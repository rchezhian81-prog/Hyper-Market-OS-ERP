import { describe, it, expect } from 'vitest';
import { assessOverShortReview } from '../../packages/till/src/index';

// The cash-office sign-off on a material over/short (M14 / P-03 control by exception). The one rule
// that matters: the cashier who counted the drawer cannot clear its own shortage — the review needs a
// second, accountable person. A clean drawer has nothing to review; a blank sign-off closes nothing.

const base = {
  reviewerId: 'u-manager',
  cashierId: 'u-cashier',
  exceptionRaised: true,
  disposition: 'gave_wrong_change',
};

describe('assessing a cash-office over/short sign-off', () => {
  it('allows a second, accountable person to sign off a material over/short with a finding', () => {
    expect(assessOverShortReview(base).ok).toBe(true);
  });

  it('refuses a sign-off on a drawer that balanced within tolerance — nothing to review', () => {
    const r = assessOverShortReview({ ...base, exceptionRaised: false });
    expect(r.ok).toBe(false);
    expect(r.refusedBecause).toBe('nothing_to_review');
  });

  it('refuses the cashier signing off their own drawer (separation of duties)', () => {
    const r = assessOverShortReview({ ...base, reviewerId: 'u-cashier' });
    expect(r.ok).toBe(false);
    expect(r.refusedBecause).toBe('cannot_review_your_own_drawer');
  });

  it('refuses a blank finding — a sign-off with no disposition closes nothing', () => {
    expect(assessOverShortReview({ ...base, disposition: '' }).refusedBecause).toBe('disposition_required');
    expect(assessOverShortReview({ ...base, disposition: '   ' }).refusedBecause).toBe('disposition_required');
  });
});
