import { describe, it, expect } from 'vitest';
import {
  ShelfMap,
  planogramCompliance,
  routeKey,
  ShelfMappingError,
  type Planogram,
  type ShelfAssignment,
  type ShelfLocation,
} from '../../packages/merchandising/src/index';

// M04-FR-02/03 — shelf location sequences the picker's route, which the roadmap's
// audit calls out as a profitability lever: picking time is the largest controllable
// cost in online grocery, and it is decided by whether a shelf address sorts sensibly.

const STORE = 'store-1';

const LOCATIONS: ShelfLocation[] = [
  { storeId: STORE, locationId: 'L-A1', aisle: 1, rack: 1, bay: 1, shelf: 2, position: 1, label: 'A1' },
  { storeId: STORE, locationId: 'L-A9', aisle: 1, rack: 9, bay: 1, shelf: 1, position: 1, label: 'A9' },
  { storeId: STORE, locationId: 'L-A10', aisle: 1, rack: 10, bay: 1, shelf: 1, position: 1, label: 'A10' },
  { storeId: STORE, locationId: 'L-B3', aisle: 2, rack: 3, bay: 1, shelf: 1, position: 1, label: 'B3' },
  { storeId: STORE, locationId: 'L-CHILL', aisle: 5, rack: 1, bay: 1, shelf: 1, position: 1, zone: 'chilled' },
];

const ASSIGNMENTS: ShelfAssignment[] = [
  { storeId: STORE, productId: 'rice', locationId: 'L-B3', capacityMinor: 24, primary: true },
  { storeId: STORE, productId: 'oil', locationId: 'L-A1', capacityMinor: 18, primary: true },
  { storeId: STORE, productId: 'sugar', locationId: 'L-A9', capacityMinor: 30, primary: true },
  { storeId: STORE, productId: 'salt', locationId: 'L-A10', capacityMinor: 40, primary: true },
  { storeId: STORE, productId: 'milk', locationId: 'L-CHILL', capacityMinor: 60, primary: true },
];

function map(): ShelfMap {
  return new ShelfMap(STORE, LOCATIONS, ASSIGNMENTS);
}

describe('ShelfMap — walking the shop once', () => {
  it('orders a pick list by physical position, not by how it was typed', () => {
    const shelfMap = map();
    const route = shelfMap.routeFor([
      { productId: 'milk' },
      { productId: 'rice' },
      { productId: 'oil' },
      { productId: 'sugar' },
    ]);
    // Aisle 1 first (oil, then sugar), then aisle 2, then the chiller.
    expect(route.lines.map((r) => r.productId)).toEqual(['oil', 'sugar', 'rice', 'milk']);
    // This store has not said which zones to collect last, and the result says so rather than
    // implying a cold chain nobody asked for.
    expect(route.ordering).toContain('has not said which zones');
  });

  it('sorts A9 before A10 — the reason locations are numbers, not labels', () => {
    // As text, "A10" sorts before "A9" and the picker walks the aisle twice.
    const route = map().routeFor([{ productId: 'salt' }, { productId: 'sugar' }]);
    expect(route.lines.map((r) => r.productId)).toEqual(['sugar', 'salt']);
    expect(routeKey(LOCATIONS[1]!)).toEqual([1, 9, 1, 1, 1]);
  });

  it('puts unmapped items LAST and marks them, rather than hiding or dropping them', () => {
    const route = map().routeFor([{ productId: 'mystery' }, { productId: 'rice' }]);
    expect(route.lines.map((r) => r.productId)).toEqual(['rice', 'mystery']);
    expect(route.lines[1]?.unmapped).toBe(true);
    expect(route.lines[0]?.location?.locationId).toBe('L-B3');
    // Named, not just counted — each one is a walk back across the shop.
    expect(route.unmapped).toEqual(['mystery']);
  });

  it('collects the chiller LAST when the store has said to, whatever the aisle numbers say', () => {
    // The zone comment on `ShelfLocation` claimed since it was written that a picker collects
    // chilled last. The sort never looked at it, so the field was decoration and the milk was
    // collected wherever it happened to fall in aisle order. Found by driving it, not by reading.
    const chilledLast = new ShelfMap(STORE, [
      ...LOCATIONS,
      // Deliberately in aisle 0 — physically first, and it must still be collected last.
      { storeId: STORE, locationId: 'L-COLD', aisle: 0, rack: 1, bay: 1, shelf: 1, position: 1, zone: 'chilled' },
    ], [
      ...ASSIGNMENTS,
      { storeId: STORE, productId: 'yoghurt', locationId: 'L-COLD', capacityMinor: 20, primary: true },
    ], ['ambient', 'chilled', 'frozen']);

    const route = chilledLast.routeFor([{ productId: 'yoghurt' }, { productId: 'rice' }, { productId: 'oil' }]);
    expect(route.lines.map((r) => r.productId)).toEqual(['oil', 'rice', 'yoghurt']);
    expect(route.ordering).toContain('in the order this store set');
  });

  it('collects a zone the store never listed last, rather than first', () => {
    // Being sent for the unfamiliar thing at the end of the walk costs a minute. Being sent for it
    // first can cost a trolley of chilled goods.
    const partial = new ShelfMap(STORE, LOCATIONS, ASSIGNMENTS, ['ambient']);
    const route = partial.routeFor([{ productId: 'milk' }, { productId: 'rice' }]);
    expect(route.lines.map((r) => r.productId)).toEqual(['rice', 'milk']);
  });

  it('applies NO zone order when the store has not given one, and says so', () => {
    // Guessing a cold-chain order would be this repository deciding a licensed matter for every
    // tenant, and the wrong guess is silent: the route looks sensible and the milk is warm.
    const route = map().routeFor([{ productId: 'milk' }, { productId: 'rice' }]);
    expect(route.ordering).toBe('shelf order only — this store has not said which zones to collect last');
  });

  it('lists the locations a store has, in the order they are walked', () => {
    expect(map().allLocations().map((l) => l.locationId))
      .toEqual(['L-A1', 'L-A9', 'L-A10', 'L-B3', 'L-CHILL']);
  });

  it('names the products with no shelf address at all', () => {
    expect(map().unmappedProducts(['rice', 'mystery', 'milk'])).toEqual(['mystery']);
  });

  it('refuses a second primary location — an item lives in exactly one place', () => {
    const shelfMap = map();
    try {
      shelfMap.assign({ storeId: STORE, productId: 'rice', locationId: 'L-A1', capacityMinor: 10, primary: true });
      expect.unreachable('should have refused');
    } catch (error) {
      expect(error).toBeInstanceOf(ShelfMappingError);
      expect((error as Error).message).toContain('already has a primary location (L-B3)');
    }
    // A secondary display is fine — that is a promotion, not a contradiction.
    expect(() =>
      shelfMap.assign({ storeId: STORE, productId: 'rice', locationId: 'L-A1', capacityMinor: 10, primary: false }),
    ).not.toThrow();
    expect(shelfMap.capacityOf('rice')).toBe(34);
  });

  it('refuses a location that does not exist, or a facing that holds nothing', () => {
    expect(() =>
      map().assign({ storeId: STORE, productId: 'x', locationId: 'L-NOWHERE', capacityMinor: 5, primary: true }),
    ).toThrow(/does not exist in this store/);
    expect(() =>
      map().assign({ storeId: STORE, productId: 'x', locationId: 'L-A1', capacityMinor: 0, primary: true }),
    ).toThrow(/holds nothing/);
  });
});

describe('planogramCompliance — the empty shelf with a full stockroom', () => {
  const NOW = '2026-08-06T10:00:00.000Z';
  /** Counted a minute ago — fresh by any policy. */
  const JUST_NOW = '2026-08-06T09:59:00.000Z';
  const AS_OF = { asOf: NOW, staleAfterMinutes: 120 };
  /** A count, with the time somebody actually looked. */
  const seen = (productId: string, locationId: string, onShelfMinor: number, observedAt = JUST_NOW) =>
    ({ productId, locationId, onShelfMinor, observedAt });

  const planogram: Planogram = {
    planogramId: 'pg-1',
    storeId: STORE,
    version: 3,
    effectiveFrom: '2026-08-01',
    assignments: ASSIGNMENTS,
    createdBy: 'merch-1',
  };

  it('raises an urgent task when the shelf is empty and the stock is in the building', () => {
    const result = planogramCompliance({
      planogram,
      map: map(),
      shelfState: [
        seen('rice', 'L-B3', 0),
        seen('oil', 'L-A1', 18),
        seen('sugar', 'L-A9', 28),
        seen('salt', 'L-A10', 40),
        seen('milk', 'L-CHILL', 55),
      ],
      backstock: { rice: 100 },
      assignedRole: 'shelf-filler',
      ...AS_OF,
    });

    const empty = result.issues.find((i) => i.productId === 'rice');
    expect(empty?.finding).toBe('empty_shelf');
    // The most expensive out-of-stock there is.
    expect(empty?.detail).toContain('the sale is being lost with the stock in the building');

    const task = result.tasks.find((t) => t.productId === 'rice');
    expect(task?.priority).toBe('urgent');
    expect(task?.quantityMinor).toBe(24);
    expect(task?.assignedRole).toBe('shelf-filler');
  });

  it('distinguishes an empty shelf from an empty shop — one is a refill, one is a reorder', () => {
    const result = planogramCompliance({
      planogram,
      map: map(),
      shelfState: [seen('rice', 'L-B3', 0)],
      backstock: {},
      assignedRole: 'shelf-filler',
      ...AS_OF,
    });
    expect(result.issues.find((i) => i.productId === 'rice')?.detail)
      .toContain('this is a reorder, not a refill');
    // No task: never send someone to fetch nothing.
    expect(result.tasks.find((t) => t.productId === 'rice')).toBeUndefined();
  });

  it('brings only what the stockroom actually has, and says so', () => {
    const result = planogramCompliance({
      planogram,
      map: map(),
      shelfState: [seen('rice', 'L-B3', 4)],
      backstock: { rice: 6 },
      assignedRole: 'shelf-filler',
      ...AS_OF,
    });
    const task = result.tasks.find((t) => t.productId === 'rice');
    expect(task?.quantityMinor).toBe(6);
    expect(task?.detail).toContain('all the stockroom has; the facing holds 20 more');
  });

  it('hands tasks over in route order, so the filler walks the shop once too', () => {
    const result = planogramCompliance({
      planogram,
      map: map(),
      shelfState: [
        seen('rice', 'L-B3', 0), seen('oil', 'L-A1', 0), seen('sugar', 'L-A9', 0),
        seen('salt', 'L-A10', 0), seen('milk', 'L-CHILL', 0),
      ],
      backstock: { rice: 50, oil: 50, sugar: 50, salt: 50, milk: 50 },
      assignedRole: 'shelf-filler',
      ...AS_OF,
    });
    expect(result.tasks.map((t) => t.productId)).toEqual(['oil', 'sugar', 'salt', 'rice', 'milk']);
  });

  // ── An uncounted shelf is not an empty one ────────────────────────────────

  it('does NOT send anybody to a facing nobody has counted', () => {
    // This read `state?.onShelfMinor ?? 0`, so an uncounted facing came through as zero — which is
    // the loudest finding here: *shelf is EMPTY and the stock is in the building*. On day one,
    // before anybody had counted anything, that fired for every product in the shop and sent staff
    // to full shelves. An alarm that goes off on everything is worse than no alarm.
    const result = planogramCompliance({
      planogram,
      map: map(),
      shelfState: [],
      backstock: { rice: 50, oil: 50, sugar: 50, salt: 50, milk: 50 },
      assignedRole: 'shelf-filler',
      ...AS_OF,
    });
    expect(result.tasks).toEqual([]);
    expect(result.issues.map((i) => i.finding)).toEqual(Array(5).fill('never_counted'));
    expect(result.issues[0]?.detail).toContain('not an empty shelf, it is an unchecked one');
    expect(result.notObserved).toBe(5);
    expect(result.wholePlanObserved).toBe(false);
  });

  it('reports 0% rather than 100% when nothing has been counted', () => {
    // An empty plan is not a compliant shop; it is an unchecked one, and somebody would quote it.
    const result = planogramCompliance({
      planogram, map: map(), shelfState: [], backstock: {}, assignedRole: 'r', ...AS_OF,
    });
    expect(result.complianceBp).toBe(0);
  });

  it('refuses to act on a count that is too old, and says how old', () => {
    // Acting on a three-day-old reading wastes a walk, and after enough wasted walks the whole
    // task list stops being believed.
    const result = planogramCompliance({
      planogram,
      map: map(),
      shelfState: [seen('rice', 'L-B3', 0, '2026-08-03T10:00:00.000Z')],
      backstock: { rice: 50 },
      assignedRole: 'r',
      ...AS_OF,
    });
    const rice = result.issues.find((i) => i.productId === 'rice');
    expect(rice?.finding).toBe('last_counted_too_long_ago');
    expect(rice?.detail).toContain('minute(s) ago');
    expect(result.tasks.find((t) => t.productId === 'rice')).toBeUndefined();
  });

  it('takes the freshness window from the tenant, not from a constant', () => {
    // A shop that counts twice a day and one that counts on Sundays need different numbers.
    const state = [seen('rice', 'L-B3', 0, '2026-08-06T07:00:00.000Z')]; // three hours old
    const patient = planogramCompliance({
      planogram, map: map(), shelfState: state, backstock: { rice: 50 },
      assignedRole: 'r', asOf: NOW, staleAfterMinutes: 240,
    });
    const strict = planogramCompliance({
      planogram, map: map(), shelfState: state, backstock: { rice: 50 },
      assignedRole: 'r', asOf: NOW, staleAfterMinutes: 60,
    });
    expect(patient.tasks.map((t) => t.productId)).toContain('rice');
    expect(strict.tasks).toEqual([]);
  });

  it('leaves an unreadable observation time out rather than treating it as now', () => {
    const result = planogramCompliance({
      planogram, map: map(), shelfState: [seen('rice', 'L-B3', 0, 'not a date')],
      backstock: { rice: 50 }, assignedRole: 'r', ...AS_OF,
    });
    expect(result.issues.find((i) => i.productId === 'rice')?.finding).toBe('last_counted_too_long_ago');
    expect(result.tasks).toEqual([]);
  });

  it('measures compliance, and takes the tenant’s own refill level', () => {
    const shelfState = [
      seen('rice', 'L-B3', 24),
      seen('oil', 'L-A1', 18),
      seen('sugar', 'L-A9', 26), // 87% — fine at 50%, low at 90%
      seen('salt', 'L-A10', 16), // 40% — low either way
      seen('milk', 'L-CHILL', 60),
    ];
    const lenient = planogramCompliance({
      planogram, map: map(), shelfState, backstock: {}, assignedRole: 'r', ...AS_OF,
    });
    expect(lenient.complianceBp).toBe(8_000); // 4 of 5 at or above half full
    expect(lenient.wholePlanObserved, 'the figure only means what it says when all were counted').toBe(true);

    const strict = planogramCompliance({
      planogram, map: map(), shelfState, backstock: {}, assignedRole: 'r', refillAtBp: 9_000, ...AS_OF,
    });
    expect(strict.complianceBp).toBe(6_000); // salt and sugar now count as low
  });

  it('measures compliance over the facings actually COUNTED, not over the plan', () => {
    // Three of five counted, two of those compliant → 66%, and it says two were not counted.
    // Folding the uncounted two in either direction produces a number somebody would quote.
    const result = planogramCompliance({
      planogram,
      map: map(),
      shelfState: [seen('rice', 'L-B3', 24), seen('oil', 'L-A1', 18), seen('salt', 'L-A10', 0)],
      backstock: {},
      assignedRole: 'r',
      ...AS_OF,
    });
    expect(result.complianceBp).toBe(6_667);
    expect(result.notObserved).toBe(2);
    expect(result.wholePlanObserved).toBe(false);
  });

  it('flags more on the shelf than the facing holds', () => {
    const result = planogramCompliance({
      planogram,
      map: map(),
      shelfState: [seen('rice', 'L-B3', 40)],
      backstock: {},
      assignedRole: 'r',
      ...AS_OF,
    });
    expect(result.issues.find((i) => i.productId === 'rice')?.finding).toBe('over_capacity');
  });
});

/**
 * **SRE's own two figures, at the boundary (OB-08, 6 August 2026).**
 *
 * "Two hours" and "half empty" are only useful answers if everybody knows which side of the line
 * counts. A shop told its counts last two hours, whose counts stop working at 119 minutes, has been
 * given a different rule from the one it agreed to — and it would find out by walking.
 */
describe('two hours and half empty, at the exact line', () => {
  const NOW = '2026-08-06T10:00:00.000Z';
  const AT = (minutesAgo: number) => new Date(Date.parse(NOW) - minutesAgo * 60_000).toISOString();
  const OWNER = { asOf: NOW, staleAfterMinutes: 120, refillAtBp: 5_000 };

  const oneFacing: Planogram = {
    planogramId: 'pg-b', storeId: STORE, version: 1, effectiveFrom: '2026-08-01', createdBy: 'm',
    assignments: [{ storeId: STORE, productId: 'rice', locationId: 'L-B3', capacityMinor: 24, primary: true }],
  };

  const run = (onShelfMinor: number, minutesAgo: number) => planogramCompliance({
    planogram: oneFacing,
    map: map(),
    shelfState: [{ productId: 'rice', locationId: 'L-B3', onShelfMinor, observedAt: AT(minutesAgo) }],
    backstock: { rice: 100 },
    assignedRole: 'shelf-filler',
    ...OWNER,
  });

  it('a count exactly two hours old is still usable; a minute later it is not', () => {
    expect(run(0, 120).tasks, 'two hours exactly was treated as stale').toHaveLength(1);
    expect(run(0, 121).tasks, 'a count just past two hours still raised a task').toEqual([]);
    expect(run(0, 121).issues[0]?.finding).toBe('last_counted_too_long_ago');
  });

  it('a facing exactly half full raises no trip; below half does', () => {
    // 24 capacity: 12 is exactly half, 11 is below it.
    expect(run(12, 5).tasks, 'a half-full facing sent somebody walking').toEqual([]);
    expect(run(12, 5).complianceBp).toBe(10_000);
    expect(run(11, 5).tasks).toHaveLength(1);
    expect(run(11, 5).tasks[0]?.quantityMinor).toBe(13);
  });

  it('an empty facing is urgent, a half-empty one is not', () => {
    // The priority is what decides whether somebody walks now or on the next round.
    expect(run(0, 5).tasks[0]?.priority).toBe('urgent');
    expect(run(11, 5).tasks[0]?.priority).toBe('low');
  });
});
