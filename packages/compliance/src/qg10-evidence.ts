// OB-423 (owner, 27 Oct 2026) · QG-10 (roadmap §22 "Health, smoke, reconciliation, monitoring and rollback verified after
// every release") · WF-20 — the release script's per-release QG-10 evidence line, as head office's gate register keeps it.
//
// `infra/deploy/release.sh` writes one QG-10 line per release attempt (scripts/lib/release-reconcile.mjs `qg10Record`) and
// posts it to head office under its own limited machine identity. This is the pure reader head office believes it by:
//
//   • the line is read EXACTLY — the fields `qg10Record` writes and nothing else; each check one of the known states; the
//     release and the one it replaced as 40-character commit ids; the outcome one the script can produce;
//   • `verified` and `notVerified` are RE-COMPUTED from the checks here — a line claiming "verified" over a failed check is
//     refused, never stored as written;
//   • the line is EVIDENCE for the owner's QG-10 decision, never a decision (QG-12: silence is not approval): a line whose
//     `decision` is anything but the script's own "not decided here" sentence is refused.
//
// The owner's answers (27 Oct 2026, OB-423):
//   (a) every release ATTEMPT is its own note — its key is the box + the release commit + the pipeline run + the attempt
//       (`qg10NoteKey`); the attempt is the pipeline's attempt number, or, run by hand, the box's own UTC time of it;
//   (b) one machine login PER COMPUTER — a login's user id names its computer (`qg10-release-<box>`,
//       `qg10ComputerOfLogin`), and a note is believed only from the login of the computer it names.
//
// No I/O, no clock.

import { QUALITY_GATES } from './gate-decisions';

/** The five things QG-10 names, in the script's order. */
export const QG10_CHECKS = Object.freeze(['health', 'smoke', 'reconciliation', 'monitoring', 'rollback'] as const);
export type Qg10Check = (typeof QG10_CHECKS)[number];
/** Every state a check can be in (scripts/lib/release-reconcile.mjs STATES). */
export const QG10_CHECK_STATES = Object.freeze(['verified', 'failed', 'not_run', 'not_run_on_this_box', 'ready', 'exercised_ok', 'exercised_failed'] as const);
/** Every outcome release.sh records a QG-10 line for. */
export const QG10_OUTCOMES = Object.freeze(['deployed', 'rolled_back', 'rolled_back_on_reconcile', 'rolled_back_in_canary_bake', 'rollback_failed', 'refused_books_unreadable'] as const);
/** The sentence every line carries instead of a decision. */
export const QG10_NOT_A_DECISION = 'not decided here — this is evidence for the owner\'s QG-10 decision in the gate register (QG-12: silence is not approval)';
export const QG10_PASS_CONDITION: string = QUALITY_GATES.find((g) => g.gate === 'QG-10')!.passCondition;

const FIELDS = Object.freeze(['gate', 'passCondition', 'release', 'previous', 'at', 'by', 'run', 'attempt', 'box', 'outcome', 'checks', 'verified', 'notVerified', 'differences', 'decision']);
const MAX_DIFFERENCES = 100;
const MAX_DIFFERENCE_LENGTH = 1000;

/** One release attempt's QG-10 evidence line, as read. */
export interface Qg10ReleaseNote {
  readonly gate: 'QG-10';
  readonly passCondition: string;
  /** The commit that was released. */
  readonly release: string;
  /** The commit it replaced. */
  readonly previous: string;
  readonly at: string;
  /** Who merged it (the pipeline's actor) — a name, never a sign-in. */
  readonly by: string;
  readonly run: string;
  /**
   * OB-423 (a): which attempt of that run — the pipeline's attempt number ("1", "2", …), or, for a release run by hand on
   * the box (run "manual"), "local-<UTC yyyymmddThhmmssZ>", the box's own time of the attempt.
   */
  readonly attempt: string;
  /** Which box ran the release (its host name). */
  readonly box: string;
  readonly outcome: (typeof QG10_OUTCOMES)[number];
  readonly checks: Readonly<Record<Qg10Check, (typeof QG10_CHECK_STATES)[number]>>;
  readonly verified: boolean;
  readonly notVerified: readonly Qg10Check[];
  readonly differences: readonly string[];
  readonly decision: typeof QG10_NOT_A_DECISION;
}

/** A QG-10 line as head office keeps it: the line, who posted it, when, and a digest of the line. */
export interface Qg10EvidenceRecord extends Qg10ReleaseNote {
  readonly recordedBy: string;
  readonly recordedAt: string;
  readonly noteDigest: string;
}

export class NotAQg10NoteError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`not a QG-10 evidence line: ${problems.join('; ')}`);
    this.name = 'NotAQg10NoteError';
  }
}

const SHA = /^[0-9a-f]{40}$/;
const ACTOR = /^[A-Za-z0-9._@-]{1,64}$/;
const RUN = /^[A-Za-z0-9._:/-]{1,80}$/;
const BOX = /^[A-Za-z0-9._-]{1,64}$/;
/** OB-423 (a): a pipeline attempt number, or a box-local attempt time. */
const ATTEMPT = /^(?:[1-9][0-9]{0,5}|local-\d{8}T\d{6}Z)$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

const passes = (check: Qg10Check, state: string): boolean =>
  state === 'verified' || (check === 'rollback' && (state === 'ready' || state === 'exercised_ok'));

/** Which of the five checks a set of states leaves not verified — the one rule the script and head office share. */
export function qg10NotVerified(checks: Readonly<Record<Qg10Check, string>>): readonly Qg10Check[] {
  return QG10_CHECKS.filter((c) => !passes(c, checks[c]));
}

/** Read one QG-10 line. Throws NotAQg10NoteError naming every problem; never fills a gap. */
export function readQg10Note(input: unknown): Qg10ReleaseNote {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new NotAQg10NoteError(['it is not a QG-10 evidence line at all']);
  const o = input as Record<string, unknown>;
  const problems: string[] = [];
  const extra = Object.keys(o).filter((k) => !FIELDS.includes(k));
  if (extra.length > 0) problems.push(`it carries fields a QG-10 line does not have (${extra.join(', ')})`);
  if (o['gate'] !== 'QG-10') problems.push('gate is not QG-10');
  if (o['passCondition'] !== QG10_PASS_CONDITION) problems.push('passCondition is not QG-10\'s (roadmap §22)');
  if (typeof o['release'] !== 'string' || !SHA.test(o['release'])) problems.push('release is not a 40-character commit id');
  if (typeof o['previous'] !== 'string' || !(SHA.test(o['previous']) || o['previous'] === 'none')) problems.push('previous is not a 40-character commit id');
  if (typeof o['at'] !== 'string' || !ISO.test(o['at']) || Number.isNaN(Date.parse(o['at']))) problems.push('at is not a UTC time');
  if (typeof o['by'] !== 'string' || !ACTOR.test(o['by'])) problems.push('by is not a readable name');
  if (typeof o['run'] !== 'string' || !RUN.test(o['run'])) problems.push('run is not a readable pipeline run');
  if (typeof o['attempt'] !== 'string' || !ATTEMPT.test(o['attempt'])) problems.push('attempt is not a pipeline attempt number or a box-local attempt time');
  if (typeof o['box'] !== 'string' || !BOX.test(o['box'])) problems.push('box is not a readable host name');
  if (typeof o['outcome'] !== 'string' || !(QG10_OUTCOMES as readonly string[]).includes(o['outcome'])) problems.push(`outcome is not one of ${QG10_OUTCOMES.join(', ')}`);
  const checks = o['checks'];
  let checksOk = false;
  if (checks === null || typeof checks !== 'object' || Array.isArray(checks)) problems.push('checks is missing');
  else {
    const c = checks as Record<string, unknown>;
    const keys = Object.keys(c);
    const wrongKeys = keys.length !== QG10_CHECKS.length || !QG10_CHECKS.every((k) => keys.includes(k));
    if (wrongKeys) problems.push(`checks must be exactly ${QG10_CHECKS.join(', ')}`);
    const badStates = QG10_CHECKS.filter((k) => !(QG10_CHECK_STATES as readonly string[]).includes(c[k] as string));
    if (!wrongKeys && badStates.length > 0) problems.push(`checks ${badStates.join(', ')} not in a known state`);
    checksOk = !wrongKeys && badStates.length === 0;
  }
  const notVerified = checksOk ? qg10NotVerified(checks as Record<Qg10Check, string>) : [];
  if (typeof o['verified'] !== 'boolean') problems.push('verified is not true or false');
  else if (checksOk && o['verified'] !== (notVerified.length === 0)) problems.push('verified does not follow from the checks');
  if (!Array.isArray(o['notVerified']) || !o['notVerified'].every((x) => typeof x === 'string')) problems.push('notVerified is not a list');
  else if (checksOk && JSON.stringify(o['notVerified']) !== JSON.stringify(notVerified)) problems.push('notVerified does not follow from the checks');
  const diffs = o['differences'];
  if (!Array.isArray(diffs) || !diffs.every((d) => typeof d === 'string' && d.length > 0 && d.length <= MAX_DIFFERENCE_LENGTH) || diffs.length > MAX_DIFFERENCES) {
    problems.push(`differences is not a list of at most ${MAX_DIFFERENCES} sentences`);
  }
  if (o['decision'] !== QG10_NOT_A_DECISION) problems.push('decision must be the script\'s "not decided here" sentence — a QG-10 line is evidence, never a decision (QG-12)');
  if (problems.length > 0) throw new NotAQg10NoteError(problems);
  const c = checks as Record<Qg10Check, (typeof QG10_CHECK_STATES)[number]>;
  return {
    gate: 'QG-10', passCondition: QG10_PASS_CONDITION,
    release: o['release'] as string, previous: o['previous'] as string, at: o['at'] as string,
    by: o['by'] as string, run: o['run'] as string, attempt: o['attempt'] as string, box: o['box'] as string,
    outcome: o['outcome'] as Qg10ReleaseNote['outcome'],
    checks: Object.fromEntries(QG10_CHECKS.map((k) => [k, c[k]])) as Qg10ReleaseNote['checks'],
    verified: notVerified.length === 0, notVerified, differences: [...(diffs as string[])],
    decision: QG10_NOT_A_DECISION,
  };
}

/**
 * OB-423 (a): the one note a box leaves for ONE release ATTEMPT — keyed on the commit released, the box that released it,
 * the pipeline run and the attempt. Every attempt is its own note; the same attempt's note again is the same note; a
 * different note under an attempt already noted is refused, never written over.
 */
export const qg10NoteKey = (n: Pick<Qg10ReleaseNote, 'release' | 'box' | 'run' | 'attempt'>): string => `${n.release}|${n.box}|${n.run}|${n.attempt}`;

/** OB-423 (b): every computer that runs releases has its OWN QG-10 machine login, whose user id names it. */
export const QG10_LOGIN_PREFIX = 'qg10-release-';
/** The computer a QG-10 machine login belongs to (`qg10-release-<box>` → `<box>`), or undefined when it names none. */
export function qg10ComputerOfLogin(userId: string): string | undefined {
  if (!userId.startsWith(QG10_LOGIN_PREFIX)) return undefined;
  const box = userId.slice(QG10_LOGIN_PREFIX.length);
  return BOX.test(box) ? box : undefined;
}

/** Newest release attempt first (by the line's own time, then when head office recorded it): the Quality gates page's order. */
export function newestQg10First(records: readonly Qg10EvidenceRecord[]): readonly Qg10EvidenceRecord[] {
  const cmp = (a: string, z: string): number => (a < z ? 1 : a > z ? -1 : 0);
  return [...records].sort((a, z) => cmp(a.at, z.at) || cmp(a.recordedAt, z.recordedAt));
}
