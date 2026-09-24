// A dry run of the whole delivery decision, over made-up data — M18-FR-01/FR-03, D08, D09.
//
// The store cannot rehearse deliveries against live maps or the owner's final numbers before the
// pilot, and "we'll find out when the first real order comes in" is exactly the moment nobody wants
// a surprise. So this replays the ENTIRE decision a real order goes through — is this address in the
// delivery area on this date, what does delivery cost, and which shop or dark store actually fills it
// with the stock it has and a slot that is free — against synthetic addresses, baskets and slots, and
// prints a report a person can read.
//
// ── It composes; it decides nothing of its own ──────────────────────────────
//
// Every judgement here is made by code already tested elsewhere, called in the order a real order
// meets it. Duplicating any of it would be a second source of truth that drifts:
//
//   • `resolveServiceabilityPolicy` (storefront) — the policy in force ON THE ORDER'S DATE, from the
//     same per-tenant effective-dated schedule the owner configures on the live API. Before he has
//     configured anything, the D08 default (10 km) applies, so a dry run runs from day one.
//   • `checkServiceability` (storefront) — is this one address, for this one basket, inside the area
//     and above the minimum, and what is the fee. Stated before a basket is filled, never after.
//   • `routeOrder` (orders) — which location fills it: capacity is real, express needs stock HERE
//     AND NOW, and an out-of-range or unstocked order is refused by name, not routed and dropped.
//
// ── What it refuses to pretend ──────────────────────────────────────────────
//
//   • **Distances are straight-line.** Same as `planDispatch`: no roads, no traffic. Carried in the
//     result as `distancesAre` so no report can quietly present it as a driving distance.
//   • **A serviceable address that no location can fill is a CONFIG INCONSISTENCY, not a route.** If
//     the store says "yes, we deliver there" but every location is out of range, out of stock or full,
//     that is the owner's serviceable radius and his locations disagreeing — surfaced as a flag for a
//     person, because it is precisely the gap that sells an order the shop cannot keep (P-08).
//   • **A correct refusal is not a flag.** An out-of-area or below-minimum address is the system
//     working; it is counted, not flagged. Only surprises — unfillable orders — raise a flag.
//
// Pure and deterministic: no clock, no I/O, no card data. The same fixtures always produce the same
// report, because a rehearsal you cannot reproduce tells you nothing.

import { resolveServiceabilityPolicy } from '../../storefront/src/serviceability-schedule';
import type { ServiceabilityPeriod, ServiceabilitySource } from '../../storefront/src/serviceability-schedule';
import { checkServiceability } from '../../storefront/src/checkout';
import type { ServiceabilityResult } from '../../storefront/src/checkout';
import { routeOrder } from '../../orders/src/fulfilment-plan';
import type {
  RouteResult,
  FulfilmentLocation,
  LocationStock,
  SlotCapacity,
  FulfilmentMethod,
} from '../../orders/src/fulfilment-plan';

/** One made-up order to put through the whole decision. */
export interface SimScenario {
  readonly scenarioId: string;
  /** The date the order is placed (YYYY-MM-DD). Selects the serviceability policy in force that day. */
  readonly on: string;
  readonly method: FulfilmentMethod;
  /** Where it goes. Required for a delivery; ignored for pickup (the customer collects). */
  readonly deliveryLocation?: { readonly lat: number; readonly lon: number };
  readonly basketMinor: number;
  readonly lines: readonly { readonly productId: string; readonly quantityMinor: number }[];
  /** The express promise the customer was shown, in minutes. Only meaningful for express delivery. */
  readonly expressPromiseMinutes?: number;
}

/** The world the dry run runs against — all synthetic, all per-tenant. */
export interface SimFixtures {
  /** The store the customer-facing serviceable radius is measured from (D08). */
  readonly storeLocation: { readonly lat: number; readonly lon: number };
  /** The effective-dated serviceability schedule — the same shape the owner configures on the API. */
  readonly schedule: readonly ServiceabilityPeriod[];
  readonly locations: readonly FulfilmentLocation[];
  readonly stock: readonly LocationStock[];
  readonly slots: readonly SlotCapacity[];
}

export type SimVerdict =
  /** A delivery the store serves AND a location can fill. */
  | 'deliverable'
  /** A pickup a location can fulfil. */
  | 'pickup_ready'
  /** Correctly refused: outside the serviceable radius on that date. */
  | 'out_of_area'
  /** Correctly refused: the basket is below the minimum for delivery. */
  | 'below_minimum'
  /** Serviceable (or a pickup) but NO location can fill it — a surprise, always flagged. */
  | 'unroutable';

export interface SimLine {
  readonly scenarioId: string;
  readonly on: string;
  readonly method: FulfilmentMethod;
  /** `scheduled` when a configured period applied on that date, `default` when the D08 default did. */
  readonly policySource: ServiceabilitySource;
  readonly policyEffectiveFrom: string | null;
  /** The store-level serviceability answer. Absent for pickup, which has no delivery address gate. */
  readonly serviceability?: ServiceabilityResult;
  /** The routing answer. Absent when the order was refused before routing was even attempted. */
  readonly route?: RouteResult;
  readonly verdict: SimVerdict;
  /** The fee that would actually be charged — non-zero only on a deliverable order. */
  readonly deliveryFeeMinor: number;
  /** The plain, true sentence for the customer's screen. */
  readonly tellTheCustomer: string;
}

export interface SimTotals {
  readonly scenarios: number;
  readonly deliverable: number;
  readonly pickupReady: number;
  readonly outOfArea: number;
  readonly belowMinimum: number;
  readonly unroutable: number;
  /** Sum of the fees that would be charged across the deliverable orders. */
  readonly totalDeliveryFeeMinor: number;
}

export interface SimReport {
  /** A caller-supplied label for what this run represents. NOT a clock — determinism first. */
  readonly runLabel: string;
  readonly lines: readonly SimLine[];
  readonly totals: SimTotals;
  /** Orders the store said it could take but no location can fill — each needs a person (P-08). */
  readonly flags: readonly { readonly scenarioId: string; readonly detail: string }[];
  /** Straight-line, always. Carried in the result so no screen can present it as a road distance. */
  readonly distancesAre: 'straight_line';
}

/**
 * Rehearse serviceability and routing for a batch of synthetic orders.
 *
 * Each scenario is put through the same three decisions a real order meets — policy in force on the
 * date, store-level serviceability, then routing — and turned into one readable line plus a running
 * total. A serviceable order no location can fill, and an unfulfillable pickup, are flagged for a
 * person; a correct refusal is counted, not flagged.
 *
 * @throws InvalidServiceabilitySchedule (from `resolveServiceabilityPolicy`) if a fixture's schedule
 *   or a scenario date is malformed — a broken config is surfaced, never silently defaulted. The live
 *   config route (S2) already refuses a malformed policy at write time, so a schedule read back from
 *   the store is well-formed by the time it reaches here.
 */
export function simulateServiceabilityAndRouting(input: {
  readonly runLabel: string;
  readonly scenarios: readonly SimScenario[];
  readonly fixtures: SimFixtures;
}): SimReport {
  const lines: SimLine[] = [];
  const flags: { scenarioId: string; detail: string }[] = [];

  for (const scenario of input.scenarios) {
    const resolved = resolveServiceabilityPolicy({ schedule: input.fixtures.schedule, on: scenario.on });
    const base = {
      scenarioId: scenario.scenarioId,
      on: scenario.on,
      method: scenario.method,
      policySource: resolved.source,
      policyEffectiveFrom: resolved.effectiveFrom,
    };

    // ── Pickup: the customer collects, so there is no delivery-address gate ────
    if (scenario.method === 'pickup') {
      const route = routeOrder({
        orderId: scenario.scenarioId,
        method: 'pickup',
        lines: scenario.lines,
        locations: input.fixtures.locations,
        stock: input.fixtures.stock,
        slots: input.fixtures.slots,
      });
      if (route.routed) {
        lines.push({
          ...base,
          route,
          verdict: 'pickup_ready',
          deliveryFeeMinor: 0,
          tellTheCustomer: `Ready to collect from ${route.locationId}.`,
        });
      } else {
        flags.push({ scenarioId: scenario.scenarioId, detail: `pickup cannot be fulfilled — ${route.detail}` });
        lines.push({
          ...base,
          route,
          verdict: 'unroutable',
          deliveryFeeMinor: 0,
          tellTheCustomer: `We cannot offer pickup for this order: ${route.detail}`,
        });
      }
      continue;
    }

    // ── Delivery: an address is required to decide anything at all ─────────────
    if (scenario.deliveryLocation === undefined) {
      const detail = 'a delivery scenario has no address, so serviceability cannot be judged';
      flags.push({ scenarioId: scenario.scenarioId, detail });
      lines.push({
        ...base,
        verdict: 'unroutable',
        deliveryFeeMinor: 0,
        tellTheCustomer: `We could not check this delivery: ${detail}.`,
      });
      continue;
    }

    const serviceability = checkServiceability({
      storeLocation: input.fixtures.storeLocation,
      deliveryLocation: scenario.deliveryLocation,
      basketMinor: scenario.basketMinor,
      policy: resolved.policy,
    });

    // A correct refusal — outside the area, or below the minimum — is the system working. Counted,
    // never flagged, and never routed: routing an order the store already refused is how a refused
    // order still gets picked.
    if (!serviceability.serviceable) {
      lines.push({
        ...base,
        serviceability,
        verdict: serviceability.outcome === 'out_of_area' ? 'out_of_area' : 'below_minimum',
        deliveryFeeMinor: 0,
        tellTheCustomer: serviceability.detail,
      });
      continue;
    }

    const route = routeOrder({
      orderId: scenario.scenarioId,
      method: scenario.method,
      deliverTo: scenario.deliveryLocation,
      lines: scenario.lines,
      locations: input.fixtures.locations,
      stock: input.fixtures.stock,
      slots: input.fixtures.slots,
      ...(scenario.expressPromiseMinutes === undefined ? {} : { expressPromiseMinutes: scenario.expressPromiseMinutes }),
    });

    if (route.routed) {
      lines.push({
        ...base,
        serviceability,
        route,
        verdict: 'deliverable',
        deliveryFeeMinor: serviceability.deliveryFeeMinor,
        tellTheCustomer: `${serviceability.detail}; fulfilled from ${route.locationId}.`,
      });
      continue;
    }

    // The store says it delivers here, but no location can fill it. That is the serviceable radius and
    // the locations disagreeing — the exact gap that sells an order the shop cannot keep.
    const detail = `the address is inside the delivery area but no location can fill it — ${route.detail}`;
    flags.push({ scenarioId: scenario.scenarioId, detail });
    lines.push({
      ...base,
      serviceability,
      route,
      verdict: 'unroutable',
      deliveryFeeMinor: 0,
      tellTheCustomer: `We serve your area, but cannot fill this order right now: ${route.detail}`,
    });
  }

  const totals: SimTotals = {
    scenarios: lines.length,
    deliverable: lines.filter((l) => l.verdict === 'deliverable').length,
    pickupReady: lines.filter((l) => l.verdict === 'pickup_ready').length,
    outOfArea: lines.filter((l) => l.verdict === 'out_of_area').length,
    belowMinimum: lines.filter((l) => l.verdict === 'below_minimum').length,
    unroutable: lines.filter((l) => l.verdict === 'unroutable').length,
    totalDeliveryFeeMinor: lines.reduce((sum, l) => sum + l.deliveryFeeMinor, 0),
  };

  return { runLabel: input.runLabel, lines, totals, flags, distancesAre: 'straight_line' };
}
