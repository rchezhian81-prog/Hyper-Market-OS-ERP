import { describe, it, expect } from 'vitest';
import {
  proposeConstrainedOrder,
  InvalidConstrainedOrderError,
  type ForecastPoint,
} from '../../packages/replenishment/src/constrained-order';

// D-2 forecast-driven, constraint-aware order proposal — cover forecast demand from the next supplier
// delivery to the one after, rounded to whole cases / pallets, netting stock and open orders. Advisory only.

/** A flat forecast of `perDay` over the days [from .. from+days). */
const flat = (from: string, days: number, perDay: number): ForecastPoint[] => {
  const start = Math.floor(Date.parse(`${from}T00:00:00.000Z`) / 86_400_000);
  return Array.from({ length: days }, (_, i) => ({ day: new Date((start + i) * 86_400_000).toISOString().slice(0, 10), qty: perDay }));
};

describe('proposeConstrainedOrder', () => {
  it('orders to cover forecast demand from the next delivery to the one after', () => {
    // 10/day, deliveries 3 days apart → cover window is 30 units; nothing on hand at arrival.
    const p = proposeConstrainedOrder({
      productId: 'MILK', onHand: 0, forecast: flat('2026-08-12', 10, 10),
      upcomingDeliveries: ['2026-08-14', '2026-08-17'], asOf: '2026-08-12',
    });
    expect(p.reason).toBe('ordered');
    expect(p.arrivesOn).toBe('2026-08-14');
    expect(p.coversUntil).toBe('2026-08-17');
    expect(p.coverDemand).toBe(30); // 3 days × 10
    expect(p.suggestedQty).toBe(30);
    expect(p.advisoryOnly).toBe(true);
  });

  it('nets stock and open orders that will still be on hand when the order lands', () => {
    // 10/day; demand to arrival (2 days) = 20; onHand 30 + onOrder 10 = 40 → 20 left at arrival; cover 30 → order 10.
    const p = proposeConstrainedOrder({
      productId: 'MILK', onHand: 30, onOrder: 10, forecast: flat('2026-08-12', 10, 10),
      upcomingDeliveries: ['2026-08-14', '2026-08-17'], asOf: '2026-08-12',
    });
    expect(p.projectedOnHandAtArrival).toBe(20);
    expect(p.requiredQty).toBe(10); // 30 cover − 20 on hand
    expect(p.suggestedQty).toBe(10);
  });

  it('proposes nothing when stock at arrival already covers the window', () => {
    const p = proposeConstrainedOrder({
      productId: 'MILK', onHand: 100, forecast: flat('2026-08-12', 10, 10),
      upcomingDeliveries: ['2026-08-14', '2026-08-17'], asOf: '2026-08-12',
    });
    expect(p.reason).toBe('covered');
    expect(p.suggestedQty).toBe(0);
  });

  it('rounds up to whole cases and reports the pallet + loose-case breakdown', () => {
    // cover 30, unitsPerCase 12 → ceil(30/12)*12 = 36 (3 cases); casesPerPallet 2 → 1 pallet + 1 case.
    const p = proposeConstrainedOrder({
      productId: 'MILK', onHand: 0, forecast: flat('2026-08-12', 10, 10),
      upcomingDeliveries: ['2026-08-14', '2026-08-17'], asOf: '2026-08-12',
      unitsPerCase: 12, casesPerPallet: 2,
    });
    expect(p.suggestedQty).toBe(36);
    expect(p.cases).toBe(3);
    expect(p.pallets).toBe(1);
    expect(p.looseCases).toBe(1);
  });

  it('raises to the supplier minimum, still in whole cases', () => {
    // cover 30 → 3 cases of 12 = 36; but MOQ 60 → ceil(60/12)*12 = 60 (5 cases).
    const p = proposeConstrainedOrder({
      productId: 'MILK', onHand: 0, forecast: flat('2026-08-12', 10, 10),
      upcomingDeliveries: ['2026-08-14', '2026-08-17'], asOf: '2026-08-12',
      unitsPerCase: 12, minOrderQty: 60,
    });
    expect(p.suggestedQty).toBe(60);
    expect(p.cases).toBe(5);
  });

  it('cannot size an order without at least two upcoming deliveries', () => {
    const p = proposeConstrainedOrder({
      productId: 'MILK', onHand: 0, forecast: flat('2026-08-12', 10, 10),
      upcomingDeliveries: ['2026-08-14'], asOf: '2026-08-12',
    });
    expect(p.reason).toBe('no_supplier_calendar');
    expect(p.suggestedQty).toBe(0);
  });

  it('rejects malformed input', () => {
    const good = { productId: 'MILK', onHand: 0, forecast: [], upcomingDeliveries: ['2026-08-14', '2026-08-17'], asOf: '2026-08-12' };
    expect(() => proposeConstrainedOrder({ ...good, asOf: 'nope' })).toThrow(InvalidConstrainedOrderError);
    expect(() => proposeConstrainedOrder({ ...good, unitsPerCase: 0 })).toThrow(InvalidConstrainedOrderError);
    expect(() => proposeConstrainedOrder({ ...good, upcomingDeliveries: ['2026-08-14', 'nope'] })).toThrow(InvalidConstrainedOrderError);
  });
});
