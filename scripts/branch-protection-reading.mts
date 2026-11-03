// W4 · QG-03 — read main's branch protection with the token this build has, and write it as a findings report for head
// office's register (the push step that follows sends every *.findings.json in the folder, OB-331).
//
//   node --experimental-strip-types scripts/branch-protection-reading.mts --out scan-reports/branch-protection.findings.json
//
// The token is read ONLY from the environment: BRANCH_PROTECTION_TOKEN (a read-only administrator token the owner issues
// as a repository secret — GitHub shows protection only to an administrator) or, without it, the build's own GITHUB_TOKEN,
// which GitHub refuses — and that refusal is read as NOT KNOWN, which holds QG-03 (never GO). The token is never printed,
// written or passed on the command line (hard rule #4). The repository is GITHUB_REPOSITORY; the API is GITHUB_API_URL.
//
// Exit 0 whatever main's protection is — the gate register holds QG-03, the build does not fail every pull request while
// the owner has not yet switched it on; the reading says so as a visible warning (P-08). Exit 2 only when the report
// cannot be written or the run is not told which repository it is.

import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { readBranchProtection, branchProtectionReport, requiredChecksOf, type GithubAnswer } from '../packages/compliance/src/branch-protection.ts';

const arg = (flag: string): string | undefined => { const i = process.argv.indexOf(flag); return i === -1 ? undefined : process.argv[i + 1]; };
const out = arg('--out') ?? 'scan-reports/branch-protection.findings.json';
const branch = arg('--branch') ?? 'main';
const repository = process.env['GITHUB_REPOSITORY'] ?? '';
const api = (process.env['GITHUB_API_URL'] ?? 'https://api.github.com').replace(/\/+$/, '');
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) { console.error('::error::GITHUB_REPOSITORY is not owner/name — this reading runs inside GitHub Actions'); process.exit(2); }
if (!/^https:\/\//.test(api)) { console.error('::error::GITHUB_API_URL is not https'); process.exit(2); }

const admin = (process.env['BRANCH_PROTECTION_TOKEN'] ?? '').trim();
const token = admin !== '' ? admin : (process.env['GITHUB_TOKEN'] ?? '').trim();
const ask = async (path: string): Promise<GithubAnswer> => {
  try {
    const res = await fetch(`${api}/repos/${repository}${path}`, {
      headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...(token === '' ? {} : { authorization: `Bearer ${token}` }) },
    });
    const text = await res.text();
    let body: unknown = null;
    try { body = text === '' ? null : JSON.parse(text); } catch { body = null; }
    return { status: res.status, body };
  } catch { return { status: 0, body: null }; }
};

const classic = await ask(`/branches/${branch}/protection`);
const rules = await ask(`/rules/branches/${branch}`);
const rulesets: Record<string, GithubAnswer> = {};
if (rules.status === 200 && Array.isArray(rules.body)) {
  for (const id of new Set((rules.body as { ruleset_id?: unknown }[]).map((r) => r.ruleset_id).filter((x) => typeof x === 'number' || typeof x === 'string').map(String))) {
    rulesets[id] = await ask(`/rulesets/${encodeURIComponent(id)}`);
  }
}
const requiredChecks = requiredChecksOf(readFileSync('.github/workflows/ci.yml', 'utf8'));
const reading = readBranchProtection({ branch, classic, rules, rulesets, requiredChecks });
const runId = process.env['GITHUB_RUN_ID'] === undefined ? `local-${new Date().toISOString()}` : `gh-${process.env['GITHUB_RUN_ID']}-${process.env['GITHUB_RUN_ATTEMPT'] ?? '1'}`;
const report = branchProtectionReport(reading, { runId, scannedAt: new Date().toISOString(), repository, ...(process.env['GITHUB_SHA'] === undefined ? {} : { commit: process.env['GITHUB_SHA'] }) });
try {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
} catch (e) { console.error(`::error::the branch-protection reading could not be written to ${out}: ${(e as Error).message}`); process.exit(2); }

console.log(`QG-03 branch protection reading (${admin !== '' ? 'administrator token' : 'the build\'s own token'}; GitHub answered ${classic.status} for the protection, ${rules.status} for the rules): ${reading.detail}`);
for (const r of reading.requirements) console.log(`  ${r.state === 'met' ? 'met      ' : r.state === 'missing' ? 'MISSING  ' : 'NOT KNOWN'}  ${r.words} — ${r.detail}`);
if (reading.standing !== 'protected') console.log(`::warning title=QG-03 holds — branch protection ${reading.standing === 'not_known' ? 'not known' : 'not on'}::${reading.detail}`);
const summary = process.env['GITHUB_STEP_SUMMARY'];
if (summary !== undefined) {
  try { appendFileSync(summary, `### QG-03 — branch protection on ${branch}\n\n${reading.detail}\n\n${reading.requirements.map((r) => `- ${r.state === 'met' ? '✓' : r.state === 'missing' ? '✗' : '?'} ${r.words} — ${r.detail}`).join('\n')}\n`); } catch { /* the summary is a courtesy */ }
}
process.exit(0);
