// D-22 (R4, signed OB-227) — personal offers from purchase history, drafted in a batch and issued only when a PERSON
// approves the batch.
//
//   POST /v1/loyalty/offer-batches/:batchId            draft a batch (the discount, look-back and validity are the person's)
//   POST /v1/loyalty/offer-batches/:batchId/approve    a person approves: each offer is checked AGAIN and then issued
//   POST /v1/loyalty/offer-batches/:batchId/reject     a person rejects it: nothing is issued
//   GET  /v1/loyalty/offer-batches                     the batches and where each stands
//   GET  /v1/loyalty/offer-batches/:batchId            one batch: every offer and every member left out, with the reason
//   POST /v1/customer/age-confirmations/:customerRef   a person records that they saw the member is 18 or over (or not)
//
// The rules are the tested `draftPersonalOffers` / `offerGate` / `priceTheOffer` in `packages/loyalty`:
//   • consent is BOTH profiling and marketing, from the customer's own consent ledger ("no consent");
//   • only a member a person has confirmed as 18 or over gets one; a child or an unconfirmed age gets none ("child or age
//     unknown") — no date of birth is kept, only the person's yes/no and who said it;
//   • OB-42: no more than 2 offers per member in 7 days — checked when drafting and again when issuing;
//   • the offer price is never below cost and never above MRP; an unknown cost or MRP is said, never taken as zero.
//
// What this NEVER does: issue an offer without a person's approval, or let anything but a signed-in person approve. The
// drafting route writes a DRAFT only. Issuing is the approve route's alone (permission `loyalty.offer.approve`), and each
// issued offer is an ordinary single-use coupon on the existing register (`CouponIssued`), redeemed by the existing rules.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import type { Coupon } from '../../../packages/loyalty/src/coupons';
import {
  draftPersonalOffers, offerGate, InvalidOfferDraftError, OFFER_EXCLUSION_WORDS, OFFER_CAP,
  type OfferMember, type MemberPurchaseLine, type OfferPricing, type DraftedOffer, type ExcludedMember, type OfferExclusion,
} from '../../../packages/loyalty/src/next-best-offer';

export interface AgeConfirmation {
  readonly customerRef: string;
  /** true: the person saw the member is 18 or over. false: under 18. No date of birth is kept. */
  readonly adult: boolean;
  readonly confirmedBy: string;
  readonly confirmedAt: string;
}

export interface OfferBatch {
  readonly batchId: string;
  readonly state: 'drafted' | 'approved' | 'rejected';
  readonly draftedBy: string;
  readonly draftedAt: string;
  readonly discountBps: number;
  readonly lookbackDays: number;
  readonly validDays: number;
  readonly fromDay: string;
  readonly asOfDay: string;
  readonly offers: readonly DraftedOffer[];
  readonly excluded: readonly ExcludedMember[];
  readonly approvedBy?: string;
  readonly approvedAt?: string;
  readonly issued?: readonly { readonly customerRef: string; readonly code: string; readonly productId: string; readonly discountMinor: number; readonly validUntil: string }[];
  /** Offers the approval did NOT issue because the member's standing changed since drafting — each with the reason. */
  readonly notIssued?: readonly ExcludedMember[];
  readonly rejectedBy?: string;
  readonly rejectedAt?: string;
  readonly rejectReason?: string;
}

export interface OfferProposalDeps {
  readonly now: () => string;
  /** The members an offer may be drafted for, each with consent (both purposes) and age as recorded now. */
  readonly members: (tenantId: string) => Promise<readonly OfferMember[]>;
  /** One member as recorded now (re-checked at issue). */
  readonly member: (tenantId: string, customerRef: string) => Promise<OfferMember>;
  /** The lines of the banked bills that named a member, booked to trading days in [fromDay, toDay]. */
  readonly purchases: (tenantId: string, fromDay: string, toDay: string) => Promise<readonly MemberPurchaseLine[]>;
  /** The shelf price, MRP and cost of each product as head office knows them now. */
  readonly pricing: (tenantId: string) => Promise<(productId: string) => OfferPricing>;
  readonly batches: (tenantId: string) => Promise<readonly OfferBatch[]>;
  /** Append one state of a batch (never an edit). */
  readonly recordBatch: (tenantId: string, batch: OfferBatch) => Promise<void>;
  /** The EXISTING coupon register: does the code exist, and issue one. */
  readonly couponExists: (tenantId: string, code: string) => Promise<boolean>;
  readonly issueCoupon: (tenantId: string, coupon: Coupon, key: string) => Promise<void>;
  readonly ageConfirmations: (tenantId: string) => Promise<readonly AgeConfirmation[]>;
  readonly recordAgeConfirmation: (tenantId: string, c: AgeConfirmation) => Promise<void>;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const wholeIn = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00.000Z`) + n * 86_400_000).toISOString().slice(0, 10);
const bad = (code: string, whatHappened: string): never => {
  throw apiError(400, { code, whatHappened, wasItSaved: 'not_saved', nextSafeAction: 'Correct the request and send it again. Nothing was changed.' });
};

/** The latest state of each batch (one event per state). */
export function latestBatches(all: readonly OfferBatch[]): OfferBatch[] {
  const by = new Map<string, OfferBatch>();
  for (const b of all) by.set(b.batchId, b);
  return [...by.values()];
}

/** The days each member was issued a D-22 offer — what the OB-42 cap counts. */
export function issuedDaysByMember(batches: readonly OfferBatch[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const b of latestBatches(batches)) {
    if (b.state !== 'approved' || b.approvedAt === undefined) continue;
    for (const i of b.issued ?? []) out.set(i.customerRef, [...(out.get(i.customerRef) ?? []), b.approvedAt.slice(0, 10)]);
  }
  return out;
}

export const offerCouponCode = (batchId: string, customerRef: string): string => `nbo-${batchId}-${customerRef}`;

export function offerProposalRoutes(deps: OfferProposalDeps): readonly Route[] {
  const findBatch = async (tenantId: string, batchId: string): Promise<OfferBatch | undefined> =>
    latestBatches(await deps.batches(tenantId)).find((b) => b.batchId === batchId);
  const audit = async (ctx: { tenantId: string; userId: string; branchId: string | null }, action: string, batchId: string, after: Record<string, string>) => {
    await deps.recordAudit?.(ctx.tenantId, {
      actorId: ctx.userId, action, objectType: 'offer_batch', objectId: batchId, at: deps.now(),
      origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null }, before: null, after, reason: 'D-22 personal offers', correlationId: `offer-batch-${batchId}`,
    });
  };
  return [
    {
      api: 'API-06', method: 'POST', path: '/v1/loyalty/offer-batches/:batchId',
      permission: 'loyalty.offer.draft', entitlement: 'loyalty', idempotent: true,
      handler: async (ctx) => {
        const batchId = (ctx.params['batchId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (batchId === '' || !/^[A-Za-z0-9_-]{1,40}$/.test(batchId)) bad('not_readable_as_an_offer_batch', 'A batch id is 1–40 letters, digits, - or _.');
        if (!wholeIn(b['discountBps'], 1, 9_999) || !wholeIn(b['lookbackDays'], 1, 366) || !wholeIn(b['validDays'], 1, 90)) {
          bad('not_readable_as_an_offer_batch', 'A batch needs { discountBps (1–9999; 1% = 100), lookbackDays (1–366), validDays (1–90) } — each is your choice; none is assumed.');
        }
        const prior = await findBatch(ctx.tenantId, batchId);
        if (prior !== undefined) return { status: 200, body: { batch: prior, alreadyDrafted: true } };
        const asOfDay = deps.now().slice(0, 10);
        const fromDay = addDays(asOfDay, -((b['lookbackDays'] as number) - 1));
        const issued = issuedDaysByMember(await deps.batches(ctx.tenantId));
        let drafted;
        try {
          drafted = draftPersonalOffers({
            members: await deps.members(ctx.tenantId),
            purchases: await deps.purchases(ctx.tenantId, fromDay, asOfDay),
            pricing: await deps.pricing(ctx.tenantId),
            issuedDays: (ref) => issued.get(ref) ?? [],
            discountBps: b['discountBps'] as number, fromDay, asOfDay,
          });
        } catch (e) {
          if (e instanceof InvalidOfferDraftError) return bad('not_readable_as_an_offer_batch', e.message);
          throw e;
        }
        const batch: OfferBatch = {
          batchId, state: 'drafted', draftedBy: ctx.userId, draftedAt: deps.now(),
          discountBps: b['discountBps'] as number, lookbackDays: b['lookbackDays'] as number, validDays: b['validDays'] as number,
          fromDay, asOfDay, offers: drafted.offers, excluded: drafted.excluded,
        };
        await deps.recordBatch(ctx.tenantId, batch);
        await audit(ctx, 'offer.batch.drafted', batchId, { offers: String(batch.offers.length), excluded: String(batch.excluded.length) });
        return { status: 201, body: { batch, issuedAnything: false, detail: 'Drafted. No offer is issued until a person approves this batch.' } };
      },
    },
    {
      api: 'API-06', method: 'POST', path: '/v1/loyalty/offer-batches/:batchId/approve',
      permission: 'loyalty.offer.approve', entitlement: 'loyalty', idempotent: true,
      handler: async (ctx) => {
        const batchId = (ctx.params['batchId'] ?? '').trim();
        const batch = await findBatch(ctx.tenantId, batchId);
        if (batch === undefined) throw notFound(`offer batch ${batchId}`);
        if (batch.state === 'approved') return { status: 200, body: { batch, alreadyApproved: true } };
        if (batch.state === 'rejected') {
          throw apiError(409, { code: 'offer_batch_rejected', whatHappened: `Batch ${batchId} was rejected by ${batch.rejectedBy ?? 'someone'}; it cannot be approved.`, wasItSaved: 'not_saved', nextSafeAction: 'Draft a new batch. Nothing was issued.' });
        }
        const at = deps.now();
        const today = at.slice(0, 10);
        const validUntil = addDays(today, batch.validDays - 1);
        const issuedDays = issuedDaysByMember(await deps.batches(ctx.tenantId));
        const issued: { customerRef: string; code: string; productId: string; discountMinor: number; validUntil: string }[] = [];
        const notIssued: ExcludedMember[] = [];
        for (const offer of batch.offers) {
          // Checked AGAIN at issue: consent withdrawn, an age now recorded as under 18, or the cap filled since drafting.
          const member = await deps.member(ctx.tenantId, offer.customerRef);
          const days = issuedDays.get(offer.customerRef) ?? [];
          const gate: OfferExclusion | undefined = offerGate(member, days, today);
          if (gate !== undefined) { notIssued.push({ customerRef: offer.customerRef, reason: gate, words: OFFER_EXCLUSION_WORDS[gate] }); continue; }
          const code = offerCouponCode(batchId, offer.customerRef);
          if (!(await deps.couponExists(ctx.tenantId, code))) {
            const coupon: Coupon = {
              code, kind: 'amount_off', valueMinor: offer.discountMinor, issuedTo: offer.customerRef, issuedAt: at, validUntil,
              maxRedemptions: 1, maxPerCustomer: 1, minimumBasketMinor: offer.shelfPriceMinor, personalised: true,
            };
            await deps.issueCoupon(ctx.tenantId, coupon, `${batchId}-${offer.customerRef}`);
          }
          issued.push({ customerRef: offer.customerRef, code, productId: offer.productId, discountMinor: offer.discountMinor, validUntil });
          issuedDays.set(offer.customerRef, [...days, today]);
        }
        const approved: OfferBatch = { ...batch, state: 'approved', approvedBy: ctx.userId, approvedAt: at, issued, notIssued };
        await deps.recordBatch(ctx.tenantId, approved);
        await audit(ctx, 'offer.batch.approved', batchId, { issued: String(issued.length), notIssued: String(notIssued.length) });
        return { status: 200, body: { batch: approved, cap: OFFER_CAP } };
      },
    },
    {
      api: 'API-06', method: 'POST', path: '/v1/loyalty/offer-batches/:batchId/reject',
      permission: 'loyalty.offer.approve', entitlement: 'loyalty', idempotent: true,
      handler: async (ctx) => {
        const batchId = (ctx.params['batchId'] ?? '').trim();
        const reason = ((ctx.body ?? {}) as { reason?: unknown }).reason;
        if (!isStr(reason)) bad('rejection_needs_a_reason', 'Rejecting a batch needs { reason }.');
        const batch = await findBatch(ctx.tenantId, batchId);
        if (batch === undefined) throw notFound(`offer batch ${batchId}`);
        if (batch.state === 'rejected') return { status: 200, body: { batch } };
        if (batch.state === 'approved') {
          throw apiError(409, { code: 'offer_batch_already_approved', whatHappened: `Batch ${batchId} was approved by ${batch.approvedBy ?? 'someone'} and its offers are issued.`, wasItSaved: 'not_saved', nextSafeAction: 'Nothing was changed.' });
        }
        const rejected: OfferBatch = { ...batch, state: 'rejected', rejectedBy: ctx.userId, rejectedAt: deps.now(), rejectReason: (reason as string).slice(0, 300) };
        await deps.recordBatch(ctx.tenantId, rejected);
        await audit(ctx, 'offer.batch.rejected', batchId, { reason: rejected.rejectReason ?? '' });
        return { status: 200, body: { batch: rejected } };
      },
    },
    {
      api: 'API-06', method: 'GET', path: '/v1/loyalty/offer-batches',
      permission: 'loyalty.coupon.read', entitlement: 'loyalty',
      handler: async (ctx) => {
        const batches = latestBatches(await deps.batches(ctx.tenantId)).sort((a, b) => b.draftedAt.localeCompare(a.draftedAt));
        return { status: 200, body: { batches: batches.map((b) => ({ batchId: b.batchId, state: b.state, draftedBy: b.draftedBy, draftedAt: b.draftedAt, offers: b.offers.length, excluded: b.excluded.length, approvedBy: b.approvedBy ?? null, issued: b.issued?.length ?? 0 })), cap: OFFER_CAP, asAt: deps.now() } };
      },
    },
    {
      api: 'API-06', method: 'GET', path: '/v1/loyalty/offer-batches/:batchId',
      permission: 'loyalty.coupon.read', entitlement: 'loyalty',
      handler: async (ctx) => {
        const batch = await findBatch(ctx.tenantId, (ctx.params['batchId'] ?? '').trim());
        if (batch === undefined) throw notFound(`offer batch ${ctx.params['batchId'] ?? ''}`);
        return { status: 200, body: { batch, cap: OFFER_CAP, asAt: deps.now() } };
      },
    },
    {
      api: 'API-06', method: 'POST', path: '/v1/customer/age-confirmations/:customerRef',
      permission: 'customer.age.confirm', idempotent: true,
      handler: async (ctx) => {
        const customerRef = (ctx.params['customerRef'] ?? '').trim();
        const b = (ctx.body ?? {}) as { adult?: unknown; dateOfBirth?: unknown };
        if (b.dateOfBirth !== undefined) bad('date_of_birth_not_kept', 'A date of birth is not kept here. Record only whether you saw the member is 18 or over: { adult: true | false }.');
        if (customerRef === '' || typeof b.adult !== 'boolean') bad('not_readable_as_an_age_confirmation', 'An age confirmation is { adult: true | false } — whether you saw the member is 18 or over.');
        const c: AgeConfirmation = { customerRef, adult: b.adult as boolean, confirmedBy: ctx.userId, confirmedAt: deps.now() };
        await deps.recordAgeConfirmation(ctx.tenantId, c);
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: 'customer.age.confirmed', objectType: 'customer', objectId: customerRef, at: c.confirmedAt,
          origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null }, before: null, after: { adult: String(c.adult) }, reason: 'D-22 adult check', correlationId: `age-${customerRef}-${c.confirmedAt}`,
        });
        return { status: 201, body: { confirmation: c } };
      },
    },
  ];
}

/** A member's age as the confirmations say (latest wins): 'adult', 'child', or 'unknown' when nobody has confirmed it. */
export function ageOf(confirmations: readonly AgeConfirmation[], customerRef: string): 'adult' | 'child' | 'unknown' {
  const mine = confirmations.filter((c) => c.customerRef === customerRef);
  const last = mine[mine.length - 1];
  return last === undefined ? 'unknown' : last.adult ? 'adult' : 'child';
}
