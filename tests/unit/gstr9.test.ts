import { describe, it, expect } from 'vitest';
import {
  foldGstr9, reconcileGstr9c, computeGstr1Figures, parseFinancialYear, ZERO_HEADS,
  type AnnualMonthInput, type Gstr3bLock, type SoldTaxLine, type CarriedAmendment,
} from '../../packages/finance/src/index';

/**
 * R3 A18 — GSTR-9 folded from the twelve filed months, GSTR-9C reconciling the books to it with every difference
 * named (signed OB-188). The shop's band (₹5–10 crore, D2) needs both.
 */

const FY = '2027-28';
const TURNOVER = 5_00_00_000_00 + 1;
const sale = (lineTotalMinor: number, rateBps = 500): SoldTaxLine => ({ productId: 'p-paneer', quantityMinor: 1, uom: 'EA', lineTotalMinor, hsnCode: '040610', rateBps });
const figuresFor = (period: string, sold: SoldTaxLine[]) => computeGstr1Figures({ period, sold, returned: [], taxTable: [], annualTurnoverMinor: TURNOVER, documents: [], amendmentsIn: [] }).figures;
const lockFor = (period: string, sold: SoldTaxLine[]): Gstr3bLock => ({ period, figures: figuresFor(period, sold), arn: `ARN-${period}`, lockedBy: 'u', lockedAt: '2027-01-01T00:00:00.000Z', filedDigest: 'd', computedDigest: 'd' });
const ITC = { status: 'reconciled' as const, igstMinor: 0, cgstMinor: 100, sgstMinor: 100, cessMinor: 0, detail: 'synthetic' };

/** A clean year: every month filed, locked, and the day book posting exactly what the till banked. */
function cleanYear(over: (m: AnnualMonthInput) => AnnualMonthInput = (m) => m): AnnualMonthInput[] {
  return parseFinancialYear(FY).periods.map((period) => over({
    period, lock: lockFor(period, [sale(10_500)]), gstr3bFiled: true, current: figuresFor(period, [sale(10_500)]), amendmentsOut: [],
    reverseCharge: { liability: ZERO_HEADS, itcPaid: ZERO_HEADS }, itc: ITC,
    books: { turnoverMinor: 10_000, taxMinor: 500 }, daysNotInBooks: [],
  }));
}

describe('GSTR-9 — folded from the twelve filed months', () => {
  it('a complete year sums the twelve locked months; ITC sums the reconciled months', () => {
    const g = foldGstr9({ fy: FY, months: cleanYear() });
    expect(g.complete).toBe(true);
    expect(g.table4Outward.heads.taxableMinor).toBe(12 * 10_000);
    expect(g.table6Itc.allOther).toMatchObject({ status: 'reconciled', cgstMinor: 1_200 });
  });

  it('a month not filed is listed and the year is INCOMPLETE; an unreconciled month makes the ITC "not known", never zero', () => {
    const months = cleanYear((m) => (m.period === '092027' ? { ...m, lock: undefined, gstr3bFiled: false, itc: { status: 'not_reconciled', detail: 'ITC not yet reconciled' } } : m));
    const g = foldGstr9({ fy: FY, months });
    expect(g.complete).toBe(false);
    expect(g.missing).toEqual([{ period: '092027', reason: 'gstr1_not_filed_and_locked' }, { period: '092027', reason: 'gstr3b_not_recorded_filed' }]);
    expect(g.table6Itc.allOther).toMatchObject({ status: 'not_known', monthsNotReconciled: ['092027'] });
    expect(g.table4Outward.heads.taxableMinor).toBe(11 * 10_000);
  });

  it('an amendment of a month of the year is Tables 10/11, and counts in what the year declares', () => {
    const am: CarriedAmendment = { amendmentId: 'AM-1', fromPeriod: '032028', intoPeriod: '042028', delta: { heads: { taxableMinor: 2_000, cgstMinor: 50, sgstMinor: 50, igstMinor: 0 }, nilMinor: 0 }, reason: 'synthetic', recordedBy: 'u', recordedAt: '2028-04-02T00:00:00.000Z' };
    const g = foldGstr9({ fy: FY, months: cleanYear((m) => (m.period === '032028' ? { ...m, amendmentsOut: [am] } : m)) });
    expect(g.table10And11Amendments.heads.taxableMinor).toBe(2_000);
    expect(g.declared.heads.taxableMinor).toBe(12 * 10_000 + 2_000);
  });
});

describe('GSTR-9C — the books against GSTR-9, every difference with a reason', () => {
  it('books that equal the filed year leave nothing to explain', () => {
    const months = cleanYear();
    const c = reconcileGstr9c({ fy: FY, months, gstr9: foldGstr9({ fy: FY, months }), reasons: [] });
    expect(c.unreconciled).toEqual({ turnoverMinor: 0, taxMinor: 0 });
    expect(c.differences).toEqual([]);
  });

  it('a day not posted to the day book, and a sale banked after filing, are each named; open until a person gives a reason', () => {
    const months = cleanYear((m) => {
      if (m.period === '052027') return { ...m, books: null, daysNotInBooks: ['2027-05-14'] };
      if (m.period === '062027') return { ...m, current: figuresFor('062027', [sale(10_500), sale(2_100)]), books: { turnoverMinor: 12_000, taxMinor: 600 } };
      return m;
    });
    const gstr9 = foldGstr9({ fy: FY, months });
    const c = reconcileGstr9c({ fy: FY, months, gstr9, reasons: [] });
    expect(c.differences).toEqual([
      expect.objectContaining({ period: '052027', code: 'books_differ_from_till', turnoverMinor: -10_000, explained: false, reason: 'the day book has not been posted for 2027-05-14' }),
      expect.objectContaining({ period: '062027', code: 'changed_after_gstr1_filed_not_amended', turnoverMinor: 2_000, taxMinor: 100, explained: false }),
    ]);
    // The differences add up to the whole gap: nothing is netted away.
    expect(c.differences.reduce((s, d) => s + d.turnoverMinor, 0)).toBe(c.unreconciled.turnoverMinor);
    expect(c.books.monthsWithNoBooks).toEqual(['052027']);
    const explained = reconcileGstr9c({ fy: FY, months, gstr9, reasons: [{ period: '062027', code: 'changed_after_gstr1_filed_not_amended', reason: 'declared in the annual return (synthetic)', by: 'u-acct', at: '2028-11-01T00:00:00.000Z' }] });
    expect(explained.differences.find((d) => d.period === '062027')).toMatchObject({ explained: true, reasonBy: 'u-acct' });
    expect(explained.open).toBe(1);
  });

  it('a month never filed is its own difference', () => {
    const months = cleanYear((m) => (m.period === '012028' ? { ...m, lock: undefined } : m));
    const c = reconcileGstr9c({ fy: FY, months, gstr9: foldGstr9({ fy: FY, months }), reasons: [] });
    expect(c.differences).toEqual([expect.objectContaining({ period: '012028', code: 'month_not_filed', turnoverMinor: 10_000, explained: false })]);
  });
});
