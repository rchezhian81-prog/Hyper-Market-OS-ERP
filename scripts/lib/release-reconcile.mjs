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
 * OB-423 (a): `run` and `attempt` name the release ATTEMPT — the pipeline's run id and attempt number, or, by hand on the
 * box, run "manual" and attempt "local-<UTC yyyymmddThhmmssZ>". Every attempt is its own line and its own note.
 * @param {{ sha: string, previous: string, at: string, by: string, run: string, attempt: string, box: string, outcome: string,
 *           checks: Record<string, string>, differences?: readonly string[] }} input
 */
export function qg10Record(input) {
  const checks = Object.fromEntries(CHECKS.map((c) => [c, STATES.has(input.checks?.[c]) ? input.checks[c] : 'not_run']));
  const verified = ['health', 'smoke', 'reconciliation', 'monitoring'].every((c) => checks[c] === 'verified')
    && (checks.rollback === 'ready' || checks.rollback === 'exercised_ok');
  return {
    gate: 'QG-10',
    passCondition: 'Health, smoke, reconciliation, monitoring and rollback verified after every release.',
    release: input.sha, previous: input.previous, at: input.at, by: input.by, run: input.run, attempt: input.attempt, box: input.box,
    outcome: input.outcome, checks, verified,
    notVerified: CHECKS.filter((c) => !(checks[c] === 'verified' || (c === 'rollback' && (checks[c] === 'ready' || checks[c] === 'exercised_ok')))),
    differences: [...(input.differences ?? [])],
    decision: 'not decided here — this is evidence for the owner\'s QG-10 decision in the gate register (QG-12: silence is not approval)',
  };
}

// ── OB-423 (owner, 27 Oct 2026): the QG-10 line goes to head office's gate register ──────────────────────────────────────
// The release script posts its QG-10 line under its OWN limited machine identity (role `qg10_release_evidence`: it may only
// add QG-10 release evidence). The key is supplied by the custodian at deploy time, in a root-only file on the box named by
// SRE_QG10_PUSH_TOKEN_FILE (docs/runbooks/automatic-deployment.md, docs/runbooks/environments-and-secrets.md) — never in the
// repository, never in deploy.conf, never on a command line, never printed. Whatever happens, the release goes on and the
// box's own QG-10 log keeps the line: a note that was not posted is SAID, in words, every time (P-08).

/** Head office's route for the release script's note (services/compliance/src/qg10-evidence.ts). */
export const QG10_NOTE_PATH = '/v1/compliance/gate-register/qg10-evidence';

const NOT_POSTED = 'QG-10 note NOT POSTED to head office\'s gate register';

/** Where a note may go: https, or this box's own loopback (the pilot box is head office). Never an address with a sign-in in it. */
export function registerAddressProblem(url) {
  const base = String(url ?? '').trim();
  if (base === '') return 'no register address is set (SRE_QG10_REGISTER_URL)';
  let u;
  try { u = new URL(base); } catch { return 'the register address (SRE_QG10_REGISTER_URL) is not an address'; }
  if (u.username !== '' || u.password !== '') return 'the register address (SRE_QG10_REGISTER_URL) carries a sign-in — refused, it would be a secret in a setting';
  if (u.protocol === 'https:') return undefined;
  if (u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost')) return undefined;
  return 'the register address (SRE_QG10_REGISTER_URL) is neither https nor this box\'s own loopback';
}

/**
 * Post one QG-10 line. Never throws: answers { posted, outcome, words } — `words` is the one sentence release.sh prints.
 * `token` is the key's text ('' = none configured); `fetch` is injected; the token never appears in `words`.
 * @param {{ line: string, url: string, token: string, idempotencyKey: string, noKeyBecause?: string,
 *           fetch: (url: string, init: object) => Promise<{ status: number, text: () => Promise<string>, headers?: { get: (n: string) => string | null } }> }} input
 */
export async function postQg10Note(input) {
  const { line, url, token, idempotencyKey, fetch } = input;
  let note;
  try { note = JSON.parse(line); } catch { note = undefined; }
  if (note === null || typeof note !== 'object' || note.gate !== 'QG-10') {
    return { posted: false, outcome: 'no_line', words: `${NOT_POSTED} — there is no readable QG-10 line for this attempt.` };
  }
  const which = `release ${note.release}, box ${note.box}, run ${note.run}, attempt ${note.attempt}`;
  if (String(token ?? '').trim() === '') {
    return { posted: false, outcome: 'no_key', words: `${NOT_POSTED} (${which}) — ${input.noKeyBecause ?? 'no key is configured on this box (SRE_QG10_PUSH_TOKEN_FILE)'}. The line is kept in this box's QG-10 log only; the custodian supplies the key (docs/runbooks/automatic-deployment.md).` };
  }
  const problem = registerAddressProblem(url);
  if (problem !== undefined) return { posted: false, outcome: 'no_address', words: `${NOT_POSTED} (${which}) — ${problem}. The line is kept in this box's QG-10 log only.` };
  let status; let body = ''; let replayed = false;
  try {
    const res = await fetch(`${String(url).trim().replace(/\/+$/, '')}${QG10_NOTE_PATH}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${String(token).trim()}`, 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
      body: JSON.stringify({ note }),
    });
    status = res.status;
    // The same note under the same key again: head office replays its first answer and says so.
    try { replayed = typeof res.headers?.get === 'function' && res.headers.get('idempotent-replay') === 'true'; } catch { replayed = false; }
    try { body = await res.text(); } catch { body = ''; }
  } catch {
    return { posted: false, outcome: 'unreachable', words: `${NOT_POSTED} (${which}) — head office could not be reached at SRE_QG10_REGISTER_URL. The line is kept in this box's QG-10 log only.` };
  }
  let code = '';
  let already = false;
  try { const j = JSON.parse(body); code = typeof j?.error?.code === 'string' ? j.error.code : ''; already = j?.alreadyRecorded === true; } catch { /* not JSON: the status says it */ }
  const why = `HTTP ${status}${code === '' ? '' : ` ${code}`}`;
  if (status === 201 && !already && !replayed) return { posted: true, outcome: 'posted', words: `QG-10 note posted to head office's gate register (${which}).` };
  if (status === 200 || status === 201) return { posted: true, outcome: 'already_recorded', words: `QG-10 note already on head office's gate register (${which}) — nothing new posted.` };
  if (status === 409) return { posted: false, outcome: 'refused_second_note', words: `${NOT_POSTED} (${which}) — head office already holds a different note from this box for this release attempt and keeps the first (${why}). This attempt is in this box's QG-10 log.` };
  // OB-423 (b): one machine login per computer — this box's login is another computer's, or names none.
  if (status === 403 && (code === 'qg10_note_names_another_computer' || code === 'qg10_login_names_no_computer')) {
    return { posted: false, outcome: 'refused_other_computer', words: `${NOT_POSTED} (${which}) — this box's QG-10 machine login belongs to another computer (${why}); each computer has its own. Tell the custodian.` };
  }
  if (status === 401 || status === 403) return { posted: false, outcome: 'refused_key', words: `${NOT_POSTED} (${which}) — head office refused this box's key (${why}). Tell the custodian.` };
  if (status === 400) return { posted: false, outcome: 'refused_note', words: `${NOT_POSTED} (${which}) — head office could not read the note (${why}).` };
  return { posted: false, outcome: 'refused', words: `${NOT_POSTED} (${which}) — head office answered ${why}. The line is kept in this box's QG-10 log only.` };
}
