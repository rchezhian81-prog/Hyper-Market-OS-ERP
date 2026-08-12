import { describe, it, expect } from 'vitest';
import {
  resolvePolicy,
  requirePolicy,
  categorySaleDecision,
  categoryReturnDecision,
  needsApproval,
  describePolicy,
  InvalidCategoryPolicy,
  NoPolicyInForceError,
  type CategoryPolicyRules,
  type CategoryPolicy,
} from '../../packages/product/src/category-policy';

// A plain fast-moving grocery category: sells with no ceremony, returnable within 7 days.
const GROCERY: CategoryPolicyRules = {
  traceability: 'none',
  quantityMode: 'each',
  valuation: 'retail_mrp',
  shelfLife: { perishable: false, blockSaleAfterExpiry: false },
  returns: { returnable: true, windowDays: 7 },
  controlledSale: {},
  approvals: [],
  enabledByDefault: true,
};

// A controlled vertical (gold-like): off until switched on, serial-tracked, needs KYC + serial capture,
// rate override needs approval, not returnable.
const CONTROLLED: CategoryPolicyRules = {
  traceability: 'serial',
  quantityMode: 'catch_weight',
  valuation: 'rate_per_unit_weight',
  shelfLife: { perishable: false, blockSaleAfterExpiry: false },
  returns: { returnable: false },
  controlledSale: { requires: ['kyc', 'serial_capture'] },
  approvals: ['rate_override', 'price_override'],
  enabledByDefault: false,
};

// A perishable food category that blocks sale past use-by.
const PERISHABLE: CategoryPolicyRules = {
  traceability: 'batch',
  quantityMode: 'weighed',
  valuation: 'retail_mrp',
  shelfLife: { perishable: true, blockSaleAfterExpiry: true, nearExpiryAlertDays: 2 },
  returns: { returnable: true, windowDays: 1, approvalRequired: true },
  controlledSale: {},
  approvals: ['markdown'],
  enabledByDefault: true,
};

describe('resolvePolicy — the rules in force on a date (effective-dated, mirrors mrpOn)', () => {
  const history = [
    { effectiveFrom: '2026-01-01', value: GROCERY },
    { effectiveFrom: '2026-06-01', value: { ...GROCERY, returns: { returnable: true, windowDays: 14 } } },
  ];

  it('takes the latest entry effective on or before the date', () => {
    expect(resolvePolicy(history, '2026-05-31')?.returns.windowDays).toBe(7);
    expect(resolvePolicy(history, '2026-06-01')?.returns.windowDays).toBe(14); // boundary: on the effective day
    expect(resolvePolicy(history, '2026-09-01')?.returns.windowDays).toBe(14);
  });

  it('returns undefined before the earliest entry', () => {
    expect(resolvePolicy(history, '2025-12-31')).toBeUndefined();
  });

  it('rejects a bad date rather than guessing', () => {
    expect(() => resolvePolicy(history, '2026-13-01')).toThrow(InvalidCategoryPolicy);
    expect(() => resolvePolicy([{ effectiveFrom: 'nope', value: GROCERY }], '2026-01-01')).toThrow(InvalidCategoryPolicy);
  });

  it('requirePolicy throws NoPolicyInForceError when none is in force', () => {
    const policy: CategoryPolicy = { categoryId: 'cat-grocery', history };
    expect(requirePolicy(policy, '2026-06-01').returns.windowDays).toBe(14);
    expect(() => requirePolicy(policy, '2025-01-01')).toThrow(NoPolicyInForceError);
  });
});

describe('categorySaleDecision', () => {
  it('sells a plain grocery line with no context', () => {
    expect(categorySaleDecision(GROCERY)).toEqual({ allowed: true, refusals: [] });
  });

  it('keeps a controlled vertical off until the store enables it', () => {
    const off = categorySaleDecision(CONTROLLED, { kycOnFile: true, serialCaptured: true });
    expect(off.allowed).toBe(false);
    expect(off.refusals.map((r) => r.reason)).toContain('category_not_enabled');

    const on = categorySaleDecision(CONTROLLED, { categoryEnabled: true, kycOnFile: true, serialCaptured: true });
    expect(on.allowed).toBe(true);
  });

  it('names every missing control at once for an enabled controlled vertical', () => {
    const d = categorySaleDecision(CONTROLLED, { categoryEnabled: true });
    expect(d.allowed).toBe(false);
    expect(d.refusals.map((r) => r.reason).sort()).toEqual(['kyc_required', 'serial_not_captured']);
  });

  it('blocks a hard-blocked category outright and stops there', () => {
    const blocked: CategoryPolicyRules = { ...CONTROLLED, controlledSale: { blocked: true, requires: ['kyc'] } };
    const d = categorySaleDecision(blocked, { categoryEnabled: true, kycOnFile: true });
    expect(d.allowed).toBe(false);
    expect(d.refusals).toHaveLength(1);
    expect(d.refusals[0]!.reason).toBe('category_blocked');
  });

  it('refuses an expired unit only where the category blocks sale after use-by', () => {
    expect(categorySaleDecision(PERISHABLE, { expired: true }).refusals.map((r) => r.reason)).toContain('expired');
    expect(categorySaleDecision(GROCERY, { expired: true }).allowed).toBe(true); // grocery doesn't block
  });

  it('enforces an age gate from the policy configuration', () => {
    const ageRules: CategoryPolicyRules = { ...GROCERY, controlledSale: { requires: ['age'], minimumAge: 21 } };
    expect(categorySaleDecision(ageRules, {}).refusals.map((r) => r.reason)).toContain('age_not_confirmed');
    expect(categorySaleDecision(ageRules, { ageConfirmed: true, ageYears: 19 }).refusals.map((r) => r.reason)).toContain('underage');
    expect(categorySaleDecision(ageRules, { ageConfirmed: true, ageYears: 22 }).allowed).toBe(true);
  });
});

describe('categoryReturnDecision', () => {
  it('accepts a return inside the window, flagging approval where required', () => {
    expect(categoryReturnDecision(GROCERY, 3)).toMatchObject({ allowed: true, approvalRequired: false });
    expect(categoryReturnDecision(PERISHABLE, 1)).toMatchObject({ allowed: true, approvalRequired: true });
  });

  it('refuses outside the window and for non-returnable categories', () => {
    expect(categoryReturnDecision(GROCERY, 8)).toMatchObject({ allowed: false, reason: 'outside_window' });
    expect(categoryReturnDecision(CONTROLLED, 0)).toMatchObject({ allowed: false, reason: 'not_returnable' });
  });
});

describe('needsApproval + describePolicy', () => {
  it('reads approval requirements from the policy', () => {
    expect(needsApproval(CONTROLLED, 'rate_override')).toBe(true);
    expect(needsApproval(GROCERY, 'rate_override')).toBe(false);
  });

  it('summarises a policy in plain English', () => {
    expect(describePolicy(GROCERY)).toContain('returnable within 7 days');
    const s = describePolicy(CONTROLLED);
    expect(s).toContain('each unit tracked individually');
    expect(s).toContain('controlled — off until switched on');
    expect(s).toContain('not returnable');
  });
});
