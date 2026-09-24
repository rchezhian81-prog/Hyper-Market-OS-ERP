import { describe, it, expect } from 'vitest';
import {
  substitutionExceptions,
  type SubstitutionRecordView,
} from '../../packages/orders/src/index';

// M19-FR-01 substitution EXCEPTION queue. The recorded substitution decisions become an owned, valued,
// worst-first worklist so no swap that owes money or left the customer short waits unseen (P-08).

const rec = (over: Partial<SubstitutionRecordView>): SubstitutionRecordView =>
  ({ orderId: 'o1', lineId: 'l1', outcome: 'substituted', ...over });

describe('substitutionExceptions — the worklist of swaps needing action (M19-FR-01)', () => {
  it('surfaces a prepaid refund due', () => {
    const q = substitutionExceptions([rec({ settlementKind: 'prepaid_refund', settlementMinor: 2_000 })]);
    expect(q.count).toBe(1);
    expect(q.exceptions[0]).toMatchObject({ kind: 'refund_due', amountMinor: 2_000 });
    expect(q.atRiskMinor).toBe(2_000);
  });

  it('surfaces a COD collect-adjustment (less and more)', () => {
    const less = substitutionExceptions([rec({ settlementKind: 'collect_less', settlementMinor: 1_500 })]);
    expect(less.exceptions[0]).toMatchObject({ kind: 'collect_adjustment', amountMinor: 1_500 });
    const more = substitutionExceptions([rec({ settlementKind: 'collect_more', settlementMinor: 3_000, aboveCap: false })]);
    expect(more.exceptions[0]).toMatchObject({ kind: 'collect_adjustment', amountMinor: 3_000 });
  });

  it('surfaces an above-cap charge for approval verification (ahead of ordinary money moves)', () => {
    const q = substitutionExceptions([rec({ settlementKind: 'prepaid_additional_charge', settlementMinor: 5_000, aboveCap: true })]);
    expect(q.exceptions[0]).toMatchObject({ kind: 'above_cap_charge', amountMinor: 5_000 });
  });

  it('surfaces an M18 cheaper-difference refund even when no tender was recorded', () => {
    const q = substitutionExceptions([rec({ refundMinor: 800 })]);
    expect(q.exceptions[0]).toMatchObject({ kind: 'refund_due', amountMinor: 800 });
  });

  it('surfaces a policy short-pick (a refused swap left the line short)', () => {
    const q = substitutionExceptions([rec({ outcome: 'short_picked', eligibility: 'refused', settlementKind: 'prepaid_refund', settlementMinor: 10_000, aboveCap: false })]);
    // A refused swap on a prepaid order owes the whole line back — recorded as a refund_due (money first).
    expect(q.exceptions[0]?.kind).toBe('refund_due');
    expect(q.exceptions[0]?.amountMinor).toBe(10_000);
  });

  it('a refused swap with no tender is a policy_short_pick', () => {
    const q = substitutionExceptions([rec({ outcome: 'short_picked', eligibility: 'refused' })]);
    expect(q.exceptions[0]).toMatchObject({ kind: 'policy_short_pick', amountMinor: 0 });
  });

  it('ignores a same-price swap that moved no money and broke no rule', () => {
    const q = substitutionExceptions([rec({ settlementKind: 'none', settlementMinor: 0, eligibility: 'auto_accept' })]);
    expect(q.count).toBe(0);
    expect(q.atRiskMinor).toBe(0);
  });

  it('orders worst (largest amount) first, deterministically', () => {
    const q = substitutionExceptions([
      rec({ orderId: 'o1', lineId: 'a', settlementKind: 'prepaid_refund', settlementMinor: 1_000 }),
      rec({ orderId: 'o2', lineId: 'b', settlementKind: 'collect_less', settlementMinor: 9_000 }),
      rec({ orderId: 'o3', lineId: 'c', aboveCap: true, settlementKind: 'collect_more', settlementMinor: 5_000 }),
    ]);
    expect(q.exceptions.map((e) => e.amountMinor)).toEqual([9_000, 5_000, 1_000]);
    expect(q.atRiskMinor).toBe(15_000);
  });

  it('an empty set is an empty queue', () => {
    const q = substitutionExceptions([]);
    expect(q).toEqual({ exceptions: [], count: 0, atRiskMinor: 0 });
  });
});
