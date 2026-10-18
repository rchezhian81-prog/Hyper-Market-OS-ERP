import { describe, it, expect } from 'vitest';
import { refundChannel, paidByTender } from '../../packages/returns/src/index';
import {
  respondByFor, disputeViews, disputeExceptions, lossEntryFor, addDays, UPI_DISPUTE_RESPONSE_DAYS, type DisputeRecord,
} from '../../packages/payment-disputes/src/index';

/**
 * R3 · C14 — the pure rules. Signed sentence: "a refund on a card or UPI sale goes to the same instrument unless a policy
 * exception (Q6) is approved by a second person with a reason. A UPI or card dispute is recorded with its received date and
 * a response due date (UPI: 15 days). A dispute not answered by the due date is an owner exception. A lost dispute posts as
 * a compensating entry." Q6 = OB-144 "A": back to the source; cash only for cash sales; a cash refund on a card/UPI sale
 * needs a second person and a written reason.
 */

const card = [{ kind: 'card', amountMinor: 10_000 }];
const mixed = [{ kind: 'cash', amountMinor: 4_000 }, { kind: 'upi', amountMinor: 6_000 }];

describe('a refund goes back the way the bill was paid (OB-144)', () => {
  it('a card sale refunds to the card; cash or store credit on it is an exception', () => {
    expect(refundChannel({ saleTenders: card, refundedByTender: {}, refundTender: 'card', refundMinor: 10_000 })).toMatchObject({ verdict: 'to_source' });
    expect(refundChannel({ saleTenders: card, refundedByTender: {}, refundTender: 'cash', refundMinor: 1_000 })).toMatchObject({ verdict: 'exception_needed', detail: expect.stringMatching(/does not go back to the card/) });
    expect(refundChannel({ saleTenders: card, refundedByTender: {}, refundTender: 'store_credit', refundMinor: 1_000 })).toMatchObject({ verdict: 'exception_needed' });
    expect(refundChannel({ saleTenders: card, refundedByTender: {}, refundTender: 'upi', refundMinor: 1_000 })).toMatchObject({ verdict: 'exception_needed' });
  });

  it('cash only for cash sales — and store credit on a cash sale stays the shop\'s store-credit policy', () => {
    const cash = [{ kind: 'cash', amountMinor: 5_000 }];
    expect(refundChannel({ saleTenders: cash, refundedByTender: {}, refundTender: 'cash', refundMinor: 5_000 })).toMatchObject({ verdict: 'to_source' });
    expect(refundChannel({ saleTenders: cash, refundedByTender: {}, refundTender: 'store_credit', refundMinor: 5_000 })).toMatchObject({ verdict: 'to_source' });
    expect(refundChannel({ saleTenders: cash, refundedByTender: {}, refundTender: 'upi', refundMinor: 5_000 })).toMatchObject({ verdict: 'exception_needed' });
  });

  it('a mixed bill: each tender gets back no more than it paid, counting earlier refunds', () => {
    expect(paidByTender(mixed)).toEqual({ cash: 4_000, upi: 6_000 });
    expect(refundChannel({ saleTenders: mixed, refundedByTender: {}, refundTender: 'cash', refundMinor: 4_000 })).toMatchObject({ verdict: 'to_source' });
    expect(refundChannel({ saleTenders: mixed, refundedByTender: { cash: 3_000 }, refundTender: 'cash', refundMinor: 2_000 })).toMatchObject({ verdict: 'exception_needed', detail: expect.stringMatching(/paid 4000 by cash; this refund would take what went back to cash to 5000/) });
    expect(refundChannel({ saleTenders: mixed, refundedByTender: { cash: 4_000 }, refundTender: 'upi', refundMinor: 6_000 })).toMatchObject({ verdict: 'to_source' });
  });

  it('an exchange moves no money here; a bill whose tenders are not held is said, not assumed', () => {
    expect(refundChannel({ saleTenders: card, refundedByTender: {}, refundTender: 'exchange', refundMinor: 1_000 })).toMatchObject({ verdict: 'not_a_money_refund' });
    expect(refundChannel({ saleTenders: undefined, refundedByTender: {}, refundTender: 'cash', refundMinor: 1_000 })).toMatchObject({ verdict: 'source_not_known' });
  });
});

describe('card and UPI disputes', () => {
  it('UPI: the answer is due 15 days after the notice — computed, never typed; card: the bank\'s stated date', () => {
    expect(UPI_DISPUTE_RESPONSE_DAYS).toBe(15);
    expect(respondByFor({ instrument: 'upi', receivedOn: '2026-10-01', statedRespondBy: '2026-12-31' })).toEqual({ respondBy: '2026-10-16' });
    expect(respondByFor({ instrument: 'upi', receivedOn: '2026-12-25' })).toEqual({ respondBy: '2027-01-09' });
    expect(respondByFor({ instrument: 'card', receivedOn: '2026-10-01', statedRespondBy: '2026-10-21' })).toEqual({ respondBy: '2026-10-21' });
    expect(respondByFor({ instrument: 'card', receivedOn: '2026-10-01' })).toMatchObject({ problem: expect.stringMatching(/reply-by date the acquiring bank/) });
    expect(respondByFor({ instrument: 'card', receivedOn: '2026-10-01', statedRespondBy: '2026-09-30' })).toMatchObject({ problem: expect.stringMatching(/cannot be before/) });
    expect(respondByFor({ instrument: 'upi', receivedOn: '2026-02-30' })).toMatchObject({ problem: expect.any(String) });
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
  });

  const d = (over: Partial<DisputeRecord> & Pick<DisputeRecord, 'disputeId'>): DisputeRecord => ({
    instrument: 'upi', saleId: 'S1', providerRef: 'NPCI-CASE-1', amountMinor: 50_000, receivedOn: '2026-10-01', respondBy: '2026-10-16',
    reason: 'goods not received (synthetic)', recordedBy: 'u-acct', recordedAt: '2026-10-01T10:00:00.000Z', ...over,
  });

  it('not answered by the due date → an owner exception; answered or decided → not', () => {
    const disputes = [d({ disputeId: 'D1' }), d({ disputeId: 'D2', providerRef: 'NPCI-CASE-2' }), d({ disputeId: 'D3', instrument: 'card', providerRef: 'ARN-3', respondBy: '2026-10-10', amountMinor: 20_000 })];
    const responses = [{ disputeId: 'D2', respondedOn: '2026-10-10', evidenceRef: 'EVID-2', by: 'u-acct', at: '2026-10-10T10:00:00.000Z' }];
    // On the due date itself, nothing is late yet.
    expect(disputeExceptions(disputeViews({ disputes, responses, outcomes: [], asOf: '2026-10-10' }))).toEqual([]);
    // Day 16: D1 is a day late; D3 (card, due 10 Oct) seven days late — most overdue first.
    const views = disputeViews({ disputes, responses, outcomes: [], asOf: '2026-10-17' });
    const ex = disputeExceptions(views);
    expect(ex.map((e) => [e.disputeId, e.daysOverdue])).toEqual([['D3', 7], ['D1', 1]]);
    expect(ex[1]!.headline).toBe('UPI dispute NPCI-CASE-1 for ₹500.00 was due an answer by 2026-10-16 — 1 day(s) late and still not answered');
    expect(views.find((v) => v.disputeId === 'D2')).toMatchObject({ state: 'answered', overdue: false, answeredLate: false });
    // Answered late is said.
    const late = disputeViews({ disputes, responses: [{ ...responses[0]!, disputeId: 'D1', respondedOn: '2026-10-20' }], outcomes: [], asOf: '2026-10-21' });
    expect(late.find((v) => v.disputeId === 'D1')).toMatchObject({ state: 'answered', overdue: false, answeredLate: true });
  });

  it('a lost dispute posts a balanced compensating entry; a won one posts nothing', () => {
    const entry = lossEntryFor(d({ disputeId: 'D1' }), '2026-11-01');
    expect(entry).toEqual({
      entryId: 'dispute-loss-D1', disputeId: 'D1', saleId: 'S1', amountMinor: 50_000, postedOn: '2026-11-01',
      lines: [{ account: 'chargeback_loss', debitMinor: 50_000 }, { account: 'card_upi_settlement_receivable', creditMinor: 50_000 }],
    });
    const views = disputeViews({ disputes: [d({ disputeId: 'D1' })], responses: [], outcomes: [{ disputeId: 'D1', outcome: 'lost', decidedOn: '2026-11-01', by: 'u-acct', at: 'x', lossEntry: entry }], asOf: '2026-11-02' });
    expect(views[0]).toMatchObject({ state: 'lost', overdue: false });
  });
});
