import { describe, it, expect, vi, afterEach } from 'vitest';
import { bootPos } from '../../apps/pos/src/browser-entry';
import { PosSession, BillArithmeticError } from '../../apps/pos/src/session';
import type { CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';
import { bestPrice, type BasketLine, type Promotion } from '../../packages/promotions/src/promotions';
import { productRuleRefusals, type LaneScales } from '../../packages/restricted-sales/src/till-gate';
import { checkTillRules } from '../../edge/store-edge/src/lane-scales';
import { acceptSale, type IncomingSale, type IntakeContext } from '../../services/pos/src/index';
import { splitInclusive } from '../../packages/pricing/src/pricing';
import { money } from '../../packages/contracts/src/money';
import { rate } from '../../packages/contracts/src/rate';

/**
 * **Verifier r2final NEW-2 (B19 · OB-173 · OB-178 · GST) and L1.** An offer is worked out on what each line ACTUALLY
 * charges — a 333 g banana at ₹99.99/kg is ₹33.29, never ₹99.99 — for the offer's cap, its minimum spend and the spread of
 * the saving over the lines. No line and no GST ever goes below zero; a carry bag is never discounted (OB-173) and never
 * counts toward a minimum spend (OB-178); and a bag is judged by the piece whatever unit its line carries (L1).
 *
 * The verifier's basket: 333 g banana at ₹99.99/kg + rice ₹70 + carry bag ₹5, all at 5% GST, with a basket amount off.
 * Synthetic data only.
 */

const NOW = new Date().toISOString();
const day = (o: number): string => new Date(Date.now() + o * 86_400_000).toISOString().slice(0, 10);
const CURRENT: LaneScales = { known: true, scales: [{ assetId: 'SCALE-L1', reverificationDueOn: day(200) }] };
const WINDOW = { status: 'active' as const, startsAt: '2020-01-01T00:00:00Z', endsAt: '2099-01-01T00:00:00Z' };
const BANANA_333G = '2000123003330';
const RICE = '8900000000707';
const BAG = '8900000000404';

const CAT: CatalogueSnapshot = {
  tenantId: 't-f7', version: 4, builtAt: NOW,
  products: [
    { productId: 'P-BAN', sku: '000123', name: 'Banana', baseUom: 'kg', unitPriceMinor: 99_99, taxBps: 500, status: 'active' },
    { productId: 'P-BAG', sku: 'BAG-120', name: 'Carry bag 120', baseUom: 'ea', unitPriceMinor: 5_00, taxBps: 500, status: 'active', regulatedFlags: { carryBag: true, plasticMaterial: 'plastic', plasticThicknessMicrons: 120 } },
    { productId: 'P-RICE', sku: 'RICE', name: 'Rice', baseUom: 'ea', unitPriceMinor: 70_00, taxBps: 500, status: 'active' },
  ],
  barcodes: [{ code: BAG, productId: 'P-BAG', kind: 'standard' }, { code: RICE, productId: 'P-RICE', kind: 'standard' }],
  embeddedRules: [{ prefix: '2', itemStart: 1, itemLength: 6, valueStart: 7, valueLength: 5, valueKind: 'weight' }],
};

type Line = { productId: string; quantityMinor: number; uom: string; unitPriceMinor: number; lineTotalMinor: number; taxRateBps: number };
type Rec = { lines: Line[]; total: number; netMinor: number; taxMinor: number; tenders: { amount: { minor: number } }[] };

function till(promotions: readonly Promotion[]) {
  const written: Rec[] = [];
  const pos = bootPos({
    laneId: 'lane-1', cashierId: 'u-cashier', tradingDay: day(0), catalogue: { ...CAT, promotions }, laneScales: CURRENT,
    durable: async (_id, record) => { written.push(JSON.parse(record) as Rec); return { committed: true, durable: true, detail: 'd', laneMessage: 'ok' }; },
  });
  return { pos, written };
}

/** Ring the verifier's basket, pay cash, and return what reached the disk. */
async function ring(promotions: readonly Promotion[]): Promise<{ payable: number; rec: Rec }> {
  const { pos, written } = till(promotions);
  pos.scanBarcode(BANANA_333G); pos.scanBarcode(RICE); pos.scanBarcode(BAG);
  const payable = pos.payableMinor();
  await pos.tenderCash('S-1', 'R-1', NOW);
  return { payable, rec: written[0]! };
}

/** The bill's own arithmetic: lines sum to the total, net + tax is the total, nothing below zero, the bag at ₹5. */
function holds(rec: Rec): void {
  expect(rec.lines.every((l) => l.lineTotalMinor >= 0)).toBe(true);
  expect(rec.lines.reduce((n, l) => n + l.lineTotalMinor, 0)).toBe(rec.total);
  const inside = rec.lines.map((l) => splitInclusive(money(l.lineTotalMinor, 'INR'), rate(l.taxRateBps)));
  expect(inside.every((s) => s.net.minor >= 0 && s.tax.minor >= 0)).toBe(true);
  expect(rec.netMinor).toBe(inside.reduce((n, s) => n + s.net.minor, 0));
  expect(rec.taxMinor).toBe(inside.reduce((n, s) => n + s.tax.minor, 0));
  expect(rec.netMinor >= 0 && rec.taxMinor >= 0).toBe(true);
  expect(rec.netMinor + rec.taxMinor).toBe(rec.total);
  expect(rec.lines.find((l) => l.productId === 'P-BAG')).toMatchObject({ unitPriceMinor: 5_00, lineTotalMinor: 5_00 });
  expect(rec.tenders[0]!.amount.minor).toBe(rec.total);
}

const of = (rec: Rec, id: string): number => rec.lines.find((l) => l.productId === id)!.lineTotalMinor;
const amountOff = (minor: number, extra: Partial<Promotion> = {}): Promotion => ({ id: 'PR-B', kind: 'amount_off', ...WINDOW, amountOffMinor: minor, ...extra });

describe('NEW-2: the till spreads a basket offer by what each line actually charges', () => {
  it('(a) ₹100 off: the banana (₹33.29 charged) takes a share of its ₹33.29, never of ₹99.99 — no line below zero', async () => {
    const { payable, rec } = await ring([amountOff(100_00)]);
    // Goods are ₹33.29 + ₹70.00 = ₹103.29; the bag is not discountable. ₹100 spread 32.23 : 67.77.
    expect(payable).toBe(8_29);
    expect(rec.total).toBe(8_29);
    expect(of(rec, 'P-BAN')).toBe(1_06);
    expect(of(rec, 'P-RICE')).toBe(2_23);
    holds(rec);
  });

  it('(b) ₹150 off: the cap is the goods\' real ₹103.29 — the customer pays the bag\'s ₹5, the record\'s net and GST are not negative', async () => {
    const { payable, rec } = await ring([amountOff(150_00)]);
    expect(payable).toBe(5_00);
    expect(rec.total).toBe(5_00);
    expect(of(rec, 'P-BAN')).toBe(0);
    expect(of(rec, 'P-RICE')).toBe(0);
    holds(rec);
  });

  it('a minimum spend is judged on what the goods charge — the weighed line at its real ₹33.29, and never the bag (OB-178)', async () => {
    // ₹103.29 of goods: below a ₹105 minimum (it used to read ₹169.99 and fire), though goods + bag is ₹108.29.
    const below = await ring([amountOff(10_00, { minSpendMinor: 105_00 })]);
    expect(below.payable).toBe(108_29);
    holds(below.rec);
    const met = await ring([amountOff(10_00, { minSpendMinor: 103_29 })]);
    expect(met.payable).toBe(98_29);
    holds(met.rec);
  });

  it('a basket 10% is 10% of what the goods charge (₹10.33), not of ₹169.99', async () => {
    const { payable, rec } = await ring([{ id: 'PR-10', kind: 'percent_off', ...WINDOW, percentBps: 1_000 }]);
    expect(payable).toBe(108_29 - 10_33);
    holds(rec);
  });

  it('the commit refuses, before the disk, a bill whose line would go below zero (the last check)', async () => {
    const { pos, written } = till([]);
    pos.scanBarcode(RICE);
    // Force an impossible attribution to prove the last check: every line "discounted" by ₹1,000.
    class Every extends Map<string, number> { override get(): number { return 1_000_00; } }
    const spy = vi.spyOn(PosSession.prototype as unknown as { promotionDiscountByLine(): ReadonlyMap<string, number> }, 'promotionDiscountByLine').mockReturnValue(new Every());
    try {
      await expect(pos.tenderCash('S-X', 'R-X', NOW)).rejects.toBeInstanceOf(BillArithmeticError);
      await expect(pos.tenderCash('S-X', 'R-X', NOW)).rejects.toThrow(/below zero/);
    } finally { spy.mockRestore(); }
    expect(written).toHaveLength(0);
  });
});

describe('NEW-2: the offer engine reads a line\'s actual gross', () => {
  const at = { at: NOW, currency: 'INR' as const };
  const line = (lineId: string, unit: number, qty: number, extra: Partial<BasketLine> = {}): BasketLine => ({ lineId, productId: lineId, unitPrice: money(unit, 'INR'), qty, ...extra });
  const banana = line('BAN', 99_99, 1, { lineTotal: money(33_29, 'INR') });
  const rice = line('RICE', 70_00, 1);
  const bag = line('BAG', 5_00, 1, { carryBag: true });

  afterEach(() => { vi.restoreAllMocks(); });

  it('caps, spreads and judges the minimum spend on the line total; no share exceeds what its line charges', () => {
    const r = bestPrice([banana, rice, bag], [amountOff(150_00)], at);
    expect(r.grossTotal.minor).toBe(108_29);
    expect(r.discount.minor).toBe(103_29);
    expect(r.perLine).toEqual([{ lineId: 'BAN', discountMinor: 33_29 }, { lineId: 'RICE', discountMinor: 70_00 }, { lineId: 'BAG', discountMinor: 0 }]);
    expect(bestPrice([banana, rice, bag], [amountOff(10_00, { minSpendMinor: 105_00 })], at).discount.minor).toBe(0);
  });

  it('a buy-1-get-1 frees the weighed line at what it charges; a member price never takes more than the line charges', () => {
    const b1g1 = bestPrice([banana, line('BAN2', 99_99, 1, { lineTotal: money(50_00, 'INR') })], [{ id: 'PR-B1', kind: 'buy_x_get_y', ...WINDOW, buyQty: 1, getQty: 1 }], at);
    expect(b1g1.discount.minor).toBe(33_29);
    const member = bestPrice([banana], [{ id: 'PR-M', kind: 'member_price', ...WINDOW, memberUnitPrice: money(10_00, 'INR') }], { ...at, isMember: true });
    expect(member.discount.minor).toBe(33_29);
    expect(member.netTotal.minor).toBe(0);
  });

  it('a line without a line total is unit price × quantity, as before', () => {
    const r = bestPrice([line('R2', 70_00, 2)], [amountOff(10_00)], at);
    expect(r.grossTotal.minor).toBe(140_00);
    expect(r.discount.minor).toBe(10_00);
  });
});

describe('NEW-2 at head office: a line below zero is raised', () => {
  const intakeCtx: IntakeContext = { catalogue: new Map(CAT.products.map((p) => [p.productId, p])), currentPackVersion: 4, saleHoldingThisReceipt: undefined, alreadyBanked: false, now: NOW };
  const sale = (lines: IncomingSale['lines']): IncomingSale => {
    const total = lines.reduce((n, l) => n + l.lineTotalMinor, 0);
    return { saleId: 'S-1', receiptNumber: 'R-1', laneId: 'lane-1', cashierId: 'u', tradingDay: day(0), committedAt: NOW, totalMinor: total, currency: 'INR', packVersion: 4, lines, tenders: [{ kind: 'cash', amountMinor: total }] };
  };
  it('the old till\'s record (banana at −₹25.53) is flagged line_charged_below_zero; the corrected record is not', () => {
    const old = acceptSale(sale([
      { productId: 'P-BAN', quantityMinor: 333, uom: 'kg', unitPriceMinor: 99_99, lineTotalMinor: -25_53, taxRateBps: 500 },
      { productId: 'P-RICE', quantityMinor: 1, uom: 'ea', unitPriceMinor: 70_00, lineTotalMinor: 28_82, taxRateBps: 500 },
      { productId: 'P-BAG', quantityMinor: 1, uom: 'ea', unitPriceMinor: 5_00, lineTotalMinor: 5_00, taxRateBps: 500 },
    ]), intakeCtx);
    expect(old.exceptions.filter((x) => x.kind === 'line_charged_below_zero').map((x) => [x.productId, x.differenceMinor])).toEqual([['P-BAN', -25_53]]);
    const fixed = acceptSale(sale([
      { productId: 'P-BAN', quantityMinor: 333, uom: 'kg', unitPriceMinor: 99_99, lineTotalMinor: 1_06, taxRateBps: 500 },
      { productId: 'P-RICE', quantityMinor: 1, uom: 'ea', unitPriceMinor: 70_00, lineTotalMinor: 2_23, taxRateBps: 500 },
      { productId: 'P-BAG', quantityMinor: 1, uom: 'ea', unitPriceMinor: 5_00, lineTotalMinor: 5_00, taxRateBps: 500 },
    ]), intakeCtx);
    expect(fixed.exceptions.filter((x) => x.kind === 'line_charged_below_zero')).toEqual([]);
  });
});

describe('L1: a carry bag is judged for a discount whatever unit its line carries', () => {
  const flags = { carryBag: true, plasticMaterial: 'plastic', plasticThicknessMicrons: 120 };
  it('the shared gate: a bag line sent as "kg" or "L" and charged below its price is refused', () => {
    for (const uom of ['kg', 'L', 'g']) {
      expect(productRuleRefusals({ productId: 'P-BAG', description: 'bag', quantityMinor: 2, uom, unitPriceMinor: 5_00, chargedMinor: 1, regulatedFlags: flags }).map((r) => r.reason)).toEqual(['carry_bag_discounted']);
    }
    expect(productRuleRefusals({ productId: 'P-BAG', description: 'bag', quantityMinor: 2, uom: 'kg', unitPriceMinor: 5_00, chargedMinor: 10_00, regulatedFlags: flags })).toEqual([]);
  });

  it('the store computer refuses it before its disk', () => {
    const products = new Map(CAT.products.map((p) => [p.productId, { name: p.name, baseUom: p.baseUom, unitPriceMinor: p.unitPriceMinor, ...(p.regulatedFlags ? { regulatedFlags: p.regulatedFlags } : {}) }]));
    const ctx = { products, scales: CURRENT, today: day(0) };
    expect(checkTillRules({ id: 'S', lines: [{ productId: 'P-BAG', quantityMinor: 1, uom: 'kg', unitPriceMinor: 5_00, lineTotalMinor: 1 }] }, ctx)).toMatchObject({ ok: false, refusedBecause: 'carry_bag_discounted' });
    expect(checkTillRules({ id: 'S', lines: [{ productId: 'P-BAG', quantityMinor: 1, uom: 'kg', unitPriceMinor: 5_00, lineTotalMinor: 5_00 }] }, ctx)).toEqual({ ok: true });
  });

  it('head office raises it critical, beside the unit mismatch', () => {
    const intakeCtx: IntakeContext = { catalogue: new Map(CAT.products.map((p) => [p.productId, p])), currentPackVersion: 4, saleHoldingThisReceipt: undefined, alreadyBanked: false, now: NOW };
    const r = acceptSale({ saleId: 'S-2', receiptNumber: 'R-2', laneId: 'lane-1', cashierId: 'u', tradingDay: day(0), committedAt: NOW, totalMinor: 1, currency: 'INR', packVersion: 4,
      lines: [{ productId: 'P-BAG', quantityMinor: 1, uom: 'kg', unitPriceMinor: 5_00, lineTotalMinor: 1, taxRateBps: 500 }], tenders: [{ kind: 'cash', amountMinor: 1 }] }, intakeCtx);
    const kinds = r.exceptions.map((x) => `${x.kind}:${x.severity}`);
    expect(kinds).toContain('unlawful_plastic_sold:critical');
    expect(kinds).toContain('unit_differs_from_catalogue:material');
  });
});
