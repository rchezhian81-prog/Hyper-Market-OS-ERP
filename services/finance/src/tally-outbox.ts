// API-09 Finance — the DAILY TALLY FILE OUTBOX (OB-293 "a daily Tally import file first" · M23-FR-04 "Tally connector,
// retry queue, period close and balance validation" · M32-FR-04 · D10-FR-06 · D14-FR-03 · §27 "Tally queue" · P-08 ·
// hard rules #2, #6, #10).
//
// Tally is a DESTINATION, not the book of record. The shop's append-only ledger is the truth; every day, a COPY of every
// journal the ledger posted for that day goes to the accountant as ONE Tally import file. This is the stored outbox that
// carries it there — durable, idempotent, with a dead letter — built on the tested engine in `@sre/period-close`
// (`drainToTally`, `deadLetters`, `requeueCorrected`, `backoffSeconds`) and the file writer in `@sre/tally-export`:
//
//   • QUEUE. Once a shop day has ENDED, every journal dated that day that no earlier file carries is queued as one posting
//     (`tally-day:<day>:<n>`). Its idempotency key is the day and the exact journals in it, so queuing the same day twice
//     queues nothing twice; a journal posted to an already-sent day later (a late bill) goes in the day's NEXT file, once.
//   • DRAIN. For each queued posting that is due (computed backoff after a failure): the file is built from the ledger's
//     journals, read back through the stand-in import check, and STORED (the shop's own store — object storage's
//     stand-in). Stored and importable → `posted`, and the accountant can download it. A journal the file cannot carry (an
//     account the accountant has not named in Tally, a journal that does not balance) is a REJECTION: it goes straight to
//     the dead letter with the reason, without burning retries — retrying cannot fix a missing ledger name. A store that
//     could not take the file is RETRYABLE, with backoff; after the attempt budget it dead-letters too.
//   • WAITING IS NOT FAILING. Until the accountant has named the Tally company and ledgers, nothing is attempted: each
//     posting says it waits for the ledger names (visible, never a silent zero, never a dead letter of its own).
//   • THE DEAD LETTER IS NEVER EMPTIED BY DELETION (hard rule #6). A dead-lettered day stays on the list for ever; the way
//     out is a person saying what they fixed and REQUEUEING it, which is a NEW posting with a new key beside the original.
//   • THE MONTH-END EVIDENCE PACK reads `deadLetteredInPeriod` from here — the real count, not a typed number.
//
// Every fact is appended (queued, attempted, file stored, requeued, downloaded). Nothing here changes a figure in the
// books, and no AI writes here (hard rule #5).

import { createHash } from 'node:crypto';
import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import {
  drainToTally, deadLetters, requeueCorrected, backoffSeconds,
  type QueuedPosting, type TallyOutcome, type ConnectorPolicy,
} from '../../../packages/period-close/src/index';
import {
  buildDailyTallyFile, gstAccountsOf, TALLY_FAMILIES, TALLY_FAMILY_WORDS,
  type GlJournal, type TallyFamily, type FamilyTotals, type GstLedgerTotal, type TallyControlTotals,
} from '../../../packages/tally-export/src/index';
import type { PostingMap } from '../../../packages/finance/src/posting';
import type { TallyLedgerNames } from './tally-export';

/** A queued day: the engine's posting, plus which day, which file of the day, and which journals it carries. */
export interface TallyDayPosting extends QueuedPosting {
  readonly day: string;
  readonly sequence: number;
  readonly journalIds: readonly string[];
  /** For a requeued posting: the dead-lettered one it corrects. */
  readonly corrects?: string;
}

/** A stored daily file — what the accountant downloads. */
export interface TallyDayFile {
  readonly postingId: string;
  readonly day: string;
  readonly sequence: number;
  readonly fileName: string;
  readonly xml: string;
  /** `sha256:<hex>` of the xml — the file's identity, and its voucher reference. */
  readonly sha256: string;
  readonly controlTotals: TallyControlTotals;
  readonly byFamily: readonly FamilyTotals[];
  readonly gst: readonly GstLedgerTotal[];
  readonly ledgerNamesVersion: number;
  readonly companyName: string;
  readonly builtAt: string;
}

/** One append-only fact about the outbox. */
export type TallyOutboxFact =
  | { readonly change: 'queued'; readonly posting: TallyDayPosting; readonly by: string; readonly at: string }
  | { readonly change: 'attempted'; readonly posting: QueuedPosting; readonly by: string; readonly at: string }
  | { readonly change: 'requeued'; readonly originalPostingId: string; readonly posting: TallyDayPosting; readonly reason: string; readonly by: string; readonly at: string }
  | { readonly change: 'downloaded'; readonly postingId: string; readonly by: string; readonly at: string };

export interface TallyOutboxDeps {
  /** Every journal the ledger holds (the `JournalPosted` facts), whatever route posted it. */
  readonly journals: (tenantId: string) => Promise<readonly GlJournal[]> | readonly GlJournal[];
  /** The accountant's Tally company and ledger names in force (the same record the payables export reads). */
  readonly ledgerNames: (tenantId: string) => Promise<TallyLedgerNames | undefined> | TallyLedgerNames | undefined;
  /** The accountant's posting map in force — which accounts carry GST is read from it. */
  readonly postingMap: (tenantId: string) => Promise<PostingMap | undefined> | PostingMap | undefined;
  readonly facts: (tenantId: string) => Promise<readonly TallyOutboxFact[]> | readonly TallyOutboxFact[];
  /** Append one fact. Idempotent on the key. */
  readonly record: (tenantId: string, fact: TallyOutboxFact, key: string) => Promise<void> | void;
  readonly files: (tenantId: string) => Promise<readonly TallyDayFile[]> | readonly TallyDayFile[];
  /** Store a built file. Throws when the store cannot take it — that attempt is then retried with backoff. */
  readonly storeFile: (tenantId: string, file: TallyDayFile) => Promise<void> | void;
  /** P-08: a day that reached the dead letter is raised to the people who answer for the books. */
  readonly raiseDeadLetter?: (tenantId: string, posting: TallyDayPosting, at: string) => Promise<void> | void;
  /**
   * The shop's TRADING day of an instant — the tenant's zone and its trading-day cut-off (packages/calendar/src/shop-clock.ts).
   * A day is "ended" only once its trading day has, so a sale after midnight but before a later cut-off is in its file.
   */
  readonly shopDayOf: (iso: string, tenantId: string) => string | Promise<string>;
  readonly policy?: ConnectorPolicy;
  readonly now: () => string;
}

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isPeriod = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);

/** The outbox folded: every posting at its latest state, in the order it was queued. */
export function foldOutbox(facts: readonly TallyOutboxFact[]): readonly TallyDayPosting[] {
  const byId = new Map<string, TallyDayPosting>();
  for (const f of facts) {
    if (f.change === 'queued' || f.change === 'requeued') {
      if (!byId.has(f.posting.postingId)) byId.set(f.posting.postingId, f.posting);
    } else if (f.change === 'attempted') {
      const cur = byId.get(f.posting.postingId);
      // Only a later attempt moves a posting: an attempt never takes a posted or dead-lettered posting back.
      if (cur !== undefined && cur.state === 'queued') byId.set(cur.postingId, { ...cur, ...f.posting, day: cur.day, sequence: cur.sequence, journalIds: cur.journalIds, ...(cur.corrects === undefined ? {} : { corrects: cur.corrects }) });
    }
  }
  return [...byId.values()];
}

/** How many of a month's days the accounts never received — dead-lettered and not yet carried by a later posting. */
export function deadLetteredInPeriod(postings: readonly TallyDayPosting[], period: string): number {
  const corrected = new Set(postings.filter((p) => p.corrects !== undefined && p.state === 'posted').map((p) => p.corrects!));
  return deadLetters(postings).filter((p) => p.period === period && !corrected.has(p.postingId)).length;
}

/**
 * QUEUE every ended day's journals that no posting carries yet. Pure over its inputs: returns the postings to append.
 * A journal is "carried" once any posting names it — posted, queued, dead-lettered or requeued — so nothing is sent twice
 * and a dead-lettered journal leaves only by its requeue.
 */
export function postingsToQueue(input: {
  readonly journals: readonly GlJournal[];
  readonly existing: readonly TallyDayPosting[];
  readonly today: string;
  readonly at: string;
}): readonly TallyDayPosting[] {
  const carried = new Set(input.existing.flatMap((p) => p.journalIds));
  const byDay = new Map<string, GlJournal[]>();
  for (const j of input.journals) {
    if (carried.has(j.entryId) || !/^\d{4}-\d{2}-\d{2}$/.test(j.documentDate) || j.documentDate >= input.today) continue;
    const list = byDay.get(j.documentDate) ?? [];
    list.push(j);
    byDay.set(j.documentDate, list);
  }
  const out: TallyDayPosting[] = [];
  for (const day of [...byDay.keys()].sort()) {
    const mine = byDay.get(day)!.sort((a, b) => a.entryId.localeCompare(b.entryId));
    const journalIds = mine.map((j) => j.entryId);
    const sequence = input.existing.filter((p) => p.day === day && p.corrects === undefined).length + 1;
    const postingId = `tally-day:${day}:${sequence}`;
    out.push({
      postingId, idempotencyKey: `tally-day:${sha(`${day}|${journalIds.join('|')}`).slice(0, 32)}`,
      period: day.slice(0, 7), journalRef: postingId, day, sequence, journalIds,
      debitMinor: mine.reduce((s, j) => s + j.lines.reduce((t, l) => t + l.debitMinor, 0), 0),
      creditMinor: mine.reduce((s, j) => s + j.lines.reduce((t, l) => t + l.creditMinor, 0), 0),
      state: 'queued', attempts: 0, queuedAt: input.at,
    });
  }
  return out;
}

/** Due now: queued, and past the computed backoff after its last attempt. */
export function isDue(p: QueuedPosting, now: string, policy?: ConnectorPolicy): boolean {
  if (p.state !== 'queued') return false;
  if (p.lastAttemptAt === undefined || p.attempts === 0) return true;
  return Date.parse(now) - Date.parse(p.lastAttemptAt) >= backoffSeconds(p.attempts, policy) * 1000;
}

export interface OutboxPass {
  readonly queued: readonly string[];
  readonly posted: readonly string[];
  readonly retrying: readonly string[];
  readonly deadLettered: readonly string[];
  readonly notYetDue: readonly string[];
  /** Set when nothing could be attempted because the accountant has not named the Tally company and ledgers. */
  readonly waitingFor?: 'ledger_names';
  readonly detail: string;
  readonly asAt: string;
}

/** ONE PASS of the outbox — queue the ended days, then attempt every due posting. What the worker runs on its timer. */
export async function runTallyOutbox(deps: TallyOutboxDeps, tenantId: string, by: string): Promise<OutboxPass> {
  const at = deps.now();
  const today = await deps.shopDayOf(at, tenantId);
  const journals = await deps.journals(tenantId);
  const before = foldOutbox(await deps.facts(tenantId));
  const fresh = postingsToQueue({ journals, existing: before, today, at });
  for (const p of fresh) await deps.record(tenantId, { change: 'queued', posting: p, by, at }, `queued|${p.postingId}|${p.idempotencyKey}`);
  const postings = [...before, ...fresh];
  const names = await deps.ledgerNames(tenantId);
  const due = postings.filter((p) => isDue(p, at, deps.policy));
  const notYetDue = postings.filter((p) => p.state === 'queued' && !isDue(p, at, deps.policy)).map((p) => p.postingId);
  if (names === undefined) {
    return {
      queued: fresh.map((p) => p.postingId), posted: [], retrying: [], deadLettered: [], notYetDue: due.map((p) => p.postingId).concat(notYetDue),
      waitingFor: 'ledger_names', asAt: at,
      detail: `${postings.filter((p) => p.state === 'queued').length} day file(s) wait for the accountant to name the Tally company and ledgers — nothing was attempted, nothing was lost.`,
    };
  }
  const byId = new Map(journals.map((j) => [j.entryId, j]));
  const gstAccounts = gstAccountsOf(await deps.postingMap(tenantId));
  // Build and store each due day's file FIRST (asynchronously); the engine then decides each posting's state from the
  // outcome — accepted, rejected (straight to the dead letter) or retryable (backoff, then the dead letter). Keyed by the
  // posting's idempotency key: a requeue carries its original's journal reference but always a key of its own.
  const outcomes = new Map<string, TallyOutcome>();
  for (const p of due) {
    const mine = p.journalIds.map((id) => byId.get(id));
    if (mine.some((j) => j === undefined)) {
      outcomes.set(p.idempotencyKey, { result: 'rejected', reason: `the ledger no longer shows journal(s) ${p.journalIds.filter((id) => !byId.has(id)).join(', ')} — a person must look` });
      continue;
    }
    const file = buildDailyTallyFile({
      day: p.day, sequence: p.sequence, companyName: names.companyName, ledgerNames: names.names,
      ...(names.voucherTypes === undefined ? {} : { voucherTypes: names.voucherTypes }),
      journals: mine as GlJournal[], gstAccounts,
    });
    if (!file.importable) {
      const why = [
        ...file.export.exceptions.map((e) => `${e.entryId}: ${e.detail}`),
        ...file.check.problems,
        ...(file.export.vouchers.length === 0 && file.export.exceptions.length === 0 ? ['the file would hold no voucher'] : []),
      ];
      outcomes.set(p.idempotencyKey, { result: 'rejected', reason: why.join('; ') });
      continue;
    }
    const stored: TallyDayFile = {
      postingId: p.postingId, day: p.day, sequence: p.sequence, fileName: file.fileName, xml: file.export.xml,
      sha256: `sha256:${sha(file.export.xml)}`, controlTotals: file.export.controlTotals, byFamily: file.byFamily, gst: file.gst,
      ledgerNamesVersion: names.version, companyName: names.companyName, builtAt: at,
    };
    try {
      await deps.storeFile(tenantId, stored);
      outcomes.set(p.idempotencyKey, { result: 'accepted', voucherRef: stored.sha256 });
    } catch (err) {
      outcomes.set(p.idempotencyKey, { result: 'retryable', reason: `the file could not be stored: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
  const drained = drainToTally(due, {
    version: 'sre-daily-file-v1',
    post: (input) => outcomes.get(input.idempotencyKey) ?? { result: 'retryable', reason: 'no outcome was worked out for this posting' },
  }, at, deps.policy);
  const posted: string[] = [];
  const retrying: string[] = [];
  const dead: string[] = [];
  for (const after of drained.postings) {
    await deps.record(tenantId, { change: 'attempted', posting: after, by, at }, `attempted|${after.postingId}|${after.attempts}`);
    if (after.state === 'posted') posted.push(after.postingId);
    else if (after.state === 'dead_lettered') {
      dead.push(after.postingId);
      const full = postings.find((p) => p.postingId === after.postingId)!;
      await deps.raiseDeadLetter?.(tenantId, { ...full, ...after, day: full.day, sequence: full.sequence, journalIds: full.journalIds }, at);
    } else retrying.push(after.postingId);
  }
  return {
    queued: fresh.map((p) => p.postingId), posted, retrying, deadLettered: dead, notYetDue, asAt: at,
    detail: dead.length > 0
      ? `${posted.length} file(s) ready, ${retrying.length} to retry, ${dead.length} in the dead letter waiting for a person — nothing was dropped`
      : `${posted.length} file(s) ready, ${retrying.length} to retry`,
  };
}

/** A posting as the accountant's screen reads it. */
function viewOf(p: TallyDayPosting, files: ReadonlyMap<string, TallyDayFile>, waiting: boolean, now: string, policy?: ConnectorPolicy, all: readonly TallyDayPosting[] = []) {
  const f = files.get(p.postingId);
  // A dead-lettered day stays dead-lettered on the record (hard rule #6); the requeue that carries it is named beside it.
  const by = all.find((x) => x.corrects === p.postingId);
  return {
    postingId: p.postingId, day: p.day, sequence: p.sequence, period: p.period, state: p.state, attempts: p.attempts,
    journals: p.journalIds.length, debitMinor: p.debitMinor, creditMinor: p.creditMinor,
    queuedAt: p.queuedAt, lastAttemptAt: p.lastAttemptAt ?? null, postedAt: p.postedAt ?? null,
    deadLetteredAt: p.deadLetteredAt ?? null, lastFailure: p.lastFailure ?? null, corrects: p.corrects ?? null,
    waitingFor: p.state === 'queued' && waiting ? 'ledger_names' : null,
    correctedBy: by === undefined ? null : { postingId: by.postingId, state: by.state },
    nextAttemptAt: p.state === 'queued' && p.lastAttemptAt !== undefined && !isDue(p, now, policy)
      ? new Date(Date.parse(p.lastAttemptAt) + backoffSeconds(p.attempts, policy) * 1000).toISOString() : null,
    file: f === undefined ? null : { fileName: f.fileName, sha256: f.sha256, controlTotals: f.controlTotals, byFamily: f.byFamily, gst: f.gst, ledgerNamesVersion: f.ledgerNamesVersion },
  };
}

export function tallyOutboxRoutes(deps: TallyOutboxDeps): readonly Route[] {
  const state = async (t: string) => {
    const [facts, files, names] = await Promise.all([deps.facts(t), deps.files(t), deps.ledgerNames(t)]);
    return { facts, postings: foldOutbox(facts), files: new Map(files.map((f) => [f.postingId, f])), names };
  };
  return [
    {
      // The queue as the accountant sees it: every day's file, newest first; the dead letter, worst first; the counts.
      api: 'API-09', method: 'GET', path: '/v1/finance/tally/outbox',
      permission: 'finance.period.read',
      handler: async (ctx) => {
        const now = deps.now();
        const s = await state(ctx.tenantId);
        const waiting = s.names === undefined;
        const ordered = [...s.postings].sort((a, b) => b.day.localeCompare(a.day) || b.sequence - a.sequence || b.postingId.localeCompare(a.postingId));
        const dead = deadLetters(s.postings) as readonly TallyDayPosting[];
        const periods = [...new Set(s.postings.map((p) => p.period))].sort();
        return {
          status: 200,
          body: {
            postings: ordered.map((p) => viewOf(p, s.files, waiting, now, deps.policy, s.postings)),
            deadLetters: dead.map((p) => viewOf(p, s.files, waiting, now, deps.policy, s.postings)),
            // Dead-lettered days NOT yet carried by a posted requeue — what still waits for a person.
            openDeadLetters: dead.filter((p) => !s.postings.some((x) => x.corrects === p.postingId && x.state === 'posted')).length,
            counts: {
              posted: s.postings.filter((p) => p.state === 'posted').length,
              queued: s.postings.filter((p) => p.state === 'queued').length,
              deadLettered: dead.length,
            },
            deadLetteredByPeriod: periods.map((period) => ({ period, deadLettered: deadLetteredInPeriod(s.postings, period) })),
            ledgerNames: s.names === undefined ? null : { companyName: s.names.companyName, version: s.names.version, voucherTypes: s.names.voucherTypes ?? {} },
            waitingFor: waiting ? 'ledger_names' : null,
            families: TALLY_FAMILIES.map((f) => ({ family: f, words: TALLY_FAMILY_WORDS[f] })),
            asAt: now,
          },
        };
      },
    },
    {
      // One pass on demand — queue the ended days and attempt every due one (the worker runs the same on its timer).
      api: 'API-09', method: 'POST', path: '/v1/finance/tally/outbox/run',
      permission: 'finance.posting.configure', idempotent: true,
      handler: async (ctx) => ({ status: 200, body: await runTallyOutbox(deps, ctx.tenantId, ctx.userId) }),
    },
    {
      // REQUEUE a dead-lettered day once a person has fixed the cause. Body: { reason }. The dead-lettered posting stays
      // exactly as it was (hard rule #6); the requeue is a NEW posting with its own key, carrying the same journals.
      api: 'API-09', method: 'POST', path: '/v1/finance/tally/outbox/:postingId/requeue',
      permission: 'finance.posting.configure', idempotent: true,
      handler: async (ctx) => {
        const postingId = ctx.params['postingId'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!isStr(b['reason'])) {
          throw apiError(400, { code: 'requeue_needs_a_reason', whatHappened: 'Requeueing a day that failed needs { reason }: what was fixed, so the record says why the month changed.', wasItSaved: 'not_saved', nextSafeAction: 'Say what you fixed (for example "named the ledger for card receipts"). Nothing was changed.' });
        }
        const s = await state(ctx.tenantId);
        const original = s.postings.find((p) => p.postingId === postingId);
        if (original === undefined) throw notFound(`Tally day file ${postingId}`);
        const already = s.postings.find((p) => p.corrects === postingId);
        if (already !== undefined) return { status: 200, body: { requeued: false, alreadyRequeuedAs: already.postingId, detail: `${postingId} was already requeued as ${already.postingId}.` } };
        const n = s.postings.filter((p) => p.postingId.startsWith(`${postingId}:r`)).length + 1;
        const result = requeueCorrected({
          original, correctedPostingId: `${postingId}:r${n}`, correctedIdempotencyKey: `${original.idempotencyKey}:r${n}`,
          fixedBy: ctx.userId, reason: (b['reason'] as string).trim(), at: deps.now(),
        });
        if (!result.requeued) {
          throw apiError(409, { code: 'not_dead_lettered', whatHappened: result.detail, wasItSaved: 'not_saved', nextSafeAction: 'Only a day in the dead letter is requeued; a posted or waiting day needs nothing. Nothing was changed.' });
        }
        const fresh = result.postings[1]!;
        const posting: TallyDayPosting = { ...fresh, day: original.day, sequence: original.sequence, journalIds: original.journalIds, corrects: postingId };
        await deps.record(ctx.tenantId, { change: 'requeued', originalPostingId: postingId, posting, reason: (b['reason'] as string).trim(), by: ctx.userId, at: deps.now() }, `requeued|${posting.postingId}`);
        return { status: 201, body: { requeued: true, posting: viewOf(posting, s.files, s.names === undefined, deps.now(), deps.policy), detail: result.detail } };
      },
    },
    {
      // DOWNLOAD one day's file (the accountant imports it into Tally). Every download is recorded: who took which file.
      api: 'API-09', method: 'GET', path: '/v1/finance/tally/files/:postingId',
      permission: 'finance.period.read',
      handler: async (ctx) => {
        const postingId = ctx.params['postingId'] ?? '';
        const s = await state(ctx.tenantId);
        const p = s.postings.find((x) => x.postingId === postingId);
        if (p === undefined) throw notFound(`Tally day file ${postingId}`);
        const f = s.files.get(postingId);
        if (p.state !== 'posted' || f === undefined) {
          throw apiError(409, {
            code: 'tally_file_not_ready',
            whatHappened: p.state === 'dead_lettered'
              ? `The file for ${p.day} could not be made: ${p.lastFailure ?? 'see the dead letter'}. It is in the dead letter, never lost.`
              : `The file for ${p.day} is not ready yet${s.names === undefined ? ' — the accountant has not named the Tally company and ledgers' : ''}.`,
            wasItSaved: 'not_saved',
            nextSafeAction: p.state === 'dead_lettered' ? 'Fix what is named, then requeue the day.' : 'Wait for the next run, or run the outbox now.',
          });
        }
        const at = deps.now();
        await deps.record(ctx.tenantId, { change: 'downloaded', postingId, by: ctx.userId, at }, `downloaded|${postingId}|${ctx.userId}|${at}`);
        const downloads = s.facts.filter((x): x is Extract<TallyOutboxFact, { change: 'downloaded' }> => x.change === 'downloaded' && x.postingId === postingId);
        return {
          status: 200,
          body: {
            ...f, contentType: 'application/xml', state: p.state,
            downloadedBefore: downloads.map((d) => ({ by: d.by, at: d.at })),
            detail: 'Import this file in Tally (Gateway of Tally → Import → Vouchers). Importing it twice makes no second voucher: each voucher carries the shop\'s own id.',
          },
        };
      },
    },
    {
      // The month's dead-letter count, as the evidence pack reads it (the real figure, never typed).
      api: 'API-09', method: 'GET', path: '/v1/finance/tally/outbox/periods/:period',
      permission: 'finance.period.read',
      handler: async (ctx) => {
        const period = ctx.params['period'] ?? '';
        if (!isPeriod(period)) throw apiError(400, { code: 'bad_period', whatHappened: `'${period}' is not a month (YYYY-MM).`, wasItSaved: 'not_saved', nextSafeAction: 'Send the month as YYYY-MM.' });
        const s = await state(ctx.tenantId);
        const mine = s.postings.filter((p) => p.period === period);
        return {
          status: 200,
          body: {
            period, deadLettered: deadLetteredInPeriod(s.postings, period),
            posted: mine.filter((p) => p.state === 'posted').length, queued: mine.filter((p) => p.state === 'queued').length,
            days: [...new Set(mine.map((p) => p.day))].sort(), asAt: deps.now(),
          },
        };
      },
    },
  ];
}

/** Which family words a screen shows — re-exported for the page. */
export type { TallyFamily };
