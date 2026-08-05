import { describe, it, expect } from 'vitest';
import {
  verifySalesAgainstBank, acceptRouteTerms, expectedCredit, bpsOf,
  type RouteTerms, type DailyTakings, type BankCredit,
} from '../../packages/migration/src/banking-verification';

// MG-06, OB-06, §34 — proving the old system's sales against the bank. The bank has no interest
// in agreeing with our old ERP, which is exactly what makes it evidence.

const TERMS: readonly RouteTerms[] = [
  { tender: 'cash', commissionBps: 0, gstOnCommissionBps: 0, settlementLagDays: 2, toleranceDays: 1, source: 'bank_confirmation' },
  { tender: 'card', commissionBps: 150, gstOnCommissionBps: 1_800, settlementLagDays: 1, toleranceDays: 1, source: 'merchant_agreement' },
  { tender: 'upi', commissionBps: 0, gstOnCommissionBps: 0, settlementLagDays: 1, toleranceDays: 1, source: 'provider_advice' },
];

const TAKINGS: readonly DailyTakings[] = [
  { businessDate: '2026-06-01', tender: 'card', grossMinor: 100_000 },
  { businessDate: '2026-06-02', tender: 'card', grossMinor: 200_000 },
  { businessDate: '2026-06-01', tender: 'upi', grossMinor: 50_000 },
  { businessDate: '2026-06-01', tender: 'cash', grossMinor: 80_000 },
  { businessDate: '2026-06-02', tender: 'cash', grossMinor: 60_000 },
];

// 1.5% commission plus 18% GST on it: 100,000 → 1,500 + 270 → 98,230 arrives.
const CREDITS: readonly BankCredit[] = [
  { lineId: 'B1', valueDate: '2026-06-02', amountMinor: 98_230, narrative: 'HDFC MERCHANT SETTLE', attributedTo: 'card' },
  { lineId: 'B2', valueDate: '2026-06-03', amountMinor: 196_460, narrative: 'HDFC MERCHANT SETTLE', attributedTo: 'card' },
  { lineId: 'B3', valueDate: '2026-06-02', amountMinor: 50_000, narrative: 'UPI SETTLEMENT', attributedTo: 'upi' },
  { lineId: 'B4', valueDate: '2026-06-04', amountMinor: 140_000, narrative: 'CASH DEP CHENGALPATTU', attributedTo: 'cash' },
];

const verify = (over: Partial<Parameters<typeof verifySalesAgainstBank>[0]> = {}) =>
  verifySalesAgainstBank({
    periodStart: '2026-06-01', periodEnd: '2026-06-03',
    statementPeriod: { from: '2026-06-01', to: '2026-06-10' },
    takings: TAKINGS, credits: CREDITS, terms: TERMS, ...over,
  });

const route = (r: ReturnType<typeof verify>, tender: string) => r.routes.find((x) => x.tender === tender)!;

describe('a commission rate is declared, never derived', () => {
  it('REFUSES a rate worked out from the gap it is meant to explain', () => {
    const a = acceptRouteTerms([{ ...TERMS[1]!, source: 'derived_from_the_difference' }]);
    expect(a.ok).toBe(false);
    expect(a.refusedBecause).toBe('commission_derived_from_the_difference');
    expect(a.detail).toContain('every shortfall commission by definition');
  });

  it('refuses BEFORE any arithmetic, so no figure is produced to argue about', () => {
    const r = verify({ terms: [TERMS[0]!, { ...TERMS[1]!, source: 'derived_from_the_difference' }, TERMS[2]!] });
    expect(r.termsAccepted).toBe(false);
    expect(r.refusedBecause).toBe('commission_derived_from_the_difference');
    expect(r.routes).toEqual([]);
    expect(r.sufficientToVerify).toBe(false);
  });

  it('shows WHAT the refusal is protecting against: the derived rate reconciles perfectly', () => {
    // 3,00,000 taken on card and only 2,40,000 in the bank — a 60,000 hole. Derive the rate from
    // that gap (20%) and the arithmetic absorbs it exactly: difference zero, nothing to explain.
    const takings: readonly DailyTakings[] = [{ businessDate: '2026-06-01', tender: 'card', grossMinor: 300_000 }];
    const credits: readonly BankCredit[] = [
      { lineId: 'B9', valueDate: '2026-06-02', amountMinor: 240_000, narrative: 'MERCHANT SETTLE', attributedTo: 'card' },
    ];
    const fitted: RouteTerms = {
      tender: 'card', commissionBps: 2_000, gstOnCommissionBps: 0,
      settlementLagDays: 1, toleranceDays: 1, source: 'merchant_agreement',
    };

    const looksClean = verifySalesAgainstBank({
      periodStart: '2026-06-01', periodEnd: '2026-06-01',
      statementPeriod: { from: '2026-06-01', to: '2026-06-10' },
      takings, credits, terms: [fitted],
    });
    expect(looksClean.sufficientToVerify).toBe(true);
    expect(route(looksClean, 'card').differenceMinor).toBe(0); // a 60,000 hole, reconciled

    // The same numbers, honestly sourced, are refused outright.
    const honest = verifySalesAgainstBank({
      periodStart: '2026-06-01', periodEnd: '2026-06-01',
      statementPeriod: { from: '2026-06-01', to: '2026-06-10' },
      takings, credits, terms: [{ ...fitted, source: 'derived_from_the_difference' }],
    });
    expect(honest.termsAccepted).toBe(false);

    // And at the real rate the hole is visible where it belongs.
    const real = verifySalesAgainstBank({
      periodStart: '2026-06-01', periodEnd: '2026-06-01',
      statementPeriod: { from: '2026-06-01', to: '2026-06-10' },
      takings, credits, terms: [{ ...fitted, commissionBps: 150, gstOnCommissionBps: 1_800 }],
    });
    expect(real.unbanked).toHaveLength(1);
    expect(real.sufficientToVerify).toBe(false);
  });

  it('REFUSES a commission on cash, which is a deduction being made to fit', () => {
    const a = acceptRouteTerms([{ ...TERMS[0]!, commissionBps: 50 }]);
    expect(a.ok).toBe(false);
    expect(a.refusedBecause).toBe('commission_on_cash');
    expect(a.detail).toContain('the cash check exists to find');
  });

  it('REFUSES to assume terms for a tender that was actually taken', () => {
    const a = acceptRouteTerms([TERMS[0]!, TERMS[1]!], ['cash', 'card', 'upi']);
    expect(a.ok).toBe(false);
    expect(a.refusedBecause).toBe('no_terms_for_a_tender_that_was_taken');
    expect(a.detail).toContain('turn an unknown into a clean result');
  });

  it('does not demand terms for a tender nothing was taken on', () => {
    expect(acceptRouteTerms([TERMS[0]!], ['cash']).ok).toBe(true);
  });

  it('demands terms for a tender that appears at zero, rather than assuming them', () => {
    // A nil line for a tender still means the old system has that tender. Reading a zero as
    // "no terms needed" invents a lag and a zero commission for it, and the route then reports a
    // clean nothing — the same "turn an unknown into a clean result" this refusal exists to stop.
    const r = verify({
      takings: [{ businessDate: '2026-06-01', tender: 'other', grossMinor: 0 }],
      credits: [], terms: [],
    });
    expect(r.termsAccepted).toBe(false);
    expect(r.refusedBecause).toBe('no_terms_for_a_tender_that_was_taken');
  });
});

describe('the arithmetic is exact, in minor units', () => {
  it('keeps basis points integral — no float anywhere (§29.1)', () => {
    expect(bpsOf(100_000, 150)).toBe(1_500);
    expect(bpsOf(12_345, 150)).toBe(185); // 185.175 → 185
    expect(Number.isInteger(bpsOf(999_999, 137))).toBe(true);
  });

  it('states the commission and the GST on it as their own figures', () => {
    const e = expectedCredit(100_000, TERMS[1]!);
    expect(e.commissionMinor).toBe(1_500);
    expect(e.gstOnCommissionMinor).toBe(270);
    expect(e.creditMinor).toBe(98_230);
    expect(e.commissionMinor + e.gstOnCommissionMinor + e.creditMinor).toBe(100_000);
  });
});

describe('a clean period', () => {
  const r = verify();

  it('ties every route once the declared commission is allowed for', () => {
    expect(r.termsAccepted).toBe(true);
    expect(route(r, 'card').differenceMinor).toBe(0);
    expect(route(r, 'upi').differenceMinor).toBe(0);
    expect(r.unbanked).toEqual([]);
    expect(r.sufficientToVerify).toBe(true);
    expect(r.detail).toContain('the bank\'s figures, not the old system\'s');
  });

  it('reports the commission as an expected deduction rather than a difference', () => {
    // Compared gross to bank, this shop is short 5,310 every period and learns to ignore it.
    // Stated up front, the remainder is a real difference and nobody is trained to look away.
    const card = route(r, 'card');
    expect(card.commissionExpectedMinor).toBe(1_500 + 270 + 3_000 + 540);
    expect(card.grossMinor - card.commissionExpectedMinor).toBe(card.expectedCreditMinor);
    expect(card.detail).toContain('declared from the merchant agreement');
  });

  it('does not match cash day by day, because it is not banked that way', () => {
    // One lodgement of 1,40,000 covers two days' takings. Matched day-against-day this is two
    // failures that both resolve to "it went in on Thursday".
    const cash = route(r, 'cash');
    expect(cash.unbankedDays).toBe(0);
    expect(cash.differenceMinor).toBe(0);
    expect(cash.detail).toContain('lodgements are lumpy on purpose');
    expect(r.cashNotBankedMinor).toBe(0);
  });

  it('still reports the peak cash standing unlodged, which is a security figure too', () => {
    expect(r.cashRetainedPeakMinor).toBe(140_000);
  });

  it('spends each bank credit once', () => {
    // Two identical days and one credit is one day banked and one day not — never one credit
    // counted twice into a total that then agrees.
    const twice = verify({
      takings: [
        { businessDate: '2026-06-01', tender: 'card', grossMinor: 100_000 },
        { businessDate: '2026-06-02', tender: 'card', grossMinor: 100_000 },
      ],
      credits: [{ lineId: 'B1', valueDate: '2026-06-02', amountMinor: 98_230, narrative: 'SETTLE', attributedTo: 'card' }],
      terms: [TERMS[1]!],
    });
    expect(route(twice, 'card').matchedDays).toBe(1);
    expect(twice.unbanked).toHaveLength(1);
    expect(twice.unbanked[0]?.businessDate).toBe('2026-06-02');
  });
});

describe('cash is the dangerous direction', () => {
  it('reports cash taken and never lodged on its own figure', () => {
    const r = verify({
      credits: CREDITS.map((c) => (c.lineId === 'B4' ? { ...c, amountMinor: 100_000 } : c)),
    });
    expect(r.cashNotBankedMinor).toBe(40_000);
    expect(r.sufficientToVerify).toBe(false);
    // Nothing else in the migration has this shape, and the owner action says why.
    expect(r.ownerAction).toContain('no supplier or bank will ever chase this one');
    expect(r.ownerAction).toContain('needs a name against it before the opening books are signed');
  });

  it('does not let a healthy card route absorb it', () => {
    const r = verify({
      credits: CREDITS.map((c) => (c.lineId === 'B4' ? { ...c, amountMinor: 100_000 } : c)),
    });
    expect(route(r, 'card').differenceMinor).toBe(0);
    expect(route(r, 'cash').differenceMinor).toBe(-40_000);
    // Separate figures. A single "total difference" of −40,000 across a period would be read as
    // rounding and cleared.
    expect(r.cashNotBankedMinor).toBe(40_000);
  });

  it('lets the owner set a tolerance, because the float and the till change are real', () => {
    const r = verify({
      credits: CREDITS.map((c) => (c.lineId === 'B4' ? { ...c, amountMinor: 130_000 } : c)),
      toleranceMinor: 15_000,
    });
    expect(r.cashNotBankedMinor).toBe(10_000);
    expect(r.sufficientToVerify).toBe(true);
  });
});

describe('an unexplained credit is not good news', () => {
  const r = verify({
    credits: [...CREDITS, { lineId: 'B5', valueDate: '2026-06-03', amountMinor: 500_000, narrative: 'NEFT INWARD REF 88213', attributedTo: 'unattributed' }],
  });

  it('treats money with no sale behind it as an exception, not a bonus', () => {
    expect(r.unexplainedCredits).toHaveLength(1);
    expect(r.unexplainedCreditsMinor).toBe(500_000);
    expect(r.sufficientToVerify).toBe(false);
  });

  it('never counts it into a route total', () => {
    // 5,00,000 of somebody else's money must not make the card route look better than it is.
    expect(r.routes.reduce((t, x) => t + x.bankedMinor, 0))
      .toBe(verify().routes.reduce((t, x) => t + x.bankedMinor, 0));
  });

  it('says why it matters, in the owner\'s terms', () => {
    const clean = verify({
      credits: CREDITS.map((c) => c).concat([{ lineId: 'B5', valueDate: '2026-06-03', amountMinor: 500_000, narrative: 'NEFT INWARD', attributedTo: 'unattributed' }]),
    });
    expect(clean.ownerAction).toContain('overstates turnover and the tax on it');
  });
});

describe('the statement has to cover the period, and a bit past it', () => {
  it('refuses a part-period statement before reading anything into the shortfall', () => {
    const r = verify({ statementPeriod: { from: '2026-06-02', to: '2026-06-10' } });
    expect(r.statementCoversPeriod).toBe(false);
    expect(r.sufficientToVerify).toBe(false);
    expect(r.ownerAction).toContain('get the statement for the whole period');
  });

  it('catches the statement that ends exactly on the last trading day', () => {
    // The subtle one: the dates look like a perfectly matched pair, and the last day's card batch
    // settles after the statement stops — so the money it exists to prove is not in it.
    const r = verify({ statementPeriod: { from: '2026-06-01', to: '2026-06-03' } });
    expect(r.statementCoversPeriod).toBe(false);
    expect(r.detail).toContain('send people looking for something that is not gone');
  });

  it('accepts one that runs past the longest settlement lag', () => {
    expect(verify({ statementPeriod: { from: '2026-06-01', to: '2026-06-06' } }).statementCoversPeriod).toBe(true);
  });

  it('takes the span from the statement header, not from the lines in it', () => {
    // Asking the file whether the file is complete: a statement that stops halfway always looks
    // complete by its own contents. `completeness.ts` refuses the same move.
    const noLines = verify({ credits: [], statementPeriod: { from: '2026-06-01', to: '2026-06-10' } });
    expect(noLines.statementCoversPeriod).toBe(true);
    expect(noLines.sufficientToVerify).toBe(false); // nothing arrived, and that is the finding
  });
});

describe('what the bank cannot prove', () => {
  it('states that it never shows sales were complete', () => {
    // A sale rung up and pocketed at the till reaches neither the old system nor the bank, and
    // the two agree perfectly about it. Typed as the literal false so it cannot drift to true.
    const proves: false = verify().provesSalesWereComplete;
    expect(proves).toBe(false);
  });

  it('names every day that never reached the bank, worst first', () => {
    const r = verify({
      credits: CREDITS.filter((c) => c.lineId !== 'B2'),
    });
    expect(r.unbanked).toHaveLength(1);
    expect(r.unbanked[0]?.businessDate).toBe('2026-06-02');
    expect(r.unbanked[0]?.expectedCreditMinor).toBe(196_460);
    // A named day is a question the provider will answer; "the card route is short" is not.
    expect(r.ownerAction).toContain('which is the only question they will answer');
  });
});
