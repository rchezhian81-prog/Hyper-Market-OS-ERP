// Proving the old system's sales against the bank — MG-06, OB-06, §34.
//
// The third external check, and the hardest of the six. The bank has no interest in agreeing with
// our old ERP, which is exactly what makes it evidence.
//
// Two packages already reconcile money in the **running** system and neither answers this:
//
//   • `packages/reconciliation` matches a tender to a settlement line on a shared provider
//     reference. For the historic period there are no references — the old system's reports give
//     a daily total per tender, and that is all.
//   • `packages/settlement` checks the provider's own file, where gross, fees and net are all
//     declared and the arithmetic can be verified against itself. For the historic period there
//     is no provider file either.
//
// So the route has to be **reconstructed** rather than compared, and reconstructing it is where
// the check earns its keep — because **gross sales never equal a bank line**, and everyone knows
// it. Cash reaches the bank in lumps, days later, after the float and the petty cash are taken
// out. Card arrives net of commission and the GST on the commission. UPI arrives gross, on its
// own cycle. Compare the two totals directly and you are permanently, explicably short — and
// **an explicable difference you see every day is the perfect hiding place for a real one.**
//
// Three rules this module will not bend:
//
//   • **A COMMISSION RATE IS DECLARED, NEVER DERIVED.** Computing the rate as
//     `(gross − banked) / gross` makes every shortfall commission **by definition**: the
//     reconciliation then agrees perfectly, at any figure, and has proved nothing at all. It is
//     the same failure as verifying a total against the system it came from, which
//     `extraction.ts` already refuses by name — so this refuses it by name too. The rate comes
//     off the merchant agreement, the provider's advice or the bank's confirmation.
//   • **CASH IS THE DANGEROUS DIRECTION.** Card and UPI move themselves; nobody carries them.
//     Cash is the only tender a person physically holds between the till and the bank, and unlike
//     a supplier balance **there is no counterparty who will ever chase it.** Nothing else in the
//     migration has that shape, so it is reported on its own figure and never merged into a
//     tender total.
//   • **AN UNEXPLAINED CREDIT IS NOT GOOD NEWS.** Money arriving with no sale behind it is
//     usually somebody else's — a mis-posted transfer that will be reversed. Migrated as revenue
//     it overstates turnover and the tax due on it, and the correction lands after the return is
//     filed. It is an exception, in the same list as money that failed to arrive.
//
// Pure and deterministic: no I/O, no clock beyond the dates supplied. Money is integer minor
// units throughout (§29.1).

/** How the money travelled from the till to the bank. */
export type TenderRoute = 'cash' | 'card' | 'upi' | 'other';

/**
 * Where the commission and settlement terms came from.
 *
 * `derived_from_the_difference` is listed **so it can be refused**. A rate reverse-engineered
 * from the gap it is meant to explain is not evidence; it is the gap wearing a name.
 */
export type TermsSource =
  | 'merchant_agreement'
  | 'provider_advice'
  | 'bank_confirmation'
  | 'derived_from_the_difference';

export interface RouteTerms {
  readonly tender: TenderRoute;
  /** Provider commission in basis points of gross. Cash and UPI are normally zero. */
  readonly commissionBps: number;
  /** GST charged ON the commission, in basis points of the commission (18% = 1800). */
  readonly gstOnCommissionBps: number;
  /** Days from the sale to the bank credit. */
  readonly settlementLagDays: number;
  /** How far either side of the expected date a credit may still be that day's money. */
  readonly toleranceDays: number;
  readonly source: TermsSource;
}

export interface DailyTakings {
  readonly businessDate: string;
  readonly tender: TenderRoute;
  /** What the old system says was taken, before any commission. */
  readonly grossMinor: number;
}

export interface BankCredit {
  readonly lineId: string;
  /** The date the bank gave value, not the date it was paid in. */
  readonly valueDate: string;
  readonly amountMinor: number;
  readonly narrative: string;
  /**
   * Which route this credit belongs to, read off the narrative by a person.
   *
   * `unattributed` is a first-class answer and the honest one for a line nobody recognises. It is
   * never quietly counted as sales.
   */
  readonly attributedTo: TenderRoute | 'unattributed';
}

export type TermsRefusal =
  | 'commission_derived_from_the_difference'
  | 'no_terms_for_a_tender_that_was_taken'
  | 'commission_on_cash';

export interface TermsAcceptance {
  readonly ok: boolean;
  readonly refusedBecause?: TermsRefusal;
  readonly detail: string;
}

/**
 * Check the settlement terms before any figure is compared.
 *
 * A separate callable, run first and on its own, so a caller cannot reach the arithmetic without
 * passing it — the same shape as `assertNonProduction` in `trial.ts`.
 */
export function acceptRouteTerms(
  terms: readonly RouteTerms[],
  tendersTaken: readonly TenderRoute[] = [],
): TermsAcceptance {
  for (const t of terms) {
    if (t.source === 'derived_from_the_difference') {
      return {
        ok: false,
        refusedBecause: 'commission_derived_from_the_difference',
        detail: `the ${t.tender} commission was worked out from the gap between sales and the bank. That makes every shortfall commission by definition — the reconciliation then agrees perfectly at any figure and proves nothing. Take the rate off the merchant agreement, the provider's advice or the bank's confirmation`,
      };
    }
    if (t.tender === 'cash' && (t.commissionBps > 0 || t.gstOnCommissionBps > 0)) {
      return {
        ok: false,
        refusedBecause: 'commission_on_cash',
        detail: 'cash carries no provider commission. A rate here is a deduction being made to fit, and it would absorb exactly the difference the cash check exists to find',
      };
    }
  }

  const covered = new Set(terms.map((t) => t.tender));
  const missing = [...new Set(tendersTaken)].filter((t) => !covered.has(t)).sort();
  if (missing.length > 0) {
    return {
      ok: false,
      refusedBecause: 'no_terms_for_a_tender_that_was_taken',
      detail: `no settlement terms for ${missing.join(', ')}, and money was taken on ${missing.length === 1 ? 'it' : 'them'}. Assuming a lag and a zero commission would turn an unknown into a clean result`,
    };
  }

  return { ok: true, detail: `terms accepted for ${[...covered].sort().join(', ')}, all declared from outside the difference they explain` };
}

/** Basis points of an amount, rounded to the nearest minor unit. Integers only (§29.1). */
export const bpsOf = (amountMinor: number, bps: number): number =>
  Math.round((amountMinor * bps) / 10_000);

/**
 * What should reach the bank for a given gross, under declared terms.
 *
 * Stated as its own function because the commission is a **stated expectation**, not a residual.
 * A card batch arriving short by exactly this is agreed; short by anything else is not.
 */
export function expectedCredit(grossMinor: number, terms: RouteTerms): {
  readonly commissionMinor: number;
  readonly gstOnCommissionMinor: number;
  readonly creditMinor: number;
} {
  const commissionMinor = bpsOf(grossMinor, terms.commissionBps);
  const gstOnCommissionMinor = bpsOf(commissionMinor, terms.gstOnCommissionBps);
  return {
    commissionMinor,
    gstOnCommissionMinor,
    creditMinor: grossMinor - commissionMinor - gstOnCommissionMinor,
  };
}

export interface UnbankedDay {
  readonly businessDate: string;
  readonly tender: TenderRoute;
  readonly grossMinor: number;
  readonly expectedCreditMinor: number;
  readonly detail: string;
}

export interface RouteResult {
  readonly tender: TenderRoute;
  readonly grossMinor: number;
  /** The expected deduction, stated rather than discovered. */
  readonly commissionExpectedMinor: number;
  readonly expectedCreditMinor: number;
  readonly bankedMinor: number;
  /** banked − expected. Negative means money did not arrive. */
  readonly differenceMinor: number;
  readonly matchedDays: number;
  readonly unbankedDays: number;
  readonly detail: string;
}

export interface BankVerification {
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly termsAccepted: boolean;
  readonly refusedBecause?: TermsRefusal;
  readonly routes: readonly RouteResult[];
  /** Non-cash days whose credit never arrived, named by date. */
  readonly unbanked: readonly UnbankedDay[];
  /** Bank credits with no sale behind them. Never counted as revenue. */
  readonly unexplainedCredits: readonly BankCredit[];
  readonly unexplainedCreditsMinor: number;
  /** Cash taken and not lodged over the period. **The dangerous one.** */
  readonly cashNotBankedMinor: number;
  /** The most cash standing unlodged at any point — a security figure as well as an accounting one. */
  readonly cashRetainedPeakMinor: number;
  /** Whether the statement spans the takings period AND long enough after it for the last day to land. */
  readonly statementCoversPeriod: boolean;
  readonly sufficientToVerify: boolean;
  /** Typed as the literal `false`: the bank proves what arrived, never what was sold. */
  readonly provesSalesWereComplete: false;
  readonly detail: string;
  readonly ownerAction: string;
}

const asDayNumber = (d: string): number => {
  const [y = 0, m = 1, day = 1] = d.slice(0, 10).split('-').map(Number);
  return Date.UTC(y, m - 1, day) / 86_400_000;
};

const daysBetween = (from: string, to: string): number => asDayNumber(to) - asDayNumber(from);

/** ISO date `n` days after `from`. No clock, no timezone. */
function addDays(from: string, n: number): string {
  return new Date((asDayNumber(from) + n) * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Verify the old system's daily takings against the bank statement.
 *
 * Non-cash tenders are matched day by day: one day's expected credit against one bank line, within
 * the declared lag and tolerance. Cash is **not** matched day by day, because it is not banked
 * that way — lodgements are lumpy by design, and a day-against-day comparison of lumpy money
 * manufactures a page of differences that all resolve to "it went in on Friday". Cash is compared
 * over the period, and what did not arrive is reported as one figure with the peak beside it.
 */
export function verifySalesAgainstBank(input: {
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly takings: readonly DailyTakings[];
  readonly credits: readonly BankCredit[];
  readonly terms: readonly RouteTerms[];
  /**
   * The period the statement itself declares, read off its header.
   *
   * Taken as an input rather than inferred from the first and last credit, because inferring it
   * asks the file whether the file is complete — and a statement that stops halfway through
   * always looks complete by its own contents. `completeness.ts` refuses the same move.
   */
  readonly statementPeriod: { readonly from: string; readonly to: string };
  /** Difference at or below which a route need not block. Per-tenant. */
  readonly toleranceMinor?: number;
}): BankVerification {
  const tolerance = input.toleranceMinor ?? 0;
  // Every tender PRESENT in the takings, including one sitting at nil. A nil line still means the
  // old system has that tender, and treating a zero as "no terms needed" invents a lag and a zero
  // commission for it — which is the very substitution `no_terms_for_a_tender_that_was_taken`
  // exists to refuse. It is also what keeps the route loop below safe to dereference.
  const tendersTaken = input.takings.map((t) => t.tender);
  const acceptance = acceptRouteTerms(input.terms, tendersTaken);

  const empty = (detail: string, refusedBecause?: TermsRefusal): BankVerification => ({
    periodStart: input.periodStart, periodEnd: input.periodEnd,
    termsAccepted: false, ...(refusedBecause === undefined ? {} : { refusedBecause }),
    routes: [], unbanked: [], unexplainedCredits: [], unexplainedCreditsMinor: 0,
    cashNotBankedMinor: 0, cashRetainedPeakMinor: 0, statementCoversPeriod: false,
    sufficientToVerify: false, provesSalesWereComplete: false,
    detail, ownerAction: detail,
  });

  if (!acceptance.ok) {
    return empty(acceptance.detail, acceptance.refusedBecause);
  }

  const termsFor = new Map(input.terms.map((t) => [t.tender, t]));

  // A statement that stops halfway through the period explains a shortfall all by itself, and
  // would otherwise be read as missing money. Checked before any arithmetic.
  //
  // It must also run PAST the period end: the last day's card batch lands after the last day's
  // sale, so a statement ending exactly on the period end is missing the money it is meant to
  // prove — and does so while looking like a perfectly matched pair of dates.
  const settlementTail = Math.max(0, ...input.terms.map((t) => t.settlementLagDays + t.toleranceDays));
  const mustReach = addDays(input.periodEnd, settlementTail);
  const statementCoversPeriod = input.statementPeriod.from <= input.periodStart
    && input.statementPeriod.to >= mustReach;

  const usedCredits = new Set<string>();
  const unbanked: UnbankedDay[] = [];
  const routes: RouteResult[] = [];

  const byTender = new Map<TenderRoute, DailyTakings[]>();
  for (const t of input.takings) {
    const list = byTender.get(t.tender);
    if (list === undefined) byTender.set(t.tender, [t]);
    else list.push(t);
  }

  const creditsByTender = (tender: TenderRoute): BankCredit[] =>
    input.credits.filter((c) => c.attributedTo === tender);

  for (const tender of [...byTender.keys()].sort()) {
    const days = [...(byTender.get(tender) ?? [])].sort((a, b) => (a.businessDate < b.businessDate ? -1 : 1));
    // Safe: `acceptRouteTerms` above refused unless every tender in the takings has terms.
    const terms = termsFor.get(tender)!;
    const available = creditsByTender(tender);

    let grossMinor = 0;
    let commissionExpectedMinor = 0;
    let expectedCreditMinor = 0;
    let matchedDays = 0;

    for (const day of days) {
      const e = expectedCredit(day.grossMinor, terms);
      grossMinor += day.grossMinor;
      commissionExpectedMinor += e.commissionMinor + e.gstOnCommissionMinor;
      expectedCreditMinor += e.creditMinor;

      // Cash is deliberately not matched day by day — see the doc comment.
      if (tender === 'cash' || day.grossMinor === 0) continue;

      const hit = available.find((c) => !usedCredits.has(c.lineId)
        && c.amountMinor === e.creditMinor
        && Math.abs(daysBetween(day.businessDate, c.valueDate) - terms.settlementLagDays) <= terms.toleranceDays);

      if (hit === undefined) {
        unbanked.push({
          businessDate: day.businessDate, tender, grossMinor: day.grossMinor,
          expectedCreditMinor: e.creditMinor,
          detail: `${day.businessDate}: ${day.grossMinor} taken on ${tender}, ${e.creditMinor} should have reached the bank around ${terms.settlementLagDays} day(s) later, and no credit of that amount did`,
        });
      } else {
        usedCredits.add(hit.lineId);
        matchedDays += 1;
      }
    }

    const bankedMinor = tender === 'cash'
      ? available.reduce((t, c) => t + c.amountMinor, 0)
      : available.filter((c) => usedCredits.has(c.lineId)).reduce((t, c) => t + c.amountMinor, 0);

    routes.push({
      tender, grossMinor, commissionExpectedMinor, expectedCreditMinor, bankedMinor,
      differenceMinor: bankedMinor - expectedCreditMinor,
      matchedDays,
      // Zero for cash, and not because every day balanced: cash is never matched to a day, so a
      // count of unmatched days would report every trading day as a failure.
      unbankedDays: tender === 'cash' ? 0 : days.filter((d) => d.grossMinor !== 0).length - matchedDays,
      detail: tender === 'cash'
        ? `${grossMinor} taken in cash over the period, ${bankedMinor} lodged. Compared over the period rather than day by day, because lodgements are lumpy on purpose`
        : commissionExpectedMinor > 0
          ? `${grossMinor} taken on ${tender}, less ${commissionExpectedMinor} of commission and GST declared from the ${terms.source.replace(/_/g, ' ')}, so ${expectedCreditMinor} was due at the bank`
          : `${grossMinor} taken on ${tender}, settling gross at ${expectedCreditMinor}`,
    });
  }

  // Cash: over the period, with the peak alongside. The peak says how much was standing in the
  // shop at worst, which is a security question as much as an accounting one.
  const cashTakings = [...(byTender.get('cash') ?? [])];
  const cashCredits = creditsByTender('cash');
  const cashNotBankedMinor = cashTakings.reduce((t, d) => t + d.grossMinor, 0)
    - cashCredits.reduce((t, c) => t + c.amountMinor, 0);

  const cashEvents = [
    ...cashTakings.map((d) => ({ date: d.businessDate, delta: d.grossMinor })),
    ...cashCredits.map((c) => ({ date: c.valueDate, delta: -c.amountMinor })),
  ].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.delta - b.delta));

  let running = 0;
  let cashRetainedPeakMinor = 0;
  for (const e of cashEvents) {
    running += e.delta;
    if (running > cashRetainedPeakMinor) cashRetainedPeakMinor = running;
  }

  const unexplainedCredits = input.credits
    .filter((c) => c.attributedTo === 'unattributed')
    .sort((a, b) => b.amountMinor - a.amountMinor);
  const unexplainedCreditsMinor = unexplainedCredits.reduce((t, c) => t + c.amountMinor, 0);

  const worstRoute = [...routes].sort((a, b) => Math.abs(b.differenceMinor) - Math.abs(a.differenceMinor))[0];

  const sufficientToVerify = statementCoversPeriod
    && unbanked.length === 0
    && unexplainedCredits.length === 0
    && Math.abs(cashNotBankedMinor) <= tolerance
    && routes.every((r) => Math.abs(r.differenceMinor) <= tolerance);

  return {
    periodStart: input.periodStart, periodEnd: input.periodEnd,
    termsAccepted: true,
    routes,
    unbanked: [...unbanked].sort((a, b) => b.expectedCreditMinor - a.expectedCreditMinor),
    unexplainedCredits, unexplainedCreditsMinor,
    cashNotBankedMinor, cashRetainedPeakMinor,
    statementCoversPeriod,
    sufficientToVerify,
    // The bank sees what arrived. A sale rung up and pocketed at the till never reaches either
    // side of this comparison, and the two agree perfectly about it.
    provesSalesWereComplete: false,
    detail: sufficientToVerify
      ? `every day's takings reached the bank, allowing for ${routes.reduce((t, r) => t + r.commissionExpectedMinor, 0)} of declared commission — the sales in the opening books are the bank's figures, not the old system's`
      : !statementCoversPeriod
        ? `the statement does not span ${input.periodStart} to ${input.periodEnd}. A part-period statement explains a shortfall by itself, and reading it as missing money would send people looking for something that is not gone`
        : `${unbanked.length} day(s) with no matching credit, ${unexplainedCreditsMinor} of credits with no sale behind them, ${cashNotBankedMinor} of cash taken and not lodged. Worst route: ${worstRoute?.tender ?? 'none'} at ${worstRoute?.differenceMinor ?? 0}`,
    ownerAction: !statementCoversPeriod
      ? 'get the statement for the whole period from the bank before anything else — the rest of this check cannot mean anything until it spans the same dates as the sales'
      : cashNotBankedMinor > tolerance
        ? `${cashNotBankedMinor} of cash was taken and never lodged, standing at ${cashRetainedPeakMinor} at its worst. Card and UPI move themselves; cash is carried by a person, and no supplier or bank will ever chase this one. Some of it is float and till change — the rest needs a name against it before the opening books are signed`
        : unexplainedCredits.length > 0
          ? `${unexplainedCreditsMinor} arrived in the bank with no sale behind it. This is not a bonus: money you cannot explain is usually somebody else's and comes back out, and migrated as revenue it overstates turnover and the tax on it`
          : unbanked.length > 0
            ? `${unbanked.length} day(s) of card or UPI takings never reached the bank. Each is listed by date with the amount that was due — the provider can be asked about a specific day, which is the only question they will answer`
            : sufficientToVerify
              ? 'nothing — the bank confirms the sales figures'
              : `the routes are within tolerance but the totals do not tie exactly. The commission is stated at ${routes.reduce((t, r) => t + r.commissionExpectedMinor, 0)}, so the remainder is a real difference and not the fee`,
  };
}
