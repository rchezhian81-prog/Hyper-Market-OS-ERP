import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * QG-03 / QG-06 guardrail (roadmap §22 "security scans … green", "zero open critical/high findings"; §35 "SAST/DAST/
 * SCA/container/IaC/secret scans"; OB-288 gates lane). The automatic build must run all six kinds of scan, every tool
 * pinned so a run can be repeated, and one judge that fails on critical/high, keeps every finding and refuses a missing
 * report. This fails if a scanner is removed, unpinned, allowed to fail quietly, or if the deploys stop waiting for it.
 */

const CI = readFileSync('.github/workflows/ci.yml', 'utf8');
const job = (name: string): string => {
  const start = CI.indexOf(`\n  ${name}:\n`);
  expect(start, `the ${name} job exists`).toBeGreaterThan(0);
  const next = CI.slice(start + 1).search(/\n {2}[a-z][a-z-]*:\n/);
  return next < 0 ? CI.slice(start) : CI.slice(start, start + 1 + next);
};

describe('the automatic build runs every security scan (§35), each pinned, one judge', () => {
  const scans = job('security-scans');

  it('SAST: Semgrep OSS at an exact version, the open rules at one commit, security rules only, over the shipped code', () => {
    expect(scans).toMatch(/SEMGREP_VERSION: '\d+\.\d+\.\d+'/);
    expect(scans).toMatch(/SEMGREP_RULES_COMMIT: [0-9a-f]{40}\n/);
    expect(scans).toContain('pip" install --quiet "semgrep==$SEMGREP_VERSION"');
    expect(scans).toContain('checkout --quiet "$SEMGREP_RULES_COMMIT"');
    expect(scans).toContain('node scripts/select-sast-rules.mjs');
    expect(scans).toContain('--metrics=off');
    expect(scans).toMatch(/apps packages services edge scripts infra\n/);
    expect(scans).toContain('--format semgrep');
  });

  it('IaC and container images: Trivy pinned by image digest, both images built and scanned, secrets too', () => {
    expect(scans).toMatch(/TRIVY_IMAGE: aquasec\/trivy:\d+\.\d+\.\d+@sha256:[0-9a-f]{64}\n/);
    expect(scans).toContain('config --format json');
    expect(scans).toContain('docker build -f infra/docker/api.Dockerfile');
    expect(scans).toContain('docker build -f infra/docker/edge.Dockerfile');
    expect(scans).toContain('image --scanners vuln,secret');
    expect(scans).toContain('--format trivy-config');
    expect(scans).toContain('--format trivy-image');
  });

  it('DAST: the ZAP baseline runs against the composed stack\'s public origin, pinned by digest, and is judged', () => {
    const deploy = job('deploy');
    expect(deploy).toMatch(/ZAP_IMAGE: zaproxy\/zap-stable:\d+\.\d+\.\d+@sha256:[0-9a-f]{64}\n/);
    expect(deploy).toContain('zap-baseline.py -t https://127.0.0.1/customer/');
    expect(deploy).toContain('--format zap');
    // It runs while the stack is up: after the stack comes up, before it is torn down.
    expect(deploy.indexOf('zap-baseline.py')).toBeGreaterThan(deploy.indexOf('The whole stack comes up'));
    expect(deploy.indexOf('zap-baseline.py')).toBeLessThan(deploy.indexOf('Tear down'));
  });

  it('SCA and secrets stay in verify, and the dependency advisories become a findings report too', () => {
    const verify = job('verify');
    expect(verify).toContain('pnpm audit --audit-level=high');
    expect(verify).toContain('pnpm run secret-scan');
    expect(verify).toContain('--format pnpm-audit');
  });

  it('no scan can fail quietly: each continue-on-error step is named in a final verdict that always runs', () => {
    const quiet = [...scans.matchAll(/id: (\w+)\n\s+continue-on-error: true/g)].map((m) => m[1]!);
    expect(quiet.sort()).toEqual(['build', 'iac', 'images', 'sast']);
    const verdict = scans.slice(scans.indexOf('Verdict'));
    expect(verdict).toContain('if: always()');
    for (const id of quiet) expect(verdict).toContain(`steps.${id}.outcome`);
    expect(CI.match(/continue-on-error: true/g)?.length).toBe(4); // nowhere else in the pipeline
  });

  it('the findings reports are kept, by an action pinned to a commit', () => {
    expect(CI).toMatch(/uses: actions\/upload-artifact@[0-9a-f]{40} # v\d+\.\d+\.\d+/);
    expect(CI).not.toMatch(/uses: actions\/upload-artifact@v\d+\s*$/m);
    expect(scans).toContain('name: scan-reports-security');
  });

  it('the canary and the full rollout wait for the security scans', () => {
    expect(job('canary')).toMatch(/needs: \[[^\]]*security-scans[^\]]*\]/);
    expect(job('release')).toMatch(/needs: \[[^\]]*security-scans[^\]]*\]/);
  });
});

describe('the judge (scripts/scan-findings.mts): fail on critical/high, keep everything, refuse a missing report', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sre-scan-judge-'));
  const judge = (format: string, input: unknown): { code: number; out: string; report?: { observations: { severity: string }[]; complete: boolean } } => {
    const inPath = join(dir, `${format}-${Math.random()}.json`);
    const outPath = `${inPath}.findings.json`;
    if (input !== undefined) writeFileSync(inPath, typeof input === 'string' ? input : JSON.stringify(input));
    const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', 'scripts/scan-findings.mts', '--format', format, '--in', inPath, '--out', outPath, '--run-id', 't'], { encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: '' } });
    let report;
    try { report = JSON.parse(readFileSync(outPath, 'utf8')); } catch { report = undefined; }
    return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}`, report };
  };
  const semgrep = (severity: string) => ({ results: [{ check_id: 'js.rule', path: 'apps/a.ts', start: { line: 3 }, extra: { message: 'm', severity } }], errors: [] });

  it('a high fails the build and names it as an annotation on the file and line', () => {
    const r = judge('semgrep', semgrep('ERROR'));
    expect(r.code).toBe(1);
    expect(r.out).toContain('::error file=apps/a.ts,line=3,title=semgrep high: js.rule::');
  });

  it('a medium does not fail the build, but it is in the findings report', () => {
    const r = judge('semgrep', semgrep('WARNING'));
    expect(r.code).toBe(0);
    expect(r.report?.observations.map((o) => o.severity)).toEqual(['medium']);
  });

  it('a critical image vulnerability fails; a clean image passes with an empty, complete report', () => {
    expect(judge('trivy-image', { ArtifactName: 'x', Results: [{ Target: 't', Vulnerabilities: [{ VulnerabilityID: 'CVE-1', PkgName: 'p', Severity: 'CRITICAL' }] }] }).code).toBe(1);
    const clean = judge('trivy-image', { ArtifactName: 'x', Results: [] });
    expect(clean.code).toBe(0);
    expect(clean.report).toMatchObject({ observations: [], complete: true });
  });

  it('a missing, unreadable or wrong-shaped report is exit 2 — never "nothing found"', () => {
    expect(judge('zap', undefined).code).toBe(2);
    expect(judge('zap', 'not json').code).toBe(2);
    expect(judge('zap', { results: [] }).code).toBe(2);
  });
});
