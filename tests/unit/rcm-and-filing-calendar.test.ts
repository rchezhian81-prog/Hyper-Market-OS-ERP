import { describe, it, expect } from 'vitest';
import {
  decideRcm, reverseChargeTax, nextSelfInvoiceNumber, reverseChargeForPeriod, validateRcmHead, InvalidRcmInput, RCM_SWITCHED_OFF,
  dueDateOf, timeBarDateOf, judgeFiling, buildFilingCalendar, isValidNearBarDays,
  judgeEInvoiceReporting, EINVOICE_REPORTING_WINDOW_DAYS,
  type RcmControl, type RcmPurchase, type RcmSelfInvoice,
} from '../../packages/finance/src/index';
import { foldGstControls, describeControls } from '../../services/finance/src/gst-controls';

/** R3 A14 (reverse charge, OB-143 switched off), A19 (filing calendar + 3-year bar) and A21 (30-day guard, OB-149 off). */

const GTA = { headCode: 'GTA', name: 'Goods transport agency', rateBps: 500, notifiedUnder: 'Notfn 13/2017-CT(R) entry 1 (synthetic)' };
const ON: RcmControl = { switchedOn: true, heads: [GTA] };
const buy = (over: Partial<RcmPurchase> = {}): RcmPurchase => ({
  purchaseId: 'pu-1', supplierId: 'sup-1', supplierGstin: null, headCode: 'GTA', supplyDate: '2027-05-10', taxableMinor: 100_000, placeOfSupply: 'intra_state', description: 'synthetic freight', ...over,
});

describe('A14 — reverse charge', () => {
  it('is built switched off with no heads (OB-143): nothing is raised', () => {
    expect(RCM_SWITCHED_OFF).toEqual({ switchedOn: false, heads: [] });
    expect(decideRcm(buy(), RCM_SWITCHED_OFF).kind).toBe('switched_off');
    expect(foldGstControls([], []).reverseCharge.value).toBe(false);
    expect(foldGstControls([], []).rcmHeads).toEqual([]);
    expect(describeControls(foldGstControls([], [])).reverseCharge).toMatch(/SWITCHED OFF/);
  });

  it('a configured head issues a self-invoice with the tax; an unconfigured head raises none', () => {
    const d = decideRcm(buy(), ON);
    expect(d).toMatchObject({ kind: 'self_invoice', tax: { taxableMinor: 100_000, cgstMinor: 2_500, sgstMinor: 2_500, igstMinor: 0 } });
    expect(decideRcm(buy({ headCode: 'LEGAL', supplierGstin: '33ABCDE1234F1Z5' }), ON).kind).toBe('no_rcm');
    expect(decideRcm(buy({ headCode: undefined, supplierGstin: '33ABCDE1234F1Z5' }), ON).kind).toBe('no_rcm');
  });

  it('an unregistered supplier with no configured head is an exception (and raises no RCM)', () => {
    expect(decideRcm(buy({ headCode: undefined }), ON)).toMatchObject({ kind: 'exception', reason: 'unregistered_supplier_no_head' });
    expect(decideRcm(buy({ headCode: 'LEGAL' }), ON)).toMatchObject({ kind: 'exception' });
  });

  it('the inter-State tax is IGST; a head must carry a rate and the CA\'s citation', () => {
    expect(reverseChargeTax(100_000, 500, 'inter_state')).toEqual({ taxableMinor: 100_000, cgstMinor: 0, sgstMinor: 0, igstMinor: 5_000 });
    expect(() => validateRcmHead({ ...GTA, notifiedUnder: '' })).toThrow(InvalidRcmInput);
    expect(() => validateRcmHead({ ...GTA, rateBps: 0 })).toThrow(InvalidRcmInput);
    expect(() => validateRcmHead({ ...GTA, headCode: 'gta' })).toThrow(InvalidRcmInput);
  });

  it('the self-invoice series is gap-free per financial year and resets in April (A2)', () => {
    expect(nextSelfInvoiceNumber([], '2027-05-10')).toEqual({ number: 'RCM/2728/000001', seq: 1, fyCompact: '2728' });
    const issued = [{ seq: 1, fyCompact: '2728' }, { seq: 2, fyCompact: '2728' }];
    expect(nextSelfInvoiceNumber(issued, '2028-03-31').number).toBe('RCM/2728/000003');
    expect(nextSelfInvoiceNumber(issued, '2028-04-01').number).toBe('RCM/2829/000001');
    expect(nextSelfInvoiceNumber([], '2027-05-10').number.length).toBeLessThanOrEqual(16);
  });

  it('3.1(d) is the month\'s liability; 4(A)(3) ITC appears only in the month it is PAID', () => {
    const si: RcmSelfInvoice = { number: 'RCM/2728/000001', seq: 1, fyCompact: '2728', purchaseId: 'pu-1', supplierId: 'sup-1', headCode: 'GTA', supplyDate: '2027-05-10', tax: { taxableMinor: 100_000, cgstMinor: 2_500, sgstMinor: 2_500, igstMinor: 0 }, issuedBy: 'u', issuedAt: '2027-05-10T00:00:00.000Z' };
    const may = reverseChargeForPeriod({ from: '2027-05-01', to: '2027-05-31', selfInvoices: [si], payments: [] });
    expect(may.liability.cgstMinor).toBe(2_500);
    expect(may.itcPaid.cgstMinor).toBe(0);
    expect(may.unpaid).toEqual(['RCM/2728/000001']);
    const paid = [{ number: si.number, challanRef: 'CPIN-SYN-1', paidOn: '2027-06-05', paidBy: 'u-acct' }];
    expect(reverseChargeForPeriod({ from: '2027-05-01', to: '2027-05-31', selfInvoices: [si], payments: paid }).itcPaid.cgstMinor).toBe(0);
    const june = reverseChargeForPeriod({ from: '2027-06-01', to: '2027-06-30', selfInvoices: [si], payments: paid });
    expect(june.itcPaid).toEqual(si.tax);
    expect(june.liability.cgstMinor).toBe(0);
  });
});

describe('A19 — the filing calendar and the 3-year time bar', () => {
  it('due dates: GSTR-1 the 11th, GSTR-3B the 20th of the next month; GSTR-9/9C 31 December after the year', () => {
    expect(dueDateOf('GSTR1', '052027')).toBe('2027-06-11');
    expect(dueDateOf('GSTR3B', '122027')).toBe('2028-01-20');
    expect(dueDateOf('GSTR9', '2027-28')).toBe('2028-12-31');
    expect(dueDateOf('GSTR9C', '2027-28')).toBe('2028-12-31');
    expect(timeBarDateOf('2027-06-11')).toBe('2030-06-11');
  });

  it('the warning escalates: not due → overdue → near the bar (owner exception) → barred (owner exception)', () => {
    const j = (today: string, n: number | null = 90) => judgeFiling({ type: 'GSTR3B', period: '052027', today, nearBarDays: n });
    expect(j('2027-05-20').warning).toBe('period_not_ended');
    expect(j('2027-06-15').warning).toBe('not_due_yet');
    expect(j('2027-06-21')).toMatchObject({ warning: 'overdue', daysOverdue: 1, ownerException: false });
    expect(j('2030-03-22')).toMatchObject({ warning: 'near_time_bar', ownerException: true, daysToTimeBar: 90 });
    expect(j('2030-03-21').warning).toBe('overdue');
    expect(j('2030-06-21')).toMatchObject({ warning: 'time_barred', ownerException: true });
    expect(judgeFiling({ type: 'GSTR3B', period: '052027', today: '2030-06-21', nearBarDays: 90, fact: { type: 'GSTR3B', period: '052027', filedOn: '2027-06-19', arn: 'A' } }).warning).toBe('filed');
  });

  it('with the owner\'s N not set, near-the-bar is not judged — and the calendar says so (no default is guessed)', () => {
    expect(judgeFiling({ type: 'GSTR1', period: '052027', today: '2030-06-01', nearBarDays: null }).warning).toBe('overdue');
    const cal = buildFilingCalendar({ today: '2030-06-01', monthlyPeriods: ['052027'], financialYears: ['2027-28'], facts: [], nearBarDays: null });
    expect(cal.nearBarNotJudged).toBe(true);
    expect(cal.detail).toMatch(/has not set how many days/);
    expect(foldGstControls([], []).timeBarWarningDays.value).toBeNull();
    expect(isValidNearBarDays(0)).toBe(false);
    expect(isValidNearBarDays(90)).toBe(true);
  });

  it('lists every GSTR-1/3B month and GSTR-9/9C year, most urgent first, with the 31 December due date', () => {
    const cal = buildFilingCalendar({
      today: '2030-05-01', monthlyPeriods: ['042027', '052027'], financialYears: ['2027-28'], nearBarDays: 60,
      facts: [{ type: 'GSTR1', period: '042027', filedOn: '2027-05-10' }, { type: 'GSTR3B', period: '042027', filedOn: '2027-05-19' }],
    });
    expect(cal.entries).toHaveLength(6);
    expect(cal.entries[0]).toMatchObject({ warning: 'near_time_bar', type: 'GSTR1', period: '052027' });
    expect(cal.entries.find((e) => e.type === 'GSTR9')?.dueDate).toBe('2028-12-31');
    expect(cal.ownerExceptions.map((e) => `${e.type} ${e.period}`)).toEqual(['GSTR1 052027', 'GSTR3B 052027']);
  });
});

describe('A21 — the 30-day e-invoice reporting guard (OB-149, switched off)', () => {
  it('switched off: nothing is blocked, and it says it is off', () => {
    const d = judgeEInvoiceReporting({ switchedOn: false, documentDate: '2027-01-01', today: '2027-06-01', documentType: 'INV' });
    expect(d.blocked).toBe(false);
    expect(d.detail).toMatch(/switched off/);
    expect(foldGstControls([], []).einvoice30DayGuard.value).toBe(false);
    expect(describeControls(foldGstControls([], [])).einvoice30DayGuard).toMatch(/SWITCHED OFF/);
  });

  it('switched on: a document older than 30 days is blocked; one within 30 is not', () => {
    expect(EINVOICE_REPORTING_WINDOW_DAYS).toBe(30);
    expect(judgeEInvoiceReporting({ switchedOn: true, documentDate: '2027-05-01', today: '2027-05-31', documentType: 'CRN' }).blocked).toBe(false);
    expect(judgeEInvoiceReporting({ switchedOn: true, documentDate: '2027-05-01', today: '2027-06-01', documentType: 'DBN' })).toMatchObject({ blocked: true, daysSinceDocument: 31 });
  });

  it('the controls fold keeps the latest change and who made it', () => {
    const c = foldGstControls([
      { control: 'einvoice_30_day_guard', value: true, reason: 'turnover reached ₹10 crore', by: 'u-owner', at: '2028-04-02T00:00:00.000Z' },
      { control: 'time_bar_warning_days', value: 90, reason: 'synthetic', by: 'u-owner', at: '2028-04-02T00:00:00.000Z' },
    ], [{ headCode: 'GTA', change: 'set', head: GTA, by: 'u-ca', at: '2028-04-01T00:00:00.000Z' }, { headCode: 'GTA', change: 'retired', reason: 'not applicable', by: 'u-ca', at: '2028-04-03T00:00:00.000Z' }]);
    expect(c.einvoice30DayGuard).toMatchObject({ value: true, changedBy: 'u-owner' });
    expect(c.timeBarWarningDays.value).toBe(90);
    expect(c.rcmHeads).toEqual([]);
    expect(c.retiredHeads.map((h) => h.headCode)).toEqual(['GTA']);
  });
});
