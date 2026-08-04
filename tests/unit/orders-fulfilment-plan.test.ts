import { describe, it, expect } from 'vitest';
import {
  metresBetween,
  routeOrder,
  assessContribution,
  type FulfilmentLocation,
  type LocationStock,
  type SlotCapacity,
} from '../../packages/orders/src/fulfilment-plan';

// M18-FR-03 acceptance: "a pickup and a delivery order each route correctly; A FULL SLOT
// OFFERS AN ALTERNATIVE; capacity-aware slotting; contribution-aware (D09)."

const STORE: FulfilmentLocation = {
  locationId: 'store-1', kind: 'store', lat: 11.0168, lon: 76.9558,
  acceptsPickup: true, acceptsDelivery: true, deliveryRadiusMetres: 10_000, expressMinutes: 90,
};
const DARK: FulfilmentLocation = {
  locationId: 'dark-1', kind: 'dark_store', lat: 11.0268, lon: 76.9658,
  acceptsPickup: false, acceptsDelivery: true, deliveryRadiusMetres: 6_000, expressMinutes: 30,
};
const NEARBY = { lat: 11.0300, lon: 76.9700 };
const FAR = { lat: 11.4, lon: 77.4 };

const LINES = [{ productId: 'p-atta', quantityMinor: 2 }];
const STOCKED: LocationStock[] = [
  { locationId: 'store-1', productId: 'p-atta', availableMinor: 40 },
  { locationId: 'dark-1', productId: 'p-atta', availableMinor: 40 },
];

function route(over: Partial<Parameters<typeof routeOrder>[0]> = {}) {
  return routeOrder({
    orderId: 'O-1',
    method: 'scheduled_delivery',
    deliverTo: NEARBY,
    lines: LINES,
    locations: [STORE, DARK],
    stock: STOCKED,
    slots: [],
    ...over,
  });
}

describe('routing states its reason rather than defaulting to the nearest shop (M18-FR-03)', () => {
  it('measures distance in whole metres', () => {
    expect(metresBetween(STORE, STORE)).toBe(0);
    expect(metresBetween(STORE, NEARBY)).toBeGreaterThan(1_500);
  });

  it('routes a delivery to the nearest location with the whole order in stock', () => {
    const result = route();
    expect(result.routed).toBe(true);
    expect(result.locationId).toBe('dark-1');
    expect(result.detail).toContain('nearest with the whole order in stock and room in the slot');
  });

  it('NEVER routes a pickup to a dark store — there is no shop floor to walk into', () => {
    const result = route({ method: 'pickup', locations: [DARK], deliverTo: undefined });
    expect(result.routed).toBe(false);
    expect(result.outcome).toBe('pickup_not_available_here');
    expect(result.detail).toContain('no shop floor for a customer to walk into');

    // With a real store available, it routes.
    const ok = route({ method: 'pickup', deliverTo: undefined });
    expect(ok.routed).toBe(true);
    expect(ok.locationId).toBe('store-1');
    expect(ok.detail).toContain('customer collects');
  });

  it('refuses an address outside every radius, naming the nearest and its limit', () => {
    const result = route({ deliverTo: FAR });
    expect(result.outcome).toBe('no_location_in_range');
    expect(result.detail).toContain('km away and its radius is');
  });

  it('refuses when no single location holds the whole order — splitting is a decision', () => {
    const result = route({
      stock: [
        { locationId: 'store-1', productId: 'p-atta', availableMinor: 1 },
        { locationId: 'dark-1', productId: 'p-atta', availableMinor: 1 },
      ],
    });
    expect(result.outcome).toBe('no_location_with_stock');
    expect(result.detail).toContain('splitting it is a decision, not a default');
    expect(result.alternatives).toHaveLength(2);
  });

  it('CAPACITY IS REAL — a full slot falls through to the next location', () => {
    const slots: SlotCapacity[] = [
      { slotId: 's-dark', locationId: 'dark-1', method: 'scheduled_delivery', capacity: 8, booked: 8 },
      { slotId: 's-store', locationId: 'store-1', method: 'scheduled_delivery', capacity: 8, booked: 2 },
    ];
    const result = route({ slots });
    expect(result.routed).toBe(true);
    expect(result.locationId).toBe('store-1');
  });

  it('offers alternatives when EVERY location is full, rather than an error', () => {
    const slots: SlotCapacity[] = [
      { slotId: 's-dark', locationId: 'dark-1', method: 'scheduled_delivery', capacity: 8, booked: 8 },
      { slotId: 's-store', locationId: 'store-1', method: 'scheduled_delivery', capacity: 8, booked: 8 },
    ];
    const result = route({ slots });
    expect(result.routed).toBe(false);
    expect(result.outcome).toBe('slot_full');
    expect(result.alternatives.map((a) => a.locationId).sort()).toEqual(['dark-1', 'store-1']);
    expect(result.alternatives[0]?.detail).toContain('offer another slot');
  });

  it('EXPRESS NEEDS A LOCATION THAT CAN ACTUALLY DO IT IN TIME', () => {
    // Only the dark store can do 30 minutes; the store needs 90.
    const achievable = route({ method: 'express_delivery', expressPromiseMinutes: 45 });
    expect(achievable.routed).toBe(true);
    expect(achievable.locationId).toBe('dark-1');

    const impossible = route({
      method: 'express_delivery',
      expressPromiseMinutes: 20,
    });
    expect(impossible.routed).toBe(false);
    expect(impossible.outcome).toBe('express_not_achievable');
    expect(impossible.detail).toContain('a promise the shop will break');
    expect(impossible.alternatives[0]?.detail).toContain('offer this as scheduled instead');
  });
});

describe('an unprofitable drop is flagged, never blocked (D09)', () => {
  it('reports a healthy drop with its delivery-cost share', () => {
    const result = assessContribution({
      orderId: 'O-1', itemsMarginMinor: 20_000, deliveryFeeChargedMinor: 4_000,
      deliveryCostMinor: 6_000, distanceMetres: 2_400, orderValueMinor: 100_000,
    });
    expect(result.profitable).toBe(true);
    expect(result.contributionMinor).toBe(18_000);
    expect(result.deliveryCostBps).toBe(600);
    expect(result.flagged).toBe(false);
  });

  it('SAYS SO PLAINLY when the drop loses money, and does not block it', () => {
    const result = assessContribution({
      orderId: 'O-2', itemsMarginMinor: 3_000, deliveryFeeChargedMinor: 0,
      deliveryCostMinor: 9_000, distanceMetres: 8_900, orderValueMinor: 20_000,
    });
    expect(result.profitable).toBe(false);
    expect(result.contributionMinor).toBe(-6_000);
    expect(result.detail).toContain('Take it if you want the customer, but take it knowingly');
  });

  it('flags a drop that still contributes but breaches the tenant ceiling', () => {
    const result = assessContribution({
      orderId: 'O-3', itemsMarginMinor: 20_000, deliveryFeeChargedMinor: 0,
      deliveryCostMinor: 9_000, distanceMetres: 8_000, orderValueMinor: 50_000,
      costCeilingBps: 1_000,
    });
    expect(result.profitable).toBe(true);
    expect(result.flagged).toBe(true);
    expect(result.detail).toContain('this pattern does not scale');
  });

  it('returns not_meaningful rather than dividing by zero', () => {
    const result = assessContribution({
      orderId: 'O-4', itemsMarginMinor: 0, deliveryFeeChargedMinor: 0,
      deliveryCostMinor: 0, distanceMetres: 0, orderValueMinor: 0,
    });
    expect(result.deliveryCostBps).toBe('not_meaningful');
  });
});
