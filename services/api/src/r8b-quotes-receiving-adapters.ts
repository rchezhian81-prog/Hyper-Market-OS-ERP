// Round 8 · R8-B (owner decisions OB-523, OB-525, OB-529, 28 Oct 2026) — head office's wiring for quotations and the
// opening-stock rule at receiving. Kept in its own file: main.ts carries only spread lines.
//
//   • OB-525 — a quotation's floors are head office's own: each product's floor price at the quotation's store, read the
//     same way the till's floor is (OB-500: the average buying cost there, lifted by the store's margin floor). The issue
//     route compares every line with it; a product never received at a cost is "floor not known", said, never zero.
//   • OB-523 — a quotation freed from a cancelled bill is appended as its own `QuotationStateChanged` fact, keyed on the
//     release (one cancelled bill, one quotation) — so the convert before it stays in the log and a re-send collapses.
//   • OB-529 — the cutover GO as the gate recorded it (the tenant's FIRST GO stands, OB-52 / GT-05): before it, an
//     `opening-` receipt with no order keeps the opening-stock exemption; after it, the receipt follows the full rules.
//
// Reads only, except the one append for a freed quotation.

import type { EventStore } from '../../../packages/persistence/src/event-store';
import type { DurableTenantSettings } from '../../../packages/tenant/src/durable-settings';
import type { PackSigner } from '../../catalogue/src/pack';
import { makeEvent } from '../../../packages/contracts/src/event';
import type { Quotation, QuotationRelease } from '../../../packages/suspended-sales/src/index';
import type { CutoverGo } from '../../migration/src/opening-reversal';
import type { QuotationsDeps } from '../../pos/src/quotations';
import type { GoodsReceiptDeps } from '../../inventory/src/goods-receipt';
import { STREAM, streamName } from './adapters';
import { floorsAt } from './r7a-till-controls-adapters';

interface Base { readonly store: EventStore; readonly now: () => string; readonly settings: DurableTenantSettings; readonly signer: PackSigner }

/** OB-525 · OB-523: what the quotation routes take from this round, spread after `quotationsAdapter` in main.ts. */
export function r8bQuotationHooks(input: Base): Pick<QuotationsDeps, 'floorsAt' | 'recordFreed'> {
  // The same stream the quotation adapter folds (latest state per quotation wins).
  const stream = streamName(STREAM.sales, 'quotations');
  return {
    floorsAt: (tenantId, storeId, productIds) => floorsAt(input, tenantId, storeId, productIds),
    recordFreed: async (tenantId: string, q: Quotation, release: QuotationRelease) => {
      await input.store.append(tenantId, stream, makeEvent({
        id: `quote-${q.quotationId}-freed-${release.freeId}`,
        type: 'QuotationStateChanged',
        occurredAt: release.recordedAt,
        idempotencyKey: `quote-${tenantId}-${q.quotationId}-freed-${release.freeId}`,
        source: 'api/pos',
        payload: q as unknown as Record<string, unknown>,
      }));
    },
  };
}

/** OB-529: when the shop's cutover GO was given (the tenant's first GO), or undefined while no GO is on record. */
export function r8bReceiptHooks(input: Pick<Base, 'store'>): Pick<GoodsReceiptDeps, 'cutoverGoAt'> {
  const goStream = streamName(STREAM.migration, 'cutover-go');
  return {
    cutoverGoAt: async (tenantId) => {
      const first = (await input.store.readStream(tenantId, goStream, { type: 'CutoverGoRecorded' }))[0];
      return first === undefined ? undefined : (first.event.payload as unknown as CutoverGo).goAt;
    },
  };
}
