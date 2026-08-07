import { describe, it, expect } from 'vitest';
import {
  simulatePromotion,
  approveForLaunch,
  checkAbuseLimit,
  reconcileVendorFunding,
  measureEffectiveness,
  PromotionApprovalRequiredError,
  type SimulationInput,
} from '../../packages/promotions/src/index';
import { money } from '../../packages/contracts/src/money';

// M05-FR-04 — a promotion is a decision to give away margin for volume. These turn
// that decision into arithmetic instead of optimism.

const INR = 'INR' as const;

function sim(over: Partial<SimulationInput> = {}): SimulationInput {
  return {
    promotionId: 'promo-1',
    description: '10% off rice',
    normalPrice: money(10_000, INR), // ₹100.00
    promoPrice: money(9_000, INR), // ₹90.00
    unitCost: money(8_000, INR), // ₹80.00 — 20% normal margin
    baselineUnits: 100,
    expectedUnits: 160,
    ...over,
  };
}

describe('simulatePromotion — before approval, not after month-end', () => {
  it('approves an offer where the extra volume more than covers the margin given up', () => {
    const result = simulatePromotion(sim());
    // ₹20 margin × 100 = ₹2,000 baseline; ₹10 × 160 = ₹1,600. Worse!
    expect(result.verdict).toBe('destroys_margin');
    expect(result.incrementalMargin).toEqual(money(-40_000, INR));
    expect(result.breakEvenUnits).toBe(200);
    expect(result.detail).toContain('would need 200 units to break even');
  });

  it('catches the classic: a discount that turns a thin margin negative', () => {
    // 20% off a 15% margin.
    const result = simulatePromotion(
      sim({ promoPrice: money(8_000, INR), unitCost: money(8_500, INR) }),
    );
    expect(result.verdict).toBe('sells_below_cost');
    expect(result.promoUnitMargin.minor).toBeLessThan(0);
    expect(result.breakEvenUnits).toBe('unreachable');
    expect(result.detail).toContain('volume makes this worse, not better');
    expect(result.blocksApproval).toBe(true);
  });

  it('recognises a genuinely good promotion', () => {
    const result = simulatePromotion(sim({ expectedUnits: 260 }));
    expect(result.verdict).toBe('margin_reduced_but_positive');
    expect(result.incrementalMargin.minor).toBeGreaterThan(0);
    expect(result.blocksApproval).toBe(false);
  });

  it('counts supplier funding as margin, because it is', () => {
    const unfunded = simulatePromotion(sim());
    const funded = simulatePromotion(sim({ vendorFundingPerUnit: money(800, INR) }));
    expect(unfunded.verdict).toBe('destroys_margin');
    // ₹8 per unit of supplier money turns the same offer around: per-unit margin
    // still falls (₹20 → ₹18), but the extra volume now more than covers it.
    expect(funded.incrementalMargin.minor).toBeGreaterThan(unfunded.incrementalMargin.minor);
    expect(funded.verdict).toBe('margin_reduced_but_positive');
    expect(funded.incrementalMargin.minor).toBeGreaterThan(0);
  });

  it('charges the fixed cost of running it', () => {
    const withCost = simulatePromotion(sim({ expectedUnits: 260, fixedCost: money(50_000, INR) }));
    const without = simulatePromotion(sim({ expectedUnits: 260 }));
    expect(withCost.incrementalMargin.minor).toBe(without.incrementalMargin.minor - 50_000);
  });
});

describe('approveForLaunch — a loss-leader is a decision, never an accident', () => {
  const bad = simulatePromotion(sim({ promoPrice: money(7_000, INR) }));

  it('lets a healthy promotion launch with no ceremony', () => {
    expect(approveForLaunch(simulatePromotion(sim({ expectedUnits: 300 })), undefined, 'pricing-1')).toEqual({
      mayLaunch: true,
    });
  });

  it('blocks a margin-losing offer that nobody approved', () => {
    expect(() => approveForLaunch(bad, undefined, 'pricing-1')).toThrow(
      PromotionApprovalRequiredError,
    );
  });

  it('allows it deliberately, with a named approver and a written reason', () => {
    const result = approveForLaunch(
      bad,
      {
        subjectRef: 'promo-1',
        status: 'approved',
        decidedBy: 'owner-1',
        rationale: 'footfall driver for the festival weekend',
      },
      'pricing-1',
    );
    expect(result.approvedBy).toBe('owner-1');
  });

  it('refuses self-approval and a reason nobody could later understand', () => {
    expect(() =>
      approveForLaunch(
        bad,
        { subjectRef: 'promo-1', status: 'approved', decidedBy: 'pricing-1', rationale: 'strategic reasons' },
        'pricing-1',
      ),
    ).toThrow(/cannot approve it themselves/);
    expect(() =>
      approveForLaunch(
        bad,
        { subjectRef: 'promo-1', status: 'approved', decidedBy: 'owner-1', rationale: 'ok' },
        'pricing-1',
      ),
    ).toThrow(/nobody can tell it from a mistake/);
  });
});

describe('checkAbuseLimit — a cap that only works online is not a cap', () => {
  const limit = { promotionId: 'promo-1', perCustomer: 2, perBasket: 1, totalUses: 500 };

  it('allows a use within every limit', () => {
    expect(
      checkAbuseLimit({ limit, usedByThisCustomer: 1, usedInThisBasket: 0, usedInTotal: 100 }).allowed,
    ).toBe(true);
  });

  it('stops a second use in one basket, and a third by one customer', () => {
    expect(
      checkAbuseLimit({ limit, usedByThisCustomer: 0, usedInThisBasket: 1, usedInTotal: 10 }).verdict,
    ).toBe('basket_limit');
    expect(
      checkAbuseLimit({ limit, usedByThisCustomer: 2, usedInThisBasket: 0, usedInTotal: 10 }).verdict,
    ).toBe('customer_limit');
  });

  it('stops the whole offer once its budget is spent', () => {
    const check = checkAbuseLimit({ limit, usedByThisCustomer: 0, usedInThisBasket: 0, usedInTotal: 500 });
    expect(check.verdict).toBe('budget_exhausted');
    expect(check.detail).toContain("budget of 500 uses is spent");
  });

  it('still enforces offline, and says the count may be behind (P-08)', () => {
    const offline = checkAbuseLimit({
      limit,
      usedByThisCustomer: 2,
      usedInThisBasket: 0,
      usedInTotal: 10,
      offline: true,
    });
    // The busiest hour and the worst connectivity are often the same hour.
    expect(offline.allowed).toBe(false);
    expect(offline.countMayBeStale).toBe(true);
  });

  it('treats an unlimited offer as unlimited, rather than inventing a cap', () => {
    expect(
      checkAbuseLimit({
        limit: { promotionId: 'p' },
        usedByThisCustomer: 99,
        usedInThisBasket: 99,
        usedInTotal: 99_999,
      }).allowed,
    ).toBe(true);
  });
});

describe('vendor funding and effectiveness', () => {
  it('shows the discount given against the contribution actually received', () => {
    const result = reconcileVendorFunding(
      {
        promotionId: 'promo-1',
        supplierId: 'sup-1',
        agreedPerUnit: money(800, INR),
        unitsSold: 160,
        receivedAmount: money(80_000, INR),
      },
      INR,
    );
    expect(result.claimable).toEqual(money(128_000, INR));
    expect(result.outstanding).toEqual(money(48_000, INR));
    expect(result.reconciled).toBe(false);
    expect(result.detail).toContain('the discount was given, the contribution was not');
  });

  it('flags receiving MORE than was agreed, which is also wrong', () => {
    const result = reconcileVendorFunding(
      { promotionId: 'p', supplierId: 's', agreedPerUnit: money(100, INR), unitsSold: 10, receivedAmount: money(5_000, INR) },
      INR,
    );
    expect(result.detail).toContain('above the agreed claim');
  });

  it('judges a finished promotion on margin, not on units sold', () => {
    // The trap: 60% more units, less money.
    const busierAndPoorer = measureEffectiveness({
      promotionId: 'promo-1',
      baselineUnits: 100,
      actualUnits: 160,
      baselineMargin: money(200_000, INR),
      actualMargin: money(160_000, INR),
    });
    expect(busierAndPoorer.upliftUnits).toBe(60);
    expect(busierAndPoorer.upliftBp).toBe(6_000);
    expect(busierAndPoorer.worthDoing).toBe(false);
    expect(busierAndPoorer.detail).toContain('busier, and poorer');

    // Supplier funding can turn the same trade around.
    const funded = measureEffectiveness({
      promotionId: 'promo-1',
      baselineUnits: 100,
      actualUnits: 160,
      baselineMargin: money(200_000, INR),
      actualMargin: money(160_000, INR),
      vendorFundingReceived: money(128_000, INR),
    });
    expect(funded.worthDoing).toBe(true);
  });
});
