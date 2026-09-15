import { describe, it, expect } from 'vitest';
import {
  buildProfile,
  buildAudience,
  rankByValue,
  assembleProfiles,
  draftMarketingAudiences,
  CAMPAIGN_SEGMENTS,
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

// The A09 Marketing agent's engine (M16-FR-02 / A09): assemble the tenant's profiles from stored facts,
// then draft the audiences worth a campaign — within consent, by margin, reach stated honestly.
describe('assembleProfiles builds one profile per known customer', () => {
  const ASOF2 = '2026-08-04T00:00:00Z';
  const ordersOf = (ref: string, n: number, from = '2026-07-20T10:00:00Z'): OrderFact[] =>
    Array.from({ length: n }, (_, i) => order({
      orderId: `${ref}-O-${i}`, customerRef: ref,
      at: new Date(Date.parse(from) + i * 86_400_000).toISOString(),
    }));

  it('collects the distinct refs from orders AND consents, and honours the consent gate', () => {
    const orders = [...ordersOf('c-1', 3), ...ordersOf('c-2', 3)];
    const consents: CustomerConsent[] = [{ customerRef: 'c-1', granted: ['profiling', 'marketing'] }];
    const profiles = assembleProfiles({ orders, complaints: [], consents, purpose: 'marketing', asOf: ASOF2 });
    expect(profiles.map((p) => p.customerRef).sort()).toEqual(['c-1', 'c-2']);
    // c-1 consented → segmented; c-2 has no profiling consent → not_profiled (not dropped).
    expect(profiles.find((p) => p.customerRef === 'c-1')!.segment).toBe('regular');
    expect(profiles.find((p) => p.customerRef === 'c-2')!.segment).toBe('not_profiled');
  });
});

describe('draftMarketingAudiences drafts the campaign-worthy segments, best-margin-first', () => {
  const ASOF2 = '2026-08-04T00:00:00Z';
  const both = (ref: string): CustomerConsent => ({ customerRef: ref, granted: ['profiling', 'marketing'] });
  const profilingOnly = (ref: string): CustomerConsent => ({ customerRef: ref, granted: ['profiling'] });
  const ordersOf = (ref: string, n: number, from: string): OrderFact[] =>
    Array.from({ length: n }, (_, i) => order({
      orderId: `${ref}-O-${i}`, customerRef: ref,
      at: new Date(Date.parse(from) + i * 86_400_000).toISOString(),
    }));

  // c-loyal-A: 10 recent orders, fully consented → loyal, contactable (200_000 margin).
  // c-loyal-B: 10 recent orders, profiling consent only → loyal, NOT contactable (excluded, counted).
  // c-regular: 3 recent orders, fully consented → regular, contactable (60_000).
  // c-lapsing: 2 orders 95 days ago, fully consented → lapsing, contactable (40_000).
  // c-new: 1 recent order, fully consented → 'new' (NOT a campaign segment; never drafted).
  const orders = [
    ...ordersOf('c-loyal-A', 10, '2026-07-24T10:00:00Z'),
    ...ordersOf('c-loyal-B', 10, '2026-07-24T10:00:00Z'),
    ...ordersOf('c-regular', 3, '2026-07-28T10:00:00Z'),
    ...ordersOf('c-lapsing', 2, '2026-05-01T10:00:00Z'),
    ...ordersOf('c-new', 1, '2026-08-01T10:00:00Z'),
  ];
  const consents = [both('c-loyal-A'), profilingOnly('c-loyal-B'), both('c-regular'), both('c-lapsing'), both('c-new')];
  const profiles = assembleProfiles({ orders, complaints: [], consents, purpose: 'marketing', asOf: ASOF2 });

  it('ranks loyal → regular → lapsing by margin, and never drafts an empty or non-campaign segment', () => {
    const drafts = draftMarketingAudiences({ profiles, consents });
    expect(drafts.map((d) => d.segment)).toEqual(['loyal', 'regular', 'lapsing']);
    // 'new' is not a campaign segment; nothing empty is drafted either.
    expect(drafts.some((d) => d.segment === 'new')).toBe(false);
    expect(drafts.every((d) => d.contactable > 0)).toBe(true);
  });

  it('states reach honestly — the loyal audience is one contactable customer with one excluded for consent', () => {
    const [loyal] = draftMarketingAudiences({ profiles, consents });
    expect(loyal!.segment).toBe('loyal');
    expect(loyal!.contactable).toBe(1);
    expect(loyal!.marginMinor).toBe(200_000);
    expect(loyal!.excludedForConsent).toBe(1); // c-loyal-B matches but withheld marketing consent
  });

  it('drafts NOTHING when no one in a campaign segment can be contacted', () => {
    // Same behaviour customers, but none consented to marketing → nothing to draft.
    const noMarketing = consents.map((c) => profilingOnly(c.customerRef));
    const p2 = assembleProfiles({ orders, complaints: [], consents: noMarketing, purpose: 'marketing', asOf: ASOF2 });
    expect(draftMarketingAudiences({ profiles: p2, consents: noMarketing })).toEqual([]);
  });

  it('targets only the loyalty/win-back segments', () => {
    expect([...CAMPAIGN_SEGMENTS].sort()).toEqual(['lapsed', 'lapsing', 'loyal', 'regular']);
  });
});
