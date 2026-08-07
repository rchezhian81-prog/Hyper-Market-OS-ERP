// Coupons, referrals, memberships and personalised offers (M17-FR-02 / PRV / D06-FR-04).
//
// A coupon is a small bearer instrument the shop prints and then honours. Everything
// that goes wrong with them goes wrong the same way: **the coupon is checked once, at
// issue, and never again at the moment it costs money.**
//
//   • **SINGLE-USE MEANS SINGLE-USE, INCLUDING OFFLINE.** A code redeemed on lane 3 and
//     again on lane 5 ninety seconds later is the commonest coupon fraud there is, and
//     it works because the second lane has not synced. So redemption is checked against
//     the **locally cached** redemption set, the check is **idempotent on the redemption
//     id**, and when the cache is stale the lane is told (`countMayBeStale`) rather than
//     silently trusting it.
//   • **EXPIRY IS CHECKED AT REDEMPTION, NOT AT ISSUE.** Obvious, and still the bug.
//   • **ELIGIBILITY IS CHECKED AT REDEMPTION TOO.** A member-only coupon in the hands of
//     a non-member is refused at the counter, not apologised for afterwards.
//   • **A REFERRAL PAYS OUT ONLY WHEN THE REFERRED PERSON ACTUALLY BUYS**, and never to
//     someone referring themselves — self-referral is not an edge case, it is the first
//     thing anyone tries.
//
// Personalised offers carry the consent gate from M16: an offer targeted at a person who
// did not consent to profiling is **not issued**, and the refusal names the reason rather
// than the offer quietly not appearing.
//
// Pure and deterministic: the clock is injected, nothing is stored here.

export type CouponKind = 'amount_off' | 'percent_off' | 'free_item' | 'referral' | 'membership';

export interface Coupon {
  readonly code: string;
  readonly kind: CouponKind;
  /** Value in minor units, or basis points for a percentage. */
  readonly valueMinor?: number;
  readonly percentBps?: number;
  readonly issuedTo?: string;
  readonly issuedAt: string;
  /** Inclusive last date it can be redeemed, YYYY-MM-DD. */
  readonly validUntil: string;
  /** Total redemptions allowed across everyone. 1 = single-use. */
  readonly maxRedemptions: number;
  /** Redemptions allowed per customer. */
  readonly maxPerCustomer: number;
  /** Minimum basket value for it to apply. */
  readonly minimumBasketMinor?: number;
  /** Segments or membership tiers that may use it. Empty = anyone. */
  readonly eligibleTo?: readonly string[];
  /** True when this offer was targeted at a person, so consent applies (M16-FR-02). */
  readonly personalised?: boolean;
}

export interface Redemption {
  readonly redemptionId: string;
  readonly code: string;
  readonly customerRef?: string;
  readonly at: string;
  readonly saleId: string;
}

export type RedeemOutcome =
  | 'redeemed'
  | 'already_redeemed'
  | 'expired'
  | 'not_yet_valid'
  | 'limit_reached'
  | 'customer_limit_reached'
  | 'not_eligible'
  | 'basket_too_small'
  | 'unknown_code';

export interface RedeemResult {
  readonly code: string;
  readonly redeemed: boolean;
  readonly outcome: RedeemOutcome;
  readonly discountMinor: number;
  readonly detail: string;
  /**
   * True when the lane's redemption cache is older than the tenant's tolerance, so a
   * "not yet redeemed" answer might be wrong. The lane shows it; it never hides it.
   */
  readonly countMayBeStale?: boolean;
}

/**
 * Redeem a coupon at the lane. **Works offline** against the cached redemption set, and
 * is idempotent on the redemption id so a re-scan after a lane hiccup is one redemption.
 */
export function redeemCoupon(input: {
  readonly coupon: Coupon | undefined;
  readonly redemption: Redemption;
  /** Redemptions the lane knows about — cached, possibly stale. */
  readonly knownRedemptions: readonly Redemption[];
  readonly basketMinor: number;
  /** Segments/tiers the customer belongs to, for eligibility. */
  readonly customerSegments?: readonly string[];
  /** Age of the redemption cache in minutes, and the tenant's tolerance. */
  readonly cacheAgeMinutes?: number;
  readonly staleAfterMinutes?: number;
}): RedeemResult {
  const c = input.coupon;
  const r = input.redemption;
  const stale =
    input.cacheAgeMinutes !== undefined &&
    input.cacheAgeMinutes > (input.staleAfterMinutes ?? 15);
  const staleFlag = stale ? { countMayBeStale: true } : {};

  if (c === undefined) {
    return { code: r.code, redeemed: false, outcome: 'unknown_code', discountMinor: 0, detail: 'this code is not a coupon we issued' };
  }

  // The idempotency check runs first: a re-scan is the same redemption, not a second one.
  const same = input.knownRedemptions.find((k) => k.redemptionId === r.redemptionId);
  if (same !== undefined) {
    return {
      code: c.code,
      redeemed: false,
      outcome: 'already_redeemed',
      discountMinor: 0,
      detail: 'this exact redemption has already been recorded — scanning again changes nothing',
    };
  }

  const day = r.at.slice(0, 10);
  if (day > c.validUntil) {
    return { ...staleFlag, code: c.code, redeemed: false, outcome: 'expired', discountMinor: 0, detail: `this coupon expired on ${c.validUntil}` };
  }
  if (day < c.issuedAt.slice(0, 10)) {
    return { ...staleFlag, code: c.code, redeemed: false, outcome: 'not_yet_valid', discountMinor: 0, detail: `this coupon is not valid until ${c.issuedAt.slice(0, 10)}` };
  }

  const forThisCode = input.knownRedemptions.filter((k) => k.code === c.code);
  if (forThisCode.length >= c.maxRedemptions) {
    return {
      ...staleFlag,
      code: c.code,
      redeemed: false,
      outcome: 'limit_reached',
      discountMinor: 0,
      detail: `this coupon has already been used ${forThisCode.length} time(s) of ${c.maxRedemptions}`,
    };
  }
  if (r.customerRef !== undefined) {
    const byThisCustomer = forThisCode.filter((k) => k.customerRef === r.customerRef);
    if (byThisCustomer.length >= c.maxPerCustomer) {
      return {
        ...staleFlag,
        code: c.code,
        redeemed: false,
        outcome: 'customer_limit_reached',
        discountMinor: 0,
        detail: `this customer has already used it ${byThisCustomer.length} time(s) of ${c.maxPerCustomer}`,
      };
    }
  }
  if (c.issuedTo !== undefined && c.issuedTo !== r.customerRef) {
    return { ...staleFlag, code: c.code, redeemed: false, outcome: 'not_eligible', discountMinor: 0, detail: 'this coupon was issued to a different customer' };
  }
  if (c.eligibleTo !== undefined && c.eligibleTo.length > 0) {
    const segments = input.customerSegments ?? [];
    if (!c.eligibleTo.some((e) => segments.includes(e))) {
      return {
        ...staleFlag,
        code: c.code,
        redeemed: false,
        outcome: 'not_eligible',
        discountMinor: 0,
        detail: `this coupon is for ${c.eligibleTo.join(' or ')} customers`,
      };
    }
  }
  if (c.minimumBasketMinor !== undefined && input.basketMinor < c.minimumBasketMinor) {
    return {
      ...staleFlag,
      code: c.code,
      redeemed: false,
      outcome: 'basket_too_small',
      discountMinor: 0,
      detail: `this coupon needs a basket of at least ${c.minimumBasketMinor}; this one is ${input.basketMinor}`,
    };
  }

  // Exact integer discount, never above the basket — a coupon cannot pay a customer.
  const raw =
    c.percentBps !== undefined
      ? Number((BigInt(input.basketMinor) * BigInt(c.percentBps)) / 10_000n)
      : (c.valueMinor ?? 0);
  const discountMinor = Math.min(raw, input.basketMinor);

  return {
    ...staleFlag,
    code: c.code,
    redeemed: true,
    outcome: 'redeemed',
    discountMinor,
    detail: stale
      ? `${discountMinor} off — but this lane's coupon list is ${input.cacheAgeMinutes} minutes old, so a use on another lane may not be counted yet`
      : `${discountMinor} off`,
  };
}

export type OfferRefusal = 'issued' | 'no_profiling_consent' | 'no_marketing_consent' | 'not_in_segment';

export interface OfferResult {
  readonly customerRef: string;
  readonly issued: boolean;
  readonly outcome: OfferRefusal;
  readonly detail: string;
  readonly coupon?: Coupon;
}

/**
 * Issue a personalised offer. The consent gate is the whole point: an offer built from
 * someone's shopping history is profiling, and sending it is marketing. **Both consents
 * are required**, and a refusal names which one is missing rather than the offer quietly
 * not appearing — a campaign whose reach shrinks for no visible reason gets "fixed".
 */
export function issuePersonalisedOffer(input: {
  readonly customerRef: string;
  readonly coupon: Coupon;
  readonly consents: readonly ('marketing' | 'profiling' | 'service')[];
  readonly customerSegments?: readonly string[];
}): OfferResult {
  if (!input.consents.includes('profiling')) {
    return {
      customerRef: input.customerRef,
      issued: false,
      outcome: 'no_profiling_consent',
      detail: 'this offer is built from the customer\'s own shopping history, and they have not consented to being profiled',
    };
  }
  if (!input.consents.includes('marketing')) {
    return {
      customerRef: input.customerRef,
      issued: false,
      outcome: 'no_marketing_consent',
      detail: 'the customer consented to analysis but not to being contacted — those are two different permissions',
    };
  }
  if (input.coupon.eligibleTo !== undefined && input.coupon.eligibleTo.length > 0) {
    const segments = input.customerSegments ?? [];
    if (!input.coupon.eligibleTo.some((e) => segments.includes(e))) {
      return {
        customerRef: input.customerRef,
        issued: false,
        outcome: 'not_in_segment',
        detail: `this offer is for ${input.coupon.eligibleTo.join(' or ')} customers`,
      };
    }
  }
  return {
    customerRef: input.customerRef,
    issued: true,
    outcome: 'issued',
    detail: `offer ${input.coupon.code} issued to ${input.customerRef}`,
    coupon: { ...input.coupon, issuedTo: input.customerRef, personalised: true },
  };
}

export type ReferralOutcome = 'payable' | 'self_referral' | 'no_qualifying_purchase' | 'already_paid';

export interface ReferralResult {
  readonly referralId: string;
  readonly payable: boolean;
  readonly outcome: ReferralOutcome;
  readonly rewardMinor: number;
  readonly detail: string;
}

/**
 * Decide whether a referral reward is payable. **The referred person must actually have
 * bought something** — paying on sign-up funds an afternoon of fake accounts — and
 * **self-referral is refused**, because it is the first thing anyone tries and it is
 * trivially detectable.
 */
export function assessReferral(input: {
  readonly referralId: string;
  readonly referrerRef: string;
  readonly referredRef: string;
  readonly referredPurchases: readonly { readonly netMinor: number; readonly at: string }[];
  readonly qualifyingSpendMinor: number;
  readonly rewardMinor: number;
  readonly alreadyPaidReferralIds: readonly string[];
  /** Contacts shared between the two accounts — a self-referral in two names. */
  readonly sharedContacts?: number;
}): ReferralResult {
  const base = { referralId: input.referralId, rewardMinor: 0 };

  if (input.alreadyPaidReferralIds.includes(input.referralId)) {
    return { ...base, payable: false, outcome: 'already_paid', detail: 'this referral has already been rewarded' };
  }
  if (input.referrerRef === input.referredRef || (input.sharedContacts ?? 0) > 0) {
    return {
      ...base,
      payable: false,
      outcome: 'self_referral',
      detail:
        input.referrerRef === input.referredRef
          ? 'a customer cannot refer themselves'
          : 'these two accounts share a verified contact — this is one person in two names',
    };
  }

  const spent = input.referredPurchases.reduce((s, p) => s + p.netMinor, 0);
  if (spent < input.qualifyingSpendMinor) {
    return {
      ...base,
      payable: false,
      outcome: 'no_qualifying_purchase',
      detail: `the referred customer has spent ${spent} against a qualifying spend of ${input.qualifyingSpendMinor} — a referral pays on a purchase, not on a sign-up`,
    };
  }

  return {
    referralId: input.referralId,
    payable: true,
    outcome: 'payable',
    rewardMinor: input.rewardMinor,
    detail: `${input.referrerRef} earns ${input.rewardMinor}; ${input.referredRef} has spent ${spent}`,
  };
}
