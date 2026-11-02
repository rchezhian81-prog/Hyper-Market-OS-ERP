// Coupons and gift cards at the till with the internet down (W3 · D06-FR-03 · OB-673 · D07-FR-04 · OB-677 · M17-FR-02/03 ·
// §31 · hard rules #1 #2 #3 #10 · P-01 · P-08).
//
// The owner decided both in writing on 2 Nov 2026:
//   • OB-673 "A" — the till ACCEPTS a coupon with the internet down and the sale goes through. A coupon used twice (on two
//     tills, or beyond its limit) shows at head office as an exception for the manager — never silent, never a
//     last-write-wins, and it never stops the sale.
//   • OB-677 "A" — a gift card is taken at the till offline up to ₹500 per till per card (the owner's limit, a tenant setting
//     that rides the signed store pack); above it the till asks for another payment until the link is back. A card overspent
//     across tills shows as an exception for the manager. Selling a gift card commits locally and syncs.
//
// So the store computer must be able to judge both with no network. Head office signs into the store pack what that needs:
//   • `coupons`   — every live coupon and every redemption head office holds of it;
//   • `giftCards` — every gift card with its balance, the till redemptions already folded into that balance, and the cap.
// The store computer adds what its own sale log says it did since (a redemption not yet in the copy is still counted), so a
// restart with the cable out forgets nothing. Everything here is PURE: records in, answers out — the box, the till and head
// office run the same rules.
//
// A gift card is a stored-value instrument identified by its OWN code — never a bank card (hard rule #3). A code shaped like a
// bank card number is refused outright, and a code is never printed whole: `maskVoucherCode` shows its last four.

import { holdsCardNumber } from '../../tender/src/tender-card-data';
import { shopDateIn } from '../../calendar/src/shop-clock';
import type { Coupon, CouponKind, Redemption } from './coupons';

/** OB-677: the owner's answer — ₹500 per till per card while head office cannot be reached. */
export const DEFAULT_GIFT_CARD_OFFLINE_CAP_MINOR = 50_000;

/** A coupon list older than this (minutes) is said to be possibly stale on the till (the coupon engine's own default). */
export const COUPON_STALE_AFTER_MINUTES = 15;

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined);
const whole = (v: unknown): number | undefined => (typeof v === 'number' && Number.isSafeInteger(v) ? v : undefined);
const KINDS: readonly CouponKind[] = ['amount_off', 'percent_off', 'free_item', 'referral', 'membership'];

// ── the store pack's two sections ───────────────────────────────────────────────────────────────────────────────────

export interface CouponPack {
  /** When this copy reached the store computer (the pack carries no clock of its own, so an unchanged pack is unchanged). */
  readonly asOf: string;
  readonly coupons: readonly Coupon[];
  /** Every redemption head office holds of those coupons (till, app and web alike). */
  readonly redemptions: readonly Redemption[];
}

export interface GiftCardPackCard {
  readonly code: string;
  /** The balance head office folded from every movement on the card when it built the pack. */
  readonly balanceMinor: number;
  readonly expiresOn?: string;
  /** The till redemptions already inside that balance — so the box does not take them off a second time. */
  readonly appliedMovementIds: readonly string[];
}

export interface GiftCardPack {
  /** When this copy reached the store computer. */
  readonly asOf: string;
  /** The owner's offline limit per till per card, from the tenant's setting (OB-677). */
  readonly offlineCapMinor: number;
  readonly cards: readonly GiftCardPackCard[];
}

function readCoupon(v: unknown): Coupon | undefined {
  if (!isRec(v)) return undefined;
  const code = str(v['code']);
  const kind = v['kind'];
  const issuedAt = str(v['issuedAt']);
  const validUntil = str(v['validUntil']);
  const maxRedemptions = whole(v['maxRedemptions']);
  const maxPerCustomer = whole(v['maxPerCustomer']);
  if (code === undefined || typeof kind !== 'string' || !(KINDS as readonly string[]).includes(kind) || issuedAt === undefined
    || validUntil === undefined || maxRedemptions === undefined || maxPerCustomer === undefined) return undefined;
  const opt = (k: string): Rec => (whole(v[k]) === undefined ? {} : { [k]: v[k] });
  return {
    code, kind: kind as CouponKind, issuedAt, validUntil, maxRedemptions, maxPerCustomer,
    ...opt('valueMinor'), ...opt('percentBps'), ...opt('minimumBasketMinor'),
    ...(str(v['issuedTo']) === undefined ? {} : { issuedTo: v['issuedTo'] as string }),
    ...(Array.isArray(v['eligibleTo']) ? { eligibleTo: (v['eligibleTo'] as unknown[]).filter((x): x is string => typeof x === 'string') } : {}),
    ...(typeof v['personalised'] === 'boolean' ? { personalised: v['personalised'] } : {}),
  } as Coupon;
}

function readRedemption(v: unknown): Redemption | undefined {
  if (!isRec(v)) return undefined;
  const redemptionId = str(v['redemptionId']); const code = str(v['code']); const at = str(v['at']); const saleId = str(v['saleId']);
  if (redemptionId === undefined || code === undefined || at === undefined || saleId === undefined) return undefined;
  return { redemptionId, code, at, saleId, ...(str(v['customerRef']) === undefined ? {} : { customerRef: v['customerRef'] as string }) };
}

/** The pack's `coupons` section, read defensively (a part that does not read is left out, never guessed). */
export function readCouponPack(v: unknown, asOf: string): CouponPack | undefined {
  if (!isRec(v) || !Array.isArray(v['coupons']) || !Array.isArray(v['redemptions'])) return undefined;
  return {
    asOf,
    coupons: (v['coupons'] as unknown[]).flatMap((c) => { const r = readCoupon(c); return r === undefined ? [] : [r]; }),
    redemptions: (v['redemptions'] as unknown[]).flatMap((c) => { const r = readRedemption(c); return r === undefined ? [] : [r]; }),
  };
}

/** The pack's `giftCards` section. A missing cap is the owner's default (₹500), never "no limit". */
export function readGiftCardPack(v: unknown, asOf: string): GiftCardPack | undefined {
  if (!isRec(v) || !Array.isArray(v['cards'])) return undefined;
  const cap = whole(v['offlineCapMinor']);
  return {
    asOf,
    offlineCapMinor: cap !== undefined && cap >= 0 ? cap : DEFAULT_GIFT_CARD_OFFLINE_CAP_MINOR,
    cards: (v['cards'] as unknown[]).flatMap((c) => {
      if (!isRec(c) || str(c['code']) === undefined || whole(c['balanceMinor']) === undefined) return [];
      return [{
        code: c['code'] as string, balanceMinor: c['balanceMinor'] as number,
        ...(str(c['expiresOn']) === undefined ? {} : { expiresOn: c['expiresOn'] as string }),
        appliedMovementIds: Array.isArray(c['appliedMovementIds']) ? (c['appliedMovementIds'] as unknown[]).filter((x): x is string => typeof x === 'string') : [],
      }];
    }),
  };
}

// ── identities ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** The movement a till's gift-card tender becomes at head office — the same id on every resend (hard rule #2, idempotent). */
export const giftCardMovementId = (saleId: string, tenderIndex: number): string => `till:${saleId}:gc${tenderIndex}`;
/** The redemption a coupon on a till bill becomes at head office — one per bill and code, the same on every resend. */
export const couponRedemptionId = (saleId: string, code: string): string => `till:${saleId}:${code}`;

/** A code as a receipt or a screen may show it: its last four, the rest hidden (like every instrument reference). */
export function maskVoucherCode(code: string): string {
  const c = code.replace(/\s+/g, '');
  return c.length <= 4 ? '••••' : `••••${c.slice(-4)}`;
}

/** A typed code in its one form: trimmed, spaces removed, capitals. */
export const normalVoucherCode = (raw: string): string => raw.replace(/\s+/g, '').toUpperCase();

/**
 * Why a code cannot be a gift card's, or undefined. Letters, digits and dashes, 4 to 32 long — and NEVER shaped like a bank
 * card number: the shop never stores a card number (hard rule #3), so a code that looks like one is refused, not kept.
 */
export function giftCardCodeRefusal(code: string): string | undefined {
  if (!/^[A-Z0-9-]{4,32}$/.test(code)) return 'A gift card code is 4 to 32 letters, digits or dashes. Check the code on the card.';
  if (holdsCardNumber(code)) return 'That looks like a bank card number, not one of the shop\'s gift cards. Never type a bank card number here.';
  return undefined;
}

// ── what a sale record on the box's disk did ──────────────────────────────────────────────────────────────────────────

export interface LocalGiftCardSpend {
  readonly movementId: string;
  readonly code: string;
  readonly amountMinor: number;
  readonly laneId: string;
  readonly capturedOffline: boolean;
  readonly saleId: string;
}
export interface LocalGiftCardSold {
  readonly code: string;
  readonly faceValueMinor: number;
  readonly saleId: string;
  readonly committedAt: string;
}
export interface LocalVoucherUses {
  readonly spends: readonly LocalGiftCardSpend[];
  readonly sold: readonly LocalGiftCardSold[];
  readonly couponUses: readonly Redemption[];
}

const tenderAmount = (t: Rec): number => whole(t['amountMinor']) ?? whole(isRec(t['amount']) ? (t['amount'] as Rec)['minor'] : undefined) ?? 0;

/** The record kind a gift card's sale is written under on the box's sale log — never a goods bill. */
export const GIFT_CARD_SALE_KIND = 'gift_card_sale';
export const isGiftCardSaleRecord = (rec: unknown): boolean => isRec(rec) && rec['kind'] === GIFT_CARD_SALE_KIND;

/** What one sale-log record did to coupons and gift cards. Pure; a record that does not read gives nothing. */
export function vouchersOfSaleRecord(rec: unknown): LocalVoucherUses {
  if (!isRec(rec)) return { spends: [], sold: [], couponUses: [] };
  const saleId = str(rec['id']) ?? str(rec['saleId']);
  if (saleId === undefined) return { spends: [], sold: [], couponUses: [] };
  const laneId = str(rec['laneId']) ?? '';
  const committedAt = str(rec['committedAt']) ?? '';
  const tenders = Array.isArray(rec['tenders']) ? rec['tenders'] as unknown[] : [];
  const spends = tenders.flatMap((t, i): LocalGiftCardSpend[] => {
    if (!isRec(t) || t['kind'] !== 'gift_card' || !isRec(t['giftCard'])) return [];
    const code = str((t['giftCard'] as Rec)['code']);
    const amountMinor = tenderAmount(t);
    if (code === undefined || amountMinor <= 0) return [];
    return [{ movementId: giftCardMovementId(saleId, i), code, amountMinor, laneId, capturedOffline: (t['giftCard'] as Rec)['capturedOffline'] === true, saleId }];
  });
  const sold = isGiftCardSaleRecord(rec) && Array.isArray(rec['giftCardsSold'])
    ? (rec['giftCardsSold'] as unknown[]).flatMap((c) => (isRec(c) && str(c['code']) !== undefined && (whole(c['faceValueMinor']) ?? 0) > 0
      ? [{ code: c['code'] as string, faceValueMinor: c['faceValueMinor'] as number, saleId, committedAt }] : []))
    : [];
  const couponUses = Array.isArray(rec['coupons'])
    ? (rec['coupons'] as unknown[]).flatMap((c): Redemption[] => {
      if (!isRec(c) || str(c['code']) === undefined) return [];
      const code = c['code'] as string;
      return [{ redemptionId: couponRedemptionId(saleId, code), code, saleId, at: committedAt, ...(str(rec['customerRef']) === undefined ? {} : { customerRef: rec['customerRef'] as string }) }];
    })
    : [];
  return { spends, sold, couponUses };
}

// ── a gift card at this store computer ───────────────────────────────────────────────────────────────────────────────

export type GiftCardAvailability =
  | { readonly known: false; readonly refusedBecause: 'gift_cards_not_known' | 'gift_card_not_known' | 'code_not_valid'; readonly laneMessage: string }
  | {
    readonly known: true;
    readonly last4: string;
    /** The balance as far as this box can tell: head office's copy less this box's redemptions not yet in it. */
    readonly balanceMinor: number;
    readonly expiresOn?: string;
    readonly expired: boolean;
    /** Whether this box can reach head office now (OB-677: the offline limit applies only when it cannot). */
    readonly linkUp: boolean;
    readonly offlineCapMinor: number;
    /** What THIS till may still take from this card offline (the cap less this till's offline takings not yet in the copy). */
    readonly offlineRemainingMinor: number;
    /** The most this till may take now: the balance — and, offline, never above what the cap still allows. */
    readonly mayTakeMinor: number;
    readonly asOf: string;
  };

export function giftCardAvailable(input: {
  readonly pack: GiftCardPack | undefined;
  readonly code: string;
  readonly uses: LocalVoucherUses;
  readonly laneId: string;
  readonly linkUp: boolean;
  /** The shop's date now (the shop's clock — never the UTC date). */
  readonly today: string;
}): GiftCardAvailability {
  const code = normalVoucherCode(input.code);
  const bad = giftCardCodeRefusal(code);
  if (bad !== undefined) return { known: false, refusedBecause: 'code_not_valid', laneMessage: bad };
  if (input.pack === undefined) {
    return { known: false, refusedBecause: 'gift_cards_not_known', laneMessage: 'This store computer has not been told the gift cards yet, so no gift card can be taken here now. Take another payment.' };
  }
  const card = input.pack.cards.find((c) => c.code === code);
  const soldHere = input.uses.sold.filter((s) => s.code === code);
  if (card === undefined && soldHere.length === 0) {
    return { known: false, refusedBecause: 'gift_card_not_known', laneMessage: `Gift card ${maskVoucherCode(code)} is not one this store knows. Check the code, or take another payment.` };
  }
  const applied = new Set(card?.appliedMovementIds ?? []);
  const pending = input.uses.spends.filter((s) => s.code === code && !applied.has(s.movementId));
  // A card sold on this box and not yet in head office's copy starts at its face value.
  const opening = card !== undefined ? card.balanceMinor : soldHere.reduce((n, s) => n + s.faceValueMinor, 0);
  const balanceMinor = Math.max(0, opening - pending.reduce((n, s) => n + s.amountMinor, 0));
  const expired = card?.expiresOn !== undefined && input.today > card.expiresOn;
  const offlineTaken = pending.filter((s) => s.laneId === input.laneId && s.capturedOffline).reduce((n, s) => n + s.amountMinor, 0);
  const offlineRemainingMinor = Math.max(0, input.pack.offlineCapMinor - offlineTaken);
  const mayTakeMinor = expired ? 0 : input.linkUp ? balanceMinor : Math.min(balanceMinor, offlineRemainingMinor);
  return {
    known: true, last4: code.slice(-4), balanceMinor, ...(card?.expiresOn === undefined ? {} : { expiresOn: card.expiresOn }), expired,
    linkUp: input.linkUp, offlineCapMinor: input.pack.offlineCapMinor, offlineRemainingMinor, mayTakeMinor, asOf: input.pack.asOf,
  };
}

export type VoucherCheck =
  | { readonly ok: true; readonly record: Rec }
  | { readonly ok: false; readonly refusedBecause: string; readonly laneMessage: string };

const inr = (minor: number): string => `₹${(minor / 100).toFixed(2)}`;

/**
 * A sale's gift-card tenders, judged on the box before its disk (OB-677): each card known, not expired, its total on this
 * bill within what this till may take now. On success each tender is STAMPED with whether the box took it offline — the
 * fact head office and the next decision read. A refusal says what to do: take another payment.
 */
export function assessGiftCardTenders(input: {
  readonly record: Rec;
  readonly pack: GiftCardPack | undefined;
  readonly uses: LocalVoucherUses;
  readonly laneId: string;
  readonly linkUp: boolean;
  readonly today: string;
}): VoucherCheck {
  const tenders = Array.isArray(input.record['tenders']) ? input.record['tenders'] as unknown[] : [];
  const byCode = new Map<string, number>();
  for (const t of tenders) {
    if (!isRec(t) || t['kind'] !== 'gift_card') continue;
    const code = isRec(t['giftCard']) ? str((t['giftCard'] as Rec)['code']) : undefined;
    const amount = tenderAmount(t);
    if (code === undefined || amount <= 0) {
      return { ok: false, refusedBecause: 'gift_card_tender_not_readable', laneMessage: 'A gift card payment needs the card\'s code and an amount. Nothing was saved.' };
    }
    byCode.set(normalVoucherCode(code), (byCode.get(normalVoucherCode(code)) ?? 0) + amount);
  }
  for (const [code, amount] of byCode) {
    const a = giftCardAvailable({ pack: input.pack, code, uses: input.uses, laneId: input.laneId, linkUp: input.linkUp, today: input.today });
    if (!a.known) return { ok: false, refusedBecause: a.refusedBecause, laneMessage: `${a.laneMessage} Nothing was saved.` };
    if (a.expired) return { ok: false, refusedBecause: 'gift_card_expired', laneMessage: `Gift card ${maskVoucherCode(code)} expired on ${a.expiresOn}. Take another payment. Nothing was saved.` };
    if (amount > a.balanceMinor) {
      return { ok: false, refusedBecause: 'gift_card_balance_too_low', laneMessage: `Gift card ${maskVoucherCode(code)} holds ${inr(a.balanceMinor)}, not ${inr(amount)}. Take the rest another way. Nothing was saved.` };
    }
    if (!input.linkUp && amount > a.offlineRemainingMinor) {
      return {
        ok: false, refusedBecause: 'gift_card_over_offline_limit',
        laneMessage: `The store computer cannot reach head office, so this till may take at most ${inr(a.offlineRemainingMinor)} more from gift card ${maskVoucherCode(code)} until the link is back (the owner's limit is ${inr(a.offlineCapMinor)}). Take the rest another way. Nothing was saved.`,
      };
    }
  }
  const stamped = tenders.map((t) => {
    if (!isRec(t) || t['kind'] !== 'gift_card' || !isRec(t['giftCard'])) return t;
    const code = normalVoucherCode(str((t['giftCard'] as Rec)['code']) ?? '');
    return { ...t, giftCard: { code, ...(input.linkUp ? {} : { capturedOffline: true }) } };
  });
  return { ok: true, record: { ...input.record, tenders: stamped } };
}

/**
 * A gift card's SALE (OB-677 "selling a gift card commits locally and syncs"), judged on the box before its disk: every
 * code new to this store (never one head office or this box already holds), a positive whole value, paid in cash, card or
 * UPI to exactly its value. It is not a goods bill: no lines, no tax invoice — GST falls on the redemption (A12, s.12(4)).
 */
export function assessGiftCardSale(input: { readonly record: Rec; readonly pack: GiftCardPack | undefined; readonly uses: LocalVoucherUses }): VoucherCheck {
  const r = input.record;
  const cards = Array.isArray(r['giftCardsSold']) ? r['giftCardsSold'] as unknown[] : [];
  if (cards.length === 0) return { ok: false, refusedBecause: 'gift_card_sale_not_readable', laneMessage: 'A gift card sale names the card and its value. Nothing was saved.' };
  const seen = new Set<string>();
  let value = 0;
  const kept: Rec[] = [];
  for (const c of cards) {
    const code = isRec(c) ? normalVoucherCode(str(c['code']) ?? '') : '';
    const face = isRec(c) ? whole(c['faceValueMinor']) ?? 0 : 0;
    const bad = giftCardCodeRefusal(code);
    if (bad !== undefined) return { ok: false, refusedBecause: 'code_not_valid', laneMessage: `${bad} Nothing was saved.` };
    if (face <= 0) return { ok: false, refusedBecause: 'gift_card_value_not_valid', laneMessage: 'A gift card\'s value is a positive amount. Nothing was saved.' };
    if (seen.has(code) || input.pack?.cards.some((k) => k.code === code) === true || input.uses.sold.some((s) => s.code === code)) {
      return { ok: false, refusedBecause: 'gift_card_already_issued', laneMessage: `Gift card ${maskVoucherCode(code)} has already been sold — selling it again would create money the shop never took. Use a new card. Nothing was saved.` };
    }
    seen.add(code);
    value += face;
    kept.push({ code, faceValueMinor: face });
  }
  const total = whole(r['total']) ?? whole(r['totalMinor']);
  if (total !== value) return { ok: false, refusedBecause: 'gift_card_sale_does_not_add_up', laneMessage: 'The gift card sale\'s total is not the cards\' value. Nothing was saved.' };
  const tenders = Array.isArray(r['tenders']) ? r['tenders'] as unknown[] : [];
  if (tenders.some((t) => !isRec(t) || !['cash', 'card', 'upi'].includes(String(t['kind'])))) {
    return { ok: false, refusedBecause: 'gift_card_sale_tender_not_allowed', laneMessage: 'A gift card is bought with cash, card or UPI. Nothing was saved.' };
  }
  return { ok: true, record: { ...r, lines: [], giftCardsSold: kept } };
}

// ── a coupon at this store computer, for the till ────────────────────────────────────────────────────────────────────

/** The marker the till's coupon engine reads for "the customer on this bill" (the box never hands a member code to a till). */
export const THIS_CUSTOMER = 'this-customer';
const SOMEONE_ELSE = 'someone-else';

export type CouponForTill =
  | { readonly known: false; readonly refusedBecause: 'coupons_not_known' | 'coupon_not_known'; readonly laneMessage: string }
  | {
    readonly known: true;
    /** The coupon, with who it was issued to replaced by THIS_CUSTOMER or someone else's marker. */
    readonly coupon: Coupon;
    /** Every use this box knows of: head office's and this box's own not yet in the copy (customers likewise replaced). */
    readonly knownRedemptions: readonly Redemption[];
    /** THIS_CUSTOMER when the bill names a member; absent for a guest. */
    readonly customerRef?: string;
    readonly customerSegments: readonly string[];
    /** How old head office's list is, in minutes — the till says a use elsewhere may not be counted yet when it is old. */
    readonly cacheAgeMinutes: number;
    readonly staleAfterMinutes: number;
  };

export function couponForTill(input: {
  readonly pack: CouponPack | undefined;
  readonly code: string;
  readonly uses: LocalVoucherUses;
  /** The member code the box made from the number keyed on this bill, if any. */
  readonly memberRef?: string;
  /** Whether that member is one head office's members list holds. */
  readonly isMember?: boolean;
  readonly now: string;
}): CouponForTill {
  if (input.pack === undefined) {
    return { known: false, refusedBecause: 'coupons_not_known', laneMessage: 'This store computer has not been told the shop\'s coupons yet, so a coupon cannot be taken here now.' };
  }
  const code = input.code.trim();
  const coupon = input.pack.coupons.find((c) => c.code === code) ?? input.pack.coupons.find((c) => c.code.toUpperCase() === code.toUpperCase());
  if (coupon === undefined) {
    return { known: false, refusedBecause: 'coupon_not_known', laneMessage: `Coupon ${code} is not one of the shop's live coupons. Check the code.` };
  }
  const who = (ref: string | undefined): string | undefined => (ref === undefined ? undefined : ref === input.memberRef ? THIS_CUSTOMER : SOMEONE_ELSE);
  const ids = new Set(input.pack.redemptions.map((r) => r.redemptionId));
  const all = [...input.pack.redemptions.filter((r) => r.code === coupon.code), ...input.uses.couponUses.filter((r) => r.code === coupon.code && !ids.has(r.redemptionId))];
  const ageMinutes = Math.max(0, Math.floor((Date.parse(input.now) - Date.parse(input.pack.asOf)) / 60_000));
  const { issuedTo, ...rest } = coupon;
  return {
    known: true,
    coupon: { ...rest, ...(issuedTo === undefined ? {} : { issuedTo: who(issuedTo)! }) },
    knownRedemptions: all.map((r) => { const { customerRef, ...x } = r; const c = who(customerRef); return { ...x, ...(c === undefined ? {} : { customerRef: c }) }; }),
    ...(input.memberRef === undefined ? {} : { customerRef: THIS_CUSTOMER }),
    customerSegments: input.memberRef !== undefined && input.isMember === true ? ['member'] : [],
    cacheAgeMinutes: Number.isFinite(ageMinutes) ? ageMinutes : 0,
    staleAfterMinutes: COUPON_STALE_AFTER_MINUTES,
  };
}

/** Whether a gift card's expiry has passed on the shop's date of an instant. */
export const giftCardExpiredAt = (expiresOn: string | undefined, at: string): boolean => expiresOn !== undefined && shopDateIn(at) > expiresOn;
