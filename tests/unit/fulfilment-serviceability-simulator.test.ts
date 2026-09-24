import { describe, it, expect } from 'vitest';
import {
  simulateServiceabilityAndRouting,
  type SimScenario,
  type SimFixtures,
} from '../../packages/fulfilment/src/serviceability-simulator';
import type { FulfilmentLocation, LocationStock } from '../../packages/orders/src/fulfilment-plan';
import type { ServiceabilityPeriod } from '../../packages/storefront/src/serviceability-schedule';

// M18-FR-01/FR-03 (D08/D09): a DRY RUN of the whole delivery decision — policy in force on the date,
// store-level serviceability, then routing — over synthetic addresses/baskets/slots, so the chain is
// verifiable before live maps or the owner's final radii/slots. The simulator COMPOSES the tested
// resolveServiceabilityPolicy + checkServiceability + routeOrder and decides nothing of its own.

const STORE = { lat: 11.0168, lon: 76.9558 };
const STORE_LOC: FulfilmentLocation = {
  locationId: 'store-1', kind: 'store', lat: 11.0168, lon: 76.9558,
  acceptsPickup: true, acceptsDelivery: true, deliveryRadiusMetres: 10_000, expressMinutes: 90,
};
const DARK_LOC: FulfilmentLocation = {
  locationId: 'dark-1', kind: 'dark_store', lat: 11.0268, lon: 76.9658,
  acceptsPickup: false, acceptsDelivery: true, deliveryRadiusMetres: 6_000, expressMinutes: 30,
};
const NEARBY = { lat: 11.0300, lon: 76.9700 }; // ~2 km from the store — inside every radius here
const FAR = { lat: 11.4, lon: 77.4 };          // ~60 km away — outside any sane radius

const LINES = [{ productId: 'p-atta', quantityMinor: 2 }];
const STOCKED: LocationStock[] = [
  { locationId: 'store-1', productId: 'p-atta', availableMinor: 40 },
  { locationId: 'dark-1', productId: 'p-atta', availableMinor: 40 },
];

// A per-tenant schedule: from 2026-10-01 an 8 km radius, a ₹30 fee, free above ₹1000, ₹200 minimum.
const SCHEDULE: ServiceabilityPeriod[] = [
  { effectiveFrom: '2026-10-01', policy: { radiusMetres: 8_000, deliveryFeeMinor: 3_000, freeDeliveryAboveMinor: 100_000, minimumOrderMinor: 20_000 } },
];

const fx = (over: Partial<SimFixtures> = {}): SimFixtures => ({
  storeLocation: STORE,
  schedule: [],
  locations: [STORE_LOC, DARK_LOC],
  stock: STOCKED,
  slots: [],
  ...over,
});

const scenario = (over: Partial<SimScenario> & Pick<SimScenario, 'scenarioId'>): SimScenario => ({
  on: '2026-09-24',
  method: 'scheduled_delivery',
  deliveryLocation: NEARBY,
  basketMinor: 50_000,
  lines: LINES,
  ...over,
});

const run = (scenarios: SimScenario[], fixtures: SimFixtures = fx()) =>
  simulateServiceabilityAndRouting({ runLabel: 'dry-run', scenarios, fixtures });

describe('serviceability + routing simulator — a dry run over synthetic fixtures (M18-FR-01/FR-03)', () => {
  it('on the D08 default (no schedule), delivers inside 10 km and refuses far away — the far one is NOT flagged', () => {
    const report = run([
      scenario({ scenarioId: 'near' }),
      scenario({ scenarioId: 'far', deliveryLocation: FAR }),
    ]);
    const near = report.lines.find((l) => l.scenarioId === 'near')!;
    const far = report.lines.find((l) => l.scenarioId === 'far')!;

    expect(near.verdict).toBe('deliverable');
    expect(near.policySource).toBe('default');
    expect(near.policyEffectiveFrom).toBeNull();
    expect(near.route?.routed).toBe(true);

    expect(far.verdict).toBe('out_of_area');
    expect(far.serviceability?.outcome).toBe('out_of_area');
    expect(far.route).toBeUndefined(); // a refused order is never routed
    // A correct refusal is the system working — counted, never flagged.
    expect(report.flags).toHaveLength(0);
  });

  it('resolves the policy in force ON THE ORDER DATE, switching radius/fee on the effective-from boundary', () => {
    const report = run([
      scenario({ scenarioId: 'before', on: '2026-09-30' }),
      scenario({ scenarioId: 'on', on: '2026-10-01' }),
    ], fx({ schedule: SCHEDULE }));
    const before = report.lines.find((l) => l.scenarioId === 'before')!;
    const on = report.lines.find((l) => l.scenarioId === 'on')!;

    // The day before the period → the D08 default (no fee).
    expect(before.policySource).toBe('default');
    expect(before.verdict).toBe('deliverable');
    expect(before.deliveryFeeMinor).toBe(0);

    // On the effective-from day → the scheduled policy (₹30 fee).
    expect(on.policySource).toBe('scheduled');
    expect(on.policyEffectiveFrom).toBe('2026-10-01');
    expect(on.verdict).toBe('deliverable');
    expect(on.deliveryFeeMinor).toBe(3_000);
  });

  it('refuses a basket below the scheduled minimum, and does not flag it', () => {
    const report = run([
      scenario({ scenarioId: 'small', on: '2026-10-01', basketMinor: 5_000 }),
    ], fx({ schedule: SCHEDULE }));
    const line = report.lines[0]!;
    expect(line.verdict).toBe('below_minimum');
    expect(line.serviceability?.outcome).toBe('below_minimum');
    expect(line.route).toBeUndefined();
    expect(report.flags).toHaveLength(0);
  });

  it('FLAGS a serviceable address that no location can fill — the config inconsistency, not a route', () => {
    // Store says "we deliver here" (inside 10 km) but nothing is in stock anywhere.
    const report = run([scenario({ scenarioId: 'no-stock' })], fx({ stock: [] }));
    const line = report.lines[0]!;
    expect(line.serviceability?.serviceable).toBe(true);
    expect(line.verdict).toBe('unroutable');
    expect(line.route?.routed).toBe(false);
    expect(line.deliveryFeeMinor).toBe(0);
    expect(report.flags).toEqual([
      { scenarioId: 'no-stock', detail: expect.stringContaining('inside the delivery area but no location can fill it') },
    ]);
  });

  it('routes a pickup with no delivery address, and flags a pickup no location can fulfil', () => {
    const ok = run([scenario({ scenarioId: 'pick', method: 'pickup', deliveryLocation: undefined })]);
    const okLine = ok.lines[0]!;
    expect(okLine.verdict).toBe('pickup_ready');
    expect(okLine.serviceability).toBeUndefined(); // pickup has no delivery-address gate
    expect(okLine.route?.locationId).toBe('store-1');
    expect(okLine.tellTheCustomer).toContain('collect');
    expect(ok.flags).toHaveLength(0);

    // Only a dark store available → no shop floor to collect from → flagged.
    const bad = run(
      [scenario({ scenarioId: 'pick-bad', method: 'pickup', deliveryLocation: undefined })],
      fx({ locations: [DARK_LOC] }),
    );
    expect(bad.lines[0]!.verdict).toBe('unroutable');
    expect(bad.flags[0]!.scenarioId).toBe('pick-bad');
  });

  it('an express promise nothing can meet is unroutable-and-flagged; a slower promise is deliverable', () => {
    const tight = run([
      scenario({ scenarioId: 'x-tight', method: 'express_delivery', expressPromiseMinutes: 20 }),
    ]);
    expect(tight.lines[0]!.verdict).toBe('unroutable'); // store 90 min, dark 30 min — neither ≤ 20
    expect(tight.flags[0]!.detail).toContain('express');

    const ok = run([
      scenario({ scenarioId: 'x-ok', method: 'express_delivery', expressPromiseMinutes: 30 }),
    ]);
    expect(ok.lines[0]!.verdict).toBe('deliverable'); // dark store does 30 ≤ 30
    expect(ok.flags).toHaveLength(0);
  });

  it('a delivery scenario with no address is flagged, never silently skipped', () => {
    const report = run([scenario({ scenarioId: 'no-addr', deliveryLocation: undefined })]);
    expect(report.lines[0]!.verdict).toBe('unroutable');
    expect(report.flags[0]!.detail).toContain('no address');
  });

  it('sums the report: totals by verdict, fees only on deliverable orders, straight-line distances declared', () => {
    const report = run([
      scenario({ scenarioId: 'd', on: '2026-10-01' }),                       // deliverable, ₹30 fee
      scenario({ scenarioId: 'oa', on: '2026-10-01', deliveryLocation: FAR }), // out of area
      scenario({ scenarioId: 'bm', on: '2026-10-01', basketMinor: 5_000 }),  // below minimum
      scenario({ scenarioId: 'p', method: 'pickup', deliveryLocation: undefined }), // pickup ready
    ], fx({ schedule: SCHEDULE }));

    expect(report.totals).toEqual({
      scenarios: 4,
      deliverable: 1,
      pickupReady: 1,
      outOfArea: 1,
      belowMinimum: 1,
      unroutable: 0,
      totalDeliveryFeeMinor: 3_000, // only the one deliverable order's fee
    });
    expect(report.distancesAre).toBe('straight_line');
    expect(report.runLabel).toBe('dry-run');
  });

  it('is deterministic — the same fixtures and scenarios produce an identical report', () => {
    const scenarios = [
      scenario({ scenarioId: 'a', on: '2026-10-01' }),
      scenario({ scenarioId: 'b', deliveryLocation: FAR }),
      scenario({ scenarioId: 'c', method: 'pickup', deliveryLocation: undefined }),
    ];
    const first = run([...scenarios], fx({ schedule: SCHEDULE }));
    const second = run([...scenarios], fx({ schedule: SCHEDULE }));
    expect(second).toEqual(first);
  });
});
