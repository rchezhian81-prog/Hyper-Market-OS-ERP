// What a store computer whose clock is 5+ minutes out HOLDS (roadmap §31.1 · OB-403 "A" · OB-327 · P-01 · P-08 · hard rule #1).
//
// §31.1: "Clock drift beyond threshold blocks time-sensitive local activation and raises incident." OB-403 "A" (owner, 27 Oct
// 2026, in writing): at the 5-minute flag (OB-327, or this store computer's own setting) the box keeps the prices and offers
// ALREADY in force and starts no new price, promotion or bill-number year until its clock is back in step. Selling never
// stops; a planned change may start late on that box. Head office and the owner are told (the box's health report).
//
// The clock guard (`clock-guard.ts` `activationHold`) says whether the hold is on and its cut-off instant. This file says
// what it holds, in one place for every reader:
//   • OFFERS — a signed offer whose start is after the cut-off is not applied by the till (the till is told the cut-off and
//     leaves such offers out of its pricing; nothing is removed from the signed pack, so when the hold lifts they apply at
//     once — re-evaluated, nothing lost);
//   • PRICES — the Products and prices screen decides "today's price" from the effective-dated entries by the shop's day; while
//     held, that day stays the day of the cut-off, so an entry dated later does not become today's price;
//   • THE BILL-NUMBER YEAR — the receipt series keeps the year it last numbered in (receipt-numbers.ts, `seriesClock`).
// Each held change is listed by name and said in words (P-08). Pure and DOM-free; read from the fsync'd clock log through
// the guard, so it is the same after a cold restart and needs no internet.

import type { ActivationHold } from './clock-guard';
import { packTradingDay, type PackCalendarSource } from './shop-zone';

/** What the box is holding now, and why, as every screen, the till and the health report read it. */
export interface ActivationHoldReport {
  readonly held: boolean;
  /** When (by this box's clock) the clock was found 5+ minutes out; null when nothing is held. */
  readonly since: string | null;
  /** Anything that starts after this instant waits; null when nothing is held. */
  readonly cutoffAt: string | null;
  /** Head office's clock minus this box's when it was found out, in whole seconds; null when nothing is held. */
  readonly offsetSeconds: number | null;
  /** The shop's day "today's price" is decided by while held (the cut-off's day); null when nothing is held. */
  readonly priceDay: string | null;
  /** Offers whose start has come by this box's clock but is after the cut-off — signed, held, not applied. */
  readonly heldPromotions: readonly { readonly id: string; readonly startsAt: string }[];
  /** Price entries dated after the price day and on or before the box's own day — recorded, held, not today's price yet. */
  readonly heldPrices: readonly { readonly id: string; readonly productId: string; readonly effectiveFrom: string }[];
  readonly staffMessage: string;
  readonly staffMessageTa: string;
}

const minutes = (seconds: number): number => Math.max(1, Math.round(Math.abs(seconds) / 60));

/** True when an offer starting at `startsAt` is held under this cut-off (a start after it; an unreadable start fails safe). */
export function offerHeld(startsAt: string, cutoffAt: string | null): boolean {
  if (cutoffAt === null) return false;
  const s = Date.parse(startsAt);
  return Number.isNaN(s) || s > Date.parse(cutoffAt);
}

/**
 * The hold, with what it holds: the offers whose start has come by the box's clock (`now`) after the cut-off, and the price
 * entries dated after the cut-off's day up to the box's own day (`tradingDay`).
 */
export function activationHoldReport(input: {
  readonly hold: ActivationHold;
  readonly pack: PackCalendarSource;
  readonly now: string;
  readonly tradingDay: string;
  readonly promotions?: readonly { readonly id: string; readonly startsAt: string; readonly status?: string }[];
  readonly priceEntries?: readonly { readonly id: string; readonly productId: string; readonly effectiveFrom: string; readonly status?: string }[];
}): ActivationHoldReport {
  const h = input.hold;
  if (!h.held) {
    return {
      held: false, since: null, cutoffAt: null, offsetSeconds: null, priceDay: null, heldPromotions: [], heldPrices: [],
      staffMessage: 'Nothing is held: this store computer starts new prices, offers and a new bill-number year on time.',
      staffMessageTa: 'எதுவும் நிறுத்தி வைக்கப்படவில்லை: புதிய விலைகள், சலுகைகள், புதிய பில் எண் ஆண்டு நேரத்தில் தொடங்கும்.',
    };
  }
  const now = Date.parse(input.now);
  const heldPromotions = (input.promotions ?? [])
    .filter((p) => p.status === undefined || p.status === 'active')
    .filter((p) => offerHeld(p.startsAt, h.cutoffAt) && !(Date.parse(p.startsAt) > now))
    .map((p) => ({ id: p.id, startsAt: p.startsAt }))
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.id.localeCompare(b.id));
  const cutDay = packTradingDay(input.pack, h.cutoffAt);
  const priceDay = cutDay < input.tradingDay ? cutDay : input.tradingDay;
  const heldPrices = (input.priceEntries ?? [])
    .filter((e) => e.status === undefined || e.status === 'active')
    .filter((e) => { const d = e.effectiveFrom.slice(0, 10); return d > priceDay && d <= input.tradingDay; })
    .map((e) => ({ id: e.id, productId: e.productId, effectiveFrom: e.effectiveFrom }))
    .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom) || a.id.localeCompare(b.id));
  const m = minutes(h.offsetSeconds);
  const flagM = minutes(h.flagSeconds);
  const list = [
    ...heldPromotions.map((p) => `offer ${p.id} (from ${p.startsAt})`),
    ...heldPrices.map((e) => `price ${e.id} for ${e.productId} (from ${e.effectiveFrom})`),
  ];
  const listTa = [
    ...heldPromotions.map((p) => `சலுகை ${p.id} (${p.startsAt} முதல்)`),
    ...heldPrices.map((e) => `விலை ${e.id} — ${e.productId} (${e.effectiveFrom} முதல்)`),
  ];
  return {
    held: true, since: h.since, cutoffAt: h.cutoffAt, offsetSeconds: h.offsetSeconds, priceDay, heldPromotions, heldPrices,
    staffMessage: `Price change held: store clock is ${m} min out (${flagM} min or more). Prices and offers already running stay; no new price, offer or bill-number year starts until the clock is back in step. Selling goes on.${list.length === 0 ? ' Nothing new has been due yet.' : ` Held now: ${list.join('; ')}.`}`,
    staffMessageTa: `விலை மாற்றம் நிறுத்தி வைக்கப்பட்டது: கடைக் கணினியின் கடிகாரம் ${m} நிமிடம் விலகியுள்ளது (${flagM} நிமிடம் அல்லது அதிகம்). இப்போதுள்ள விலைகளும் சலுகைகளும் தொடரும்; கடிகாரம் சரியாகும் வரை புதிய விலை, சலுகை அல்லது பில் எண் ஆண்டு தொடங்காது. விற்பனை தொடர்கிறது.${listTa.length === 0 ? ' இதுவரை புதியது எதுவும் தொடங்க வேண்டியதில்லை.' : ` இப்போது நிறுத்தியவை: ${listTa.join('; ')}.`}`,
  };
}
