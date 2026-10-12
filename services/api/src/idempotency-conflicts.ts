// Hard rule #10 · P-08 · OB-87 (verifier r18 OB85-1): a write that reuses an Idempotency-Key for DIFFERENT content is a
// visible exception at head office — never only a 409 that the sender quietly dead-letters.
//
// The kernel refuses such a write by name (`idempotency_key_reused`, nothing saved) and, before answering, hands it here
// (`KernelOptions.onIdempotencyConflict`). This keeps it on head office's own append-only register — one record per
// distinct conflicting request (a re-send of the same conflicting request collapses onto it) — read at
// `GET /v1/idempotency-conflicts`. A conflicting SALE is also raised where the owner already looks for bill problems:
// the sales exceptions (`receipt_number_reused`), because a box that re-issued a bill number (a restored disk, two boxes
// on one lane) re-sends a DIFFERENT bill under the SAME sale id and key — the customer's bill exists, head office did not
// bank it, and the number is on two bills.

import { createHash } from 'node:crypto';
import type { EventStore } from '../../../packages/persistence/src/event-store';
import { makeEvent } from '../../../packages/contracts/src/event';
import type { IdempotencyConflict, Route } from '../../kernel/src/index';
import type { SaleException, IncomingSale } from '../../pos/src/index';
import { billFingerprint } from '../../pos/src/index';
import { branchInScope, scopeOf } from '../../kernel/src/scope';
import { posAdapter, STREAM, streamName } from './adapters';

/** One conflicting request as head office keeps it. The body is not kept (it may hold personal data) — its hash is. */
export interface IdempotencyConflictRecord {
  readonly conflictId: string;
  readonly userId: string;
  readonly branchId?: string;
  readonly method: string;
  readonly routePath: string;
  readonly path: string;
  readonly idempotencyKey: string;
  readonly storedRequestHash: string;
  readonly requestHash: string;
  /** For a sale: the sale id and bill number the different content carried. */
  readonly saleId?: string;
  readonly receiptNumber?: string;
  readonly at: string;
  readonly detail: string;
  /**
   * Verifier r19 IC-2: what kind of conflict — `receipt_number_reused` (material) when a re-sent SALE carries a different
   * BILL (number, time, total, lines or tenders differ from the one banked); `resent_with_other_details` (informational)
   * when the bill is the same and only other details differ (a store computer upgrade adding a field); `key_reused`
   * (material) for any other write. Absent on a record kept before r19.
   */
  readonly kind?: 'receipt_number_reused' | 'resent_with_other_details' | 'key_reused';
  readonly severity?: 'material' | 'informational';
}

const STREAM_NAME = streamName(STREAM.platform, 'idempotency-conflicts');
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined);

export function idempotencyConflictsAdapter(input: { readonly store: EventStore; readonly now: () => string }): {
  readonly record: (c: IdempotencyConflict) => Promise<void>;
  readonly list: (tenantId: string) => Promise<readonly IdempotencyConflictRecord[]>;
} {
  const pos = posAdapter(input);
  return {
    record: async (c) => {
      const conflictId = createHash('sha256').update(JSON.stringify([c.idempotencyKey, c.requestHash])).digest('hex').slice(0, 32);
      const body = c.body !== null && typeof c.body === 'object' ? c.body as Record<string, unknown> : {};
      const isSale = c.method === 'POST' && c.routePath === '/v1/sales';
      const saleId = isSale ? str(body['saleId']) : undefined;
      const receiptNumber = isSale ? str(body['receiptNumber']) : undefined;
      const at = input.now();
      // Verifier r19 IC-2: is it a different BILL, or the same bill with other details changed? Judged on the route's own
      // fingerprint (number, time, total, lines, tenders) against the bill head office banked under the sale id.
      let sameBill = false;
      if (saleId !== undefined && pos.bankedSale !== undefined) {
        const first = await pos.bankedSale(c.tenantId, saleId);
        try { sameBill = first !== undefined && billFingerprint(first) === billFingerprint(body as unknown as IncomingSale); } catch { sameBill = false; }
      }
      const kind: NonNullable<IdempotencyConflictRecord['kind']> = saleId === undefined ? 'key_reused' : sameBill ? 'resent_with_other_details' : 'receipt_number_reused';
      const detail = kind === 'resent_with_other_details'
        ? `sale ${saleId!}${receiptNumber === undefined ? '' : ` (bill ${receiptNumber})`} was re-sent under the key head office banked it with; the BILL is the same (number, time, total, lines, tenders) and only other details differ — head office kept the first, nothing is missing`
        : saleId !== undefined
        ? `sale ${saleId}${receiptNumber === undefined ? '' : ` (bill ${receiptNumber})`} arrived again with DIFFERENT content under the key head office already banked it with — this bill was not banked`
        : `${c.method} ${c.path} arrived again with DIFFERENT content under an idempotency key already used — it was refused and nothing was saved`;
      const rec: IdempotencyConflictRecord = {
        conflictId, userId: c.userId, ...(c.branchId === undefined ? {} : { branchId: c.branchId }),
        method: c.method, routePath: c.routePath, path: c.path, idempotencyKey: c.idempotencyKey,
        storedRequestHash: c.storedRequestHash, requestHash: c.requestHash,
        ...(saleId === undefined ? {} : { saleId }), ...(receiptNumber === undefined ? {} : { receiptNumber }),
        at, detail, kind, severity: kind === 'resent_with_other_details' ? 'informational' : 'material',
      };
      await input.store.append(c.tenantId, STREAM_NAME, makeEvent({
        id: `idem-conflict-${conflictId}`, type: 'IdempotencyConflictRecorded', occurredAt: at,
        idempotencyKey: `idem-conflict-${c.tenantId}-${conflictId}`, source: 'api/platform', payload: rec,
      }));
      if (saleId !== undefined && kind === 'receipt_number_reused') {
        const finding: SaleException = {
          kind: 'receipt_number_reused', severity: 'material', saleId,
          ...(typeof body['totalMinor'] === 'number' ? { differenceMinor: body['totalMinor'] } : {}),
          detail: `${receiptNumber === undefined ? 'a bill' : `receipt ${receiptNumber}`} arrived a second time as a DIFFERENT bill under the same sale id ${saleId}: head office kept the first one and did NOT bank this one`,
          ownerAction: 'A store computer gave one bill number to two different bills (a computer restored from a backup, or two computers on one till). The customer holds the second bill, which head office has not banked. Find the second bill at the store computer (it is on its "needs a person" list), bank it by hand, and check that till\'s bill-number prefix.',
        };
        await pos.recordExceptions(c.tenantId, [finding]);
      }
    },
    list: async (tenantId) => (await input.store.readStream(tenantId, STREAM_NAME, { type: 'IdempotencyConflictRecorded' }))
      .map((e) => e.event.payload as IdempotencyConflictRecord),
  };
}

/** Head office's read of every write refused for reusing a key with different content (owner, operations). */
export function idempotencyConflictRoutes(input: { readonly store: EventStore | undefined; readonly now?: () => string }): readonly Route[] {
  const conflicts = input.store === undefined ? undefined : idempotencyConflictsAdapter({ store: input.store, now: input.now ?? (() => new Date().toISOString()) });
  return [{
    api: 'API-01', method: 'GET', path: '/v1/idempotency-conflicts',
    permission: 'platform.health.read',
    // Verifier r19 IC-1 (P-04): a reader whose authority is store-scoped sees only conflicts from the stores it holds; one
    // that names no store (or none placeable) is read only by a tenant-wide reader (owner, operations). Said in the answer.
    handler: async (ctx) => {
      const all = conflicts === undefined ? [] : await conflicts.list(ctx.tenantId);
      const scope = scopeOf(ctx);
      const mine = scope === 'all' ? all : all.filter((r) => r.branchId !== undefined && branchInScope(ctx, r.branchId));
      return { status: 200, body: { conflicts: mine, scope: scope === 'all' ? 'all' : [...scope] } };
    },
  }];
}
