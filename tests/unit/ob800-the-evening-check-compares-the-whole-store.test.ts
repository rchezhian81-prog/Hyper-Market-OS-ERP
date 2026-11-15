import { describe, it, expect } from 'vitest';
import { eveningCheck, MAX_DAY_DIFFERENCES, type CheckProduct, type CheckRefund, type CheckSale } from '../../packages/migration/src/evening-check';
import type { ItemWiseRow, OldBill } from '../../packages/migration/src/old-erp-reports';
import { departmentOf, STORE_DEPARTMENTS } from '../../packages/migration/src/bpal-slice';
import { compareParallelDay } from '../../packages/migration/src/cutover';

/**
 * OB-800 (owner, 15 Nov 2026): no pilot department — the whole store runs alongside Bpal (Bpal stays the record), and the
 * owner checks the two side by side each evening. The evening check therefore compares EVERY department:
 *
 *   • no "pilot department not known" refusal — every product of the catalogue is compared, whatever its department;
 *   • each department's totals (the department the Bpal load gave the product from its HSN — the same published table,
 *     `departmentOf`), and the whole store's total, which the departments add up to;
 *   • a loose item sold by weight compares to the gram (three decimals) exactly — and a kg difference of one gram is a
 *     difference, never rounded away (no tolerance is invented: that is the owner's choice);
 *   • a part quantity of an item sold in whole units is NOT refused (that would stop the whole store's day for one row):
 *     it is compared in thousandths and its quantity differs — visible, with a reason to write (hard rule #10);
 *   • every bill of the store is rung on both, so an old bill no new-till sale carries is "not keyed" even when the
 *     bill-wise list has no item lines, and the number of old bills is known;
 *   • a product the old file names but the catalogue lacks, a product with no department, and a new-till product the
 *     catalogue lacks each stay visible in their own group — never dropped.
 * Synthetic data only.
 */

const DAY = '2026-11-16';
const GROCERY = departmentOf('1006')!.categoryId; // rice HSN, packed → packaged-groceries
const CARE = departmentOf('3305')!.categoryId; // shampoo → personal-care
const LOOSE = departmentOf('0713', 'loose_kg')!.categoryId; // loose dal by weight → loose-foods
const HOUSE = departmentOf('3402')!.categoryId; // detergent → household-general

const CATALOGUE: CheckProduct[] = [
  { productId: 'P1', name: 'Ponni rice 5kg', barcodes: ['8901234567890'], categoryId: GROCERY, uom: 'ea', taxBps: 500 },
  { productId: 'S1', name: 'Shampoo 180ml', barcodes: ['8900000000099'], categoryId: CARE, uom: 'ea', taxBps: 1800 },
  { productId: 'L1', name: 'Loose toor dal', barcodes: [], categoryId: LOOSE, uom: 'kg', taxBps: 0 },
  { productId: 'H1', name: 'Detergent 1kg', barcodes: ['8900000000105'], categoryId: HOUSE, uom: 'pcs', taxBps: 1800 },
  { productId: 'N1', name: 'No department item', barcodes: [], uom: 'ea', taxBps: 0 },
];
const taxAt = (incl: number, bps: number): number => incl - Math.round((incl * 10_000) / (10_000 + bps));
const row = (line: number, code: string, qty: number, value: number, tax: number): ItemWiseRow => ({ line, code, quantityThousandths: qty, valueMinor: value, taxMinor: tax });
const sale = (n: number, oldBill: string | undefined, lines: CheckSale['lines'], day = DAY): CheckSale => ({ saleId: `S-${n}`, number: `B${n}`, tradingDay: day, lines, ...(oldBill === undefined ? {} : { oldErpBillNumber: oldBill }) });
const rice = (q: number) => ({ productId: 'P1', quantityMinor: q, uom: 'ea', lineTotalMinor: 48_000 * q, taxRateBps: 500 });
const shampoo = (q: number) => ({ productId: 'S1', quantityMinor: q, uom: 'ea', lineTotalMinor: 15_000 * q, taxRateBps: 1800 });
const dal = (g: number) => ({ productId: 'L1', quantityMinor: g, uom: 'kg', lineTotalMinor: Math.round((g * 14_000) / 1000), taxRateBps: 0 });
const soap = (q: number) => ({ productId: 'H1', quantityMinor: q, uom: 'ea', lineTotalMinor: 9000 * q, taxRateBps: 1800 });

const base = {
  businessDate: DAY, catalogue: CATALOGUE, tolerance: { valueMinor: 0, taxMinor: 0 },
  sales: [sale(1, 'OLD/1', [rice(1), shampoo(2)]), sale(2, 'OLD/2', [dal(1234)]), sale(3, 'OLD/3', [soap(1)])],
  refunds: [] as CheckRefund[],
  itemWise: [
    row(3, '8901234567890', 1000, 48_000, taxAt(48_000, 500)),
    row(4, 'S1', 2000, 30_000, taxAt(30_000, 1800)),
    row(5, 'L1', 1234, 17_276, 0),
    row(6, 'H1', 1000, 9000, taxAt(9000, 1800)),
  ],
  billWise: { bills: [{ billNumber: 'OLD/1', line: 2, totalMinor: 78_000 }, { billNumber: 'OLD/2', line: 3, totalMinor: 17_276 }, { billNumber: 'OLD/3', line: 4, totalMinor: 9000 }] as OldBill[], withLines: false },
};

describe('OB-800: the evening check compares the WHOLE store — every department', () => {
  it('needs no pilot department: every department\'s items are compared, and a day that agrees agrees everywhere', () => {
    const r = eveningCheck(base);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    const c = r.check;
    expect(c.scope).toBe('whole_store');
    expect(c.department).toBeUndefined();
    expect(c.items.map((i) => [i.productId, i.categoryId, i.differs])).toEqual([['H1', HOUSE, []], ['L1', LOOSE, []], ['P1', GROCERY, []], ['S1', CARE, []]]);
    expect(compareParallelDay({ tenantId: 't', businessDate: DAY, comparisons: c.comparisons }).differences).toEqual([]);
    // The bill count is known for the whole store (every bill is rung on both) — and agrees.
    expect(c.totals.bills).toEqual({ old: { known: true, minor: 3 }, new: 3 });
    expect(c.comparisons).toEqual(expect.arrayContaining([{ area: 'sales_count', legacyValue: 3, newValue: 3, toleranceMinor: 0 }]));
  });

  it('each department\'s totals, in the published table\'s order, by the same HSN table as the Bpal load; they add up to the whole store', () => {
    const r = eveningCheck(base);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.check.departments!;
    expect(d.map((x) => [x.group, x.categoryId, x.name])).toEqual([
      ['department', GROCERY, STORE_DEPARTMENTS.find((s) => s.categoryId === GROCERY)!.name],
      ['department', CARE, 'Personal care'],
      ['department', HOUSE, 'Household and general goods'],
      ['department', LOOSE, 'Loose foods (by weight or by count)'],
    ]);
    expect(d.find((x) => x.categoryId === LOOSE)).toEqual({
      group: 'department', categoryId: LOOSE, name: 'Loose foods (by weight or by count)', items: 1, itemsDiffering: 0,
      value: { old: 17_276, new: 17_276 }, tax: { old: 0, new: { known: true, minor: 0 } }, quantity: [{ uom: 'kg', old: 1234, new: 1234 }],
    });
    // "pcs" in the catalogue is the system's "ea" (OB-31) — one unit, never two rows for the same thing.
    expect(d.find((x) => x.categoryId === HOUSE)!.quantity).toEqual([{ uom: 'ea', old: 1, new: 1 }]);
    const sum = (f: (x: (typeof d)[number]) => number): number => d.reduce((a, x) => a + f(x), 0);
    expect(sum((x) => x.value.old)).toBe(r.check.totals.value.old);
    expect(sum((x) => x.value.new)).toBe(r.check.totals.value.new);
    expect(sum((x) => x.tax.old)).toBe(r.check.totals.tax.old);
    expect(r.check.totals.quantity).toEqual([{ uom: 'ea', old: 4, new: 4 }, { uom: 'kg', old: 1234, new: 1234 }]);
  });

  it('a loose item by weight compares to the gram, three decimals: one gram short is a difference — never rounded away', () => {
    const r = eveningCheck({ ...base, itemWise: [...base.itemWise.filter((x) => x.code !== 'L1'), row(5, 'L1', 1233, 17_276, 0)] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.check.items.find((i) => i.productId === 'L1')).toMatchObject({ uom: 'kg', old: { quantityMinor: 1233 }, new: { quantityMinor: 1234 }, differs: ['quantity'] });
    expect(r.check.comparisons).toEqual(expect.arrayContaining([
      { area: 'item_quantity', subject: 'L1', legacyValue: 1233, newValue: 1234, toleranceMinor: 0 },
      { area: 'stock_movement', subject: 'kg', legacyValue: 1233, newValue: 1234, toleranceMinor: 0 },
    ]));
    // A unit spelt "KG" in the catalogue is the same kilogram.
    const spelt = eveningCheck({ ...base, catalogue: CATALOGUE.map((p) => (p.productId === 'L1' ? { ...p, uom: 'KG' } : p)) });
    expect(spelt.ok && spelt.check.items.find((i) => i.productId === 'L1')).toMatchObject({ uom: 'kg', differs: [] });
  });

  it('a part quantity of an item sold in whole units is NOT refused: compared in thousandths, and its quantity differs — visible', () => {
    const r = eveningCheck({ ...base, itemWise: [...base.itemWise.filter((x) => x.code !== 'S1'), row(4, 'S1', 1500, 30_000, taxAt(30_000, 1800))] });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.check.items.find((i) => i.productId === 'S1')).toMatchObject({ uom: 'ea', quantityInThousandths: true, old: { quantityMinor: 1500 }, new: { quantityMinor: 2000 }, differs: ['quantity'] });
    expect(r.check.comparisons).toEqual(expect.arrayContaining([
      { area: 'item_quantity', subject: 'S1', legacyValue: 1500, newValue: 2000, toleranceMinor: 0 },
      // The "each" total is then kept in thousandths for every item of that unit, and says so in its subject.
      { area: 'stock_movement', subject: 'ea/1000', legacyValue: 3500, newValue: 4000, toleranceMinor: 0 },
    ]));
    // Two old rows that add up to a whole number compare in whole units again.
    const whole = eveningCheck({ ...base, itemWise: [...base.itemWise.filter((x) => x.code !== 'S1'), row(4, 'S1', 1500, 15_000, taxAt(15_000, 1800)), row(7, 'S1', 500, 15_000, taxAt(15_000, 1800))] });
    expect(whole.ok && whole.check.items.find((i) => i.productId === 'S1')).toMatchObject({ old: { quantityMinor: 2 }, differs: [] });
  });

  it('nothing is dropped: a code not in the catalogue, an item with no department, a new-till product the catalogue lacks — each in its own group', () => {
    const r = eveningCheck({
      ...base,
      itemWise: [...base.itemWise, row(8, 'X-404', 1000, 5000, 0), row(9, 'N1', 1000, 2000, 0)],
      sales: [...base.sales, sale(4, 'OLD/3', [{ productId: 'GONE', quantityMinor: 1, uom: 'ea', lineTotalMinor: 700, taxRateBps: 0 }]), sale(5, 'OLD/5', [{ productId: 'N1', quantityMinor: 1, uom: 'ea', lineTotalMinor: 2000, taxRateBps: 0 }])],
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    const d = r.check.departments!;
    expect(d.slice(-2).map((x) => [x.group, x.name, x.items, x.value])).toEqual([
      ['no_department', 'Department not known', 1, { old: 2000, new: 2000 }],
      ['not_in_catalogue', 'Not in the new catalogue', 2, { old: 5000, new: 700 }],
    ]);
    expect(r.check.items.find((i) => i.productId === 'GONE')).toMatchObject({ notInCatalogue: true, uom: 'ea', differs: ['quantity', 'value'] });
    expect(r.check.comparisons).toEqual(expect.arrayContaining([
      { area: 'item_not_in_catalogue', subject: 'X-404', legacyValue: 1, newValue: 0, toleranceMinor: 0 },
      { area: 'item_value', subject: 'GONE', legacyValue: 0, newValue: 700, toleranceMinor: 0 },
    ]));
    expect(d.reduce((a, x) => a + x.value.new, 0)).toBe(r.check.totals.value.new);
    expect(d.reduce((a, x) => a + x.value.old, 0)).toBe(r.check.totals.value.old);
  });

  it('every bill is rung on both: an old bill not keyed is a difference even with no item lines; with lines, the whole bill is compared', () => {
    const presence = eveningCheck({ ...base, sales: [sale(1, 'OLD/1', [rice(1), shampoo(2)]), sale(2, 'OLD/2', [dal(1234)])] });
    expect(presence.ok && presence.check.bills).toEqual({
      checked: 'presence_only', valueBasis: 'with_tax', valueNotKnown: 0, matched: 2,
      differences: [{ billNumber: 'OLD/3', kind: 'not_keyed', oldValueMinor: 9000 }],
    });
    const withLines = eveningCheck({
      ...base,
      billWise: {
        withLines: true,
        bills: [
          // Every line of the bill counts, whatever its department: rice and one shampoo — the till has two shampoos.
          { billNumber: 'OLD/1', line: 2, totalMinor: 63_000, lines: [{ line: 2, code: 'P1', valueMinor: 48_000 }, { line: 3, code: '8900000000099', valueMinor: 15_000 }] },
          { billNumber: 'OLD/2', line: 4, totalMinor: 17_276, lines: [{ line: 4, code: 'L1', quantityThousandths: 1234, valueMinor: 17_276 }] },
          { billNumber: 'OLD/3', line: 5, totalMinor: 9000, lines: [{ line: 5, code: 'H1', valueMinor: 9000 }] },
        ],
      },
    });
    expect(withLines.ok && withLines.check.bills).toEqual({
      checked: 'lines', valueBasis: 'with_tax', valueNotKnown: 0, matched: 2,
      differences: [{ billNumber: 'OLD/1', kind: 'value_differs', oldValueMinor: 63_000, newValueMinor: 78_000, newBill: 'B1' }],
    });
  });

  it('far too many differences is still refused — said as a wrong mapping or a file kept to one department, never "the pilot department"', () => {
    const whole = Array.from({ length: MAX_DAY_DIFFERENCES + 1 }, (_, i) => row(i + 2, `X${i}`, 1000, 100, 0));
    const r = eveningCheck({ ...base, itemWise: whole });
    expect(r).toMatchObject({ ok: false, refusedBecause: 'too_many_differences' });
    expect(!r.ok && r.detail).toContain('kept to one department');
    expect(!r.ok && r.detail).not.toContain('pilot');
    expect(eveningCheck({ ...base, catalogue: [] })).toMatchObject({ ok: false, refusedBecause: 'no_catalogue' });
  });
});
