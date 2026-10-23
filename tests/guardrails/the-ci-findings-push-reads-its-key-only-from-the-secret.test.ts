import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * OB-331 guardrail (owner, 23 Oct 2026, in writing): the CI scan findings are pushed to head office's findings register
 * automatically and authenticated. The key is read ONLY from the GitHub Actions secret FINDINGS_PUSH_TOKEN; with it absent
 * the build says "findings not sent: no key set" visibly and is not failed; nothing under services/, apps/, edge/ or
 * packages/ mints a token for it. This fails if the step is removed, reads its key from anywhere else, could fail the
 * build, or if the push script ever prints the key.
 */

const CI = readFileSync('.github/workflows/ci.yml', 'utf8');
const scans = CI.slice(CI.indexOf('\n  security-scans:\n'), CI.indexOf('\n  browser:\n'));

describe('the security-scans job pushes the findings with a key from the secret store only (OB-331)', () => {
  const step = scans.slice(scans.indexOf("- name: Send the findings to head office's register (OB-331)"), scans.indexOf('- name: Verdict'));

  it('the step exists, always runs, before the verdict, and never fails the build itself', () => {
    expect(step.length).toBeGreaterThan(0);
    expect(step).toContain('if: always()');
    expect(step).toContain('run: node scripts/push-findings.mjs scan-reports');
    expect(step).not.toContain('continue-on-error');
  });

  it('the key comes from secrets.FINDINGS_PUSH_TOKEN and nowhere else; it is never echoed', () => {
    expect(step).toContain('FINDINGS_PUSH_TOKEN: ${{ secrets.FINDINGS_PUSH_TOKEN }}');
    expect(CI.match(/FINDINGS_PUSH_TOKEN/g)?.length).toBe(3); // the comment, the env name and the secret it reads
    expect(CI).not.toMatch(/echo[^\n]*FINDINGS_PUSH_TOKEN/);
    expect(readFileSync('docs/runbooks/environments-and-secrets.md', 'utf8')).toContain('FINDINGS_PUSH_TOKEN');
  });

  it('with no key set the push says "findings not sent: no key set" and exits 0; with a key it never prints the key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sre-findings-push-'));
    writeFileSync(join(dir, 'semgrep.findings.json'), JSON.stringify({ tool: 'semgrep', source: 'sast', runId: 'r1', scannedAt: '2026-10-23T00:00:00Z', complete: true, observations: [] }));
    const env = { ...process.env } as Record<string, string | undefined>;
    delete env['FINDINGS_PUSH_TOKEN'];
    const none = spawnSync(process.execPath, ['scripts/push-findings.mjs', dir], { encoding: 'utf8', env });
    expect(none.status).toBe(0);
    expect(none.stdout).toContain('findings not sent: no key set');
    const key = ['not', 'a', 'real', 'key', 'value'].join('-');
    const unreachable = spawnSync(process.execPath, ['scripts/push-findings.mjs', dir], { encoding: 'utf8', env: { ...env, FINDINGS_PUSH_TOKEN: key, FINDINGS_REGISTER_URL: 'http://127.0.0.1:9' } });
    expect(unreachable.status).toBe(0);
    expect(unreachable.stdout).toContain('findings not sent for semgrep run r1: head office could not be reached');
    expect(`${unreachable.stdout}${unreachable.stderr}`).not.toContain(key);
  });

  it('nothing in production code mints the push credential', () => {
    const files: string[] = [];
    const walk = (d: string): void => {
      for (const f of readdirSync(d)) {
        if (f === 'node_modules' || f.startsWith('.')) continue;
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p); else if (/\.(ts|mjs|js)$/.test(f) && !f.endsWith('.bundle.js')) files.push(p);
      }
    };
    for (const root of ['services', 'apps', 'edge', 'packages']) walk(root);
    const minting = files.filter((f) => /findings_push/.test(readFileSync(f, 'utf8')) && /createHmac|\.sign\(|issueToken|mintToken/.test(readFileSync(f, 'utf8')));
    expect(minting).toEqual([]);
  });
});
