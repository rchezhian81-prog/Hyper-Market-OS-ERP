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
import { subscriptionRoutes, runSubscriptions, type SubscriptionDeps, type SubscriptionOccurrence, type PlaceAttempt } from '../../orders/src/storefront-subscriptions';
import type { SubscriptionPlan, SubscriptionChange } from '../../../packages/storefront/src/subscriptions';
import { customer360Routes, complaintFactsOf, type ServiceCaseFact } from '../../customer/src/customer-360';
import { segmentRoutes } from '../../customer/src/segments';
import type { ComplaintFact } from '../../../packages/customer/src/index';
import { customer360Adapter, segmentDataAdapter, serviceCaseAdapter, customerAdapter, couponAdapter, promotionCatalogueAdapter, productMasterAdapter, STREAM, streamName } from './adapters';
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
const RUNNERS = new WeakMap<EventStore, { readonly subscriptions: SubscriptionDeps }>();

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
  return async (tenantId: string, customerRef: string): Promise<{ readonly memberRef: string; readonly mobileLast4?: string } | undefined> => {
    const links = (await input.store.readStream(tenantId, MEMBER_LINKS, { type: 'MemberAppLinked' })).map((e) => e.event.payload as MemberAppLink);
    const link = currentMemberLink(links, customerRef);
    if (link === undefined) return undefined;
    const history = (await input.store.readStream(tenantId, MEMBERS, { type: 'LoyaltyMember' })).map((e) => e.event.payload as MemberRecord).filter((m) => m.memberRef === link.memberRef);
    const now = history[history.length - 1];
    return now?.status === 'member' ? { memberRef: link.memberRef, mobileLast4: now.mobileLast4 } : undefined;
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
    return expired.expired.length + repeat.placed + repeat.notPlaced + repeat.missed;
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
  if (store !== undefined && subs !== undefined) RUNNERS.set(store, { subscriptions: subs });
  surface.push(...subscriptionRoutes(subs ?? {
    plans: async () => [], recordPlan: async () => {}, changes: async () => [], recordChange: async () => {}, occurrences: async () => [], recordOccurrence: async () => {},
    placeOrder: async () => ({ placed: false, why: 'no store' }), today: async () => dayIn(now(), 'Asia/Kolkata'), now,
  }));
  // M17-FR-01 · OB-295: the programme's two owner settings, a member's standing, and the expiry run.
  surface.push(...loyaltyProgrammeRoutes(store === undefined ? unwiredProgramme(now) : loyaltyProgrammeAdapter({ store, now })));
}
