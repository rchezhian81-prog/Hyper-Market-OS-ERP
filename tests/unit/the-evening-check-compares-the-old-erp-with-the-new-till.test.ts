import { describe, it, expect } from 'vitest';
import { eveningCheck, subjectOf, MAX_DAY_DIFFERENCES, type CheckProduct, type CheckRefund, type CheckSale } from '../../packages/migration/src/evening-check';
import type { ItemWiseRow, OldBill } from '../../packages/migration/src/old-erp-reports';
import { compareParallelDay, currentDifferences, differencePrefixFor, ownDifference, type DayComparison } from '../../packages/migration/src/cutover';
import { dayDigestOf, signParallelDay } from '../../packages/migration/src/parallel-day-sign';

/**
 * OB-263 (owner, 21 Oct 2026) — the evening check's comparison engine: the old ERP's item-wise and bill-wise figures for a
 * day (already read through their mappings) against the new till's mirror sales and refunds for the same day.
 *
 *   • only the PILOT DEPARTMENT (the catalogue's department of each product); other departments counted and said; an old
 *     code that matches NO catalogue product listed "not in the new catalogue" — a difference, never dropped;
 *   • per item: quantity, value and tax; the new side is the day's mirror sales LESS its mirror refunds (OB-258);
 *   • the totals: value, tax, quantity per unit, the number of bills — "not known" where it cannot be known, never 0;
 *   • per bill by the old bill number (OB-264): not keyed, not on the old list, value differs — or presence only, said;
 *   • returns, credit notes and exchanges on the old files (OB-269) listed to EXPLAIN, never matched;
 *   • payments and loyalty not compared (OB-256, OB-265);
 *   • it becomes the MG-10 day: each line beyond tolerance its own difference, so the day cannot be signed until each has a
 *     reason; a reload with other figures numbers its differences apart from the ones it replaces.
 * Synthetic data only.
 */

const DAY = '2026-10-21';
const DEPT = { categoryId: 'grocery', name: 'Grocery' };
const CATALOGUE: CheckProduct[] = [
  { productId: 'P1', name: 'Toor dal 1kg', barcodes: ['8901234567890'], categoryId: 'grocery', uom: 'ea', taxBps: 500 },
  { productId: 'P2', name: 'Loose rice', barcodes: [], categoryId: 'grocery', uom: 'kg', taxBps: 0 },
  { productId: 'P3', name: 'Sugar 1kg', barcodes: ['8900000000003'], categoryId: 'grocery', uom: 'ea', taxBps: 500 },
  { productId: 'S1', name: 'Shampoo', barcodes: ['8900000000099'], categoryId: 'personal_care', uom: 'ea', taxBps: 1800 },
];
const tax5 = (incl: number): number => incl - Math.round((incl * 10_000) / 10_500);
const row = (line: number, code: string, qty: number, value: number, tax: number): ItemWiseRow => ({ line, code, quantityThousandths: qty, valueMinor: value, taxMinor: tax });
const sale = (n: number, oldBill: string | undefined, lines: CheckSale['lines'], day = DAY): CheckSale => ({ saleId: `S-${n}`, number: `B${n}`, tradingDay: day, lines, ...(oldBill === undefined ? {} : { oldErpBillNumber: oldBill }) });
const dal = (q: number) => ({ productId: 'P1', quantityMinor: q, uom: 'ea', lineTotalMinor: 10_500 * q, taxRateBps: 500 });
const rice = (g: number, value: number) => ({ productId: 'P2', quantityMinor: g, uom: 'kg', lineTotalMinor: value, taxRateBps: 0 });

const base = {
  businessDate: DAY, department: DEPT, catalogue: CATALOGUE, tolerance: { valueMinor: 0, taxMinor: 0 },
  sales: [sale(1, 'OLD/1', [dal(2)]), sale(2, 'OLD/2', [rice(1250, 7500)]), sale(9, 'OLD/9', [dal(1)], '2026-10-20')],
  refunds: [] as CheckRefund[],
  itemWise: [row(3, 'P1', 2000, 21_000, tax5(21_000)), row(4, 'P2', 1250, 7500, 0)],
  billWise: { bills: [{ billNumber: 'OLD/1', line: 2, totalMinor: 21_000 }, { billNumber: 'OLD/2', line: 3, totalMinor: 7500 }] as OldBill[], withLines: false },
};

describe('the evening check, item by item and in total', () => {
  it('a day that agrees: every item, the totals and every keyed bill; payments and loyalty not compared', () => {
    const r = eveningCheck(base);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.check;
    expect(c.items.map((i) => [i.productId, i.differs])).toEqual([['P1', []], ['P2', []]]);
    expect(c.totals).toEqual({
      value: { old: 28_500, new: 28_500 }, tax: { old: 1000, new: { known: true, minor: 1000 } },
      quantity: [{ uom: 'ea', old: 2, new: 2 }, { uom: 'kg', old: 1250, new: 1250 }],
      bills: { old: { known: false, why: expect.stringContaining('no item lines') }, new: 2 },
    });
    expect(c.bills).toEqual({ checked: 'presence_only', valueBasis: 'with_tax', valueNotKnown: 0, matched: 2, differences: [] });
    expect(c.notCompared).toEqual([{ area: 'payments', decision: 'OB-256' }, { area: 'loyalty', decision: 'OB-265' }]);
    // The MG-10 day: the totals only (no bill count: not known — never a 0); nothing beyond tolerance.
    expect(c.comparisons.map((x) => [x.area, x.subject])).toEqual([['sales_value', undefined], ['tax', undefined], ['stock_movement', 'ea'], ['stock_movement', 'kg']]);
    expect(compareParallelDay({ tenantId: 't', businessDate: DAY, comparisons: c.comparisons }).differences).toEqual([]);
  });

  it('keeps only the pilot department: another department\'s rows counted and not compared; a code the catalogue lacks listed', () => {
    const r = eveningCheck({ ...base, itemWise: [...base.itemWise, row(5, '8900000000099', 1000, 25_000, 3814), row(6, 'X-404', 1000, 5000, 238)] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.check.otherDepartments).toEqual({ rows: 1, valueMinor: 25_000 });
    expect(r.check.notInCatalogue).toEqual([{ code: 'X-404', quantityThousandths: 1000, valueMinor: 5000, taxMinor: 238, lines: [6] }]);
    expect(r.check.totals.value).toEqual({ old: 33_500, new: 28_500 });
    expect(r.check.comparisons).toEqual(expect.arrayContaining([{ area: 'item_not_in_catalogue', subject: 'X-404', legacyValue: 1, newValue: 0, toleranceMinor: 0 }]));
  });

  it('matches an old code by product id or barcode; a quantity, value and tax that differ are each their own line', () => {
    const r = eveningCheck({ ...base, itemWise: [row(3, '8901234567890', 3000, 31_500, tax5(31_500)), row(4, 'P2', 1250, 7500, 0)] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.check.items.find((i) => i.productId === 'P1')).toMatchObject({ oldCodes: ['8901234567890'], differs: ['quantity', 'value', 'tax'] });
    expect(r.check.comparisons.filter((c) => c.subject === 'P1')).toEqual([
      { area: 'item_quantity', subject: 'P1', legacyValue: 3, newValue: 2, toleranceMinor: 0 },
      { area: 'item_value', subject: 'P1', legacyValue: 31_500, newValue: 21_000, toleranceMinor: 0 },
      { area: 'item_tax', subject: 'P1', legacyValue: tax5(31_500), newValue: tax5(21_000), toleranceMinor: 0 },
    ]);
    // Within the value tolerance, a value is not a difference; a quantity always is.
    const tolerant = eveningCheck({ ...base, tolerance: { valueMinor: 20_000, taxMinor: 20_000 }, itemWise: [row(3, 'P1', 3000, 31_500, tax5(31_500)), row(4, 'P2', 1250, 7500, 0)] });
    expect(tolerant.ok && tolerant.check.items.find((i) => i.productId === 'P1')!.differs).toEqual(['quantity']);
  });

  it('the new side is the day\'s sales LESS the day\'s refunds, the refund spread at the bill\'s own prices', () => {
    const refunds: CheckRefund[] = [{ returnId: 'R-1', originalSaleId: 'S-1', tradingDay: DAY, refundMinor: 10_500, lines: [{ productId: 'P1', quantityMinor: 1 }] }];
    const r = eveningCheck({ ...base, refunds, itemWise: [row(3, 'P1', 1000, 10_500, tax5(10_500)), row(4, 'P2', 1250, 7500, 0)] });
    expect(r.ok && r.check.items.find((i) => i.productId === 'P1')).toMatchObject({ new: { quantityMinor: 1, valueMinor: 10_500, tax: { known: true, minor: tax5(10_500) } }, differs: [] });
  });

  it('tax the till did not record a rate for is NOT KNOWN — never a zero — and its tax lines are not compared', () => {
    const catalogue = CATALOGUE.map((p) => (p.productId === 'P2' ? { ...p, taxBps: undefined } : p)) as CheckProduct[];
    const r = eveningCheck({ ...base, catalogue, sales: [sale(1, 'OLD/1', [dal(2)]), sale(2, 'OLD/2', [{ productId: 'P2', quantityMinor: 1250, uom: 'kg', lineTotalMinor: 7500 }])] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.check.totals.tax.new).toEqual({ known: false, why: expect.stringContaining('no tax rate') });
    expect(r.check.comparisons.some((c) => c.area === 'tax')).toBe(false);
  });

  it('a whole-unit item with a part quantity on the old report is refused, in words', () => {
    expect(eveningCheck({ ...base, itemWise: [row(3, 'P1', 1500, 15_750, 750)] })).toMatchObject({ ok: false, refusedBecause: 'quantity_not_whole' });
  });
});

describe('bill by bill, by the old bill number (OB-264)', () => {
  const withLines = (bills: OldBill[]) => ({ bills, withLines: true });
  it('with the bills\' item lines: not keyed, not on the old list, a value that differs; bills without pilot items ignored', () => {
    const r = eveningCheck({
      ...base,
      sales: [sale(1, 'OLD/1', [dal(2)]), sale(2, 'OLD/22', [rice(1250, 7500)])],
      billWise: withLines([
        { billNumber: 'OLD/1', line: 2, totalMinor: 31_500, lines: [{ line: 2, code: 'P1', valueMinor: 21_000 }, { line: 3, code: '8900000000099', valueMinor: 10_500 }] },
        { billNumber: 'OLD/2', line: 4, totalMinor: 7500, lines: [{ line: 4, code: 'P2', valueMinor: 7500 }] },
        { billNumber: 'OLD/3', line: 5, totalMinor: 9900, lines: [{ line: 5, code: 'S1', valueMinor: 9900 }] },
        { billNumber: 'OLD/4', line: 6, totalMinor: 10_500, lines: [{ line: 6, code: 'P1', valueMinor: 10_000 }] },
      ]),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.check.bills).toEqual({
      checked: 'lines', valueBasis: 'with_tax', valueNotKnown: 0, matched: 1,
      differences: [
        { billNumber: 'OLD/2', kind: 'not_keyed', oldValueMinor: 7500 },
        { billNumber: 'OLD/4', kind: 'not_keyed', oldValueMinor: 10_000 },
        { billNumber: 'OLD/22', kind: 'not_on_old', newValueMinor: 7500, newBill: 'B2' },
      ],
    });
    expect(r.check.totals.bills).toEqual({ old: { known: true, minor: 3 }, new: 2 });
    expect(r.check.comparisons).toEqual(expect.arrayContaining([
      { area: 'sales_count', legacyValue: 3, newValue: 2, toleranceMinor: 0 },
      { area: 'bill_not_keyed', subject: 'OLD/2', legacyValue: 1, newValue: 0, toleranceMinor: 0 },
      { area: 'bill_not_on_old', subject: 'OLD/22', legacyValue: 0, newValue: 1, toleranceMinor: 0 },
    ]));
    const differs = eveningCheck({ ...base, billWise: withLines([{ billNumber: 'OLD/1', line: 2, totalMinor: 20_000, lines: [{ line: 2, code: 'P1', valueMinor: 20_000 }] }, { billNumber: 'OLD/2', line: 3, totalMinor: 7500, lines: [{ line: 3, code: 'P2', valueMinor: 7500 }] }]) });
    expect(differs.ok && differs.check.bills.differences).toEqual([{ billNumber: 'OLD/1', kind: 'value_differs', oldValueMinor: 20_000, newValueMinor: 21_000, newBill: 'B1' }]);
  });

  it('without the item lines only presence is checked, and the result says so', () => {
    const r = eveningCheck({ ...base, sales: [sale(1, 'OLD/1', [dal(2)]), sale(2, 'OLD/99', [rice(1250, 7500)])] });
    expect(r.ok && r.check.bills).toEqual({ checked: 'presence_only', valueBasis: 'with_tax', valueNotKnown: 0, matched: 1, differences: [{ billNumber: 'OLD/99', kind: 'not_on_old', newValueMinor: 7500, newBill: 'B2' }] });
  });

  it('a credit note, a return or an exchange on the old files is listed to EXPLAIN — never matched to anything (OB-269)', () => {
    const r = eveningCheck({
      ...base,
      itemWise: [...base.itemWise, row(9, 'P1', -1000, -10_500, -500)],
      billWise: withLines([
        { billNumber: 'OLD/1', line: 2, totalMinor: 21_000, lines: [{ line: 2, code: 'P1', valueMinor: 21_000 }] },
        { billNumber: 'OLD/2', line: 3, totalMinor: 7500, lines: [{ line: 3, code: 'P2', valueMinor: 7500 }] },
        { billNumber: 'CN/5', line: 4, totalMinor: -10_500, lines: [{ line: 4, code: 'P1', valueMinor: -10_500 }] },
      ]),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.check.explain).toEqual([
      { subject: 'item:P1@9', source: 'item_wise', line: 9, code: 'P1', valueMinor: -10_500 },
      { subject: 'bill:CN/5', source: 'bill_wise', line: 4, billNumber: 'CN/5', valueMinor: -10_500 },
    ]);
    expect(r.check.bills.differences).toEqual([]);
    expect(r.check.comparisons.filter((c) => c.area === 'old_return').map((c) => c.subject)).toEqual(['item:P1@9', 'bill:CN/5']);
  });
});

describe('OB-263 A and B (owner, 21 Oct 2026): the file\'s own department, and bill lines before tax', () => {
  const withLines = (bills: OldBill[], lineValuesIncludeTax?: boolean) => ({ bills, withLines: true, ...(lineValuesIncludeTax === undefined ? {} : { lineValuesIncludeTax }) });
  const exTax = (incl: number): number => incl - tax5(incl);

  it('B: bill lines before tax are compared without tax against the new till\'s lines without tax — and said', () => {
    const bills = [
      { billNumber: 'OLD/1', line: 2, totalMinor: 21_000, lines: [{ line: 2, code: 'P1', valueMinor: exTax(21_000) }] },
      { billNumber: 'OLD/2', line: 3, totalMinor: 7500, lines: [{ line: 3, code: 'P2', valueMinor: 7000 }] },
    ];
    const r = eveningCheck({ ...base, billWise: withLines(bills, false) });
    expect(r.ok && r.check.bills).toEqual({
      checked: 'lines', valueBasis: 'without_tax', valueNotKnown: 0, matched: 1,
      // Rice is 0% tax, so without tax it is still 7500 — the old line's 7000 differs.
      differences: [{ billNumber: 'OLD/2', kind: 'value_differs', oldValueMinor: 7000, newValueMinor: 7500, newBill: 'B2' }],
    });
    // The same before-tax lines read as if they included tax would differ on every bill: the answer matters.
    const asIfWith = eveningCheck({ ...base, billWise: withLines(bills, true) });
    expect(asIfWith.ok && asIfWith.check.bills.differences.map((b) => b.billNumber)).toEqual(['OLD/1', 'OLD/2']);
  });

  it('B: a new-till line with no tax rate leaves that bill\'s value without tax NOT KNOWN — counted, never compared as a zero', () => {
    const catalogue = CATALOGUE.map((p) => (p.productId === 'P1' ? { ...p, taxBps: undefined } : p)) as CheckProduct[];
    const r = eveningCheck({
      ...base, catalogue,
      sales: [sale(1, 'OLD/1', [{ productId: 'P1', quantityMinor: 2, uom: 'ea', lineTotalMinor: 21_000 }]), sale(2, 'OLD/2', [rice(1250, 7500)])],
      billWise: withLines([{ billNumber: 'OLD/1', line: 2, totalMinor: 21_000, lines: [{ line: 2, code: 'P1', valueMinor: 20_000 }] }, { billNumber: 'OLD/2', line: 3, totalMinor: 7500, lines: [{ line: 3, code: 'P2', valueMinor: 7500 }] }], false),
    });
    expect(r.ok && r.check.bills).toMatchObject({ valueBasis: 'without_tax', valueNotKnown: 1, matched: 1, differences: [] });
  });

  it('A: a file kept to the pilot department by its own column lists every unmatched code — never refused as "the whole shop"', () => {
    const many = Array.from({ length: 1001 }, (_, i) => row(i + 2, `X${i}`, 1000, 100, 0));
    expect(eveningCheck({ ...base, itemWise: many })).toMatchObject({ ok: false, detail: expect.stringContaining('save it again for the pilot department') });
    const filtered = eveningCheck({ ...base, itemWise: many, departmentFiltered: true });
    // Still far too many differences for one day (the safety cap) — but said as a wrong mapping, not "the whole shop".
    expect(filtered).toMatchObject({ ok: false, refusedBecause: 'too_many_differences' });
    expect(!filtered.ok && filtered.detail).not.toContain('save it again for the pilot department');
    const few = eveningCheck({ ...base, itemWise: [...base.itemWise, row(9, 'X-1', 1000, 100, 0)], departmentFiltered: true });
    expect(few.ok && few.check.notInCatalogue.map((n) => n.code)).toEqual(['X-1']);
  });
});

describe('what it refuses, in words', () => {
  it('no pilot department, no catalogue, a phone number in the item column, far too many differences', () => {
    expect(eveningCheck({ ...base, department: undefined })).toMatchObject({ ok: false, refusedBecause: 'no_pilot_department' });
    expect(eveningCheck({ ...base, catalogue: [] })).toMatchObject({ ok: false, refusedBecause: 'no_catalogue' });
    expect(eveningCheck({ ...base, itemWise: [row(3, '9876543210', 1000, 100, 0)] })).toMatchObject({ ok: false, refusedBecause: 'code_looks_personal', detail: expect.stringContaining('looks like a phone number') });
    const whole = Array.from({ length: MAX_DAY_DIFFERENCES + 1 }, (_, i) => row(i + 2, `X${i}`, 1000, 100, 0));
    expect(eveningCheck({ ...base, itemWise: whole })).toMatchObject({ ok: false, refusedBecause: 'too_many_differences', detail: expect.stringContaining('save it again for the pilot department (Grocery) only') });
  });
  it('a subject head office can keep: odd characters become "_", at most 64', () => {
    expect(subjectOf('A&B (1)')).toBe('A_B _1_');
    expect(subjectOf('#7')).toBe('x#7');
    expect(subjectOf('9'.repeat(80))).toHaveLength(64);
  });
});

describe('the MG-10 day: a reason on every difference before the day is signed', () => {
  const r = eveningCheck({ ...base, itemWise: [row(3, 'P1', 3000, 31_500, tax5(31_500)), row(4, 'P2', 1250, 7500, 0)] });
  const comparisons = r.ok ? r.check.comparisons : [];
  const sign = (differences: Parameters<typeof signParallelDay>[0]['differences']) => signParallelDay({
    businessDate: DAY, comparisons, differences, signedBy: 'u-owner', statement: 'compared the old item-wise report line by line with the new till',
    now: `${DAY}T20:00:00.000Z`, reconcilerUserId: 'u-owner', ownerUserId: undefined,
  });

  it('refused while any line has no reason, naming each; signed once every one has one', () => {
    let diffs = [...compareParallelDay({ tenantId: 't', businessDate: DAY, comparisons }).differences];
    expect(diffs.map((d) => [d.area, d.subject ?? ''])).toEqual([
      ['sales_value', ''], ['tax', ''], ['stock_movement', 'ea'], ['item_quantity', 'P1'], ['item_value', 'P1'], ['item_tax', 'P1'],
    ]);
    const refused = sign(diffs);
    expect(refused).toMatchObject({ ok: false, refusedBecause: 'unexplained_material_difference' });
    expect(!refused.ok && refused.detail).toContain('item quantity P1');
    for (const d of diffs) diffs = [...ownDifference({ differences: diffs, differenceId: d.differenceId, ownerUserId: 'u-owner', explanation: 'one bag of dal rung on the old till only while the new till was stopped' }).differences];
    const signed = sign(diffs);
    expect(signed.ok).toBe(true);
    expect(signed.ok && signed.signature.differences.find((d) => d.area === 'item_value')).toMatchObject({ subject: 'P1' });
  });

  it('the digest covers each line\'s subject, and a day total typed by hand digests exactly as it always did', () => {
    const typed: DayComparison[] = [{ area: 'sales_value', legacyValue: 100, newValue: 90, toleranceMinor: 0 }];
    // The digest of a typed day before OB-263, computed the old way, by hand.
    const oldWay = (text: string): string => {
      let h1 = 0x811c9dc5; let h2 = 0x01000193;
      for (let i = 0; i < text.length; i += 1) { const c = text.charCodeAt(i); h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0; h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0; }
      return `day-${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
    };
    expect(dayDigestOf(typed)).toBe(oldWay('sales_value:100:90:0'));
    const a: DayComparison[] = [{ area: 'item_value', subject: 'P1', legacyValue: 1, newValue: 2, toleranceMinor: 0 }];
    expect(dayDigestOf(a)).not.toBe(dayDigestOf([{ ...a[0]!, subject: 'P2' }]));
  });

  it('a day recorded again with other figures: fresh ids, and only its current differences count', () => {
    const first = compareParallelDay({ tenantId: 't', businessDate: DAY, comparisons, idPrefix: differencePrefixFor(false, dayDigestOf(comparisons)) });
    const other: DayComparison[] = [{ area: 'sales_value', legacyValue: 1, newValue: 2, toleranceMinor: 0 }];
    const again = compareParallelDay({ tenantId: 't', businessDate: DAY, comparisons: other, idPrefix: differencePrefixFor(true, dayDigestOf(other)) });
    expect(first.differences[0]!.differenceId).toBe(`PD-${DAY}-001`);
    expect(again.differences[0]!.differenceId).toMatch(new RegExp(`^PD-[0-9a-f]{8}-${DAY}-001$`));
    expect(currentDifferences([again], [...first.differences, ...again.differences])).toEqual(again.differences);
  });
});
