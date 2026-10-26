// QG-10 · WF-20 "deploy/canary → smoke/RECONCILE → monitor → rollback" — the post-deploy reconcile, pure.
//
// Roadmap §22 QG-10 Production: "Health, smoke, reconciliation, monitoring and rollback verified after every release."
// `infra/deploy/release.sh` takes a SNAPSHOT of head office's books just before a release touches anything, and another
// after the new release is up, GREEN and (on a canary box) watched — and asks `compareSnapshots` whether they agree:
//
//   • THE LEDGER. Every event that was on the ledger before the release is still there, unchanged: the same count, the
//     same digest over (sequence, id, idempotency key) up to the last sequence before the release, the same count per
//     ledger family (sales, stock, cash, …). New events after it are trading and are fine; a lost or altered one is not
//     (hard rule #2, append-only). The ledger never shrinks.
//   • THE OUTBOX. No new dead letters (a message head office has given up on) and the pending backlog has not grown by
//     more than the box's allowance (`SRE_RECONCILE_MAX_BACKLOG_GROWTH`, default 0).
//   • A snapshot that cannot be read is a DIFFERENCE, never a pass (P-08).
//
// `qg10Record` writes the per-release QG-10 evidence line: each of the five things the gate names, verified or not, the
// differences in words, and the plain statement that the record is EVIDENCE for the owner's QG-10 decision — never a
// decision itself (QG-12: "silence is not approval"; a gate decision is a named person's, in the gate register).
//
// No I/O, no clock: the CLI (`scripts/release-reconcile.mjs`) does the reading and the writing.

/** @typedef {{ count: number, maxSeq: number, digest: string, byFamily: Record<string, number> }} LedgerFacts */
/** @typedef {{ version: 1, at: string, ledger: LedgerFacts, outbox: { pending: number, deadLetter: number, oldestPendingSeconds: number | null }, upTo?: { seq: number, count: number, digest: string, byFamily: Record<string, number> } }} Snapshot */

const isCount = (v) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isFamilies = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every(isCount);

/** Why a snapshot cannot be trusted, or undefined when it can. */
export function snapshotProblem(s) {
  if (s === null || typeof s !== 'object') return 'it is not a snapshot at all';
  if (s.version !== 1) return 'it is not a version-1 snapshot';
  const l = s.ledger;
  if (l === null || typeof l !== 'object' || !isCount(l.count) || !isCount(l.maxSeq) || typeof l.digest !== 'string' || !isFamilies(l.byFamily)) return 'its ledger figures cannot be read';
  const o = s.outbox;
  if (o === null || typeof o !== 'object' || !isCount(o.pending) || !isCount(o.deadLetter)) return 'its outbox figures cannot be read';
  if (s.upTo !== undefined) {
    const u = s.upTo;
    if (u === null || typeof u !== 'object' || !isCount(u.seq) || !isCount(u.count) || typeof u.digest !== 'string' || !isFamilies(u.byFamily)) return 'its before-the-release ledger figures cannot be read';
  }
  return undefined;
}

/** Read a snapshot from text (the snapshot command's output). Undefined when it is not one. */
export function parseSnapshot(text) {
  try {
    const s = JSON.parse(String(text).trim());
    return snapshotProblem(s) === undefined ? s : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Do the books after the release agree with the books before it? `after` must have been taken with `upTo` = the last
 * sequence `before` saw. Returns every difference, in words; `ok` only when there are none.
 * @param {unknown} before @param {unknown} after
 * @param {{ maxBacklogGrowth?: number, maxDeadLetterGrowth?: number }} [policy]
 */
export function compareSnapshots(before, after, policy = {}) {
  const differences = [];
  const bad = (which, s) => { const p = snapshotProblem(s); if (p !== undefined) differences.push(`the ${which} snapshot cannot be trusted: ${p}`); return p !== undefined; };
  const beforeBad = bad('before-release', before);
  const afterBad = bad('after-release', after);
  if (beforeBad || afterBad) return { ok: false, differences };
  const maxBacklog = isCount(policy.maxBacklogGrowth) ? policy.maxBacklogGrowth : 0;
  const maxDead = isCount(policy.maxDeadLetterGrowth) ? policy.maxDeadLetterGrowth : 0;
  const b = before; const a = after;

  // The ledger, up to where it stood before the release.
  if (a.upTo === undefined) {
    differences.push('the after-release snapshot does not re-read the ledger up to where it stood before the release');
  } else {
    if (a.upTo.seq !== b.ledger.maxSeq) differences.push(`the after-release snapshot re-read the ledger up to sequence ${a.upTo.seq}, not ${b.ledger.maxSeq} where it stood before`);
    if (a.upTo.count !== b.ledger.count) differences.push(`the ledger held ${b.ledger.count} event(s) before the release and holds ${a.upTo.count} of them now — ${a.upTo.count < b.ledger.count ? 'some were LOST' : 'some appeared in the past'}`);
    if (a.upTo.digest !== b.ledger.digest) differences.push('the events that were on the ledger before the release are not the same events now (their digest differs) — something was changed or replaced');
    const families = [...new Set([...Object.keys(b.ledger.byFamily), ...Object.keys(a.upTo.byFamily)])].sort();
    for (const f of families) {
      const was = b.ledger.byFamily[f] ?? 0; const now = a.upTo.byFamily[f] ?? 0;
      if (was !== now) differences.push(`the "${f}" ledger had ${was} event(s) before the release and ${now} of those now`);
    }
  }
  if (a.ledger.maxSeq < b.ledger.maxSeq || a.ledger.count < b.ledger.count) {
    differences.push(`the ledger shrank: ${b.ledger.count} event(s) up to sequence ${b.ledger.maxSeq} before, ${a.ledger.count} up to ${a.ledger.maxSeq} after`);
  }
  // The outbox and the sync backlog.
  const dead = a.outbox.deadLetter - b.outbox.deadLetter;
  if (dead > maxDead) differences.push(`${dead} new dead letter(s) in the outbox since the release (from ${b.outbox.deadLetter} to ${a.outbox.deadLetter}; allowed +${maxDead})`);
  if (dead < 0) differences.push(`dead letters went DOWN from ${b.outbox.deadLetter} to ${a.outbox.deadLetter} — a dead letter is never deleted (hard rule #6)`);
  const backlog = a.outbox.pending - b.outbox.pending;
  if (backlog > maxBacklog) differences.push(`the sync backlog grew by ${backlog} (from ${b.outbox.pending} pending to ${a.outbox.pending}; allowed +${maxBacklog})`);
  return { ok: differences.length === 0, differences };
}

const CHECKS = ['health', 'smoke', 'reconciliation', 'monitoring', 'rollback'];
const STATES = new Set(['verified', 'failed', 'not_run', 'not_run_on_this_box', 'ready', 'exercised_ok', 'exercised_failed']);

/**
 * The per-release QG-10 evidence line. `checks` holds one state per thing QG-10 names; `verified` is true only when
 * health, smoke, reconciliation and monitoring are `verified` and rollback is `ready` or `exercised_ok`.
 * @param {{ sha: string, previous: string, at: string, by: string, run: string, box: string, outcome: string,
 *           checks: Record<string, string>, differences?: readonly string[] }} input
 */
export function qg10Record(input) {
  const checks = Object.fromEntries(CHECKS.map((c) => [c, STATES.has(input.checks?.[c]) ? input.checks[c] : 'not_run']));
  const verified = ['health', 'smoke', 'reconciliation', 'monitoring'].every((c) => checks[c] === 'verified')
    && (checks.rollback === 'ready' || checks.rollback === 'exercised_ok');
  return {
    gate: 'QG-10',
    passCondition: 'Health, smoke, reconciliation, monitoring and rollback verified after every release.',
    release: input.sha, previous: input.previous, at: input.at, by: input.by, run: input.run, box: input.box,
    outcome: input.outcome, checks, verified,
    notVerified: CHECKS.filter((c) => !(checks[c] === 'verified' || (c === 'rollback' && (checks[c] === 'ready' || checks[c] === 'exercised_ok')))),
    differences: [...(input.differences ?? [])],
    decision: 'not decided here — this is evidence for the owner\'s QG-10 decision in the gate register (QG-12: silence is not approval)',
  };
}
