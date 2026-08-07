// Pickup, scheduled/express delivery and dark-store routing (M18-FR-03 / D08 / D09).
//
// One order can be satisfied from several places, and choosing badly is expensive in a
// way nobody notices until the month end. So the routing decision is made **explicitly,
// with the reason recorded**, rather than defaulting to "the nearest shop" — which is
// the rule that quietly sends a ₹200 order on a 9 km round trip.
//
// Three things the router refuses to pretend:
//
//   • **CAPACITY IS REAL.** A slot with eight vans is a slot with eight vans. Promising a
//     ninth is not optimism, it is a customer waiting in for a delivery that was never
//     going to come, and they find out at the end of the window.
//   • **EXPRESS IS A DIFFERENT PROMISE.** It needs stock **at that location now**, not
//     "in the chain somewhere". An express order routed to a dark store that has to
//     receive the stock first is a scheduled order with an express price on it.
//   • **AN UNPROFITABLE STOP IS FLAGGED, NOT BLOCKED** (D09). The shop may well want the
//     customer; what it must not do is take the order believing it made money. The rule
//     is per-tenant, the flag is plain English, and the decision stays with a person.
//
// Contribution is computed in **exact integer minor units** (§29.1) — a delivery margin
// carried as a float and compared against a threshold is a boundary nobody can reason
// about.
//
// Pure and deterministic: locations, capacity and stock are supplied; no clock, no I/O.

export type FulfilmentMethod = 'pickup' | 'scheduled_delivery' | 'express_delivery';

export type LocationKind = 'store' | 'dark_store' | 'partner';

export interface FulfilmentLocation {
  readonly locationId: string;
  readonly kind: LocationKind;
  readonly lat: number;
  readonly lon: number;
  /** A dark store has no shop floor, so it can never serve a pickup order. */
  readonly acceptsPickup: boolean;
  readonly acceptsDelivery: boolean;
  /** Serviceable radius for delivery from here, in metres. Per-tenant. */
  readonly deliveryRadiusMetres: number;
  /** Minutes from order to doorstep this location can actually achieve. */
  readonly expressMinutes?: number;
}

export interface LocationStock {
  readonly locationId: string;
  readonly productId: string;
  readonly availableMinor: number;
}

export interface SlotCapacity {
  readonly slotId: string;
  readonly locationId: string;
  readonly method: FulfilmentMethod;
  readonly capacity: number;
  readonly booked: number;
}

export type RouteOutcome =
  | 'routed'
  | 'no_location_in_range'
  | 'no_location_with_stock'
  | 'slot_full'
  | 'pickup_not_available_here'
  | 'express_not_achievable';

export interface RouteResult {
  readonly orderId: string;
  readonly routed: boolean;
  readonly outcome: RouteOutcome;
  readonly locationId?: string;
  readonly method: FulfilmentMethod;
  readonly distanceMetres?: number;
  /** Why this location and not another — recorded, not inferred later. */
  readonly detail: string;
  /** Alternatives when the chosen route fails, so the customer is never left with an error. */
  readonly alternatives: readonly { readonly locationId: string; readonly detail: string }[];
}

/** Great-circle distance in whole metres — integer, so a boundary is a boundary. */
export function metresBetween(
  a: { readonly lat: number; readonly lon: number },
  b: { readonly lat: number; readonly lon: number },
): number {
  const R = 6_371_000;
  const rad = (d: number): number => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.min(1, Math.sqrt(h))));
}

/**
 * Route an order to the location that will actually fulfil it.
 *
 * Order of checks matters and is deliberate: **can this place serve this method → is it
 * in range → does it have the stock now → is there room in the slot.** Reversing any pair
 * produces a route that looks valid and fails later, which is the expensive kind.
 */
export function routeOrder(input: {
  readonly orderId: string;
  readonly method: FulfilmentMethod;
  readonly deliverTo?: { readonly lat: number; readonly lon: number };
  readonly lines: readonly { readonly productId: string; readonly quantityMinor: number }[];
  readonly locations: readonly FulfilmentLocation[];
  readonly stock: readonly LocationStock[];
  readonly slots: readonly SlotCapacity[];
  /** Express promise the customer was shown, in minutes. */
  readonly expressPromiseMinutes?: number;
}): RouteResult {
  const base = { orderId: input.orderId, method: input.method, alternatives: [] as { locationId: string; detail: string }[] };

  const canServe = input.locations.filter((l) =>
    input.method === 'pickup' ? l.acceptsPickup : l.acceptsDelivery,
  );
  if (canServe.length === 0) {
    return {
      ...base,
      routed: false,
      outcome: input.method === 'pickup' ? 'pickup_not_available_here' : 'no_location_in_range',
      detail:
        input.method === 'pickup'
          ? 'no location here serves pickup — a dark store has no shop floor for a customer to walk into'
          : 'no location offers delivery',
    };
  }

  const inRange =
    input.method === 'pickup' || input.deliverTo === undefined
      ? canServe.map((l) => ({ location: l, metres: 0 }))
      : canServe
          .map((l) => ({ location: l, metres: metresBetween(l, input.deliverTo!) }))
          .filter((x) => x.metres <= x.location.deliveryRadiusMetres);

  if (inRange.length === 0) {
    const nearest = canServe
      .map((l) => ({ l, m: metresBetween(l, input.deliverTo!) }))
      .sort((a, b) => a.m - b.m)[0];
    return {
      ...base,
      routed: false,
      outcome: 'no_location_in_range',
      detail: `the nearest location that delivers is ${((nearest?.m ?? 0) / 1000).toFixed(1)} km away and its radius is ${((nearest?.l.deliveryRadiusMetres ?? 0) / 1000).toFixed(1)} km`,
    };
  }

  // Stock must be at the location NOW. "In the chain somewhere" is a scheduled order.
  const stocked = inRange.filter(({ location }) =>
    input.lines.every((line) => {
      const held = input.stock.find(
        (s) => s.locationId === location.locationId && s.productId === line.productId,
      );
      return (held?.availableMinor ?? 0) >= line.quantityMinor;
    }),
  );
  if (stocked.length === 0) {
    return {
      ...base,
      routed: false,
      outcome: 'no_location_with_stock',
      detail: 'no location in range holds the whole order — splitting it is a decision, not a default',
      alternatives: inRange.map(({ location }) => ({
        locationId: location.locationId,
        detail: 'in range, but does not hold every line',
      })),
    };
  }

  if (input.method === 'express_delivery' && input.expressPromiseMinutes !== undefined) {
    const achievable = stocked.filter(
      ({ location }) => (location.expressMinutes ?? Number.POSITIVE_INFINITY) <= input.expressPromiseMinutes!,
    );
    if (achievable.length === 0) {
      return {
        ...base,
        routed: false,
        outcome: 'express_not_achievable',
        detail: `no location in range can do this in ${input.expressPromiseMinutes} minutes — an express price on a scheduled delivery is a promise the shop will break`,
        alternatives: stocked.map(({ location }) => ({
          locationId: location.locationId,
          detail: `can deliver in ${location.expressMinutes ?? 'an unknown number of'} minutes — offer this as scheduled instead`,
        })),
      };
    }
    return routeToNearestWithCapacity(input, achievable);
  }

  return routeToNearestWithCapacity(input, stocked);
}

/** Nearest first, then capacity. Capacity is real: a ninth van does not exist. */
function routeToNearestWithCapacity(
  input: Parameters<typeof routeOrder>[0],
  candidates: readonly { readonly location: FulfilmentLocation; readonly metres: number }[],
): RouteResult {
  const base = { orderId: input.orderId, method: input.method };
  const ordered = [...candidates].sort((a, b) => a.metres - b.metres);
  for (const { location, metres } of ordered) {
    const slot = input.slots.find(
      (s) => s.locationId === location.locationId && s.method === input.method,
    );
    if (slot !== undefined && slot.booked >= slot.capacity) continue;

    return {
      orderId: input.orderId,
      routed: true,
      outcome: 'routed',
      locationId: location.locationId,
      method: input.method,
      distanceMetres: metres,
      alternatives: [],
      detail:
        input.method === 'pickup'
          ? `${location.locationId} (${location.kind}) — customer collects`
          : `${location.locationId} (${location.kind}), ${(metres / 1000).toFixed(1)} km, nearest with the whole order in stock and room in the slot`,
    };
  }

  return {
    ...base,
    routed: false,
    outcome: 'slot_full',
    detail: 'every location that could fulfil this order is fully booked for that method',
    alternatives: ordered.map(({ location }) => ({
      locationId: location.locationId,
      detail: 'has the stock but no capacity in that slot — offer another slot',
    })),
  };
}

export interface ContributionInput {
  readonly orderId: string;
  readonly itemsMarginMinor: number;
  readonly deliveryFeeChargedMinor: number;
  /** What the drop actually costs: driver time, fuel, packing. */
  readonly deliveryCostMinor: number;
  readonly distanceMetres: number;
  /** Per-tenant: the share of order value delivery may consume before it is flagged. */
  readonly costCeilingBps?: number;
  readonly orderValueMinor: number;
}

export interface ContributionResult {
  readonly orderId: string;
  readonly contributionMinor: number;
  readonly deliveryCostBps: number | 'not_meaningful';
  /** True when the drop is worth doing on its own numbers. */
  readonly profitable: boolean;
  /** True when it breaches the tenant's ceiling. Flagged, never blocked (D09). */
  readonly flagged: boolean;
  readonly detail: string;
}

/**
 * What the shop actually makes on a drop.
 *
 * **Flagged, never blocked.** The shop may well want a customer it loses money on this
 * week; what it must not do is take the order believing it made money. So the number is
 * stated in plain English and the decision stays with a person (D09).
 */
export function assessContribution(input: ContributionInput): ContributionResult {
  const contributionMinor =
    input.itemsMarginMinor + input.deliveryFeeChargedMinor - input.deliveryCostMinor;
  const deliveryCostBps =
    input.orderValueMinor === 0
      ? ('not_meaningful' as const)
      : Number((BigInt(input.deliveryCostMinor) * 10_000n) / BigInt(input.orderValueMinor));
  const ceiling = input.costCeilingBps ?? 1_000; // 10% of order value
  const flagged = deliveryCostBps !== 'not_meaningful' && deliveryCostBps > ceiling;

  return {
    orderId: input.orderId,
    contributionMinor,
    deliveryCostBps,
    profitable: contributionMinor > 0,
    flagged,
    detail:
      contributionMinor <= 0
        ? `this drop loses ${-contributionMinor} — ${input.deliveryCostMinor} of delivery cost against ${input.itemsMarginMinor + input.deliveryFeeChargedMinor} of margin and fee. Take it if you want the customer, but take it knowingly`
        : flagged
          ? `delivery is ${((deliveryCostBps as number) / 100).toFixed(1)}% of order value (limit ${(ceiling / 100).toFixed(1)}%) — it still contributes ${contributionMinor}, but this pattern does not scale`
          : `contributes ${contributionMinor} at ${(((deliveryCostBps as number) || 0) / 100).toFixed(1)}% delivery cost`,
  };
}
