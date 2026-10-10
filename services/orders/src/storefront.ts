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
import { promiseAndHold, readSubRules, type OrdersDeps, type PlacedOrder, type StoredSubstitutionRules, type SubstitutionConsent } from './index';
import { quoteOrder, type PaymentVerifier } from '../../../packages/orders/src/payment-verification';
import { transitionOrder } from '../../../packages/orders/src/index';
import type { PaymentRefundDeps } from './payments';

export interface StorefrontDeps {
  /** Every order this customer placed through the storefront — a fold of the per-customer index. */
  readonly ordersForCustomer: (tenantId: string, customerRef: string) => Promise<readonly PlacedOrder[]> | readonly PlacedOrder[];
  /** The order as placed — who placed it included — for the scope decision. */
  readonly placedOrder: (tenantId: string, orderId: string) => Promise<PlacedOrder | undefined> | PlacedOrder | undefined;
  readonly recordAccessRefusal: (tenantId: string, r: StorefrontAccessRefusal) => Promise<void> | void;
  readonly accessRefusals: (tenantId: string) => Promise<readonly StorefrontAccessRefusal[]> | readonly StorefrontAccessRefusal[];
  /**
   * FUL-03: the store's published unit price for a product — the shop's own quote for an order, never the app's figure.
   * Absent → no quote can be made, and no payment is ever taken as authorised (it stays pending for a person).
   */
  readonly unitPriceOf?: (tenantId: string, productId: string) => Promise<number | undefined> | number | undefined;
  /**
   * FUL-03: the payment provider — the only party that may say a payment is paid. Absent (no provider connected) →
   * every online payment stays pending until the bank's answer is recorded (POST /v1/orders/:orderId/payment/resolution).
   */
  readonly paymentVerifier?: PaymentVerifier;
  /** FUL-03: the shop's delivery fee for an order of this value, from its serviceability policy in force (fee, free-above). */
  readonly deliveryFeeFor?: (tenantId: string, itemsMinor: number) => Promise<number> | number;
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
  /** The shop's quote for what is promised on this order (FUL-03) — or why there is none. */
  const quoteFor = async (tenantId: string, lines: readonly { readonly productId: string; readonly quantityMinor: number }[], fulfilment?: 'delivery' | 'pickup') => {
    if (deps.unitPriceOf === undefined) return { ok: false as const, unpriced: lines.map((l) => l.productId) };
    const prices = new Map<string, number | undefined>();
    for (const l of lines) prices.set(l.productId, await deps.unitPriceOf(tenantId, l.productId));
    const items = quoteOrder({ lines, priceOf: (id) => prices.get(id) });
    if (!items.ok) return items;
    const deliveryFeeMinor = fulfilment === 'delivery' && deps.deliveryFeeFor !== undefined ? await deps.deliveryFeeFor(tenantId, items.itemsMinor) : 0;
    // `itemsMinor` names the whole amount to pay below; the items alone and the fee are kept beside it.
    return { ok: true as const, itemsMinor: items.itemsMinor + deliveryFeeMinor, goodsMinor: items.itemsMinor, deliveryFeeMinor, lines: items.lines };
  };
  /** What the shop promised on an order — the quantities the reservations hold. */
  const promisedLines = async (tenantId: string, order: PlacedOrder) =>
    (await deps.orderReservations(tenantId, order.orderId, order.locationId)).map((r) => ({ productId: r.productId, quantityMinor: r.quantityMinor }));

  /**
   * Record the app's payment answer as a CLAIM (FUL-03) and ask the provider. Only the provider's word that it captured
   * this token for exactly the shop's quote makes it authorised; a decline the app reports is kept (nothing was charged);
   * anything else is pending, with the reason said. Never trusted from the request alone.
   */
  const takePayment = async (
    tenantId: string, orderId: string, userId: string,
    claim: { readonly providerRef: string; readonly amountMinor: number; readonly result: PaymentResult; readonly reason?: unknown },
    quote: Awaited<ReturnType<typeof quoteFor>>,
  ) => {
    const at = deps.now();
    const mismatch = quote.ok && claim.amountMinor !== quote.itemsMinor;
    const unpriced = !quote.ok;
    const reason = claim.result === 'declined'
      ? (isStr(claim.reason) ? claim.reason : 'the customer\'s bank declined it')
      : mismatch ? `the app asked to pay ${claim.amountMinor} but the shop's price for this order is ${quote.itemsMinor} — not taken as paid; a person must look`
        : unpriced ? `the shop has no published price for ${quote.unpriced.join(', ')}, so it cannot check the amount — waiting for a person`
          : 'waiting for the payment provider to confirm it captured this payment';
    const record: OrderPayment = {
      orderId, providerRef: claim.providerRef, amountMinor: claim.amountMinor,
      // The app's word is never "authorised" on its own. A decline it reports is kept — nothing was charged.
      result: claim.result === 'declined' ? 'declined' : 'unknown',
      reason, recordedBy: userId, recordedAt: at,
    };
    await deps.recordPayment(tenantId, record);
    if (record.result === 'unknown' && !mismatch && !unpriced && deps.paymentVerifier !== undefined) {
      await checkWithProvider(tenantId, orderId, record, quote.ok ? quote.itemsMinor : claim.amountMinor);
    }
    return { mismatch, unpriced };
  };
  const checkWithProvider = async (tenantId: string, orderId: string, payment: OrderPayment, amountMinor: number) => {
    if (deps.paymentVerifier === undefined) return undefined;
    const v = await deps.paymentVerifier.verify({ orderId, providerRef: payment.providerRef, amountMinor });
    if (v.result === 'unknown' || v.evidenceRef === undefined) return v;
    await deps.recordPaymentResolution(tenantId, {
      orderId, result: v.result, evidenceRef: `${v.provider}:${v.evidenceRef}`, resolvedBy: `provider:${v.provider}`, resolvedAt: deps.now(),
    });
    return v;
  };

  const view = async (tenantId: string, order: PlacedOrder) => {
    const state = await deps.orderState(tenantId, order.orderId);
    const { payment, refunds } = await money(tenantId, order.orderId);
    return {
      orderId: order.orderId, locationId: order.locationId, lines: order.lines, placedAt: order.placedAt,
      state: state?.state ?? order.state,
      payment,
      position: { paidMinor: refunds.paidMinor, refundedMinor: refunds.refundedMinor, pendingMinor: refunds.pendingMinor, refundableMinor: refunds.refundableMinor },
      tellTheCustomer: payment.state === 'none' && (state?.state ?? order.state) === 'placed'
        ? 'Some of what you asked for is not in stock. Please look at what we can send, then pay for that or cancel — nothing has been charged.'
        : payment.state === 'pending'
        ? 'We are waiting for your bank to confirm the payment. Your order is not placed yet and we will not pick it until we know.'
        : payment.state === 'declined'
          ? 'Your bank did not accept the payment, so this order is not going ahead. Nothing has been charged.'
          : state?.state === 'cancelled' ? 'This order was cancelled.' : `Your order is ${state?.state ?? order.state}.`,
    };
  };

  return [
    // FUL-14: the signed-in customer's own standing substitution rules — what every one of their orders is swapped by.
    {
      api: 'API-07', method: 'PUT', path: '/v1/storefront/substitution-preferences',
      permission: 'storefront.order.place', entitlement: 'customer_app', idempotent: true,
      handler: async (ctx) => {
        if (deps.substitutionTruth === undefined) throw apiError(404, { code: 'not_available', whatHappened: 'Substitution rules are not kept by this composition.', wasItSaved: 'not_saved', nextSafeAction: 'Nothing was changed.' });
        const rules = readSubRules((ctx.body as { rules?: unknown } | undefined)?.rules);
        if (rules === undefined) {
          throw apiError(400, {
            code: 'not_readable_as_substitution_rules',
            whatHappened: 'Your substitution choice needs { rules: { preference: no_substitution | best_match | contact_me, blockedBrands?, blockedCategories?, avoidAllergens? } }.',
            wasItSaved: 'not_saved', nextSafeAction: 'Choose again. Nothing was changed.',
          });
        }
        const record: StoredSubstitutionRules = { rules, source: 'customer', recordedBy: ctx.userId, at: deps.now() };
        await deps.substitutionTruth.recordCustomerRules(ctx.tenantId, ctx.userId, record);
        return { status: 200, body: record };
      },
    },
    // FUL-14: the customer answers about a substitute on their OWN order — the recorded consent a swap that needs a yes rests on.
    {
      api: 'API-07', method: 'POST', path: '/v1/storefront/orders/:orderId/substitutions/:lineId',
      permission: 'storefront.order.place', entitlement: 'customer_app', idempotent: true,
      handler: async (ctx) => {
        const orderId = ctx.params['orderId'] ?? '';
        const lineId = ctx.params['lineId'] ?? '';
        if (deps.substitutionTruth === undefined) throw apiError(404, { code: 'not_available', whatHappened: 'Substitution answers are not kept by this composition.', wasItSaved: 'not_saved', nextSafeAction: 'Nothing was changed.' });
        await ownOrRefused(ctx.tenantId, ctx.userId, orderId, 'place');
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!isStr(lineId) || !isStr(b['substituteProductId']) || (b['decision'] !== 'confirmed' && b['decision'] !== 'declined')) {
          throw apiError(400, {
            code: 'not_readable_as_a_substitution_answer',
            whatHappened: 'Your answer needs { substituteProductId, decision: confirmed | declined, acceptsHigherPrice? }.',
            wasItSaved: 'not_saved', nextSafeAction: 'Answer again. Nothing was changed.',
          });
        }
        const consent: SubstitutionConsent = {
          orderId, lineId, substituteProductId: b['substituteProductId'] as string, decision: b['decision'] as 'confirmed' | 'declined',
          acceptsHigherPrice: b['acceptsHigherPrice'] === true, given: 'customer', by: ctx.userId, at: deps.now(),
        };
        await deps.substitutionTruth.recordConsent(ctx.tenantId, consent);
        return { status: 201, body: consent };
      },
    },
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
        const locationId = b['locationId'] as string;
        const fulfilment = b['fulfilment'] === 'delivery' || b['fulfilment'] === 'pickup' ? b['fulfilment'] : undefined;
        // Promised and held under the location's guard (Wave 2a · FUL-02), the lines one per product.
        const held = await promiseAndHold(deps, { tenantId: ctx.tenantId, orderId, lines: b['lines'], locationId });
        const { result, lines } = held;
        const placedAt = deps.now();
        // Who placed it is the authenticated subject — the one fact every later scope decision rests on.
        await deps.recordPlaced(ctx.tenantId, { orderId, locationId, lines, state: 'placed', placedAt, customerRef: ctx.userId, ...(fulfilment === undefined ? {} : { fulfilment }) });
        // FUL-03: the shop's own quote, on what it actually promised. FUL-07: when it could not promise everything, no
        // payment is taken — the customer sees the shortage and decides (pay for what is available, or cancel).
        const promised = result.lines.filter((l) => l.promisedMinor > 0).map((l) => ({ productId: l.productId, quantityMinor: l.promisedMinor }));
        const shortages = result.lines.filter((l) => l.promisedMinor < l.requestedMinor)
          .map((l) => ({ productId: l.productId, requestedMinor: l.requestedMinor, promisedMinor: l.promisedMinor }));
        const quote = await quoteFor(ctx.tenantId, promised, fulfilment);
        let taken: { readonly mismatch: boolean; readonly unpriced: boolean } | undefined;
        if (payment !== undefined && shortages.length === 0) {
          taken = await takePayment(ctx.tenantId, orderId, ctx.userId, payment, quote);
        }
        const placed = (await deps.placedOrder(ctx.tenantId, orderId)) ?? { orderId, locationId, lines, state: 'placed' as const, placedAt, customerRef: ctx.userId };
        return {
          status: 201,
          body: {
            ...(await view(ctx.tenantId, placed)),
            promise: { outcome: result.outcome, lines: result.lines.map((l) => ({ productId: l.productId, requestedMinor: l.requestedMinor, promisedMinor: l.promisedMinor, outcome: l.outcome })) },
            quote: quote.ok ? { itemsMinor: quote.itemsMinor, goodsMinor: quote.goodsMinor, deliveryFeeMinor: quote.deliveryFeeMinor, lines: quote.lines } : { unpriced: quote.unpriced },
            ...(shortages.length === 0 ? {} : { needsCustomerDecision: true, shortages }),
            ...(taken?.mismatch === true ? { amountMismatch: true } : {}),
          },
        };
      },
    },
    {
      // Pay for MY order (FUL-07): after a shortage, the customer pays for what the shop promised. Body:
      // { providerRef, amountMinor, result }. The same rule as at checkout: the app's word is a claim; the provider decides.
      api: 'API-07', method: 'POST', path: '/v1/storefront/orders/:orderId/payment',
      permission: 'storefront.order.place', entitlement: 'customer_app', idempotent: true,
      handler: async (ctx) => {
        const orderId = ctx.params['orderId'] ?? '';
        const own = await ownOrRefused(ctx.tenantId, ctx.userId, orderId, 'place');
        const b = ctx.body;
        if (!isObj(b) || !isStr(b['providerRef']) || !Number.isInteger(b['amountMinor']) || (b['amountMinor'] as number) < 0 || !PAYMENT_RESULTS.includes(b['result'] as PaymentResult)) {
          throw apiError(400, { code: 'not_readable_as_a_payment', whatHappened: 'A payment needs { providerRef, amountMinor, result }.', wasItSaved: 'not_saved', nextSafeAction: 'Nothing was recorded.' });
        }
        if (looksLikeCardNumber(b['providerRef'] as string)) {
          throw apiError(422, { code: 'not_a_provider_token', whatHappened: 'The payment reference looks like a card number. Only a provider token may be recorded (hard rule #3).', wasItSaved: 'not_saved', nextSafeAction: 'Pay through the provider\'s own sheet, which gives a token.' });
        }
        if ((await deps.orderPayment(ctx.tenantId, orderId)) !== undefined) {
          return { status: 200, body: { ...(await view(ctx.tenantId, own)), alreadyPaid: true } };
        }
        const state = (await deps.orderState(ctx.tenantId, orderId))?.state ?? own.state;
        if (state !== 'placed') {
          throw apiError(409, { code: 'order_not_awaiting_payment', whatHappened: `This order is ${state}; it is not waiting for a payment.`, wasItSaved: 'not_saved', nextSafeAction: 'Nothing was charged.' });
        }
        const quote = await quoteFor(ctx.tenantId, await promisedLines(ctx.tenantId, own), own.fulfilment);
        const taken = await takePayment(ctx.tenantId, orderId, ctx.userId, b as { providerRef: string; amountMinor: number; result: PaymentResult }, quote);
        return {
          status: 201,
          body: { ...(await view(ctx.tenantId, own)), quote: quote.ok ? { itemsMinor: quote.itemsMinor, lines: quote.lines } : { unpriced: quote.unpriced }, ...(taken.mismatch ? { amountMismatch: true } : {}) },
        };
      },
    },
    {
      // Ask the provider again about MY pending payment (FUL-03) — the answer is the provider's, never the app's.
      api: 'API-07', method: 'POST', path: '/v1/storefront/orders/:orderId/payment/check',
      permission: 'storefront.order.read', entitlement: 'customer_app', idempotent: true,
      handler: async (ctx) => {
        const orderId = ctx.params['orderId'] ?? '';
        const own = await ownOrRefused(ctx.tenantId, ctx.userId, orderId, 'read');
        const payment = await deps.orderPayment(ctx.tenantId, orderId);
        const resolution = await deps.paymentResolution(ctx.tenantId, orderId);
        if (payment !== undefined && payment.result === 'unknown' && resolution === undefined) {
          const quote = await quoteFor(ctx.tenantId, await promisedLines(ctx.tenantId, own), own.fulfilment);
          if (quote.ok && quote.itemsMinor === payment.amountMinor) await checkWithProvider(ctx.tenantId, orderId, payment, quote.itemsMinor);
        }
        return { status: 200, body: await view(ctx.tenantId, own) };
      },
    },
    {
      // Cancel MY order before it is paid (FUL-07: the customer's answer to a shortage) — the stock it held is released.
      api: 'API-07', method: 'POST', path: '/v1/storefront/orders/:orderId/cancel',
      permission: 'storefront.order.place', entitlement: 'customer_app', idempotent: true,
      handler: async (ctx) => {
        const orderId = ctx.params['orderId'] ?? '';
        const own = await ownOrRefused(ctx.tenantId, ctx.userId, orderId, 'place');
        const current = await deps.orderState(ctx.tenantId, orderId);
        const state = current?.state ?? own.state;
        if (state === 'cancelled') return { status: 200, body: await view(ctx.tenantId, own) };
        const pay = paymentPosition(await deps.orderPayment(ctx.tenantId, orderId), await deps.paymentResolution(ctx.tenantId, orderId));
        if (state !== 'placed' || pay.state === 'authorised' || pay.state === 'pending') {
          throw apiError(409, {
            code: 'cancel_at_the_desk',
            whatHappened: pay.state === 'authorised' || pay.state === 'pending'
              ? 'This order has a payment; cancelling it means a refund, which the shop arranges.'
              : `This order is ${state}; the app can cancel it only before it is paid.`,
            wasItSaved: 'not_saved', nextSafeAction: 'Contact the shop to cancel. Nothing was changed.',
          });
        }
        const released = await deps.orderReservations(ctx.tenantId, orderId, own.locationId);
        if (released.length > 0) await deps.releaseReservations(ctx.tenantId, released);
        await deps.recordTransition(ctx.tenantId, { orderId, event: 'cancel', from: state, to: transitionOrder(state, 'cancel'), at: deps.now() });
        return { status: 200, body: await view(ctx.tenantId, own) };
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
