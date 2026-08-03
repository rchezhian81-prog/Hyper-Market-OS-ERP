import { describe, it, expect } from 'vitest';
import {
  checkCredit,
  computeCommission,
  InvalidCommissionRateError,
} from '../../packages/b2b/src/index';
import { money } from '../../packages/contracts/src/money';
import { requestApproval, decide, type Approver } from '../../packages/approvals/src/index';

// B2B: an over-limit order is blocked pending approval; commission is exact (M22).

const AT = '2026-08-02T11:00:00Z';

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    id: 'so-1',
    customerId: 'biz-1',
    takenBy: 'sales-1',
    creditLimit: money(100_000_00, 'INR'),
    outstanding: money(60_000_00, 'INR'),
    orderValue: money(20_000_00, 'INR'),
    ...overrides,
  };
}

function approvalFor(subjectRef: string, by = 'finance-9') {
  const req = requestApproval({
    id: subjectRef,
    subjectType: 'credit_override',
    subjectRef,
    requestedBy: 'requester-0',
    value: money(0, 'INR'),
  });
  const approver: Approver = { userId: by, branchScope: 'all', authorityLimit: null };
  const outcome = decide(req, approver, 'approved', 'credit approved', AT);
  if (!outcome.ok) throw new Error('expected approval');
  return outcome.request;
}

describe('checkCredit', () => {
  it('allows an order within the credit limit', () => {
    const decision = checkCredit(baseInput());
    expect(decision.verdict).toBe('ok');
    expect(decision.allowed).toBe(true);
    expect(decision.availableCredit).toEqual(money(40_000_00, 'INR')); // 100k − 60k
  });

  it('blocks an over-limit order pending approval', () => {
    // outstanding 60k + order 50k = 110k > 100k limit
    const decision = checkCredit(baseInput({ orderValue: money(50_000_00, 'INR') }));
    expect(decision.verdict).toBe('over_limit');
    expect(decision.requiresApproval).toBe(true);
    expect(decision.allowed).toBe(false);
  });

  it('allows an over-limit order with a valid separate approval', () => {
    const decision = checkCredit(
      baseInput({ orderValue: money(50_000_00, 'INR'), approval: approvalFor('so-1') }),
    );
    expect(decision.allowed).toBe(true);
  });

  it('does not let the order-taker self-approve an over-limit order (§28)', () => {
    const selfApproval = approvalFor('so-1', 'sales-1'); // same as takenBy
    const decision = checkCredit(
      baseInput({ orderValue: money(50_000_00, 'INR'), approval: selfApproval }),
    );
    expect(decision.allowed).toBe(false);
  });

  it('blocks an expired contract per policy, overridable by approval', () => {
    const blocked = checkCredit(baseInput({ contractExpired: true }));
    expect(blocked.verdict).toBe('contract_expired');
    expect(blocked.allowed).toBe(false);

    const approved = checkCredit(baseInput({ contractExpired: true, approval: approvalFor('so-1') }));
    expect(approved.allowed).toBe(true);
  });

  it('proceeds past an expired contract when policy is fallback', () => {
    const decision = checkCredit(baseInput({ contractExpired: true, contractPolicy: 'fallback' }));
    expect(decision.verdict).toBe('ok'); // within limit, falls back to base pricing
    expect(decision.allowed).toBe(true);
  });
});

describe('computeCommission', () => {
  it('computes commission exactly at the given rate', () => {
    // 2.5% of ₹20,000 = ₹500
    expect(computeCommission(money(20_000_00, 'INR'), 250)).toEqual(money(500_00, 'INR'));
  });

  it('rounds to whole minor units (half-up)', () => {
    // 3.33% of ₹10.01 = 0.333333 → 33.33... paise → rounds to 33 paise
    expect(computeCommission(money(10_01, 'INR'), 333)).toEqual(money(33, 'INR'));
  });

  it('caps the payout when a cap is given', () => {
    // 10% of ₹20,000 = ₹2,000, capped at ₹1,000
    expect(computeCommission(money(20_000_00, 'INR'), 1000, 1_000_00)).toEqual(money(1_000_00, 'INR'));
  });

  it('rejects an invalid rate', () => {
    expect(() => computeCommission(money(100_00, 'INR'), 20_000)).toThrow(InvalidCommissionRateError);
  });
});
