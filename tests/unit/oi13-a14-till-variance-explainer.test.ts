// CR-01 OI-13-A14 (OB-763 B) — the cash-office variance explainer's rule (packages/cash/src/variance-explainer.ts).
//
// Acceptance (docs/requirements/CR-01-OI-13-A14-cash-office-variance-explainer.md):
//   AC-1 a till that balanced, or whose over/short a person already signed off, gets NO explanation;
//   AC-2 likely causes are listed from the records, most specific first, each naming the record it came from:
//        a sale or refund of exactly the difference on another tender (paid one way, recorded another), a round sum
//        (a pickup or safe drop not entered / cash put in and not entered), inside the till's tolerance;
//   AC-3 when no record explains it, it says so and asks for a recount with a second person — it never guesses;
//   AC-4 it lists records, not people: no cashier is named and no word of blame (theft, stole, fraud) is ever used;
//   AC-5 it drafts — it never writes off, signs off or changes a cash balance.
// Synthetic data only.
import { describe, it, expect } from 'vitest';
import { explainTillVariance, type TillCloseFacts, type TillPaymentFact } from '../../packages/cash/src/variance-explainer';

const close: TillCloseFacts = {
  shiftId: 'sh-demo-1', tillId: 'lane-1', tradingDay: '2026-11-20', expectedMinor: 1_250_000, countedMinor: 1_250_000, varianceMinor: 0,
  toleranceMinor: 5_000, pickupsMinor: 500_000, denominationsGiven: true, reviewed: false,
};
const pay = (ref: string, kind: 'sale' | 'refund', tender: string, amountMinor: number): TillPaymentFact => ({ ref, kind, tender, amountMinor, at: '2026-11-20T12:00:00.000Z' });

describe('A14 cash-office variance explainer — the rule', () => {
  it('AC-1: a balanced till, or one already signed off, is not explained', () => {
    expect(explainTillVariance({ close, payments: [] })).toBeNull();
    expect(explainTillVariance({ close: { ...close, countedMinor: 1_200_000, varianceMinor: -50_000, reviewed: true }, payments: [] })).toBeNull();
  });

  it('AC-2: short by exactly a cash sale — a payment recorded as cash may have been paid by UPI or card (first), then the round sum', () => {
    const x = explainTillVariance({
      close: { ...close, countedMinor: 1_200_000, varianceMinor: -50_000 },
      payments: [pay('R-1001', 'sale', 'cash', 50_000), pay('R-1002', 'sale', 'upi', 12_000)],
    })!;
    expect(x.direction).toBe('short');
    expect(x.reasons.map((r) => r.code)).toEqual(['cash_sale_may_be_upi_or_card', 'round_sum_short']);
    expect(x.reasons[0]!.sentence).toBe('Bill R-1001 was recorded as cash for ₹500.00 — exactly the shortage. Check whether it was really paid by UPI or card.');
    expect(x.reasons[0]!.recordRef).toBe('R-1001');
    expect(x.reasons[1]!.sentence).toBe('The shortage is a round ₹500.00. Check whether a cash pickup or safe drop of that amount was taken and not entered (₹5,000.00 of pickups are entered on this till).');
    expect(x.summary).toBe('Till lane-1 on 2026-11-20 is ₹500.00 short. 2 likely cause(s) from the records — a manager checks them and decides.');
  });

  it('AC-2: over by exactly a UPI sale, and over by exactly a cash refund', () => {
    const over = explainTillVariance({
      close: { ...close, countedMinor: 1_251_850, varianceMinor: 1_850 },
      payments: [pay('R-2001', 'sale', 'upi', 1_850), pay('RT-9', 'refund', 'cash', 1_850)],
    })!;
    expect(over.direction).toBe('over');
    expect(over.reasons.map((r) => r.code)).toEqual(['non_cash_sale_may_be_cash', 'cash_refund_may_be_non_cash', 'within_tolerance']);
    expect(over.reasons[1]!.sentence).toBe('Refund RT-9 was recorded as paid in cash for ₹18.50 — exactly the excess. Check whether it really went back by UPI or card.');
  });

  it('AC-2: short by exactly a refund recorded on card', () => {
    const x = explainTillVariance({ close: { ...close, countedMinor: 1_247_700, varianceMinor: -2_300, toleranceMinor: 0 }, payments: [pay('RT-7', 'refund', 'card', 2_300)] })!;
    expect(x.reasons.map((r) => r.code)).toEqual(['non_cash_refund_may_be_cash']);
  });

  it('AC-3: nothing in the records explains it — said, with a recount by two people; a total-only count is said too', () => {
    const x = explainTillVariance({ close: { ...close, countedMinor: 1_237_300, varianceMinor: -12_700, denominationsGiven: false }, payments: [pay('R-1', 'sale', 'cash', 9_900)] })!;
    expect(x.reasons.map((r) => r.code)).toEqual(['count_not_broken_down', 'no_cause_found']);
    expect(x.reasons[1]!.sentence).toBe('No record on this till explains the difference. Recount the drawer with a second person before deciding anything.');
  });

  it('AC-4/5: it lists records, not people — no cashier named, no word of blame, no claim to have acted', () => {
    const x = explainTillVariance({
      close: { ...close, countedMinor: 1_200_000, varianceMinor: -50_000, denominationsGiven: false },
      payments: [pay('R-1001', 'sale', 'cash', 50_000), pay('RT-1', 'refund', 'upi', 50_000)],
    })!;
    const words = [x.summary, ...x.reasons.map((r) => r.sentence)].join(' ').toLowerCase();
    for (const blame of ['theft', 'stole', 'steal', 'fraud', 'cashier', 'suspect', 'pocket']) expect(words).not.toContain(blame);
    for (const act of ['written off', 'signed off', 'adjusted', 'i have']) expect(words).not.toContain(act);
  });
});
