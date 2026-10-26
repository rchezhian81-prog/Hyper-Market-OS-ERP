import { describe, it, expect } from 'vitest';
import { PosSession, TillRuleRefusedError, type ScanInput } from '../../apps/pos/src/session';
import { money } from '../../packages/contracts/src/money';
import { rate } from '../../packages/contracts/src/rate';
import { Ledger, InMemoryLedgerStore } from '../../packages/ledger/src/index';
import { SyncOutbox } from '../../packages/sync/src/index';
import { isMedicineHsn, medicineReason, MEDICINE_HSN_HEADINGS, MEDICINE_LANE_WORDS } from '../../packages/restricted-sales/src/medicines';
import { tillLineRefusals, productRuleRefusals } from '../../packages/restricted-sales/src/till-gate';
import { checkTillRules } from '../../edge/store-edge/src/lane-scales';
import { acceptSale, type IncomingSale, type IntakeContext } from '../../services/pos/src/index';
import { validateProduct } from '../../packages/product/src/index';
import { buildCatalogueSnapshot } from '../../packages/catalogue/src/snapshot-builder';

/**
 * **B18 · OB-310 ("sell no medicines; category stays blocked")** — the rule (mark, `drug` category, HSN 3003/3004) and every
 * point that refuses it, mirroring the liquor rule (B17): the product engine before publish, the pack builder, the till at
 * the scan and the commit (offline, from the pack's HSN), the store computer before its disk, head office's sale intake.
 */

const AT = '2026-10-26T09:00:00.000Z';
const HSN: Record<string, string> = { 'p-para': '30049099', 'p-rice': '1006' };
const cash = (minor: number) => [{ kind: 'cash' as const, amount: money(minor, 'INR'), status: 'settled' as const }];
const tillWith = () => {
  const written: unknown[] = [];
  const s = new PosSession(
    { laneId: 'lane-1', cashierId: 'u-meena', currency: 'INR', defaultTaxRate: rate(500), clock: () => AT, hsnCodeOf: (id) => HSN[id], shopState: 'TN' },
    new Ledger(new InMemoryLedgerStore()), new SyncOutbox(),
    async (_id, record) => { written.push(record); return { committed: true } as never; },
  );
  return { s, written };
};
const item = (productId: string, priceMinor: number): ScanInput => ({ productId, description: productId, unitPrice: money(priceMinor, 'INR'), quantityMinor: 1, uom: 'ea' });

describe('B18 — what makes a product a medicine', () => {
  it('its mark, a drug (pharmacy) category, or HSN 3003/3004 — never its name; bandages, vaccines and cosmetics are not caught', () => {
    expect(MEDICINE_HSN_HEADINGS).toEqual(['3003', '3004']);
    expect(isMedicineHsn('30049099')).toBe(true);
    expect(isMedicineHsn('3003.90')).toBe(true);
    expect(isMedicineHsn('3004')).toBe(true);
    for (const h of ['3005', '30021500', '3304', '2203', '', null, undefined, 'abcd']) expect(isMedicineHsn(h as string | null | undefined), String(h)).toBe(false);
    expect(medicineReason({ declaredMedicine: true })).toMatch(/marked as a medicine/);
    expect(medicineReason({ categoryKinds: ['drug'] })).toMatch(/medicine \(pharmacy\) category/);
    expect(medicineReason({ hsn: '30049099' })).toMatch(/30049099/);
    expect(medicineReason({ hsn: '3401', categoryKinds: ['food'] })).toBeUndefined();
    expect(MEDICINE_LANE_WORDS.ta).toMatch(/மருந்து/);
  });

  it('the product engine blocks publishing one, by mark, category or HSN', () => {
    const base = { productId: 'p', tenantId: 't', sku: 'S', name: 'Paracetamol', baseUom: 'each', primaryCategoryId: 'home', taxClass: '3401', lifecycle: 'active' } as const;
    const blocks = (product: Record<string, unknown>, regulated: string[] = []) =>
      validateProduct({ ...base, ...product } as never, [{ categoryId: 'home', name: 'Home', parentId: null, regulated } as never]).issues
        .filter((i: { field: string; severity: string }) => i.field === 'safety.medicine' && i.severity === 'blocks_publish').length;
    expect(blocks({ safety: { medicine: true } })).toBe(1);
    expect(blocks({}, ['drug'])).toBe(1);
    expect(blocks({ taxClass: '30049099' })).toBe(1);
    expect(blocks({})).toBe(0);
    expect(blocks({ safety: { medicine: 'yes' } })).toBe(1);
  });

  it('the pack builder leaves one out and says so', () => {
    const r = buildCatalogueSnapshot({
      scope: { tenantId: 't', storeId: 'S1' }, version: 1, asOf: AT,
      products: [{ productId: 'p-para', sku: 'PARA', name: 'Paracetamol', baseUom: 'ea', taxClassId: '30049099', status: 'active' }],
      barcodes: [], taxClasses: { '30049099': 1200 },
      priceEntries: [{ id: 'e-p', productId: 'p-para', scope: 'store' as const, scopeRef: 'S1', price: money(3_000, 'INR'), effectiveFrom: '2026-01-01T00:00:00.000Z', status: 'active' as const, version: 1 }],
    });
    expect(r.excluded).toEqual([{ productId: 'p-para', sku: 'PARA', reason: 'medicine_not_sold' }]);
    expect(r.snapshot.products).toEqual([]);
  });
});

describe('B18 — refused at the till, the store computer and head office', () => {
  it('the till refuses a medicine at the scan from the pack\'s HSN, with no network and no override; nothing joins the bill', () => {
    const { s } = tillWith();
    let caught: unknown;
    try { s.scan(item('p-para', 3_000)); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(TillRuleRefusedError);
    expect((caught as TillRuleRefusedError).refusals.map((r) => r.reason)).toEqual(['medicine_not_sold']);
    expect((caught as TillRuleRefusedError).laneMessage).toBe(`p-para is a medicine. ${MEDICINE_LANE_WORDS.en}`);
    expect(s.basket()).toHaveLength(0);
  });

  it('a held basket recalled with a medicine on it is refused at the commit, before the disk', async () => {
    const { s, written } = tillWith();
    s.restoreHeld([{ lineId: 'L1', productId: 'p-para', description: 'Paracetamol', unitPriceMinor: 3_000, quantityMinor: 1, uom: 'ea', taxBps: 1200, voided: false }]);
    await expect(s.commit('S-M', 'N-M', AT, cash(3_000))).rejects.toBeInstanceOf(TillRuleRefusedError);
    expect(written).toHaveLength(0);
  });

  it('the store computer refuses a medicine record before its disk — from its own catalogue\'s HSN, the line\'s, or the mark', () => {
    const products = new Map([['p-para', { name: 'Paracetamol', baseUom: 'ea', unitPriceMinor: 3_000, hsnCode: '3004' }]]);
    const ctx = { products, scales: { known: false as const, why: 'none' }, today: '2026-10-26', shopState: 'TN' };
    expect(checkTillRules({ lines: [{ productId: 'p-para', quantityMinor: 1, uom: 'ea', unitPriceMinor: 3_000, lineTotalMinor: 3_000 }] }, ctx))
      .toMatchObject({ ok: false, refusedBecause: 'medicine_not_sold', productId: 'p-para' });
    expect(checkTillRules({ lines: [{ productId: 'p-x', quantityMinor: 1, uom: 'ea', unitPriceMinor: 1, lineTotalMinor: 1, hsnCode: '3003' }] }, { ...ctx, products: new Map() }))
      .toMatchObject({ ok: false, refusedBecause: 'medicine_not_sold' });
    expect(tillLineRefusals({ productId: 'p', description: 'Cough syrup', quantityMinor: 1, uom: 'ea', unitPriceMinor: 1, regulatedFlags: { medicine: true } }, {})[0]?.reason).toBe('medicine_not_sold');
    expect(productRuleRefusals({ productId: 'p', description: 'Gauze', quantityMinor: 1, uom: 'ea', unitPriceMinor: 1, hsnCode: '3005' })).toEqual([]);
  });

  it('head office\'s intake raises "medicine sold", critical — the sale still banks', () => {
    const sale: IncomingSale = {
      saleId: 'S-M', receiptNumber: 'L1-0002', laneId: 'lane-1', cashierId: 'u-meena', tradingDay: '2026-10-26', committedAt: AT, totalMinor: 3_000, currency: 'INR', packVersion: 3,
      lines: [{ productId: 'p-para', quantityMinor: 1, uom: 'ea', unitPriceMinor: 3_000, lineTotalMinor: 3_000, hsnCode: '30049099' }], tenders: [{ kind: 'cash', amountMinor: 3_000 }],
    };
    const ctx: IntakeContext = { catalogue: new Map(), currentPackVersion: 3, saleHoldingThisReceipt: undefined, alreadyBanked: false, now: AT, shopState: 'TN' };
    const r = acceptSale(sale, ctx);
    expect(r.banked).toBe(true);
    const found = r.exceptions.find((e) => e.kind === 'medicine_sold');
    expect(found?.severity).toBe('critical');
    expect(found?.detail).toMatch(/OB-310/);
  });
});
