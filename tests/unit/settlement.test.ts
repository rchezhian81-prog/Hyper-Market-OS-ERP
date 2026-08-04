import { describe, it, expect } from 'vitest';
import {
  importSettlementBatch,
  reviewSettlement,
  openInvestigation,
  attachEvidence,
  resolveInvestigation,
  ageInvestigations,
  type SettlementBatch,
  type Investigation,
  type SettlementException,
} from '../../packages/settlement/src/settlement';
import { CardDataError } from '../../packages/reconciliation/src/reconciliation';

// M14-FR-03 acceptance: "card settlements reconcile to POS card tenders; an
// unsettled/mismatched tender is flagged with value; reconciliation uses no card PAN."

const BATCH: SettlementBatch = {
  batchId: 'BATCH-2026-08-04',
  providerId: 'prov-1',
  currency: 'INR',
  settlementDate: '2026-08-04',
  lines: [
    { id: 'c-1', ref: 'tok_aa', amountMinor: 120_000 },
    { id: 'c-2', ref: 'tok_bb', amountMinor: 80_000 },
  ],
  declaredGrossMinor: 200_000,
  declaredFeesMinor: 3_600, // 1.8%
  declaredNetMinor: 196_400,
};

describe('a provider file must add up before it is trusted (M14-FR-03)', () => {
  it('accepts a batch whose lines and arithmetic both hold', () => {
    const result = importSettlementBatch(BATCH);
    expect(result.accepted).toBe(true);
    expect(result.lineTotalMinor).toBe(200_000);
    expect(result.detail).toContain('196400 banked');
  });

  it('refuses a batch whose lines do not sum to its declared gross', () => {
    const result = importSettlementBatch({ ...BATCH, declaredGrossMinor: 250_000, declaredNetMinor: 246_400 });
    expect(result.accepted).toBe(false);
    expect(result.outcome).toBe('lines_do_not_sum_to_gross');
    expect(result.detail).toContain('invent differences that are not there');
  });

  it("refuses a batch whose own gross − fees ≠ net", () => {
    const result = importSettlementBatch({ ...BATCH, declaredNetMinor: 200_000 });
    expect(result.accepted).toBe(false);
    expect(result.outcome).toBe('gross_minus_fees_is_not_net');
    expect(result.detail).toContain("provider's own arithmetic does not hold");
  });

  it('refuses the same batch twice — a re-import would double every credit', () => {
    const result = importSettlementBatch(BATCH, ['BATCH-2026-08-04']);
    expect(result.outcome).toBe('duplicate_batch');
    expect(result.detail).toContain('double every credit');
  });

  it('refuses an empty batch', () => {
    expect(
      importSettlementBatch({ ...BATCH, lines: [], declaredGrossMinor: 0, declaredFeesMinor: 0, declaredNetMinor: 0 })
        .outcome,
    ).toBe('empty_batch');
  });
});

describe('LATE IS NOT LOST — the distinction that makes this list usable', () => {
  const tenders = [
    { id: 'T-fresh', ref: 'tok_fresh', amountMinor: 50_000, capturedOn: '2026-08-04' },
    { id: 'T-old', ref: 'tok_old', amountMinor: 70_000, capturedOn: '2026-07-20' },
  ];

  it('reports a tender inside the settlement cycle as awaiting, not as an exception', () => {
    const review = reviewSettlement({
      tenders,
      credits: [{ id: 'c-1', ref: 'tok_old', amountMinor: 70_000 }],
      settlementCycleDays: 2,
      asOf: '2026-08-05',
    });

    const fresh = review.exceptions.find((e) => e.ref === 'tok_fresh');
    expect(fresh?.finding).toBe('awaiting_settlement');
    expect(fresh?.needsInvestigation).toBe(false);
    expect(fresh?.detail).toContain('not due yet');

    // The money is visible for cash flow, but it is not "at risk".
    expect(review.awaitingValueMinor).toBe(50_000);
    expect(review.atRiskValueMinor).toBe(0);
    expect(review.detail).toContain('nothing at risk');
  });

  it('turns the same tender into an OVERDUE exception once the cycle has passed', () => {
    const review = reviewSettlement({
      tenders,
      credits: [{ id: 'c-1', ref: 'tok_fresh', amountMinor: 50_000 }],
      settlementCycleDays: 2,
      asOf: '2026-08-05',
    });

    const old = review.exceptions.find((e) => e.ref === 'tok_old');
    expect(old?.finding).toBe('overdue_settlement');
    expect(old?.needsInvestigation).toBe(true);
    expect(old?.ageDays).toBe(16);
    expect(old?.valueMinor).toBe(70_000);
    expect(old?.detail).toContain('may not arrive on its own');
    expect(review.atRiskValueMinor).toBe(70_000);
  });
});

describe('short, over, unknown and ambiguous are four different problems', () => {
  it('values a short settlement and points at the fee model', () => {
    const review = reviewSettlement({
      tenders: [{ id: 'T-1', ref: 'tok_aa', amountMinor: 120_000, capturedOn: '2026-08-04' }],
      credits: [{ id: 'c-1', ref: 'tok_aa', amountMinor: 117_840 }],
      settlementCycleDays: 2,
      asOf: '2026-08-05',
    });
    const short = review.exceptions[0];
    expect(short?.finding).toBe('short_settled');
    expect(short?.valueMinor).toBe(2_160);
    expect(short?.detail).toContain('belongs in the batch fee line');
  });

  it('treats an OVER-settlement as a problem too, not a windfall', () => {
    const review = reviewSettlement({
      tenders: [{ id: 'T-1', ref: 'tok_aa', amountMinor: 120_000, capturedOn: '2026-08-04' }],
      credits: [{ id: 'c-1', ref: 'tok_aa', amountMinor: 130_000 }],
      settlementCycleDays: 2,
      asOf: '2026-08-05',
    });
    expect(review.exceptions[0]?.finding).toBe('over_settled');
    expect(review.exceptions[0]?.detail).toContain('as much of a problem as being short');
  });

  it('investigates money that arrived with no sale behind it', () => {
    const review = reviewSettlement({
      tenders: [],
      credits: [{ id: 'c-9', ref: 'tok_mystery', amountMinor: 45_000 }],
      settlementCycleDays: 2,
      asOf: '2026-08-05',
    });
    expect(review.exceptions[0]?.finding).toBe('unknown_credit');
    expect(review.exceptions[0]?.valueMinor).toBe(45_000);
    expect(review.exceptions[0]?.detail).toContain('never quietly kept');
  });

  it('flags an ambiguous reference instead of guessing which sale it belongs to', () => {
    const review = reviewSettlement({
      tenders: [
        { id: 'T-1', ref: 'tok_dup', amountMinor: 10_000, capturedOn: '2026-08-04' },
        { id: 'T-2', ref: 'tok_dup', amountMinor: 10_000, capturedOn: '2026-08-04' },
      ],
      credits: [{ id: 'c-1', ref: 'tok_dup', amountMinor: 10_000 }],
      settlementCycleDays: 2,
      asOf: '2026-08-05',
    });
    expect(review.exceptions[0]?.finding).toBe('ambiguous_reference');
    expect(review.exceptions[0]?.detail).toContain('until the provider clarifies');
  });

  it('orders the list worst first', () => {
    const review = reviewSettlement({
      tenders: [
        { id: 'T-await', ref: 'tok_await', amountMinor: 10_000, capturedOn: '2026-08-05' },
        { id: 'T-late', ref: 'tok_late', amountMinor: 20_000, capturedOn: '2026-07-01' },
        { id: 'T-short', ref: 'tok_short', amountMinor: 30_000, capturedOn: '2026-08-04' },
      ],
      credits: [
        { id: 'c-1', ref: 'tok_short', amountMinor: 29_000 },
        { id: 'c-2', ref: 'tok_odd', amountMinor: 500 },
      ],
      settlementCycleDays: 2,
      asOf: '2026-08-05',
    });
    expect(review.exceptions.map((e) => e.finding)).toEqual([
      'overdue_settlement',
      'short_settled',
      'unknown_credit',
      'awaiting_settlement',
    ]);
  });

  it('reconciles cleanly when everything matches', () => {
    const review = reviewSettlement({
      tenders: [
        { id: 'T-1', ref: 'tok_aa', amountMinor: 120_000, capturedOn: '2026-08-04' },
        { id: 'T-2', ref: 'tok_bb', amountMinor: 80_000, capturedOn: '2026-08-04' },
      ],
      credits: BATCH.lines,
      settlementCycleDays: 2,
      asOf: '2026-08-05',
    });
    expect(review.matchedCount).toBe(2);
    expect(review.matchedValueMinor).toBe(200_000);
    expect(review.exceptions).toEqual([]);
  });

  it('refuses a card PAN as a reference (hard rule #3)', () => {
    expect(() =>
      reviewSettlement({
        tenders: [{ id: 'T-1', ref: '4111111111111111', amountMinor: 1, capturedOn: '2026-08-04' }],
        credits: [],
        settlementCycleDays: 2,
        asOf: '2026-08-05',
      }),
    ).toThrow(CardDataError);
  });
});

describe('an exception with no owner is a list (P-03)', () => {
  const exception: SettlementException = {
    finding: 'overdue_settlement',
    ref: 'tok_old',
    tenderId: 'T-old',
    valueMinor: 70_000,
    ageDays: 16,
    needsInvestigation: true,
    detail: 'overdue',
  };

  it('opens an investigation with a named owner and a due date', () => {
    const result = openInvestigation({
      investigationId: 'INV-1',
      exception,
      ownerId: 'u-cash-office-priya',
      openedBy: 'u-manager',
      at: '2026-08-05T09:00:00Z',
      dueBy: '2026-08-12',
    });
    expect(result.opened).toBe(true);
    expect(result.investigation?.ownerId).toBe('u-cash-office-priya');
    expect(result.investigation?.valueMinor).toBe(70_000);
  });

  it('refuses an unnamed owner and a due date in the past', () => {
    expect(
      openInvestigation({ investigationId: 'INV-1', exception, ownerId: '  ', openedBy: 'u-m', at: '2026-08-05T09:00:00Z', dueBy: '2026-08-12' })
        .detail,
    ).toContain('owned by nobody');
    expect(
      openInvestigation({ investigationId: 'INV-1', exception, ownerId: 'u-p', openedBy: 'u-m', at: '2026-08-05T09:00:00Z', dueBy: '2026-08-01' })
        .opened,
    ).toBe(false);
  });

  it('REFUSES to open a case on money that is simply not due yet', () => {
    const result = openInvestigation({
      investigationId: 'INV-2',
      exception: { ...exception, finding: 'awaiting_settlement', needsInvestigation: false },
      ownerId: 'u-p',
      openedBy: 'u-m',
      at: '2026-08-05T09:00:00Z',
      dueBy: '2026-08-12',
    });
    expect(result.opened).toBe(false);
    expect(result.detail).toContain('close cases without reading them');
  });
});

describe('an investigation closes only with an outcome', () => {
  const open: Investigation = {
    investigationId: 'INV-1',
    ref: 'tok_old',
    finding: 'overdue_settlement',
    valueMinor: 70_000,
    ownerId: 'u-priya',
    openedBy: 'u-manager',
    openedAt: '2026-08-05T09:00:00Z',
    dueBy: '2026-08-12',
    state: 'open',
    evidenceRefs: ['email-to-provider.pdf'],
  };

  it('appends evidence and never replaces it (hard rule #6)', () => {
    const one = attachEvidence(open, 'provider-reply.pdf');
    const two = attachEvidence(one, 'bank-statement.pdf');
    expect(two.evidenceRefs).toEqual(['email-to-provider.pdf', 'provider-reply.pdf', 'bank-statement.pdf']);
    // Adding the same reference twice does not duplicate it, and adding nothing does nothing.
    expect(attachEvidence(two, 'provider-reply.pdf').evidenceRefs).toHaveLength(3);
    expect(attachEvidence(two, '   ').evidenceRefs).toHaveLength(3);
  });

  it('needs a note saying what was actually found', () => {
    const result = resolveInvestigation({
      investigation: open,
      outcome: 'provider_error_recovered',
      note: '   ',
      resolvedBy: 'u-priya',
      at: '2026-08-09T10:00:00Z',
    });
    expect(result.resolved).toBe(false);
  });

  it('resolves with an outcome and FEEDS THE RULES THAT RAISED IT (M15-FR-04)', () => {
    const result = resolveInvestigation({
      investigation: open,
      outcome: 'timing_only',
      note: 'the provider settles this card type at T+5, not T+2',
      resolvedBy: 'u-priya',
      at: '2026-08-09T10:00:00Z',
    });
    expect(result.resolved).toBe(true);
    expect(result.investigation.state).toBe('resolved');
    expect(result.feedback).toContain('correct the cycle so normal timing stops raising exceptions');
  });

  it('will not let the person who raised a difference also write it off (§28)', () => {
    const selfWriteOff = resolveInvestigation({
      investigation: { ...open, openedBy: 'u-priya' },
      outcome: 'written_off',
      note: 'small amount, not worth chasing',
      resolvedBy: 'u-priya',
      at: '2026-08-09T10:00:00Z',
    });
    expect(selfWriteOff.resolved).toBe(false);
    expect(selfWriteOff.detail).toContain('someone other than the person who raised it');

    const proper = resolveInvestigation({
      investigation: { ...open, openedBy: 'u-priya' },
      outcome: 'written_off',
      note: 'provider confirmed the credit was never issued; below the chase threshold',
      resolvedBy: 'u-finance',
      at: '2026-08-09T10:00:00Z',
    });
    expect(proper.resolved).toBe(true);
    expect(proper.feedback).toContain('a real loss');
  });

  it('refuses to resolve twice', () => {
    expect(
      resolveInvestigation({
        investigation: { ...open, state: 'resolved' },
        outcome: 'timing_only',
        note: 'again',
        resolvedBy: 'u-x',
        at: '2026-08-09T10:00:00Z',
      }).resolved,
    ).toBe(false);
  });
});

describe('ageing — the oldest unmatched money is the least likely to arrive', () => {
  it('buckets open investigations by age and values each bucket', () => {
    const make = (id: string, openedAt: string, valueMinor: number): Investigation => ({
      investigationId: id,
      ref: `tok_${id}`,
      finding: 'overdue_settlement',
      valueMinor,
      ownerId: 'u-priya',
      openedBy: 'u-manager',
      openedAt,
      dueBy: '2026-12-31',
      state: 'open',
      evidenceRefs: [],
    });

    const buckets = ageInvestigations(
      [
        make('a', '2026-08-01T09:00:00Z', 10_000), // 4 days
        make('b', '2026-07-20T09:00:00Z', 20_000), // 16 days
        make('c', '2026-06-15T09:00:00Z', 30_000), // 51 days
        make('d', '2026-01-05T09:00:00Z', 40_000), // 212 days
        { ...make('e', '2026-01-05T09:00:00Z', 99_000), state: 'resolved' },
      ],
      '2026-08-05',
    );

    expect(buckets.map((b) => [b.label, b.count, b.valueMinor])).toEqual([
      ['0-7 days', 1, 10_000],
      ['8-30 days', 1, 20_000],
      ['31-90 days', 1, 30_000],
      ['over 90 days', 1, 40_000],
    ]);
  });
});
