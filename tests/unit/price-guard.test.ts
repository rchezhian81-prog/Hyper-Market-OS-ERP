import { describe, it, expect } from 'vitest';
import {
  checkPrice,
  InvalidMarginFloorError,
} from '../../packages/price-guard/src/index';
import { money } from '../../packages/contracts/src/money';
import { requestApproval, decide, type Approver } from '../../packages/approvals/src/index';

// Never above MRP; below floor/cost is an approved exception, never silent
// (M05-FR-02). Checks are exact and run the same offline.

const AT = '2026-08-02T16:00:00Z';

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    id: 'price-1',
    proposedPrice: money(90_00, 'INR'),
    mrp: money(100_00, 'INR'),
    cost: money(60_00, 'INR'),
    marginFloorBps: 2000, // 20% minimum margin
    setBy: 'pricing-1',
    ...overrides,
  };
}

function approvalFor(subjectRef: string, by = 'manager-9') {
  const req = requestApproval({
    id: subjectRef,
    subjectType: 'price_change',
    subjectRef,
    requestedBy: 'requester-0',
    value: money(90_00, 'INR'),
  });
  const approver: Approver = { userId: by, branchScope: 'all', authorityLimit: null };
  const outcome = decide(req, approver, 'approved', 'clearance markdown', AT);
  if (!outcome.ok) throw new Error('expected approval');
  return outcome.request;
}

describe('checkPrice', () => {
  it('allows a healthy price at/below MRP and above the floor', () => {
    // price ₹90, cost ₹60 → margin (90−60)/90 = 33% ≥ 20% floor
    const result = checkPrice(baseInput());
    expect(result.verdict).toBe('ok');
    expect(result.allowed).toBe(true);
    expect(result.requiresApproval).toBe(false);
  });

  it('rejects a price above MRP outright — no approval path', () => {
    const result = checkPrice(
      baseInput({ proposedPrice: money(110_00, 'INR'), approval: approvalFor('price-1') }),
    );
    expect(result.verdict).toBe('above_mrp');
    expect(result.allowed).toBe(false);
    expect(result.requiresApproval).toBe(false);
  });

  it('blocks a below-floor price without approval', () => {
    // price ₹65, cost ₹60 → margin ~7.7% < 20% floor
    const result = checkPrice(baseInput({ proposedPrice: money(65_00, 'INR') }));
    expect(result.verdict).toBe('below_floor');
    expect(result.requiresApproval).toBe(true);
    expect(result.allowed).toBe(false);
  });

  it('allows a below-floor price with a valid separate approval', () => {
    const result = checkPrice(
      baseInput({ proposedPrice: money(65_00, 'INR'), approval: approvalFor('price-1') }),
    );
    expect(result.verdict).toBe('below_floor');
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('clearance markdown');
  });

  it('flags a below-cost price and requires approval', () => {
    const result = checkPrice(baseInput({ proposedPrice: money(55_00, 'INR') }));
    expect(result.verdict).toBe('below_cost');
    expect(result.requiresApproval).toBe(true);
    expect(result.allowed).toBe(false);
  });

  it('allows a below-cost price only with a valid approval', () => {
    const result = checkPrice(
      baseInput({ proposedPrice: money(55_00, 'INR'), approval: approvalFor('price-1') }),
    );
    expect(result.verdict).toBe('below_cost');
    expect(result.allowed).toBe(true);
  });

  it('rejects a self-approved below-floor price (§28)', () => {
    const selfApproval = approvalFor('price-1', 'pricing-1'); // same as setBy
    const result = checkPrice(baseInput({ proposedPrice: money(65_00, 'INR'), approval: selfApproval }));
    expect(result.allowed).toBe(false);
  });

  it('rejects an approval that references a different price', () => {
    const wrong = approvalFor('some-other-price');
    const result = checkPrice(baseInput({ proposedPrice: money(65_00, 'INR'), approval: wrong }));
    expect(result.allowed).toBe(false);
  });

  it('treats a price exactly at MRP as allowed', () => {
    const result = checkPrice(baseInput({ proposedPrice: money(100_00, 'INR') }));
    expect(result.verdict).toBe('ok');
    expect(result.allowed).toBe(true);
  });

  it('rejects an invalid margin-floor configuration', () => {
    expect(() => checkPrice(baseInput({ marginFloorBps: 10_000 }))).toThrow(InvalidMarginFloorError);
  });
});
