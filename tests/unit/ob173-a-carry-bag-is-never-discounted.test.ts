import { describe, it, expect } from 'vitest';
import { bootPos } from '../../apps/pos/src/browser-entry';
import { TillRuleRefusedError } from '../../apps/pos/src/session';
import type { CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';
import { bestPrice, type BasketLine, type Promotion } from '../../packages/promotions/src/promotions';
import { productRuleRefusals, type LaneScales } from '../../packages/restricted-sales/src/till-gate';
import { checkSingleUsePlastic } from '../../packages/restricted-sales/src/single-use-plastic';
import { checkTillRules } from '../../edge/store-edge/src/lane-scales';
import { acceptSale, type IncomingSale, type IntakeContext } from '../../services/pos/src/index';
import { splitInclusive } from '../../packages/pricing/src/pricing';
import { money } from '../../packages/contracts/src/money';
import { rate } from '../../packages/contracts/src/rate';

/**
 * **OB-173 "A" (owner, 17 Oct 2026, in writing, "Never discount bags") · B19 — discounts never apply to a carry bag.**
 *
 * The bag is always charged its full list price: a basket-wide offer, a category (group) offer, an offer that names it, a
 * buy-X-get-Y, a member price — none reaches it, and no share of any discount is spread onto it. Enforced at the till's
 * pricing (the offer engine skips bags), at the till's own commit gate and price change, at the store computer before its
 * disk, and at head office's intake (critical `unlawful_plastic_sold` for a bag charged below its list price).
 *
 * The owner's proof: a basket-wide 10% offer — the bag is still ₹5, and the discount is spread over the other lines
 * EXACTLY (to the paisa), with each line's GST pulled from what it actually charged. Synthetic data only.
 */

const NOW = new Date().toISOString();
const day = (o: number): string => new Date(Date.now() + o * 86_400_000).toISOString().slice(0, 10);
const SCALES: LaneScales = { known: true, scales: [] };
const WINDOW = { status: 'active' as const, startsAt: '2020-01-01T00:00:00Z', endsAt: '2099-01-01T00:00:00Z' };
const BAG = '8900000000404';
const RICE = '8900000000707';
const GHEE = '8900000000808';

const CAT: CatalogueSnapshot = {
  tenantId: 't-ob173', version: 7, builtAt: NOW,
  products: [
    { productId: 'P-RICE', sku: 'RICE', name: 'Ponni rice 1kg', baseUom: 'ea', unitPriceMinor: 70_00, taxBps: 500, status: 'active' },
    { productId: 'P-GHEE', sku: 'GHEE', name: 'Ghee 500ml', baseUom: 'ea', unitPriceMinor: 333_33, taxBps: 1200, status: 'active' },
    { productId: 'P-BAG', sku: 'BAG-120', name: 'Carry bag 120 micron', baseUom: 'ea', unitPriceMinor: 5_00, taxBps: 1800, status: 'active', regulatedFlags: { carryBag: true, plasticMaterial: 'plastic', plasticThicknessMicrons: 120 } },
  ],
  barcodes: [{ code: BAG, productId: 'P-BAG', kind: 'standard' }, { code: RICE, productId: 'P-RICE', kind: 'standard' }, { code: GHEE, productId: 'P-GHEE', kind: 'standard' }],
};
const TEN_PERCENT: Promotion = { id: 'PR-10', kind: 'percent_off', ...WINDOW, percentBps: 1_000 };

function till(promotions: readonly Promotion[]) {
  const written: Record<string, unknown>[] = [];
  const pos = bootPos({
    laneId: 'lane-1', cashierId: 'u-cashier', tradingDay: day(0), catalogue: { ...CAT, promotions }, laneScales: SCALES,
    durable: async (_id, record) => { written.push(JSON.parse(record) as Record<string, unknown>); return { committed: true, durable: true, detail: 'double', laneMessage: 'Sale complete.' }; },
  });
  return { pos, written };
}
type Line = { productId: string; quantityMinor: number; unitPriceMinor: number; lineTotalMinor: number; taxRateBps: number };
const line = (lineId: string, productId: string, unitMinor: number, qty: number, extra: Partial<BasketLine> = {}): BasketLine =>
  ({ lineId, productId, unitPrice: money(unitMinor, 'INR'), qty, ...extra });

describe('OB-173 — the offer engine never reaches a carry bag', () => {
  const basket = [line('L1', 'P-RICE', 70_00, 2), line('L2', 'P-GHEE', 333_33, 1), line('L3', 'P-BAG', 5_00, 1, { carryBag: true })];
  const at = { at: NOW, currency: 'INR' as const };

  it('a basket-wide 10%: computed on the goods, spread over the goods exactly, the bag takes no share', () => {
    const r = bestPrice(basket, [TEN_PERCENT], at);
    // 10% of ₹473.33 (the rice and ghee; the bag is not discountable) = ₹47.33, rounded half up.
    expect(r.discount.minor).toBe(47_33);
    expect(r.perLine).toEqual([{ lineId: 'L1', discountMinor: 14_00 }, { lineId: 'L2', discountMinor: 33_33 }, { lineId: 'L3', discountMinor: 0 }]);
    expect(r.perLine.reduce((n, p) => n + p.discountMinor, 0)).toBe(r.discount.minor);
    expect(r.grossTotal.minor).toBe(478_33);
    expect(r.netTotal.minor).toBe(431_00);
  });

  it('a 100% basket offer, an amount off bigger than the goods, a group that holds the bag, a buy-1-get-1 and a member price: the bag is still ₹5', () => {
    const all = bestPrice(basket, [{ id: 'PR-ALL', kind: 'percent_off', ...WINDOW, percentBps: 10_000 }], at);
    expect(all.perLine.find((p) => p.lineId === 'L3')!.discountMinor).toBe(0);
    expect(all.netTotal.minor).toBe(5_00);
    const huge = bestPrice(basket, [{ id: 'PR-OFF', kind: 'amount_off', ...WINDOW, amountOffMinor: 10_000_00 }], at);
    expect(huge.discount.minor).toBe(473_33);
    expect(huge.netTotal.minor).toBe(5_00);
    const grouped = [line('G1', 'P-RICE', 70_00, 1, { group: 'packaging' }), line('G2', 'P-BAG', 5_00, 3, { group: 'packaging', carryBag: true })];
    const cat = bestPrice(grouped, [{ id: 'PR-CAT', kind: 'percent_off', ...WINDOW, group: 'packaging', percentBps: 5_000 }], at);
    expect(cat.perLine).toEqual([{ lineId: 'G1', discountMinor: 35_00 }, { lineId: 'G2', discountMinor: 0 }]);
    const b1g1 = bestPrice([line('B1', 'P-BAG', 5_00, 4, { carryBag: true })], [{ id: 'PR-B1G1', kind: 'buy_x_get_y', ...WINDOW, buyQty: 1, getQty: 1 }], at);
    expect(b1g1.discount.minor).toBe(0);
    const named = bestPrice([line('N1', 'P-BAG', 5_00, 1, { carryBag: true })], [{ id: 'PR-N', kind: 'amount_off', ...WINDOW, productIds: ['P-BAG'], amountOffMinor: 2_00 }], at);
    expect(named.discount.minor).toBe(0);
    const member = bestPrice([line('M1', 'P-BAG', 5_00, 1, { carryBag: true })], [{ id: 'PR-M', kind: 'member_price', ...WINDOW, memberUnitPrice: money(1_00, 'INR') }], { ...at, isMember: true });
    expect(member.discount.minor).toBe(0);
  });

  it('a bag does not count toward an offer\'s minimum spend', () => {
    const r = bestPrice([line('L1', 'P-RICE', 70_00, 1), line('L2', 'P-BAG', 5_00, 2, { carryBag: true })], [{ id: 'PR-MIN', kind: 'amount_off', ...WINDOW, amountOffMinor: 10_00, minSpendMinor: 75_00 }], at);
    expect(r.discount.minor).toBe(0);
  });
});

describe('OB-173 — the till, with a basket-wide 10% offer', () => {
  it('the bag rings and lands on the disk at ₹5; the 10% is spread over the rice and ghee to the paisa; GST is pulled from what each line charged', async () => {
    const { pos, written } = till([TEN_PERCENT]);
    pos.scanBarcode(RICE); pos.scanBarcode(RICE); pos.scanBarcode(GHEE); pos.scanBarcode(BAG);
    expect(pos.payableMinor()).toBe(431_00);
    await pos.tenderCash('S-1', 'R-1', NOW);
    const rec = written[0]! as { lines: Line[]; total: number; netMinor: number; taxMinor: number };
    const of = (id: string): Line => rec.lines.find((l) => l.productId === id)!;
    expect(of('P-BAG')).toMatchObject({ unitPriceMinor: 5_00, quantityMinor: 1, lineTotalMinor: 5_00 });
    // Each rice scan rings its own line: together ₹140.00 − ₹14.00.
    expect(rec.lines.filter((l) => l.productId === 'P-RICE').reduce((n, l) => n + l.lineTotalMinor, 0)).toBe(126_00);
    expect(of('P-GHEE').lineTotalMinor).toBe(300_00); // ₹333.33 − ₹33.33
    // The lines add up to what the customer paid, exactly.
    expect(rec.lines.reduce((n, l) => n + l.lineTotalMinor, 0)).toBe(rec.total);
    expect(rec.total).toBe(431_00);
    // GST inside each line as CHARGED — the bag's 18% is on its full ₹5, the goods' on their reduced value.
    const inside = rec.lines.map((l) => splitInclusive(money(l.lineTotalMinor, 'INR'), rate(l.taxRateBps)));
    expect(rec.taxMinor).toBe(inside.reduce((n, s) => n + s.tax.minor, 0));
    expect(rec.netMinor).toBe(inside.reduce((n, s) => n + s.net.minor, 0));
    expect(rec.netMinor + rec.taxMinor).toBe(rec.total);
    const bagSplit = splitInclusive(money(5_00, 'INR'), rate(1800));
    expect(bagSplit.net.minor + bagSplit.tax.minor).toBe(5_00);
    expect(inside[rec.lines.findIndex((l) => l.productId === 'P-BAG')]).toEqual(bagSplit);
  });

  it('a manager\'s price change on a bag — even a rupee off — is refused before any approval is spent', () => {
    const { pos } = till([]);
    pos.scanBarcode(BAG);
    const lineId = pos.basket()[0]!.lineId;
    expect(pos.priceChangeValue(lineId, 4_00)).toEqual({ ok: false, laneMessage: expect.stringContaining('always charged its full price') as unknown });
    expect(pos.priceChangeValue(lineId, 0)).toMatchObject({ ok: false });
  });

  it('the till\'s own commit gate refuses a discounted bag that reached the basket any other way', () => {
    const refusals = productRuleRefusals({ productId: 'P-BAG', description: 'Carry bag 120 micron', quantityMinor: 2, uom: 'ea', unitPriceMinor: 5_00, chargedMinor: 9_00, regulatedFlags: { carryBag: true, plasticMaterial: 'plastic', plasticThicknessMicrons: 120 } });
    expect(refusals.map((r) => r.reason)).toEqual(['carry_bag_discounted']);
    expect(refusals[0]!.laneMessage).toMatch(/always charged its full price/);
    expect(() => { throw new TillRuleRefusedError(refusals, 'Do not take payment. '); }).toThrow(/carry_bag_discounted/);
    // Full price passes; a cloth bag is held to the same rule.
    expect(productRuleRefusals({ productId: 'P-BAG', description: 'bag', quantityMinor: 2, uom: 'ea', unitPriceMinor: 5_00, chargedMinor: 10_00, regulatedFlags: { carryBag: true, plasticMaterial: 'plastic', plasticThicknessMicrons: 120 } })).toEqual([]);
    expect(checkSingleUsePlastic({ lines: [{ lineId: 'c', productId: 'C', unitPriceMinor: 30_00, chargedMinor: 27_00, listMinor: 30_00, isCarryBag: true, material: 'cloth' }] }).blocks.map((b) => b.reason)).toEqual(['carry_bag_discounted']);
  });
});

describe('OB-173 — the store computer and head office', () => {
  const products = new Map(CAT.products.map((p) => [p.productId, { name: p.name, baseUom: p.baseUom, unitPriceMinor: p.unitPriceMinor, ...(p.regulatedFlags ? { regulatedFlags: p.regulatedFlags } : {}) }]));
  const bagLine = (over: Record<string, unknown>) => ({ productId: 'P-BAG', quantityMinor: 1, uom: 'ea', unitPriceMinor: 5_00, lineTotalMinor: 5_00, ...over });

  it('the store computer refuses, before its disk, a bag charged below its list price — by an offer, a lowered unit price or a price change', () => {
    const ctx = { products, scales: SCALES, today: day(0) };
    expect(checkTillRules({ id: 'S', lines: [bagLine({ lineTotalMinor: 4_50 })] }, ctx)).toMatchObject({ ok: false, refusedBecause: 'carry_bag_discounted', productId: 'P-BAG', laneMessage: expect.stringMatching(/^Do not take payment\./) as unknown });
    expect(checkTillRules({ id: 'S', lines: [bagLine({ unitPriceMinor: 4_00, lineTotalMinor: 4_00 })] }, ctx)).toMatchObject({ ok: false, refusedBecause: 'carry_bag_discounted' });
    expect(checkTillRules({ id: 'S', lines: [bagLine({ unitPriceMinor: 4_00, lineTotalMinor: 4_00, priceOverride: { fromUnitPriceMinor: 5_00, approvedBy: 'u-mgr', activityId: 'a1' } })] }, ctx)).toMatchObject({ ok: false, refusedBecause: 'carry_bag_discounted' });
    expect(checkTillRules({ id: 'S', lines: [bagLine({})] }, ctx)).toEqual({ ok: true });
  });

  const intakeCtx: IntakeContext = { catalogue: new Map(CAT.products.map((p) => [p.productId, p])), currentPackVersion: 7, saleHoldingThisReceipt: undefined, alreadyBanked: false, now: NOW };
  const sale = (lines: IncomingSale['lines']): IncomingSale => {
    const total = lines.reduce((n, l) => n + l.lineTotalMinor, 0);
    return { saleId: 'S-1', receiptNumber: 'R-1', laneId: 'lane-1', cashierId: 'u', tradingDay: day(0), committedAt: NOW, totalMinor: total, currency: 'INR', packVersion: 7, lines, tenders: [{ kind: 'cash', amountMinor: total }] };
  };

  it('head office flags CRITICAL `unlawful_plastic_sold` for a bag charged below its list price; the owner\'s 10% basket is clean', () => {
    const bad = acceptSale(sale([
      { productId: 'P-RICE', quantityMinor: 2, uom: 'ea', unitPriceMinor: 70_00, lineTotalMinor: 126_00, taxRateBps: 500 },
      { productId: 'P-BAG', quantityMinor: 1, uom: 'ea', unitPriceMinor: 5_00, lineTotalMinor: 4_50, taxRateBps: 1800 },
    ]), intakeCtx);
    const found = bad.exceptions.filter((x) => x.kind === 'unlawful_plastic_sold');
    expect(found.map((x) => [x.severity, x.productId])).toEqual([['critical', 'P-BAG']]);
    expect(found[0]!.detail).toMatch(/never discounted \(OB-173\)/);
    // A bag rung below head office's own list price (the till's unit price lowered) is caught too.
    const lowered = acceptSale(sale([{ productId: 'P-BAG', quantityMinor: 1, uom: 'ea', unitPriceMinor: 4_00, lineTotalMinor: 4_00, taxRateBps: 1800 }]), intakeCtx);
    expect(lowered.exceptions.some((x) => x.kind === 'unlawful_plastic_sold' && x.severity === 'critical')).toBe(true);
    const good = acceptSale(sale([
      { productId: 'P-RICE', quantityMinor: 2, uom: 'ea', unitPriceMinor: 70_00, lineTotalMinor: 126_00, taxRateBps: 500 },
      { productId: 'P-GHEE', quantityMinor: 1, uom: 'ea', unitPriceMinor: 333_33, lineTotalMinor: 300_00, taxRateBps: 1200 },
      { productId: 'P-BAG', quantityMinor: 1, uom: 'ea', unitPriceMinor: 5_00, lineTotalMinor: 5_00, taxRateBps: 1800 },
    ]), intakeCtx);
    expect(good.exceptions.filter((x) => x.kind === 'unlawful_plastic_sold')).toEqual([]);
  });
});
