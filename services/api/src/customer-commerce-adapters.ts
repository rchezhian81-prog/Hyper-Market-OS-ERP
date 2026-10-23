// OB-288 wave 3 · customer, loyalty, CRM and the online cart — head office's wiring for this package. One line in
// `main.ts` calls `customerCommerceSurface(surface, …)`; everything below adds routes or rebuilds an existing route in
// place with more of the shop's own facts behind it. Each rebuilt route keeps its path and permission; a target route
// that is missing throws at start-up — a step that silently does not happen is the failure P-08 forbids.
//
//   • M16-FR-04 — the customer's record shows the service desk's own cases (complaints first), and segmentation counts
//     the complaints the desk actually recorded, not only ones typed in by hand.
//   • WF-13 · M20-FR-02 — the online basket priced by the till's promotions and coupon engines, with the points balance
//     (`onlinePricingAdapter`, one deps line on the storefront routes in main.ts).
//   • M17-FR-02 (OB-303) — repeat online orders: the customer's plan, each day's order placed through the storefront's
//     OWN placement route (found on the surface, invoked as the customer), on the ops timer and on demand.
//   • M20-FR-03 — order-status notices worked out from the orders' own facts and handed to the service-message queue
//     (its own route, found on the surface), on the ops timer and on demand.
//   • M20-FR-04 · M20-FR-02 · A05 — saved addresses (minimised), the "no saved payment" stand-in, consent-safe
//     recommendations, and the customer's help answers (A05 through its own staff-side engine, own orders only).
//   • M21-FR-02 — journeys worked out from facts (a held basket, an occasion given with consent, the last purchase), sent
//     only when switched on, each through the campaign send's own route; on the ops timer and on demand.
//   • M17-FR-01 (OB-295) — the loyalty programme's tiers and points expiry: owner settings kept as facts, OFF and "not set"
//     until entered; the tier multiplier applied when a bill earns (`withLoyaltyTiers`, one wrap in main.ts); the expiry
//     run on the ops worker's timer (`customerCommerceSweep`) and on demand.

import { createHash } from 'node:crypto';
import type { EventStore } from '../../../packages/persistence/src/event-store';
import { makeEvent } from '../../../packages/contracts/src/event';
import type { LoyaltyTier, LedgerMovement } from '../../../packages/loyalty/src/index';
import { loyaltyProgrammeRoutes, runPointsExpiry, tierMultiplierAt, type LoyaltyProgrammeDeps, type ProgrammeSetting } from '../../customer/src/loyalty-programme';
import type { LoyaltyEffectsDeps } from '../../customer/src/loyalty-effects';
import type { MemberRecord } from '../../customer/src/loyalty-members';
import type { RecordedPointsMovement } from '../../customer/src/index';
import type { Route, RequestContext } from '../../kernel/src/index';
import { ApiError } from '../../kernel/src/index';
import { storefrontAccountRoutes, type StorefrontAccountDeps, type SavedAddress } from '../../orders/src/storefront-account';
import { basketAffinityAdapter } from './r4-insight-adapters';
import { resolveServiceabilityPolicy } from '../../../packages/storefront/src/index';
import { journeyRoutes, runJourneys, type JourneyDeps, type CartFact, type JourneySwitch, type JourneyOutcome } from '../../customer/src/journeys';
import type { Occasion } from '../../../packages/service-desk/src/journey-facts';
import { orderNoticeRoutes, runOrderNotices, type OrderNoticeDeps, type OrderNoticeFact } from '../../orders/src/order-notices';
import { paymentPosition, foldRefunds } from '../../../packages/orders/src/payment-refunds';
import type { PlacedOrder } from '../../orders/src/index';
import { approvedTemplate } from '../../customer/src/notification-queue';
import { subscriptionRoutes, runSubscriptions, type SubscriptionDeps, type SubscriptionOccurrence, type PlaceAttempt } from '../../orders/src/storefront-subscriptions';
import type { SubscriptionPlan, SubscriptionChange } from '../../../packages/storefront/src/subscriptions';
import { customer360Routes, complaintFactsOf, type ServiceCaseFact } from '../../customer/src/customer-360';
import { segmentRoutes } from '../../customer/src/segments';
import type { ComplaintFact } from '../../../packages/customer/src/index';
import { customer360Adapter, segmentDataAdapter, serviceCaseAdapter, customerAdapter, couponAdapter, promotionCatalogueAdapter, productMasterAdapter, ordersAdapter, fulfilmentAdapter, notificationQueueAdapter, serviceabilityAdapter, STREAM, streamName } from './adapters';
import type { OnlinePricingDeps, OrderPricingFact } from '../../orders/src/storefront';
import { currentMemberLink, type MemberAppLink } from '../../customer/src/digital-receipts';
import { customerOverviewRoutes } from '../../customer/src/customer-overview';
import { customerOverviewAdapter } from './r4-insight-adapters';

export interface CustomerCommerceInput {
  readonly store: EventStore | undefined;
  readonly now: () => string;
  /** The shop's time zone (store setup) — its calendar decides which day a repeat order is for. */
  readonly timeZone?: (tenantId: string) => Promise<string> | string;
}

/** The day an instant falls on in a time zone (YYYY-MM-DD). */
export function dayIn(at: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at));
}
const timeIn = (at: string, timeZone: string): string =>
  new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(at));

/** A route's handler run as an internal caller (no HTTP, no permission check: head office acting for the customer). */
async function invoke(route: Route, ctx: Omit<RequestContext, 'branchId' | 'traceId'>): Promise<{ readonly status: number; readonly body: unknown } | { readonly refused: ApiError }> {
  try {
    return await route.handler({ ...ctx, branchId: null, traceId: 'customer-commerce' });
  } catch (e) {
    if (e instanceof ApiError) return { refused: e };
    throw e;
  }
}

/**
 * What the timed sweep needs from the surface it cannot see from `startApi` — the storefront's own placement route —
 * registered here by `customerCommerceSurface` for the store it was built over.
 */
const RUNNERS = new WeakMap<EventStore, { readonly subscriptions: SubscriptionDeps; readonly notices: OrderNoticeDeps; readonly journeys: JourneyDeps }>();

const unwiredProgramme = (now: () => string): LoyaltyProgrammeDeps => ({
  now, tiers: async () => undefined, recordTiers: async () => {}, expiry: async () => undefined, recordExpiry: async () => {},
  allMembers: async () => [], spendBetween: async () => 0, movements: async () => [], pointsVersion: async () => 0, recordExpiryMovement: async () => {},
});

function replace(surface: Route[], method: string, path: string, change: (r: Route) => Route): void {
  const at = surface.findIndex((r) => r.method === method && r.path === path);
  if (at < 0) throw new Error(`customer-commerce wiring cannot find ${method} ${path} — the step it adds would silently not happen`);
  surface[at] = change(surface[at]!);
}

/** Every route of `fresh` replaces the route with the same method and path on the surface (keeping its permission). */
function rebuildInPlace(surface: Route[], fresh: readonly Route[], only?: (r: Route) => boolean): void {
  for (const f of fresh) {
    if (only !== undefined && !only(f)) continue;
    replace(surface, f.method, f.path, (r) => ({ ...f, permission: r.permission, ...(r.entitlement === undefined ? {} : { entitlement: r.entitlement }) }));
  }
}

// ── M16-FR-04 · the service desk's cases on the customer's record ───────────────────────────────────────────────────

/** The desk's cases naming one customer, as the record shows them. */
export function casesOfCustomer(input: { readonly store: EventStore; readonly now: () => string }) {
  return async (tenantId: string, customerRef: string): Promise<readonly ServiceCaseFact[]> =>
    (await serviceCaseAdapter(input).serviceCases(tenantId))
      .filter((c) => c.customerRef === customerRef)
      .map((c): ServiceCaseFact => ({
        caseId: c.caseId, customerRef: c.customerRef, kind: c.kind, state: c.state, priority: c.priority, summary: c.summary, openedAt: c.openedAt,
        ...(c.orderRef === undefined ? {} : { orderRef: c.orderRef }),
        ...(c.resolvedAt === undefined ? {} : { resolvedAt: c.resolvedAt }),
        ...(c.resolution === undefined ? {} : { resolution: c.resolution }),
      }));
}

/** The complaint facts segmentation reads: the ones typed in (kept) and the desk's own complaints, one per case. */
export function complaintFactsWithCases(input: { readonly store: EventStore; readonly now: () => string }) {
  return async (tenantId: string): Promise<readonly ComplaintFact[]> => {
    const typed = await segmentDataAdapter(input).complaintFacts(tenantId);
    const fromDesk = complaintFactsOf(await serviceCaseAdapter(input).serviceCases(tenantId));
    const seen = new Set(typed.map((c) => c.caseId));
    return [...typed, ...fromDesk.filter((c) => !seen.has(c.caseId))];
  };
}

// ── small event-sourced registers ────────────────────────────────────────────────────────────────────────────────────

type Base = { readonly store: EventStore; readonly now: () => string };
const keyed = (prefix: string, key: string): string => `${prefix}-${createHash('sha256').update(key).digest('hex').slice(0, 24)}`;

/** An append-only list of facts of one type on one stream: read oldest first, appended once per key. */
function factList<T>(store: EventStore, stream: string, type: string) {
  return {
    all: async (tenantId: string): Promise<readonly T[]> => (await store.readStream(tenantId, stream, { type })).map((e) => e.event.payload as T),
    append: async (tenantId: string, key: string, payload: T, at: string): Promise<void> => {
      await store.append(tenantId, stream, makeEvent({ id: keyed(type, `${tenantId}|${key}`), type, occurredAt: at, idempotencyKey: `${type}-${tenantId}-${key}`, source: 'api/customer-commerce', payload }));
    },
  };
}

// ── M17-FR-02 · OB-303 · repeat online orders ───────────────────────────────────────────────────────────────────────

const SUBSCRIPTIONS = streamName(STREAM.orders, 'subscriptions');

export function subscriptionAdapter(input: Base & { readonly placement: Route | undefined; readonly slots: Route | undefined; readonly timeZone: (tenantId: string) => Promise<string> }): SubscriptionDeps {
  const { store, now } = input;
  const plans = factList<SubscriptionPlan>(store, SUBSCRIPTIONS, 'SubscriptionStarted');
  const changes = factList<SubscriptionChange>(store, SUBSCRIPTIONS, 'SubscriptionChanged');
  const occurrences = factList<SubscriptionOccurrence>(store, SUBSCRIPTIONS, 'SubscriptionOccurrence');
  /** The delivery slot on that day at (or after) the customer's preferred time, from the shop's own delivery service. */
  const slotFor = async (tenantId: string, plan: SubscriptionPlan, day: string): Promise<{ readonly startsAt: string; readonly endsAt: string } | string> => {
    if (input.slots === undefined) return 'the shop\'s delivery service is not set up here';
    const r = await invoke(input.slots, { tenantId, userId: plan.customerRef, params: {}, query: { day }, body: undefined });
    if ('refused' in r) return r.refused.body.whatHappened;
    const tz = await input.timeZone(tenantId);
    const offered = ((r.body as { slots?: { startsAt: string; endsAt: string; capacity: number; taken: number }[] }).slots ?? [])
      .filter((sl) => sl.taken < sl.capacity && timeIn(sl.startsAt, tz) >= (plan.delivery?.slotTime ?? '00:00'))
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    return offered[0] ?? `no delivery slot is open on ${day} at or after ${plan.delivery?.slotTime ?? ''}`;
  };
  return {
    now,
    plans: (t) => plans.all(t),
    recordPlan: (t, p) => plans.append(t, p.subscriptionId, p, p.createdAt),
    changes: (t) => changes.all(t),
    recordChange: (t, c) => changes.append(t, `${c.subscriptionId}|${c.change}|${c.at}`, c, c.at),
    occurrences: (t) => occurrences.all(t),
    recordOccurrence: (t, o) => occurrences.append(t, `${o.subscriptionId}|${o.day}`, o, o.at),
    today: async (t) => dayIn(now(), await input.timeZone(t)),
    placeOrder: async (tenantId, { orderId, plan, day }): Promise<PlaceAttempt> => {
      if (input.placement === undefined) return { placed: false, why: 'the storefront is not part of this head office, so no order can be placed' };
      let delivery: Record<string, unknown> = {};
      if (plan.fulfilment === 'delivery' && plan.delivery !== undefined) {
        const slot = await slotFor(tenantId, plan, day);
        if (typeof slot === 'string') return { placed: false, why: `Not placed: ${slot}. Nothing was charged.` };
        delivery = { deliverySlot: { startsAt: slot.startsAt, endsAt: slot.endsAt }, deliveryLocation: plan.delivery.location };
      }
      const r = await invoke(input.placement, {
        tenantId, userId: plan.customerRef, params: { orderId }, query: {}, idempotencyKey: `subscription-${orderId}`,
        body: { lines: plan.lines, locationId: plan.locationId, fulfilment: plan.fulfilment, ...delivery },
      });
      if ('refused' in r) return { placed: false, why: `Not placed: ${r.refused.body.whatHappened} Nothing was charged.` };
      const b = r.body as { quote?: { itemsMinor?: number }; shortages?: SubscriptionOccurrence['shortages']; alreadyPlaced?: boolean };
      const pay = b.quote?.itemsMinor;
      return {
        placed: true, ...(pay === undefined ? {} : { payableMinor: pay }), ...(b.shortages === undefined ? {} : { shortages: b.shortages }),
        detail: b.shortages !== undefined && b.shortages.length > 0
          ? `Placed for ${day}, but the shop cannot send everything — look in the app at what it can send, then pay or cancel. Nothing has been charged.`
          : `Placed for ${day}${pay === undefined ? '' : ` — ₹${(pay / 100).toFixed(2)} to pay in the app`}. Nothing has been charged yet.`,
      };
    },
  };
}

// ── M20-FR-03 · order-status notices ────────────────────────────────────────────────────────────────────────────────

const ORDER_INDEX = streamName(STREAM.orders, 'index');
const ORDER_NOTICES = streamName(STREAM.orders, 'customer-notices');

export function orderNoticeAdapter(input: Base & { readonly queue: Route | undefined }): OrderNoticeDeps {
  const { store, now } = input;
  const orders = ordersAdapter({ store, now, holdMinutes: 60 });
  const notices = factList<OrderNoticeFact>(store, ORDER_NOTICES, 'OrderNoticeRecorded');
  return {
    now,
    onlineOrders: async (t) => (await store.readStream(t, ORDER_INDEX, { type: 'OrderPlaced' }))
      .map((e) => e.event.payload as PlacedOrder)
      .filter((o): o is PlacedOrder & { customerRef: string } => typeof o.customerRef === 'string' && o.customerRef !== '')
      .map((o) => ({ orderId: o.orderId, customerRef: o.customerRef })),
    facts: async (t, o) => {
      const state = await orders.orderState(t, o.orderId);
      if (state === undefined) return undefined;
      const payment = paymentPosition(await orders.orderPayment(t, o.orderId), await orders.paymentResolution(t, o.orderId));
      const refunds = foldRefunds(await orders.orderRefunds(t, o.orderId), await orders.refundOutcomes(t, o.orderId));
      const delivery = await fulfilmentAdapter({ store, now }).deliveryState(t, o.orderId);
      return { orderId: o.orderId, customerRef: o.customerRef, state: state.state, paymentState: payment.state, delivery: delivery.map((d) => ({ to: d.to, at: d.at })), refunds: refunds.map((r) => ({ refundId: r.refundId, amountMinor: r.amountMinor, effectiveState: r.effectiveState })) };
    },
    enqueue: async (t, notice) => {
      if (input.queue === undefined) return { queued: false, code: 'no_message_queue', detail: 'This head office has no message queue, so nothing can be sent.' };
      const template = approvedTemplate(await notificationQueueAdapter({ store, now }).templates!(t), notice.templateId);
      if (template === undefined) return { queued: false, code: 'template_not_approved', detail: `No approved template "${notice.templateId}" — the words are drafted by one person and approved by another before anything is sent.` };
      const r = await invoke(input.queue, {
        tenantId: t, userId: 'system:order-notices', params: { id: notice.noticeId }, query: {}, idempotencyKey: notice.noticeId,
        body: { customerId: notice.customerRef, purpose: 'transactional', channel: template.channel, templateId: notice.templateId, values: notice.values },
      });
      if ('refused' in r) return { queued: false, code: r.refused.body.code, detail: r.refused.body.whatHappened };
      return { queued: true, channel: template.channel };
    },
    notices: (t) => notices.all(t),
    recordNotice: (t, f) => notices.append(t, `${f.noticeId}|${f.outcome}|${f.code ?? ''}|${f.at}`, f, f.at),
  };
}

// ── M20-FR-04 · M20-FR-02 · A05 · the customer's account controls, suggestions and help ──────────────────────────────

const ADDRESSES = streamName(STREAM.customer, 'saved-addresses');
const rupeesOf = (minor: number): string => `₹${(minor / 100).toFixed(2)}`;

export function storefrontAccountAdapter(input: Base & { readonly a05: Route | undefined; readonly returnPolicy: Route | undefined }): StorefrontAccountDeps {
  const { store, now } = input;
  const addresses = factList<SavedAddress>(store, ADDRESSES, 'AddressSaved');
  const orders = ordersAdapter({ store, now, holdMinutes: 60 });
  return {
    now,
    addresses: async (t, c) => (await addresses.all(t)).filter((a) => a.customerRef === c),
    recordAddress: (t, a) => addresses.append(t, `${a.customerRef}|${a.addressId}|${a.change}|${a.at}`, a, a.at),
    consentRecords: async (t, c) => (await customerAdapter(input).consentRecords(t, c)).map((r) => ({ purpose: r.purpose, given: r.given, recordedAt: r.recordedAt })),
    alsoBought: async (t, productId) => {
      const to = now().slice(0, 10);
      const from = new Date(Date.parse(now()) - 90 * 86_400_000).toISOString().slice(0, 10);
      const counts = new Map<string, number>();
      for (const b of await basketAffinityAdapter(input).baskets(t, from, to)) {
        const ids = new Set(b.lines.map((l) => l.productId));
        if (!ids.has(productId)) continue;
        for (const id of ids) if (id !== productId) counts.set(id, (counts.get(id) ?? 0) + 1);
      }
      return [...counts.entries()].map(([id, count]) => ({ productId: id, count }));
    },
    boughtBefore: async (t, c) => {
      const latest = new Map<string, string>();
      for (const o of await orders.ordersForCustomer(t, c)) for (const l of o.lines) if ((latest.get(l.productId) ?? '') < o.placedAt) latest.set(l.productId, o.placedAt);
      return [...latest.entries()].map(([productId, lastBoughtAt]) => ({ productId, lastBoughtAt }));
    },
    sellable: async (t, productId) => {
      const p = await productMasterAdapter({ store, now }).product(t, productId);
      return p !== undefined && p.lifecycle === 'active';
    },
    orderOwner: async (t, orderId) => (await orders.placedOrder(t, orderId))?.customerRef,
    a05OrderAnswer: async (t, orderId) => {
      if (input.a05 === undefined) return { answered: false, agentActive: false, text: '' };
      const r = await invoke(input.a05, { tenantId: t, userId: 'system:customer-help', params: {}, query: {}, idempotencyKey: `help-${orderId}-${now()}`, body: { topic: 'order_status', orderId } });
      if ('refused' in r) return { answered: false, agentActive: false, text: '' };
      const b = r.body as { answered?: boolean; agentActive?: boolean; text?: string };
      return { answered: b.answered === true, agentActive: b.agentActive === true, text: b.text ?? '' };
    },
    returnPolicyWords: async (t) => {
      if (input.returnPolicy === undefined) return 'The shop\'s return windows are not set yet ("not set"). Ask a person and the shop will help.';
      const r = await invoke(input.returnPolicy, { tenantId: t, userId: 'system:customer-help', params: {}, query: {}, body: undefined });
      const p = 'refused' in r ? undefined : (r.body as { policy?: { windowDaysByCategory?: Record<string, number>; nonReturnable?: unknown } }).policy;
      const w = p?.windowDaysByCategory ?? {};
      if (Object.keys(w).length === 0) return 'The shop has not set its return windows yet ("not set"), so a return cannot be judged automatically. Ask a person and the shop will help.';
      const list = p?.nonReturnable === 'not set' ? 'The list of things that cannot be returned is not set yet.' : Array.isArray(p?.nonReturnable) && p!.nonReturnable.length > 0 ? `Not returnable: ${(p!.nonReturnable as string[]).join(', ')}.` : 'Everything may be returned within its window.';
      return `You can return within these days after delivery: ${Object.entries(w).map(([c, d]) => `${c} ${d}`).join(', ')}. ${list}`;
    },
    deliveryWords: async (t) => {
      const { policy } = resolveServiceabilityPolicy({ schedule: await serviceabilityAdapter({ store, now }).schedule(t), on: now().slice(0, 10) });
      const fee = policy.deliveryFeeMinor ?? 0;
      return `We deliver within ${((policy.radiusMetres ?? 10_000) / 1000).toFixed(0)} km. Delivery costs ${fee === 0 ? 'nothing' : rupeesOf(fee)}${policy.freeDeliveryAboveMinor === undefined ? '' : `, and is free on orders of ${rupeesOf(policy.freeDeliveryAboveMinor)} or more`}${policy.minimumOrderMinor === undefined ? '' : `. The smallest order we deliver is ${rupeesOf(policy.minimumOrderMinor)}`}. You can also collect from the store at no charge.`;
    },
  };
}

// ── M21-FR-02 · journeys from facts ─────────────────────────────────────────────────────────────────────────────────

const JOURNEYS = streamName(STREAM.customer, 'journeys');

export function journeyAdapter(input: Base & { readonly quote: Route | undefined; readonly send: Route | undefined; readonly timeZone: (tenantId: string) => Promise<string> }): JourneyDeps {
  const { store, now } = input;
  const carts = factList<CartFact>(store, JOURNEYS, 'CartHeld');
  const occasions = factList<Occasion & { readonly at: string }>(store, JOURNEYS, 'OccasionGiven');
  const switches = factList<JourneySwitch>(store, JOURNEYS, 'JourneySwitched');
  const outcomes = factList<JourneyOutcome>(store, JOURNEYS, 'JourneyOutcome');
  return {
    now,
    carts: (t) => carts.all(t),
    recordCart: (t, c) => carts.append(t, `${c.customerRef}|${c.updatedAt}`, c, c.updatedAt),
    // What the basket is worth at the shop's own prices — the storefront's own quote, as the customer.
    valueOf: async (t, lines) => {
      if (input.quote === undefined) return 0;
      const r = await invoke(input.quote, { tenantId: t, userId: 'system:journeys', params: {}, query: {}, idempotencyKey: `cart-value-${now()}`, body: { lines } });
      return 'refused' in r ? 0 : ((r.body as { goodsMinor?: number }).goodsMinor ?? 0);
    },
    occasions: (t) => occasions.all(t),
    recordOccasion: (t, o) => occasions.append(t, `${o.occasionId}|${o.at}|${o.removed === true}`, o, o.at),
    purchases: async (t) => {
      const sales = (await store.readStream(t, STREAM.sales, { type: 'SaleCommitted' })).map((e) => e.event.payload as { customerRef?: unknown; committedAt: string; totalMinor: number })
        .filter((x) => typeof x.customerRef === 'string' && x.customerRef !== '')
        .map((x) => ({ customerRef: x.customerRef as string, at: x.committedAt, valueMinor: x.totalMinor }));
      const online = (await store.readStream(t, ORDER_INDEX, { type: 'OrderPlaced' })).map((e) => e.event.payload as PlacedOrder)
        .filter((o) => typeof o.customerRef === 'string' && o.customerRef !== '')
        .map((o) => ({ customerRef: o.customerRef as string, at: o.placedAt, valueMinor: 0 }));
      return [...sales, ...online];
    },
    lapsingAfterDays: async (t) => (await segmentDataAdapter(input).policy(t))?.lapsingAfterDays ?? 60,
    switches: (t) => switches.all(t),
    recordSwitch: (t, sw) => switches.append(t, `${sw.kind}|${sw.at}`, sw, sw.at),
    outcomes: (t) => outcomes.all(t),
    recordOutcome: (t, o) => outcomes.append(t, `${o.ref}|${o.outcome}|${o.code ?? ''}|${o.at}`, o, o.at),
    send: async (t, m) => {
      if (input.send === undefined) return { queued: false, code: 'no_campaign_send', detail: 'This head office has no campaign send.' };
      const r = await invoke(input.send, {
        tenantId: t, userId: 'system:journeys', params: { campaignId: m.campaignId }, query: {}, idempotencyKey: m.campaignId,
        body: { purpose: 'marketing', channel: m.channel, templateId: m.templateId, containsPromotion: true, audience: [m.customerRef], values: m.values },
      });
      if ('refused' in r) return { queued: false, code: r.refused.body.code, detail: r.refused.body.whatHappened };
      const b = r.body as { queued?: number; alreadyQueued?: number; excludedByReason?: Record<string, number>; detail?: string };
      if ((b.queued ?? 0) > 0 || (b.alreadyQueued ?? 0) > 0) return { queued: true };
      return { queued: false, code: Object.keys(b.excludedByReason ?? {})[0] ?? 'not_queued', detail: b.detail ?? 'not queued' };
    },
    today: async (t) => dayIn(now(), await input.timeZone(t)),
  };
}

// ── M17-FR-01 · OB-295 · tiers and points expiry ─────────────────────────────────────────────────────────────────────

const PROGRAMME = streamName(STREAM.loyalty, 'programme');
const MEMBERS = streamName(STREAM.loyalty, 'members');

export function loyaltyProgrammeAdapter(input: Base): LoyaltyProgrammeDeps {
  const { store, now } = input;
  const tiers = factList<ProgrammeSetting<readonly LoyaltyTier[]>>(store, PROGRAMME, 'LoyaltyTiersSet');
  const expiry = factList<ProgrammeSetting<number | null>>(store, PROGRAMME, 'LoyaltyPointsExpirySet');
  const customers = customerAdapter(input);
  const c360 = customer360Adapter(input);
  const last = <T>(xs: readonly T[]): T | undefined => xs[xs.length - 1];
  return {
    now,
    tiers: async (t) => last(await tiers.all(t)),
    recordTiers: (t, v) => tiers.append(t, `v${v.version}`, v, v.setAt),
    expiry: async (t) => last(await expiry.all(t)),
    recordExpiry: (t, v) => expiry.append(t, `v${v.version}`, v, v.setAt),
    allMembers: async (t) => (await store.readStream(t, MEMBERS, { type: 'LoyaltyMember' })).map((e) => e.event.payload as MemberRecord),
    // The member's own bills and what came back against them, from the customer facts derived from the banked sales.
    spendBetween: async (t, memberRef, from, to) => {
      await c360.catchUp(t);
      const bought = (await c360.purchasesOf(t, memberRef)).filter((p) => p.at >= from && p.at < to).reduce((n, p) => n + p.grossMinor, 0);
      const back = (await c360.returnsOf(t, memberRef)).filter((r) => r.at >= from && r.at < to).reduce((n, r) => n + r.refundMinor, 0);
      return Math.max(0, bought - back);
    },
    movements: async (t, memberRef) => (await store.readStream(t, streamName(STREAM.loyalty, memberRef), { type: 'PointsMovement' }))
      .map((e) => e.event.payload as RecordedPointsMovement)
      .map((m): LedgerMovement => ({ movementId: m.movementId, delta: m.delta, reason: m.reason, at: m.at, sourceRef: m.sourceRef })),
    pointsVersion: (t, memberRef) => store.guardVersion(t, `points:${memberRef}`),
    recordExpiryMovement: async (t, memberRef, m, version) => customers.recordPointsMovement(t, memberRef, { movementId: m.movementId, customerId: memberRef, delta: m.delta, reason: 'expiry', sourceRef: m.sourceRef, at: m.at }, version),
  };
}

// ── WF-13 · M20-FR-02 · the online basket's offers and points ───────────────────────────────────────────────────────

/** The desk's app ↔ membership links (D-28, r4-online-adapters keeps them on this stream). */
const MEMBER_LINKS = streamName(STREAM.customer, 'digital-receipts', 'member-links');
const ORDER_PRICING = streamName(STREAM.orders, 'online-pricing');

/** The membership an app account is tied to now, if any (and still a member). */
export function appMemberOf(input: Base) {
  return async (tenantId: string, customerRef: string): Promise<{ readonly memberRef: string } | undefined> => {
    const links = (await input.store.readStream(tenantId, MEMBER_LINKS, { type: 'MemberAppLinked' })).map((e) => e.event.payload as MemberAppLink);
    const link = currentMemberLink(links, customerRef);
    if (link === undefined) return undefined;
    const history = (await input.store.readStream(tenantId, MEMBERS, { type: 'LoyaltyMember' })).map((e) => e.event.payload as MemberRecord).filter((m) => m.memberRef === link.memberRef);
    const now = history[history.length - 1];
    return now?.status === 'member' ? { memberRef: link.memberRef } : undefined;
  };
}

export function onlinePricingAdapter(input: Base & { readonly pointValuePaise: (tenantId: string) => Promise<number> }): OnlinePricingDeps {
  const { store, now } = input;
  const coupons = couponAdapter(input);
  const pricing = factList<OrderPricingFact>(store, ORDER_PRICING, 'OnlineOrderPriced');
  return {
    promotions: async (t) => promotionCatalogueAdapter(input).promotions(t),
    carryBagsAmong: async (t, ids) => {
      const wanted = new Set(ids);
      const bags = new Set((await productMasterAdapter({ store, now }).products(t)).filter((p) => wanted.has(p.productId) && p.safety?.carryBag === true).map((p) => p.productId));
      return ids.filter((id) => bags.has(id));
    },
    memberOf: appMemberOf(input),
    pointsOf: async (t, memberRef) => customerAdapter(input).pointsBalance(t, memberRef),
    pointValuePaise: input.pointValuePaise,
    coupon: async (t, code) => coupons.coupon(t, code),
    couponRedemptions: async (t, code) => coupons.redemptions(t, code),
    recordCouponRedemption: async (t, r, key) => { await coupons.recordRedemption(t, r, key); },
    orderPricing: async (t, orderId) => (await pricing.all(t)).filter((f) => f.orderId === orderId)[0],
    recordOrderPricing: (t, f) => pricing.append(t, f.orderId, f, f.at),
  };
}

/** OB-295: a bill earns its tier's multiplier — the one wrap `main.ts` puts round the loyalty effects. */
export function withLoyaltyTiers<D extends LoyaltyEffectsDeps>(effects: D, input: Base): D {
  const programme = loyaltyProgrammeAdapter(input);
  return { ...effects, tierAt: (t: string, memberRef: string, at: string) => tierMultiplierAt(programme, t, memberRef, at) };
}

/**
 * The package's work on the ops worker's timer, for one shop: the points expiry (OB-295; nothing moves while it is off).
 * Answers how many things it did.
 */
export function customerCommerceSweep(input: Base): (tenantId: string, at: string) => Promise<number> {
  return async (tenantId) => {
    const expired = await runPointsExpiry(loyaltyProgrammeAdapter(input), tenantId);
    const runner = RUNNERS.get(input.store);
    const repeat = runner === undefined ? { placed: 0, notPlaced: 0, missed: 0 } : await runSubscriptions(runner.subscriptions, tenantId);
    const told = runner === undefined ? { queued: 0, notQueued: 0 } : await runOrderNotices(runner.notices, tenantId);
    const journeys = runner === undefined ? { queued: 0, notQueued: 0 } : await runJourneys(runner.journeys, tenantId);
    return expired.expired.length + repeat.placed + repeat.notPlaced + repeat.missed + told.queued + told.notQueued + journeys.queued + journeys.notQueued;
  };
}

/** The package on the head-office surface. Called once by `buildSurface`, before the API manifest is taken. */
export function customerCommerceSurface(surface: Route[], input: CustomerCommerceInput): void {
  const { store, now } = input;
  if (store !== undefined) {
    const base = { store, now };
    // M16-FR-04: the record shows the desk's cases; segments count the desk's complaints.
    rebuildInPlace(surface, customer360Routes({ ...customer360Adapter(base), casesOf: casesOfCustomer(base) }), (r) => r.path === '/v1/customers/:customerRef/profile');
    rebuildInPlace(surface, segmentRoutes({
      now, ...segmentDataAdapter(base),
      orderFacts: async (t: string) => { await customer360Adapter(base).catchUp(t); return segmentDataAdapter(base).orderFacts(t); },
      complaintFacts: complaintFactsWithCases(base),
    }), (r) => r.method === 'GET');
    rebuildInPlace(surface, customerOverviewRoutes({ ...customerOverviewAdapter(base), complaintFacts: complaintFactsWithCases(base) }));
  }
  // M17-FR-02 · OB-303: repeat online orders, placed through the storefront's own placement route.
  const timeZone = async (t: string): Promise<string> => (input.timeZone === undefined ? 'Asia/Kolkata' : await input.timeZone(t));
  const subs = store === undefined ? undefined : subscriptionAdapter({
    store, now, timeZone,
    placement: surface.find((r) => r.method === 'POST' && r.path === '/v1/storefront/orders/:orderId'),
    slots: surface.find((r) => r.method === 'GET' && r.path === '/v1/serviceability/delivery-service'),
  });
  // M20-FR-03: order notices through the service-message queue's own enqueue route.
  const notices = store === undefined ? undefined : orderNoticeAdapter({ store, now, queue: surface.find((r) => r.method === 'POST' && r.path === '/v1/notifications/queue/:id') });
  // M21-FR-02: journeys from facts, sent through the campaign send's own route.
  const journeys = store === undefined ? undefined : journeyAdapter({
    store, now, timeZone,
    quote: surface.find((r) => r.method === 'POST' && r.path === '/v1/storefront/cart/quote'),
    send: surface.find((r) => r.method === 'POST' && r.path === '/v1/service/campaigns/:campaignId/send'),
  });
  if (store !== undefined && subs !== undefined && notices !== undefined && journeys !== undefined) RUNNERS.set(store, { subscriptions: subs, notices, journeys });
  surface.push(...journeyRoutes(journeys ?? {
    now, carts: async () => [], recordCart: async () => {}, valueOf: async () => 0, occasions: async () => [], recordOccasion: async () => {}, purchases: async () => [],
    lapsingAfterDays: async () => 60, switches: async () => [], recordSwitch: async () => {}, outcomes: async () => [], recordOutcome: async () => {},
    send: async () => ({ queued: false, code: 'no_store', detail: 'no store' }), today: async () => dayIn(now(), 'Asia/Kolkata'),
  }));
  surface.push(...orderNoticeRoutes(notices ?? { now, onlineOrders: async () => [], facts: async () => undefined, enqueue: async () => ({ queued: false, code: 'no_store', detail: 'no store' }), notices: async () => [], recordNotice: async () => {} }));
  surface.push(...subscriptionRoutes(subs ?? {
    plans: async () => [], recordPlan: async () => {}, changes: async () => [], recordChange: async () => {}, occurrences: async () => [], recordOccurrence: async () => {},
    placeOrder: async () => ({ placed: false, why: 'no store' }), today: async () => dayIn(now(), 'Asia/Kolkata'), now,
  }));
  // M20-FR-04 · M20-FR-02 · A05: the customer's own addresses, suggestions and help.
  surface.push(...storefrontAccountRoutes(store === undefined ? {
    now, addresses: async () => [], recordAddress: async () => {}, consentRecords: async () => [], alsoBought: async () => [], boughtBefore: async () => [], sellable: async () => false,
    orderOwner: async () => undefined, a05OrderAnswer: async () => ({ answered: false, agentActive: false, text: '' }), returnPolicyWords: async () => 'not set', deliveryWords: async () => 'not set',
  } : storefrontAccountAdapter({
    store, now,
    a05: surface.find((r) => r.method === 'POST' && r.path === '/v1/ai/service/answers'),
    returnPolicy: surface.find((r) => r.method === 'GET' && r.path === '/v1/me/return-policy'),
  })));
  // M17-FR-01 · OB-295: the programme's two owner settings, a member's standing, and the expiry run.
  surface.push(...loyaltyProgrammeRoutes(store === undefined ? unwiredProgramme(now) : loyaltyProgrammeAdapter({ store, now })));
}
