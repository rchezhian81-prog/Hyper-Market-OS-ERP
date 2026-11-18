// SEVERAL DOCUMENT NUMBERS IN ONE SAVE (OB-847 follow-up · OB-850): a save that records more than one numbered document —
// a count plan's held write-offs, the damaged items a floor receipt writes off — gives EACH its own number, all in the
// same atomic append as the documents. The same rule as `appendWithDocumentNumber` (document-number-issue.ts):
//
//   • each range's write guard is its counter; a batch taking k numbers from one range reads its version v, takes
//     v+1 … v+k, and moves the guard by k (one guard bump per number, held together in the same transaction);
//   • each number has its own append-only `DocumentNumberIssued` record whose event id is the number;
//   • a re-sent save finds each document's issue by its key and gets the SAME numbers back; a failed save takes none.

import type { EventStore, BatchEntry, AppendOptions, WriteGuard } from '../../../packages/persistence/src/event-store';
import { ConcurrencyConflictError, EventIdClashError } from '../../../packages/persistence/src/event-store';
import { makeEvent } from '../../../packages/contracts/src/event';
import { DOCUMENT_COUNT_MAX, financialYearLabel, formatDocumentNumber } from '../../../packages/numbering/src/document-numbers';
import {
  DOCUMENT_NUMBERS_STREAM, DOCUMENT_NUMBER_ISSUED, DocumentNumbersUsedUp, issuedNumberFor, prefixOf, rangeGuardKey,
  type DocumentNumberIssue, type NumberRange,
} from './document-number-issue';

const RETRIES = 200;

export interface NumberedDocument {
  readonly range: NumberRange;
  /** The record the number belongs to (its own id). Distinct within one save. */
  readonly documentRef: string;
}

/**
 * Save several documents WITH a number each, in ONE atomic append. `entries(numbers)` builds the documents' events with
 * `numbers[i]` for `docs[i]` (an empty string while probing whether they were saved before format A). Answers the numbers
 * in order; `null` for a document saved before format A (it keeps no new number). With no documents, it is a plain append.
 *
 * @throws DocumentNumbersUsedUp when a range would pass 99,999 — nothing saved.
 */
export async function appendWithDocumentNumbers(store: EventStore, tenantId: string, input: {
  readonly docs: readonly NumberedDocument[];
  readonly at: string;
  readonly timeZone?: string;
  readonly entries: (numbers: readonly string[]) => readonly BatchEntry[];
  readonly options?: AppendOptions;
}): Promise<readonly (string | null)[]> {
  if (input.docs.length === 0) {
    await store.appendBatch(tenantId, input.entries([]), input.options);
    return [];
  }
  const priors = await Promise.all(input.docs.map((d) => issuedNumberFor(store, tenantId, d.range.kind, d.documentRef)));
  if (priors.every((p) => p !== undefined)) {
    // A re-send of a save that already landed: the same numbers; the documents' events dedup.
    const numbers = priors.map((p) => p!.number);
    await store.appendBatch(tenantId, input.entries(numbers), input.options);
    return numbers;
  }
  // OB-845 A: documents whose events are all on the ledger already were saved before format A — appended as they were.
  const probe = input.entries(input.docs.map(() => ''));
  if (probe.length > 0) {
    const held = await Promise.all(probe.map((e) => store.findByIdempotencyKey(tenantId, e.event.idempotencyKey)));
    if (held.every((h) => h !== undefined)) {
      await store.appendBatch(tenantId, probe, input.options);
      return input.docs.map(() => null);
    }
  }
  const yearLabel = financialYearLabel(input.at, input.timeZone);
  const prefixes = input.docs.map((d) => prefixOf(d.range));
  const keys = [...new Set(prefixes.map((p) => rangeGuardKey(p, yearLabel)))];
  for (let attempt = 0; ; attempt += 1) {
    const versions = new Map<string, number>();
    for (const k of keys) versions.set(k, await store.guardVersion(tenantId, k));
    const taken = new Map<string, number>();
    const issues: DocumentNumberIssue[] = input.docs.map((d, i) => {
      const prior = priors[i];
      if (prior !== undefined) return prior;
      const key = rangeGuardKey(prefixes[i]!, yearLabel);
      const count = versions.get(key)! + (taken.get(key) ?? 0) + 1;
      taken.set(key, (taken.get(key) ?? 0) + 1);
      if (count > DOCUMENT_COUNT_MAX) throw new DocumentNumbersUsedUp(prefixes[i]!, yearLabel);
      return {
        number: formatDocumentNumber(prefixes[i]!, yearLabel, count), kind: d.range.kind, prefix: prefixes[i]!, yearLabel, count,
        documentRef: d.documentRef, ...(d.range.storeId === undefined ? {} : { storeId: d.range.storeId }), issuedAt: input.at,
      };
    });
    const numberEntries: BatchEntry[] = issues.filter((_, i) => priors[i] === undefined).map((issue) => ({
      stream: DOCUMENT_NUMBERS_STREAM,
      event: makeEvent({
        id: `docno-${issue.number}`, type: DOCUMENT_NUMBER_ISSUED, occurredAt: input.at,
        idempotencyKey: `docno:${issue.kind}:${issue.documentRef}`, source: 'platform/document-numbers', payload: issue,
      }),
    }));
    // One guard per number taken from a range, at v, v+1, … v+k-1: the store checks and bumps them in that order in this one
    // transaction, so the range's version — its count — moves from v to v+k, or nothing moves at all.
    const guards: WriteGuard[] = [];
    for (const [key, n] of taken) for (let j = 0; j < n; j += 1) guards.push({ key, expectedVersion: versions.get(key)! + j });
    const options: AppendOptions | undefined = guards.length === 0 ? input.options
      : input.options?.guard === undefined
        ? { guard: guards[0]!, alsoGuards: guards.slice(1) }
        : { ...input.options, alsoGuards: [...(input.options.alsoGuards ?? []), ...guards] };
    try {
      // The issue records go FIRST, in number order: every save takes the numbers' rows in the same order, so two saves that
      // reach for the same numbers wait for each other, never deadlock.
      const ordered = [...numberEntries].sort((x, y) => (x.event.id < y.event.id ? -1 : x.event.id > y.event.id ? 1 : 0));
      await store.appendBatch(tenantId, [...ordered, ...input.entries(issues.map((i) => i.number))], options);
      return issues.map((i) => i.number);
    } catch (e) {
      const ourKey = e instanceof ConcurrencyConflictError && keys.includes(e.key);
      const ourId = e instanceof EventIdClashError && numberEntries.some((n) => n.event.id === e.eventId);
      // PostgreSQL's own answer to a lock cycle (40P01): the transaction rolled back whole — take fresh numbers and try again.
      const deadlock = typeof e === 'object' && e !== null && (e as { code?: unknown }).code === '40P01';
      if (attempt < RETRIES && (ourKey || ourId || deadlock)) {
        if (attempt >= 3) await new Promise((r) => { setTimeout(r, Math.random() * Math.min(50, attempt * 2)); });
        continue;
      }
      throw e;
    }
  }
}

