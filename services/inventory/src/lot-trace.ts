// API-04 One-up/one-down lot traceability export (B11 / M10-FR-03) — the document a recall runs on, built
// on the tested `packages/quality` engine. For any batch it assembles the two lists food-safety law
// requires: who it came FROM (one step back — supplier + goods-receipt note) and who it went TO (one step
// forward — the sales, and the customers where they were identified), and RECONCILES them so a batch that
// somehow dispatched more than it received surfaces as a traceability gap rather than reading as clean.
//
// A read masquerading as POST (the inbound/outbound records are arrays) — idempotent, writes nothing. The
// caller holds the records (from the receipts ledger and, once batch-on-sale is captured at the till, the
// sales ledger); this endpoint is the authoritative assembler + reconciler, not a second store of them.
// Gated on a traceability read (`quality.lottrace.read`: owner / store-manager), not the cashier's till.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import { buildLotTrace, InvalidLotTrace, type InboundLotRecord, type OutboundLotRecord } from '../../../packages/quality/src/index';

export function lotTraceRoutes(): readonly Route[] {
  return [
    {
      api: 'API-04', method: 'POST', path: '/v1/quality/lot-trace/export',
      permission: 'quality.lottrace.read', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (typeof b['batchId'] !== 'string' || typeof b['productId'] !== 'string') {
          throw apiError(400, {
            code: 'lot_trace_needs_batch',
            whatHappened: 'A lot trace needs batchId and productId, with the batch’s inbound[] (supplier/GRN) and outbound[] (sales) records.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the batch, its product and its inbound/outbound records (either list may be empty).',
          });
        }
        if ((b['inbound'] !== undefined && !Array.isArray(b['inbound'])) || (b['outbound'] !== undefined && !Array.isArray(b['outbound']))) {
          throw apiError(400, { code: 'lot_trace_lists_must_be_arrays', whatHappened: 'inbound and outbound, if given, must each be an array.', wasItSaved: 'not_saved', nextSafeAction: 'Send inbound[] and outbound[] as arrays, or omit them (treated as empty).' });
        }
        try {
          const trace = buildLotTrace({
            batchId: b['batchId'],
            productId: b['productId'],
            inbound: (Array.isArray(b['inbound']) ? b['inbound'] : []) as InboundLotRecord[],
            outbound: (Array.isArray(b['outbound']) ? b['outbound'] : []) as OutboundLotRecord[],
          });
          // 200, not 201 — nothing was created; this is the reconciled export of what already happened.
          return { status: 200, body: trace };
        } catch (err) {
          if (err instanceof InvalidLotTrace) throw apiError(400, { code: 'lot_trace_invalid', whatHappened: err.message, wasItSaved: 'not_saved', nextSafeAction: 'Correct the offending inbound/outbound record and try again.' });
          throw err;
        }
      },
    },
  ];
}
