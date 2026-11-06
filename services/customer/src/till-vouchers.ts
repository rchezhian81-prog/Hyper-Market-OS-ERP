// Coupons and gift cards that reach head office from the till (W3 · D06-FR-03 · OB-673 · D07-FR-04 · OB-677 · M17-FR-02/03 ·
// hard rules #1 #2 #10 · P-08).
//
// The till has ALREADY given the discount or taken the gift card's value — the customer has gone home with the goods. So
// nothing here ever refuses: every use is recorded, once, under the same id on every resend (idempotent), and anything that
// should not have happened is raised as a valued exception for the manager instead of being reversed or overwritten:
//   • a coupon used past its limit (on two tills while the link was down, or after head office's last copy) →
//     `coupon_used_beyond_its_limit`; expired, unknown or not this customer's → `coupon_not_valid_when_used`;
//   • a gift card spent for more than its true balance across tills → `gift_card_overspent`, valued at the shortfall;
//     unknown or expired → `gift_card_not_valid_when_spent`;
//   • a gift card SOLD at the till whose code head office already holds → `gift_card_sold_twice`.
// The rules are the tested engines (`redeemCoupon`, `balanceOf`); this is the persistence around them.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import { ConcurrencyConflictError } from '../../../packages/persistence/src/event-store';
import { redeemCoupon, type Coupon, type Redemption } from '../../../packages/loyalty/src/coupons';
import { balanceOf, type Instrument, type ValueMovement } from '../../../packages/loyalty/src/stored-value';
import { couponRedemptionId, giftCardMovementId, giftCardExpiredAt, maskVoucherCode, giftCardCodeRefusal, normalVoucherCode } from '../../../packages/loyalty/src/till-vouchers';
import { giftCardTimeOfSupplyAtIssue, giftCardTimeOfSupplyAtRedemption } from './stored-value';
import { DEFAULT_SHOP_CALENDAR, type ShopCalendarOf } from '../../../packages/calendar/src/shop-clock';
import { tradingDayIn } from '../../../packages/calendar/src/trading-day';
import type { IncomingSale, SaleException } from '../../pos/src/sale-intake';

export interface TillVoucherDeps {
  readonly coupon: (tenantId: string, code: string) => Promise<Coupon | undefined>;
  readonly redemptions: (tenantId: string, code: string) => Promise<readonly Redemption[]>;
  readonly recordRedemption: (tenantId: string, r: Redemption, key: string) => Promise<void>;
  readonly instrument: (tenantId: string, instrumentId: string) => Promise<Instrument | undefined>;
  readonly movements: (tenantId: string, instrumentId: string) => Promise<readonly ValueMovement[]>;
  readonly instrumentVersion?: (tenantId: string, instrumentId: string) => Promise<number>;
  readonly recordMovement: (tenantId: string, instrumentId: string, m: ValueMovement, expectedVersion?: number) => Promise<void>;
  readonly recordIssue: (tenantId: string, instrument: Instrument, opening: ValueMovement) => Promise<void>;
  /** The gift-card sale itself, kept as it happened (the cash taken against the liability), once per sale. */
  readonly recordGiftCardSale: (tenantId: string, sale: TillGiftCardSale) => Promise<void>;
  readonly recordExceptions: (tenantId: string, exceptions: readonly SaleException[]) => Promise<void>;
  readonly now: () => string;
  readonly calendar?: ShopCalendarOf;
}

const inr = (minor: number): string => `₹${(minor / 100).toFixed(2)}`;
const LIMIT_OUTCOMES = new Set(['limit_reached', 'customer_limit_reached']);

/**
 * What a banked sale's coupons and gift-card tenders do at head office — applied once per sale (a resend changes nothing),
 * never refusing. Returns the exceptions it raised (already recorded) and what it did, for the sale's reply.
 */
export function tillVoucherEffects(deps: TillVoucherDeps) {
  return async (tenantId: string, sale: IncomingSale): Promise<{ readonly exceptions: readonly SaleException[]; readonly coupons: readonly unknown[]; readonly giftCards: readonly unknown[] }> => {
    const exceptions: SaleException[] = [];
    const couponOut: unknown[] = [];
    const cardOut: unknown[] = [];

    // ── coupons (OB-673) ──
    const goods = sale.lines.reduce((n, l) => n + (l.lineTotalMinor ?? 0), 0);
    for (const used of sale.coupons ?? []) {
      if (typeof used?.code !== 'string' || used.code === '') continue;
      const discountMinor = Number.isSafeInteger(used.discountMinor) && used.discountMinor > 0 ? used.discountMinor : 0;
      const redemption: Redemption = {
        redemptionId: couponRedemptionId(sale.saleId, used.code), code: used.code, saleId: sale.saleId, at: sale.committedAt,
        ...(sale.customerRef === undefined ? {} : { customerRef: sale.customerRef }),
      };
      const coupon = await deps.coupon(tenantId, used.code);
      const known = await deps.redemptions(tenantId, used.code);
      if (known.some((k) => k.redemptionId === redemption.redemptionId)) { couponOut.push({ code: used.code, alreadyRecorded: true }); continue; }
      const judged = redeemCoupon({
        coupon, redemption, knownRedemptions: known, basketMinor: goods + discountMinor,
        customerSegments: sale.customerRef === undefined ? [] : ['member'],
      });
      // The use is KEPT whatever the answer: the customer has the discount (hard rule #10 — both uses on file).
      if (coupon !== undefined) await deps.recordRedemption(tenantId, redemption, redemption.redemptionId);
      couponOut.push({ code: used.code, outcome: judged.outcome, discountMinor });
      if (!judged.redeemed) {
        const overLimit = LIMIT_OUTCOMES.has(judged.outcome);
        exceptions.push({
          kind: overLimit ? 'coupon_used_beyond_its_limit' : 'coupon_not_valid_when_used',
          severity: 'material', saleId: sale.saleId, differenceMinor: discountMinor,
          detail: `Coupon ${used.code} gave ${inr(discountMinor)} off bill ${sale.receiptNumber || sale.saleId} on till ${sale.laneId || '(not named)'}, but by head office's record ${judged.detail}.${overLimit ? ' It was used on another till or channel too before the copies met.' : ''}`,
          ownerAction: 'The customer has the goods and the discount; nothing was reversed. Decide whether to absorb it or follow it up, and check why the coupon was used again.',
        });
      } else if (discountMinor > judged.discountMinor) {
        exceptions.push({
          kind: 'coupon_not_valid_when_used', severity: 'material', saleId: sale.saleId, differenceMinor: discountMinor - judged.discountMinor,
          detail: `Coupon ${used.code} took ${inr(discountMinor)} off bill ${sale.receiptNumber || sale.saleId}; by head office's coupon it was worth ${inr(judged.discountMinor)} on this bill.`,
          ownerAction: 'The customer has the goods and the discount; nothing was reversed. Check the till that rang it.',
        });
      }
    }

    // ── gift cards spent (OB-677) ──
    for (const [index, t] of sale.tenders.entries()) {
      if (t.kind !== 'gift_card' || t.giftCard === undefined || typeof t.giftCard.code !== 'string') continue;
      const code = normalVoucherCode(t.giftCard.code);
      const movementId = giftCardMovementId(sale.saleId, index);
      const amount = t.amountMinor;
      const instrument = await deps.instrument(tenantId, code);
      if (instrument === undefined || instrument.kind !== 'gift_card') {
        exceptions.push({
          kind: 'gift_card_not_valid_when_spent', severity: 'material', saleId: sale.saleId, differenceMinor: amount,
          detail: `Gift card ${maskVoucherCode(code)} paid ${inr(amount)} on bill ${sale.receiptNumber || sale.saleId}, but head office holds no gift card with that code.`,
          ownerAction: 'The customer has the goods. Find the card: it may have been sold on a store computer that has not synced yet. Nothing was taken off any card.',
        });
        cardOut.push({ card: maskVoucherCode(code), outcome: 'not_known' });
        continue;
      }
      let done = false;
      for (let attempt = 0; attempt < 5 && !done; attempt += 1) {
        const version = deps.instrumentVersion === undefined ? undefined : await deps.instrumentVersion(tenantId, code);
        const moves = await deps.movements(tenantId, code);
        if (moves.some((m) => m.movementId === movementId)) { cardOut.push({ card: maskVoucherCode(code), alreadyRecorded: true }); done = true; break; }
        const before = balanceOf(moves, code);
        const timeOfSupply = giftCardTimeOfSupplyAtRedemption(instrument, tradingDayIn(sale.committedAt, await calendarOf(deps, tenantId)), tradingDayIn(instrument.issuedAt, await calendarOf(deps, tenantId)));
        const movement: ValueMovement = {
          movementId, instrumentId: code, kind: 'redeem', deltaMinor: -amount, at: sale.committedAt, channel: 'store', saleId: sale.saleId,
          ...(t.giftCard.capturedOffline === true ? { capturedOffline: true } : {}),
          ...(sale.customerRef === undefined ? {} : { customerRef: sale.customerRef }),
          ...(timeOfSupply === undefined ? {} : { timeOfSupply }),
        };
        try {
          await deps.recordMovement(tenantId, code, movement, version);
        } catch (e) {
          if (e instanceof ConcurrencyConflictError) continue; // another movement landed first — read the true balance again
          throw e;
        }
        done = true;
        cardOut.push({ card: maskVoucherCode(code), amountMinor: amount, balanceMinor: before - amount, capturedOffline: t.giftCard.capturedOffline === true });
        if (before - amount < 0) {
          const shortfall = amount - Math.max(0, before);
          exceptions.push({
            kind: 'gift_card_overspent', severity: 'material', saleId: sale.saleId, differenceMinor: shortfall,
            detail: `Gift card ${maskVoucherCode(code)} paid ${inr(amount)} on bill ${sale.receiptNumber || sale.saleId} (till ${sale.laneId || '(not named)'}${t.giftCard.capturedOffline === true ? ', taken while the store computer could not reach head office' : ''}), but it held only ${inr(Math.max(0, before))} once every till's spends arrived — ${inr(shortfall)} was spent twice.`,
            ownerAction: 'Both payments are kept and the card now shows below zero; nothing was reversed. Decide whether to recover the difference from the card holder or write it off.',
          });
        }
        if (giftCardExpiredAt(instrument.expiresOn, sale.committedAt)) {
          exceptions.push({
            kind: 'gift_card_not_valid_when_spent', severity: 'material', saleId: sale.saleId, differenceMinor: amount,
            detail: `Gift card ${maskVoucherCode(code)} paid ${inr(amount)} on bill ${sale.receiptNumber || sale.saleId}, but it expired on ${instrument.expiresOn}.`,
            ownerAction: 'The payment is kept; nothing was reversed. Check why the till took an expired card.',
          });
        }
      }
      if (!done) throw new Error(`gift card ${maskVoucherCode(code)} kept changing while this sale was applied — the resend will try again`);
    }

    const merged = mergeByKind(exceptions);
    if (merged.length > 0) await deps.recordExceptions(tenantId, merged);
    return { exceptions: merged, coupons: couponOut, giftCards: cardOut };
  };
}

/** One finding per sale and kind (head office keys a finding by both): two coupons over their limit on one bill are one finding naming both. */
function mergeByKind(list: readonly SaleException[]): readonly SaleException[] {
  const out = new Map<string, SaleException>();
  for (const e of list) {
    const k = `${e.saleId}\u0000${e.kind}`;
    const prior = out.get(k);
    out.set(k, prior === undefined ? e : { ...prior, differenceMinor: (prior.differenceMinor ?? 0) + (e.differenceMinor ?? 0), detail: `${prior.detail} ${e.detail}` });
  }
  return [...out.values()];
}

async function calendarOf(deps: TillVoucherDeps, tenantId: string): Promise<{ readonly timeZone: string; readonly tradingDayCutoff: string }> {
  return deps.calendar === undefined ? DEFAULT_SHOP_CALENDAR : await deps.calendar(tenantId);
}

/** A gift card's sale as the store computer relays it (`toCloudGiftCardSale`, edge/store-edge/src/cloud-sale.ts). */
export interface TillGiftCardSale {
  readonly saleId: string;
  readonly laneId: string;
  readonly cashierId: string;
  readonly tradingDay: string;
  readonly committedAt: string;
  readonly totalMinor: number;
  readonly currency: string;
  readonly cards: readonly { readonly code: string; readonly faceValueMinor: number }[];
  readonly tenders: readonly { readonly kind: string; readonly amountMinor: number; readonly ref?: string }[];
  readonly locationId?: string;
  readonly customerRef?: string;
  readonly operatorVerified?: unknown;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isPos = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

function readGiftCardSale(b: unknown): TillGiftCardSale | undefined {
  if (b === null || typeof b !== 'object') return undefined;
  const r = b as Record<string, unknown>;
  if (!isStr(r['saleId']) || !isStr(r['committedAt']) || !Array.isArray(r['cards']) || !Array.isArray(r['tenders'])) return undefined;
  const cards = (r['cards'] as unknown[]).flatMap((c) => {
    const x = (c ?? {}) as Record<string, unknown>;
    return isStr(x['code']) && isPos(x['faceValueMinor']) ? [{ code: normalVoucherCode(x['code']), faceValueMinor: x['faceValueMinor'] }] : [];
  });
  if (cards.length === 0) return undefined;
  const tenders = (r['tenders'] as unknown[]).flatMap((t) => {
    const x = (t ?? {}) as Record<string, unknown>;
    return isStr(x['kind']) && Number.isSafeInteger(x['amountMinor']) ? [{ kind: x['kind'], amountMinor: x['amountMinor'] as number, ...(isStr(x['ref']) ? { ref: x['ref'] } : {}) }] : [];
  });
  return {
    saleId: r['saleId'], laneId: isStr(r['laneId']) ? r['laneId'] : '', cashierId: isStr(r['cashierId']) ? r['cashierId'] : '',
    tradingDay: isStr(r['tradingDay']) ? r['tradingDay'] : '', committedAt: r['committedAt'],
    totalMinor: Number.isSafeInteger(r['totalMinor']) ? r['totalMinor'] as number : cards.reduce((n, c) => n + c.faceValueMinor, 0),
    currency: isStr(r['currency']) ? r['currency'] : 'INR', cards, tenders,
    ...(isStr(r['locationId']) ? { locationId: r['locationId'] } : {}),
    ...(isStr(r['customerRef']) ? { customerRef: r['customerRef'] } : {}),
    ...(r['operatorVerified'] !== undefined ? { operatorVerified: r['operatorVerified'] } : {}),
  };
}

/**
 * OB-677 "selling a gift card commits locally and syncs": the store computer relays a gift card sold at the till. Each card
 * is issued here once (its own code is its id; a resend is the same card), its time of supply decided at issue (A12), and
 * the sale kept as it happened. A code head office already holds for another card is NOT overwritten — the customer paid, so
 * the sale is kept and raised as `gift_card_sold_twice` for the manager (hard rule #10). Never a 4xx for a business
 * problem: a refusal here would dead-letter money the till has already taken.
 */
export function tillGiftCardSaleRoutes(deps: TillVoucherDeps): readonly Route[] {
  return [{
    api: 'API-06', method: 'POST', path: '/v1/stored-value/till-sales',
    permission: 'pos.sale.sync', idempotent: true,
    handler: async (ctx) => {
      const sale = readGiftCardSale(ctx.body);
      if (sale === undefined) {
        throw apiError(400, {
          code: 'not_readable_as_a_gift_card_sale',
          whatHappened: 'A gift card sale from a till names its sale id, when it happened, the cards sold (code and value) and how they were paid.',
          wasItSaved: 'not_saved',
          nextSafeAction: 'This is a store computer fault — it stays in the store computer\'s queue for a person. Nothing was issued.',
        });
      }
      const exceptions: SaleException[] = [];
      const issued: unknown[] = [];
      const cal = await calendarOf(deps, ctx.tenantId);
      for (const card of sale.cards) {
        const existing = await deps.instrument(ctx.tenantId, card.code);
        if (existing !== undefined) {
          // This very sale's card, issued on an earlier send of it: the same card, not a second one (idempotent).
          if ((await deps.movements(ctx.tenantId, card.code)).some((m) => m.kind === 'issue' && m.saleId === sale.saleId)) { issued.push({ card: maskVoucherCode(card.code), alreadyIssued: true }); continue; }
          exceptions.push({
            kind: 'gift_card_sold_twice', severity: 'critical', saleId: sale.saleId, differenceMinor: card.faceValueMinor,
            detail: `Till ${sale.laneId || '(not named)'} sold gift card ${maskVoucherCode(card.code)} for ${inr(card.faceValueMinor)}, but head office already holds a card with that code. The new value was NOT added to it.`,
            ownerAction: 'The customer paid. Give them a new card for the value they paid, and check how the same code was sold twice.',
          });
          issued.push({ card: maskVoucherCode(card.code), outcome: 'code_already_held' });
          continue;
        }
        if (giftCardCodeRefusal(card.code) !== undefined) {
          exceptions.push({
            kind: 'gift_card_sold_twice', severity: 'critical', saleId: sale.saleId, differenceMinor: card.faceValueMinor,
            detail: `Till ${sale.laneId || '(not named)'} sold a gift card for ${inr(card.faceValueMinor)} under a code head office cannot keep as a gift card's.`,
            ownerAction: 'The customer paid. Give them a new card for the value they paid.',
          });
          continue;
        }
        const instrument: Instrument = {
          instrumentId: card.code, kind: 'gift_card', ownerRef: sale.customerRef ?? `till-sale:${sale.saleId}`, issuedAt: sale.committedAt,
          timeOfSupply: giftCardTimeOfSupplyAtIssue({ supplyIdentifiableAtIssue: false, issueDate: tradingDayIn(sale.committedAt, cal) }),
        };
        await deps.recordIssue(ctx.tenantId, instrument, {
          movementId: `${card.code}:issue`, instrumentId: card.code, kind: 'issue', deltaMinor: card.faceValueMinor, at: sale.committedAt, channel: 'store', saleId: sale.saleId,
        });
        issued.push({ card: maskVoucherCode(card.code), balanceMinor: card.faceValueMinor });
      }
      await deps.recordGiftCardSale(ctx.tenantId, sale);
      const merged = mergeByKind(exceptions);
      if (merged.length > 0) await deps.recordExceptions(ctx.tenantId, merged);
      return { status: 202, body: { saleId: sale.saleId, recorded: true, cards: issued, exceptions: merged } };
    },
  }];
}
