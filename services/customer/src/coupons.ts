// API-06 Coupons, personalised offers and referrals (M17-FR-02) — the small bearer instruments the shop
// prints and then honours, made live on the cloud. Everything that goes wrong with a coupon goes wrong the
// same way — it is checked once, at issue, and never again at the moment it costs money — so the tested
// `@sre/loyalty` engine checks EVERY rule at REDEMPTION, and this surface runs it at the authoritative tier:
//
//   • SINGLE-USE MEANS SINGLE-USE, INCLUDING OFFLINE (hard rule #10). A code redeemed on lane 3 and again on
//     lane 5 ninety seconds later is the commonest coupon fraud there is; it works because the second lane
//     has not synced. The cloud holds the WHOLE redemption history, so when the second lane syncs, the
//     central `redeemCoupon` sees the limit is already reached and REFUSES it — a visible 409, never a
//     silent last-write-wins. A re-sync of the SAME redemption id is idempotent (200), not a second use.
//   • EXPIRY and ELIGIBILITY are checked at redemption, not at issue.
//   • A PERSONALISED OFFER carries the consent gate (M16-FR-02): an offer built from someone's shopping
//     history is profiling and sending it is marketing — BOTH consents are required, and a refusal NAMES
//     which is missing rather than the offer quietly not appearing.
//   • A REFERRAL PAYS OUT ONLY WHEN THE REFERRED PERSON ACTUALLY BOUGHT, and never on a self-referral.
//
// The rules are the tested `redeemCoupon`/`issuePersonalisedOffer`/`assessReferral` in `@sre/loyalty` (the
// `services-run-on-their-tested-engine` guardrail); this file is the persistence + HTTP skin. Coupons and
// their redemptions are event-sourced (`CouponIssued`/`CouponRedeemed`), so the register survives a restart
// and reads as what happened. Issuing/offering/referral-reward are gated `loyalty.coupon.issue`; recording a
// redemption is `loyalty.coupon.redeem` (a lane action); reads are `loyalty.coupon.read`.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import {
  redeemCoupon, issuePersonalisedOffer, assessReferral,
  type Coupon, type CouponKind, type Redemption,
} from '../../../packages/loyalty/src/coupons';

export interface CouponDeps {
  /** Record a coupon definition (idempotent on the caller's key; latest-per-code). */
  readonly issue: (tenantId: string, coupon: Coupon, key: string) => Promise<void> | void;
  /** The current definition of one coupon, or undefined when the code is unknown. */
  readonly coupon: (tenantId: string, code: string) => Promise<Coupon | undefined> | Coupon | undefined;
  /** Every recorded redemption of one code — the authoritative set the central checks run against. */
  readonly redemptions: (tenantId: string, code: string) => Promise<readonly Redemption[]> | readonly Redemption[];
  /** Record a successful redemption (idempotent on the redemption id). */
  readonly recordRedemption: (tenantId: string, r: Redemption, key: string) => Promise<void> | void;
  /** Referral ids already rewarded — the already-paid guard. */
  readonly rewardedReferralIds: (tenantId: string) => Promise<readonly string[]> | readonly string[];
  /** Record that a referral reward was granted (idempotent on the referral id). */
  readonly recordReferralReward: (tenantId: string, referralId: string, rewardMinor: number, at: string, key: string) => Promise<void> | void;
  readonly now: () => string;
}

const KINDS: readonly CouponKind[] = ['amount_off', 'percent_off', 'free_item', 'referral', 'membership'];
const isKind = (v: unknown): v is CouponKind => typeof v === 'string' && (KINDS as readonly string[]).includes(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isNonNegInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isPosInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const isStrArr = (v: unknown): v is readonly string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** Build a Coupon from a body (issuedAt stamped server-side), or throw a 400 naming what is wrong. */
function readCoupon(code: string, issuedAt: string, b: Record<string, unknown>): Coupon {
  if (!isKind(b['kind']) || !isStr(b['validUntil']) || !YMD.test(b['validUntil'] as string)
    || !isPosInt(b['maxRedemptions']) || !isPosInt(b['maxPerCustomer'])) {
    throw apiError(400, {
      code: 'not_readable_as_a_coupon',
      whatHappened: 'A coupon needs a kind (amount_off, percent_off, free_item, referral or membership), a validUntil date (YYYY-MM-DD), and whole positive maxRedemptions and maxPerCustomer.',
      wasItSaved: 'not_saved',
      nextSafeAction: 'Send the coupon shape; a single-use coupon is maxRedemptions 1, maxPerCustomer 1.',
    });
  }
  if (b['valueMinor'] !== undefined && !isNonNegInt(b['valueMinor'])) throw badValue();
  if (b['percentBps'] !== undefined && !isNonNegInt(b['percentBps'])) throw badValue();
  return {
    code,
    kind: b['kind'],
    issuedAt,
    validUntil: b['validUntil'] as string,
    maxRedemptions: b['maxRedemptions'] as number,
    maxPerCustomer: b['maxPerCustomer'] as number,
    ...(isNonNegInt(b['valueMinor']) ? { valueMinor: b['valueMinor'] } : {}),
    ...(isNonNegInt(b['percentBps']) ? { percentBps: b['percentBps'] } : {}),
    ...(isNonNegInt(b['minimumBasketMinor']) ? { minimumBasketMinor: b['minimumBasketMinor'] } : {}),
    ...(isStr(b['issuedTo']) ? { issuedTo: b['issuedTo'] } : {}),
    ...(isStrArr(b['eligibleTo']) ? { eligibleTo: b['eligibleTo'] } : {}),
    ...(typeof b['personalised'] === 'boolean' ? { personalised: b['personalised'] } : {}),
  };
}

const badValue = () => apiError(400, {
  code: 'not_readable_as_a_coupon',
  whatHappened: 'valueMinor and percentBps, where given, must be whole numbers ≥ 0.',
  wasItSaved: 'not_saved',
  nextSafeAction: 'Send an amount in minor units, or a percentage in basis points (1% = 100).',
});

/** Issue a coupon, refusing to overwrite a code that already names a different instrument. */
async function issueCoupon(deps: CouponDeps, tenantId: string, coupon: Coupon, key: string): Promise<void> {
  const existing = await deps.coupon(tenantId, coupon.code);
  if (existing !== undefined) {
    throw apiError(409, {
      code: 'coupon_code_in_use',
      whatHappened: `Coupon code "${coupon.code}" already exists — a code names exactly one instrument, and re-defining it would change what people already hold.`,
      wasItSaved: 'not_saved',
      nextSafeAction: 'Use a fresh code for a new coupon; nothing was changed.',
    });
  }
  await deps.issue(tenantId, coupon, key);
}

export function couponRoutes(deps: CouponDeps): readonly Route[] {
  return [
    {
      // Define/issue a coupon. Body: the coupon shape (issuedAt is stamped server-side).
      api: 'API-06', method: 'POST', path: '/v1/loyalty/coupons/:code',
      permission: 'loyalty.coupon.issue', idempotent: true,
      handler: async (ctx) => {
        const code = (ctx.params['code'] ?? '').trim();
        if (code === '') throw notFound('coupon (no code given)');
        const coupon = readCoupon(code, deps.now(), (ctx.body ?? {}) as Record<string, unknown>);
        await issueCoupon(deps, ctx.tenantId, coupon, ctx.idempotencyKey ?? code);
        return { status: 201, body: { coupon } };
      },
    },
    {
      // Read a coupon and its redemptions — the lane's authoritative cache source.
      api: 'API-06', method: 'GET', path: '/v1/loyalty/coupons/:code',
      permission: 'loyalty.coupon.read',
      handler: async (ctx) => {
        const code = (ctx.params['code'] ?? '').trim();
        const coupon = await deps.coupon(ctx.tenantId, code);
        if (coupon === undefined) throw notFound(`coupon ${code}`);
        const redemptions = await deps.redemptions(ctx.tenantId, code);
        return { status: 200, body: { coupon, redemptions, redemptionCount: redemptions.length } };
      },
    },
    {
      // Record a redemption (synced from a lane). The central `redeemCoupon` runs against the WHOLE
      // redemption history, so a cross-lane double-use a stale lane cache missed is caught HERE and refused
      // — a visible 409, never a silent accept (hard rule #10). Body: { saleId, basketMinor, customerRef?,
      // customerSegments? }.
      api: 'API-06', method: 'POST', path: '/v1/loyalty/coupons/:code/redemptions/:redemptionId',
      permission: 'loyalty.coupon.redeem', idempotent: true,
      handler: async (ctx) => {
        const code = (ctx.params['code'] ?? '').trim();
        const redemptionId = (ctx.params['redemptionId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (code === '' || redemptionId === '' || !isStr(b['saleId']) || !isNonNegInt(b['basketMinor'])) {
          throw apiError(400, {
            code: 'not_readable_as_a_redemption',
            whatHappened: 'Recording a redemption needs a coupon code and a redemption id in the path, and a saleId and a whole basketMinor ≥ 0 in the body.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send { saleId, basketMinor } (optionally customerRef, customerSegments) with the code and redemption id in the URL.',
          });
        }
        const coupon = await deps.coupon(ctx.tenantId, code);
        if (coupon === undefined) throw notFound(`coupon ${code}`);
        const redemption: Redemption = {
          redemptionId, code, saleId: b['saleId'] as string, at: deps.now(),
          ...(isStr(b['customerRef']) ? { customerRef: b['customerRef'] } : {}),
        };
        const result = redeemCoupon({
          coupon, redemption,
          knownRedemptions: await deps.redemptions(ctx.tenantId, code), // authoritative, whole history
          basketMinor: b['basketMinor'] as number,
          ...(isStrArr(b['customerSegments']) ? { customerSegments: b['customerSegments'] } : {}),
        });
        if (result.redeemed) {
          await deps.recordRedemption(ctx.tenantId, redemption, ctx.idempotencyKey ?? redemptionId);
          return { status: 201, body: { outcome: result.outcome, discountMinor: result.discountMinor, detail: result.detail } };
        }
        // A re-sync of the same redemption is idempotent — not an error, nothing new recorded.
        if (result.outcome === 'already_redeemed') {
          return { status: 200, body: { outcome: result.outcome, discountMinor: 0, detail: result.detail } };
        }
        // Every other outcome is a REFUSAL the caller must see — expired, over-limit (the cross-lane
        // double-use), not-eligible, basket-too-small. A conflict is a visible exception (hard rule #10).
        throw apiError(409, {
          code: `coupon_${result.outcome}`,
          whatHappened: result.detail,
          wasItSaved: 'not_saved',
          nextSafeAction: 'This redemption was not recorded. If a lane already gave the discount offline, this is the cross-lane conflict the central register exists to catch — raise it for review.',
        });
      },
    },
    {
      // Issue a PERSONALISED offer — consent-gated (M16-FR-02). Body: { customerRef, coupon:{...},
      // consents:[], customerSegments? }. On issue the offer is a real coupon and is recorded as one.
      api: 'API-06', method: 'POST', path: '/v1/loyalty/offers',
      permission: 'loyalty.coupon.issue', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const couponBody = b['coupon'];
        if (!isStr(b['customerRef']) || couponBody === null || typeof couponBody !== 'object' || Array.isArray(couponBody)
          || !isStr((couponBody as Record<string, unknown>)['code']) || !isStrArr(b['consents'])) {
          throw apiError(400, {
            code: 'not_readable_as_an_offer',
            whatHappened: 'A personalised offer needs a customerRef, a coupon object (with a code), and the customer\'s consents[].',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send { customerRef, coupon: {...}, consents: ["marketing","profiling"] }.',
          });
        }
        const cb = couponBody as Record<string, unknown>;
        const draft = readCoupon((cb['code'] as string).trim(), deps.now(), cb);
        const consents = (b['consents'] as readonly string[]).filter(
          (c): c is 'marketing' | 'profiling' | 'service' => c === 'marketing' || c === 'profiling' || c === 'service',
        );
        const result = issuePersonalisedOffer({
          customerRef: b['customerRef'] as string, coupon: draft, consents,
          ...(isStrArr(b['customerSegments']) ? { customerSegments: b['customerSegments'] } : {}),
        });
        if (!result.issued || result.coupon === undefined) {
          // A consent/segment refusal is NAMED, not a silently-absent offer (M16-FR-02).
          throw apiError(422, {
            code: `offer_${result.outcome}`,
            whatHappened: result.detail,
            wasItSaved: 'not_saved',
            nextSafeAction: 'No offer was issued. Profiling AND marketing consent are both needed to send a personalised offer.',
          });
        }
        await issueCoupon(deps, ctx.tenantId, result.coupon, ctx.idempotencyKey ?? result.coupon.code);
        return { status: 201, body: { outcome: result.outcome, coupon: result.coupon } };
      },
    },
    {
      // Assess a referral for payability. Body: { referrerRef, referredRef, referredPurchases:[],
      // qualifyingSpendMinor, rewardMinor, sharedContacts? }. Payable → recorded (so it cannot be paid
      // twice) and 201; not-yet-qualifying or self-referral → 200 with the named reason (a legitimate
      // "not payable" answer, not a server fault).
      api: 'API-06', method: 'POST', path: '/v1/loyalty/referrals/:referralId',
      permission: 'loyalty.coupon.issue', idempotent: true,
      handler: async (ctx) => {
        const referralId = (ctx.params['referralId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const purchases = b['referredPurchases'];
        const okPurchases = Array.isArray(purchases) && purchases.every(
          (p) => p !== null && typeof p === 'object' && typeof (p as Record<string, unknown>)['netMinor'] === 'number' && typeof (p as Record<string, unknown>)['at'] === 'string',
        );
        if (referralId === '' || !isStr(b['referrerRef']) || !isStr(b['referredRef']) || !okPurchases
          || !isNonNegInt(b['qualifyingSpendMinor']) || !isNonNegInt(b['rewardMinor'])) {
          throw apiError(400, {
            code: 'not_readable_as_a_referral',
            whatHappened: 'A referral needs a referralId, a referrerRef and referredRef, referredPurchases[] ({netMinor, at}), and whole qualifyingSpendMinor and rewardMinor.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the two customer refs, the referred customer\'s purchases, and the qualifying spend + reward.',
          });
        }
        const result = assessReferral({
          referralId,
          referrerRef: b['referrerRef'] as string,
          referredRef: b['referredRef'] as string,
          referredPurchases: purchases as readonly { netMinor: number; at: string }[],
          qualifyingSpendMinor: b['qualifyingSpendMinor'] as number,
          rewardMinor: b['rewardMinor'] as number,
          alreadyPaidReferralIds: await deps.rewardedReferralIds(ctx.tenantId),
          ...(isNonNegInt(b['sharedContacts']) ? { sharedContacts: b['sharedContacts'] } : {}),
        });
        if (result.payable) {
          await deps.recordReferralReward(ctx.tenantId, referralId, result.rewardMinor, deps.now(), ctx.idempotencyKey ?? referralId);
          return { status: 201, body: { payable: true, outcome: result.outcome, rewardMinor: result.rewardMinor, detail: result.detail } };
        }
        return { status: 200, body: { payable: false, outcome: result.outcome, rewardMinor: 0, detail: result.detail } };
      },
    },
  ];
}
