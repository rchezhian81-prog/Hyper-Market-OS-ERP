// FUL-05 — ONE fulfilment command (M18-FR-01 · M18-FR-02 · M19-FR-02/03/04 · M20-FR-03 · P-02 · P-08 · hard rules #2 #10).
//
// Before this, an online order's progress lived in four separate records that never met: the order's own lifecycle, the
// pack register, the dispatch manifest and the door outcomes. An order could be packed, driven out and handed over while
// head office still said "confirmed", its stock stayed reserved forever, and no sale ever reached the stock ledger or the
// day book. This command joins them, from the AUTHORITATIVE facts only — never from a body:
//
//   • the ORDER advances along its own lifecycle as far as the recorded facts carry it: the recorded pack → packed, the
//     recorded manifest → dispatched, the door's delivered / partly delivered → delivered, returned to origin → returned
//     (an order no one has confirmed is not confirmed here: confirming checks the payment, §31);
//   • at the hand-over (delivered, partly delivered with the goods that came back counted, or collected at the store) the
//     goods the customer KEPT become ONE banked sale through the till's own sale pipeline — so the stock leaves through the
//     same ledger as every other sale and the day book reads it like any other — paid by the order's prepayment, or by the
//     cash / UPI the door took, and any cash-on-delivery remainder is a named tender that stays visible; the order's stock
//     holds are released in the same pass; what was paid and not delivered is recorded as a REFUND DUE for a person to issue
//     through the order's refund route (an approved act, never automatic);
//   • everything is applied ONCE: the sale is keyed on the order, the settlement is one fact per order, and a re-run (a crash
//     in the middle, a resend from the box) finishes what is missing and changes nothing that is done.
//
// Every place it stops short is SAID in the answer (`waiting`), never guessed past.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import type { OrderStateView, OrderTransition, Reservation } from '../../orders/src/index';
import type { OrderEvent, OrderState } from '../../../packages/orders/src/lifecycle';
import { canTransition, transitionOrder } from '../../../packages/orders/src/lifecycle';
import { paymentPosition, type OrderPayment, type OrderPaymentResolution, type OrderRefund } from '../../../packages/orders/src/payment-refunds';
import type { PackResult, Manifest } from '../../../packages/fulfilment/src/index';
import type { IncomingSale, IncomingTender } from '../../pos/src/sale-intake';
import type { DeliveryAttempt, DeliveryStateRecord } from './index';

/** The goods that came back to the store from a door, counted, per packed line (needed for a partial delivery). */
export interface OrderHandback {
  readonly orderId: string;
  readonly lines: readonly { readonly lineId: string; readonly quantityMinor: number }[];
  readonly countedBy: string;
  readonly at: string;
}

export type SettlementOutcome = 'delivered' | 'partially_delivered' | 'returned' | 'collected';

/** What one order's fulfilment posted — one fact per order. */
export interface FulfilmentSettlement {
  readonly orderId: string;
  readonly outcome: SettlementOutcome;
  /** The banked sale for what the customer kept — absent when they kept nothing. */
  readonly saleId?: string;
  readonly keptMinor: number;
  readonly lines: readonly { readonly lineId: string; readonly productId: string; readonly packedMinor: number; readonly keptMinor: number; readonly valueMinor: number }[];
  readonly tenders: readonly IncomingTender[];
  readonly paidMinor: number;
  /** Paid (prepaid) and not delivered — due back to the customer through the order's refund route. */
  readonly refundDueMinor: number;
  /** Cash-on-delivery the door did not take for goods the customer kept — owed by the customer. */
  readonly codDueMinor: number;
  /** Cash taken at the door beyond what the kept goods are worth — for the cash office. */
  readonly codOverMinor: number;
  readonly releasedReservations: number;
  readonly by: string;
  readonly at: string;
}

export interface OrderFulfilmentDeps {
  readonly now: () => string;
  readonly orderState: (tenantId: string, orderId: string) => Promise<OrderStateView | undefined> | OrderStateView | undefined;
  readonly recordTransition: (tenantId: string, t: OrderTransition) => Promise<void> | void;
  readonly orderReservations: (tenantId: string, orderId: string, locationId: string) => Promise<readonly Reservation[]> | readonly Reservation[];
  readonly releaseReservations: (tenantId: string, rs: readonly Reservation[]) => Promise<void> | void;
  readonly pack: (tenantId: string, orderId: string) => Promise<PackResult | undefined> | PackResult | undefined;
  readonly manifest: (tenantId: string, orderId: string) => Promise<Manifest | undefined> | Manifest | undefined;
  readonly deliveryState: (tenantId: string, orderId: string) => Promise<readonly DeliveryStateRecord[]> | readonly DeliveryStateRecord[];
  readonly doorAttempts: (tenantId: string, orderId: string) => Promise<readonly DeliveryAttempt[]> | readonly DeliveryAttempt[];
  readonly handback: (tenantId: string, orderId: string) => Promise<OrderHandback | undefined> | OrderHandback | undefined;
  readonly recordHandback: (tenantId: string, h: OrderHandback) => Promise<void> | void;
  readonly orderPayment: (tenantId: string, orderId: string) => Promise<OrderPayment | undefined> | OrderPayment | undefined;
  readonly paymentResolution: (tenantId: string, orderId: string) => Promise<OrderPaymentResolution | undefined> | OrderPaymentResolution | undefined;
  /** Refunds already sent on the order (a short pick, a substitution) — not due a second time. */
  readonly orderRefunds?: (tenantId: string, orderId: string) => Promise<readonly OrderRefund[]> | readonly OrderRefund[];
  readonly isBanked: (tenantId: string, saleId: string) => Promise<boolean> | boolean;
  /** The till's own sale pipeline: the sale and its `sold` stock movements in one atomic, idempotent batch. */
  readonly bankSale: (tenantId: string, sale: IncomingSale) => Promise<void> | void;
  readonly uomOf?: (tenantId: string, productId: string) => Promise<string | undefined> | string | undefined;
  readonly settlement: (tenantId: string, orderId: string) => Promise<FulfilmentSettlement | undefined> | FulfilmentSettlement | undefined;
  readonly recordSettlement: (tenantId: string, s: FulfilmentSettlement) => Promise<void> | void;
}

export type FulfilmentWait =
  | 'not_packed' | 'not_confirmed' | 'order_cancelled' | 'awaiting_handback' | 'no_door_outcome' | 'unpaid_pickup';

export interface FulfilmentApplied {
  readonly orderId: string;
  readonly state: OrderState;
  readonly steps: readonly { readonly event: OrderEvent; readonly from: OrderState; readonly to: OrderState }[];
  readonly settlement?: FulfilmentSettlement;
  readonly alreadySettled: boolean;
  readonly waiting?: FulfilmentWait;
  readonly detail: string;
}

const FORWARD: readonly { readonly event: OrderEvent; readonly to: OrderState }[] = [
  { event: 'pick', to: 'picking' }, { event: 'pack', to: 'packed' }, { event: 'dispatch', to: 'dispatched' },
];
const RANK: Readonly<Record<string, number>> = { confirmed: 0, picking: 1, packed: 2, dispatched: 3 };

/** Where the recorded facts say the order has got to — the furthest point they prove, and how it ended at the door. */
function factsTarget(pack: PackResult | undefined, manifest: Manifest | undefined, door: DeliveryStateRecord | undefined):
  { readonly reach: 'none' | 'packed' | 'dispatched'; readonly end?: 'delivered' | 'partially_delivered' | 'returned' } {
  const end = door?.to === 'delivered' ? 'delivered' as const
    : door?.to === 'partially_delivered' ? 'partially_delivered' as const
      : door?.to === 'returned_to_origin' ? 'returned' as const : undefined;
  if (manifest !== undefined || end !== undefined) return { reach: 'dispatched', ...(end === undefined ? {} : { end }) };
  if (pack !== undefined && pack.lines.length > 0) return { reach: 'packed' };
  return { reach: 'none' };
}

/**
 * Advance one order from its recorded pack and door outcomes, and post its stock and money once. Idempotent: run it again
 * and it does only what is still missing.
 */
export async function applyOrderFulfilment(deps: OrderFulfilmentDeps, tenantId: string, orderId: string, by: string): Promise<FulfilmentApplied | undefined> {
  const order = await deps.orderState(tenantId, orderId);
  if (order === undefined) return undefined;
  const done = await deps.settlement(tenantId, orderId);
  if (done !== undefined) {
    return { orderId, state: order.state, steps: [], settlement: done, alreadySettled: true, detail: `Order ${orderId} was settled ${done.outcome}; nothing more to post.` };
  }
  const [pack, manifest, history] = await Promise.all([deps.pack(tenantId, orderId), deps.manifest(tenantId, orderId), deps.deliveryState(tenantId, orderId)]);
  const door = history.length === 0 ? undefined : history[history.length - 1];
  const target = factsTarget(pack, manifest, door);

  const steps: { event: OrderEvent; from: OrderState; to: OrderState }[] = [];
  let state = order.state;
  const step = async (event: OrderEvent): Promise<void> => {
    const to = transitionOrder(state, event);
    await deps.recordTransition(tenantId, { orderId, event, from: state, to, at: deps.now() });
    steps.push({ event, from: state, to });
    state = to;
  };
  const answer = (waiting: FulfilmentWait | undefined, detail: string, settlement?: FulfilmentSettlement): FulfilmentApplied => ({
    orderId, state, steps, alreadySettled: false, detail, ...(waiting === undefined ? {} : { waiting }), ...(settlement === undefined ? {} : { settlement }),
  });

  if (state === 'cancelled') {
    return answer('order_cancelled', target.reach === 'none'
      ? `Order ${orderId} is cancelled; nothing to post.`
      : `Order ${orderId} is cancelled, yet a ${target.reach === 'packed' ? 'pack' : 'dispatch'} is recorded for it — a person must look: nothing was posted.`);
  }
  if (state === 'placed' && target.reach !== 'none') {
    return answer('not_confirmed', `Order ${orderId} was never confirmed (confirming checks its payment, §31), so its pack and door outcomes are not posted. Confirm it, then run this again.`);
  }

  // The lifecycle, as far as the facts carry it — through the same machine the order's own route runs.
  const reachRank = target.reach === 'dispatched' ? 3 : target.reach === 'packed' ? 2 : -1;
  for (const f of FORWARD) {
    const here = RANK[state];
    if (here === undefined || here >= RANK[f.to]! || RANK[f.to]! > reachRank) continue;
    if (canTransition(state, f.event)) await step(f.event);
  }

  // The hand-over: a door outcome on a dispatched order, or the store's own collect.
  const collected = state === 'collected';
  if (!collected && target.end === undefined) {
    return answer(target.reach === 'none' ? 'not_packed' : 'no_door_outcome',
      target.reach === 'none' ? `Order ${orderId} has no pack recorded yet.` : `Order ${orderId} is ${state}; nothing has been handed over yet.`);
  }
  if (pack === undefined) return answer('not_packed', `Order ${orderId} has no pack recorded, so there is nothing to sell from.`);

  const outcome: SettlementOutcome = collected ? 'collected' : target.end!;
  // What the customer kept, per packed line: all of it, none of it (returned), or — on a partial — what was packed less what
  // came back to the store, COUNTED. Without the count a partial cannot be posted: the shop does not guess what was kept.
  const handback = outcome === 'partially_delivered' ? await deps.handback(tenantId, orderId) : undefined;
  if (outcome === 'partially_delivered' && handback === undefined) {
    return answer('awaiting_handback', `Order ${orderId} was partly delivered. Count what came back to the store (POST /v1/fulfilment/orders/${orderId}/handback) and its sale is then posted.`);
  }
  const back = new Map((handback?.lines ?? []).map((l) => [l.lineId, l.quantityMinor] as const));
  const lines = pack.lines.map((l) => {
    const keptMinor = outcome === 'returned' ? 0 : Math.max(0, l.packedMinor - (back.get(l.lineId) ?? 0));
    const valueMinor = l.packedMinor <= 0 ? 0 : keptMinor === l.packedMinor ? l.finalPriceMinor : Math.round((l.finalPriceMinor * keptMinor) / l.packedMinor);
    return { lineId: l.lineId, productId: l.productId, packedMinor: l.packedMinor, keptMinor, valueMinor };
  });
  const keptTotal = lines.reduce((n, l) => n + l.valueMinor, 0);

  // How it was paid: the bank's word on the order's prepayment, or the door's cash / UPI.
  const pay = paymentPosition(await deps.orderPayment(tenantId, orderId), await deps.paymentResolution(tenantId, orderId));
  const prepaid = pay.state === 'authorised';
  if (!prepaid && collected) {
    return answer('unpaid_pickup', `Order ${orderId} was collected with no online payment — it is paid at the till, and the till's own sale carries its stock and money. Nothing posted here.`);
  }
  const paidMinor = prepaid ? pay.paidMinor : 0;
  const attempts = await deps.doorAttempts(tenantId, orderId);
  const handOver = [...attempts].reverse().find((a) => a.outcome === 'delivered' || a.outcome === 'partially_delivered');
  const doorCash = prepaid || handOver === undefined ? 0 : (handOver.cashCollectedMinor ?? 0);
  const refundedMinor = prepaid && deps.orderRefunds !== undefined
    ? (await deps.orderRefunds(tenantId, orderId)).filter((r) => r.state !== 'refused').reduce((n, r) => n + r.amountMinor, 0) : 0;
  const availableMinor = Math.max(0, paidMinor - refundedMinor);
  const tenders: IncomingTender[] = [];
  let codDueMinor = 0;
  let codOverMinor = 0;
  if (keptTotal > 0) {
    if (prepaid) {
      if (availableMinor > 0) tenders.push({ kind: 'online_prepaid', amountMinor: Math.min(keptTotal, availableMinor), ...(pay.providerRef === undefined ? {} : { ref: pay.providerRef }) });
      if (availableMinor < keptTotal) { codDueMinor = keptTotal - availableMinor; tenders.push({ kind: 'cod_due', amountMinor: codDueMinor }); }
    } else {
      const taken = Math.min(doorCash, keptTotal);
      if (taken > 0) tenders.push({ kind: handOver?.codMethod ?? 'cash', amountMinor: taken });
      codDueMinor = keptTotal - taken;
      if (codDueMinor > 0) tenders.push({ kind: 'cod_due', amountMinor: codDueMinor });
    }
  }
  codOverMinor = prepaid ? 0 : Math.max(0, doorCash - keptTotal);
  const refundDueMinor = prepaid ? Math.max(0, availableMinor - keptTotal) : 0;
  const at = door?.at ?? deps.now();

  // ONE sale for what was kept — the till's own pipeline, so the stock leaves through the one ledger and the day book reads it.
  const saleId = `order-${orderId}`;
  if (keptTotal > 0 || lines.some((l) => l.keptMinor > 0)) {
    if (!(await deps.isBanked(tenantId, saleId))) {
      const saleLines = await Promise.all(lines.filter((l) => l.keptMinor > 0).map(async (l) => ({
        productId: l.productId, quantityMinor: l.keptMinor, uom: (await deps.uomOf?.(tenantId, l.productId)) ?? 'each',
        unitPriceMinor: Math.round(l.valueMinor / l.keptMinor), lineTotalMinor: l.valueMinor,
      })));
      await deps.bankSale(tenantId, {
        saleId, receiptNumber: `ORD-${orderId}`, laneId: 'online-orders', locationId: order.locationId, cashierId: by,
        tradingDay: at.slice(0, 10), committedAt: at, totalMinor: keptTotal, currency: 'INR', packVersion: 0,
        lines: saleLines, tenders,
      } as IncomingSale);
    }
  }
  // The order's holds are released: the kept goods left through the sale, the rest are back on the shelf.
  const held = await deps.orderReservations(tenantId, orderId, order.locationId);
  if (held.length > 0) await deps.releaseReservations(tenantId, held);
  if (!collected) await step(outcome === 'returned' ? 'return' : 'deliver');

  const settlement: FulfilmentSettlement = {
    orderId, outcome, ...(keptTotal > 0 || lines.some((l) => l.keptMinor > 0) ? { saleId } : {}),
    keptMinor: keptTotal, lines, tenders, paidMinor, refundDueMinor, codDueMinor, codOverMinor,
    releasedReservations: held.length, by, at: deps.now(),
  };
  await deps.recordSettlement(tenantId, settlement);
  const words = [
    `Order ${orderId} ${outcome === 'returned' ? 'came back undelivered' : outcome === 'collected' ? 'was collected' : outcome === 'partially_delivered' ? 'was partly delivered' : 'was delivered'}`,
    keptTotal > 0 ? `₹${(keptTotal / 100).toFixed(2)} of goods posted as sale ${saleId}` : 'no goods were kept, no sale posted',
    refundDueMinor > 0 ? `₹${(refundDueMinor / 100).toFixed(2)} paid and not delivered is due back to the customer — issue it from the order's refunds (it needs approval)` : '',
    codDueMinor > 0 ? `₹${(codDueMinor / 100).toFixed(2)} of cash on delivery is still owed by the customer` : '',
    codOverMinor > 0 ? `₹${(codOverMinor / 100).toFixed(2)} more cash was taken at the door than the goods kept are worth — for the cash office` : '',
  ].filter((x) => x !== '');
  return answer(undefined, `${words.join('; ')}.`, settlement);
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/** The routes: run the command (it also runs on its own after every pack, dispatch and door outcome), count a hand-back, read. */
export function orderFulfilmentRoutes(deps: OrderFulfilmentDeps): readonly Route[] {
  const unknown = (orderId: string) => apiError(404, {
    code: 'order_unknown', whatHappened: `No order "${orderId}" has been placed.`, wasItSaved: 'not_saved', nextSafeAction: 'Check the order reference. Nothing was changed.',
  });
  return [
    {
      // Advance the order from its recorded pack and door outcomes and post its stock and money once. No body: the facts are read.
      api: 'API-08', method: 'POST', path: '/v1/fulfilment/orders/:orderId/apply',
      permission: 'fulfilment.pack.record', idempotent: true,
      handler: async (ctx) => {
        const orderId = (ctx.params['orderId'] ?? '').trim();
        const out = await applyOrderFulfilment(deps, ctx.tenantId, orderId, ctx.userId);
        if (out === undefined) throw unknown(orderId);
        return { status: 200, body: out };
      },
    },
    {
      // The goods that came back to the store from a partial delivery, COUNTED per packed line. Once per order.
      api: 'API-08', method: 'POST', path: '/v1/fulfilment/orders/:orderId/handback',
      permission: 'fulfilment.pack.record', idempotent: true,
      handler: async (ctx) => {
        const orderId = (ctx.params['orderId'] ?? '').trim();
        if ((await deps.orderState(ctx.tenantId, orderId)) === undefined) throw unknown(orderId);
        const b = (ctx.body ?? {}) as { lines?: unknown };
        const pack = await deps.pack(ctx.tenantId, orderId);
        const lines = Array.isArray(b.lines) ? b.lines : undefined;
        const ok = lines !== undefined && pack !== undefined && lines.every((l) => {
          const o = (l ?? {}) as { lineId?: unknown; quantityMinor?: unknown };
          const packed = pack.lines.find((p) => p.lineId === o.lineId);
          return isStr(o.lineId) && packed !== undefined && Number.isInteger(o.quantityMinor) && (o.quantityMinor as number) >= 0 && (o.quantityMinor as number) <= packed.packedMinor;
        });
        if (!ok) {
          throw apiError(400, {
            code: 'not_readable_as_a_handback',
            whatHappened: 'A hand-back needs { lines: [{ lineId, quantityMinor }] } — each a line of the order\'s recorded pack, counted back as a whole number no more than was packed.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Count what came back against the pack and send it again. Nothing was posted.',
          });
        }
        const existing = await deps.handback(ctx.tenantId, orderId);
        if (existing !== undefined) {
          return { status: 200, body: { handback: existing, alreadyRecorded: true, applied: await applyOrderFulfilment(deps, ctx.tenantId, orderId, ctx.userId) } };
        }
        const handback: OrderHandback = {
          orderId, lines: (lines as { lineId: string; quantityMinor: number }[]).map((l) => ({ lineId: l.lineId, quantityMinor: l.quantityMinor })),
          countedBy: ctx.userId, at: deps.now(),
        };
        await deps.recordHandback(ctx.tenantId, handback);
        return { status: 201, body: { handback, applied: await applyOrderFulfilment(deps, ctx.tenantId, orderId, ctx.userId) } };
      },
    },
    {
      api: 'API-08', method: 'GET', path: '/v1/fulfilment/orders/:orderId/settlement',
      permission: 'fulfilment.pack.read',
      handler: async (ctx) => {
        const orderId = (ctx.params['orderId'] ?? '').trim();
        const s = await deps.settlement(ctx.tenantId, orderId);
        if (s === undefined) throw notFound(`fulfilment settlement for order ${orderId}`);
        return { status: 200, body: s };
      },
    },
  ];
}
