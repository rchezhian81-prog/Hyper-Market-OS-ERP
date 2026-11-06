// W4 · QG-03 "Review, automated tests, security scans, SBOM and documentation green" (roadmap §22) — the branch-protection
// reading. Everything else in QG-03 runs on every pull request, but it is only a SUGGESTION until GitHub refuses a change to
// `main` that has not passed it (hard rule #8; docs/runbooks/branch-protection.md, OA-14). That switch is a repository
// setting nobody can make from a file, so the gate must READ it, not assume it.
//
// A CI step (scripts/branch-protection-reading.mts) asks GitHub, with the token it has, how `main` is protected — the
// classic protection AND the rulesets that apply to `main` — and this file reads the answers:
//
//   • each of the runbook's requirements is MET, MISSING (GitHub said so) or NOT KNOWN (GitHub would not tell this token);
//   • the reading becomes a findings report on head office's register (tool `github-branch-protection`, source
//     `repository`), so a missing requirement is an open HIGH finding that holds QG-03 by name, and a later complete
//     reading with nothing missing closes it — the register's own rule, never by hand;
//   • a reading that could not see everything is an INCOMPLETE run: what it could not see is a "not known" finding, and an
//     incomplete run closes nothing;
//   • the gate register adds one more rule (`qg03BranchProtectionBlockers`): no reading on file, or a latest reading that
//     was not complete, holds QG-03 as NOT KNOWN. Silence is never "protected" (P-08).
//
// Reading protection needs an administrator's read-only token, which only the owner can issue (a repository secret,
// BRANCH_PROTECTION_TOKEN). The build's own token is refused by GitHub — and that refusal is read as NOT KNOWN, never as
// protected. No token is ever written to the repository, the report or a log (hard rule #4). Pure: no clock, no I/O.

import type { FindingObservation, ScanReport } from './findings';
import type { GateBlocker } from './gate-decisions';

export const BRANCH_PROTECTION_TOOL = 'github-branch-protection';

/** One answer from GitHub's API: its HTTP status and body, or that it could not be reached at all (status 0). */
export interface GithubAnswer { readonly status: number; readonly body: unknown }

export type RequirementState = 'met' | 'missing' | 'not_known';

export interface RequirementReading {
  /** A stable key: pull_request, code_owner_review, up_to_date, no_bypass, check:<job name>. */
  readonly key: string;
  readonly words: string;
  readonly state: RequirementState;
  readonly detail: string;
}

export interface BranchProtectionReading {
  readonly branch: string;
  /** protected: every requirement met · not_protected: at least one is missing · not_known: none missing, some unseen. */
  readonly standing: 'protected' | 'not_protected' | 'not_known';
  readonly requirements: readonly RequirementReading[];
  readonly detail: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/**
 * The checks a pull request must pass, from the workflow file itself: every job that runs on a pull request. A job that
 * runs only after a merge (`if: github.event_name == 'push' …`) never reports on a pull request, so requiring it would
 * block every merge — the runbook says not to (docs/runbooks/branch-protection.md "The exact checks to require").
 */
export function requiredChecksOf(workflowYaml: string): readonly string[] {
  const lines = workflowYaml.split(/\r?\n/);
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (start === -1) return [];
  const out: string[] = [];
  let name: string | undefined;
  let pushOnly = false;
  const flush = (): void => { if (name !== undefined && !pushOnly) out.push(name); name = undefined; pushOnly = false; };
  for (const l of lines.slice(start + 1)) {
    if (/^\S/.test(l)) break; // the end of the jobs block
    if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(l)) { flush(); name = undefined; continue; }
    const n = /^ {4}name:\s*(.+?)\s*$/.exec(l);
    if (n !== null && name === undefined) { name = n[1]!.replace(/^(['"])(.*)\1$/, '$2'); continue; }
    if (/^ {4}if:\s*.*github\.event_name\s*==\s*'push'/.test(l)) pushOnly = true;
  }
  flush();
  return out;
}

const REQUIREMENT_WORDS = {
  pull_request: 'A pull request is required — nobody pushes to main directly',
  code_owner_review: 'The code owner (the owner, OA-14) must approve every pull request',
  up_to_date: 'A branch must be up to date with main before it merges',
  no_bypass: 'Nobody, administrators included, may bypass the rule',
} as const;

interface SourceSays {
  /** Whether this source could be read at all. */
  readonly readable: boolean;
  readonly pullRequest: boolean;
  readonly codeOwner: boolean;
  readonly upToDate: boolean;
  readonly checks: ReadonlySet<string>;
  /** true: no bypass · false: somebody may bypass · undefined: this source cannot say. */
  readonly noBypass: boolean | undefined;
  /** Whether this source protects the branch at all (a 404 "not protected" protects nothing). */
  readonly protects: boolean;
}

const NOTHING: SourceSays = { readable: true, pullRequest: false, codeOwner: false, upToDate: false, checks: new Set(), noBypass: undefined, protects: false };
const UNREADABLE: SourceSays = { ...NOTHING, readable: false };

/** GET /repos/{owner}/{repo}/branches/{branch}/protection — needs an administrator's token. */
function classicSays(a: GithubAnswer): SourceSays {
  if (a.status === 404) return NOTHING; // "Branch not protected": GitHub says plainly there is no classic protection
  if (a.status !== 200 || !isObj(a.body)) return UNREADABLE;
  const b = a.body;
  const pr = isObj(b['required_pull_request_reviews']) ? b['required_pull_request_reviews'] : undefined;
  const sc = isObj(b['required_status_checks']) ? b['required_status_checks'] : undefined;
  const checks = new Set<string>([...strs(sc?.['contexts']), ...(Array.isArray(sc?.['checks']) ? (sc!['checks'] as unknown[]).filter(isObj).map((c) => c['context']).filter((c): c is string => typeof c === 'string') : [])]);
  const admins = isObj(b['enforce_admins']) ? b['enforce_admins']['enabled'] === true : false;
  return {
    readable: true, protects: true,
    pullRequest: pr !== undefined, codeOwner: pr?.['require_code_owner_reviews'] === true,
    upToDate: sc?.['strict'] === true, checks, noBypass: admins,
  };
}

/**
 * GET /repos/{owner}/{repo}/rules/branches/{branch} (the rules every active ruleset lays on the branch) and, for each
 * ruleset named there, GET /repos/{owner}/{repo}/rulesets/{id} — whose bypass list GitHub shows only to an administrator.
 */
function rulesetsSay(rules: GithubAnswer, rulesets: Readonly<Record<string, GithubAnswer>>): SourceSays {
  if (rules.status !== 200 || !Array.isArray(rules.body)) return UNREADABLE;
  const list = (rules.body as unknown[]).filter(isObj);
  if (list.length === 0) return NOTHING;
  const pr = list.filter((r) => r['type'] === 'pull_request');
  const sc = list.filter((r) => r['type'] === 'required_status_checks');
  const params = (r: Record<string, unknown>): Record<string, unknown> => (isObj(r['parameters']) ? r['parameters'] : {});
  const checks = new Set<string>(sc.flatMap((r) => (Array.isArray(params(r)['required_status_checks']) ? (params(r)['required_status_checks'] as unknown[]) : []))
    .filter(isObj).map((c) => c['context']).filter((c): c is string => typeof c === 'string'));
  // Bypass: every ruleset laying a rule on main must be read, and must have an empty bypass list.
  const ids = [...new Set(list.map((r) => r['ruleset_id']).filter((x) => typeof x === 'number' || typeof x === 'string').map(String))];
  let noBypass: boolean | undefined = true;
  for (const id of ids) {
    const a = rulesets[id];
    if (a === undefined || a.status !== 200 || !isObj(a.body) || !Array.isArray(a.body['bypass_actors'])) { noBypass = noBypass === false ? false : undefined; continue; }
    if ((a.body['bypass_actors'] as unknown[]).length > 0) noBypass = false;
  }
  return {
    readable: true, protects: true,
    pullRequest: pr.length > 0, codeOwner: pr.some((r) => params(r)['require_code_owner_review'] === true),
    upToDate: sc.some((r) => params(r)['strict_required_status_checks_policy'] === true), checks, noBypass,
  };
}

/** Read GitHub's answers about `branch` against the requirements (the runbook's settings and every required check). */
export function readBranchProtection(input: {
  readonly branch: string;
  readonly classic: GithubAnswer;
  readonly rules: GithubAnswer;
  /** The answer for each ruleset id named in `rules` (absent: not asked). */
  readonly rulesets?: Readonly<Record<string, GithubAnswer>>;
  readonly requiredChecks: readonly string[];
}): BranchProtectionReading {
  const sources = [classicSays(input.classic), rulesetsSay(input.rules, input.rulesets ?? {})];
  const unreadable = sources.some((s) => !s.readable);
  const unseen = unreadable ? ' — GitHub would not show this token all of the branch\'s protection, so it is not known' : '';
  const state = (met: boolean): RequirementState => (met ? 'met' : unreadable ? 'not_known' : 'missing');
  const flag = (k: 'pullRequest' | 'codeOwner' | 'upToDate'): boolean => sources.some((s) => s[k]);
  const reqs: RequirementReading[] = [];
  const add = (key: keyof typeof REQUIREMENT_WORDS, met: boolean): void => {
    const st = state(met);
    reqs.push({ key, words: REQUIREMENT_WORDS[key], state: st, detail: st === 'met' ? 'set' : st === 'missing' ? 'not set on main' : `not known${unseen}` });
  };
  add('pull_request', flag('pullRequest'));
  add('code_owner_review', flag('codeOwner'));
  add('up_to_date', flag('upToDate'));
  // Bypass: every source that protects main must forbid it; one that cannot say leaves it not known.
  const protecting = sources.filter((s) => s.readable && s.protects);
  let bypass: RequirementState;
  if (protecting.some((s) => s.noBypass === false)) bypass = 'missing';
  else if (protecting.length === 0) bypass = unreadable ? 'not_known' : 'missing';
  else if (unreadable || protecting.some((s) => s.noBypass === undefined)) bypass = 'not_known';
  else bypass = 'met';
  reqs.push({ key: 'no_bypass', words: REQUIREMENT_WORDS.no_bypass, state: bypass, detail: bypass === 'met' ? 'set' : bypass === 'missing' ? 'somebody may bypass the rule on main, or main has no rule at all' : 'not known — GitHub shows who may bypass a rule only to an administrator\'s token' });
  const checks = new Set(sources.flatMap((s) => [...s.checks]));
  for (const c of input.requiredChecks) {
    const st = state(checks.has(c));
    reqs.push({ key: `check:${c}`, words: `The check "${c}" must pass before a merge`, state: st, detail: st === 'met' ? 'required' : st === 'missing' ? 'not required on main' : `not known${unseen}` });
  }
  const missing = reqs.filter((r) => r.state === 'missing');
  const notKnown = reqs.filter((r) => r.state === 'not_known');
  const standing = missing.length > 0 ? 'not_protected' : notKnown.length > 0 ? 'not_known' : 'protected';
  const detail = standing === 'protected'
    ? `${input.branch} is protected: a pull request, the code owner's approval, an up-to-date branch, no bypass and all ${input.requiredChecks.length} checks are required`
    : standing === 'not_protected'
      ? `${input.branch} is NOT protected: ${missing.length} requirement(s) missing (${missing.map((r) => r.key).join(', ')})${notKnown.length > 0 ? `; ${notKnown.length} not known` : ''}`
      : `${input.branch}'s protection is NOT KNOWN: ${notKnown.length} requirement(s) could not be read with this token — the owner issues a read-only administrator token as the BRANCH_PROTECTION_TOKEN secret (docs/runbooks/branch-protection.md)`;
  return { branch: input.branch, standing, requirements: reqs, detail };
}

/**
 * The reading as a findings report for head office's register. Every missing or not-known requirement is a HIGH
 * observation (high blocks a gate while open, §22); a reading that could not see everything is an incomplete run, so it
 * closes nothing it did not see.
 */
export function branchProtectionReport(reading: BranchProtectionReading, run: { readonly runId: string; readonly scannedAt: string; readonly repository: string; readonly commit?: string }): ScanReport {
  const observations: FindingObservation[] = reading.requirements.filter((r) => r.state !== 'met').map((r) => ({
    fingerprint: `${BRANCH_PROTECTION_TOOL}|${run.repository}|${reading.branch}|${r.state}|${r.key}`,
    source: 'repository', tool: BRANCH_PROTECTION_TOOL,
    ruleId: r.state === 'missing' ? `missing:${r.key}` : `not_known:${r.key}`,
    title: r.state === 'missing' ? `QG-03: ${r.words} — not set on ${reading.branch}` : `QG-03: ${r.words} — not known (the gate holds until it is read)`,
    severity: 'high', toolSeverity: r.state === 'missing' ? 'MISSING' : 'NOT_KNOWN',
    location: `${run.repository} branch ${reading.branch}`,
  }));
  const notKnown = reading.requirements.filter((r) => r.state === 'not_known').map((r) => `${r.key}: ${r.detail}`);
  return {
    tool: BRANCH_PROTECTION_TOOL, source: 'repository', runId: run.runId, scannedAt: run.scannedAt,
    ...(run.commit === undefined ? {} : { commit: run.commit }),
    complete: notKnown.length === 0, ...(notKnown.length === 0 ? {} : { incompleteBecause: notKnown }), observations,
  };
}

/** A scan run as the register keeps it (the parts this rule reads). */
export interface ScanRunView { readonly tool: string; readonly scannedAt: string; readonly complete: boolean; readonly runId: string }

/**
 * The gate register's own QG-03 rule: no branch-protection reading on file, or a latest reading that could not see
 * everything, holds QG-03 as NOT KNOWN. (What a reading found missing is already an open high finding on the register.)
 */
export function qg03BranchProtectionBlockers(scans: readonly ScanRunView[]): readonly GateBlocker[] {
  const mine = scans.filter((s) => s.tool === BRANCH_PROTECTION_TOOL);
  if (mine.length === 0) {
    return [{ gate: 'QG-03', kind: 'check', ref: 'branch-protection:no-reading', reason: 'branch protection on main is NOT KNOWN — no reading is on file, so nothing shows GitHub refuses a change that has not passed review and the checks (hard rule #8)' }];
  }
  const latest = mine.reduce((a, z) => (z.scannedAt >= a.scannedAt ? z : a));
  if (!latest.complete) {
    return [{ gate: 'QG-03', kind: 'check', ref: `branch-protection:not-known:${latest.runId}`, reason: `branch protection on main is NOT KNOWN — the latest reading (${latest.scannedAt}) could not read all of it with the token it had; the owner issues a read-only administrator token (BRANCH_PROTECTION_TOKEN)` }];
  }
  return [];
}
