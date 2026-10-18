import { describe, it, expect } from 'vitest';
import {
  computeGstr1Figures, buildGstr3b, evaluateGstr3bLock, refuseOutwardChange, evaluateAmendment, gstr1CanonicalForm,
  parseMonthlyPeriod, InvalidGstPeriod, nextMonthlyPeriod, periodsBetween, financialYearOfPeriod, parseFinancialYear,
  ITC_NOT_YET_RECONCILED, ZERO_HEADS, grossOf, taxOf,
  type SoldTaxLine, type Gstr3bLock, type CarriedAmendment, type ItcForPeriod,
} from '../../packages/finance/src/index';

/**
 * R3 A15 / A16 — the GSTR-3B engine (signed OB-188). 3B Table 3.1 equals GSTR-1's total and the till's banked sales less
 * returns to the paisa; every difference is named; once GSTR-1 is filed the outward figure is locked and no input
 * changes it; a correction is an amendment declared in the next month. Monthly periods only (D2).
 */

const P = '052027';
const TURNOVER = 5_00_00_000_00 + 1; // the owner's ₹5–10 crore band (D2): 6-digit HSN
const line = (productId: string, lineTotalMinor: number, rateBps: number, hsnCode = '040610'): SoldTaxLine => ({ productId, quantityMinor: 1, uom: 'EA', lineTotalMinor, hsnCode, rateBps });
const ITC_NONE: ItcForPeriod = { status: 'not_reconciled', detail: 'ITC not yet reconciled' };
const NO_RC = { liability: ZERO_HEADS, itcPaid: ZERO_HEADS };

const month = (sold: SoldTaxLine[], returned: SoldTaxLine[] = [], amendmentsIn: CarriedAmendment[] = []) =>
  computeGstr1Figures({ period: P, sold, returned, taxTable: [], annualTurnoverMinor: TURNOVER, documents: [], amendmentsIn });

const lockOf = (fig: ReturnType<typeof month>['figures'], digest = 'd1'): Gstr3bLock => ({
  period: P, figures: fig, arn: 'ARN-SYN-1', lockedBy: 'u-acct', lockedAt: '2027-06-12T05:00:00.000Z', filedDigest: digest, computedDigest: digest,
});

describe('monthly periods only (D2: ₹5–10 crore — no quarterly scheme)', () => {
  it('reads MMYYYY and refuses a quarter or any other form by name', () => {
    expect(parseMonthlyPeriod('052027')).toMatchObject({ from: '2027-05-01', to: '2027-05-31', month: 5, year: 2027 });
    expect(parseMonthlyPeriod('022028').to).toBe('2028-02-29');
    for (const bad of ['Q1-2027', '042027-062027', '132027', '2027-05', '52027', '']) expect(() => parseMonthlyPeriod(bad)).toThrow(InvalidGstPeriod);
    expect(() => parseMonthlyPeriod('Q1-2027')).toThrow(/files monthly/);
    expect(nextMonthlyPeriod('122027')).toBe('012028');
    expect(periodsBetween('112027', '022028')).toEqual(['112027', '122027', '012028', '022028']);
    expect(financialYearOfPeriod('032028')).toBe('2027-28');
    expect(parseFinancialYear('2027-28').periods).toHaveLength(12);
    expect(() => parseFinancialYear('2027-29')).toThrow(InvalidGstPeriod);
  });
});

describe('A15 — 3.1 equals the till and GSTR-1 to the paisa', () => {
  it('a month with a sale and a return: 3.1(a) is the net, equal to GSTR-1 and the till, with no difference', () => {
    const c = month([line('p-paneer', 10_500, 500), line('p-ghee', 11_800, 1800)], [line('p-paneer', 2_100, 500)]);
    const r = buildGstr3b({ period: P, current: c, gstr1State: 'previewed', amendmentsIn: [], amendmentsOut: [], reverseCharge: NO_RC, itc: ITC_NONE });
    // 10500 @5% → 10000 + 250 + 250; 11800 @18% → 10000 + 900 + 900; return 2100 @5% → 2000 + 50 + 50.
    expect(r.table31.a).toEqual({ taxableMinor: 18_000, cgstMinor: 1_100, sgstMinor: 1_100, igstMinor: 0 });
    expect(grossOf(r.reconciliation.table31Outward)).toBe(c.salesLedger.netGrossMinor);
    expect(c.salesLedger.netGrossMinor).toBe(10_500 + 11_800 - 2_100);
    expect(r.reconciliation.equalsGstr1).toBe(true);
    expect(r.reconciliation.equalsSalesLedger).toBe(true);
    expect(r.reconciliation.differences).toEqual([]);
    expect(r.basis).toBe('provisional_gstr1_not_filed');
    expect(r.editable).toBe(false);
  });

  it('a nil-rated line goes to 3.1(c), never into 3.1(a)', () => {
    const r = buildGstr3b({ period: P, current: month([line('p-rice', 5_000, 0, '100630'), line('p-paneer', 1_050, 500)]), gstr1State: 'not_started', amendmentsIn: [], amendmentsOut: [], reverseCharge: NO_RC, itc: ITC_NONE });
    expect(r.table31.c.taxableMinor).toBe(5_000);
    expect(r.table31.a.taxableMinor).toBe(1_000);
  });

  it('a sold product that cannot be placed on the return is a NAMED exception, not absorbed', () => {
    const c = computeGstr1Figures({ period: P, sold: [line('p-paneer', 1_050, 500), { productId: 'p-mystery', quantityMinor: 1, uom: 'EA', lineTotalMinor: 999 }], returned: [], taxTable: [], annualTurnoverMinor: TURNOVER, documents: [], amendmentsIn: [] });
    const r = buildGstr3b({ period: P, current: c, gstr1State: 'not_started', amendmentsIn: [], amendmentsOut: [], reverseCharge: NO_RC, itc: ITC_NONE });
    const d = r.reconciliation.differences.find((x) => x.code === 'sold_not_on_return');
    expect(d).toMatchObject({ explained: false, productId: 'p-mystery', grossMinor: 999 });
    expect(r.reconciliation.equalsSalesLedger).toBe(false);
    expect(r.exceptions.map((e) => e.code)).toContain('reconciliation_difference');
  });

  it('outward documents that did not come from the till are named, and the ITC is "not yet reconciled", never zero', () => {
    const c = computeGstr1Figures({
      period: P, sold: [line('p-paneer', 1_050, 500)], returned: [], taxTable: [], annualTurnoverMinor: TURNOVER, amendmentsIn: [],
      documents: [{ documentId: 'INV-1', documentDate: '2027-05-04', supplyType: 'b2b', recipientGstin: '33ABCDE1234F1Z5', lines: [{ hsnCode: '040610', quantityMinor: 1, uom: 'EA', taxableMinor: 10_000, rateBps: 500, cgstMinor: 250, sgstMinor: 250, igstMinor: 0 }] }],
    });
    const r = buildGstr3b({ period: P, current: c, gstr1State: 'not_started', amendmentsIn: [], amendmentsOut: [], reverseCharge: NO_RC, itc: ITC_NOT_YET_RECONCILED.itcForPeriod('t', P) as ItcForPeriod });
    expect(r.reconciliation.differences).toEqual([expect.objectContaining({ code: 'documents_not_from_till', explained: true, grossMinor: 10_500 })]);
    expect(r.table4.a5AllOther.status).toBe('not_reconciled');
    expect(r.exceptions.map((e) => e.code)).toEqual(expect.arrayContaining(['gstr1_not_filed', 'itc_not_yet_reconciled']));
    expect('igstMinor' in r.table4.a5AllOther).toBe(false); // no figure at all — not a zero
  });
});

describe('A16 — locked to the filed GSTR-1; no change path; a correction is an amendment in the next month', () => {
  it('the lock is allowed only once GSTR-1 is filed, and only once', () => {
    expect(evaluateGstr3bLock({ gstr1State: 'approved' })).toMatchObject({ allowed: false, refusal: 'gstr1_not_filed' });
    expect(evaluateGstr3bLock({ gstr1State: 'filed' })).toEqual({ allowed: true });
    expect(evaluateGstr3bLock({ gstr1State: 'filed', existing: lockOf(month([]).figures) })).toMatchObject({ allowed: false, refusal: 'already_locked' });
  });

  it('every request to change the outward liability is refused — locked or not', () => {
    expect(refuseOutwardChange({ period: P })).toMatchObject({ allowed: false, refusal: 'derived_from_stored_sales' });
    expect(refuseOutwardChange({ period: P, lock: lockOf(month([]).figures) })).toMatchObject({ allowed: false, refusal: 'locked_to_filed_gstr1' });
    expect(refuseOutwardChange({ period: P, lock: lockOf(month([]).figures) }).nextSafeAction).toContain('062027');
  });

  it('after the lock 3B reads the FILED figure; a sale banked later is a named difference until an amendment carries it', () => {
    const filed = month([line('p-paneer', 10_500, 500)]);
    const lock = lockOf(filed.figures);
    const later = month([line('p-paneer', 10_500, 500), line('p-paneer', 2_100, 500)]);
    const r = buildGstr3b({ period: P, current: later, gstr1State: 'filed', lock, amendmentsIn: [], amendmentsOut: [], reverseCharge: NO_RC, itc: ITC_NONE });
    expect(r.basis).toBe('locked_to_filed_gstr1');
    expect(r.table31.a.taxableMinor).toBe(10_000); // the filed figure stands
    expect(r.reconciliation.equalsGstr1).toBe(true);
    const late = r.reconciliation.differences.find((d) => d.code === 'changed_after_gstr1_filed');
    expect(late).toMatchObject({ explained: false, grossMinor: 2_100 });

    const decision = evaluateAmendment({ lock, current: later.figures, alreadyCarried: [], nextMonthLocked: false });
    expect(decision).toMatchObject({ allowed: true, intoPeriod: '062027' });
    if (!decision.allowed) throw new Error('unreachable');
    const amendment: CarriedAmendment = { amendmentId: 'AM-1', fromPeriod: P, intoPeriod: decision.intoPeriod, delta: decision.delta, reason: 'synced late', recordedBy: 'u-acct', recordedAt: '2027-06-15T00:00:00.000Z' };
    expect(grossOf(amendment.delta)).toBe(2_100);
    const after = buildGstr3b({ period: P, current: later, gstr1State: 'filed', lock, amendmentsIn: [], amendmentsOut: [amendment], reverseCharge: NO_RC, itc: ITC_NONE });
    expect(after.reconciliation.differences.map((d) => [d.code, d.explained])).toEqual([['carried_by_amendment', true]]);
    // Nothing left to amend; an unfiled month is never amended; a locked next month refuses.
    expect(evaluateAmendment({ lock, current: later.figures, alreadyCarried: [amendment], nextMonthLocked: false })).toMatchObject({ allowed: false, refusal: 'nothing_to_amend' });
    expect(evaluateAmendment({ lock: undefined, current: later.figures, alreadyCarried: [], nextMonthLocked: false })).toMatchObject({ allowed: false, refusal: 'not_locked' });
    expect(evaluateAmendment({ lock, current: later.figures, alreadyCarried: [], nextMonthLocked: true })).toMatchObject({ allowed: false, refusal: 'next_month_already_locked' });

    // The next month declares the amendment: its 3.1 includes it, and the difference from its own till is named.
    const june = computeGstr1Figures({ period: '062027', sold: [line('p-ghee', 1_180, 1800)], returned: [], taxTable: [], annualTurnoverMinor: TURNOVER, documents: [], amendmentsIn: [amendment] });
    const j = buildGstr3b({ period: '062027', current: june, gstr1State: 'not_started', amendmentsIn: [amendment], amendmentsOut: [], reverseCharge: NO_RC, itc: ITC_NONE });
    expect(j.table31.a.taxableMinor).toBe(1_000 + 2_000);
    expect(j.reconciliation.differences).toEqual([expect.objectContaining({ code: 'amendment_from_earlier_period', explained: true, amendmentId: 'AM-1', grossMinor: 2_100 })]);
  });

  it('a filed digest that does not match the locked figures is an exception', () => {
    const f = month([line('p-paneer', 1_050, 500)]);
    const r = buildGstr3b({ period: P, current: f, gstr1State: 'filed', lock: { ...lockOf(f.figures), filedDigest: 'something-else' }, amendmentsIn: [], amendmentsOut: [], reverseCharge: NO_RC, itc: ITC_NONE });
    expect(r.exceptions.map((e) => e.code)).toContain('filed_digest_does_not_match');
  });

  it('the canonical form is stable and changes when a figure changes', () => {
    const a = gstr1CanonicalForm(month([line('p-paneer', 1_050, 500)]).figures);
    expect(gstr1CanonicalForm(month([line('p-paneer', 1_050, 500)]).figures)).toBe(a);
    expect(gstr1CanonicalForm(month([line('p-paneer', 1_051, 500)]).figures)).not.toBe(a);
  });
});

describe('A14 in 3B — reverse charge is 3.1(d), cash only; its ITC is 4(A)(3) once paid', () => {
  it('3.1(d) carries the liability and 6.1 pays it all in cash, none set off', () => {
    const rc = { liability: { taxableMinor: 100_000, cgstMinor: 2_500, sgstMinor: 2_500, igstMinor: 0 }, itcPaid: ZERO_HEADS };
    const r = buildGstr3b({ period: P, current: month([]), gstr1State: 'not_started', amendmentsIn: [], amendmentsOut: [], reverseCharge: rc, itc: ITC_NONE });
    expect(r.table31.d).toEqual(rc.liability);
    expect(r.table61.reverseChargePaidInCashMinor).toBe(taxOf(rc.liability));
    expect(r.table61.reverseChargeSetOffAgainstItcMinor).toBe(0);
    expect(r.table4.a3ReverseCharge).toEqual(ZERO_HEADS); // unpaid → no ITC
  });
});
