// API-06 / API-07 — the customer referral programme (M17-FR-02 · D07-FR-04 · owner decision OB-351, 24 Oct 2026: "build now;
// reward per side 'not set' until the owner enters it").
//
//   GET  /v1/me/referral                       MY referral code (issued once), the rewards in force, my referrals — counts
//                                              and states only, never another customer's name or number
//   POST /v1/me/referral/claim                 I was referred: the code a friend gave me, before my first delivered order
//   GET  /v1/loyalty/referral-rewards          the two rewards — each "not set" until the owner enters it
//   POST /v1/loyalty/referral-rewards          the owner enters or changes them (append-only, with the reason)
//   GET  /v1/loyalty/referral-programme        the register: every referral, where it stands, what was given
//
// The rules (OB-351 and the roadmap's M17-FR-02):
//
//   • BOTH SIDES earn — the customer who referred and the customer referred — each the owner's own number. A side whose
//     number is "not set" is given NOTHING: the referral says "earned — the reward is not set yet" and waits. The reward is
//     given at the number in force when it is granted (the first read after both the delivery and the number exist).
//   • ONE REWARD per referred customer, on their FIRST DELIVERED online order — never on a sign-up, never on a second order.
//     A customer who already had an order delivered cannot then be "referred".
//   • NO SELF-REFERRAL: my own code is refused; a customer is referred once, by one code.
//
// A reward given is the EXISTING `ReferralRewarded` fact on the loyalty referral register, one per side — so the liability
// register, its payout / expiry by a person and its posting to the books through the accountant's map (offer-liability.ts,
// OB-221) carry it with no second path. Everything here is append-only (hard rules #2, #6): a code, a claim, a reward
// setting and a grant are each new records; nothing is edited or deleted. No AI decides any of it (hard rule #5).
//
// The owner's routes are not behind the loyalty marketing switch: "not set" IS the programme's off state (OB-351) — while
// either number is not set, that side gives nothing — so the owner can always read and enter them.

import { createHash } from 'node:crypto';
import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';

/** The owner's two numbers, as kept — each null ("not set") until he enters it. */
export interface ReferralRewardSetting {
  readonly referrerRewardMinor: number | null;
  readonly referredRewardMinor: number | null;
  readonly reason: string;
  readonly setBy: string;
  readonly setAt: string;
}

export interface ReferralCode {
  readonly customerRef: string;
  readonly code: string;
  readonly issuedAt: string;
}

/** One referred customer's claim: whose code, and when. One per referred customer. */
export interface ReferralClaim {
  readonly claimId: string;
  readonly referredRef: string;
  readonly referrerRef: string;
  readonly code: string;
  readonly claimedAt: string;
}

export type ReferralSide = 'referrer' | 'referred';

/** A reward given — written as the loyalty register's own `ReferralRewarded` fact (its `referralId` is per side). */
export interface ReferralGrant {
  readonly referralId: string;
  readonly rewardMinor: number;
  readonly at: string;
  readonly side: ReferralSide;
  readonly claimId: string;
  readonly customerRef: string;
  readonly orderId: string;
}

export interface ReferralProgrammeDeps {
  readonly rewardHistory: (tenantId: string) => Promise<readonly ReferralRewardSetting[]>;
  readonly recordReward: (tenantId: string, s: ReferralRewardSetting) => Promise<void>;
  readonly codeOf: (tenantId: string, customerRef: string) => Promise<ReferralCode | undefined>;
  readonly codeOwner: (tenantId: string, code: string) => Promise<ReferralCode | undefined>;
  /** Append a code — idempotent on the customer (the first code stands) and on the code itself. */
  readonly recordCode: (tenantId: string, c: ReferralCode) => Promise<void>;
  readonly claimOf: (tenantId: string, referredRef: string) => Promise<ReferralClaim | undefined>;
  /** Every claim, oldest first (the tenant-wide index). */
  readonly claims: (tenantId: string) => Promise<readonly ReferralClaim[]>;
  /** Append a claim — idempotent on the referred customer (the first claim stands). */
  readonly recordClaim: (tenantId: string, c: ReferralClaim) => Promise<void>;
  /** The customer's FIRST delivered online order, and when it was delivered — undefined: none yet. */
  readonly firstDelivered: (tenantId: string, customerRef: string) => Promise<{ readonly orderId: string; readonly deliveredAt: string } | undefined>;
  /** The grants already given for a claim (from the loyalty referral register). */
  readonly grantsFor: (tenantId: string, claimId: string) => Promise<readonly ReferralGrant[]>;
  /** Give a reward — idempotent on its referralId (a second write is the same grant). */
  readonly recordGrant: (tenantId: string, g: ReferralGrant) => Promise<void>;
  /** A uniform random integer in [0, max) — the caller passes `crypto.randomInt`. */
  readonly randomInt: (max: number) => number;
  readonly now: () => string;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
}

/** One claim per referred customer — its id is the customer's, digested (never their reference in a path). */
export const claimIdOf = (referredRef: string): string => `rf-${createHash('sha256').update(referredRef).digest('hex').slice(0, 24)}`;

/** A referral code: 8 characters from an alphabet with no look-alikes (no 0/O, 1/I/L), shown and typed easily. */
export const REFERRAL_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const REFERRAL_CODE = /^[2-9A-HJKMNP-Z]{8}$/;
export function newReferralCode(randomInt: (max: number) => number): string {
  let out = '';
  for (let i = 0; i < 8; i += 1) out += REFERRAL_ALPHABET[randomInt(REFERRAL_ALPHABET.length)];
  return out;
}

/** The rewards in force: the owner's latest change of each side, over "not set". */
export function rewardsInForce(history: readonly ReferralRewardSetting[]): { readonly referrerRewardMinor: number | null; readonly referredRewardMinor: number | null; readonly last: ReferralRewardSetting | null } {
  const last = history.at(-1) ?? null;
  return { referrerRewardMinor: last?.referrerRewardMinor ?? null, referredRewardMinor: last?.referredRewardMinor ?? null, last };
}

const WORDS = {
  notSet: { en: 'not set — nothing is given until the owner enters it', ta: 'அமைக்கப்படவில்லை — உரிமையாளர் உள்ளிடும் வரை எதுவும் வழங்கப்படாது' },
  how: {
    en: 'Give your code to a friend. When their FIRST online order is delivered, you both earn the shop\'s referral reward — once. Your own code cannot be used by you.',
    ta: 'உங்கள் குறியீட்டை நண்பரிடம் கொடுங்கள். அவரது முதல் ஆன்லைன் ஆர்டர் டெலிவரி ஆனதும், நீங்கள் இருவரும் கடையின் பரிந்துரைப் பரிசைப் பெறுவீர்கள் — ஒருமுறை மட்டும். உங்கள் சொந்தக் குறியீட்டை நீங்களே பயன்படுத்த முடியாது.',
  },
} as const;

export type ReferralStanding =
  /** Claimed; the referred customer's first order has not been delivered yet. */
  | 'waiting_for_first_delivery'
  /** Delivered; at least one side's reward is not set, so that side has been given nothing yet. */
  | 'earned_reward_not_set'
  /** Delivered; every side the owner set has been given its reward. */
  | 'rewarded';

export interface ReferralView {
  readonly claim: ReferralClaim;
  readonly standing: ReferralStanding;
  readonly firstDeliveredOrderId: string | null;
  readonly grants: readonly ReferralGrant[];
  /** Sides still waiting for the owner's number. */
  readonly waitingForReward: readonly ReferralSide[];
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const wholeNonNeg = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const MAX_REWARD_MINOR = 1_000_000; // ₹10,000 — a sanity ceiling on a typed reward, not a policy

/**
 * Bring one referral up to date: once the referred customer's first order is delivered, give each side the owner has set
 * its reward (once — idempotent per side). A side not set is given nothing and waits. Pure of the clock: `now` is the deps'.
 */
export async function settleReferral(deps: ReferralProgrammeDeps, tenantId: string, claim: ReferralClaim): Promise<ReferralView> {
  const delivered = await deps.firstDelivered(tenantId, claim.referredRef);
  let grants = await deps.grantsFor(tenantId, claim.claimId);
  if (delivered === undefined) return { claim, standing: 'waiting_for_first_delivery', firstDeliveredOrderId: null, grants, waitingForReward: [] };
  const rewards = rewardsInForce(await deps.rewardHistory(tenantId));
  const waiting: ReferralSide[] = [];
  for (const side of ['referrer', 'referred'] as const) {
    if (grants.some((g) => g.side === side)) continue;
    const amount = side === 'referrer' ? rewards.referrerRewardMinor : rewards.referredRewardMinor;
    if (amount === null) { waiting.push(side); continue; }
    // The owner set this side to nothing: nothing is owed, and nothing is written to the liability register.
    if (amount === 0) continue;
    const grant: ReferralGrant = {
      referralId: `${claim.claimId}-${side}`, rewardMinor: amount, at: deps.now(), side, claimId: claim.claimId,
      customerRef: side === 'referrer' ? claim.referrerRef : claim.referredRef, orderId: delivered.orderId,
    };
    await deps.recordGrant(tenantId, grant);
    await deps.recordAudit?.(tenantId, {
      actorId: 'system:referral-programme', action: 'referral.reward.grant', objectType: 'referral', objectId: grant.referralId, at: grant.at,
      origin: { tenantId, branchId: null }, before: null,
      after: { side, rewardMinor: String(amount), orderId: delivered.orderId, rule: 'OB-351 first delivered order' }, correlationId: claim.claimId,
    });
  }
  grants = await deps.grantsFor(tenantId, claim.claimId);
  return { claim, standing: waiting.length > 0 ? 'earned_reward_not_set' : 'rewarded', firstDeliveredOrderId: delivered.orderId, grants, waitingForReward: waiting };
}

/** A number as the screens say it: rupees, or "not set". */
const sayReward = (minor: number | null) => (minor === null ? { state: 'not_set' as const, words: WORDS.notSet } : { state: 'set' as const, amountMinor: minor });

export function referralProgrammeRoutes(deps: ReferralProgrammeDeps): readonly Route[] {
  /** My code — issued the first time I ask, then always the same (whoever wrote first, that code stands). */
  const myCode = async (tenantId: string, customerRef: string): Promise<ReferralCode> => {
    const held = await deps.codeOf(tenantId, customerRef);
    if (held !== undefined) return held;
    // A clash with another customer's code is drawn again (31^8 codes; a clash is rare, and never shared).
    for (let i = 0; i < 5; i += 1) {
      const code = newReferralCode(deps.randomInt);
      if ((await deps.codeOwner(tenantId, code)) !== undefined) continue;
      await deps.recordCode(tenantId, { customerRef, code, issuedAt: deps.now() });
      const mine = await deps.codeOf(tenantId, customerRef);
      if (mine !== undefined) return mine;
    }
    throw apiError(503, { code: 'referral_code_not_issued', whatHappened: 'The shop could not issue a referral code just now.', wasItSaved: 'not_saved', nextSafeAction: 'Try again in a moment. Nothing was changed.' });
  };
  const rewardsBody = async (tenantId: string) => {
    const r = rewardsInForce(await deps.rewardHistory(tenantId));
    return {
      referrer: sayReward(r.referrerRewardMinor), referred: sayReward(r.referredRewardMinor),
      ...(r.last === null ? {} : { lastSetBy: r.last.setBy, lastSetAt: r.last.setAt, lastReason: r.last.reason }),
    };
  };

  return [
    {
      api: 'API-07', method: 'GET', path: '/v1/me/referral',
      permission: 'storefront.order.read', entitlement: 'customer_app',
      handler: async (ctx) => {
        const code = await myCode(ctx.tenantId, ctx.userId);
        const mine = (await deps.claims(ctx.tenantId)).filter((c) => c.referrerRef === ctx.userId);
        const referred = [];
        // Counts and states only — never who they are.
        for (const c of mine) {
          const v = await settleReferral(deps, ctx.tenantId, c);
          referred.push({ standing: v.standing, claimedAt: c.claimedAt, rewardMinor: v.grants.find((g) => g.side === 'referrer')?.rewardMinor ?? null, waitingForReward: v.waitingForReward.includes('referrer') });
        }
        const claim = await deps.claimOf(ctx.tenantId, ctx.userId);
        let iWasReferred: Record<string, unknown> | null = null;
        if (claim !== undefined) {
          const v = await settleReferral(deps, ctx.tenantId, claim);
          iWasReferred = { standing: v.standing, claimedAt: claim.claimedAt, rewardMinor: v.grants.find((g) => g.side === 'referred')?.rewardMinor ?? null, waitingForReward: v.waitingForReward.includes('referred') };
        }
        return {
          status: 200,
          body: { code: code.code, issuedAt: code.issuedAt, rewards: await rewardsBody(ctx.tenantId), myReferrals: referred, iWasReferred, howItWorks: WORDS.how, asAt: deps.now() },
        };
      },
    },
    {
      // Body: { code } — the code a friend gave me.
      api: 'API-07', method: 'POST', path: '/v1/me/referral/claim',
      permission: 'storefront.order.place', entitlement: 'customer_app', idempotent: true,
      handler: async (ctx) => {
        const b = ctx.body;
        const typed = isObj(b) && typeof b['code'] === 'string' ? b['code'].trim().toUpperCase() : '';
        if (!REFERRAL_CODE.test(typed)) {
          throw apiError(400, { code: 'not_readable_as_a_referral_code', whatHappened: 'A referral code is 8 letters and digits, as your friend\'s app shows it.', wasItSaved: 'not_saved', nextSafeAction: 'Type the code again. Nothing was changed.' });
        }
        const prior = await deps.claimOf(ctx.tenantId, ctx.userId);
        if (prior !== undefined) {
          if (prior.code === typed) return { status: 200, body: { claimed: true, alreadyClaimed: true, claimedAt: prior.claimedAt } };
          throw apiError(409, { code: 'already_referred', whatHappened: 'You were already referred by another code. A customer is referred once.', wasItSaved: 'not_saved', nextSafeAction: 'Nothing was changed.' });
        }
        const owner = await deps.codeOwner(ctx.tenantId, typed);
        if (owner === undefined) throw apiError(404, { code: 'referral_code_unknown', whatHappened: 'No customer has that referral code.', wasItSaved: 'not_saved', nextSafeAction: 'Check the code with your friend. Nothing was changed.' });
        if (owner.customerRef === ctx.userId) {
          throw apiError(409, { code: 'self_referral', whatHappened: 'That is your own referral code — a customer cannot refer themselves.', wasItSaved: 'not_saved', nextSafeAction: 'Give your code to a friend instead. Nothing was changed.' });
        }
        if ((await deps.firstDelivered(ctx.tenantId, ctx.userId)) !== undefined) {
          throw apiError(409, { code: 'already_a_customer', whatHappened: 'You have already had an order delivered, so a referral cannot apply — the reward is for a new customer\'s first delivered order.', wasItSaved: 'not_saved', nextSafeAction: 'Nothing was changed.' });
        }
        const claim: ReferralClaim = { claimId: claimIdOf(ctx.userId), referredRef: ctx.userId, referrerRef: owner.customerRef, code: typed, claimedAt: deps.now() };
        await deps.recordClaim(ctx.tenantId, claim);
        const stood = (await deps.claimOf(ctx.tenantId, ctx.userId)) ?? claim;
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: 'referral.claim', objectType: 'referral', objectId: stood.claimId, at: stood.claimedAt,
          origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null }, before: null, after: { code: stood.code }, correlationId: stood.claimId,
        });
        return { status: 201, body: { claimed: true, claimedAt: stood.claimedAt, rewards: await rewardsBody(ctx.tenantId), detail: 'Recorded. When your first online order is delivered, you and your friend each earn the shop\'s referral reward.' } };
      },
    },
    {
      api: 'API-06', method: 'GET', path: '/v1/loyalty/referral-rewards',
      permission: 'loyalty.coupon.read',
      handler: async (ctx) => ({ status: 200, body: { ...await rewardsBody(ctx.tenantId), rule: 'OB-351: both sides, once, on the referred customer\'s first delivered online order; no self-referral.', asAt: deps.now() } }),
    },
    {
      // The owner enters or changes the rewards. Body: { referrerRewardMinor?, referredRewardMinor?, reason } — whole paise;
      // a side left out keeps its number; null puts a side back to "not set".
      api: 'API-06', method: 'POST', path: '/v1/loyalty/referral-rewards',
      permission: 'loyalty.programme.configure', idempotent: true,
      handler: async (ctx) => {
        const b = ctx.body;
        const ok = (v: unknown) => v === undefined || v === null || (wholeNonNeg(v) && v <= MAX_REWARD_MINOR);
        if (!isObj(b) || !ok(b['referrerRewardMinor']) || !ok(b['referredRewardMinor']) || (b['referrerRewardMinor'] === undefined && b['referredRewardMinor'] === undefined)
          || !isStr(b['reason']) || b['reason'].trim().length < 3) {
          throw apiError(400, { code: 'not_readable_as_referral_rewards', whatHappened: `The rewards need { referrerRewardMinor?, referredRewardMinor?, reason } — whole paise from 0 to ${MAX_REWARD_MINOR}, or null for "not set", and why.`, wasItSaved: 'not_saved', nextSafeAction: 'Enter the numbers again. Nothing was changed.' });
        }
        const before = rewardsInForce(await deps.rewardHistory(ctx.tenantId));
        const pick = (v: unknown, was: number | null): number | null => (v === undefined ? was : (v as number | null));
        const s: ReferralRewardSetting = {
          referrerRewardMinor: pick(b['referrerRewardMinor'], before.referrerRewardMinor), referredRewardMinor: pick(b['referredRewardMinor'], before.referredRewardMinor),
          reason: (b['reason'] as string).trim().slice(0, 300), setBy: ctx.userId, setAt: deps.now(),
        };
        await deps.recordReward(ctx.tenantId, s);
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: 'referral.rewards.set', objectType: 'referral_programme', objectId: 'referral-rewards', at: s.setAt,
          origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null },
          before: { referrer: String(before.referrerRewardMinor ?? 'not set'), referred: String(before.referredRewardMinor ?? 'not set') },
          after: { referrer: String(s.referrerRewardMinor ?? 'not set'), referred: String(s.referredRewardMinor ?? 'not set') }, reason: s.reason, correlationId: 'referral-rewards',
        });
        return { status: 200, body: await rewardsBody(ctx.tenantId) };
      },
    },
    {
      // The register, staff-side: every referral brought up to date and where it stands — the ones waiting first.
      api: 'API-06', method: 'GET', path: '/v1/loyalty/referral-programme',
      permission: 'loyalty.coupon.read',
      handler: async (ctx) => {
        const rows: ReferralView[] = [];
        for (const c of await deps.claims(ctx.tenantId)) rows.push(await settleReferral(deps, ctx.tenantId, c));
        const rank: Record<ReferralStanding, number> = { earned_reward_not_set: 0, waiting_for_first_delivery: 1, rewarded: 2 };
        rows.sort((a, b) => rank[a.standing] - rank[b.standing] || a.claim.claimedAt.localeCompare(b.claim.claimedAt));
        return {
          status: 200,
          body: {
            rewards: await rewardsBody(ctx.tenantId), referrals: rows,
            givenMinor: rows.reduce((n, r) => n + r.grants.reduce((m, g) => m + g.rewardMinor, 0), 0),
            waitingForTheOwner: rows.filter((r) => r.standing === 'earned_reward_not_set').length, asAt: deps.now(),
          },
        };
      },
    },
  ];
}
