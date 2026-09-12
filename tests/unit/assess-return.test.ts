import { describe, it, expect } from 'vitest';
import {
  assessReturn, refundGovernanceFindings, crossLaneRefundFindings, type ReturnRequest,
  type OriginalSale, type RecordedReturn,
} from '../../packages/returns/src/index';

// The cloud-side return guard (M13-FR-01/FR-03, §28). Pure: given the bill, its whole return/refund
// history, and a new return, it says yes-and-what's-left or no-and-why. The integration test drives
// this through the real API; these cases pin the arithmetic the API leans on — the ones a wire test
// cannot easily reach: two lines of one product gaming the cap, and a return not counting itself.

const SALE: OriginalSale = {
  saleId: 'S-1', number: 'R-1001', tradingDay: '2026-08-01',
  committedAt: '2026-08-01T10:00:00.000Z', totalMinor: 15_000,
  lines: [{ productId: 'p1', uom: 'ea', quantityMinor: 3 }],
  tenders: [{ kind: 'cash', amountMinor: 15_000 }],
};

const request = (over: Partial<ReturnRequest> = {}): ReturnRequest => ({
  returnId: 'RT-1', number: 'RN-1', originalSaleId: 'S-1', processedBy: 'u1',
  processedAt: '2026-08-02T10:00:00.000Z', reasonCode: 'changed_mind',
  lines: [{ productId: 'p1', uom: 'ea', quantityMinor: 1, disposition: 'resell' }],
  refundMinor: 5_000, refundTender: 'cash', approvalThresholdMinor: 9_999_999, ...over,
});

const assess = (request: ReturnRequest, priorReturns: readonly RecordedReturn[] = [], priorRefunds: readonly { returnId: string; originalSaleId: string | null; refundMinor: number }[] = []) =>
  assessReturn({ sale: SALE, priorReturns, priorRefunds, request });

describe('assessReturn guards the refund against the whole history', () => {
  it('accepts a clean partial return and reports what is left', () => {
    const r = assess(request());
    expect(r.ok).toBe(true);
    expect(r.restockedLines).toBe(1);
    expect(r.remaining.find((l) => l.productId === 'p1')?.returnableMinor).toBe(2);
  });

  it('cannot be gamed by splitting one product across two lines', () => {
    // Two lines of p1, 2 + 2 = 4, against 3 sold. Aggregating by product catches it; checking each
    // line alone (2 ≤ 3, 2 ≤ 3) would not.
    const r = assess(request({ lines: [
      { productId: 'p1', uom: 'ea', quantityMinor: 2, disposition: 'resell' },
      { productId: 'p1', uom: 'ea', quantityMinor: 2, disposition: 'resell' },
    ] }));
    expect(r.ok).toBe(false);
    expect(r.refusedBecause).toBe('more_than_was_sold');
  });

  it('does not count a return against itself (idempotent retry)', () => {
    // The same return already sits in the history. Re-assessing it must not read its own quantity as
    // "already returned" and refuse it — the retry reaches the same yes it did the first time.
    const prior: RecordedReturn = {
      returnId: 'RT-1', originalSaleId: 'S-1', processedAt: '2026-08-02T10:00:00.000Z',
      lines: [{ productId: 'p1', uom: 'ea', quantityMinor: 3 }],
    };
    const r = assess(request({ returnId: 'RT-1', lines: [{ productId: 'p1', uom: 'ea', quantityMinor: 3, disposition: 'resell' }] }), [prior]);
    expect(r.ok).toBe(true);
  });

  it('holds the money cap across separate returns', () => {
    // ₹150 already refunded on the ₹150 bill; a further ₹1 cannot go out.
    const r = assess(
      request({ returnId: 'RT-2', refundMinor: 100 }),
      [],
      [{ returnId: 'RT-1', originalSaleId: 'S-1', refundMinor: 15_000 }],
    );
    expect(r.ok).toBe(false);
    expect(r.refusedBecause).toBe('refund_exceeds_what_is_left');
  });

  it('reports a card refund pending and a cash refund settled (M13-FR-04)', () => {
    expect(assess(request({ refundTender: 'card' })).refundStatus).toBe('pending');
    expect(assess(request({ refundTender: 'cash' })).refundStatus).toBe('settled');
  });

  it('requires a different approver only for a material refund (§28)', () => {
    const material = (over: Partial<ReturnRequest>) => request({ refundMinor: 12_000, approvalThresholdMinor: 10_000, ...over });
    expect(assess(material({})).refusedBecause).toBe('needs_a_second_person');
    expect(assess(material({ approvedBy: 'u1' })).refusedBecause).toBe('approved_by_the_person_processing_it');
    expect(assess(material({ approvedBy: 'u2' })).ok).toBe(true);
  });
});

// The findings on an ALREADY-GIVEN (synced) refund — the record-and-flag counterpart to the desk guard.
describe('refundGovernanceFindings (M13-FR-01, §28 on sync)', () => {
  const f = (over: Partial<Parameters<typeof refundGovernanceFindings>[0]> = {}) => refundGovernanceFindings({
    refundMinor: 5000, approvalThresholdMinor: 0, processedBy: 'u-lane', approverHoldsAuthority: true, ...over,
  });

  it('an immaterial refund (below threshold) has no findings', () => {
    expect(f({ refundMinor: 5000, approvalThresholdMinor: 10000, approvedBy: undefined })).toEqual([]);
    expect(f({ refundMinor: 0, approvalThresholdMinor: 0 })).toEqual([]);
  });
  it('a material refund with no approver, a self-approval, or an unauthorised approver is flagged, in precedence', () => {
    expect(f({ approvedBy: undefined })).toEqual(['given_without_approval']);
    expect(f({ approvedBy: 'u-lane' })).toEqual(['approved_by_the_processor']);
    expect(f({ approvedBy: 'u-other', approverHoldsAuthority: false })).toEqual(['approver_lacks_authority']);
  });
  it('a material refund approved by a genuinely-authorised, different person has no findings', () => {
    expect(f({ approvedBy: 'u-mgr', approverHoldsAuthority: true })).toEqual([]);
  });
});

describe('crossLaneRefundFindings — global at-most-once from the whole cloud history (GAP-REFUND-XLANE-01)', () => {
  // SALE sold 3 units of p1 for ₹150.
  const priorReturn = (returnId: string, qty: number): RecordedReturn => ({
    returnId, originalSaleId: 'S-1', processedAt: '2026-08-01T11:00:00.000Z',
    lines: [{ productId: 'p1', uom: 'ea', quantityMinor: qty }],
  });

  it('no findings when this return stays within what the bill sold and was paid', () => {
    const findings = crossLaneRefundFindings({
      sale: SALE, priorReturns: [priorReturn('RT-A', 1)], priorRefunds: [{ returnId: 'RT-A', originalSaleId: 'S-1', refundMinor: 5_000 }],
      thisReturn: { returnId: 'RT-B', lines: [{ productId: 'p1', uom: 'ea', quantityMinor: 1 }], refundMinor: 5_000 },
    });
    expect(findings).toEqual([]); // 2 of 3 units, ₹100 of ₹150 — within entitlement
  });

  it('flags an over-return of goods once cumulative exceeds what was sold', () => {
    const findings = crossLaneRefundFindings({
      sale: SALE, priorReturns: [priorReturn('RT-A', 3)], priorRefunds: [{ returnId: 'RT-A', originalSaleId: 'S-1', refundMinor: 15_000 }],
      thisReturn: { returnId: 'RT-B', lines: [{ productId: 'p1', uom: 'ea', quantityMinor: 1 }], refundMinor: 0 },
    });
    expect(findings).toContain('over_returned_goods'); // 4 of 3 units
  });

  it('flags an over-refund of money independently of the goods count', () => {
    const findings = crossLaneRefundFindings({
      sale: SALE, priorReturns: [priorReturn('RT-A', 1)], priorRefunds: [{ returnId: 'RT-A', originalSaleId: 'S-1', refundMinor: 15_000 }],
      thisReturn: { returnId: 'RT-B', lines: [{ productId: 'p1', uom: 'ea', quantityMinor: 1 }], refundMinor: 5_000 },
    });
    expect(findings).toContain('refund_exceeds_paid');   // ₹200 of ₹150 paid
    expect(findings).not.toContain('over_returned_goods'); // 2 of 3 units — goods fine
  });

  it('is idempotent: folding a return already in the history changes nothing', () => {
    const findings = crossLaneRefundFindings({
      sale: SALE, priorReturns: [priorReturn('RT-A', 3)], priorRefunds: [{ returnId: 'RT-A', originalSaleId: 'S-1', refundMinor: 15_000 }],
      thisReturn: { returnId: 'RT-A', lines: [{ productId: 'p1', uom: 'ea', quantityMinor: 3 }], refundMinor: 15_000 },
    });
    expect(findings).toEqual([]); // RT-A counted once — exactly 3 of 3, ₹150 of ₹150
  });
});
