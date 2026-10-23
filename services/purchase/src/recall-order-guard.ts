// API-03 The recall stops ORDERING too (M10-FR-04: "recall-block stops POS sale and ordering"; D01-FR-05; the product
// master's own words for `recallBlocked`: "stops sale AND purchase everywhere").
//
// The recall block already stopped the till. Nothing stopped a buyer: a product with a batch under an open recall could
// be put on a purchase order, approved and sent to the supplier the same afternoon. This guard sits in front of the three
// purchase-order steps that commit the shop to buying more:
//
//   • PROPOSE  — POST /v1/purchase/orders/:poId              a new order naming a recalled product is refused;
//   • APPROVE  — POST /v1/purchase/orders/:poId/approval     an order proposed before the recall started is not issued;
//   • AMEND    — POST /v1/purchase/orders/:poId/amendments   an amendment that adds a recalled product, or raises its
//                                                           quantity, is refused (lowering it is allowed — that is the
//                                                           remedy, and cancelling stays open for the same reason).
//
// A product is under recall when any batch of it has an OPEN recall (the recall register, each batch named to its product
// through the stock ledger, as the till block names it — OB-25 / OB-139: a purchase order carries no batch, so it is the
// whole product), or when the product master itself is marked recall-blocked. The block lifts when every recall on the
// product is closed with evidence.
//
// Each refusal is 409 `product_under_recall`, names the products and the batches, saves nothing, and is sealed on the
// audit trail (who tried, when, which order, which products) — besides the kernel's own audit of every refusal. There is
// no override: a recall is the one reason the shop must not buy, and no role can approve past it.
//
// A replay of an order already proposed is not judged again (the idempotent reply stands); its APPROVAL is.

import type { Route, RequestContext, HandlerResult } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import type { StoredPurchaseOrder } from './purchase-orders';

/** Why one product may not be ordered. */
export interface ProductUnderRecall {
  readonly productId: string;
  /** The batches under open recall (empty when it is the product master's own recall flag). */
  readonly batchIds: readonly string[];
  readonly because: 'open_batch_recall' | 'product_recall_flag';
  readonly reason: string;
  readonly since: string | null;
}

export interface RecallOrderGuardDeps {
  /** Which of these products are under an open recall now. */
  readonly underRecall: (tenantId: string, productIds: readonly string[]) => Promise<readonly ProductUnderRecall[]>;
  /** The stored purchase order, for the approval and amendment steps. */
  readonly order: (tenantId: string, poId: string) => Promise<StoredPurchaseOrder | undefined> | StoredPurchaseOrder | undefined;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
  readonly now: () => string;
}

export type GuardedStep = 'propose' | 'approve' | 'amend';

/** The purchase-order routes this guard stands in front of, by step. */
export const RECALL_GUARDED_ORDER_ROUTES: Readonly<Record<GuardedStep, { readonly method: 'POST'; readonly path: string }>> = Object.freeze({
  propose: { method: 'POST', path: '/v1/purchase/orders/:poId' },
  approve: { method: 'POST', path: '/v1/purchase/orders/:poId/approval' },
  amend: { method: 'POST', path: '/v1/purchase/orders/:poId/amendments' },
});

const STEP_WORDS: Readonly<Record<GuardedStep, string>> = {
  propose: 'put on a purchase order', approve: 'issued to the supplier', amend: 'added to this order or raised on it',
};

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/** The product ids a request's `lines[]` names, with the quantity each line asks for (summed per product). */
function linesAsked(body: unknown): Map<string, number> {
  const out = new Map<string, number>();
  const lines = (body as { lines?: unknown } | null | undefined)?.lines;
  if (!Array.isArray(lines)) return out;
  for (const l of lines) {
    const productId = (l as { productId?: unknown })?.productId;
    if (!isStr(productId)) continue;
    const qty = (l as { orderedQty?: unknown }).orderedQty;
    out.set(productId, (out.get(productId) ?? 0) + (typeof qty === 'number' && Number.isFinite(qty) ? qty : 0));
  }
  return out;
}

/** The refusal: 409, nothing saved, every product and batch named, and the attempt sealed on the audit trail. */
async function refuse(deps: RecallOrderGuardDeps, ctx: RequestContext, step: GuardedStep, poId: string, found: readonly ProductUnderRecall[]): Promise<never> {
  const sorted = [...found].sort((a, b) => (a.productId < b.productId ? -1 : 1));
  const named = sorted.map((p) => (p.because === 'product_recall_flag'
    ? `${p.productId} (the product itself is marked recall-blocked)`
    : `${p.productId} (batch${p.batchIds.length === 1 ? '' : 'es'} ${p.batchIds.join(', ')} under recall)`)).join('; ');
  await deps.recordAudit?.(ctx.tenantId, {
    actorId: ctx.userId, action: 'purchase.order.refused_under_recall', objectType: 'purchase-order', objectId: poId,
    at: deps.now(), origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null },
    before: null,
    after: {
      step, products: sorted.map((p) => p.productId).join(','),
      batches: [...new Set(sorted.flatMap((p) => p.batchIds))].sort().join(','), outcome: 'refused',
    },
    reason: 'M10-FR-04: a recall block stops ordering',
    correlationId: ctx.traceId,
  });
  throw apiError(409, {
    code: 'product_under_recall',
    whatHappened: `${sorted.length === 1 ? 'This product is' : 'These products are'} under recall and cannot be ${STEP_WORDS[step]}: ${named}. A recall stops ordering as well as selling (M10-FR-04).`,
    wasItSaved: 'not_saved',
    nextSafeAction: step === 'amend'
      ? 'Take the recalled product off the amendment (lowering or cancelling its quantity is allowed). It can be ordered again when every recall on it is closed with evidence. Nothing was changed.'
      : 'Take the recalled product off the order. It can be ordered again when every recall on it is closed with evidence. Nothing was ordered.',
  });
}

/** Wrap one purchase-order route's handler with the recall check for its step. */
function guarded(route: Route, step: GuardedStep, deps: RecallOrderGuardDeps): Route {
  const inner = route.handler;
  const handler = async (ctx: RequestContext): Promise<HandlerResult> => {
    const poId = (ctx.params['poId'] ?? '').trim();
    if (poId === '') return inner(ctx); // the route's own refusal says what is missing
    const po = await deps.order(ctx.tenantId, poId);
    let judged: string[] = [];
    if (step === 'propose') {
      if (po !== undefined) return inner(ctx); // a replay of an order already proposed — its reply stands
      judged = [...linesAsked(ctx.body).keys()];
    } else if (step === 'approve') {
      if (po === undefined || po.status === 'issued') return inner(ctx); // 404 / already issued: the route answers
      judged = [...new Set(po.lines.map((l) => l.productId))];
    } else {
      if (po === undefined) return inner(ctx);
      const before = new Map<string, number>();
      for (const l of po.lines) before.set(l.productId, (before.get(l.productId) ?? 0) + l.orderedQty);
      // Only a product the amendment adds, or raises, is judged: lowering a recalled product's quantity is the remedy.
      judged = [...linesAsked(ctx.body).entries()].filter(([p, q]) => q > (before.get(p) ?? 0)).map(([p]) => p);
    }
    if (judged.length > 0) {
      const found = await deps.underRecall(ctx.tenantId, judged.sort());
      if (found.length > 0) await refuse(deps, ctx, step, poId, found);
    }
    return inner(ctx);
  };
  return { ...route, handler };
}

/**
 * The purchase-order routes with the recall guard in front of propose, approve and amend. Every other route is returned
 * as it was. Throws when a guarded route is not in the list — a guard that silently guards nothing is the failure this
 * exists to prevent (P-08).
 */
export function withRecallOrderGuard(routes: readonly Route[], deps: RecallOrderGuardDeps): Route[] {
  const out = [...routes];
  for (const step of Object.keys(RECALL_GUARDED_ORDER_ROUTES) as GuardedStep[]) {
    const want = RECALL_GUARDED_ORDER_ROUTES[step];
    const at = out.findIndex((r) => r.method === want.method && r.path === want.path);
    if (at < 0) throw new Error(`the recall ordering guard cannot find ${want.method} ${want.path} — ordering would not be stopped by a recall`);
    out[at] = guarded(out[at]!, step, deps);
  }
  return out;
}
