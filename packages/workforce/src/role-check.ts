// The scored check per role behind QG-02 (W3 · OB-675, owner, 2 Nov 2026, in writing: "a scored check per role; the gate
// passes when 90% of trained staff in each role pass it at pilot, 95% at final"; "the pass mark per check is set by the
// owner on screen ('not set' until set)"). Roadmap §2.3 "Training success ≥ 90% role assessment (pilot) / ≥ 95% (final)";
// §22 QG-02 "cashier training/performance targets proven".
//
// Three kinds of record, each a fact with a name on it, append-only:
//
//   • a CHECK for a role — a list of questions or observed tasks; a later list is a new version (the old ones are kept);
//   • the role's PASS MARK — a whole percentage the OWNER sets; "not set" until he does, never a default number;
//   • an ATTEMPT — a trainer records each item passed or not for one person; the score is worked out from those, and
//     whether it passed is judged against the pass mark in force when it was recorded. A retake is a NEW attempt; the
//     person's latest attempt is the one that counts. The person never records their own.
//
// The QG-02 reading, per role: the people TRAINED for it are the active staff holding the role who have done every item of
// the role's approved curriculum, or who have sat the check. The role passes at a level when at least that share of them
// passed their latest attempt (90% pilot, 95% final). It reads NOT PASSED — never a pass — while the role has no check,
// its pass mark is not set, or nobody is trained (P-08).
//
// PILOT and FINAL against the release plan: the pilot is R2 (the decisions register, OB-58: "items the roadmap places
// after the pilot (R2)"), so the 90% pilot level counts for R0–R2 and the 95% final level for every release after it.
//
// Pure and deterministic: no clock, no I/O.

export interface RoleCheckItem {
  readonly itemId: string;
  /** A question to answer, or a task the trainer watches the person do. */
  readonly kind: 'question' | 'task';
  readonly text: string;
  readonly textTa?: string;
}

export interface RoleCheck {
  readonly roleId: string;
  readonly version: number;
  readonly items: readonly RoleCheckItem[];
  readonly definedBy: string;
  readonly definedAt: string;
}

export interface RolePassMark {
  readonly roleId: string;
  /** A whole percentage, 1–100. */
  readonly passMarkPercent: number;
  readonly setBy: string;
  readonly setAt: string;
}

export interface CheckAttempt {
  readonly attemptId: string;
  readonly roleId: string;
  readonly employeeId: string;
  readonly checkVersion: number;
  readonly results: readonly { readonly itemId: string; readonly passed: boolean }[];
  /** Whole percentage of items passed (rounded down). */
  readonly scorePercent: number;
  /** The pass mark in force when the attempt was recorded. */
  readonly passMarkPercent: number;
  readonly passed: boolean;
  readonly recordedBy: string;
  readonly recordedAt: string;
  readonly note?: string;
}

/** The two levels of roadmap §2.3. */
export const QG02_LEVELS = Object.freeze({ pilot: 90, final: 95 } as const);
/** The pilot is R2 (OB-58); the pilot level counts up to it, the final level after it. */
export const QG02_PILOT_RELEASES: readonly string[] = Object.freeze(['R0', 'R1', 'R2']);
export const QG02_FINAL_RELEASES: readonly string[] = Object.freeze(['R3', 'R4', 'R5', 'R6', 'R7', 'R8']);

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/** Read a check's list from a request: each item an id, a kind and its words; ids unique; at least one. */
export function readCheckItems(raw: unknown): readonly RoleCheckItem[] | string {
  if (!Array.isArray(raw) || raw.length === 0) return 'A check is a list of one or more questions or tasks.';
  if (raw.length > 200) return 'A check has at most 200 questions or tasks.';
  const out: RoleCheckItem[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    const o = r !== null && typeof r === 'object' ? r as Record<string, unknown> : {};
    if (!isStr(o['itemId']) || !isStr(o['text']) || (o['kind'] !== 'question' && o['kind'] !== 'task')) return 'Each item needs an itemId, a kind ("question" or "task") and its words.';
    const itemId = o['itemId'].trim();
    if (seen.has(itemId)) return `Item ${itemId} is listed twice.`;
    seen.add(itemId);
    out.push({ itemId, kind: o['kind'], text: o['text'].trim().slice(0, 500), ...(isStr(o['textTa']) ? { textTa: o['textTa'].trim().slice(0, 500) } : {}) });
  }
  return out;
}

/** A pass mark is a whole percentage from 1 to 100 — or the answer is why not. */
export function readPassMark(raw: unknown): number | string {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 && raw <= 100 ? raw : 'The pass mark is a whole percentage from 1 to 100.';
}

/** The latest check per role (the highest version). */
export function currentChecks(checks: readonly RoleCheck[]): ReadonlyMap<string, RoleCheck> {
  const out = new Map<string, RoleCheck>();
  for (const c of checks) { const p = out.get(c.roleId); if (p === undefined || c.version >= p.version) out.set(c.roleId, c); }
  return out;
}

/** The pass mark in force per role (the latest set). */
export function currentPassMarks(marks: readonly RolePassMark[]): ReadonlyMap<string, RolePassMark> {
  const out = new Map<string, RolePassMark>();
  for (const m of marks) { const p = out.get(m.roleId); if (p === undefined || m.setAt >= p.setAt) out.set(m.roleId, m); }
  return out;
}

export type AttemptRefusal = 'no_check' | 'pass_mark_not_set' | 'cannot_record_own_attempt' | 'results_do_not_match_the_check';

/**
 * Score one attempt against the role's current check and pass mark. Every item of the check answered exactly once; the
 * trainer is never the person. The score is the share of items passed, rounded down.
 */
export function scoreAttempt(input: {
  readonly check: RoleCheck | undefined; readonly passMark: RolePassMark | undefined; readonly employeeId: string; readonly recordedBy: string;
  readonly results: unknown;
}): { readonly results: CheckAttempt['results']; readonly scorePercent: number; readonly passMarkPercent: number; readonly passed: boolean } | AttemptRefusal {
  if (input.check === undefined) return 'no_check';
  if (input.passMark === undefined) return 'pass_mark_not_set';
  if (input.recordedBy === input.employeeId) return 'cannot_record_own_attempt';
  if (!Array.isArray(input.results)) return 'results_do_not_match_the_check';
  const byItem = new Map<string, boolean>();
  for (const r of input.results as unknown[]) {
    const o = r !== null && typeof r === 'object' ? r as Record<string, unknown> : {};
    if (!isStr(o['itemId']) || typeof o['passed'] !== 'boolean' || byItem.has(o['itemId'].trim())) return 'results_do_not_match_the_check';
    byItem.set(o['itemId'].trim(), o['passed']);
  }
  const items = input.check.items;
  if (byItem.size !== items.length || items.some((i) => !byItem.has(i.itemId))) return 'results_do_not_match_the_check';
  const results = items.map((i) => ({ itemId: i.itemId, passed: byItem.get(i.itemId)! }));
  const scorePercent = Math.floor((100 * results.filter((r) => r.passed).length) / items.length);
  return { results, scorePercent, passMarkPercent: input.passMark.passMarkPercent, passed: scorePercent >= input.passMark.passMarkPercent };
}

/** Each person's latest attempt at each role's check (by the time recorded, then the order kept). */
export function latestAttempts(attempts: readonly CheckAttempt[]): ReadonlyMap<string, CheckAttempt> {
  const out = new Map<string, CheckAttempt>();
  for (const a of attempts) {
    const k = `${a.roleId}\u0000${a.employeeId}`;
    const p = out.get(k);
    if (p === undefined || a.recordedAt >= p.recordedAt) out.set(k, a);
  }
  return out;
}

export interface RoleCheckPerson { readonly employeeId: string; readonly name: string }

export interface RoleCheckRow {
  readonly roleId: string;
  readonly check: { readonly version: number; readonly items: number } | null;
  readonly passMarkPercent: number | null;
  /** Everyone trained for the role, by name, with their latest attempt (null: not yet sat). */
  readonly trained: readonly { readonly employeeId: string; readonly name: string; readonly latest: { readonly scorePercent: number; readonly passed: boolean; readonly recordedAt: string } | null }[];
  readonly passedCount: number;
  /** Whole percentage of the trained who passed; null when nobody is trained. */
  readonly passedPercent: number | null;
  readonly pilot: 'passed' | 'not_passed';
  readonly final: 'passed' | 'not_passed';
  /** Why it is not passed, in plain words; empty when it passes at the final level. */
  readonly why: readonly string[];
}

/**
 * The QG-02 reading per role. `people(roleId)` is the active staff holding the role; `curriculumDone(roleId, employeeId)` says
 * whether that person has done every item of the role's approved curriculum (false when the role has none approved).
 */
export function roleCheckReading(input: {
  readonly roles: readonly string[];
  readonly checks: readonly RoleCheck[];
  readonly passMarks: readonly RolePassMark[];
  readonly attempts: readonly CheckAttempt[];
  readonly people: (roleId: string) => readonly RoleCheckPerson[];
  readonly curriculumDone: (roleId: string, employeeId: string) => boolean;
}): readonly RoleCheckRow[] {
  const checks = currentChecks(input.checks);
  const marks = currentPassMarks(input.passMarks);
  const latest = latestAttempts(input.attempts);
  const roles = [...new Set([...input.roles, ...checks.keys()])].sort();
  return roles.map((roleId): RoleCheckRow => {
    const check = checks.get(roleId);
    const mark = marks.get(roleId);
    const trainedPeople = input.people(roleId).filter((p) => input.curriculumDone(roleId, p.employeeId) || latest.has(`${roleId}\u0000${p.employeeId}`));
    const trained = trainedPeople.map((p) => {
      const a = latest.get(`${roleId}\u0000${p.employeeId}`);
      return { employeeId: p.employeeId, name: p.name, latest: a === undefined ? null : { scorePercent: a.scorePercent, passed: a.passed, recordedAt: a.recordedAt } };
    }).sort((a, b) => a.employeeId.localeCompare(b.employeeId));
    const passedCount = trained.filter((t) => t.latest?.passed === true).length;
    const passedPercent = trained.length === 0 ? null : Math.floor((100 * passedCount) / trained.length);
    const why: string[] = [];
    if (check === undefined) why.push(`${roleId}: no check has been set for this role`);
    if (mark === undefined) why.push(`${roleId}: the pass mark is not set — the owner sets it`);
    if (trained.length === 0) why.push(`${roleId}: nobody is trained for this role yet`);
    const reaches = (level: number): boolean => why.length === 0 && passedPercent !== null && passedCount * 100 >= level * trained.length;
    const pilot = reaches(QG02_LEVELS.pilot) ? 'passed' : 'not_passed';
    const final = reaches(QG02_LEVELS.final) ? 'passed' : 'not_passed';
    if (why.length === 0 && final === 'not_passed') {
      const notYet = trained.filter((t) => t.latest?.passed !== true).map((t) => `${t.name} (${t.employeeId}${t.latest === null ? ', not yet sat' : `, ${t.latest.scorePercent}%`})`);
      why.push(`${roleId}: ${passedCount} of ${trained.length} trained passed (${passedPercent}%) — ${pilot === 'not_passed' ? `below the pilot ${QG02_LEVELS.pilot}%` : `below the final ${QG02_LEVELS.final}%`}; not passed: ${notYet.join(', ')}`);
    }
    return { roleId, check: check === undefined ? null : { version: check.version, items: check.items.length }, passMarkPercent: mark?.passMarkPercent ?? null, trained, passedCount, passedPercent, pilot, final, why };
  });
}

/** A QG-02 blocker on the gate register (structural: `packages/compliance` GateBlocker). */
export interface Qg02Blocker { readonly gate: 'QG-02'; readonly kind: 'check'; readonly ref: string; readonly reason: string; readonly releases?: readonly string[] }

/**
 * The reading as gate blockers: a role not passed at the PILOT level blocks QG-02 for every release; a role that passes the
 * pilot but not the FINAL level blocks the releases after the pilot. No role at all is a blocker too (nothing on record is
 * never a pass).
 */
export function qg02Blockers(rows: readonly RoleCheckRow[]): readonly Qg02Blocker[] {
  if (rows.length === 0) return [{ gate: 'QG-02', kind: 'check', ref: 'role-checks:none', reason: 'QG-02 training: no role has a scored check and nobody is on the staff list in a role — training success is not shown' }];
  const out: Qg02Blocker[] = [];
  for (const r of rows) {
    if (r.pilot === 'not_passed') out.push({ gate: 'QG-02', kind: 'check', ref: `role-check:${r.roleId}`, reason: `QG-02 training not passed — ${r.why.join('; ')}` });
    else if (r.final === 'not_passed') out.push({ gate: 'QG-02', kind: 'check', ref: `role-check:${r.roleId}:final`, reason: `QG-02 training not at the final ${QG02_LEVELS.final}% — ${r.why.join('; ')}`, releases: QG02_FINAL_RELEASES });
  }
  return out;
}
