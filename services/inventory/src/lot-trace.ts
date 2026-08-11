// API-04 One-up/one-down lot traceability export (B11 / M10-FR-03) — the document a recall runs on, built
// on the tested `packages/quality` engine. For any batch it assembles the two lists food-safety law
// requires: who it came FROM (one step back — supplier + goods-receipt note) and who it went TO (one step
// forward — the sales, and the customers where they were identified), and RECONCILES them so a batch that
// somehow dispatched more than it received surfaces as a traceability gap rather than reading as clean.
//
// The OUTBOUND (who bought it) is now folded from the REAL banked sales: `bankSale` stores each sale — with
// its batch-tagged lines (batch-on-sale inc1) — as a `SaleCommitted` event, so `soldOfBatch` reads them back
// and returns every sale whose line carried this batch. The caller may still pass an explicit `outbound[]`
// for a what-if, but by default the trace pulls live sales. Inbound (supplier/GRN receipts) is still caller-
// supplied — folding receipts by batch is the next step. A read; it writes nothing. Gated on a traceability
// read (`quality.lottrace.read`: owner / store-manager), not the cashier's till.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import { buildLotTrace, InvalidLotTrace, type InboundLotRecord, type OutboundLotRecord } from '../../../packages/quality/src/index';

export interface LotTraceDeps {
  /** The real outbound records for a batch, folded from the banked sales whose lines carry it. */
  readonly soldOfBatch: (tenantId: string, batchId: string) => Promise<readonly OutboundLotRecord[]> | readonly OutboundLotRecord[];
}

/** Summary counts over a set of outbound (sold) records — the "who bought this batch" view. */
function summariseSold(batchId: string, outbound: readonly OutboundLotRecord[]) {
  const identifiedRecipientCount = outbound.filter((r) => typeof r.customerId === 'string' && r.customerId.trim() !== '').length;
  // Captured = the till recorded the batch; estimated = head office's FIFO best-estimate (ADR-0006).
  const capturedCount = outbound.filter((r) => r.source !== 'fifo_receipt_estimate').length;
  return {
    batchId,
    outbound,
    totalDispatchedMinor: outbound.reduce((s, r) => s + r.quantityMinor, 0),
    saleCount: outbound.length,
    capturedCount,
    estimatedCount: outbound.length - capturedCount,
    identifiedRecipientCount,
    anonymousSaleCount: outbound.length - identifiedRecipientCount,
  };
}

export function lotTraceRoutes(deps: LotTraceDeps): readonly Route[] {
  return [
    {
      api: 'API-04', method: 'POST', path: '/v1/quality/lot-trace/export',
      permission: 'quality.lottrace.read', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (typeof b['batchId'] !== 'string' || typeof b['productId'] !== 'string') {
          throw apiError(400, {
            code: 'lot_trace_needs_batch',
            whatHappened: 'A lot trace needs batchId and productId. The outbound (sales) list is folded from the banked sales by default; pass inbound[] (supplier/GRN) and optionally an override outbound[].',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the batch and its product; add the inbound receipts to complete the reconciliation.',
          });
        }
        if ((b['inbound'] !== undefined && !Array.isArray(b['inbound'])) || (b['outbound'] !== undefined && !Array.isArray(b['outbound']))) {
          throw apiError(400, { code: 'lot_trace_lists_must_be_arrays', whatHappened: 'inbound and outbound, if given, must each be an array.', wasItSaved: 'not_saved', nextSafeAction: 'Send inbound[] and outbound[] as arrays, or omit them.' });
        }
        // Outbound: a caller-supplied list wins (what-if); otherwise fold the real banked sales for the batch.
        const outbound = Array.isArray(b['outbound'])
          ? (b['outbound'] as OutboundLotRecord[])
          : await deps.soldOfBatch(ctx.tenantId, b['batchId']);
        try {
          const trace = buildLotTrace({
            batchId: b['batchId'],
            productId: b['productId'],
            inbound: (Array.isArray(b['inbound']) ? b['inbound'] : []) as InboundLotRecord[],
            outbound,
          });
          // 200, not 201 — nothing was created; this is the reconciled export of what already happened.
          return { status: 200, body: trace };
        } catch (err) {
          if (err instanceof InvalidLotTrace) throw apiError(400, { code: 'lot_trace_invalid', whatHappened: err.message, wasItSaved: 'not_saved', nextSafeAction: 'Correct the offending inbound/outbound record and try again.' });
          throw err;
        }
      },
    },
    {
      // The concrete recall query: who did we sell this batch to? Folded from the real banked sales — every
      // sale whose line carried this batch, with its date and quantity (and customer where the sale captured
      // one). An anonymous walk-in is kept and counted, never dropped (M10-FR-03).
      api: 'API-04', method: 'GET', path: '/v1/quality/lot-trace/:batchId/sold',
      permission: 'quality.lottrace.read',
      handler: async (ctx) => {
        const batchId = ctx.params['batchId'] ?? '';
        if (batchId.trim() === '') {
          throw apiError(400, { code: 'lot_trace_sold_needs_batch', whatHappened: 'This needs a batchId in the path.', wasItSaved: 'not_saved', nextSafeAction: 'Call /v1/quality/lot-trace/<batchId>/sold.' });
        }
        const outbound = await deps.soldOfBatch(ctx.tenantId, batchId);
        return { status: 200, body: summariseSold(batchId, outbound) };
      },
    },
  ];
}
