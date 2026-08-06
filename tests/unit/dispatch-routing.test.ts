import { describe, it, expect } from 'vitest';
import {
  planDispatch, reassign, assignedOrderIds,
  type DeliverableOrder, type DispatchDriver, type RoutingPolicy,
} from '../../packages/fulfilment/src/routing';
import { reconcileRun } from '../../services/fulfilment/src/index';

/**
 * **Dispatch (M19-FR-03 / M19-FR-04 / D08 / D09).**
 *
 * Nothing planned a route until this existed, and the consequence was not just a driver holding a
 * handwritten list. `reconcileRun` was given an empty assignment list, so **every delivery a driver
 * actually made came back as one nobody had dispatched** — goods out of the building against orders
 * no run could account for. The last test here closes that.
 *
 * The invariant under test throughout is not the sequencing. It is that **every order goes
 * somewhere**: onto a route, or onto the unplanned list with a reason. An order in neither is a
 * customer who ordered, paid, waited and was told nothing.
 */

const RUN = '2026-08-06';

/** The store, and three addresses at increasing distance from it. */
const STORE = { lat: 11.0000, lon: 77.0000 };
const NEAR = { lat: 11.0050, lon: 77.0000 };   // ~556 m
const MID = { lat: 11.0150, lon: 77.0000 };    // ~1.7 km
const FAR = { lat: 11.0400, lon: 77.0000 };    // ~4.4 km
const OUTSIDE = { lat: 11.2000, lon: 77.0000 }; // ~22 km — beyond a 10 km radius

const POLICY: RoutingPolicy = {
  storeLocation: STORE,
  radiusMetres: 10_000,
  averageSpeedKmh: 20,
  serviceMinutesPerStop: 5,
};

const order = (over: Partial<DeliverableOrder> & { orderId: string }): DeliverableOrder => ({
  slotId: 'evening',
  slotStartsAt: '2026-08-06T17:00:00.000Z',
  slotEndsAt: '2026-08-06T19:00:00.000Z',
  area: 'Anna Nagar',
  location: NEAR,
  codMinor: 0,
  ...over,
});

const driver = (over: Partial<DispatchDriver> & { driverId: string }): DispatchDriver => ({
  maxStops: 10,
  availableFrom: '2026-08-06T16:00:00.000Z',
  availableUntil: '2026-08-06T21:00:00.000Z',
  ...over,
});

const plan = (orders: DeliverableOrder[], drivers: DispatchDriver[] = [driver({ driverId: 'd1' })], policy = POLICY) =>
  planDispatch({ runDate: RUN, orders, drivers, policy });

/** Every order id the plan accounts for, routed or not. */
const accounted = (p: ReturnType<typeof plan>): string[] => [
  ...p.routes.flatMap((r) => r.stops.map((s) => s.orderId)),
  ...p.unplanned.map((u) => u.orderId),
].sort();

describe('every order goes somewhere — the invariant', () => {
  it('accounts for every order exactly once, routed or refused', () => {
    const orders = [
      order({ orderId: 'A', location: FAR }),
      order({ orderId: 'B', location: NEAR }),
      order({ orderId: 'C', location: undefined }),        // cannot be placed
      order({ orderId: 'D', location: OUTSIDE }),           // out of area
      order({ orderId: 'E', location: MID }),
    ];
    const result = plan(orders);

    expect(accounted(result)).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(result.accountedFor).toBe(orders.length);
    // Disjoint: nothing on a route may also be on the unplanned list.
    const routed = new Set(result.routes.flatMap((r) => r.stops.map((s) => s.orderId)));
    for (const u of result.unplanned) expect(routed.has(u.orderId)).toBe(false);
  });

  it('holds the invariant however the day is shaped', () => {
    // Driven as a property rather than trusted, because the failure is silent and the cost is a
    // customer who hears nothing.
    const shapes: DeliverableOrder[][] = [
      [],
      [order({ orderId: 'only' })],
      Array.from({ length: 25 }, (_, i) => order({ orderId: `o${i}`, location: i % 2 ? NEAR : MID })),
      Array.from({ length: 8 }, (_, i) => order({ orderId: `x${i}`, location: i < 4 ? undefined : OUTSIDE })),
      Array.from({ length: 6 }, (_, i) => order({
        orderId: `w${i}`,
        slotId: i < 3 ? 'morning' : 'evening',
        slotStartsAt: i < 3 ? '2026-08-06T09:00:00.000Z' : '2026-08-06T17:00:00.000Z',
        slotEndsAt: i < 3 ? '2026-08-06T11:00:00.000Z' : '2026-08-06T19:00:00.000Z',
      })),
    ];
    for (const orders of shapes) {
      const result = plan(orders, [driver({ driverId: 'd1', maxStops: 4 }), driver({ driverId: 'd2', maxStops: 4 })]);
      expect(accounted(result), `${orders.length} orders`).toEqual(orders.map((o) => o.orderId).sort());
      expect(result.accountedFor).toBe(orders.length);
    }
  });

  it('names a reason for every unplanned order, written for a person', () => {
    const result = plan([
      order({ orderId: 'A', location: undefined }),
      order({ orderId: 'B', location: OUTSIDE }),
    ]);
    const byId = new Map(result.unplanned.map((u) => [u.orderId, u]));
    expect(byId.get('A')?.reason).toBe('no_location');
    expect(byId.get('A')?.detail).toMatch(/add the address/i);
    expect(byId.get('B')?.reason).toBe('out_of_area');
    expect(byId.get('B')?.detail).toMatch(/tell the customer today, not at the door/i);
  });
});

describe('it never claims to be something it is not', () => {
  it('says its distances are straight-line, in the result rather than in a comment', () => {
    // There is no map here and no road network. A river between two points makes the ordering
    // wrong, and any screen showing a distance has to acknowledge which kind it is.
    expect(plan([order({ orderId: 'A' })]).distancesAre).toBe('straight_line');
  });

  it('is deterministic — the same day always plans the same way', () => {
    const orders = [
      order({ orderId: 'C', location: FAR }),
      order({ orderId: 'A', location: MID }),
      order({ orderId: 'B', location: NEAR }),
    ];
    const first = plan(orders);
    const second = plan([...orders].reverse());
    expect(first.routes[0]?.stops.map((s) => s.orderId))
      .toEqual(second.routes[0]?.stops.map((s) => s.orderId));
  });
});

describe('the sequence, and what it is allowed to optimise across', () => {
  it('goes nearest first from the store', () => {
    const result = plan([
      order({ orderId: 'far', location: FAR }),
      order({ orderId: 'near', location: NEAR }),
      order({ orderId: 'mid', location: MID }),
    ]);
    expect(result.routes[0]?.stops.map((s) => s.orderId)).toEqual(['near', 'mid', 'far']);
  });

  it('never moves a stop into a different window to shorten the route', () => {
    // The customer booked a window. A shorter route that delivers at eight what was promised for
    // five is a broken promise, and only one of the two is visible on a screen.
    const morningFar = order({
      orderId: 'morning-far', location: FAR, slotId: 'morning',
      slotStartsAt: '2026-08-06T09:00:00.000Z', slotEndsAt: '2026-08-06T11:00:00.000Z',
    });
    const eveningNear = order({ orderId: 'evening-near', location: NEAR });
    // A driver on all day, so the windows are the only thing separating these two.
    const allDay = driver({
      driverId: 'd1', availableFrom: '2026-08-06T08:00:00.000Z', availableUntil: '2026-08-06T21:00:00.000Z',
    });
    const result = plan([eveningNear, morningFar], [allDay]);

    const routes = result.routes;
    expect(routes).toHaveLength(2);
    // Earliest window first, and each route holds only its own window.
    expect(routes[0]?.slotId).toBe('morning');
    expect(routes[0]?.stops.map((s) => s.orderId)).toEqual(['morning-far']);
    expect(routes[1]?.slotId).toBe('evening');
  });

  it('counts the leg home, so a route is not shorter on paper than in a van', () => {
    const result = plan([order({ orderId: 'A', location: MID })]);
    const route = result.routes[0]!;
    // Out and back: roughly twice the one-way distance.
    expect(route.totalMetres).toBeGreaterThan(route.stops[0]!.legMetres * 1.9);
  });

  it('estimates an arrival for every stop, after the window opens', () => {
    const result = plan([order({ orderId: 'A' }), order({ orderId: 'B', location: MID })]);
    const stops = result.routes[0]!.stops;
    expect(Date.parse(stops[0]!.estimatedArrivalAt)).toBeGreaterThanOrEqual(Date.parse('2026-08-06T17:00:00.000Z'));
    expect(Date.parse(stops[1]!.estimatedArrivalAt)).toBeGreaterThan(Date.parse(stops[0]!.estimatedArrivalAt));
  });

  it('does not leave before the driver is on shift', () => {
    const late = driver({ driverId: 'd1', availableFrom: '2026-08-06T18:00:00.000Z' });
    const result = plan([order({ orderId: 'A' })], [late]);
    expect(result.routes[0]?.startsAt).toBe('2026-08-06T18:00:00.000Z');
  });
});

describe('a window that cannot be met is said before the van leaves', () => {
  it('flags a stop whose estimate lands after the promised window', () => {
    // Said at planning time, which is the only moment anybody can still ring the customer.
    const slow: RoutingPolicy = { ...POLICY, averageSpeedKmh: 2, serviceMinutesPerStop: 30 };
    const result = plan(
      Array.from({ length: 5 }, (_, i) => order({ orderId: `o${i}`, location: i < 2 ? NEAR : FAR })),
      [driver({ driverId: 'd1' })],
      slow,
    );
    const stops = result.routes[0]!.stops;
    expect(stops.some((s) => s.missesTheWindow)).toBe(true);
    // And it is still ON the route — a stop that would miss its window is a conversation, not a
    // reason to quietly not deliver somebody's shopping.
    expect(stops).toHaveLength(5);
  });

  it('does not cry wolf on a route that comfortably fits', () => {
    const result = plan([order({ orderId: 'A' }), order({ orderId: 'B', location: MID })]);
    expect(result.routes[0]!.stops.every((s) => s.missesTheWindow)).toBe(false);
  });
});

describe('capacity is a constraint, not a suggestion', () => {
  it('fills one driver, then the next', () => {
    const orders = Array.from({ length: 5 }, (_, i) => order({ orderId: `o${i}` }));
    const result = plan(orders, [
      driver({ driverId: 'd1', maxStops: 3 }),
      driver({ driverId: 'd2', maxStops: 3 }),
    ]);
    expect(result.routes.map((r) => r.stops.length)).toEqual([3, 2]);
    expect(result.routes.map((r) => r.driverId)).toEqual(['d1', 'd2']);
  });

  it('refuses what will not fit rather than overloading somebody', () => {
    // A driver given forty stops in a two-hour window fails twenty-five, and the shop finds out
    // at nine in the evening.
    const orders = Array.from({ length: 5 }, (_, i) => order({ orderId: `o${i}` }));
    const result = plan(orders, [driver({ driverId: 'd1', maxStops: 2 })]);

    expect(result.routes[0]?.stops).toHaveLength(2);
    expect(result.unplanned).toHaveLength(3);
    expect(result.unplanned[0]?.reason).toBe('no_driver_available');
    expect(result.unplanned[0]?.detail).toMatch(/needs a person/i);
    expect(accounted(result)).toEqual(['o0', 'o1', 'o2', 'o3', 'o4']);
  });

  it('says when nobody is on shift for the window the customer was promised', () => {
    const dayShift = driver({
      driverId: 'd1', availableFrom: '2026-08-06T06:00:00.000Z', availableUntil: '2026-08-06T14:00:00.000Z',
    });
    const result = plan([order({ orderId: 'A' })], [dayShift]);
    expect(result.unplanned[0]).toMatchObject({ orderId: 'A', reason: 'no_driver_in_the_window' });
    expect(result.unplanned[0]?.detail).toMatch(/put somebody on, or ring the customer/i);
  });

  it('plans nothing, and refuses everything by name, with no drivers at all', () => {
    const result = plan([order({ orderId: 'A' }), order({ orderId: 'B' })], []);
    expect(result.routes).toEqual([]);
    expect(result.unplanned.map((u) => u.orderId)).toEqual(['A', 'B']);
  });
});

describe('the money on the van', () => {
  it('totals the COD each driver will be carrying', () => {
    const result = plan([
      order({ orderId: 'A', codMinor: 250_00 }),
      order({ orderId: 'B', codMinor: 150_00, location: MID }),
    ]);
    expect(result.routes[0]?.totalCodMinor).toBe(400_00);
  });

  it('flags a stop that costs more to reach than it is worth (D09)', () => {
    // Raised with a person before the van goes. Never used to cancel somebody's order.
    const result = plan(
      [order({ orderId: 'tiny', location: FAR, orderValueMinor: 50_00 })],
      [driver({ driverId: 'd1' })],
      { ...POLICY, contributionRule: { maxCostShareBps: 500 } },
    );
    expect(result.contributionFlags[0]?.orderId).toBe('tiny');
    expect(result.contributionFlags[0]?.detail).toMatch(/worth a look before the van goes/i);
    // Flagged, and still on the route.
    expect(result.routes[0]?.stops.map((s) => s.orderId)).toEqual(['tiny']);
  });

  it('flags nothing when no contribution rule is configured', () => {
    expect(plan([order({ orderId: 'tiny', location: FAR, orderValueMinor: 50_00 })]).contributionFlags).toEqual([]);
  });
});

describe('a driver goes off the road', () => {
  it('re-plans the whole day rather than patching their stops onto somebody else', () => {
    // Patching appends their stops to the end of another run, in whatever order they happened to
    // be in, and the last customer of the day pays for it.
    const orders = Array.from({ length: 4 }, (_, i) => order({ orderId: `o${i}`, location: i % 2 ? MID : NEAR }));
    const drivers = [driver({ driverId: 'd1', maxStops: 2 }), driver({ driverId: 'd2', maxStops: 4 })];

    const after = reassign({ runDate: RUN, orders, drivers, policy: POLICY, withoutDriverId: 'd1' });
    expect(after.routes.every((r) => r.driverId !== 'd1')).toBe(true);
    expect(accounted(after)).toEqual(['o0', 'o1', 'o2', 'o3']);
    // Re-sequenced from the store, not appended.
    expect(after.routes[0]?.stops[0]?.sequence).toBe(1);
  });

  it('reports honestly when the remaining fleet cannot take it all', () => {
    const orders = Array.from({ length: 4 }, (_, i) => order({ orderId: `o${i}` }));
    const drivers = [driver({ driverId: 'd1', maxStops: 4 }), driver({ driverId: 'd2', maxStops: 1 })];

    const after = reassign({ runDate: RUN, orders, drivers, policy: POLICY, withoutDriverId: 'd1' });
    expect(after.routes[0]?.stops).toHaveLength(1);
    expect(after.unplanned).toHaveLength(3);
    expect(accounted(after)).toEqual(['o0', 'o1', 'o2', 'o3']);
  });
});

describe('the run can finally be reconciled — what was missing before', () => {
  it('gives reconcileRun the assignment list it never had', () => {
    // Without this the reconciliation was handed an empty list and reported EVERY delivery a
    // driver actually made as one nobody dispatched.
    const orders = [order({ orderId: 'ORD-1' }), order({ orderId: 'ORD-2', location: MID })];
    const result = plan(orders);
    const assigned = assignedOrderIds(result, 'd1');
    expect(assigned).toEqual(['ORD-1', 'ORD-2']);

    const run = reconcileRun({
      driverId: 'd1',
      runDate: RUN,
      assignedOrderIds: assigned,
      attempts: [
        { attemptId: 'a1', orderId: 'ORD-1', driverId: 'd1', attemptedAt: '2026-08-06T17:30:00.000Z', outcome: 'delivered', proofRef: 'otp:1234' },
        { attemptId: 'a2', orderId: 'ORD-2', driverId: 'd1', attemptedAt: '2026-08-06T17:50:00.000Z', outcome: 'delivered', proofRef: 'otp:5678' },
      ],
      cashHandedInMinor: 0,
    });

    expect(run.unassigned).toEqual([]);
    expect(run.outstanding).toEqual([]);
    expect(run.ownerAction).toMatch(/the run reconciles/);
  });

  it('still catches a delivery against an order that was never on the run', () => {
    // The control must survive dispatch existing — it is the one that notices goods leaving the
    // building against an order nobody planned.
    const result = plan([order({ orderId: 'ORD-1' })]);
    const run = reconcileRun({
      driverId: 'd1',
      runDate: RUN,
      assignedOrderIds: assignedOrderIds(result, 'd1'),
      attempts: [
        { attemptId: 'a9', orderId: 'ORD-9', driverId: 'd1', attemptedAt: '2026-08-06T17:30:00.000Z', outcome: 'delivered', proofRef: 'otp:1' },
      ],
      cashHandedInMinor: 0,
    });
    expect(run.unassigned).toEqual(['ORD-9']);
    expect(run.ownerAction).toMatch(/goods left the building against orders nobody dispatched/);
  });

  it('gives each driver only their own orders', () => {
    const orders = Array.from({ length: 4 }, (_, i) => order({ orderId: `o${i}` }));
    const result = plan(orders, [driver({ driverId: 'd1', maxStops: 2 }), driver({ driverId: 'd2', maxStops: 2 })]);
    expect(assignedOrderIds(result, 'd1')).toHaveLength(2);
    expect(assignedOrderIds(result, 'd2')).toHaveLength(2);
    expect(assignedOrderIds(result, 'nobody')).toEqual([]);
  });
});
