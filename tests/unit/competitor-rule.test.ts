import { describe, it, expect } from 'vitest';
import {
  COMPETITOR_RULE_DEFAULTS, competitorRuleProblem, draftFromCompetitors, latestPerCompetitor,
  type ProductPriceFacts,
} from '../../packages/pricing/src/competitor-rule';

// D-18 (R4, OB-216): a competitor 5% or more below the shop, seen under 14 days ago, DRAFTS a price change — never above
// MRP, never below cost or the margin floor ("draft refused: below margin floor"); an old sighting is not used ("sighting
// too old"); both figures are settings. The engine applies nothing.

const NOW = '2026-10-19T06:00:00.000Z';
const daysAgo = (n: number) => new Date(Date.parse(NOW) - n * 86_400_000).toISOString();
const facts = (over: Partial<ProductPriceFacts> = {}): ProductPriceFacts => ({
  productId: 'p-tea', storeId: 'store-1', ourPriceMinor: 10_000, mrpMinor: 10_500, costMinor: 7_000, marginFloorBps: 2_000, currency: 'INR',
  sightings: [{ observationId: 'o1', competitor: 'Shop A', priceMinor: 9_400, observedAt: daysAgo(2) }], ...over,
});

describe('D-18 — competitor prices draft a price change (OB-216)', () => {
  it('defaults to the owner\'s 5% / 14 days', () => {
    expect(COMPETITOR_RULE_DEFAULTS).toEqual({ gapBps: 500, maxAgeDays: 14 });
  });

  it('a competitor 6% below, seen 2 days ago, drafts a change to its price — for a person, applying nothing', () => {
    const out = draftFromCompetitors(facts(), COMPETITOR_RULE_DEFAULTS, NOW);
    expect(out.draft).toMatchObject({ productId: 'p-tea', fromPriceMinor: 10_000, draftPriceMinor: 9_400, competitor: 'Shop A', ageDays: 2, gapBps: 600, cappedAtMrp: false });
    expect(out.notDrafted).toEqual([]);
  });

  it('exactly 5% below drafts; 4.9% below does not', () => {
    expect(draftFromCompetitors(facts({ sightings: [{ observationId: 'o', competitor: 'A', priceMinor: 9_500, observedAt: daysAgo(1) }] }), COMPETITOR_RULE_DEFAULTS, NOW).draft?.draftPriceMinor).toBe(9_500);
    const near = draftFromCompetitors(facts({ sightings: [{ observationId: 'o', competitor: 'A', priceMinor: 9_510, observedAt: daysAgo(1) }] }), COMPETITOR_RULE_DEFAULTS, NOW);
    expect(near.draft).toBeUndefined();
    expect(near.notDrafted[0]).toMatchObject({ reason: 'gap_below_setting' });
  });

  it('a sighting 14 days old or more is not used ("sighting too old"); 13 days is', () => {
    const old = draftFromCompetitors(facts({ sightings: [{ observationId: 'o', competitor: 'A', priceMinor: 9_000, observedAt: daysAgo(14) }] }), COMPETITOR_RULE_DEFAULTS, NOW);
    expect(old.draft).toBeUndefined();
    expect(old.notDrafted).toEqual([expect.objectContaining({ reason: 'sighting_too_old', words: 'sighting too old', ageDays: 14 })]);
    expect(draftFromCompetitors(facts({ sightings: [{ observationId: 'o', competitor: 'A', priceMinor: 9_000, observedAt: daysAgo(13) }] }), COMPETITOR_RULE_DEFAULTS, NOW).draft?.draftPriceMinor).toBe(9_000);
  });

  it('a draft below cost or the margin floor is refused by name, never trimmed', () => {
    // 7_500 is above cost but its margin (6.7%) is below the 20% floor.
    const floor = draftFromCompetitors(facts({ sightings: [{ observationId: 'o', competitor: 'A', priceMinor: 7_500, observedAt: daysAgo(1) }] }), COMPETITOR_RULE_DEFAULTS, NOW);
    expect(floor.draft).toBeUndefined();
    expect(floor.notDrafted[0]).toMatchObject({ reason: 'draft_refused_below_margin_floor', words: 'draft refused: below margin floor' });
    const loss = draftFromCompetitors(facts({ sightings: [{ observationId: 'o', competitor: 'A', priceMinor: 6_000, observedAt: daysAgo(1) }] }), COMPETITOR_RULE_DEFAULTS, NOW);
    expect(loss.notDrafted[0]).toMatchObject({ reason: 'draft_refused_below_margin_floor', detail: expect.stringMatching(/below the buying cost/) });
  });

  it('never above MRP: a shop price above a lowered MRP drafts no higher than the MRP', () => {
    const out = draftFromCompetitors(facts({ ourPriceMinor: 12_000, mrpMinor: 10_000, sightings: [{ observationId: 'o', competitor: 'A', priceMinor: 11_000, observedAt: daysAgo(1) }] }), COMPETITOR_RULE_DEFAULTS, NOW);
    expect(out.draft).toMatchObject({ draftPriceMinor: 10_000, cappedAtMrp: true });
  });

  it('what head office does not hold is said, never guessed', () => {
    const { mrpMinor: _m, ...noMrp } = facts(); void _m;
    const { costMinor: _c, ...noCost } = facts(); void _c;
    const { marginFloorBps: _f, ...noFloor } = facts(); void _f;
    expect(draftFromCompetitors(noMrp, COMPETITOR_RULE_DEFAULTS, NOW).notDrafted[0]?.reason).toBe('mrp_not_known');
    expect(draftFromCompetitors(noCost, COMPETITOR_RULE_DEFAULTS, NOW).notDrafted[0]?.reason).toBe('cost_not_known');
    expect(draftFromCompetitors(noFloor, COMPETITOR_RULE_DEFAULTS, NOW).notDrafted[0]?.reason).toBe('margin_floor_not_set');
    expect(draftFromCompetitors(facts({ ourPriceMinor: null }), COMPETITOR_RULE_DEFAULTS, NOW).notDrafted[0]?.reason).toBe('no_shop_price');
  });

  it('uses each competitor\'s LATEST sighting, and the lowest of the fresh ones', () => {
    const sightings = [
      { observationId: 'a-old', competitor: 'A', priceMinor: 8_000, observedAt: daysAgo(5) },
      { observationId: 'a-new', competitor: 'A', priceMinor: 9_900, observedAt: daysAgo(1) },
      { observationId: 'b', competitor: 'B', priceMinor: 9_300, observedAt: daysAgo(3) },
    ];
    expect(latestPerCompetitor(sightings).map((s) => s.observationId).sort()).toEqual(['a-new', 'b']);
    expect(draftFromCompetitors(facts({ sightings }), COMPETITOR_RULE_DEFAULTS, NOW).draft).toMatchObject({ observationId: 'b', draftPriceMinor: 9_300 });
  });

  it('the settings change the answer, and a malformed setting is named', () => {
    expect(draftFromCompetitors(facts(), { gapBps: 1_000, maxAgeDays: 14 }, NOW).draft).toBeUndefined();
    expect(draftFromCompetitors(facts(), { gapBps: 500, maxAgeDays: 2 }, NOW).notDrafted[0]?.reason).toBe('sighting_too_old');
    expect(competitorRuleProblem({ gapBps: 0, maxAgeDays: 14 })).toMatch(/gapBps/);
    expect(competitorRuleProblem({ gapBps: 500, maxAgeDays: 1.5 })).toMatch(/maxAgeDays/);
    expect(competitorRuleProblem({ gapBps: 500, maxAgeDays: 14 })).toBeUndefined();
  });
});
