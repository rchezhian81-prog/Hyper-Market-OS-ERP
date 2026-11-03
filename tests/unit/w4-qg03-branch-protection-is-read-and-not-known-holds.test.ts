import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  readBranchProtection, branchProtectionReport, qg03BranchProtectionBlockers, requiredChecksOf, BRANCH_PROTECTION_TOOL,
  readScanReport, importScan, findingBlocks, type GithubAnswer,
} from '../../packages/compliance/src/index';

/**
 * W4 · QG-03 (roadmap §22 "Review, automated tests, security scans, SBOM and documentation green"; hard rule #8;
 * docs/runbooks/branch-protection.md, OA-14). The gate reads main's branch protection, as a CI step read it with the token it
 * had — and reads "not known" as a HOLD, never a pass:
 *
 *   • a fully protected main (classic protection or a ruleset): every requirement met, a complete reading, no blocker;
 *   • a requirement GitHub says is not set: MISSING, an open high finding that holds QG-03 (and only QG-03);
 *   • the build's own token (GitHub answers 403): NOT KNOWN — an incomplete reading that closes nothing and holds QG-03;
 *   • no reading on file at all: NOT KNOWN, a blocker by name;
 *   • the required checks are the workflow's own pull-request jobs (the runbook's rule), never a list typed here;
 *   • the token is read only from the environment and never printed or written.
 */

const CHECKS = ['Type check, lint, tests, secret & dependency scan', 'Stage gate suites (real PostgreSQL)'];
const REFUSED: GithubAnswer = { status: 403, body: { message: 'Resource not accessible by integration' } };
const NO_RULES: GithubAnswer = { status: 200, body: [] };
const fullClassic: GithubAnswer = {
  status: 200,
  body: {
    required_pull_request_reviews: { require_code_owner_reviews: true, required_approving_review_count: 1 },
    required_status_checks: { strict: true, contexts: [CHECKS[0]], checks: [{ context: CHECKS[1], app_id: 15368 }] },
    enforce_admins: { enabled: true },
  },
};
const states = (r: ReturnType<typeof readBranchProtection>) => Object.fromEntries(r.requirements.map((q) => [q.key, q.state]));
const RUN = { runId: 'gh-1-1', scannedAt: '2026-11-03T06:00:00.000Z', repository: 'synthetic/repo' };

describe('QG-03 · main\'s branch protection is read, and "not known" holds the gate', () => {
  it('a fully protected main by classic protection: every requirement met; a complete reading with nothing to block', () => {
    const r = readBranchProtection({ branch: 'main', classic: fullClassic, rules: NO_RULES, requiredChecks: CHECKS });
    expect(r.standing).toBe('protected');
    expect(Object.values(states(r)).every((s) => s === 'met')).toBe(true);
    const report = branchProtectionReport(r, RUN);
    expect(report).toMatchObject({ tool: BRANCH_PROTECTION_TOOL, source: 'repository', complete: true, observations: [] });
    expect(readScanReport(report)).toEqual(report); // head office's register accepts it as it is
  });

  it('a fully protected main by a ruleset with an empty bypass list, the classic protection absent (404)', () => {
    const rules: GithubAnswer = {
      status: 200,
      body: [
        { type: 'pull_request', ruleset_id: 7, parameters: { require_code_owner_review: true } },
        { type: 'required_status_checks', ruleset_id: 7, parameters: { strict_required_status_checks_policy: true, required_status_checks: CHECKS.map((context) => ({ context })) } },
        { type: 'non_fast_forward', ruleset_id: 7 },
      ],
    };
    const r = readBranchProtection({ branch: 'main', classic: { status: 404, body: { message: 'Branch not protected' } }, rules, rulesets: { 7: { status: 200, body: { id: 7, bypass_actors: [] } } }, requiredChecks: CHECKS });
    expect(r.standing).toBe('protected');
    // …but a ruleset whose bypass list this token cannot see leaves "no bypass" NOT KNOWN — never assumed.
    const unseen = readBranchProtection({ branch: 'main', classic: { status: 404, body: null }, rules, rulesets: { 7: { status: 200, body: { id: 7 } } }, requiredChecks: CHECKS });
    expect(unseen.standing).toBe('not_known');
    expect(states(unseen)['no_bypass']).toBe('not_known');
    // …and one somebody may bypass is MISSING.
    const bypass = readBranchProtection({ branch: 'main', classic: { status: 404, body: null }, rules, rulesets: { 7: { status: 200, body: { bypass_actors: [{ actor_type: 'RepositoryRole' }] } } }, requiredChecks: CHECKS });
    expect(states(bypass)['no_bypass']).toBe('missing');
  });

  it('main not protected at all (today): every requirement MISSING — high findings that hold QG-03, and only QG-03', () => {
    const r = readBranchProtection({ branch: 'main', classic: { status: 404, body: { message: 'Branch not protected' } }, rules: NO_RULES, requiredChecks: CHECKS });
    expect(r.standing).toBe('not_protected');
    expect(Object.values(states(r)).every((s) => s === 'missing')).toBe(true);
    const report = branchProtectionReport(r, RUN);
    expect(report.complete).toBe(true);
    expect(report.observations.map((o) => o.ruleId)).toEqual(['missing:pull_request', 'missing:code_owner_review', 'missing:up_to_date', 'missing:no_bypass', ...CHECKS.map((c) => `missing:check:${c}`)]);
    expect(report.observations.every((o) => o.severity === 'high')).toBe(true);
    const { changes } = importScan([], readScanReport(report));
    expect(new Set(findingBlocks(changes).map((b) => b.gate))).toEqual(new Set(['QG-03'])); // not a QG-06 security finding
  });

  it('one check not required and the code owner not asked: just those two are MISSING, by name', () => {
    const half: GithubAnswer = { status: 200, body: { ...(fullClassic.body as object), required_pull_request_reviews: { require_code_owner_reviews: false }, required_status_checks: { strict: true, contexts: [CHECKS[0]] } } };
    const r = readBranchProtection({ branch: 'main', classic: half, rules: NO_RULES, requiredChecks: CHECKS });
    expect(r.standing).toBe('not_protected');
    expect(r.requirements.filter((q) => q.state !== 'met').map((q) => q.key)).toEqual(['code_owner_review', `check:${CHECKS[1]}`]);
  });

  it('the build\'s own token (GitHub refuses it): NOT KNOWN — an incomplete reading that holds QG-03 and closes nothing', () => {
    const r = readBranchProtection({ branch: 'main', classic: REFUSED, rules: REFUSED, requiredChecks: CHECKS });
    expect(r.standing).toBe('not_known');
    expect(Object.values(states(r)).every((s) => s === 'not_known')).toBe(true);
    expect(r.detail).toMatch(/NOT KNOWN[\s\S]*BRANCH_PROTECTION_TOKEN/);
    const report = branchProtectionReport(r, RUN);
    expect(report.complete).toBe(false);
    expect(report.observations.every((o) => o.ruleId.startsWith('not_known:') && o.severity === 'high')).toBe(true);
    // GitHub unreachable (status 0) is the same: not known.
    expect(readBranchProtection({ branch: 'main', classic: { status: 0, body: null }, rules: { status: 0, body: null }, requiredChecks: CHECKS }).standing).toBe('not_known');
    // The rules readable but the protection refused: what the rules show is met, the rest NOT KNOWN — never "missing" on a guess.
    const part = readBranchProtection({ branch: 'main', classic: REFUSED, rules: { status: 200, body: [{ type: 'pull_request', ruleset_id: 1, parameters: {} }] }, requiredChecks: CHECKS });
    expect(states(part)).toMatchObject({ pull_request: 'met', code_owner_review: 'not_known', no_bypass: 'not_known' });
  });

  it('the gate rule: no reading on file, or a latest reading that could not see everything, holds QG-03 as NOT KNOWN', () => {
    expect(qg03BranchProtectionBlockers([])).toEqual([expect.objectContaining({ gate: 'QG-03', kind: 'check', ref: 'branch-protection:no-reading' })]);
    expect(qg03BranchProtectionBlockers([{ tool: 'semgrep', scannedAt: RUN.scannedAt, complete: true, runId: 's' }])[0]!.ref).toBe('branch-protection:no-reading');
    const incomplete = { tool: BRANCH_PROTECTION_TOOL, scannedAt: '2026-11-03T06:00:00.000Z', complete: false, runId: 'gh-2' };
    const completeEarlier = { tool: BRANCH_PROTECTION_TOOL, scannedAt: '2026-11-02T06:00:00.000Z', complete: true, runId: 'gh-1' };
    expect(qg03BranchProtectionBlockers([completeEarlier, incomplete])).toEqual([expect.objectContaining({ ref: 'branch-protection:not-known:gh-2' })]);
    expect(qg03BranchProtectionBlockers([incomplete, { ...completeEarlier, scannedAt: '2026-11-04T06:00:00.000Z', runId: 'gh-3' }])).toEqual([]);
  });

  it('the not-known findings close only when a later COMPLETE reading no longer reports them', () => {
    const first = importScan([], readScanReport(branchProtectionReport(readBranchProtection({ branch: 'main', classic: REFUSED, rules: REFUSED, requiredChecks: CHECKS }), RUN)));
    expect(first.changes.every((f) => f.status === 'open')).toBe(true);
    const later = importScan(first.changes, readScanReport(branchProtectionReport(readBranchProtection({ branch: 'main', classic: fullClassic, rules: NO_RULES, requiredChecks: CHECKS }), { ...RUN, runId: 'gh-2-1', scannedAt: '2026-11-04T06:00:00.000Z' })));
    expect(later.summary).toMatchObject({ fixed: first.changes.length, complete: true });
  });

  it('the required checks are the workflow\'s own pull-request jobs — the deploy jobs that run only after a merge are left out', () => {
    const jobs = requiredChecksOf(readFileSync('.github/workflows/ci.yml', 'utf8'));
    expect(jobs).toContain('Type check, lint, tests, secret & dependency scan');
    expect(jobs).toContain('Stage gate suites (real PostgreSQL)');
    expect(jobs).toContain('Identity server suites (real Keycloak)');
    expect(jobs.some((j) => /^Canary stage|^Deploy the merged release/.test(j))).toBe(false);
    expect(jobs.length).toBeGreaterThanOrEqual(6);
  });

  it('the CI step reads the token only from the environment; the script never prints or writes it', () => {
    const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
    expect(ci).toContain('BRANCH_PROTECTION_TOKEN: ${{ secrets.BRANCH_PROTECTION_TOKEN }}');
    expect(ci).toContain('node --experimental-strip-types scripts/branch-protection-reading.mts');
    const script = readFileSync('scripts/branch-protection-reading.mts', 'utf8');
    // The token's value is used in exactly one place: the authorization header of the request to GitHub.
    expect(script.match(/\$\{(token|admin)\}/g)).toEqual(['${token}']);
    expect(script).toContain('authorization: `Bearer ${token}`');
    // Run it with no repository named: it refuses (exit 2) without a network call, saying why.
    const dir = mkdtempSync(join(tmpdir(), 'sre-bp-'));
    const out = join(dir, 'bp.json');
    const env = { ...process.env, GITHUB_REPOSITORY: '', BRANCH_PROTECTION_TOKEN: 'synthetic-never-a-real-token' } as Record<string, string>;
    const r = spawnSync(process.execPath, ['--experimental-strip-types', 'scripts/branch-protection-reading.mts', '--out', out], { encoding: 'utf8', env });
    expect(r.status).toBe(2);
    expect(`${r.stdout}${r.stderr}`).not.toContain('synthetic-never-a-real-token');
    expect(existsSync(out)).toBe(false);
  });
});
