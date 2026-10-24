import { describe, it, expect } from 'vitest';
import { readTiers, tierFor, withMultiplier, twelveMonthsBefore, pointsExpiry, addMonths, type LoyaltyTier } from '../../packages/loyalty/src/index';

// OB-295 · M17-FR-01 · D07-FR-03: the tier engine (12-month spend, multiplier, falling back by itself) and the points
// expiry engine (lots, oldest first, once, nothing when not set).

const silver: LoyaltyTier = { tierId: 'silver', name: 'Silver', minSpend12mMinor: 100_000, multiplierBps: 15_000 };
const gold: LoyaltyTier = { tierId: 'gold', name: 'Gold', minSpend12mMinor: 500_000, multiplierBps: 20_000 };

describe('loyalty tiers (OB-295)', () => {
  it('reads a ladder that rises; an empty list is "tiers off"', () => {
    expect(readTiers([silver, gold])).toEqual({ ok: true, tiers: [silver, gold] });
    expect(readTiers([])).toEqual({ ok: true, tiers: [] });
    expect(readTiers('gold')).toMatchObject({ ok: false, problem: 'not_a_list' });
    expect(readTiers([gold, silver])).toMatchObject({ ok: false, problem: 'thresholds_not_rising' });
    expect(readTiers([silver, { ...gold, multiplierBps: 12_000 }])).toMatchObject({ ok: false, problem: 'multipliers_not_rising' });
    expect(readTiers([{ ...silver, multiplierBps: 9_000 }])).toMatchObject({ ok: false, problem: 'multiplier_out_of_range' });
    expect(readTiers([silver, { ...gold, tierId: 'silver' }])).toMatchObject({ ok: false, problem: 'tier_id_repeated' });
    expect(readTiers([{ ...silver, minSpend12mMinor: 1.5 }])).toMatchObject({ ok: false, problem: 'tier_unreadable' });
    expect(readTiers(Array.from({ length: 7 }, (_, i) => ({ ...silver, tierId: `t${i}`, name: `T${i}`, minSpend12mMinor: i })))).toMatchObject({ ok: false, problem: 'too_many_tiers' });
  });

  it('the tier a spend reaches, the next one up, and base points with no tiers', () => {
    expect(tierFor([silver, gold], 99_999)).toMatchObject({ tier: null, multiplierBps: 10_000, next: { tier: silver, moreSpendMinor: 1 } });
    expect(tierFor([silver, gold], 100_000)).toMatchObject({ tier: silver, multiplierBps: 15_000, next: { tier: gold, moreSpendMinor: 400_000 } });
    const top = tierFor([silver, gold], 900_000);
    expect(top.tier).toEqual(gold);
    expect(top.next).toBeUndefined();
    expect(tierFor([], 900_000)).toMatchObject({ tier: null, multiplierBps: 10_000, tiersSet: false });
  });

  it('whole points after the multiplier, rounded down; never below the base', () => {
    expect(withMultiplier(12, 15_000)).toBe(18);
    expect(withMultiplier(13, 15_000)).toBe(19);
    expect(withMultiplier(7, 5_000)).toBe(7);
    expect(withMultiplier(0, 20_000)).toBe(0);
  });

  it('the 12-month window ends at the bill (the bill does not count towards its own tier)', () => {
    expect(twelveMonthsBefore('2026-10-23T10:00:00.000Z')).toEqual({ from: '2025-10-23T10:00:00.000Z', to: '2026-10-23T10:00:00.000Z' });
  });
});

describe('points expiry (OB-295)', () => {
  const m = (movementId: string, delta: number, at: string, reason = delta > 0 ? 'earn' : 'burn', sourceRef: string | null = null) => ({ movementId, delta, at, reason, sourceRef });

  it('nothing expires when the months are not set', () => {
    expect(pointsExpiry({ movements: [m('e1', 100, '2020-01-01T00:00:00.000Z')], expiryMonths: 0, asOf: '2026-10-23T00:00:00.000Z' })).toMatchObject({ due: [], upcoming: [], balance: 100 });
  });

  it('what is left of the oldest lot expires N months after it arrived; spends come off the oldest first', () => {
    const out = pointsExpiry({
      movements: [m('e1', 100, '2025-01-10T00:00:00.000Z'), m('b1', -30, '2025-03-01T00:00:00.000Z'), m('e2', 50, '2025-09-01T00:00:00.000Z'), m('b2', -40, '2026-02-01T00:00:00.000Z')],
      expiryMonths: 12, asOf: '2026-03-01T00:00:00.000Z',
    });
    // e1 held 70 when its year ended (2026-01-10); b2 later took from e2.
    expect(out.due).toEqual([{ lotMovementId: 'e1', earnedAt: '2025-01-10T00:00:00.000Z', expiresAt: '2026-01-10T00:00:00.000Z', points: 70, expiryMovementId: 'expiry-e1' }]);
    expect(out.upcoming).toEqual([{ lotMovementId: 'e2', expiresAt: '2026-09-01T00:00:00.000Z', points: 10 }]);
  });

  it('a recorded expiry is never repeated, and the next lot expires on its own day', () => {
    const movements = [
      m('e1', 100, '2025-01-10T00:00:00.000Z'), m('e2', 50, '2025-02-10T00:00:00.000Z'),
      m('expiry-e1', -100, '2026-01-11T00:00:00.000Z', 'expiry', 'lot:e1'),
    ];
    expect(pointsExpiry({ movements, expiryMonths: 12, asOf: '2026-02-01T00:00:00.000Z' }).due).toEqual([]);
    expect(pointsExpiry({ movements, expiryMonths: 12, asOf: '2026-02-10T00:00:00.000Z' }).due.map((d) => [d.lotMovementId, d.points])).toEqual([['e2', 50]]);
  });

  it('a month that is shorter clamps to its last day', () => {
    expect(addMonths('2025-01-31T09:00:00.000Z', 1)).toBe('2025-02-28T09:00:00.000Z');
    expect(addMonths('2024-02-29T00:00:00.000Z', 12)).toBe('2025-02-28T00:00:00.000Z');
  });
});
