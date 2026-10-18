import { describe, it, expect } from 'vitest';
import {
  assessTds, validateTdsConfig, payeesWithoutSection, priorInYear, tdsLiabilities, checkChallan, form26qSummary,
  financialYearOf, quarterOf, tdsOn, EMPTY_TDS_CONFIG, type TdsConfig, type PaymentWithTds,
} from '../../packages/withholding/src/index';

/**
 * R3 · A24 — the pure TDS engine (OB-143 "A": built switched off; the CA fills the list). Signed sentence: "a payment to a
 * payee tagged with a TDS section deducts at the configured rate once the single/aggregate threshold is crossed. The payee
 * is paid net. The TDS is a liability until a challan reference is recorded. A quarterly 26Q summary is produced. A payment
 * with no section tag to a payee flagged "TDS applicable" is refused." Every number below is SYNTHETIC — a stand-in for
 * the CA's own list, never a rate this code asserts.
 */

const CA_LIST: TdsConfig = {
  version: 1, setBy: 'u-ca', setAt: '2026-10-01T00:00:00.000Z',
  sections: [
    { section: '194C', label: 'Contractors (synthetic)', rateBps: 100, singleThresholdMinor: 3_000_000, aggregateThresholdMinor: 10_000_000, onCrossing: 'whole_aggregate' },
    { section: '194J', label: 'Professional fees (synthetic)', rateBps: 1_000, singleThresholdMinor: null, aggregateThresholdMinor: 3_000_000, onCrossing: 'this_payment' },
    { section: '194I', label: 'Rent (synthetic)', rateBps: 1_000, singleThresholdMinor: null, aggregateThresholdMinor: null, onCrossing: 'this_payment' },
  ],
  payees: [
    { supplierId: 's-contractor', tdsApplicable: true, section: '194C', pan: 'AAAPA1234A' },
    { supplierId: 's-ca-firm', tdsApplicable: true, section: '194J', pan: null },
    { supplierId: 's-landlord', tdsApplicable: true, section: '194I', pan: 'BBBPB5678B' },
    { supplierId: 's-untagged', tdsApplicable: true, section: null, pan: null },
    { supplierId: 's-goods', tdsApplicable: false, section: null, pan: null },
  ],
};
const none = { grossMinor: 0, deductedOnMinor: 0 };

describe('the TDS a payment carries', () => {
  it('switched off: nothing is deducted, and it says so — the list starts empty', () => {
    expect(EMPTY_TDS_CONFIG.sections).toEqual([]);
    expect(EMPTY_TDS_CONFIG.payees).toEqual([]);
    expect(assessTds({ enabled: false, config: CA_LIST, supplierId: 's-landlord', grossMinor: 5_000_000, priorInYear: none })).toMatchObject({ outcome: 'switched_off' });
    expect(assessTds({ enabled: true, config: EMPTY_TDS_CONFIG, supplierId: 's-landlord', grossMinor: 5_000_000, priorInYear: none })).toMatchObject({ outcome: 'not_applicable' });
  });

  it('a payee tagged with a section deducts at the configured rate; the payee is paid net', () => {
    expect(assessTds({ enabled: true, config: CA_LIST, supplierId: 's-landlord', grossMinor: 5_000_000, priorInYear: none }))
      .toMatchObject({ outcome: 'deducted', section: '194I', rateBps: 1_000, baseMinor: 5_000_000, tdsMinor: 500_000, netMinor: 4_500_000 });
  });

  it('only once the single or aggregate threshold is crossed', () => {
    // 194C: ₹25,000 is within the single ₹30,000 and the year's ₹1,00,000 — nothing yet.
    expect(assessTds({ enabled: true, config: CA_LIST, supplierId: 's-contractor', grossMinor: 2_500_000, priorInYear: none })).toMatchObject({ outcome: 'below_threshold', section: '194C' });
    // Single crossed: ₹35,000 in one payment.
    expect(assessTds({ enabled: true, config: CA_LIST, supplierId: 's-contractor', grossMinor: 3_500_000, priorInYear: none })).toMatchObject({ outcome: 'deducted', baseMinor: 3_500_000, tdsMinor: 35_000 });
    // Aggregate crossed with the CA's "whole_aggregate": the year's earlier ₹80,000 (not yet deducted on) is caught up.
    expect(assessTds({ enabled: true, config: CA_LIST, supplierId: 's-contractor', grossMinor: 2_500_000, priorInYear: { grossMinor: 8_000_000, deductedOnMinor: 0 } }))
      .toMatchObject({ outcome: 'deducted', baseMinor: 10_500_000, tdsMinor: 105_000, netMinor: 2_395_000 });
    // After the catch-up, a later payment is deducted on itself only.
    expect(assessTds({ enabled: true, config: CA_LIST, supplierId: 's-contractor', grossMinor: 1_000_000, priorInYear: { grossMinor: 10_500_000, deductedOnMinor: 10_500_000 } }))
      .toMatchObject({ outcome: 'deducted', baseMinor: 1_000_000, tdsMinor: 10_000 });
    // 194J with "this_payment": the crossing payment alone.
    expect(assessTds({ enabled: true, config: CA_LIST, supplierId: 's-ca-firm', grossMinor: 1_000_000, priorInYear: { grossMinor: 2_500_000, deductedOnMinor: 0 } }))
      .toMatchObject({ outcome: 'deducted', baseMinor: 1_000_000, tdsMinor: 100_000 });
    expect(assessTds({ enabled: true, config: CA_LIST, supplierId: 's-ca-firm', grossMinor: 1_000_000, priorInYear: none })).toMatchObject({ outcome: 'below_threshold' });
  });

  it('a payee flagged "TDS applicable" with no section is refused; one not on the list pays gross', () => {
    expect(assessTds({ enabled: true, config: CA_LIST, supplierId: 's-untagged', grossMinor: 100, priorInYear: none })).toMatchObject({ outcome: 'refused', code: 'tds_section_missing' });
    expect(assessTds({ enabled: true, config: CA_LIST, supplierId: 's-goods', grossMinor: 9_000_000, priorInYear: none })).toMatchObject({ outcome: 'not_applicable' });
    expect(assessTds({ enabled: true, config: { ...CA_LIST, payees: [{ supplierId: 's-x', tdsApplicable: true, section: '194Q', pan: null }] }, supplierId: 's-x', grossMinor: 1, priorInYear: none })).toMatchObject({ outcome: 'refused', code: 'tds_section_unknown' });
    expect(payeesWithoutSection(CA_LIST)).toEqual(['s-untagged']);
  });

  it('a catch-up larger than the payment is refused rather than paid short', () => {
    expect(assessTds({ enabled: true, config: { ...CA_LIST, sections: [{ ...CA_LIST.sections[0]!, rateBps: 10_000 }] }, supplierId: 's-contractor', grossMinor: 2_500_000, priorInYear: { grossMinor: 8_000_000, deductedOnMinor: 0 } }))
      .toMatchObject({ outcome: 'refused', code: 'tds_more_than_payment' });
  });

  it('rounds half up to the paisa; the year and quarter are the Indian ones', () => {
    expect(tdsOn(150, 100)).toBe(2); // 1.5 → 2
    expect(tdsOn(149, 100)).toBe(1);
    expect(financialYearOf('2026-03-31')).toBe('2025-26');
    expect(financialYearOf('2026-04-01')).toBe('2026-27');
    expect([quarterOf('2026-04-01'), quarterOf('2026-09-30'), quarterOf('2026-10-01'), quarterOf('2027-03-31')]).toEqual(['Q1', 'Q2', 'Q3', 'Q4']);
  });
});

describe('the CA\'s list is checked whole', () => {
  it('names every problem', () => {
    const problems = validateTdsConfig({
      sections: [{ section: '194C', label: '', rateBps: 0, singleThresholdMinor: -1, aggregateThresholdMinor: null, onCrossing: 'later' as never }, { section: '194C', label: 'x', rateBps: 100, singleThresholdMinor: null, aggregateThresholdMinor: null, onCrossing: 'this_payment' }, { section: 'rent', label: 'x', rateBps: 100, singleThresholdMinor: null, aggregateThresholdMinor: null, onCrossing: 'this_payment' }],
      payees: [{ supplierId: 'a', tdsApplicable: true, section: '194Z', pan: 'nope' }, { supplierId: 'a', tdsApplicable: false, section: '194C', pan: null }],
    }).join('\n');
    for (const p of [/has no label/, /rate must be/, /singleThresholdMinor must be/, /onCrossing must be/, /listed twice/, /"rent" is not a section/, /194Z, which is not on the list/, /PAN is not a PAN/, /payee a is listed twice/, /flagged "TDS not applicable"/]) expect(problems).toMatch(p);
    expect(validateTdsConfig(CA_LIST)).toEqual([]);
  });
});

describe('liability until the challan, and the 26Q', () => {
  const payments: PaymentWithTds[] = [
    { paymentId: 'pay-1', supplierId: 's-landlord', paidOn: '2026-10-05', grossMinor: 5_000_000, tds: { section: '194I', rateBps: 1_000, baseMinor: 5_000_000, tdsMinor: 500_000, netMinor: 4_500_000 } },
    { paymentId: 'pay-2', supplierId: 's-ca-firm', paidOn: '2026-11-05', grossMinor: 1_000_000, tds: { section: '194J', rateBps: 1_000, baseMinor: 1_000_000, tdsMinor: 100_000, netMinor: 900_000 } },
    { paymentId: 'pay-3', supplierId: 's-goods', paidOn: '2026-11-06', grossMinor: 9_000_000 },
    { paymentId: 'pay-4', supplierId: 's-landlord', paidOn: '2026-07-05', grossMinor: 5_000_000, tds: { section: '194I', rateBps: 1_000, baseMinor: 5_000_000, tdsMinor: 500_000, netMinor: 4_500_000 } },
  ];

  it('every deduction is a liability until a challan covers it — exactly', () => {
    expect(tdsLiabilities(payments, []).map((l) => [l.paymentId, l.state])).toEqual([['pay-4', 'liability'], ['pay-1', 'liability'], ['pay-2', 'liability']]);
    const liabilities = tdsLiabilities(payments, []);
    expect(checkChallan({ challan: { paymentIds: ['pay-1', 'pay-2'], amountMinor: 600_000 }, liabilities })).toEqual([]);
    expect(checkChallan({ challan: { paymentIds: ['pay-1'], amountMinor: 1 }, liabilities }).join()).toMatch(/come to 500000 paise, not the 1/);
    expect(checkChallan({ challan: { paymentIds: ['pay-3'], amountMinor: 1 }, liabilities }).join()).toMatch(/carries no TDS deduction/);
    const challan = { challanId: 'ch-1', challanRef: 'BSR 0001234 05-11-2026 00042', depositedOn: '2026-11-07', paymentIds: ['pay-1'], amountMinor: 500_000, by: 'u-acct', at: '2026-11-07T10:00:00.000Z' };
    const after = tdsLiabilities(payments, [challan]);
    expect(after.find((l) => l.paymentId === 'pay-1')).toMatchObject({ state: 'deposited', challanRef: 'BSR 0001234 05-11-2026 00042' });
    expect(checkChallan({ challan: { paymentIds: ['pay-1'], amountMinor: 500_000 }, liabilities: after }).join()).toMatch(/already covered by challan/);
    expect(priorInYear(payments, 's-landlord', '2026-12-01', 'pay-new')).toEqual({ grossMinor: 10_000_000, deductedOnMinor: 10_000_000 });
    expect(priorInYear(payments, 's-landlord', '2027-04-01', 'pay-new')).toEqual({ grossMinor: 0, deductedOnMinor: 0 });
  });

  it('the quarterly 26Q summary: every deduction in the quarter by section, deposited or not, PAN or not', () => {
    const challan = { challanId: 'ch-1', challanRef: 'BSR-1', depositedOn: '2026-11-07', paymentIds: ['pay-1'], amountMinor: 500_000, by: 'u-acct', at: '2026-11-07T10:00:00.000Z' };
    const q3 = form26qSummary({ financialYear: '2026-27', quarter: 'Q3', liabilities: tdsLiabilities(payments, [challan]), config: CA_LIST });
    expect(q3.rows.map((r) => [r.paymentId, r.section, r.pan, r.tdsMinor, r.challanRef])).toEqual([['pay-1', '194I', 'BBBPB5678B', 500_000, 'BSR-1'], ['pay-2', '194J', null, 100_000, null]]);
    expect(q3.bySection).toEqual([
      { section: '194I', count: 1, paidMinor: 5_000_000, tdsMinor: 500_000, depositedMinor: 500_000 },
      { section: '194J', count: 1, paidMinor: 1_000_000, tdsMinor: 100_000, depositedMinor: 0 },
    ]);
    expect(q3).toMatchObject({ totalTdsMinor: 600_000, depositedMinor: 500_000, undeposited: ['pay-2'], withoutPan: ['pay-2'] });
    expect(form26qSummary({ financialYear: '2026-27', quarter: 'Q2', liabilities: tdsLiabilities(payments, []), config: CA_LIST }).rows.map((r) => r.paymentId)).toEqual(['pay-4']);
  });
});
