import { describe, it, expect } from 'vitest';
import { readSubscriptionPlan, subscriptionStateAt, occursOn, nextOccurrences, dueToPlace, occurrenceOrderId, type SubscriptionPlan } from '../../packages/storefront/src/subscriptions';

// OB-303 · M17-FR-02: the repeat-order engine — the plan read strictly, the days it repeats on, pause / resume / cancel
// as facts, and what a run places (today and tomorrow) or names as missed (an earlier day never placed while it was on).

const plan = (over: Partial<SubscriptionPlan> = {}): SubscriptionPlan => ({
  subscriptionId: 'S1', customerRef: 'c1', lines: [{ productId: 'MILK', quantityMinor: 2 }], locationId: 'store-01',
  schedule: { kind: 'every_days', days: 2 }, startsOn: '2026-10-20', fulfilment: 'pickup', createdAt: '2026-10-19T08:00:00.000Z', ...over,
});

describe('repeat orders (OB-303)', () => {
  it('reads a plan strictly and keeps a delivery location to about 100 m', () => {
    expect(readSubscriptionPlan({ lines: [], locationId: 's', schedule: { kind: 'every_days', days: 1 }, startsOn: '2026-10-20', fulfilment: 'pickup' })).toMatchObject({ ok: false });
    expect(readSubscriptionPlan({ lines: [{ productId: 'A', quantityMinor: 1 }, { productId: 'A', quantityMinor: 2 }], locationId: 's', schedule: { kind: 'every_days', days: 1 }, startsOn: '2026-10-20', fulfilment: 'pickup' })).toMatchObject({ ok: false });
    expect(readSubscriptionPlan({ lines: [{ productId: 'A', quantityMinor: 1 }], locationId: 's', schedule: { kind: 'weekdays', weekdays: [7] }, startsOn: '2026-10-20', fulfilment: 'pickup' })).toMatchObject({ ok: false });
    expect(readSubscriptionPlan({ lines: [{ productId: 'A', quantityMinor: 1 }], locationId: 's', schedule: { kind: 'every_days', days: 1 }, startsOn: '2026-10-20', fulfilment: 'delivery' })).toMatchObject({ ok: false });
    const d = readSubscriptionPlan({ lines: [{ productId: 'A', quantityMinor: 1 }], locationId: 's', schedule: { kind: 'weekdays', weekdays: [5, 1, 1] }, startsOn: '2026-10-20', fulfilment: 'delivery', delivery: { location: { lat: 11.016_844, lon: 76.955_832 }, slotTime: '07:00' } });
    expect(d).toMatchObject({ ok: true, plan: { schedule: { kind: 'weekdays', weekdays: [1, 5] }, delivery: { location: { lat: 11.017, lon: 76.956 }, slotTime: '07:00' } } });
  });

  it('the days it repeats on', () => {
    expect(occursOn(plan(), '2026-10-19')).toBe(false);
    expect(occursOn(plan(), '2026-10-20')).toBe(true);
    expect(occursOn(plan(), '2026-10-21')).toBe(false);
    expect(nextOccurrences(plan(), '2026-10-21', 3)).toEqual(['2026-10-22', '2026-10-24', '2026-10-26']);
    // 2026-10-23 is a Friday (5), 2026-10-26 a Monday (1).
    expect(nextOccurrences(plan({ schedule: { kind: 'weekdays', weekdays: [1, 5] } }), '2026-10-21', 3)).toEqual(['2026-10-23', '2026-10-26', '2026-10-30']);
  });

  it('pause, resume and cancel are facts; cancelled stays cancelled', () => {
    const changes = [
      { subscriptionId: 'S1', change: 'paused' as const, at: '2026-10-21T00:00:00.000Z', by: 'c1' },
      { subscriptionId: 'S1', change: 'resumed' as const, at: '2026-10-23T00:00:00.000Z', by: 'c1' },
      { subscriptionId: 'S1', change: 'cancelled' as const, at: '2026-10-25T00:00:00.000Z', by: 'c1' },
      { subscriptionId: 'S1', change: 'resumed' as const, at: '2026-10-26T00:00:00.000Z', by: 'c1' },
    ];
    expect(subscriptionStateAt(changes, '2026-10-20T12:00:00.000Z')).toBe('active');
    expect(subscriptionStateAt(changes, '2026-10-22T12:00:00.000Z')).toBe('paused');
    expect(subscriptionStateAt(changes, '2026-10-24T12:00:00.000Z')).toBe('active');
    expect(subscriptionStateAt(changes, '2026-10-27T12:00:00.000Z')).toBe('cancelled');
  });

  it('a run places today and tomorrow; an earlier day never placed while on is missed; a paused or done day is not', () => {
    const p = plan({ schedule: { kind: 'every_days', days: 1 } });
    expect(dueToPlace({ plan: p, changes: [], done: new Set(['2026-10-21']), today: '2026-10-22', now: '2026-10-22T06:00:00.000Z' })).toEqual({ place: ['2026-10-22', '2026-10-23'], missed: ['2026-10-20'] });
    const paused = [{ subscriptionId: 'S1', change: 'paused' as const, at: '2026-10-19T09:00:00.000Z', by: 'c1' }];
    expect(dueToPlace({ plan: p, changes: paused, done: new Set(), today: '2026-10-22', now: '2026-10-22T06:00:00.000Z' })).toEqual({ place: [], missed: [] });
    const cancelled = [{ subscriptionId: 'S1', change: 'cancelled' as const, at: '2026-10-21T09:00:00.000Z', by: 'c1' }];
    expect(dueToPlace({ plan: p, changes: cancelled, done: new Set(), today: '2026-10-22', now: '2026-10-22T06:00:00.000Z' })).toEqual({ place: [], missed: [] });
    expect(occurrenceOrderId('S1', '2026-10-22')).toBe('SUB-S1-2026-10-22');
  });
});
