// Segments, lifetime value and engagement history (M16-FR-04 / PRV / P-08).
//
// Everything in this file is a **derived opinion about a person**, which is a different
// kind of data from a sale. A sale is a fact. "This customer is low value and lapsing" is
// an inference, it will be wrong for some people, and acting on it changes how the shop
// treats them. So three rules shape the module:
//
//   • **NO PROFILING WITHOUT A LAWFUL BASIS** (PRV, and the roadmap says it in those
//     words). A customer who has not consented to profiling is not segmented for
//     marketing — and rather than silently excluding them, the module returns them as
//     `not_profiled` **with the reason**, so a campaign's reach is honest and nobody
//     wonders where the missing customers went.
//
//   • **SERVICE IS NOT MARKETING.** A customer who withheld marketing consent can still
//     be looked up by the service desk to answer their own complaint — that is the
//     lawful basis of performing the contract, not consent. Conflating the two either
//     leaks marketing to people who refused it, or makes the shop unable to help its own
//     customers. The purpose is therefore an explicit input, and the answer differs.
//
//   • **LIFETIME VALUE IS MARGIN, NOT REVENUE, AND IT IS NOT A PREDICTION.** A customer
//     who spends ₹50,000 a year on cigarettes at 4% is worth less than one spending
//     ₹20,000 on fresh at 30%. And this module computes **historic** value only: a
//     projected CLV multiplied out over an assumed lifetime is a guess dressed as a
//     figure, and shops make real decisions on it.
//
// Everything is exact integer arithmetic (§29.1). A ratio that cannot be computed says
// `not_meaningful` rather than returning zero or Infinity.
//
// Pure and deterministic: orders in, opinion out, clock injected.

export type ConsentPurpose = 'marketing' | 'profiling' | 'service';

export interface CustomerConsent {
  readonly customerRef: string;
  /** Purposes the customer has actively consented to. */
  readonly granted: readonly ConsentPurpose[];
  readonly withdrawnAt?: string;
}

export interface OrderFact {
  readonly orderId: string;
  readonly customerRef: string;
  readonly at: string;
  readonly netMinor: number;
  /** Margin on the order — the number that actually says what a customer is worth. */
  readonly marginMinor: number;
  readonly channel: 'store' | 'app' | 'web' | 'phone';
}

export interface ComplaintFact {
  readonly caseId: string;
  readonly customerRef: string;
  readonly at: string;
  readonly resolved: boolean;
}

export type SegmentName =
  | 'new'
  | 'regular'
  | 'loyal'
  | 'lapsing'
  | 'lapsed'
  | 'not_profiled'
  | 'insufficient_history';

export interface CustomerProfile {
  readonly customerRef: string;
  readonly segment: SegmentName;
  /** Historic margin contributed. Never a projection. */
  readonly lifetimeMarginMinor: number;
  readonly lifetimeRevenueMinor: number;
  readonly orderCount: number;
  readonly firstOrderAt?: string;
  readonly lastOrderAt?: string;
  readonly daysSinceLastOrder?: number;
  readonly averageBasketMinor: number | 'not_meaningful';
  /** Margin as basis points of revenue — exact, never a float percentage. */
  readonly marginBps: number | 'not_meaningful';
  readonly openComplaints: number;
  readonly channels: readonly string[];
  /** Why this customer is in this segment, in words. */
  readonly detail: string;
}

/** Per-tenant segment boundaries. No number here belongs to a particular shop. */
export interface SegmentPolicy {
  /** Orders below which a customer is still 'new'. Default 2. */
  readonly newBelowOrders?: number;
  /** Orders at or above which a customer is 'loyal'. Default 10. */
  readonly loyalAtOrders?: number;
  /** Days without an order before 'lapsing'. Default 60. */
  readonly lapsingAfterDays?: number;
  /** Days without an order before 'lapsed'. Default 180. */
  readonly lapsedAfterDays?: number;
  /** Orders needed before any segment is claimed at all. Default 1. */
  readonly minimumHistory?: number;
}

function policyOf(p: SegmentPolicy = {}): Required<SegmentPolicy> {
  return {
    newBelowOrders: p.newBelowOrders ?? 2,
    loyalAtOrders: p.loyalAtOrders ?? 10,
    lapsingAfterDays: p.lapsingAfterDays ?? 60,
    lapsedAfterDays: p.lapsedAfterDays ?? 180,
    minimumHistory: p.minimumHistory ?? 1,
  };
}

function hasConsent(consent: CustomerConsent | undefined, purpose: ConsentPurpose): boolean {
  if (consent === undefined) return false;
  if (consent.withdrawnAt !== undefined) return false;
  return consent.granted.includes(purpose);
}

/**
 * Build one customer's profile.
 *
 * `purpose` decides what may be computed. For `'marketing'` and `'profiling'` a customer
 * without consent is returned as **`not_profiled`** — present in the output, with the
 * reason, so a campaign's reach is honest. For `'service'` the profile is built
 * regardless, because answering a customer's own complaint is performance of the
 * contract, not marketing (PRV lawful basis).
 */
export function buildProfile(input: {
  readonly customerRef: string;
  readonly orders: readonly OrderFact[];
  readonly complaints?: readonly ComplaintFact[];
  readonly consent?: CustomerConsent;
  readonly purpose: ConsentPurpose;
  readonly asOf: string;
  readonly policy?: SegmentPolicy;
}): CustomerProfile {
  const p = policyOf(input.policy);
  const mine = input.orders.filter((o) => o.customerRef === input.customerRef);
  const complaints = (input.complaints ?? []).filter((c) => c.customerRef === input.customerRef);
  const openComplaints = complaints.filter((c) => !c.resolved).length;

  const revenue = mine.reduce((s, o) => s + o.netMinor, 0);
  const margin = mine.reduce((s, o) => s + o.marginMinor, 0);
  const sorted = [...mine].sort((a, b) => a.at.localeCompare(b.at));
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const daysSince =
    last === undefined
      ? undefined
      : Math.floor((Date.parse(input.asOf) - Date.parse(last.at)) / 86_400_000);

  const base = {
    customerRef: input.customerRef,
    lifetimeMarginMinor: margin,
    lifetimeRevenueMinor: revenue,
    orderCount: mine.length,
    ...(first === undefined ? {} : { firstOrderAt: first.at }),
    ...(last === undefined ? {} : { lastOrderAt: last.at }),
    ...(daysSince === undefined ? {} : { daysSinceLastOrder: daysSince }),
    averageBasketMinor: mine.length === 0 ? ('not_meaningful' as const) : Math.round(revenue / mine.length),
    // Exact basis points via BigInt. A margin percentage of zero revenue is not zero —
    // it is not a number, and saying so beats printing 0%.
    marginBps:
      revenue === 0 ? ('not_meaningful' as const) : Number((BigInt(margin) * 10_000n) / BigInt(revenue)),
    openComplaints,
    channels: [...new Set(mine.map((o) => o.channel))].sort(),
  };

  // The consent gate, before any segment is assigned.
  if (input.purpose !== 'service' && !hasConsent(input.consent, 'profiling')) {
    return {
      ...base,
      segment: 'not_profiled',
      detail:
        'this customer has not consented to profiling, so they are not segmented for marketing. They are listed here rather than dropped so the campaign reach is honest',
    };
  }

  if (mine.length < p.minimumHistory) {
    return {
      ...base,
      segment: 'insufficient_history',
      detail: `${mine.length} order(s) — too few to say anything about this customer that would not be a guess`,
    };
  }

  if (daysSince !== undefined && daysSince >= p.lapsedAfterDays) {
    return { ...base, segment: 'lapsed', detail: `no order for ${daysSince} days` };
  }
  if (daysSince !== undefined && daysSince >= p.lapsingAfterDays) {
    return { ...base, segment: 'lapsing', detail: `no order for ${daysSince} days, and they used to come regularly` };
  }
  if (mine.length >= p.loyalAtOrders) {
    return { ...base, segment: 'loyal', detail: `${mine.length} orders, ${margin} of margin` };
  }
  if (mine.length < p.newBelowOrders) {
    return { ...base, segment: 'new', detail: `${mine.length} order(s) so far` };
  }
  return { ...base, segment: 'regular', detail: `${mine.length} orders, last one ${daysSince} day(s) ago` };
}

export interface SegmentAudience {
  readonly purpose: ConsentPurpose;
  readonly segment: SegmentName;
  readonly customerRefs: readonly string[];
  /** Customers who match the segment but cannot be contacted for this purpose. */
  readonly excludedForConsent: number;
  /** Total margin the audience represents. */
  readonly marginMinor: number;
  readonly detail: string;
}

/**
 * Build a campaign audience. **The excluded count is always reported** — a marketing
 * list that silently drops non-consenting customers looks smaller for no visible reason,
 * and somebody eventually "fixes" it by removing the consent check.
 *
 * Marketing needs marketing consent **as well as** profiling consent: agreeing to be
 * analysed is not agreeing to be messaged.
 */
export function buildAudience(input: {
  readonly segment: SegmentName;
  readonly purpose: ConsentPurpose;
  readonly profiles: readonly CustomerProfile[];
  readonly consents: readonly CustomerConsent[];
}): SegmentAudience {
  const consentByRef = new Map(input.consents.map((c) => [c.customerRef, c]));
  const matching = input.profiles.filter((p) => p.segment === input.segment);

  const contactable = matching.filter((p) => {
    if (input.purpose === 'service') return true;
    const consent = consentByRef.get(p.customerRef);
    // Analysis consent and contact consent are two different permissions.
    return hasConsent(consent, 'profiling') && hasConsent(consent, input.purpose);
  });

  const excluded = matching.length - contactable.length;
  return {
    purpose: input.purpose,
    segment: input.segment,
    customerRefs: contactable.map((p) => p.customerRef).sort(),
    excludedForConsent: excluded,
    marginMinor: contactable.reduce((s, p) => s + p.lifetimeMarginMinor, 0),
    detail:
      excluded === 0
        ? `${contactable.length} customer(s) in "${input.segment}"`
        : `${contactable.length} customer(s) in "${input.segment}"; ${excluded} more match but have not consented to ${input.purpose} and are not contactable`,
  };
}

export interface ValueRanking {
  readonly customerRef: string;
  readonly lifetimeMarginMinor: number;
  readonly lifetimeRevenueMinor: number;
  readonly marginBps: number | 'not_meaningful';
  readonly detail: string;
}

/**
 * Rank customers by what they are actually worth. **By margin, not revenue** — and the
 * ranking states both, because the two orders differ and the difference is the point: a
 * ₹50,000 cigarette customer at 4% is worth less than a ₹20,000 fresh customer at 30%,
 * and a revenue-ranked list would have the shop chasing the wrong one.
 */
export function rankByValue(profiles: readonly CustomerProfile[], top = 10): readonly ValueRanking[] {
  return [...profiles]
    .filter((p) => p.segment !== 'not_profiled')
    .sort((a, b) => b.lifetimeMarginMinor - a.lifetimeMarginMinor || a.customerRef.localeCompare(b.customerRef))
    .slice(0, top)
    .map((p) => ({
      customerRef: p.customerRef,
      lifetimeMarginMinor: p.lifetimeMarginMinor,
      lifetimeRevenueMinor: p.lifetimeRevenueMinor,
      marginBps: p.marginBps,
      detail:
        p.marginBps === 'not_meaningful'
          ? `${p.lifetimeMarginMinor} of margin`
          : `${p.lifetimeMarginMinor} of margin on ${p.lifetimeRevenueMinor} of spend (${(p.marginBps / 100).toFixed(2)}%)`,
    }));
}
