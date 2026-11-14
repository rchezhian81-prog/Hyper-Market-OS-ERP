// API-04 — The QUARANTINE register (U6 of the UI/UX gap audit, 7 Nov 2026 · §27 Inventory "Quarantine" · M07-FR-03 ·
// M08-FR-02 · M10-FR-02 · P-03 · P-08).
//
// Stock in quarantine is counted but never sellable (M08-FR-02). Until U6 it was in two places and no register: the
// quality holds (a batch held for a sample, a cold-chain breach, a failed test — `/v1/quality/holds`) and the goods
// receipt lines a receiver quarantined at the door (damaged, temperature breach — on each GRN, waiting for a second
// person's disposition). A manager who asked "what is in quarantine right now?" had to open two pages and add them up.
//
// This route is ONE reading of both, as they stand: the batches on quality hold (held / failed / sampling / pending —
// everything not yet released or passed) and the receipt lines with quarantined stock and NO disposition yet. It writes
// nothing: a hold is placed and released on the quality routes, a receipt line is disposed on the goods-receipt route;
// the screen links to each. The figures are the records' own (hard rule #2) and the time they were read is said (P-08).

import type { Route } from '../../kernel/src/index';
import type { QualityHold } from '../../../packages/quality/src/index';
import type { GrnRecord } from './goods-receipt';
import { stockReadScope, type LocationBranches } from './location-scope';

export interface QuarantineDeps {
  /** Every batch's CURRENT quality hold record (the quality register's own fold). */
  readonly holds: (tenantId: string) => Promise<readonly QualityHold[]> | readonly QualityHold[];
  /** Every goods receipt on file (the GRN register's own fold). */
  readonly receipts: (tenantId: string) => Promise<readonly GrnRecord[]> | readonly GrnRecord[];
  readonly locationBranches?: LocationBranches;
  readonly now: () => string;
}

/** A receipt line with stock still in quarantine, as the register shows it. */
export interface QuarantinedReceiptLine {
  readonly grnId: string;
  readonly number: string;
  readonly lineId: string;
  readonly productId: string;
  readonly warehouseId: string;
  readonly quantityMinor: number;
  readonly uom: string;
  readonly batchId: string | null;
  readonly expiry: string | null;
  readonly receivedBy: string;
  readonly receivedAt: string;
  /** What the receiver found: the line's condition as the receipt kept it. */
  readonly condition: string;
}

/** The states that mean "still in quarantine" — a released or passed batch is history, kept on the quality register. */
export const QUARANTINED_HOLD_STATUSES = Object.freeze(['held', 'failed', 'sampling', 'pending'] as const);

export const isQuarantinedHold = (h: QualityHold): boolean => (QUARANTINED_HOLD_STATUSES as readonly string[]).includes(h.status);

/** The receipt lines whose quarantined quantity has no disposition yet. */
export function quarantinedLinesOf(receipts: readonly GrnRecord[]): readonly QuarantinedReceiptLine[] {
  const out: QuarantinedReceiptLine[] = [];
  for (const r of receipts) {
    const disposed = new Set((r.dispositions ?? []).map((d) => d.lineId));
    for (const l of r.captured.lines) {
      if (l.quarantinedMinor <= 0 || disposed.has(l.lineId)) continue;
      out.push({
        grnId: r.grnId, number: r.number, lineId: l.lineId, productId: l.productId, warehouseId: r.warehouseId,
        quantityMinor: l.quarantinedMinor, uom: l.uom, batchId: l.batchId, expiry: l.expiry,
        receivedBy: r.receivedBy, receivedAt: r.receivedAt, condition: String(l.disposition),
      });
    }
  }
  // Oldest first: what has waited longest for a decision is the first thing a person sees.
  return out.sort((a, b) => (a.receivedAt < b.receivedAt ? -1 : a.receivedAt > b.receivedAt ? 1 : 0));
}

export function quarantineRoutes(deps: QuarantineDeps): readonly Route[] {
  return [
    {
      api: 'API-04', method: 'GET', path: '/v1/inventory/quarantine',
      permission: 'quality.hold.manage',
      handler: async (ctx) => {
        const scope = await stockReadScope(ctx, deps.locationBranches);
        const holds = [...(await deps.holds(ctx.tenantId))];
        const held = holds.filter(isQuarantinedHold)
          // Failed first (nothing more urgent), then the oldest hold first.
          .sort((a, b) => (a.status === 'failed' ? 0 : 1) - (b.status === 'failed' ? 0 : 1) || (a.heldAt < b.heldAt ? -1 : a.heldAt > b.heldAt ? 1 : 0));
        const released = holds.filter((h) => !isQuarantinedHold(h))
          .sort((a, b) => ((b.releasedAt ?? '') < (a.releasedAt ?? '') ? -1 : 1));
        // PA-01-r1: receipt lines at the reader's own places only (a hold is a batch's, placed by quality; it carries no place).
        const lines = quarantinedLinesOf((await deps.receipts(ctx.tenantId)).filter((r) => scope.covers(r.warehouseId)));
        return {
          status: 200,
          body: {
            holds: held, released, lines,
            counts: { batchesHeld: held.length, batchesFailed: held.filter((h) => h.status === 'failed').length, receiptLines: lines.length, released: released.length },
            asAt: deps.now(),
          },
        };
      },
    },
  ];
}
