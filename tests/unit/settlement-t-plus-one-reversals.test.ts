import { describe, it, expect } from 'vitest';
import { importSettlementBatch, reviewSettlement, type SettlementBatch, type PosRefund } from '../../packages/settlement/src/settlement';
import { CardDataError } from '../../packages/reconciliation/src/reconciliation';

// C13 (v2.1 addendum · M23/M14 · P-08): POS, UPI and card captures are matched to the aggregator's T+1 settlement file;
// shortfalls, chargebacks and refunds surface as exceptions. The file is uploaded — there is no live provider.

const T1 = 1; // the aggregator settles at T+1
const tenders = [
  { id: 's1:t0', ref: 'UPI-0001', amountMinor: 20_000, capturedOn: '2026-10-14' },
  { id: 's2:t0', ref: 'CARD-0002', amountMinor: 50_000, capturedOn: '2026-10-14' },
  { id: 's3:t0', ref: 'CARD-0003', amountMinor: 30_000, capturedOn: '2026-10-14' },
  { id: 's4:t0', ref: 'CARD-0004', amountMinor: 10_000, capturedOn: '2026-10-15' },
];

const file: SettlementBatch = {
  batchId: 'AGG-2026-10-15', providerId: 'example-aggregator', currency: 'INR', settlementDate: '2026-10-15',
  lines: [
    { id: 'L1', ref: 'UPI-0001', amountMinor: 20_000 },
    { id: 'L2', ref: 'CARD-0002', amountMinor: 49_000 }, // short by 1,000
    { id: 'L3', ref: 'CARD-0003', amountMinor: 30_000 },
    { id: 'L4', ref: 'RF-9', type: 'refund', originalRef: 'CARD-0003', amountMinor: 5_000 },
    { id: 'L5', ref: 'CB-7', type: 'chargeback', originalRef: 'UPI-0001', amountMinor: 20_000 },
    { id: 'L6', ref: 'RF-10', type: 'refund', originalRef: 'CARD-0002', amountMinor: 2_000 }, // no till refund
  ],
  // 20000 + 49000 + 30000 − 5000 − 20000 − 2000
  declaredGrossMinor: 72_000, declaredFeesMinor: 1_000, declaredNetMinor: 71_000,
};

describe('a T+1 file with refunds and chargebacks adds up on its own figures (C13)', () => {
  it('counts refunds and chargebacks against the gross', () => {
    const r = importSettlementBatch(file);
    expect(r).toMatchObject({ accepted: true, lineTotalMinor: 72_000 });
  });
  it('refuses a refund or chargeback that does not say which capture it reverses, and a negative amount', () => {
    const noOriginal = { ...file, lines: [...file.lines.slice(0, 3), { id: 'Lx', ref: 'RF-x', type: 'refund' as const, amountMinor: 1 }] };
    expect(importSettlementBatch(noOriginal).outcome).toBe('reversal_without_an_original');
    const negative = { ...file, lines: [{ id: 'Ln', ref: 'X', amountMinor: -5 }], declaredGrossMinor: -5, declaredFeesMinor: 0, declaredNetMinor: -5 };
    expect(importSettlementBatch(negative).outcome).toBe('reversal_without_an_original');
  });
  it('a file of captures only adds up exactly as before', () => {
    expect(importSettlementBatch({ ...file, lines: file.lines.slice(0, 3), declaredGrossMinor: 99_000, declaredFeesMinor: 0, declaredNetMinor: 99_000 }).accepted).toBe(true);
  });
});

describe('the review surfaces shortfalls, chargebacks and refunds as exceptions (C13 · P-08)', () => {
  const refunds: PosRefund[] = [
    { id: 'ret-1', originalRef: 'CARD-0003', amountMinor: 5_000, refundedOn: '2026-10-14' }, // matched by L4
    { id: 'ret-2', originalRef: 'CARD-0004', amountMinor: 4_000, refundedOn: '2026-10-15' }, // not due yet at T+1
    { id: 'ret-3', originalRef: 'CARD-0002', amountMinor: 3_000, refundedOn: '2026-10-13' }, // provider debited 2,000
  ];
  const review = reviewSettlement({ tenders, credits: file.lines, refunds, settlementCycleDays: T1, asOf: '2026-10-16' });
  const by = (finding: string) => review.exceptions.filter((e) => e.finding === finding);

  it('matches the captures that settled in full, and the refund the provider debited exactly', () => {
    expect(review.matchedCount).toBe(2); // UPI-0001, CARD-0003
    expect(review.matchedRefundCount).toBe(1); // ret-1 ↔ L4
  });

  it('a short-settled capture is an exception with its value', () => {
    expect(by('short_settled')).toEqual([expect.objectContaining({ ref: 'CARD-0002', valueMinor: 1_000, needsInvestigation: true })]);
  });

  it('a chargeback is always an exception, linked to the sale it reverses', () => {
    expect(by('chargeback')).toEqual([expect.objectContaining({ ref: 'UPI-0001', tenderId: 's1:t0', settlementId: 'L5', valueMinor: 20_000, needsInvestigation: true })]);
  });

  it('a refund whose amount differs from the till\'s is an exception; a refund not yet due at T+1 is information only', () => {
    expect(by('refund_amount_mismatch')).toEqual([expect.objectContaining({ ref: 'CARD-0002', settlementId: 'L6', valueMinor: 1_000, needsInvestigation: true })]);
    expect(by('refund_awaiting_settlement')).toEqual([expect.objectContaining({ ref: 'CARD-0004', valueMinor: 4_000, ageDays: 1, needsInvestigation: false })]);
  });

  it('a capture from yesterday not yet in a T+1 file is not due; the day after it is overdue', () => {
    expect(by('awaiting_settlement')).toEqual([expect.objectContaining({ ref: 'CARD-0004', ageDays: 1, needsInvestigation: false })]);
    const later = reviewSettlement({ tenders, credits: file.lines, refunds, settlementCycleDays: T1, asOf: '2026-10-17' });
    expect(later.exceptions.filter((e) => e.finding === 'overdue_settlement').map((e) => e.ref)).toEqual(['CARD-0004']);
    expect(later.exceptions.filter((e) => e.finding === 'refund_overdue').map((e) => e.ref)).toEqual(['CARD-0004']);
  });

  it('a refund the provider debited with no till refund is an exception', () => {
    const r = reviewSettlement({ tenders, credits: file.lines, refunds: [], settlementCycleDays: T1, asOf: '2026-10-16' });
    expect(r.exceptions.filter((e) => e.finding === 'refund_without_a_till_record').map((e) => e.settlementId).sort()).toEqual(['L4', 'L6']);
  });

  it('puts the chargeback first, values every problem, and says when till refunds were not read', () => {
    expect(review.exceptions[0]?.finding).toBe('chargeback');
    expect(review.atRiskValueMinor).toBe(20_000 + 1_000 + 1_000);
    // Verifier NEW-4: the pending capture (in) less the pending refund (out) — never the two added together.
    expect(review.awaitingValueMinor).toBe(10_000 - 4_000);
    expect(review.awaitingCapturesMinor).toBe(10_000);
    expect(review.awaitingRefundsMinor).toBe(4_000);
    expect(reviewSettlement({ tenders, credits: file.lines, settlementCycleDays: T1, asOf: '2026-10-16' }).detail).toContain('till refunds were not read');
  });

  it('refuses a refund or chargeback reference that looks like a card number (hard rule #3)', () => {
    const pan = ['4111', '1111', '1111', '1111'].join('');
    expect(() => reviewSettlement({ tenders, credits: [{ id: 'X', ref: 'CB-1', type: 'chargeback', originalRef: pan, amountMinor: 1 }], settlementCycleDays: T1, asOf: '2026-10-16' })).toThrow(CardDataError);
    expect(() => reviewSettlement({ tenders, credits: [], refunds: [{ id: 'r', originalRef: pan, amountMinor: 1, refundedOn: '2026-10-16' }], settlementCycleDays: T1, asOf: '2026-10-16' })).toThrow(CardDataError);
  });
});
