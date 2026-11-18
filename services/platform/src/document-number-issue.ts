// TAKING A DOCUMENT NUMBER IN THE SAME SAVE AS THE DOCUMENT (owner, 18 Nov 2026: "Document numbers, format A" — OB-847 ·
// OB-844 A · OB-845 A · OB-846 A · M01-FR-02 · hard rules #2, #6, #10 · P-08).
//
// Every document that is not a till bill is numbered WHERE IT IS SAVED — on the store computer (head office's API runs
// there, ADR-0032) — and the number is taken in the SAME atomic append as the document itself:
//
//   • THE COUNTER is the write guard of the range (`docno:<prefix>/<YY-YY>`, db/migrations/0014): a row updated under its
//     row lock, in the same transaction as the document's events — `UPDATE … SET version = version + 1 WHERE version = $read`.
//     Its version IS the count of numbers taken in that range that year, so the next number is version + 1. Two saves at
//     the same moment read the same version; one lands and bumps it, the other's whole batch rolls back by name
//     (`ConcurrencyConflictError`) and is re-tried here with the new count — never a duplicate, never a gap.
//   • THE ISSUE RECORD is an append-only event in the same batch (`DocumentNumberIssued`, stream `document-numbers`), whose
//     event id is the number itself. The database refuses a second event with the same id under another key, so even a
//     write that somehow skipped the guard could not give one number twice. Nothing is ever updated or removed (hard rule #2).
//   • NO GAPS: a save that fails (a refusal, a crash, a rolled-back batch) takes no number — the guard's bump and the issue
//     record roll back with it. A cancelled or voided document keeps its number: cancelling is a later event; the number
//     stays on the document and the screens say "Cancelled".
//   • A RE-SENT SAVE (a lost reply) finds its own issue record by its idempotency key (`docno:<kind>:<document id>`) and gets
//     the SAME number back; its document events dedup as before.
//   • A document saved BEFORE format A (its events already on the ledger) is never given a number: old records keep theirs
//     (OB-845 A).
//   • OB-844 A: 5 digits. From 90,000 the answer carries a warning; at 99,999 the range refuses by name (`numbers_used_up`)
//     — it never wraps. (A TILL's range moves to its +50 range instead — that is the till's own register.)

import type { Route } from '../../kernel/src/index';
import type { EventStore, BatchEntry, AppendOptions, WriteGuard, PersistedEvent } from '../../../packages/persistence/src/event-store';
import { ConcurrencyConflictError, EventIdClashError } from '../../../packages/persistence/src/event-store';
import { makeEvent } from '../../../packages/contracts/src/event';
import {
  DOCUMENT_KINDS, DOCUMENT_COUNT_MAX, companyPrefix, storePrefix, financialYearLabel, formatDocumentNumber, rangeWarning, readDocumentNumber,
  type DocumentNumberKind,
} from '../../../packages/numbering/src/document-numbers';

export const DOCUMENT_NUMBERS_STREAM = 'document-numbers';
export const DOCUMENT_NUMBER_ISSUED = 'DocumentNumberIssued';
/** How many times a save re-reads its range after losing a race (each loss means someone else's save landed). */
const RETRIES = 200;

/** One number, as it was issued — the append-only record. */
export interface DocumentNumberIssue {
  readonly number: string;
  readonly kind: DocumentNumberKind;
  readonly prefix: string;
  readonly yearLabel: string;
  readonly count: number;
  /** The record the number belongs to (its own id: the PO id, the GRN id, …). */
  readonly documentRef: string;
  /** The store a store-ranged number belongs to, when it is one. */
  readonly storeId?: string;
  readonly issuedAt: string;
}

export class DocumentNumbersUsedUp extends Error {
  constructor(readonly prefix: string, readonly yearLabel: string) {
    super(`The ${prefix} range for ${yearLabel} has used all ${DOCUMENT_COUNT_MAX} numbers. Nothing was saved — tell the owner.`);
    this.name = 'DocumentNumbersUsedUp';
  }
}

/** Where a document's number comes from: its kind, and — for a store-ranged kind — its store's number (1–9). */
export interface NumberRange {
  readonly kind: DocumentNumberKind;
  readonly storeNumber?: number;
  readonly storeId?: string;
}

/** The prefix a range numbers under (`PO`, `GRN1`, …). */
export function prefixOf(range: NumberRange): string {
  const scope = DOCUMENT_KINDS[range.kind].scope;
  if (scope === 'company') return companyPrefix(range.kind);
  if (scope === 'store') return storePrefix(range.kind, range.storeNumber ?? Number.NaN);
  throw new RangeError(`${range.kind} is numbered on the till's own store computer, never here`);
}

export const rangeGuardKey = (prefix: string, yearLabel: string): string => `docno:${prefix}/${yearLabel}`;
const issueKey = (kind: DocumentNumberKind, documentRef: string): string => `docno:${kind}:${documentRef}`;

export interface NumberedSave {
  /** The number this document carries. */
  readonly number: string;
  /** False when this was a re-send that found its number already taken. */
  readonly fresh: boolean;
  /** OB-844 A: true from count 90,000 in the range — said to the manager. */
  readonly warn: boolean;
  readonly remaining: number;
}

/** The issue already recorded for a document, if any (a re-send of the same save). */
export async function issuedNumberFor(store: EventStore, tenantId: string, kind: DocumentNumberKind, documentRef: string): Promise<DocumentNumberIssue | undefined> {
  const e = await store.findByIdempotencyKey(tenantId, issueKey(kind, documentRef));
  return e === undefined ? undefined : e.event.payload as DocumentNumberIssue;
}

/**
 * Save a document WITH its number, in one atomic append (header). `entries(number)` builds the document's own events with the
 * number in them; `options` carries the caller's own write guards (a budget, a balance), which are held together with the
 * range's. Answers the number, or `null` when the document was already saved BEFORE format A (it keeps no new number).
 *
 * @throws DocumentNumbersUsedUp at 99,999 — nothing saved.
 */
export async function appendWithDocumentNumber(store: EventStore, tenantId: string, input: {
  readonly range: NumberRange;
  readonly documentRef: string;
  /** The document's date — its financial year is the shop's date of this instant. */
  readonly at: string;
  readonly timeZone?: string;
  readonly entries: (number: string) => readonly BatchEntry[];
  readonly options?: AppendOptions;
}): Promise<NumberedSave | null> {
  const prior = await issuedNumberFor(store, tenantId, input.range.kind, input.documentRef);
  if (prior !== undefined) {
    // A re-send of a save that already landed: the same number; the document's own events dedup.
    await store.appendBatch(tenantId, input.entries(prior.number), input.options);
    return { number: prior.number, fresh: false, ...rangeWarning(prior.count) };
  }
  // OB-845 A: a document saved before format A is never renumbered — if its events are all on the ledger already, they
  // are appended as they were (a dedup) and it carries no new number.
  const probe = input.entries('');
  if (probe.length > 0) {
    const held = await Promise.all(probe.map((e) => store.findByIdempotencyKey(tenantId, e.event.idempotencyKey)));
    if (held.every((h) => h !== undefined)) {
      await store.appendBatch(tenantId, probe, input.options);
      return null;
    }
  }
  const prefix = prefixOf(input.range);
  const yearLabel = financialYearLabel(input.at, input.timeZone);
  const key = rangeGuardKey(prefix, yearLabel);
  for (let attempt = 0; ; attempt += 1) {
    const version = await store.guardVersion(tenantId, key);
    const count = version + 1;
    if (count > DOCUMENT_COUNT_MAX) throw new DocumentNumbersUsedUp(prefix, yearLabel);
    const number = formatDocumentNumber(prefix, yearLabel, count);
    const issue: DocumentNumberIssue = {
      number, kind: input.range.kind, prefix, yearLabel, count, documentRef: input.documentRef,
      ...(input.range.storeId === undefined ? {} : { storeId: input.range.storeId }), issuedAt: input.at,
    };
    const numberEntry: BatchEntry = {
      stream: DOCUMENT_NUMBERS_STREAM,
      event: makeEvent({
        // The number IS the event id: the database refuses one id under two keys, so a number can never be issued twice.
        id: `docno-${number}`, type: DOCUMENT_NUMBER_ISSUED, occurredAt: input.at,
        idempotencyKey: issueKey(input.range.kind, input.documentRef), source: 'platform/document-numbers', payload: issue,
      }),
    };
    const rangeGuard: WriteGuard = { key, expectedVersion: version };
    const options: AppendOptions = input.options?.guard === undefined
      ? { guard: rangeGuard }
      : { ...input.options, alsoGuards: [...(input.options.alsoGuards ?? []), rangeGuard] };
    try {
      const results = await store.appendBatch(tenantId, [...input.entries(number), numberEntry], options);
      const mine = results[results.length - 1];
      if (mine !== undefined && mine.deduped) {
        // Another save of the SAME document landed first: its number is the document's.
        const kept = mine.record.event.payload as DocumentNumberIssue;
        return { number: kept.number, fresh: false, ...rangeWarning(kept.count) };
      }
      return { number, fresh: true, ...rangeWarning(count) };
    } catch (e) {
      // Someone else took this count at the same moment: read the range again and take the next one.
      // (A store that checks event ids before guards says so as an id clash on THIS number's record — the same race.)
      if (attempt < RETRIES && ((e instanceof ConcurrencyConflictError && e.key === key) || (e instanceof EventIdClashError && e.eventId === numberEntry.event.id))) {
        // A short, growing, random pause after the first few losses, so many saves at one moment take turns fairly.
        if (attempt >= 3) await new Promise((r) => { setTimeout(r, Math.random() * Math.min(50, attempt * 2)); });
        continue;
      }
      throw e;
    }
  }
}

/** Every number issued (the append-only record), oldest first. */
export async function issuedDocumentNumbers(store: EventStore, tenantId: string): Promise<readonly DocumentNumberIssue[]> {
  const events: readonly PersistedEvent[] = await store.readStream(tenantId, DOCUMENT_NUMBERS_STREAM, { type: DOCUMENT_NUMBER_ISSUED });
  return events.map((e) => e.event.payload as DocumentNumberIssue);
}

/** One range's standing, for the manager's screen (P-08: a range running out is said, never discovered). */
export interface RangeStanding {
  readonly prefix: string;
  readonly yearLabel: string;
  readonly kind: DocumentNumberKind;
  readonly words: string;
  readonly issued: number;
  readonly lastNumber: string;
  readonly remaining: number;
  readonly warn: boolean;
  readonly says?: string;
}

/** Each range's count, last number and warning — folded from the issue record. Pure. */
export function rangeStandings(issues: readonly DocumentNumberIssue[]): readonly RangeStanding[] {
  const by = new Map<string, DocumentNumberIssue>();
  const counts = new Map<string, number>();
  for (const i of issues) {
    const k = `${i.prefix}/${i.yearLabel}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
    const cur = by.get(k);
    if (cur === undefined || i.count > cur.count) by.set(k, i);
  }
  return [...by.entries()].map(([k, i]) => {
    const w = rangeWarning(i.count);
    return {
      prefix: i.prefix, yearLabel: i.yearLabel, kind: i.kind, words: DOCUMENT_KINDS[i.kind].words, issued: counts.get(k) ?? 0,
      lastNumber: i.number, remaining: w.remaining, warn: w.warn,
      ...(w.warn ? { says: `${DOCUMENT_KINDS[i.kind].words} numbers ${i.prefix}/${i.yearLabel} have reached ${i.count.toLocaleString('en-IN')}; ${w.remaining.toLocaleString('en-IN')} are left this financial year. Tell the owner.` } : {}),
    };
  }).sort((a, b) => (a.prefix === b.prefix ? (a.yearLabel < b.yearLabel ? 1 : -1) : a.prefix < b.prefix ? -1 : 1));
}

/** What the document-numbers read needs: the issue record, and each store's tills' codes and their banked till ranges. */
export interface DocumentNumbersDeps {
  readonly issues: (tenantId: string) => Promise<readonly DocumentNumberIssue[]>;
  /** Each store: its number, each till lane's code, and the highest count head office holds in each format-A till range. */
  readonly tills: (tenantId: string) => Promise<readonly {
    readonly storeId: string; readonly storeNumber: number; readonly laneCodes: Readonly<Record<string, string>>; readonly banked: Readonly<Record<string, number>>;
  }[]>;
  readonly now: () => string;
}

/**
 * OB-847 · OB-844 A: `GET /v1/document-numbers` — every range, its last number and what is left this year, with the
 * 90,000 warning said in words (P-03: only a range running out is flagged); and each till's lane code, given automatically.
 */
export function documentNumberRoutes(deps: DocumentNumbersDeps): readonly Route[] {
  return [{
    api: 'API-01', method: 'GET', path: '/v1/document-numbers',
    permission: 'org.branch.read',
    handler: async (ctx) => {
      const inScope = (s: string): boolean => ctx.scope === undefined || ctx.scope === 'all' || ctx.scope.includes(s);
      const ranges = rangeStandings((await deps.issues(ctx.tenantId)).filter((i) => i.storeId === undefined || inScope(i.storeId)));
      const tills = (await deps.tills(ctx.tenantId)).filter((t) => inScope(t.storeId)).map((t) => ({
        storeId: t.storeId, storeNumber: t.storeNumber,
        lanes: Object.entries(t.laneCodes).map(([laneId, code]) => ({ laneId, code: `${t.storeNumber}${code}` })).sort((a, b) => (a.code < b.code ? -1 : 1)),
        ranges: Object.entries(t.banked).map(([head, count]) => {
          const w = rangeWarning(count);
          return { head, lastNumber: `${head}${String(count).padStart(5, '0')}`, remaining: w.remaining, warn: w.warn,
            ...(w.warn ? { says: `Till numbers ${head.slice(0, -1)} have reached ${count.toLocaleString('en-IN')}; at 99,999 the till moves to its next range by itself. Tell the owner.` } : {}) };
        }).sort((a, b) => (a.head < b.head ? -1 : 1)),
      }));
      const warnings = [...ranges.filter((r) => r.warn).map((r) => r.says!), ...tills.flatMap((t) => t.ranges.filter((r) => r.warn).map((r) => r.says!))];
      return { status: 200, body: { ranges, tills, warnings, rule: 'PREFIX/YY-YY/NNNNN — at most 16 characters; restarts each 1 April (shop date); a warning from 90,000', asAt: deps.now() } };
    },
  }];
}

/** A record's number for a screen: its format-A number when it has one, else what it was always called (OB-845 A). */
export function shownNumber(record: { readonly documentNumber?: unknown }, fallback: string): string {
  return readDocumentNumber(record.documentNumber) === undefined ? fallback : String(record.documentNumber);
}
