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
        { productId: 'rice', locationId: 'L-B3', onShelfMinor: 0 },
        { productId: 'oil', locationId: 'L-A1', onShelfMinor: 18 },
        { productId: 'sugar', locationId: 'L-A9', onShelfMinor: 28 },
        { productId: 'salt', locationId: 'L-A10', onShelfMinor: 40 },
        { productId: 'milk', locationId: 'L-CHILL', onShelfMinor: 55 },
      ],
      backstock: { rice: 100 },
      assignedRole: 'shelf-filler',
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
      shelfState: [{ productId: 'rice', locationId: 'L-B3', onShelfMinor: 0 }],
      backstock: {},
      assignedRole: 'shelf-filler',
    });
    expect(result.issues[0]?.detail).toContain('this is a reorder, not a refill');
    // No task: never send someone to fetch nothing.
    expect(result.tasks.find((t) => t.productId === 'rice')).toBeUndefined();
  });

  it('brings only what the stockroom actually has, and says so', () => {
    const result = planogramCompliance({
      planogram,
      map: map(),
      shelfState: [{ productId: 'rice', locationId: 'L-B3', onShelfMinor: 4 }],
      backstock: { rice: 6 },
      assignedRole: 'shelf-filler',
    });
    const task = result.tasks.find((t) => t.productId === 'rice');
    expect(task?.quantityMinor).toBe(6);
    expect(task?.detail).toContain('all the stockroom has; the facing holds 20 more');
  });

  it('hands tasks over in route order, so the filler walks the shop once too', () => {
    const result = planogramCompliance({
      planogram,
      map: map(),
      shelfState: [],
      backstock: { rice: 50, oil: 50, sugar: 50, salt: 50, milk: 50 },
      assignedRole: 'shelf-filler',
    });
    expect(result.tasks.map((t) => t.productId)).toEqual(['oil', 'sugar', 'salt', 'rice', 'milk']);
  });

  it('measures compliance, and takes the tenant’s own refill level', () => {
    const shelfState = [
      { productId: 'rice', locationId: 'L-B3', onShelfMinor: 24 },
      { productId: 'oil', locationId: 'L-A1', onShelfMinor: 18 },
      { productId: 'sugar', locationId: 'L-A9', onShelfMinor: 26 }, // 87% — fine at 50%, low at 90%
      { productId: 'salt', locationId: 'L-A10', onShelfMinor: 16 }, // 40% — low either way
      { productId: 'milk', locationId: 'L-CHILL', onShelfMinor: 60 },
    ];
    const lenient = planogramCompliance({
      planogram, map: map(), shelfState, backstock: {}, assignedRole: 'r',
    });
    expect(lenient.complianceBp).toBe(8_000); // 4 of 5 at or above half full

    const strict = planogramCompliance({
      planogram, map: map(), shelfState, backstock: {}, assignedRole: 'r', refillAtBp: 9_000,
    });
    expect(strict.complianceBp).toBe(6_000); // salt and sugar now count as low
  });

  it('flags more on the shelf than the facing holds', () => {
    const result = planogramCompliance({
      planogram,
      map: map(),
      shelfState: [{ productId: 'rice', locationId: 'L-B3', onShelfMinor: 40 }],
      backstock: {},
      assignedRole: 'r',
    });
    expect(result.issues.find((i) => i.productId === 'rice')?.finding).toBe('over_capacity');
  });
});
