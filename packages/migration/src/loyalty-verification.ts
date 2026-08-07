// Proving migrated loyalty balances against the customers themselves — MG-06, OB-06, §34.
//
// The sixth and last external check, and the odd one out. Every other domain is proved against a
// record somebody else keeps for their own reasons — a bank, a supplier, the department, the CA.
// **Here no such record exists.** A point balance lives in one place, and the only witness to
// whether it is right is the customer, one at a time.
//
// Which makes the sampling everything, and makes two facts about customers decisive:
//
//   • **THE FEEDBACK IS ASYMMETRIC, SO COMPLAINTS ARE A USELESS SAMPLE.** A customer whose points
//     went DOWN complains, loudly and on day one. A customer whose points went UP says nothing,
//     ever. So a "sample" drawn from the complaint list is 100% shortfalls by construction, and it
//     will confirm — with real evidence, from real customers — a migration that is systematically
//     over-crediting. The sample has to be drawn before anybody complains.
//
//   • **THE LOUD DIRECTION IS NOT THE DANGEROUS ONE.** Understated points are visible, immediate
//     and expensive in trust: the customer is at the till on day one saying so. That is bad, and
//     it is self-correcting, because a problem that generates complaints gets fixed. **Overstated
//     points are silent, permanent and cost real money** — they are a liability redeemed for goods
//     at our cost, nobody ever chases them, and they are never discovered. Everywhere else in this
//     migration the quiet direction is the one that hurts; here it is the same, and the noise from
//     the other direction is what conceals it.
//
// The control the check stands on is the one the stock count already uses, for the same reason:
// **do not show the customer the balance.** Asked *"is your balance 450 points?"* almost anybody
// says yes — nobody carries their points total in their head, and the question measures
// agreeableness rather than the balance. So a confirmation obtained that way is refused by name,
// and what is accepted instead is the customer stating their own figure, or confirming the recent
// activity they actually remember.
//
// Pure and deterministic: no I/O, no clock beyond the dates supplied.

export interface LoyaltyBalance {
  readonly customerId: string;
  readonly customerName: string;
  readonly pointsBalance: number;
  readonly tier?: string;
  readonly lastActivityDate?: string;
  /** Points due to lapse soon. These customers find out fastest, whichever way the error went. */
  readonly pointsExpiringSoon?: number;
}

/**
 * How a customer's balance was confirmed.
 *
 * `customer_shown_the_balance_and_agreed` is listed **so it can be refused**. It is the loyalty
 * equivalent of printing "expected: 40" on a stock count sheet.
 */
export type ConfirmationMethod =
  | 'customer_stated_their_own_figure'
  | 'customer_confirmed_recent_activity'
  | 'customer_shown_the_balance_and_agreed';

export interface CustomerConfirmation {
  readonly customerId: string;
  readonly method: ConfirmationMethod;
  /** Required for `customer_stated_their_own_figure`. */
  readonly statedPoints?: number;
  /** Required for `customer_confirmed_recent_activity` — what they actually remembered. */
  readonly activityConfirmed?: string;
  readonly confirmedOn: string;
}

export type SampleSource = 'drawn_before_anybody_was_told' | 'drawn_from_complaints';

export type SampleRefusal =
  | 'drawn_from_complaints'
  | 'chosen_by_the_extractor'
  | 'sample_too_small';

export type Stratum = 'largest_balances' | 'tier_boundary' | 'sampled' | 'not_checked';

export interface SampleLine {
  readonly customerId: string;
  readonly customerName: string;
  readonly stratum: Stratum;
  /**
   * Typed as the literal `false`. The balance never reaches the person doing the asking, so it
   * cannot reach the customer — asked *"is it 450?"*, almost anybody says yes.
   */
  readonly balanceShownToTheCustomer: false;
  readonly ask: string;
}

export interface LoyaltySamplePlan {
  readonly planId: string;
  readonly lines: readonly SampleLine[];
  readonly censusCustomers: number;
  readonly tierBoundaryCustomers: number;
  readonly sampledCustomers: number;
  readonly notCheckedCustomers: number;
  /** Share of all outstanding points sitting in the customers being asked, in basis points. */
  readonly pointsCoverageBps: number;
  readonly detail: string;
}

export interface SamplePlanResult {
  readonly ok: boolean;
  readonly plan?: LoyaltySamplePlan;
  readonly refusedBecause?: SampleRefusal;
  readonly detail: string;
}

/** A seeded, reproducible draw. An audit must be able to ask why THIS customer was chosen. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Plan which customers get asked.
 *
 * Three strata, each for a stated reason. The **largest balances**, because those are the points
 * that cost money if they are wrong. The **tier boundaries**, because a customer who drops a tier
 * notices something far more visible than a point total and takes it far more personally. And a
 * thin **random slice of everybody else**, because the first two are exactly the customers a
 * careful operator would have got right.
 */
export function planLoyaltySample(input: {
  readonly planId: string;
  readonly balances: readonly LoyaltyBalance[];
  readonly plannedBy: string;
  readonly extractionOperator: string;
  readonly source: SampleSource;
  /** Points-value share the largest-balance census should cover. Default 60%. */
  readonly censusPointsTargetBps?: number;
  /** Rate at which the remainder is sampled. Default 5%. */
  readonly tailSampleRateBps?: number;
  /** A customer within this many points of a tier threshold is asked. Default 0 (off). */
  readonly tierBoundaryWindow?: number;
  readonly tierThresholds?: readonly number[];
  readonly seed: number;
}): SamplePlanResult {
  if (input.source === 'drawn_from_complaints') {
    return {
      ok: false,
      refusedBecause: 'drawn_from_complaints',
      detail: 'a sample drawn from the customers who complained is every customer whose points went DOWN and no customer whose points went up — 100% shortfalls by construction. It will confirm, with real evidence from real customers, a migration that is quietly over-crediting everybody',
    };
  }

  if (input.plannedBy === input.extractionOperator) {
    return {
      ok: false,
      refusedBecause: 'chosen_by_the_extractor',
      detail: 'the person who ran the extraction cannot choose which customers get asked. Not dishonesty — the accounts somebody is confident about are the accounts they pick, and that is what confidence does (§28)',
    };
  }

  const censusTarget = input.censusPointsTargetBps ?? 6_000;
  const tailRate = input.tailSampleRateBps ?? 500;
  const window = input.tierBoundaryWindow ?? 0;
  const thresholds = input.tierThresholds ?? [];

  const totalPoints = input.balances.reduce((t, b) => t + b.pointsBalance, 0);
  const byValue = [...input.balances].sort((a, b) => b.pointsBalance - a.pointsBalance
    || (a.customerId < b.customerId ? -1 : 1));

  const chosen = new Map<string, Stratum>();
  let covered = 0;
  for (const b of byValue) {
    if (totalPoints > 0 && (covered * 10_000) / totalPoints >= censusTarget) break;
    chosen.set(b.customerId, 'largest_balances');
    covered += b.pointsBalance;
  }

  // A customer sitting just either side of a tier threshold. A tier is visible on every receipt
  // and in the app; a point total is not, so this is where a small error becomes a loud one.
  if (window > 0 && thresholds.length > 0) {
    for (const b of input.balances) {
      if (chosen.has(b.customerId)) continue;
      if (thresholds.some((t) => Math.abs(b.pointsBalance - t) <= window)) {
        chosen.set(b.customerId, 'tier_boundary');
      }
    }
  }

  const rand = mulberry32(input.seed);
  for (const b of [...input.balances].sort((a, c) => (a.customerId < c.customerId ? -1 : 1))) {
    if (chosen.has(b.customerId)) continue;
    if (rand() * 10_000 < tailRate) chosen.set(b.customerId, 'sampled');
  }

  const lines: SampleLine[] = input.balances.map((b) => ({
    customerId: b.customerId,
    customerName: b.customerName,
    stratum: chosen.get(b.customerId) ?? 'not_checked',
    balanceShownToTheCustomer: false as const,
    // The question never contains the answer.
    ask: 'How many points do you think you have, and when did you last use any? Do not offer a figure',
  })).filter((l) => l.stratum !== 'not_checked');

  const censusCustomers = lines.filter((l) => l.stratum === 'largest_balances').length;
  const tierBoundaryCustomers = lines.filter((l) => l.stratum === 'tier_boundary').length;
  const sampledCustomers = lines.filter((l) => l.stratum === 'sampled').length;

  if (lines.length < 5) {
    return {
      ok: false,
      refusedBecause: 'sample_too_small',
      detail: `${lines.length} customer(s) supports no conclusion at all. A result presented from it would be a number with nothing behind it`,
    };
  }

  const asked = new Set(lines.map((l) => l.customerId));
  const pointsCovered = input.balances.filter((b) => asked.has(b.customerId))
    .reduce((t, b) => t + b.pointsBalance, 0);

  return {
    ok: true,
    plan: {
      planId: input.planId,
      lines,
      censusCustomers, tierBoundaryCustomers, sampledCustomers,
      notCheckedCustomers: input.balances.length - lines.length,
      pointsCoverageBps: totalPoints === 0 ? 0 : Math.round((pointsCovered * 10_000) / totalPoints),
      detail: `${censusCustomers} largest balances, ${tierBoundaryCustomers} sitting on a tier boundary and ${sampledCustomers} drawn at random from everybody else — the random slice matters most, because the first two are exactly the accounts a careful operator would already have got right`,
    },
    detail: `plan ${input.planId}: ${lines.length} customers, drawn before anybody was told`,
  };
}

export type BalanceFinding =
  | 'agrees'
  /** The customer says they have MORE than we migrated. Loud, visible, self-correcting. */
  | 'we_migrated_fewer'
  /** The customer says they have FEWER. Silent, permanent, and it costs money. */
  | 'we_migrated_more'
  /** They could not say, which is not the same as agreeing. */
  | 'could_not_say';

export interface BalanceCheck {
  readonly customerId: string;
  readonly customerName: string;
  readonly finding: BalanceFinding;
  readonly migratedPoints: number;
  readonly customerStatedPoints?: number;
  /** migrated − stated. Positive means we credited more than the customer believes they have. */
  readonly differencePoints: number;
  readonly detail: string;
}

export interface TierChange {
  readonly customerId: string;
  readonly customerName: string;
  readonly wasTier: string;
  readonly nowTier: string;
  readonly detail: string;
}

export type VerificationRefusal = 'balance_was_shown_to_the_customer' | 'confirmation_carries_no_figure';

export interface LoyaltyVerification {
  readonly accepted: boolean;
  readonly refusedBecause?: VerificationRefusal;
  readonly checks: readonly BalanceCheck[];
  /** Customers who say they have more than we gave them. Reported separately, never netted. */
  readonly weMigratedFewerPoints: number;
  /** Customers who say they have fewer. **The one that costs money.** Never netted with the above. */
  readonly weMigratedMorePoints: number;
  /** What the silent direction is worth, at the tenant's own cost of a redeemed point. */
  readonly silentLiabilityMinor: number;
  /** Customers who dropped a tier. Named — a tier is visible on every receipt. */
  readonly tierDrops: readonly TierChange[];
  /** Asked and never answered. Unverified, which is not the same as agreeing. */
  readonly noAnswer: readonly string[];
  readonly sufficientToVerify: boolean;
  /**
   * Typed as the literal `false`. A customer confirming a balance confirms the balance, not that
   * it was ever earned. Award double points by mistake for a year and every customer confirms the
   * wrong figure cheerfully.
   */
  readonly provesTheBalanceWasEarned: false;
  readonly detail: string;
  readonly ownerAction: string;
}

/**
 * Assess what the customers said.
 *
 * The two directions are counted separately and never offset. Netting them produces a reassuring
 * near-zero out of a migration that shortchanged half the customers and over-credited the other
 * half, which is two problems rather than none.
 */
export function assessLoyaltyVerification(input: {
  readonly migrated: readonly LoyaltyBalance[];
  readonly legacyTiers?: ReadonlyMap<string, string>;
  readonly confirmations: readonly CustomerConfirmation[];
  readonly asked: readonly string[];
  /** What one redeemed point actually costs this tenant, in minor units. Per-tenant. */
  readonly pointCostMinor: number;
  /** Points difference at or below which a balance need not block. Per-tenant. */
  readonly tolerancePoints?: number;
}): LoyaltyVerification {
  const tolerance = input.tolerancePoints ?? 0;

  const empty = (detail: string, refusedBecause: VerificationRefusal): LoyaltyVerification => ({
    accepted: false, refusedBecause, checks: [],
    weMigratedFewerPoints: 0, weMigratedMorePoints: 0, silentLiabilityMinor: 0,
    tierDrops: [], noAnswer: [], sufficientToVerify: false,
    provesTheBalanceWasEarned: false, detail, ownerAction: detail,
  });

  const shown = input.confirmations.filter((c) => c.method === 'customer_shown_the_balance_and_agreed');
  if (shown.length > 0) {
    return empty(
      `${shown.length} confirmation(s) were obtained by showing the customer the balance and asking whether it was right. Nobody carries their points total in their head, so that question measures agreeableness rather than the balance — it is the same as printing "expected: 40" on a stock count sheet. Ask what they think they have, or what they remember doing`,
      'balance_was_shown_to_the_customer',
    );
  }

  const hollow = input.confirmations.filter((c) => c.method === 'customer_stated_their_own_figure' && c.statedPoints === undefined);
  if (hollow.length > 0) {
    return empty(
      `${hollow.length} confirmation(s) record that the customer stated a figure without recording the figure. A confirmation with nothing in it cannot be checked, and it counts as agreement everywhere it is read`,
      'confirmation_carries_no_figure',
    );
  }

  const byCustomer = new Map(input.confirmations.map((c) => [c.customerId, c]));
  const checks: BalanceCheck[] = [];

  for (const b of input.migrated) {
    const c = byCustomer.get(b.customerId);
    if (c === undefined) continue;

    if (c.statedPoints === undefined) {
      checks.push({
        customerId: b.customerId, customerName: b.customerName, finding: 'could_not_say',
        migratedPoints: b.pointsBalance, differencePoints: 0,
        detail: `${b.customerName} confirmed activity (${c.activityConfirmed ?? 'unspecified'}) but could not put a number on the balance. That is honest and it is not agreement`,
      });
      continue;
    }

    const differencePoints = b.pointsBalance - c.statedPoints;
    const finding: BalanceFinding = Math.abs(differencePoints) <= tolerance ? 'agrees'
      : differencePoints > 0 ? 'we_migrated_more' : 'we_migrated_fewer';

    checks.push({
      customerId: b.customerId, customerName: b.customerName, finding,
      migratedPoints: b.pointsBalance, customerStatedPoints: c.statedPoints, differencePoints,
      detail: finding === 'agrees'
        ? `${b.customerName}: agrees at ${b.pointsBalance}`
        : finding === 'we_migrated_fewer'
          ? `${b.customerName} believes they have ${c.statedPoints} and we migrated ${b.pointsBalance}. They will say so at the till on day one${(b.pointsExpiringSoon ?? 0) > 0 ? ', and sooner still — they have points about to lapse' : ''}`
          : `${b.customerName} believes they have ${c.statedPoints} and we migrated ${b.pointsBalance}. Nobody will ever mention this one, and it is a liability we redeem in goods`,
    });
  }

  const weMigratedFewerPoints = checks.filter((c) => c.finding === 'we_migrated_fewer')
    .reduce((t, c) => t + Math.abs(c.differencePoints), 0);
  const weMigratedMorePoints = checks.filter((c) => c.finding === 'we_migrated_more')
    .reduce((t, c) => t + c.differencePoints, 0);

  const tierDrops: TierChange[] = [];
  for (const b of input.migrated) {
    const was = input.legacyTiers?.get(b.customerId);
    if (was !== undefined && b.tier !== undefined && was !== b.tier) {
      tierDrops.push({
        customerId: b.customerId, customerName: b.customerName, wasTier: was, nowTier: b.tier,
        detail: `${b.customerName} was ${was} and is now ${b.tier}. A tier is printed on the receipt and shown in the app — it is far more visible than a point total, and taken far more personally`,
      });
    }
  }

  const answered = new Set(input.confirmations.map((c) => c.customerId));
  const noAnswer = input.asked.filter((id) => !answered.has(id)).sort();

  const sufficientToVerify = noAnswer.length === 0
    && tierDrops.length === 0
    && weMigratedMorePoints === 0
    && weMigratedFewerPoints === 0
    && checks.every((c) => c.finding === 'agrees');

  const silentLiabilityMinor = weMigratedMorePoints * input.pointCostMinor;

  return {
    accepted: true,
    // Worst first, and the silent direction above the loud one.
    checks: [...checks].sort((a, b) => {
      const rank = (c: BalanceCheck): number => (c.finding === 'we_migrated_more' ? 2 : c.finding === 'we_migrated_fewer' ? 1 : 0);
      return rank(b) - rank(a) || Math.abs(b.differencePoints) - Math.abs(a.differencePoints);
    }),
    weMigratedFewerPoints, weMigratedMorePoints, silentLiabilityMinor, tierDrops, noAnswer,
    sufficientToVerify,
    provesTheBalanceWasEarned: false,
    detail: sufficientToVerify
      ? `every customer asked confirmed their own balance, and no tier moved — the points in the opening books are the customers' own figures`
      : `${weMigratedFewerPoints} points short across the customers who will tell us, ${weMigratedMorePoints} over across the customers who will not, ${tierDrops.length} tier change(s), ${noAnswer.length} never answered. Reported separately, because offsetting them turns two problems into none`,
    ownerAction: weMigratedMorePoints > 0
      ? `we migrated ${weMigratedMorePoints} points more than customers believe they hold — about ${silentLiabilityMinor} at what a redeemed point costs us. Nobody will ever mention it, which is exactly why it is the one to fix: the shortfalls will be reported to you at the till within a week, and this will not be reported to you at all`
      : tierDrops.length > 0
        ? `${tierDrops.length} customer(s) changed tier: ${tierDrops.map((t) => t.customerName).join(', ')}. A tier is on the receipt and in the app, so this is the most visible thing in the whole migration — decide before go-live whether to hold everybody at their old tier for a period`
        : weMigratedFewerPoints > 0
          ? `${weMigratedFewerPoints} points short across the customers who checked. Every one of them will say so at the till, so fix it before go-live rather than at the counter with a queue behind them`
          : noAnswer.length > 0
            ? `${noAnswer.length} customer(s) were asked and did not answer. They are recorded by name as unverified — a customer who did not reply has not agreed with us`
            : 'nothing — the customers confirm their own balances'
    ,
  };
}
