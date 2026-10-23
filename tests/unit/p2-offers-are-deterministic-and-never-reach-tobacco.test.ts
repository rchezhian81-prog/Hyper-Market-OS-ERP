import { describe, it, expect } from 'vitest';
import { bestPrice, promotionLines, promotionProductIds, BANK_OFFERS, type BasketLine, type Promotion, type PromoContext } from '../../packages/promotions/src/index';
import { money } from '../../packages/contracts/src/money';

// OB-288 P2 · M05-FR-03 · D06-FR-03: the new offer kinds — "3 for ₹99" (multibuy), a named set at one price (bundle_price,
// OB-306's price-offer bundle), buy from one set and get from another (mix_match), and a bank-card offer built switched OFF
// (OB-305). The same basket gives the same best price however its lines are ordered (the till offline and head office
// online run this one engine); an expired or stopped offer never applies; and B15: no offer ever reaches a tobacco line.

const AT = '2026-10-23T10:00:00Z';
const ctx: PromoContext = { at: AT, currency: 'INR' };
const line = (lineId: string, productId: string, unitMinor: number, qty: number, extra: Partial<BasketLine> = {}): BasketLine =>
  ({ lineId, productId, unitPrice: money(unitMinor, 'INR'), qty, ...extra });
const offer = (o: Partial<Promotion> & Pick<Promotion, 'id' | 'kind'>): Promotion =>
  ({ startsAt: '2026-10-01T00:00:00Z', endsAt: '2026-10-31T23:59:59Z', status: 'active', ...o } as Promotion);

describe('multibuy — "N for ₹X"', () => {
  const three99 = offer({ id: 'mb-3-for-99', kind: 'multibuy', productIds: ['soap-a', 'soap-b'], multibuyQty: 3, multibuyPriceMinor: 9_900 });

  it('makes deals from the dearest units first and saves what N would have cost less ₹X', () => {
    // 4 × ₹40 + 2 × ₹35: one deal of the three dearest (₹120 → ₹99 saves ₹21), a second of 40+35+35 (₹110 → ₹99 saves ₹11).
    const r = bestPrice([line('l1', 'soap-a', 4_000, 4), line('l2', 'soap-b', 3_500, 2)], [three99], ctx);
    expect(r.discount.minor).toBe(2_100 + 1_100);
    expect(r.perLine.reduce((s, p) => s + p.discountMinor, 0)).toBe(r.discount.minor);
  });

  it('two units make no deal, a cheaper-than-the-offer set saves nothing, and the cap holds', () => {
    expect(bestPrice([line('l1', 'soap-a', 4_000, 2)], [three99], ctx).discount.minor).toBe(0);
    expect(bestPrice([line('l1', 'soap-a', 2_000, 3)], [three99], ctx).discount.minor).toBe(0); // ₹60 < ₹99: never a negative saving
    const capped = offer({ ...three99, id: 'mb-capped', maxApplications: 1 });
    expect(bestPrice([line('l1', 'soap-a', 4_000, 6)], [capped], ctx).discount.minor).toBe(2_100);
  });

  it('a weighed line is not counted in units', () => {
    const weighed = line('l1', 'soap-a', 4_000, 1, { lineTotal: money(1_333, 'INR') });
    expect(bestPrice([weighed, line('l2', 'soap-a', 4_000, 2)], [three99], ctx).discount.minor).toBe(0);
  });
});

describe('bundle_price — a named set at one price (OB-306, the price offer)', () => {
  const breakfast = offer({ id: 'set-breakfast', kind: 'bundle_price', bundleItems: [{ productId: 'bread', qty: 1 }, { productId: 'jam', qty: 1 }, { productId: 'butter', qty: 1 }], bundlePriceMinor: 19_900 });

  it('as many whole sets as every item allows; each saves its items less the set price', () => {
    const lines = [line('l1', 'bread', 5_000, 2), line('l2', 'jam', 9_000, 2), line('l3', 'butter', 8_000, 1)];
    const r = bestPrice(lines, [breakfast], ctx);
    expect(r.discount.minor).toBe(5_000 + 9_000 + 8_000 - 19_900); // one set: butter allows only one
    // The saving falls on the set's lines only, and adds up.
    expect(r.perLine.reduce((s, p) => s + p.discountMinor, 0)).toBe(r.discount.minor);
  });

  it('a missing item makes no set', () => {
    expect(bestPrice([line('l1', 'bread', 5_000, 2), line('l2', 'jam', 9_000, 2)], [breakfast], ctx).discount.minor).toBe(0);
  });

  it('names its products', () => {
    expect(promotionProductIds(breakfast)).toEqual(['bread', 'butter', 'jam']);
  });
});

describe('mix_match — buy from one set, get from another', () => {
  const shampooConditioner = offer({ id: 'mm-sh-co', kind: 'mix_match', buyProductIds: ['shampoo'], buyQty: 2, getProductIds: ['conditioner-a', 'conditioner-b'], getQty: 1, getPercentBps: 10_000 });

  it('gives the cheapest GET unit per block, and spreads the saving on the GET side only', () => {
    const lines = [line('l1', 'shampoo', 20_000, 4), line('l2', 'conditioner-a', 15_000, 1), line('l3', 'conditioner-b', 12_000, 1)];
    const r = bestPrice(lines, [shampooConditioner], ctx);
    expect(r.discount.minor).toBe(12_000 + 15_000); // two blocks of 2 shampoo → both conditioners free
    expect(r.perLine.find((p) => p.lineId === 'l1')!.discountMinor).toBe(0);
  });

  it('half off, and no GET unit means no discount', () => {
    const half = offer({ ...shampooConditioner, id: 'mm-half', getPercentBps: 5_000 });
    expect(bestPrice([line('l1', 'shampoo', 20_000, 2), line('l2', 'conditioner-a', 15_000, 1)], [half], ctx).discount.minor).toBe(7_500);
    expect(bestPrice([line('l1', 'shampoo', 20_000, 2)], [half], ctx).discount.minor).toBe(0);
  });

  it('a line on both sides is only bought, never also given', () => {
    const overlap = offer({ id: 'mm-overlap', kind: 'mix_match', buyProductIds: ['tea'], buyQty: 1, getProductIds: ['tea'], getQty: 1, getPercentBps: 10_000 });
    expect(bestPrice([line('l1', 'tea', 10_000, 2)], [overlap], ctx).discount.minor).toBe(0);
  });
});

describe('bank_offer — built and switched OFF (OB-305)', () => {
  const hdfc = offer({ id: 'bank-10', kind: 'bank_offer', bankIssuer: 'Bank X', percentBps: 1_000, amountOffMinor: 15_000, minSpendMinor: 100_000 });
  const basket = [line('l1', 'rice', 60_000, 2)];

  it('is off in code, named for the release that brings integrated terminals', () => {
    expect(BANK_OFFERS.on).toBe(false);
    expect(BANK_OFFERS.release).toBe('R4');
  });

  it('never applies at a till that cannot say the card\'s bank — today, every till', () => {
    expect(bestPrice(basket, [hdfc], ctx).discount.minor).toBe(0);
    expect(bestPrice(basket, [hdfc], { ...ctx, cardIssuer: 'Bank X' }).discount.minor).toBe(0); // switched off
    expect(bestPrice(basket, [hdfc], { ...ctx, bankOffersOn: true }).discount.minor).toBe(0); // no issuer reported
  });

  it('once switched on with an integrated machine, gives its percent up to its cap, for that bank only', () => {
    expect(bestPrice(basket, [hdfc], { ...ctx, bankOffersOn: true, cardIssuer: 'bank x' }).discount.minor).toBe(12_000);
    expect(bestPrice(basket, [hdfc], { ...ctx, bankOffersOn: true, cardIssuer: 'Bank Y' }).discount.minor).toBe(0);
    expect(bestPrice([line('l1', 'rice', 60_000, 3)], [hdfc], { ...ctx, bankOffersOn: true, cardIssuer: 'Bank X' }).discount.minor).toBe(15_000);
  });
});

describe('every kind is deterministic, and nothing expired or stopped applies', () => {
  const all: Promotion[] = [
    offer({ id: 'a-mb', kind: 'multibuy', productIds: ['soap-a'], multibuyQty: 3, multibuyPriceMinor: 9_900 }),
    offer({ id: 'b-set', kind: 'bundle_price', bundleItems: [{ productId: 'bread', qty: 1 }, { productId: 'jam', qty: 1 }], bundlePriceMinor: 12_000 }),
    offer({ id: 'c-mm', kind: 'mix_match', buyProductIds: ['shampoo'], buyQty: 1, getProductIds: ['conditioner-a'], getQty: 1, getPercentBps: 5_000 }),
    offer({ id: 'd-pc', kind: 'percent_off', productIds: ['rice'], percentBps: 500 }),
  ];
  const lines = [
    line('l1', 'soap-a', 4_000, 3), line('l2', 'bread', 5_000, 1), line('l3', 'jam', 9_000, 1),
    line('l4', 'shampoo', 20_000, 1), line('l5', 'conditioner-a', 15_000, 1), line('l6', 'rice', 60_000, 1),
  ];

  it('the same basket gives the same best price in any line order, every time', () => {
    const once = bestPrice(lines, all, ctx);
    const reversed = bestPrice([...lines].reverse(), all, ctx);
    const again = bestPrice(lines, all, ctx);
    expect(once.discount).toEqual(reversed.discount);
    expect(once.applied).toEqual(reversed.applied);
    expect(once).toEqual(again);
    expect(once.discount.minor).toBe(2_100 + 2_000 + 7_500 + 3_000);
  });

  it('an expired, not-yet-started or stopped offer is never applied', () => {
    const expired = all.map((p) => ({ ...p, endsAt: '2026-10-22T23:59:59Z' }));
    const future = all.map((p) => ({ ...p, startsAt: '2026-10-24T00:00:00Z' }));
    const stopped = all.map((p) => ({ ...p, status: 'stopped' as const }));
    for (const set of [expired, future, stopped]) expect(bestPrice(lines, set, ctx).discount.minor).toBe(0);
  });
});

describe('B15 — no offer ever reaches a tobacco line', () => {
  it('a basket-wide, a product and a set offer all leave tobacco at its price and take no share of it', () => {
    const cigarettes = line('l1', 'cig-10', 30_000, 1, { tobacco: true });
    const rice = line('l2', 'rice', 60_000, 1);
    const wide = offer({ id: 'wide-10', kind: 'percent_off', percentBps: 1_000 });
    const named = offer({ id: 'named', kind: 'amount_off', productIds: ['cig-10'], amountOffMinor: 5_000 });
    const set = offer({ id: 'set', kind: 'bundle_price', bundleItems: [{ productId: 'cig-10', qty: 1 }, { productId: 'rice', qty: 1 }], bundlePriceMinor: 50_000 });
    const r = bestPrice([cigarettes, rice], [wide, named, set], ctx);
    expect(r.discount.minor).toBe(6_000); // 10% of the rice only
    expect(r.perLine.find((p) => p.lineId === 'l1')!.discountMinor).toBe(0);
    expect(promotionLines(wide, [cigarettes, rice]).map((l) => l.lineId)).toEqual(['l2']);
  });

  it('tobacco does not count toward a minimum spend', () => {
    const minSpend = offer({ id: 'min', kind: 'amount_off', amountOffMinor: 5_000, minSpendMinor: 50_000 });
    expect(bestPrice([line('l1', 'cig-10', 30_000, 1, { tobacco: true }), line('l2', 'rice', 30_000, 1)], [minSpend], ctx).discount.minor).toBe(0);
  });
});
