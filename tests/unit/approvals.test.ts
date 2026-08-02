import { describe, it, expect } from 'vitest';
import {
  requestApproval,
  decide,
  type Approver,
} from '../../packages/approvals/src/index';
import { money } from '../../packages/contracts/src/money';

// The maker-checker engine's whole reason to exist is §28: the person who makes a
// request can never approve it. These tests pin that invariant and the value/scope
// routing (M02-FR-03).

const AT = '2026-08-02T10:00:00Z';

function priceChange(by: string, branchId: string | null = 'branch-1') {
  return requestApproval({
    id: 'req-1',
    subjectType: 'price_change',
    subjectRef: 'price-9',
    requestedBy: by,
    branchId,
    value: money(500_00, 'INR'), // ₹500.00
  });
}

const managerAt = (userId: string, limitMinor: number | null): Approver => ({
  userId,
  branchScope: ['branch-1'],
  authorityLimit: limitMinor === null ? null : money(limitMinor, 'INR'),
});

describe('requestApproval', () => {
  it('builds an immutable pending request with defaults', () => {
    const r = requestApproval({
      id: 'r1',
      subjectType: 'refund',
      subjectRef: 'sale-1',
      requestedBy: 'cashier-7',
    });
    expect(r.status).toBe('pending');
    expect(r.branchId).toBeNull();
    expect(r.value).toBeNull();
    expect(Object.isFrozen(r)).toBe(true);
  });

  it('rejects empty required fields', () => {
    expect(() =>
      requestApproval({ id: '', subjectType: 'x', subjectRef: 'y', requestedBy: 'z' }),
    ).toThrow(RangeError);
  });
});

describe('separation of duties (§28)', () => {
  it('forbids the maker from approving their own request', () => {
    const req = priceChange('manager-5');
    const outcome = decide(req, managerAt('manager-5', 1000_00), 'approved', 'looks fine', AT);
    expect(outcome).toEqual({ ok: false, refusal: 'self_approval_forbidden' });
  });

  it('also forbids the maker from rejecting their own request', () => {
    const req = priceChange('manager-5');
    const outcome = decide(req, managerAt('manager-5', 1000_00), 'rejected', 'nope', AT);
    expect(outcome.ok).toBe(false);
  });
});

describe('valid decisions', () => {
  it('approves when a different, authorised, in-scope approver acts with a reason', () => {
    const req = priceChange('manager-5');
    const outcome = decide(req, managerAt('owner-1', 1000_00), 'approved', 'within policy', AT);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.request.status).toBe('approved');
      expect(outcome.request.decidedBy).toBe('owner-1');
      expect(outcome.request.reason).toBe('within policy');
      expect(Object.isFrozen(outcome.request)).toBe(true);
    }
  });

  it('requires a reason on every decision', () => {
    const req = priceChange('manager-5');
    expect(decide(req, managerAt('owner-1', 1000_00), 'approved', '  ', AT)).toEqual({
      ok: false,
      refusal: 'reason_required',
    });
  });
});

describe('scope and value-limit routing (M02-FR-03)', () => {
  it('refuses an approver outside the request branch scope', () => {
    const req = priceChange('manager-5', 'branch-2');
    const outcome = decide(req, managerAt('owner-1', 1000_00), 'approved', 'ok', AT);
    expect(outcome).toEqual({ ok: false, refusal: 'out_of_scope' });
  });

  it('refuses to APPROVE beyond the approver authority, but allows a REJECT', () => {
    const req = priceChange('manager-5'); // value ₹500
    const junior = managerAt('junior-2', 100_00); // limit ₹100
    expect(decide(req, junior, 'approved', 'too big for me', AT)).toEqual({
      ok: false,
      refusal: 'exceeds_authority',
    });
    expect(decide(req, junior, 'rejected', 'not allowed', AT).ok).toBe(true);
  });

  it('an unlimited approver can approve any value', () => {
    const req = priceChange('manager-5');
    expect(decide(req, managerAt('owner-1', null), 'approved', 'fine', AT).ok).toBe(true);
  });

  it('a company-wide request needs an "all"-scope approver', () => {
    const req = priceChange('manager-5', null);
    const branchScoped = managerAt('owner-1', null);
    expect(decide(req, branchScoped, 'approved', 'ok', AT)).toEqual({
      ok: false,
      refusal: 'out_of_scope',
    });
    const companyWide: Approver = { userId: 'owner-1', branchScope: 'all', authorityLimit: null };
    expect(decide(req, companyWide, 'approved', 'ok', AT).ok).toBe(true);
  });
});
