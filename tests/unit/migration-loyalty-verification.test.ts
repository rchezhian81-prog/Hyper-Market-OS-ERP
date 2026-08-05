import { describe, it, expect } from 'vitest';
import {
  planLoyaltySample, assessLoyaltyVerification,
  type LoyaltyBalance, type CustomerConfirmation,
} from '../../packages/migration/src/loyalty-verification';

// MG-06, OB-06, §34 — the last of the six, and the odd one out. No third party keeps a record of
// a customer's points; the only witness is the customer.

const BALANCES: readonly LoyaltyBalance[] = [
  { customerId: 'C001', customerName: 'Meena R', pointsBalance: 12_000, tier: 'gold' },
  { customerId: 'C002', customerName: 'Suresh K', pointsBalance: 9_400, tier: 'gold' },
  { customerId: 'C003', customerName: 'Lakshmi V', pointsBalance: 5_100, tier: 'silver' },
  { customerId: 'C004', customerName: 'Arun P', pointsBalance: 4_950, tier: 'silver', pointsExpiringSoon: 800 },
  ...Array.from({ length: 60 }, (_, i) => ({
    customerId: `C${String(i + 100).padStart(3, '0')}`,
    customerName: `Customer ${i + 1}`,
    pointsBalance: 40 + i * 7,
  })),
];

const plan = (over: Partial<Parameters<typeof planLoyaltySample>[0]> = {}) => planLoyaltySample({
  planId: 'loy-1', balances: BALANCES, plannedBy: 'u-manager', extractionOperator: 'u-operator',
  source: 'drawn_before_anybody_was_told', seed: 20260807, ...over,
});

const confirm = (customerId: string, statedPoints: number): CustomerConfirmation =>
  ({ customerId, method: 'customer_stated_their_own_figure', statedPoints, confirmedOn: '2026-08-20' });

const assess = (over: Partial<Parameters<typeof assessLoyaltyVerification>[0]> = {}) =>
  assessLoyaltyVerification({
    migrated: BALANCES,
    confirmations: BALANCES.slice(0, 4).map((b) => confirm(b.customerId, b.pointsBalance)),
    asked: BALANCES.slice(0, 4).map((b) => b.customerId),
    pointCostMinor: 25, // 25 paise of goods per redeemed point
    ...over,
  });

describe('the sample cannot come from the complaints', () => {
  it('REFUSES a sample drawn from customers who complained', () => {
    // Every customer whose points went DOWN complains; no customer whose points went UP ever
    // does. So that sample is 100% shortfalls by construction, and it confirms — with real
    // evidence from real customers — a migration that is quietly over-crediting everybody.
    const r = plan({ source: 'drawn_from_complaints' });
    expect(r.ok).toBe(false);
    expect(r.refusedBecause).toBe('drawn_from_complaints');
    expect(r.detail).toContain('100% shortfalls by construction');
  });

  it('REFUSES a sample chosen by whoever ran the extraction (§28)', () => {
    const r = plan({ plannedBy: 'u-operator' });
    expect(r.refusedBecause).toBe('chosen_by_the_extractor');
    expect(r.detail).toContain('that is what confidence does');
  });

  it('REFUSES a sample too thin to conclude anything from', () => {
    const r = plan({ balances: BALANCES.slice(0, 2), censusPointsTargetBps: 1, tailSampleRateBps: 0 });
    expect(r.refusedBecause).toBe('sample_too_small');
  });
});

describe('who gets asked, and why', () => {
  // A threshold high in the balances and one down in the tail, so both cases are exercised.
  const p = plan({ tierThresholds: [5_000, 300], tierBoundaryWindow: 20 }).plan!;

  it('covers most of the points with a handful of customers', () => {
    expect(p.censusCustomers).toBeLessThan(10);
    expect(p.pointsCoverageBps).toBeGreaterThan(6_000);
  });

  it('asks a customer sitting on a tier threshold who would otherwise never be asked', () => {
    // C137 holds 299 points against a 300-point threshold. Far too small to reach the census and
    // unlikely to be drawn at random — and one point from a tier that is printed on every receipt
    // and shown in the app, where a tiny error becomes a very loud one.
    const boundary = p.lines.filter((l) => l.stratum === 'tier_boundary').map((l) => l.customerId);
    expect(boundary).toContain('C137');
    expect(p.detail).toContain('sitting on a tier boundary');
  });

  it('does not put a customer in two strata — the census wins', () => {
    // C004 holds 4,950 against the 5,000 line, so it qualifies on the boundary rule too. It is
    // already being counted in full, and listing it twice would overstate the coverage.
    const strata = p.lines.filter((l) => l.customerId === 'C004').map((l) => l.stratum);
    expect(strata).toEqual(['largest_balances']);
  });

  it('keeps a random slice, because the big accounts are the ones already got right', () => {
    expect(p.sampledCustomers).toBeGreaterThan(0);
    expect(p.detail).toContain('the random slice matters most');
  });

  it('NEVER puts the balance on the sheet, and asks a question with no answer in it', () => {
    for (const l of p.lines) {
      const shown: false = l.balanceShownToTheCustomer;
      expect(shown).toBe(false);
      expect(l.ask).toContain('Do not offer a figure');
    }
    expect(JSON.stringify(p.lines)).not.toContain('pointsBalance');
  });

  it('is reproducible from its seed, so an auditor can ask why THIS customer', () => {
    const again = plan({ tierThresholds: [5_000, 300], tierBoundaryWindow: 20 }).plan!;
    expect(again.lines.map((l) => `${l.customerId}:${l.stratum}`))
      .toEqual(p.lines.map((l) => `${l.customerId}:${l.stratum}`));
  });
});

describe('showing the customer the balance is not a confirmation', () => {
  it('REFUSES a confirmation obtained by reading the balance out', () => {
    // "Is your balance 450 points?" — almost anybody says yes. Nobody carries their points total
    // in their head, so the question measures agreeableness. Same as printing "expected: 40" on a
    // stock count sheet.
    const r = assess({
      confirmations: [{ customerId: 'C001', method: 'customer_shown_the_balance_and_agreed', confirmedOn: '2026-08-20' }],
    });
    expect(r.accepted).toBe(false);
    expect(r.refusedBecause).toBe('balance_was_shown_to_the_customer');
    expect(r.detail).toContain('measures agreeableness rather than the balance');
  });

  it('REFUSES a confirmation that records agreement without a figure', () => {
    const r = assess({
      confirmations: [{ customerId: 'C001', method: 'customer_stated_their_own_figure', confirmedOn: '2026-08-20' }],
    });
    expect(r.refusedBecause).toBe('confirmation_carries_no_figure');
    expect(r.detail).toContain('counts as agreement everywhere it is read');
  });

  it('accepts a customer who remembers what they did but not the total', () => {
    // Honest, useful, and explicitly not agreement about the number.
    const r = assess({
      confirmations: [{
        customerId: 'C001', method: 'customer_confirmed_recent_activity',
        activityConfirmed: 'redeemed against a gas cylinder in June', confirmedOn: '2026-08-20',
      }],
      asked: ['C001'],
    });
    expect(r.accepted).toBe(true);
    expect(r.checks[0]?.finding).toBe('could_not_say');
    expect(r.checks[0]?.detail).toContain('That is honest and it is not agreement');
  });
});

describe('the loud direction is not the dangerous one', () => {
  it('counts the two directions separately and never nets them', () => {
    // 500 short on one customer and 500 over on another is two problems. Offset, it is a
    // reassuring zero and both survive into the opening books.
    const r = assess({
      confirmations: [
        confirm('C001', 12_500), // we migrated 500 fewer than they believe
        confirm('C002', 8_900),  // we migrated 500 more than they believe
        confirm('C003', 5_100), confirm('C004', 4_950),
      ],
    });
    expect(r.weMigratedFewerPoints).toBe(500);
    expect(r.weMigratedMorePoints).toBe(500);
    expect(r.sufficientToVerify).toBe(false);
    expect(r.detail).toContain('offsetting them turns two problems into none');
  });

  it('puts the SILENT direction at the top of the list and in the owner action', () => {
    const r = assess({
      confirmations: [
        confirm('C001', 14_000), // 2,000 short — loud, and larger
        confirm('C002', 8_900),  // 500 over — silent, and smaller
        confirm('C003', 5_100), confirm('C004', 4_950),
      ],
    });
    // Larger by value, but the one that will be reported to the owner at the till within a week.
    expect(r.checks[0]?.customerId).toBe('C002');
    expect(r.checks[0]?.finding).toBe('we_migrated_more');
    expect(r.ownerAction).toContain('will not be reported to you at all');
  });

  it('values the silent side at what a redeemed point actually costs', () => {
    const r = assess({
      confirmations: [confirm('C001', 11_000), confirm('C002', 9_400), confirm('C003', 5_100), confirm('C004', 4_950)],
    });
    expect(r.weMigratedMorePoints).toBe(1_000);
    expect(r.silentLiabilityMinor).toBe(25_000); // 1,000 points at 25 paise of goods
  });

  it('says the shortfalls will be reported and the overs will not', () => {
    const r = assess({
      confirmations: [confirm('C001', 12_500), confirm('C002', 9_400), confirm('C003', 5_100), confirm('C004', 4_950)],
    });
    expect(r.weMigratedFewerPoints).toBe(500);
    expect(r.ownerAction).toContain('at the counter with a queue behind them');
  });

  it('mentions expiring points, because those customers find out first', () => {
    const r = assess({
      confirmations: [confirm('C001', 12_000), confirm('C002', 9_400), confirm('C003', 5_100), confirm('C004', 5_500)],
    });
    expect(r.checks[0]?.detail).toContain('they have points about to lapse');
  });
});

describe('a tier change is the most visible thing in the migration', () => {
  it('names every customer whose tier moved', () => {
    const r = assess({
      legacyTiers: new Map([['C003', 'gold'], ['C001', 'gold']]),
    });
    expect(r.tierDrops).toHaveLength(1);
    expect(r.tierDrops[0]?.customerName).toBe('Lakshmi V');
    expect(r.tierDrops[0]?.detail).toContain('taken far more personally');
    expect(r.ownerAction).toContain('hold everybody at their old tier for a period');
  });

  it('blocks verification on a tier change even when the points agree', () => {
    const r = assess({ legacyTiers: new Map([['C003', 'gold']]) });
    expect(r.checks.every((c) => c.finding === 'agrees')).toBe(true);
    expect(r.sufficientToVerify).toBe(false);
  });
});

describe('silence is not agreement', () => {
  it('NAMES a customer who was asked and never answered', () => {
    const r = assess({
      confirmations: [confirm('C001', 12_000)],
      asked: ['C001', 'C002', 'C003'],
    });
    expect(r.noAnswer).toEqual(['C002', 'C003']);
    expect(r.sufficientToVerify).toBe(false);
    expect(r.ownerAction).toContain('has not agreed with us');
  });

  it('is satisfied only when everyone asked confirmed and no tier moved', () => {
    const r = assess();
    expect(r.sufficientToVerify).toBe(true);
    expect(r.ownerAction).toBe('nothing — the customers confirm their own balances');
    expect(r.detail).toContain("the customers' own figures");
  });

  it('lets the owner set a points tolerance', () => {
    const r = assess({
      confirmations: [confirm('C001', 12_010), confirm('C002', 9_400), confirm('C003', 5_100), confirm('C004', 4_950)],
      tolerancePoints: 50,
    });
    expect(r.sufficientToVerify).toBe(true);
  });
});

describe('what the customers cannot prove', () => {
  it('states that confirming a balance is not confirming it was earned', () => {
    // Award double points by mistake for a year and every customer confirms the wrong figure
    // cheerfully. Typed as the literal false so it cannot drift.
    const proves: false = assess().provesTheBalanceWasEarned;
    expect(proves).toBe(false);
  });
});
