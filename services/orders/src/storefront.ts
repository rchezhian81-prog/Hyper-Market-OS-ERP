// The storefront's own surface on API-07 — M20-FR-02/FR-03 · M18-FR-01/FR-02 · §31 · §35 · hard rules #3, #6.
//
// The customer app has always computed its order in the browser and never told the cloud. This is the cloud
// half of that hop, scoped to the CUSTOMER: a signed-in customer places an order that reserves stock in the
// same breath (the same `promise` engine the desk uses), records the checkout's payment answer against it in
// the same call (the same recording the desk uses — a card-shaped reference refused unrecorded, an unknown
// answer never picked), and reads back its OWN orders and nothing else. Who placed the order is written from
// the authenticated subject, never from the body; a request for another customer's order — or a staff-placed
// order — is refused AND recorded, so probing is visible to staff (hard rule #6), never answered with an
// empty screen.
//
// Gated by the `customer_app` entitlement (M36-FR-01): a shop whose plan has not enabled the customer app
// reaches none of this.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  scopeOrderToCustomer, probingCustomers, type StorefrontAccessRefusal,
} from '../../../packages/orders/src/storefront-scope';
import {
  looksLikeCardNumber, paymentPosition, refundPosition, type OrderPayment, type PaymentResult,
} from '../../../packages/orders/src/payment-refunds';
import { promise, type OrdersDeps, type PlacedOrder, type Reservation } from './index';
import type { PaymentRefundDeps } from './payments';

export interface StorefrontDeps {
  /** Every order this customer placed through the storefront — a fold of the per-customer index. */
  readonly ordersForCustomer: (tenantId: string, customerRef: string) => Promise<readonly PlacedOrder[]> | readonly PlacedOrder[];
  /** The order as placed — who placed it included — for the scope decision. */
  readonly placedOrder: (tenantId: string, orderId: string) => Promise<PlacedOrder | undefined> | PlacedOrder | undefined;
  readonly recordAccessRefusal: (tenantId: string, r: StorefrontAccessRefusal) => Promise<void> | void;
  readonly accessRefusals: (tenantId: string) => Promise<readonly StorefrontAccessRefusal[]> | readonly StorefrontAccessRefusal[];
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const PAYMENT_RESULTS: readonly PaymentResult[] = ['authorised', 'declined', 'unknown'];
const isLine = (v: unknown): v is { productId: string; quantityMinor: number } =>
  isObj(v) && isStr(v['productId']) && Number.isInteger(v['quantityMinor']) && (v['quantityMinor'] as number) > 0;

export function storefrontRoutes(deps: OrdersDeps & PaymentRefundDeps & StorefrontDeps): readonly Route[] {
  // Refuse-and-record: the one place a customer's request for what is not theirs is turned away (hard rule #6).
  const ownOrRefused = async (tenantId: string, customerRef: string, orderId: string, action: 'read' | 'place'): Promise<PlacedOrder> => {
    const order = await deps.placedOrder(tenantId, orderId);
    const decision = scopeOrderToCustomer({ order, customerRef });
    if (decision.securityEvent && decision.outcome !== 'own' && decision.outcome !== 'unknown') {
      await deps.recordAccessRefusal(tenantId, { customerRef, orderId, outcome: decision.outcome, action, at: deps.now() });
    }
    if (decision.outcome === 'unknown') {
      throw apiError(404, {
        code: 'order_unknown',
        whatHappened: `No order "${orderId}" has been placed.`,
        wasItSaved: 'not_saved',
        nextSafeAction: 'Check the order reference. Nothing was changed.',
      });
    }
    if (!decision.allowed) {
      throw apiError(403, {
        code: decision.outcome,
        whatHappened: `${decision.detail}. You can only see your own orders. This attempt was recorded.`,
        wasItSaved: 'not_saved',
        nextSafeAction: 'Nothing was changed.',
      });
    }
    return order!;
  };
  const money = async (tenantId: string, orderId: string) => {
    const payment = paymentPosition(await deps.orderPayment(tenantId, orderId), await deps.paymentResolution(tenantId, orderId));
    const refunds = refundPosition({ payment, refunds: await deps.orderRefunds(tenantId, orderId), outcomes: await deps.refundOutcomes(tenantId, orderId) });
    return { payment, refunds };
  };
  const view = async (tenantId: string, order: PlacedOrder) => {
    const state = await deps.orderState(tenantId, order.orderId);
    const { payment, refunds } = await money(tenantId, order.orderId);
    return {
      orderId: order.orderId, locationId: order.locationId, lines: order.lines, placedAt: order.placedAt,
      state: state?.state ?? order.state,
      payment,
      position: { paidMinor: refunds.paidMinor, refundedMinor: refunds.refundedMinor, pendingMinor: refunds.pendingMinor, refundableMinor: refunds.refundableMinor },
      tellTheCustomer: payment.state === 'pending'
        ? 'We are waiting for your bank to confirm the payment. Your order is not placed yet and we will not pick it until we know.'
        : payment.state === 'declined'
          ? 'Your bank did not accept the payment, so this order is not going ahead. Nothing has been charged.'
          : state?.state === 'cancelled' ? 'This order was cancelled.' : `Your order is ${state?.state ?? order.state}.`,
    };
  };

  return [
    {
      // Place an order as the signed-in customer: reserve in the same breath, record the checkout's payment answer.
      // Body: { lines: [{ productId, quantityMinor }], locationId, payment?: { providerRef, amountMinor, result, reason? } }.
      api: 'API-07', method: 'POST', path: '/v1/storefront/orders/:orderId',
      permission: 'storefront.order.place', entitlement: 'customer_app', idempotent: true,
      handler: async (ctx) => {
        const orderId = ctx.params['orderId'] ?? '';
        const b = ctx.body;
        if (!isObj(b) || !Array.isArray(b['lines']) || b['lines'].length === 0 || !b['lines'].every(isLine) || !isStr(b['locationId'])
          || (b['payment'] !== undefined && (!isObj(b['payment']) || !isStr(b['payment']['providerRef']) || !Number.isInteger(b['payment']['amountMinor'])
            || (b['payment']['amountMinor'] as number) < 0 || !PAYMENT_RESULTS.includes(b['payment']['result'] as PaymentResult)))) {
          throw apiError(400, {
            code: 'not_readable_as_an_order',
            whatHappened: 'An order needs { lines: [{ productId, quantityMinor > 0 }], locationId, payment?: { providerRef, amountMinor, result } }.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was reserved or recorded. Send the basket as the app reviewed it.',
          });
        }
        const payment = b['payment'] as { providerRef: string; amountMinor: number; result: PaymentResult; reason?: unknown } | undefined;
        if (payment !== undefined && looksLikeCardNumber(payment.providerRef)) {
          throw apiError(422, {
            code: 'not_a_provider_token',
            whatHappened: 'The payment reference looks like a card number. Only a provider token may be recorded (hard rule #3).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was reserved or recorded. Pay through the provider\'s own sheet, which gives a token.',
          });
        }
        // An order that already exists is either this customer's (a retry — answer with what stands, reserve
        // nothing twice) or somebody else's (refused and recorded).
        const existing = await deps.placedOrder(ctx.tenantId, orderId);
        if (existing !== undefined) {
          const own = await ownOrRefused(ctx.tenantId, ctx.userId, orderId, 'place');
          return { status: 200, body: { ...(await view(ctx.tenantId, own)), alreadyPlaced: true } };
        }
        const lines = b['lines'] as { productId: string; quantityMinor: number }[];
        const locationId = b['locationId'] as string;
        const result = promise({
          orderId, lines,
          onHand: await deps.onHand(ctx.tenantId, locationId),
          outstanding: await deps.outstanding(ctx.tenantId, locationId),
          locationId,
          heldUntil: new Date(Date.parse(deps.now()) + deps.holdMinutes * 60_000).toISOString(),
          reservationIdFor: (o, p) => `${o}${p}`,
        });
        const reservations: readonly Reservation[] = result.lines.flatMap((l) => (l.reservation === undefined ? [] : [l.reservation]));
        if (reservations.length > 0) await deps.holdReservations(ctx.tenantId, reservations);
        const placedAt = deps.now();
        // Who placed it is the authenticated subject — the one fact every later scope decision rests on.
        await deps.recordPlaced(ctx.tenantId, { orderId, locationId, lines, state: 'placed', placedAt, customerRef: ctx.userId });
        if (payment !== undefined) {
          const record: OrderPayment = {
            orderId, providerRef: payment.providerRef, amountMinor: payment.amountMinor, result: payment.result,
            ...(isStr(payment.reason) ? { reason: payment.reason } : {}),
            recordedBy: ctx.userId, recordedAt: placedAt,
          };
          await deps.recordPayment(ctx.tenantId, record);
        }
        const placed = (await deps.placedOrder(ctx.tenantId, orderId)) ?? { orderId, locationId, lines, state: 'placed' as const, placedAt, customerRef: ctx.userId };
        return { status: 201, body: { ...(await view(ctx.tenantId, placed)), promise: { outcome: result.outcome, lines: result.lines.map((l) => ({ productId: l.productId, requestedMinor: l.requestedMinor, promisedMinor: l.promisedMinor, outcome: l.outcome })) } } };
      },
    },
    {
      // The security register — every refused attempt to read or place against another customer's order, and who
      // is probing (more than one distinct order). Staff read; a customer never sees it.
      api: 'API-07', method: 'GET', path: '/v1/storefront/access-refusals',
      permission: 'order.read', entitlement: 'customer_app',
      handler: async (ctx) => {
        const refusals = await deps.accessRefusals(ctx.tenantId);
        return { status: 200, body: { refusals, probing: probingCustomers(refusals), detail: refusals.length === 0 ? 'no customer has asked for another customer\'s order' : `${refusals.length} refused attempt(s) on record` } };
      },
    },
    {
      // My orders — the signed-in customer's own, newest first. Never another customer's, never a desk order.
      api: 'API-07', method: 'GET', path: '/v1/storefront/orders',
      permission: 'storefront.order.read', entitlement: 'customer_app',
      handler: async (ctx) => {
        const mine = [...await deps.ordersForCustomer(ctx.tenantId, ctx.userId)].sort((a, b) => b.placedAt.localeCompare(a.placedAt));
        const orders = [];
        for (const o of mine) orders.push(await view(ctx.tenantId, o));
        return { status: 200, body: { orders } };
      },
    },
    {
      // One of my orders — state, payment, money position, and what to tell me. Another customer's → 403, recorded.
      api: 'API-07', method: 'GET', path: '/v1/storefront/orders/:orderId',
      permission: 'storefront.order.read', entitlement: 'customer_app',
      handler: async (ctx) => {
        const own = await ownOrRefused(ctx.tenantId, ctx.userId, ctx.params['orderId'] ?? '', 'read');
        return { status: 200, body: await view(ctx.tenantId, own) };
      },
    },
  ];
}
