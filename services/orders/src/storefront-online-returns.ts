// An online return after delivery, end to end, on API-07 (R4 · WF-16 · OB-58 · OB-213 · C14 · §28 · hard rules #2, #5, #10).
//
//   THE CUSTOMER, in the app, on their OWN delivered (or collected) order, raises a return for lines on it — each line
//   judged against the window the owner set for its CATEGORY and the owner's non-returnable list (OB-213). Until those are
//   given they read "not set" and a return cannot be judged: it is refused by name, never waved through.
//   THE SHOP books a collection, records it collected, receives the goods back WITH A COUNT, and a PERSON chooses each
//   received line's disposition: back to sellable (a `returned` stock movement — never for a recalled product), quarantine
//   (held off the shelf, no stock), or waste with a reason (no stock).
//   THE REFUND is for RECEIVED lines only, at the price the line was charged, back to the ORDER's own payment token (refund to
//   source, C14) — through the same planning, second-person approval (ADR-0024, kind `order_refund`) and processor port the
//   order desk uses. A line refunded once is refused ("already refunded"). What the provider has not confirmed reads
//   "waiting" — never done — until its statement line is recorded (POST /v1/orders/:orderId/refunds/:refundId/outcome).
//   THE CUSTOMER sees every step in the app.
//
// Append-only throughout: each step is a new fact on the return's own stream; nothing is edited or deleted.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import { actionDetails, approvalNamedIn, type ApprovalPort } from '../../identity/src/approval-requests';
import {
  paymentPosition, refundPosition, planOrderRefund, refundMessage, foldRefunds,
  type OrderPayment, type OrderPaymentResolution, type OrderRefund, type OrderRefundOutcome, type RefundProcessor,
} from '../../../packages/orders/src/payment-refunds';
import { DEFAULT_REFUND_THRESHOLD_MINOR } from '../../../packages/returns/src/assess-return';
import {
  lineEligibility, foldOnlineReturn, checkReceivedCount, planReturnRefund, returnStageWords, DISPOSITIONS,
  type OnlineReturnStep, type OnlineReturnView, type ReturnDisposition, type ReturnPolicySettings,
} from '../../../packages/storefront/src/online-returns';
import { NOT_SET } from '../../../packages/storefront/src/listing-duties';
import type { ServiceCase } from '../../../packages/service-desk/src/index';
import type { PlacedOrder } from './index';

export interface OnlineReturnDeps {
  readonly placedOrder: (tenantId: string, orderId: string) => Promise<PlacedOrder | undefined>;
  /** When the order reached the customer (its transition to delivered or collected), or undefined if it has not. */
  readonly deliveredAt: (tenantId: string, orderId: string) => Promise<string | undefined>;
  readonly categoryOf: (tenantId: string, productId: string) => Promise<string | undefined>;
  readonly policies: (tenantId: string) => Promise<readonly ReturnPolicySettings[]>;
  readonly recordPolicy: (tenantId: string, p: ReturnPolicySettings) => Promise<void>;
  readonly steps: (tenantId: string, returnId: string) => Promise<readonly OnlineReturnStep[]>;
  /** Every return's steps, tenant-wide (the desk's worklist and the customer's own list). */
  readonly allSteps: (tenantId: string) => Promise<readonly OnlineReturnStep[]>;
  readonly recordStep: (tenantId: string, step: OnlineReturnStep, key: string) => Promise<void>;
  /** The price a line of this order was charged at, and where that figure comes from. */
  readonly priceOf: (tenantId: string, orderId: string, productId: string) => Promise<{ readonly unitPriceMinor: number; readonly basis: string } | undefined>;
  /** Back to sellable: a `returned` stock movement at the order's place, once per return line. */
  readonly restock: (tenantId: string, m: { readonly movementId: string; readonly productId: string; readonly locationId: string; readonly quantityMinor: number; readonly by: string; readonly at: string }) => Promise<void>;
  readonly recalled: (tenantId: string, productId: string) => Promise<boolean>;
  /** The service desk's case for the return (the desk works it as it works every app request). */
  readonly openCase?: (tenantId: string, c: ServiceCase) => Promise<void>;
  // ── the order's money: the SAME records and rules the order refund desk uses (C14, FUL-03) ──
  readonly orderPayment: (tenantId: string, orderId: string) => Promise<OrderPayment | undefined> | OrderPayment | undefined;
  readonly paymentResolution: (tenantId: string, orderId: string) => Promise<OrderPaymentResolution | undefined> | OrderPaymentResolution | undefined;
  readonly orderRefunds: (tenantId: string, orderId: string) => Promise<readonly OrderRefund[]> | readonly OrderRefund[];
  readonly refundOutcomes: (tenantId: string, orderId: string) => Promise<readonly OrderRefundOutcome[]> | readonly OrderRefundOutcome[];
  readonly recordRefund: (tenantId: string, r: OrderRefund) => Promise<void> | void;
  readonly refundThreshold: (tenantId: string) => Promise<number | undefined> | number | undefined;
  readonly approvals?: ApprovalPort;
  /** The payment provider. No live provider is connected (OA-4): the product's processor answers "unknown" → waiting. */
  readonly refundProcessor: RefundProcessor;
  readonly now: () => string;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The processor the product runs with: no provider is connected, so every refund is asked for and stays WAITING. */
export function noProviderRefundProcessor(): RefundProcessor {
  return { refund: async () => ({ result: 'unknown', detail: 'no payment provider is connected — the refund waits for a person to record the bank\'s answer' }) };
}

const readLines = <K extends string>(v: unknown, qty: K): { productId: string; n: number }[] | undefined => {
  if (!Array.isArray(v) || v.length === 0 || v.length > 200) return undefined;
  const out: { productId: string; n: number }[] = [];
  for (const x of v) {
    const r = x as Record<string, unknown>;
    if (r === null || typeof r !== 'object' || !isStr(r['productId']) || typeof r[qty] !== 'number' || !Number.isInteger(r[qty]) || (r[qty] as number) < 0) return undefined;
    out.push({ productId: (r['productId'] as string).trim(), n: r[qty] as number });
  }
  return out;
};

export function onlineReturnRoutes(deps: OnlineReturnDeps): readonly Route[] {
  const policy = async (t: string): Promise<ReturnPolicySettings | undefined> =>
    (await deps.policies(t)).reduce<ReturnPolicySettings | undefined>((b, p) => (b === undefined || p.version > b.version ? p : b), undefined);
  const refundStates = async (t: string, orderId: string): Promise<Record<string, 'issued' | 'pending' | 'refused'>> => {
    const out: Record<string, 'issued' | 'pending' | 'refused'> = {};
    for (const r of foldRefunds(await deps.orderRefunds(t, orderId), await deps.refundOutcomes(t, orderId))) out[r.refundId] = r.effectiveState;
    return out;
  };
  const view = async (t: string, returnId: string): Promise<OnlineReturnView> => {
    const steps = await deps.steps(t, returnId);
    const first = steps.find((s) => s.kind === 'requested');
    const v = first === undefined || first.kind !== 'requested' ? undefined : foldOnlineReturn(steps, await refundStates(t, first.orderId));
    if (v === undefined) throw notFound(`online return ${returnId}`);
    return v;
  };
  const allViews = async (t: string): Promise<OnlineReturnView[]> => {
    const byId = new Map<string, OnlineReturnStep[]>();
    for (const s of await deps.allSteps(t)) byId.set(s.returnId, [...(byId.get(s.returnId) ?? []), s]);
    const out: OnlineReturnView[] = [];
    for (const steps of byId.values()) {
      const req = steps.find((s) => s.kind === 'requested');
      if (req === undefined || req.kind !== 'requested') continue;
      const v = foldOnlineReturn(steps, await refundStates(t, req.orderId));
      if (v !== undefined) out.push(v);
    }
    return out.sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
  };
  const forCustomer = (v: OnlineReturnView) => ({ ...v, customerRef: undefined, stageSay: returnStageWords(v.stage) });
  const policyView = (p: ReturnPolicySettings | undefined) => ({
    version: p?.version ?? 0,
    windowDaysByCategory: p?.windowDaysByCategory ?? {},
    windows: p === undefined || Object.keys(p.windowDaysByCategory).length === 0 ? NOT_SET : undefined,
    nonReturnable: p?.nonReturnable ?? NOT_SET,
    ...(p === undefined ? {} : { setBy: p.setBy, setAt: p.setAt }),
    say: 'A category with no window reads "not set": a return in it cannot be judged until the owner gives the window (OB-213).',
  });
  const stage = async (t: string, returnId: string, kinds: readonly string[], what: string): Promise<OnlineReturnView> => {
    const v = await view(t, returnId);
    if (!kinds.includes(v.stage)) throw apiError(409, { code: 'not_at_this_step', whatHappened: `Return ${returnId} is ${v.stage.replace(/_/g, ' ')}; ${what}.`, wasItSaved: 'not_saved', nextSafeAction: 'Nothing was changed. Do the steps in order: book the collection, collect, receive and count, choose where each line goes, refund.' });
    return v;
  };

  return [
    // ── the owner's return policy (OB-213) ──
    {
      api: 'API-07', method: 'GET', path: '/v1/online-returns/policy',
      permission: 'online.return.manage',
      handler: async (ctx) => ({ status: 200, body: { policy: policyView(await policy(ctx.tenantId)) } }),
    },
    {
      // Set the windows by category and the non-returnable list — a NEW VERSION. Body: { windowDaysByCategory, nonReturnable?, reason }.
      api: 'API-07', method: 'POST', path: '/v1/online-returns/policy',
      permission: 'online.store.manage', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const w = b['windowDaysByCategory'];
        const okWindows = w !== null && typeof w === 'object' && !Array.isArray(w) && Object.entries(w as Record<string, unknown>).every(([k, d]) => ID.test(k) && typeof d === 'number' && Number.isInteger(d) && d >= 0 && d <= 365);
        const nr = b['nonReturnable'];
        const okList = nr === undefined || (Array.isArray(nr) && nr.length <= 5_000 && nr.every(isStr));
        if (!okWindows || !okList || !isStr(b['reason'])) {
          throw apiError(400, { code: 'not_readable_as_a_return_policy', whatHappened: 'A return policy needs { windowDaysByCategory: { categoryId: days 0–365 }, nonReturnable?: [productId], reason }.', wasItSaved: 'not_saved', nextSafeAction: 'Nothing was changed.' });
        }
        const before = await policy(ctx.tenantId);
        const p: ReturnPolicySettings = {
          version: (before?.version ?? 0) + 1, windowDaysByCategory: { ...(w as Record<string, number>) },
          ...(nr === undefined ? {} : { nonReturnable: [...new Set((nr as string[]).map((x) => x.trim()))].sort() }),
          setBy: ctx.userId, setAt: deps.now(),
        };
        await deps.recordPolicy(ctx.tenantId, p);
        return { status: 201, body: { policy: policyView(p) } };
      },
    },
    // ── the customer ──
    {
      api: 'API-07', method: 'GET', path: '/v1/me/return-policy',
      permission: 'storefront.order.read', entitlement: 'customer_app',
      handler: async (ctx) => ({ status: 200, body: { policy: policyView(await policy(ctx.tenantId)) } }),
    },
    {
      // Raise a return on my delivered order. Body: { lines: [{ productId, quantityMinor }], reason }.
      api: 'API-07', method: 'POST', path: '/v1/me/orders/:orderId/online-returns/:returnId',
      permission: 'storefront.order.place', entitlement: 'customer_app', idempotent: true,
      handler: async (ctx) => {
        const orderId = ctx.params['orderId'] ?? '';
        const returnId = (ctx.params['returnId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const lines = readLines(b['lines'], 'quantityMinor');
        if (!ID.test(returnId) || lines === undefined || lines.some((l) => l.n <= 0) || !isStr(b['reason']) || (b['reason'] as string).length > 500) {
          throw apiError(400, { code: 'not_readable_as_a_return', whatHappened: 'A return needs { lines: [{ productId, quantityMinor (above 0) }], reason (≤ 500 characters) }.', wasItSaved: 'not_saved', nextSafeAction: 'Choose what you want to return and say why.' });
        }
        const order = await deps.placedOrder(ctx.tenantId, orderId);
        if (order === undefined || order.customerRef !== ctx.userId) throw notFound(`order ${orderId}`);
        const held = await deps.steps(ctx.tenantId, returnId);
        if (held.length > 0) {
          const v = await view(ctx.tenantId, returnId);
          if (v.customerRef !== ctx.userId) throw apiError(409, { code: 'return_id_taken', whatHappened: 'That reference is already used.', wasItSaved: 'not_saved', nextSafeAction: 'Try again — the app picks a new reference.' });
          return { status: 200, body: { return: forCustomer(v), alreadyRaised: true } };
        }
        const deliveredAt = await deps.deliveredAt(ctx.tenantId, orderId);
        if (deliveredAt === undefined) throw apiError(409, { code: 'order_not_received_yet', whatHappened: `Order ${orderId} has not reached you yet — a return is asked for once you have the goods.`, wasItSaved: 'not_saved', nextSafeAction: 'To change an order you have not received, cancel it or raise a complaint.' });
        const ordered = new Map<string, number>();
        for (const l of order.lines) ordered.set(l.productId, (ordered.get(l.productId) ?? 0) + l.quantityMinor);
        const asked = new Map<string, number>();
        for (const v of await allViews(ctx.tenantId)) if (v.orderId === orderId) for (const l of v.lines) asked.set(l.productId, (asked.get(l.productId) ?? 0) + l.requestedMinor);
        const p = await policy(ctx.tenantId);
        const now = deps.now();
        for (const l of lines) {
          const room = (ordered.get(l.productId) ?? 0) - (asked.get(l.productId) ?? 0);
          if (l.n > room) throw apiError(422, { code: 'more_than_was_ordered', whatHappened: `${l.productId}: you asked to return ${l.n}, but ${room <= 0 ? 'none is left to return on this order' : `only ${room} is left to return`}.`, wasItSaved: 'not_saved', nextSafeAction: 'Ask for no more than you received.' });
          const e = lineEligibility({ productId: l.productId, categoryId: await deps.categoryOf(ctx.tenantId, l.productId), deliveredAt, now, policy: p });
          if (!e.ok) {
            throw apiError(422, {
              code: e.code, whatHappened: `${l.productId}: ${e.refusal}.`, wasItSaved: 'not_saved',
              nextSafeAction: e.code === 'return_window_closed' ? 'The time to return this has passed. Raise a complaint if something was wrong with it.'
                : e.code === 'not_returnable' ? 'This item cannot be returned. Raise a complaint if something was wrong with it.'
                  : 'The shop has not set its return terms for this yet. Raise a complaint and the shop will help.',
            });
          }
        }
        const step: OnlineReturnStep = { kind: 'requested', returnId, orderId, customerRef: ctx.userId, lines: lines.map((l) => ({ productId: l.productId, quantityMinor: l.n })), reason: (b['reason'] as string).trim(), at: now };
        await deps.recordStep(ctx.tenantId, step, `${returnId}-requested`);
        await deps.openCase?.(ctx.tenantId, {
          caseId: `app-online-return-${returnId}`, tenantId: ctx.tenantId, kind: 'complaint', customerRef: ctx.userId, openedAt: now, assignedTo: 'service-desk', priority: 'normal', state: 'open', orderRef: orderId,
          summary: `Online return ${returnId} for order ${orderId}: ${step.lines.map((l) => `${l.quantityMinor} × ${l.productId}`).join(', ')} — ${step.reason}`,
        });
        return { status: 201, body: { return: forCustomer(await view(ctx.tenantId, returnId)), tellTheCustomer: `We have your return (reference ${returnId}). The shop will book a collection; nothing is refunded until the goods are back and counted.` } };
      },
    },
    {
      api: 'API-07', method: 'GET', path: '/v1/me/online-returns',
      permission: 'storefront.order.read', entitlement: 'customer_app',
      handler: async (ctx) => {
        const mine = (await allViews(ctx.tenantId)).filter((v) => v.customerRef === ctx.userId).map(forCustomer);
        return { status: 200, body: { returns: mine, count: mine.length } };
      },
    },
    // ── the shop ──
    {
      // Every online return and where it stands — the desk's worklist; refunds still waiting are counted (P-08).
      api: 'API-07', method: 'GET', path: '/v1/online-returns',
      permission: 'online.return.manage',
      handler: async (ctx) => {
        const all = await allViews(ctx.tenantId);
        return { status: 200, body: { returns: all, count: all.length, refundsWaiting: all.filter((v) => v.stage === 'refund_waiting').length, policy: policyView(await policy(ctx.tenantId)) } };
      },
    },
    {
      // Book the collection. Body: { collectOn: YYYY-MM-DD }.
      api: 'API-07', method: 'POST', path: '/v1/online-returns/:returnId/collection',
      permission: 'online.return.manage', idempotent: true,
      handler: async (ctx) => {
        const returnId = ctx.params['returnId'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (typeof b['collectOn'] !== 'string' || !DAY.test(b['collectOn'])) throw apiError(400, { code: 'not_readable_as_a_collection', whatHappened: 'A collection needs { collectOn: YYYY-MM-DD }.', wasItSaved: 'not_saved', nextSafeAction: 'Nothing was changed.' });
        await stage(ctx.tenantId, returnId, ['requested', 'collection_scheduled'], 'a collection is booked before it is collected');
        await deps.recordStep(ctx.tenantId, { kind: 'collection_scheduled', returnId, collectOn: b['collectOn'], by: ctx.userId, at: deps.now() }, `${returnId}-collection-${b['collectOn']}`);
        return { status: 201, body: { return: await view(ctx.tenantId, returnId) } };
      },
    },
    {
      // The driver (or the desk) collected the goods from the customer.
      api: 'API-07', method: 'POST', path: '/v1/online-returns/:returnId/collected',
      permission: 'online.return.collect', idempotent: true,
      handler: async (ctx) => {
        const returnId = ctx.params['returnId'] ?? '';
        const v = await view(ctx.tenantId, returnId);
        if (v.stage === 'collected') return { status: 200, body: { return: v, alreadyCollected: true } };
        await stage(ctx.tenantId, returnId, ['collection_scheduled'], 'only a booked collection is collected');
        await deps.recordStep(ctx.tenantId, { kind: 'collected', returnId, by: ctx.userId, at: deps.now() }, `${returnId}-collected`);
        return { status: 201, body: { return: await view(ctx.tenantId, returnId) } };
      },
    },
    {
      // Received back at the shop, WITH A COUNT per line (0 when a line did not come back). Body: { lines: [{ productId, receivedMinor }] }.
      api: 'API-07', method: 'POST', path: '/v1/online-returns/:returnId/received',
      permission: 'online.return.manage', idempotent: true,
      handler: async (ctx) => {
        const returnId = ctx.params['returnId'] ?? '';
        const lines = readLines(((ctx.body ?? {}) as Record<string, unknown>)['lines'], 'receivedMinor');
        if (lines === undefined) throw apiError(400, { code: 'not_readable_as_a_count', whatHappened: 'Receiving needs { lines: [{ productId, receivedMinor (0 or more) }] } — one per line on the return.', wasItSaved: 'not_saved', nextSafeAction: 'Count each line and send again.' });
        const v = await stage(ctx.tenantId, returnId, ['collected'], 'goods are counted in once they are collected');
        const counted = lines.map((l) => ({ productId: l.productId, receivedMinor: l.n }));
        const check = checkReceivedCount(v, counted);
        if (!check.ok) throw apiError(422, { code: 'count_does_not_fit', whatHappened: `The count was not recorded: ${check.detail}.`, wasItSaved: 'not_saved', nextSafeAction: 'Count again and send every line once.' });
        await deps.recordStep(ctx.tenantId, { kind: 'received', returnId, lines: counted, by: ctx.userId, at: deps.now() }, `${returnId}-received`);
        return { status: 201, body: { return: await view(ctx.tenantId, returnId) } };
      },
    },
    {
      // A person chooses where one received line goes. Body: { disposition: sellable | quarantine | waste, reason? (waste) }.
      api: 'API-07', method: 'POST', path: '/v1/online-returns/:returnId/lines/:productId/disposition',
      permission: 'online.return.manage', idempotent: true,
      handler: async (ctx) => {
        const returnId = ctx.params['returnId'] ?? '';
        const productId = ctx.params['productId'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const disposition = b['disposition'] as ReturnDisposition;
        if (!DISPOSITIONS.includes(disposition) || (b['reason'] !== undefined && !isStr(b['reason']))) {
          throw apiError(400, { code: 'not_readable_as_a_disposition', whatHappened: 'A disposition is { disposition: sellable | quarantine | waste, reason? }.', wasItSaved: 'not_saved', nextSafeAction: 'Nothing was changed.' });
        }
        if (disposition === 'waste' && !isStr(b['reason'])) throw apiError(400, { code: 'reason_required', whatHappened: 'Waste needs a reason — the next person reads why the goods were thrown away.', wasItSaved: 'not_saved', nextSafeAction: 'Say why, and send again.' });
        const v = await view(ctx.tenantId, returnId);
        const line = v.lines.find((l) => l.productId === productId);
        if (v.receivedAt === undefined || line === undefined || (line.receivedMinor ?? 0) <= 0) {
          throw apiError(409, { code: 'nothing_received_on_this_line', whatHappened: `${productId} has not been received back on return ${returnId}.`, wasItSaved: 'not_saved', nextSafeAction: 'Receive and count the goods first.' });
        }
        if (line.disposition !== undefined) {
          if (line.disposition === disposition) return { status: 200, body: { return: v, alreadyChosen: true } };
          throw apiError(409, { code: 'disposition_already_chosen', whatHappened: `${productId} already went to ${line.disposition}; a disposition is chosen once.`, wasItSaved: 'not_saved', nextSafeAction: 'Nothing was changed. Correct it through a stock adjustment with its own reason if it was wrong.' });
        }
        if (disposition === 'sellable' && await deps.recalled(ctx.tenantId, productId)) {
          throw apiError(409, { code: 'under_recall', whatHappened: `${productId} is under a recall or hold — it cannot go back on the shelf.`, wasItSaved: 'not_saved', nextSafeAction: 'Choose quarantine.' });
        }
        const at = deps.now();
        if (disposition === 'sellable') {
          const order = await deps.placedOrder(ctx.tenantId, v.orderId);
          await deps.restock(ctx.tenantId, { movementId: `online-return-${returnId}-${productId}`, productId, locationId: order!.locationId, quantityMinor: line.receivedMinor!, by: ctx.userId, at });
        }
        await deps.recordStep(ctx.tenantId, { kind: 'disposed', returnId, productId, disposition, ...(isStr(b['reason']) ? { reason: (b['reason'] as string).trim() } : {}), by: ctx.userId, at }, `${returnId}-disposed-${productId}`);
        return { status: 201, body: { return: await view(ctx.tenantId, returnId) } };
      },
    },
    {
      // Refund the received lines to the order's own payment. Body: { refundId, approvalId?, productIds? }.
      api: 'API-07', method: 'POST', path: '/v1/online-returns/:returnId/refund',
      permission: 'order.refund.issue', idempotent: true,
      handler: async (ctx) => {
        const returnId = ctx.params['returnId'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const only = b['productIds'];
        if (!isStr(b['refundId']) || !ID.test(b['refundId'] as string) || (only !== undefined && (!Array.isArray(only) || !only.every(isStr)))) {
          throw apiError(400, { code: 'not_readable_as_a_refund', whatHappened: 'A return refund needs { refundId, approvalId?, productIds? }.', wasItSaved: 'not_saved', nextSafeAction: 'Nothing was sent and nothing was recorded.' });
        }
        const refundId = b['refundId'] as string;
        const v = await view(ctx.tenantId, returnId);
        if (v.refunds.some((r) => r.refundId === refundId)) return { status: 200, body: { return: v, alreadyRecorded: true } };
        const priced = new Map<string, { unitPriceMinor: number; basis: string } | undefined>();
        for (const l of v.lines) priced.set(l.productId, await deps.priceOf(ctx.tenantId, v.orderId, l.productId));
        const lines = planReturnRefund(v, (id) => priced.get(id), only as string[] | undefined);
        if (!lines.ok) throw apiError(409, { code: lines.code, whatHappened: `The refund was not sent: ${lines.detail}.`, wasItSaved: 'not_saved', nextSafeAction: 'Nothing moved.' });
        const orderId = v.orderId;
        const payment = paymentPosition(await deps.orderPayment(ctx.tenantId, orderId), await deps.paymentResolution(ctx.tenantId, orderId));
        const position = refundPosition({ payment, refunds: await deps.orderRefunds(ctx.tenantId, orderId), outcomes: await deps.refundOutcomes(ctx.tenantId, orderId) });
        // The second person (ADR-0024 · §28): an approval GIVEN in their own session for exactly this refund.
        const opened = await approvalNamedIn(deps.approvals, {
          tenantId: ctx.tenantId, approvalId: b['approvalId'], typedField: 'approvedBy', typedValue: b['approvedBy'],
          kind: 'order_refund', subjectRef: `${orderId}/${refundId}`, details: actionDetails(b, { returnId }), valueMinor: lines.amountMinor,
          maker: ctx.userId, usedBy: `online-return-refund:${returnId}/${refundId}`, now: deps.now(),
        });
        const approvedBy = opened?.decision.decidedBy;
        const plan = planOrderRefund({
          payment, position, amountMinor: lines.amountMinor, basis: 'return', substitutionRefundDueMinor: 0, requestedBy: ctx.userId,
          ...(approvedBy === undefined ? {} : { approvedBy }), approverHoldsAuthority: approvedBy !== undefined,
          approvalThresholdMinor: (await deps.refundThreshold(ctx.tenantId)) ?? DEFAULT_REFUND_THRESHOLD_MINOR,
        });
        if (!plan.ok) {
          throw apiError(409, { code: plan.refusedBecause ?? 'refund_refused', whatHappened: `The refund was not sent: ${plan.detail}.`, wasItSaved: 'not_saved', nextSafeAction: 'Nothing moved. For an approval finding, have a second person with refund-approval authority approve exactly this refund.' });
        }
        await opened?.spend();
        // Refund to source (C14): the ORDER's own token, never one in the request — once.
        const answer = await deps.refundProcessor.refund({ refundId, providerRef: payment.providerRef!, amountMinor: lines.amountMinor, currency: 'INR' });
        const state = answer.result === 'refunded' ? 'issued' : answer.result === 'declined' ? 'refused' : 'pending';
        const at = deps.now();
        const refund: OrderRefund = {
          refundId, orderId, amountMinor: lines.amountMinor, basis: 'return', reason: `online return ${returnId}: ${lines.lines.map((l) => `${l.quantityMinor} × ${l.productId}`).join(', ')}`,
          requestedBy: ctx.userId, ...(approvedBy === undefined ? {} : { approvedBy }), providerOutcome: answer.result, state,
          ...(answer.providerRefundRef === undefined ? {} : { providerRefundRef: answer.providerRefundRef }),
          ...(answer.detail === undefined ? {} : { providerDetail: answer.detail }), at,
        };
        await deps.recordRefund(ctx.tenantId, refund);
        await deps.recordStep(ctx.tenantId, { kind: 'refund_recorded', returnId, refundId, lines: lines.lines, amountMinor: lines.amountMinor, state, by: ctx.userId, at }, `${returnId}-refund-${refundId}`);
        const after = await view(ctx.tenantId, returnId);
        return { status: 201, body: { return: after, refund: { refundId, amountMinor: lines.amountMinor, state, shown: state === 'pending' ? 'waiting' : state }, tellTheCustomer: refundMessage(state, lines.amountMinor) } };
      },
    },
  ];
}
