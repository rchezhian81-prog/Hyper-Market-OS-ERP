// Dispatch: turning today's confirmed orders into routes somebody can actually drive — M19-FR-03
// (driver/partner assignment, route, geofence), M19-FR-04 (SLA), D08 (serviceability), D09.
//
// Until this existed nothing dispatched. Two things followed, and the second is worse than it
// sounds. The driver's phone had to be handed a route written out by hand; and `reconcileRun` was
// given an empty assignment list, so **every delivery a driver actually made came back as one
// nobody had dispatched** — goods leaving the building against orders no run could account for.
//
// ── What this is, stated plainly, because the alternative is a lie ──────────
//
// **These are straight-line distances.** Not road distances. There is no map here, no road network
// and no traffic; the arithmetic is great-circle geometry over latitude and longitude. A river, a
// railway line or a one-way system between two points makes the ordering wrong, and no amount of
// care inside this file can fix that.
//
// So what it produces is a **draft a dispatcher confirms**, and it says so in the result — every
// plan carries `distancesAre: 'straight_line'` and an ETA marked as an estimate. It never claims an
// optimal route, because it cannot compute one and software that claims it anyway is how a driver
// ends up with a schedule that was never achievable and a shop finds out at nine in the evening.
//
// ── The invariant that matters more than the sequencing ─────────────────────
//
// **Every order goes somewhere.** On a route, or on the unplanned list with a named reason — and
// nothing may appear on both or on neither. A dropped stop is not a routing inefficiency; it is a
// customer who ordered, paid, waited, and was never told anything, and they find out by the goods
// not arriving. `accountedFor` is asserted against the input, and a test drives it as a property
// rather than trusting the code that produces it.
//
// ── Why time windows beat geography ─────────────────────────────────────────
//
// The customer booked a slot (M20-FR-03). A stop cannot be moved into a later window because it
// happened to be geographically convenient, so the windows are the outer ordering and the
// nearest-neighbour pass runs **inside** one. Optimising across windows produces a shorter route
// and a broken promise, and only one of those is visible on a screen.

import { metresBetween } from '../../orders/src/fulfilment-plan';

/** One confirmed order waiting to go out. */
export interface DeliverableOrder {
  readonly orderId: string;
  /** The window the customer booked. Orders in different windows never share a leg. */
  readonly slotId: string;
  readonly slotStartsAt: string;
  readonly slotEndsAt: string;
  /** Coarse area label for the driver — never the full address record (§31/§35). */
  readonly area: string;
  /** Where it goes. Absent means this order **cannot be planned**, and says so. */
  readonly location?: { readonly lat: number; readonly lon: number };
  readonly codMinor: number;
  readonly orderValueMinor?: number;
}

/** Somebody who can drive a route today. */
export interface DispatchDriver {
  readonly driverId: string;
  /** Most stops this driver can take in a day. A constraint, not a suggestion. */
  readonly maxStops: number;
  /** When they are available, ISO-8601 UTC. A route never starts before or ends after. */
  readonly availableFrom: string;
  readonly availableUntil: string;
}

/** Per-tenant, all of it. Nothing in this file is a constant about one shop. */
export interface RoutingPolicy {
  readonly storeLocation: { readonly lat: number; readonly lon: number };
  /** Serviceable radius in metres (D08). Beyond it, an order is refused, not driven. */
  readonly radiusMetres: number;
  /** Assumed average speed. An estimate, and labelled as one wherever it reaches a person. */
  readonly averageSpeedKmh: number;
  /** How long a doorstep takes: park, walk, hand over, take the money, get proof. */
  readonly serviceMinutesPerStop: number;
  /** Flag a stop whose delivery cost is out of proportion to the order (D09). */
  readonly contributionRule?: { readonly maxCostShareBps: number };
}

export interface PlannedStop {
  readonly stopId: string;
  readonly orderId: string;
  readonly area: string;
  readonly codMinor: number;
  /** 1-based position on the run. */
  readonly sequence: number;
  /** Straight-line metres from the previous stop, or from the store for the first. */
  readonly legMetres: number;
  /** When the driver is expected to be there. **An estimate on straight-line distance.** */
  readonly estimatedArrivalAt: string;
  /** True when the estimate lands outside the window the customer was promised. */
  readonly missesTheWindow: boolean;
  readonly orderValueMinor?: number;
}

export interface PlannedRoute {
  readonly routeId: string;
  readonly driverId: string;
  readonly slotId: string;
  readonly startsAt: string;
  readonly stops: readonly PlannedStop[];
  /** Straight-line total, out and back. Not a road distance and never presented as one. */
  readonly totalMetres: number;
  /** What the driver will be carrying by the end. Feeds the shift handover (M19-FR-04). */
  readonly totalCodMinor: number;
  readonly estimatedReturnAt: string;
}

export type UnplannedReason =
  /** No coordinates on the order. It cannot be sequenced, and guessing a location is worse. */
  | 'no_location'
  /** Outside the serviceable radius (D08). It should never have been sold as a delivery. */
  | 'out_of_area'
  /** Every driver's day was full. A real answer, and it needs a person, not a longer route. */
  | 'no_driver_available'
  /** No driver is on shift during the window the customer was promised. */
  | 'no_driver_in_the_window';

export interface UnplannedOrder {
  readonly orderId: string;
  readonly reason: UnplannedReason;
  /** Written for the dispatcher who has to do something about it. */
  readonly detail: string;
}

export interface DispatchPlan {
  readonly routes: readonly PlannedRoute[];
  /** Every order that could not go on a route, each with a reason. Never silently dropped. */
  readonly unplanned: readonly UnplannedOrder[];
  /**
   * How many orders this plan accounts for — routed plus unplanned.
   *
   * Compared against the input by the caller and by a test. An order that appears in neither is a
   * customer who ordered, paid, waited and was told nothing, and they find out by nothing
   * arriving.
   */
  readonly accountedFor: number;
  /**
   * **Straight-line, always.** Carried in the result rather than in a comment, so any screen or
   * report that shows a distance has to acknowledge what kind it is.
   */
  readonly distancesAre: 'straight_line';
  /** Stops the contribution rule flags as costing more than they are worth (D09). */
  readonly contributionFlags: readonly { readonly orderId: string; readonly detail: string }[];
}

const MINUTE_MS = 60_000;

/** Travel minutes for a straight-line distance at the policy's assumed speed. */
function travelMinutes(metres: number, averageSpeedKmh: number): number {
  if (averageSpeedKmh <= 0) throw new RangeError('averageSpeedKmh must be greater than zero.');
  return (metres / 1000 / averageSpeedKmh) * 60;
}

function addMinutes(iso: string, minutes: number): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) throw new RangeError(`"${iso}" is not a valid timestamp.`);
  return new Date(at + minutes * MINUTE_MS).toISOString();
}

const laterOf = (a: string, b: string): string => (Date.parse(a) >= Date.parse(b) ? a : b);

/**
 * Order the stops within one window, nearest first from the store.
 *
 * Nearest-neighbour, which is a **heuristic and not an optimum** — it is typically within about a
 * quarter of the best possible route and it is explainable, which matters more here than the last
 * few percent: a dispatcher who cannot see why a stop is third will re-order it by hand and be
 * right to.
 *
 * Ties break on `orderId` so the same input always produces the same plan. A planner that shuffled
 * would give two dispatchers two different answers to one question.
 */
function sequence(
  orders: readonly DeliverableOrder[],
  from: { readonly lat: number; readonly lon: number },
): readonly DeliverableOrder[] {
  const remaining = [...orders];
  const ordered: DeliverableOrder[] = [];
  let at = from;

  while (remaining.length > 0) {
    let best = 0;
    let bestMetres = Number.POSITIVE_INFINITY;
    for (const [i, order] of remaining.entries()) {
      const metres = metresBetween(at, order.location!);
      const closer = metres < bestMetres;
      const tied = metres === bestMetres && order.orderId < remaining[best]!.orderId;
      if (closer || tied) {
        best = i;
        bestMetres = metres;
      }
    }
    const [next] = remaining.splice(best, 1);
    ordered.push(next!);
    at = next!.location!;
  }
  return ordered;
}

/**
 * Plan today's deliveries.
 *
 * Deterministic: the same orders, drivers and policy always produce the same plan, because a
 * dispatcher who re-runs it and gets a different answer stops believing either.
 */
export function planDispatch(input: {
  readonly runDate: string;
  readonly orders: readonly DeliverableOrder[];
  readonly drivers: readonly DispatchDriver[];
  readonly policy: RoutingPolicy;
}): DispatchPlan {
  const routes: PlannedRoute[] = [];
  const unplanned: UnplannedOrder[] = [];
  const contributionFlags: { orderId: string; detail: string }[] = [];

  // How many stops each driver has left. Capacity is a constraint: a driver given forty stops in a
  // two-hour window fails twenty-five of them, and the shop finds out at nine in the evening.
  const remainingStops = new Map(input.drivers.map((d) => [d.driverId, d.maxStops]));

  // ── Every order is triaged before any of it is sequenced ──────────────────
  //
  // Refusing early and by name is the point. An order with no coordinates cannot be placed, and
  // appending it to the end of somebody's route — which is what "handle it later" becomes — sends
  // a driver to an address the system does not have.
  const routable: DeliverableOrder[] = [];
  for (const order of input.orders) {
    if (order.location === undefined) {
      unplanned.push({
        orderId: order.orderId,
        reason: 'no_location',
        detail: `${order.orderId} has no delivery location on it, so it cannot be put in a sequence. Somebody has to add the address before it can go out.`,
      });
      continue;
    }
    const metres = metresBetween(input.policy.storeLocation, order.location);
    if (metres > input.policy.radiusMetres) {
      unplanned.push({
        orderId: order.orderId,
        reason: 'out_of_area',
        detail: `${order.orderId} is ${(metres / 1000).toFixed(1)} km away and we deliver up to ${(input.policy.radiusMetres / 1000).toFixed(1)} km. It should not have been sold as a delivery — tell the customer today, not at the door.`,
      });
      continue;
    }
    routable.push(order);
  }

  // ── Then by window, because a promise beats a shorter route ───────────────
  const windows = new Map<string, DeliverableOrder[]>();
  for (const order of routable) {
    const group = windows.get(order.slotId) ?? [];
    group.push(order);
    windows.set(order.slotId, group);
  }

  // Earliest window first, then by id, so the plan is stable however the orders arrived.
  const windowIds = [...windows.keys()].sort((a, b) => {
    const left = windows.get(a)![0]!;
    const right = windows.get(b)![0]!;
    const byStart = Date.parse(left.slotStartsAt) - Date.parse(right.slotStartsAt);
    return byStart !== 0 ? byStart : a.localeCompare(b);
  });

  for (const slotId of windowIds) {
    const group = windows.get(slotId)!;
    const { slotStartsAt, slotEndsAt } = group[0]!;

    // Only drivers actually on shift for this window. A driver who clocks off at six cannot take
    // a seven o'clock slot, and assigning it to them anyway is how a stop silently fails.
    const onShift = input.drivers
      .filter((d) => Date.parse(d.availableFrom) <= Date.parse(slotEndsAt)
        && Date.parse(d.availableUntil) >= Date.parse(slotStartsAt))
      .filter((d) => (remainingStops.get(d.driverId) ?? 0) > 0);

    if (onShift.length === 0) {
      const anyFree = input.drivers.some((d) => (remainingStops.get(d.driverId) ?? 0) > 0);
      for (const order of group) {
        unplanned.push({
          orderId: order.orderId,
          reason: anyFree ? 'no_driver_in_the_window' : 'no_driver_available',
          detail: anyFree
            ? `nobody is on shift during the ${slotId} window that ${order.orderId} was promised. Either put somebody on, or ring the customer and move the slot.`
            : `every driver's day is full, so ${order.orderId} has nowhere to go. This needs a person — a longer route is not the answer.`,
        });
      }
      continue;
    }

    const ordered = sequence(group, input.policy.storeLocation);

    // Fill one driver at a time, in the order they were configured, so the plan is explainable.
    let driverIndex = 0;
    let carrying: DeliverableOrder[] = [];

    const flush = (): void => {
      if (carrying.length === 0) return;
      const driver = onShift[driverIndex]!;
      routes.push(buildRoute({
        runDate: input.runDate, driver, slotId, slotStartsAt, orders: carrying,
        policy: input.policy, slotEndsAt, contributionFlags,
      }));
      remainingStops.set(driver.driverId, (remainingStops.get(driver.driverId) ?? 0) - carrying.length);
      carrying = [];
    };

    for (const order of ordered) {
      const driver = onShift[driverIndex];
      if (driver === undefined) {
        unplanned.push({
          orderId: order.orderId,
          reason: 'no_driver_available',
          detail: `every driver on the ${slotId} window is full, so ${order.orderId} has nowhere to go. This needs a person — a longer route is not the answer.`,
        });
        continue;
      }
      const room = (remainingStops.get(driver.driverId) ?? 0) - carrying.length;
      if (room <= 0) {
        flush();
        driverIndex += 1;
        // Re-offer this order to the next driver rather than losing it.
        const nextDriver = onShift[driverIndex];
        if (nextDriver === undefined) {
          unplanned.push({
            orderId: order.orderId,
            reason: 'no_driver_available',
            detail: `every driver on the ${slotId} window is full, so ${order.orderId} has nowhere to go. This needs a person — a longer route is not the answer.`,
          });
          continue;
        }
      }
      carrying.push(order);
    }
    flush();
  }

  return {
    routes,
    unplanned,
    accountedFor: routes.reduce((n, r) => n + r.stops.length, 0) + unplanned.length,
    distancesAre: 'straight_line',
    contributionFlags,
  };
}

function buildRoute(input: {
  readonly runDate: string;
  readonly driver: DispatchDriver;
  readonly slotId: string;
  readonly slotStartsAt: string;
  readonly slotEndsAt: string;
  readonly orders: readonly DeliverableOrder[];
  readonly policy: RoutingPolicy;
  readonly contributionFlags: { orderId: string; detail: string }[];
}): PlannedRoute {
  // A van does not leave before the driver is on shift, and does not leave before the window it is
  // serving opens. Later of the two, always.
  const startsAt = laterOf(input.driver.availableFrom, input.slotStartsAt);

  let at = input.policy.storeLocation;
  let clock = startsAt;
  let totalMetres = 0;
  let totalCodMinor = 0;
  const stops: PlannedStop[] = [];

  for (const [i, order] of input.orders.entries()) {
    const legMetres = metresBetween(at, order.location!);
    totalMetres += legMetres;
    clock = addMinutes(clock, travelMinutes(legMetres, input.policy.averageSpeedKmh));
    const estimatedArrivalAt = clock;
    clock = addMinutes(clock, input.policy.serviceMinutesPerStop);
    totalCodMinor += order.codMinor;

    // Flagged, not hidden, and flagged at PLANNING time rather than after the van is out — which
    // is the only moment anybody can still decide not to send it (D09).
    const rule = input.policy.contributionRule;
    if (rule !== undefined && order.orderValueMinor !== undefined && order.orderValueMinor > 0) {
      // Cost attributed to this stop: the leg it added, at the policy's own speed and rate. It is
      // a straight-line estimate like everything else here, and it is used to raise a question
      // with a person, never to cancel somebody's order automatically.
      const shareBps = Math.round((legMetres * 10_000) / Math.max(1, order.orderValueMinor));
      if (shareBps > rule.maxCostShareBps) {
        input.contributionFlags.push({
          orderId: order.orderId,
          detail: `${order.orderId} is ${(legMetres / 1000).toFixed(1)} km off the run for an order worth ${(order.orderValueMinor / 100).toFixed(2)}. Worth a look before the van goes.`,
        });
      }
    }

    stops.push({
      stopId: `${input.runDate}:${input.driver.driverId}:${i + 1}`,
      orderId: order.orderId,
      area: order.area,
      codMinor: order.codMinor,
      sequence: i + 1,
      legMetres,
      estimatedArrivalAt,
      // Said on the stop rather than left for the driver to discover at the door. A window that
      // was never achievable is a promise the shop should not have made, and the dispatcher can
      // still ring the customer while the van is in the yard.
      missesTheWindow: Date.parse(estimatedArrivalAt) > Date.parse(input.slotEndsAt),
      ...(order.orderValueMinor === undefined ? {} : { orderValueMinor: order.orderValueMinor }),
    });
    at = order.location!;
  }

  // Back to the store. The return leg is part of the day and leaving it out makes every route look
  // shorter than it is — which is how a driver's last stop lands after their shift ends.
  const home = metresBetween(at, input.policy.storeLocation);
  totalMetres += home;

  return {
    routeId: `${input.runDate}:${input.driver.driverId}:${input.slotId}`,
    driverId: input.driver.driverId,
    slotId: input.slotId,
    startsAt,
    stops,
    totalMetres,
    totalCodMinor,
    estimatedReturnAt: addMinutes(clock, travelMinutes(home, input.policy.averageSpeedKmh)),
  };
}

/**
 * A driver has become unavailable — re-plan without them (M19-FR-03, "partner unavailable →
 * reassign").
 *
 * Deliberately a **full re-plan** rather than moving that driver's stops onto whoever has room.
 * Patching produces a route nobody sequenced: their stops get appended to the end of somebody
 * else's run, in the order they happened to be in, and the last customer of the day pays for it.
 *
 * What comes back is a plan like any other, so anything that now genuinely does not fit appears on
 * the unplanned list by name — which is the honest outcome when a van is off the road.
 */
export function reassign(input: {
  readonly runDate: string;
  readonly orders: readonly DeliverableOrder[];
  readonly drivers: readonly DispatchDriver[];
  readonly policy: RoutingPolicy;
  readonly withoutDriverId: string;
}): DispatchPlan {
  return planDispatch({
    runDate: input.runDate,
    orders: input.orders,
    drivers: input.drivers.filter((d) => d.driverId !== input.withoutDriverId),
    policy: input.policy,
  });
}

/**
 * The order ids a run is answerable for — what `reconcileRun` needs and never had.
 *
 * Without it the reconciliation was given an empty list and reported **every** delivery a driver
 * actually made as one nobody had dispatched: goods out of the building against orders no run
 * could account for.
 */
export function assignedOrderIds(plan: DispatchPlan, driverId: string): readonly string[] {
  return plan.routes
    .filter((r) => r.driverId === driverId)
    .flatMap((r) => r.stops.map((s) => s.orderId))
    .sort();
}
