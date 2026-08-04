import { describe, it, expect } from 'vitest';
import {
  buildProfile,
  buildAudience,
  rankByValue,
  type OrderFact,
  type CustomerConsent,
} from '../../packages/customer/src/segments';

// M16-FR-04: "derived and consent-scoped; NO PROFILING WITHOUT A LAWFUL BASIS (PRV)."

const order = (over: Partial<OrderFact>): OrderFact => ({
  orderId: 'O-1',
  customerRef: 'c-1',
  at: '2026-07-01T10:00:00Z',
  netMinor: 100_000,
  marginMinor: 20_000,
  channel: 'store',
  ...over,
});

const CONSENTED: CustomerConsent = { customerRef: 'c-1', granted: ['profiling', 'marketing'] };
const ASOF = '2026-08-04T00:00:00Z';

describe('no profiling without a lawful basis (M16-FR-04 / PRV)', () => {
  const orders = Array.from({ length: 4 }, (_, i) =>
    order({ orderId: `O-${i}`, at: `2026-07-2${i}T10:00:00Z` }),
  );

  it('REFUSES TO SEGMENT a customer who has not consented — and says so instead of hiding them', () => {
    const profile = buildProfile({ customerRef: 'c-1', orders, purpose: 'marketing', asOf: ASOF });
    expect(profile.segment).toBe('not_profiled');
    expect(profile.detail).toContain('has not consented to profiling');
    expect(profile.detail).toContain('so the campaign reach is honest');
    // The facts are still computed — they are facts, not inferences.
    expect(profile.orderCount).toBe(4);
    expect(profile.lifetimeMarginMinor).toBe(80_000);
  });

  it('refuses when consent was granted and then WITHDRAWN', () => {
    const profile = buildProfile({
      customerRef: 'c-1', orders, purpose: 'marketing', asOf: ASOF,
      consent: { ...CONSENTED, withdrawnAt: '2026-08-01T00:00:00Z' },
    });
    expect(profile.segment).toBe('not_profiled');
  });

  it('STILL BUILDS THE PROFILE FOR SERVICE — answering a complaint is not marketing', () => {
    const profile = buildProfile({ customerRef: 'c-1', orders, purpose: 'service', asOf: ASOF });
    expect(profile.segment).toBe('regular');
    expect(profile.detail).toContain('4 orders');
  });

  it('segments a consenting customer', () => {
    const profile = buildProfile({ customerRef: 'c-1', orders, consent: CONSENTED, purpose: 'profiling', asOf: ASOF });
    expect(profile.segment).toBe('regular');
  });
});

describe('the segments themselves, all per-tenant', () => {
  const consented = { consent: CONSENTED, purpose: 'profiling' as const, asOf: ASOF };

  it('new, regular and loyal by order count', () => {
    expect(buildProfile({ customerRef: 'c-1', orders: [order({ at: '2026-08-01T10:00:00Z' })], ...consented }).segment).toBe('new');
    expect(
      buildProfile({
        customerRef: 'c-1',
        orders: Array.from({ length: 12 }, (_, i) => order({ orderId: `O-${i}`, at: '2026-08-01T10:00:00Z' })),
        ...consented,
      }).segment,
    ).toBe('loyal');
  });

  it('lapsing and lapsed by recency', () => {
    const old = Array.from({ length: 4 }, (_, i) => order({ orderId: `O-${i}`, at: '2026-05-20T10:00:00Z' }));
    expect(buildProfile({ customerRef: 'c-1', orders: old, ...consented }).segment).toBe('lapsing');

    const ancient = Array.from({ length: 4 }, (_, i) => order({ orderId: `O-${i}`, at: '2025-11-01T10:00:00Z' }));
    const lapsed = buildProfile({ customerRef: 'c-1', orders: ancient, ...consented });
    expect(lapsed.segment).toBe('lapsed');
    expect(lapsed.daysSinceLastOrder).toBe(275);
  });

  it('says INSUFFICIENT HISTORY rather than guessing', () => {
    const profile = buildProfile({
      customerRef: 'c-1', orders: [order({})], ...consented,
      policy: { minimumHistory: 3 },
    });
    expect(profile.segment).toBe('insufficient_history');
    expect(profile.detail).toContain('would not be a guess');
  });

  it('honours the tenant\'s own boundaries', () => {
    const orders = Array.from({ length: 5 }, (_, i) => order({ orderId: `O-${i}`, at: '2026-08-01T10:00:00Z' }));
    expect(buildProfile({ customerRef: 'c-1', orders, ...consented, policy: { loyalAtOrders: 5 } }).segment).toBe('loyal');
  });
});

describe('value is margin, and a ratio that means nothing says so', () => {
  it('computes exact basis points and the average basket', () => {
    const profile = buildProfile({
      customerRef: 'c-1',
      orders: [
        order({ orderId: 'O-1', netMinor: 100_000, marginMinor: 30_000 }),
        order({ orderId: 'O-2', netMinor: 60_000, marginMinor: 12_000 }),
      ],
      consent: CONSENTED, purpose: 'profiling', asOf: ASOF,
    });
    expect(profile.lifetimeRevenueMinor).toBe(160_000);
    expect(profile.lifetimeMarginMinor).toBe(42_000);
    expect(profile.marginBps).toBe(2_625); // 26.25%, exact
    expect(profile.averageBasketMinor).toBe(80_000);
  });

  it('returns not_meaningful rather than zero or Infinity', () => {
    const none = buildProfile({ customerRef: 'c-none', orders: [], consent: CONSENTED, purpose: 'profiling', asOf: ASOF });
    expect(none.averageBasketMinor).toBe('not_meaningful');
    expect(none.marginBps).toBe('not_meaningful');
  });

  it('RANKS BY MARGIN, NOT REVENUE — the cigarette customer is not the best customer', () => {
    const cigarettes = buildProfile({
      customerRef: 'c-cigs',
      orders: [order({ customerRef: 'c-cigs', netMinor: 5_000_000, marginMinor: 200_000 })], // ₹50,000 at 4%
      consent: { customerRef: 'c-cigs', granted: ['profiling'] }, purpose: 'profiling', asOf: ASOF,
    });
    const fresh = buildProfile({
      customerRef: 'c-fresh',
      orders: [order({ customerRef: 'c-fresh', netMinor: 2_000_000, marginMinor: 600_000 })], // ₹20,000 at 30%
      consent: { customerRef: 'c-fresh', granted: ['profiling'] }, purpose: 'profiling', asOf: ASOF,
    });

    const ranked = rankByValue([cigarettes, fresh]);
    expect(ranked.map((r) => r.customerRef)).toEqual(['c-fresh', 'c-cigs']);
    // And it states both numbers, so the difference is visible.
    expect(ranked[0]?.detail).toContain('600000 of margin on 2000000 of spend (30.00%)');
    expect(ranked[1]?.detail).toContain('(4.00%)');
  });

  it('leaves un-profiled customers out of a value ranking entirely', () => {
    const unconsented = buildProfile({ customerRef: 'c-x', orders: [order({ customerRef: 'c-x' })], purpose: 'marketing', asOf: ASOF });
    expect(rankByValue([unconsented])).toEqual([]);
  });
});

describe('an audience always reports who it could not reach', () => {
  const profiles = ['c-1', 'c-2', 'c-3'].map((ref) =>
    buildProfile({
      customerRef: ref,
      orders: Array.from({ length: 4 }, (_, i) => order({ orderId: `${ref}-${i}`, customerRef: ref, at: '2026-08-01T10:00:00Z' })),
      consent: { customerRef: ref, granted: ['profiling'] },
      purpose: 'profiling',
      asOf: ASOF,
    }),
  );

  it('needs MARKETING consent as well as profiling consent', () => {
    const audience = buildAudience({
      segment: 'regular',
      purpose: 'marketing',
      profiles,
      consents: [
        { customerRef: 'c-1', granted: ['profiling', 'marketing'] },
        { customerRef: 'c-2', granted: ['profiling'] }, // analysed, but not contactable
        { customerRef: 'c-3', granted: ['profiling', 'marketing'], withdrawnAt: '2026-08-02T00:00:00Z' },
      ],
    });
    expect(audience.customerRefs).toEqual(['c-1']);
    expect(audience.excludedForConsent).toBe(2);
    expect(audience.detail).toContain('2 more match but have not consented to marketing');
  });

  it('reports a clean audience without an exclusion note', () => {
    const audience = buildAudience({
      segment: 'regular',
      purpose: 'marketing',
      profiles,
      consents: profiles.map((p) => ({ customerRef: p.customerRef, granted: ['profiling', 'marketing'] as const })),
    });
    expect(audience.excludedForConsent).toBe(0);
    expect(audience.detail).toBe('3 customer(s) in "regular"');
    expect(audience.marginMinor).toBe(240_000);
  });

  it('lets the service desk reach anyone in the segment', () => {
    const audience = buildAudience({ segment: 'regular', purpose: 'service', profiles, consents: [] });
    expect(audience.customerRefs).toHaveLength(3);
    expect(audience.excludedForConsent).toBe(0);
  });
});
