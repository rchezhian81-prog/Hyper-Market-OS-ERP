// Serviceability, slots, checkout and the privacy centre (M20-FR-03 / M20-FR-04 / D08).
//
// This is where a browsing session becomes a promise, and a promise the shop cannot keep
// is worse than a refused order. Four refusals, each one a promise not made:
//
//   • **OUT OF AREA IS REFUSED CLEARLY, AT THE START.** The serviceable radius is
//     per-tenant (D08 defaults to 10 km) and the customer is told the distance and the
//     limit — not "something went wrong at checkout" after they have filled a basket.
//   • **A FULL SLOT IS NOT SOLD TWICE.** Capacity is checked at booking, and when a slot
//     is full the alternatives are offered rather than an error.
//   • **FEES AND MINIMUMS ARE SHOWN BEFORE PAYMENT, NEVER AFTER.** A delivery fee that
//     appears on the confirmation screen is the single most common reason a grocery
//     basket is abandoned, and it is entirely self-inflicted.
//   • **AN UNCERTAIN PAYMENT DOES NOT CONFIRM AN ORDER** (§4.3, and the same rule the
//     till obeys in `packages/tender`). If the provider does not answer, the order is
//     *pending*, the customer is told the truth, and nothing is picked or dispatched
//     against money that may not exist.
//
// **No card data, ever** (hard rule #3): the checkout handles a provider token and
// refuses anything that looks like a card number, exactly as reconciliation does.
//
// The privacy centre (M20-FR-04) is the customer-facing half of M16-FR-03: it must be
// able to *show* what is held, *change* consent immediately, and *raise* an erasure —
// and a consent switched off has to take effect on the next send, not on the next batch.
//
// Pure and deterministic: the clock is injected, nothing here talks to a provider.

export interface ServiceabilityPolicy {
  /** Serviceable radius in metres. Default 10 km (D08). */
  readonly radiusMetres?: number;
  /** Minimum order value below which delivery is refused or charged. */
  readonly minimumOrderMinor?: number;
  /** Delivery fee below the free-delivery threshold. */
  readonly deliveryFeeMinor?: number;
  readonly freeDeliveryAboveMinor?: number;
}

export type ServiceabilityOutcome = 'serviceable' | 'out_of_area' | 'below_minimum';

export interface ServiceabilityResult {
  readonly outcome: ServiceabilityOutcome;
  readonly serviceable: boolean;
  readonly distanceMetres: number;
  readonly deliveryFeeMinor: number;
  readonly minimumOrderMinor: number;
  /** Shown to the customer before they fill a basket, not after. */
  readonly detail: string;
}

/**
 * Great-circle distance in whole metres. Integer output on purpose: a distance carried
 * as a float and compared against a limit is a boundary nobody can reason about.
 */
export function distanceMetres(
  a: { readonly lat: number; readonly lon: number },
  b: { readonly lat: number; readonly lon: number },
): number {
  const R = 6_371_000;
  const toRad = (d: number): number => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.min(1, Math.sqrt(h))));
}

/** Decide serviceability **before** the basket is filled, and state the fee up front. */
export function checkServiceability(input: {
  readonly storeLocation: { readonly lat: number; readonly lon: number };
  readonly deliveryLocation: { readonly lat: number; readonly lon: number };
  readonly basketMinor: number;
  readonly policy?: ServiceabilityPolicy;
}): ServiceabilityResult {
  const radius = input.policy?.radiusMetres ?? 10_000;
  const minimum = input.policy?.minimumOrderMinor ?? 0;
  const fee = input.policy?.deliveryFeeMinor ?? 0;
  const freeAbove = input.policy?.freeDeliveryAboveMinor;
  const metres = distanceMetres(input.storeLocation, input.deliveryLocation);
  const chargedFee = freeAbove !== undefined && input.basketMinor >= freeAbove ? 0 : fee;

  if (metres > radius) {
    return {
      outcome: 'out_of_area',
      serviceable: false,
      distanceMetres: metres,
      deliveryFeeMinor: 0,
      minimumOrderMinor: minimum,
      detail: `we deliver up to ${Math.round(radius / 1000)} km and this address is ${(metres / 1000).toFixed(1)} km away — you can still collect from the store`,
    };
  }
  if (input.basketMinor < minimum) {
    return {
      outcome: 'below_minimum',
      serviceable: false,
      distanceMetres: metres,
      deliveryFeeMinor: chargedFee,
      minimumOrderMinor: minimum,
      detail: `the minimum order for delivery is ${minimum}; this basket is ${input.basketMinor}`,
    };
  }

  return {
    outcome: 'serviceable',
    serviceable: true,
    distanceMetres: metres,
    deliveryFeeMinor: chargedFee,
    minimumOrderMinor: minimum,
    detail:
      chargedFee === 0
        ? `free delivery, ${(metres / 1000).toFixed(1)} km`
        : `delivery ${chargedFee}, ${(metres / 1000).toFixed(1)} km${freeAbove === undefined ? '' : ` (free above ${freeAbove})`}`,
  };
}

export interface Slot {
  readonly slotId: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly capacity: number;
  readonly booked: number;
  readonly kind: 'delivery' | 'pickup';
}

export interface SlotOffer {
  readonly slotId: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly kind: Slot['kind'];
  readonly remaining: number;
}

/** Slots a customer can actually have: in the future, with room, soonest first. */
export function availableSlots(input: {
  readonly slots: readonly Slot[];
  readonly now: string;
  /** Minimum notice in minutes before a slot can be taken. Default 60. */
  readonly leadMinutes?: number;
}): readonly SlotOffer[] {
  const lead = (input.leadMinutes ?? 60) * 60_000;
  const earliest = Date.parse(input.now) + lead;
  return input.slots
    .filter((s) => Date.parse(s.startsAt) >= earliest && s.booked < s.capacity)
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
    .map((s) => ({
      slotId: s.slotId,
      startsAt: s.startsAt,
      endsAt: s.endsAt,
      kind: s.kind,
      remaining: s.capacity - s.booked,
    }));
}

export type SlotBookingOutcome = 'booked' | 'slot_full' | 'too_soon' | 'unknown_slot';

export interface SlotBookingResult {
  readonly slotId: string;
  readonly booked: boolean;
  readonly outcome: SlotBookingOutcome;
  readonly detail: string;
  /** When the chosen slot cannot be had, what else is available. Never a bare error. */
  readonly alternatives: readonly SlotOffer[];
}

/** Book a slot, or refuse it and **offer the alternatives** rather than an error. */
export function bookSlot(input: {
  readonly slotId: string;
  readonly slots: readonly Slot[];
  readonly now: string;
  readonly leadMinutes?: number;
}): SlotBookingResult {
  const alternatives = availableSlots({ slots: input.slots, now: input.now, leadMinutes: input.leadMinutes });
  const slot = input.slots.find((s) => s.slotId === input.slotId);
  const base = { slotId: input.slotId, alternatives };

  if (slot === undefined) {
    return { ...base, booked: false, outcome: 'unknown_slot', detail: 'that slot does not exist' };
  }
  if (slot.booked >= slot.capacity) {
    return {
      ...base,
      booked: false,
      outcome: 'slot_full',
      detail: `that slot is full — ${alternatives.length} other slot(s) are available`,
      alternatives: alternatives.filter((a) => a.slotId !== slot.slotId),
    };
  }
  const lead = (input.leadMinutes ?? 60) * 60_000;
  if (Date.parse(slot.startsAt) < Date.parse(input.now) + lead) {
    return {
      ...base,
      booked: false,
      outcome: 'too_soon',
      detail: `we need at least ${input.leadMinutes ?? 60} minutes to pick an order`,
      alternatives: alternatives.filter((a) => a.slotId !== slot.slotId),
    };
  }

  return { ...base, booked: true, outcome: 'booked', detail: `booked for ${slot.startsAt}`, alternatives: [] };
}

export class CardDataError extends Error {
  constructor() {
    super('A checkout payment reference must be a provider token, never a card number (hard rule #3).');
    this.name = 'CardDataError';
  }
}

const PAN_LIKE = /^\d{13,19}$/;

export type PaymentAnswer =
  | { readonly result: 'authorised'; readonly providerRef: string }
  | { readonly result: 'declined'; readonly reason: string }
  /** The provider did not answer. Expected, and never treated as success. */
  | { readonly result: 'unknown'; readonly reason: string };

export type OrderState = 'confirmed' | 'payment_pending' | 'refused';

export interface PlacedOrder {
  readonly orderId: string;
  readonly state: OrderState;
  readonly customerRef: string;
  readonly slotId: string;
  readonly itemsMinor: number;
  readonly deliveryFeeMinor: number;
  readonly payableMinor: number;
  readonly providerRef?: string;
  readonly detail: string;
  /** The true sentence for the customer's screen. */
  readonly tellTheCustomer: string;
  /** True only when the order may be picked and dispatched. */
  readonly releaseForPicking: boolean;
}

/**
 * Place an order.
 *
 * The important branch is `unknown`: the order becomes **`payment_pending`**, nothing is
 * picked, and the customer is told plainly that we are waiting on the bank. Confirming an
 * order against a payment that may not exist means the shop picks, packs and delivers
 * goods it was never paid for — and finds out at settlement.
 */
export function placeOrder(input: {
  readonly orderId: string;
  readonly customerRef: string;
  readonly slotId: string;
  readonly itemsMinor: number;
  readonly deliveryFeeMinor: number;
  readonly serviceability: ServiceabilityResult;
  readonly payment: PaymentAnswer;
}): PlacedOrder {
  const payableMinor = input.itemsMinor + input.deliveryFeeMinor;
  const base = {
    orderId: input.orderId,
    customerRef: input.customerRef,
    slotId: input.slotId,
    itemsMinor: input.itemsMinor,
    deliveryFeeMinor: input.deliveryFeeMinor,
    payableMinor,
  };

  if (!input.serviceability.serviceable) {
    return {
      ...base,
      state: 'refused',
      releaseForPicking: false,
      detail: input.serviceability.detail,
      tellTheCustomer: input.serviceability.detail,
    };
  }

  if (input.payment.result === 'authorised') {
    if (PAN_LIKE.test(input.payment.providerRef.replace(/[\s-]/g, ''))) {
      throw new CardDataError();
    }
    return {
      ...base,
      state: 'confirmed',
      providerRef: input.payment.providerRef,
      releaseForPicking: true,
      detail: `paid ${payableMinor} against token ${input.payment.providerRef}`,
      tellTheCustomer: 'Your order is confirmed and we will pick it for your chosen slot.',
    };
  }

  if (input.payment.result === 'declined') {
    return {
      ...base,
      state: 'refused',
      releaseForPicking: false,
      detail: `payment declined: ${input.payment.reason}`,
      tellTheCustomer: 'Your bank did not accept the payment, so we have not placed the order. Nothing has been charged.',
    };
  }

  return {
    ...base,
    state: 'payment_pending',
    releaseForPicking: false,
    detail: `payment outcome unknown (${input.payment.reason}) — the order is NOT confirmed and nothing will be picked`,
    tellTheCustomer:
      'We are waiting for your bank to confirm the payment. Your order is not placed yet and we will not pick it until we know. We will message you either way — please do not pay again.',
  };
}

export type TrackingStage = 'placed' | 'picking' | 'packed' | 'out_for_delivery' | 'delivered' | 'cancelled';

export interface TrackingView {
  readonly orderId: string;
  readonly stage: TrackingStage;
  readonly detail: string;
  readonly asOfMinutesAgo: number;
  /** True when the tracking data is old enough that it may be wrong (P-08). */
  readonly stale: boolean;
}

/** Order tracking, with its age stated — a cached "out for delivery" can be an hour old. */
export function trackOrder(input: {
  readonly orderId: string;
  readonly stage: TrackingStage;
  readonly asOfMinutesAgo: number;
  readonly staleAfterMinutes?: number;
}): TrackingView {
  const stale = input.asOfMinutesAgo > (input.staleAfterMinutes ?? 15);
  const words: Record<TrackingStage, string> = {
    placed: 'We have your order',
    picking: 'We are picking your order now',
    packed: 'Your order is packed and waiting for the driver',
    out_for_delivery: 'Your order is on its way',
    delivered: 'Delivered',
    cancelled: 'This order was cancelled',
  };
  return {
    orderId: input.orderId,
    stage: input.stage,
    asOfMinutesAgo: input.asOfMinutesAgo,
    stale,
    detail: stale
      ? `${words[input.stage]} — last updated ${input.asOfMinutesAgo} minutes ago, so this may have moved on`
      : words[input.stage],
  };
}

// --- privacy centre and account controls (M20-FR-04) -------------------------------

export type ConsentPurpose = 'marketing' | 'profiling' | 'service';

export interface PrivacyCentreView {
  readonly customerRef: string;
  /** What the shop holds, by category, in plain words. */
  readonly held: readonly { readonly category: string; readonly summary: string }[];
  readonly consents: readonly { readonly purpose: ConsentPurpose; readonly granted: boolean }[];
  readonly canRequest: readonly ('access' | 'correction' | 'export' | 'erasure')[];
  readonly detail: string;
}

/**
 * The customer's own view of what is held about them — the front half of M16-FR-03.
 *
 * It lists **every** category, including the ones that cannot be erased, because a
 * privacy centre that shows only the convenient data is worse than none: it tells the
 * customer a comforting and untrue story about how much the shop knows.
 */
export function privacyCentre(input: {
  readonly customerRef: string;
  readonly categories: readonly { readonly category: string; readonly recordCount: number; readonly retained?: boolean }[];
  readonly consents: readonly ConsentPurpose[];
}): PrivacyCentreView {
  return {
    customerRef: input.customerRef,
    held: input.categories.map((c) => ({
      category: c.category,
      summary:
        c.retained === true
          ? `${c.recordCount} record(s) — kept because the law requires it, and shown here so you know it exists`
          : `${c.recordCount} record(s)`,
    })),
    consents: (['marketing', 'profiling', 'service'] as const).map((purpose) => ({
      purpose,
      granted: input.consents.includes(purpose),
    })),
    canRequest: ['access', 'correction', 'export', 'erasure'],
    detail: `${input.categories.reduce((s, c) => s + c.recordCount, 0)} record(s) across ${input.categories.length} categor(y/ies)`,
  };
}

export interface ConsentChangeResult {
  readonly customerRef: string;
  readonly purpose: ConsentPurpose;
  readonly granted: boolean;
  readonly effectiveAt: string;
  /** Always true: a withdrawal applies to the very next send, not the next batch. */
  readonly effectiveImmediately: true;
  readonly detail: string;
}

/**
 * Change a consent from the app. **It takes effect immediately** — the returned
 * `effectiveAt` is the moment of the change, not the start of the next campaign run.
 *
 * "It will apply from tomorrow's batch" is how a customer who has just switched
 * marketing off receives one more message, which is precisely the message that makes
 * them complain to a regulator rather than to the shop.
 */
export function changeConsent(input: {
  readonly customerRef: string;
  readonly purpose: ConsentPurpose;
  readonly granted: boolean;
  readonly at: string;
}): ConsentChangeResult {
  return {
    customerRef: input.customerRef,
    purpose: input.purpose,
    granted: input.granted,
    effectiveAt: input.at,
    effectiveImmediately: true,
    detail: input.granted
      ? `${input.purpose} switched on at ${input.at}`
      : `${input.purpose} switched off at ${input.at} — this applies to the very next message, not to the next batch`,
  };
}
