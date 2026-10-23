// API-04 The trace run backwards (M10-FR-03: "traceability works backwards and forwards"; acceptance "the trace works
// from supplier→customer and customer→supplier"; Stage 16 test "recall backwards-trace").
//
//   • GET /v1/quality/lot-trace/backward/sales/:saleId          — this bill: each line's batch, and where each came from
//   • GET /v1/quality/lot-trace/backward/customers/:customerRef — every bill that names this customer, the same way
//
// Every other trace route starts from a batch id. These start from what the service desk has in hand — a bill, or a
// customer who says "I bought it here" — and walk back: line → batch (the till's record, or head office's FIFO estimate,
// labelled) → goods-receipt note → supplier, and for a batch the shop made itself, → the ingredient batches its run used
// → their suppliers. The engine is `packages/quality/src/lot-trace-backward.ts`; this file validates, gathers the stored
// facts the walk asks for, and replies.
//
// A read, gated `quality.lottrace.read` (owner / store manager). Customer data is minimised: the customer route echoes
// only the reference it was given and the bills' ids and dates. Each read is sealed on the audit trail (who traced what,
// when) by the composition root, like every lot-trace read (M10-FR-03 "trace queries logged").
//
// Freshness (§31: "trace uses last-synced data with freshness shown"): the reply says up to when head office has the
// shop's bills — a bill a store computer has not sent yet is not in any trace, and the reply says so rather than reading
// as complete.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import {
  buildBackwardTrace, batchesStillToFetch, MAX_INGREDIENT_DEPTH,
  type BackwardSale, type BatchOrigin,
} from '../../../packages/quality/src/lot-trace-backward';

export interface LotTraceBackwardDeps {
  /** One banked sale, with each line's batch(es), or undefined when head office holds no such sale. */
  readonly sale: (tenantId: string, saleId: string) => Promise<BackwardSale | undefined>;
  /** Every banked sale that names this customer, each with its lines' batches. */
  readonly salesOfCustomer: (tenantId: string, customerRef: string) => Promise<readonly BackwardSale[]>;
  /** Where each of these batches came from (receipts, production runs). A batch with nothing on record is left out. */
  readonly origins: (tenantId: string, batchIds: readonly string[]) => Promise<ReadonlyMap<string, BatchOrigin>>;
  /** The latest moment head office holds a banked sale for, or null when it holds none. */
  readonly salesBankedUpTo: (tenantId: string) => Promise<string | null>;
  readonly now: () => string;
}

const SALE = /^[A-Za-z0-9._:/-]{1,80}$/;
const CUSTOMER = /^[A-Za-z0-9._:@+-]{1,80}$/;

/** Fetch the origins the walk asks for, a step back at a time, until it asks for nothing new. */
async function originsFor(deps: LotTraceBackwardDeps, tenantId: string, sales: readonly BackwardSale[]): Promise<ReadonlyMap<string, BatchOrigin>> {
  const origins = new Map<string, BatchOrigin>();
  const asked = new Set<string>();
  for (let round = 0; round <= MAX_INGREDIENT_DEPTH + 1; round += 1) {
    const wanted = batchesStillToFetch(sales, origins).filter((b) => !asked.has(b));
    if (wanted.length === 0) break;
    for (const b of wanted) asked.add(b);
    for (const [batchId, origin] of await deps.origins(tenantId, wanted)) origins.set(batchId, origin);
  }
  return origins;
}

async function replyFor(deps: LotTraceBackwardDeps, tenantId: string, start: { readonly saleId: string } | { readonly customerRef: string }, sales: readonly BackwardSale[]) {
  const trace = buildBackwardTrace({ sales, origins: await originsFor(deps, tenantId, sales) });
  const upTo = await deps.salesBankedUpTo(tenantId);
  return {
    start,
    ...trace,
    asOf: deps.now(),
    freshness: {
      salesBankedUpTo: upTo,
      detail: upTo === null
        ? 'Head office holds no bills yet, so nothing can be traced from one.'
        : `Built from the bills head office holds, the latest from ${upTo}. A bill a store computer has not sent yet is not in this trace.`,
    },
  };
}

export function lotTraceBackwardRoutes(deps: LotTraceBackwardDeps): readonly Route[] {
  return [
    {
      api: 'API-04', method: 'GET', path: '/v1/quality/lot-trace/backward/sales/:saleId',
      permission: 'quality.lottrace.read',
      handler: async (ctx) => {
        const saleId = (ctx.params['saleId'] ?? '').trim();
        if (!SALE.test(saleId)) {
          throw apiError(400, {
            code: 'backward_trace_needs_a_sale', whatHappened: 'Name the bill by its sale id (up to 80 letters, digits, dots, dashes, colons or slashes).',
            wasItSaved: 'not_saved', nextSafeAction: 'Call /v1/quality/lot-trace/backward/sales/<saleId>.',
          });
        }
        const sale = await deps.sale(ctx.tenantId, saleId);
        if (sale === undefined) throw notFound(`banked sale ${saleId} (a bill a store computer has not sent yet is not at head office)`);
        return { status: 200, body: await replyFor(deps, ctx.tenantId, { saleId }, [sale]) };
      },
    },
    {
      api: 'API-04', method: 'GET', path: '/v1/quality/lot-trace/backward/customers/:customerRef',
      permission: 'quality.lottrace.read',
      handler: async (ctx) => {
        const customerRef = (ctx.params['customerRef'] ?? '').trim();
        if (!CUSTOMER.test(customerRef)) {
          throw apiError(400, {
            code: 'backward_trace_needs_a_customer', whatHappened: 'Name the customer by their customer reference (up to 80 letters, digits and . _ : @ + -).',
            wasItSaved: 'not_saved', nextSafeAction: 'Call /v1/quality/lot-trace/backward/customers/<customerRef>.',
          });
        }
        const sales = [...(await deps.salesOfCustomer(ctx.tenantId, customerRef))]
          .sort((a, b) => (a.soldDate < b.soldDate ? -1 : a.soldDate > b.soldDate ? 1 : a.saleId < b.saleId ? -1 : 1));
        const reply = await replyFor(deps, ctx.tenantId, { customerRef }, sales);
        return {
          status: 200,
          body: {
            ...reply,
            detail: sales.length === 0
              ? 'No bill head office holds names this customer — a walk-in sale names nobody, and a bill not yet sent is not here.'
              : `${sales.length} bill(s) name this customer; ${reply.suppliers.length} supplier(s) stand behind what they bought.`,
          },
        };
      },
    },
  ];
}
