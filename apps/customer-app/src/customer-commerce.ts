// OB-288 wave 3 — the customer app's commerce rules, DOM-free and tested (WF-13 · M20-FR-02/03/04 · M21-FR-02 · OB-303 ·
// D08-FR-03 · A04 · A05 · AI-NFR-11). The page (web/customer-commerce.js) shows what these return; it decides nothing.
//
//   • THE SHOP'S PRICE (WF-13): the basket priced by the shop with the till's own promotions and coupon engine. The app
//     pays exactly the shop's quoted payable for exactly the basket it quoted — a basket changed since is quoted again.
//   • REPEAT ORDERS (OB-303): what the customer chose, checked before anything is sent; paid for in the app each time.
//   • DELIVERY CODE / ARRIVAL TIME (OB-294 · D08-FR-05): head office's own 4-digit code for MY order (only my app can read
//     it) and the driver's last stamped stop with an estimate — "not given yet" until head office gives them, never made up.

import { shopDateIn } from '../../../packages/calendar/src/shop-clock';
import { servedShopZone } from '../../../packages/calendar/src/shop-day';

/**
 * Today in the SHOP's own zone (packages/calendar shop-clock) — a repeat order's earliest start day. Never the phone's own
 * date and never the UTC date: head office judges "not before today" by the shop's day, and a phone set to another zone
 * (or the UTC date, from 18:30 UTC) is still on the shop's yesterday — the order was refused as starting in the past.
 */
export const todayAtShop = (nowIso: string = new Date().toISOString(), timeZone: string = servedShopZone()): string => shopDateIn(nowIso, timeZone);

/** The coupon codes the shop reads (the same rule as head office's). */
export const COUPON_CODE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;

export interface QuoteLine { readonly productId: string; readonly quantityMinor: number }

/** One basket's fingerprint — a quote is only good for the basket it was asked for, in the same fulfilment, coupon. */
export function basketKey(lines: readonly QuoteLine[], fulfilment: string | undefined, couponCode: string | undefined): string {
  return JSON.stringify([[...lines].filter((l) => l.quantityMinor > 0).map((l) => [l.productId, l.quantityMinor]).sort(), fulfilment ?? '', (couponCode ?? '').trim()]);
}

export interface ShopQuote {
  readonly priced: boolean;
  readonly goodsMinor?: number; readonly deliveryFeeMinor?: number; readonly payableMinor?: number;
  readonly promotions?: { readonly discountMinor: number; readonly applied: readonly { readonly promotionId?: string; readonly name?: string; readonly discountMinor?: number }[] };
  readonly coupon?: { readonly code: string; readonly applied: boolean; readonly outcome: string; readonly discountMinor: number; readonly detail: string } | null;
  readonly points?: { readonly member: boolean; readonly pointsBalance?: number; readonly worthMinor?: number; readonly say: string };
  readonly unpriced?: readonly string[];
  readonly detail?: string;
}

/** The rows the basket shows, in order — every amount the shop's, never the phone's sum. */
export type QuoteRow =
  | { readonly kind: 'goods' | 'offers' | 'coupon' | 'delivery' | 'payable'; readonly amountMinor: number }
  | { readonly kind: 'coupon_refused'; readonly code: string; readonly outcome: string }
  | { readonly kind: 'unpriced'; readonly productIds: readonly string[] };

export function quoteRows(q: ShopQuote): readonly QuoteRow[] {
  if (!q.priced) return [{ kind: 'unpriced', productIds: q.unpriced ?? [] }];
  const rows: QuoteRow[] = [{ kind: 'goods', amountMinor: q.goodsMinor ?? 0 }];
  if ((q.promotions?.discountMinor ?? 0) > 0) rows.push({ kind: 'offers', amountMinor: -(q.promotions!.discountMinor) });
  if (q.coupon !== null && q.coupon !== undefined) {
    rows.push(q.coupon.applied ? { kind: 'coupon', amountMinor: -q.coupon.discountMinor } : { kind: 'coupon_refused', code: q.coupon.code, outcome: q.coupon.outcome });
  }
  rows.push({ kind: 'delivery', amountMinor: q.deliveryFeeMinor ?? 0 }, { kind: 'payable', amountMinor: q.payableMinor ?? 0 });
  return rows;
}

export type RepeatOrderForm = {
  readonly lines: readonly QuoteLine[]; readonly locationId: string | undefined; readonly today: string;
  readonly startsOn: string; readonly every: 'days' | 'weekdays'; readonly days?: number; readonly weekdays?: readonly number[];
  readonly fulfilment: 'pickup' | 'delivery'; readonly location?: { readonly lat: number; readonly lon: number }; readonly slotTime?: string;
};
export type RepeatOrderWhy = 'empty_basket' | 'no_store' | 'bad_start' | 'bad_days' | 'no_weekdays' | 'no_location' | 'bad_time';

/** The body for `POST /v1/me/subscriptions/:id` — or why the form is not ready (nothing is sent). */
export function repeatOrderBody(f: RepeatOrderForm): { readonly ok: true; readonly body: Record<string, unknown> } | { readonly ok: false; readonly why: RepeatOrderWhy } {
  const lines = f.lines.filter((l) => l.quantityMinor > 0).map((l) => ({ productId: l.productId, quantityMinor: l.quantityMinor }));
  if (lines.length === 0) return { ok: false, why: 'empty_basket' };
  if (f.locationId === undefined || f.locationId === '') return { ok: false, why: 'no_store' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.startsOn) || f.startsOn < f.today) return { ok: false, why: 'bad_start' };
  let schedule: Record<string, unknown>;
  if (f.every === 'days') {
    if (!Number.isInteger(f.days) || f.days! < 1 || f.days! > 31) return { ok: false, why: 'bad_days' };
    schedule = { kind: 'every_days', days: f.days };
  } else {
    const w = [...new Set(f.weekdays ?? [])].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort();
    if (w.length === 0) return { ok: false, why: 'no_weekdays' };
    schedule = { kind: 'weekdays', weekdays: w };
  }
  const body: Record<string, unknown> = { lines, locationId: f.locationId, schedule, startsOn: f.startsOn, fulfilment: f.fulfilment };
  if (f.fulfilment === 'delivery') {
    if (f.location === undefined) return { ok: false, why: 'no_location' };
    if (f.slotTime === undefined || !/^([01]\d|2[0-3]):[0-5]\d$/.test(f.slotTime)) return { ok: false, why: 'bad_time' };
    body['delivery'] = { location: f.location, slotTime: f.slotTime };
  }
  return { ok: true, body };
}

/** What the slot shows about one order's hand-over — every field `null` until head office has said it. */
export interface Handover {
  /** Head office's 4-digit code for my order (OB-294) — null: not given yet. */
  readonly code: string | null;
  /** The order is finished (delivered, collected, returned): the code has done its job. */
  readonly used: boolean;
  /** The ESTIMATED arrival (straight-line, never earlier than the plan) — null: not given (not on a route, or reached). */
  readonly eta: string | null;
  /** Where the driver's run stands, in head office's words. Null: head office has not said. */
  readonly etaState: 'not_on_a_route' | 'not_started' | 'on_the_way' | 'reached' | null;
  /** When the driver stamped his last stop — null until he has. */
  readonly lastStopAt: string | null;
  /** Stops still before mine (counts only — never another customer's address or time). Null: not on a route. */
  readonly stopsBeforeYou: number | null;
}

const ETA_STATES = ['not_on_a_route', 'not_started', 'on_the_way', 'reached'] as const;
const isoOrNull = (v: unknown): string | null => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null);

/**
 * The hand-over as head office gives it: the body of `GET /v1/storefront/orders/:id/delivery-code` and of `.../delivery-eta`
 * (either may be absent — not asked, refused or offline). `null` is "not given yet", never a made-up code or a guessed time.
 */
export function deliveryHandover(codeBody: unknown, etaBody?: unknown): Handover {
  const c = (codeBody ?? {}) as Record<string, unknown>;
  const e = (etaBody ?? {}) as Record<string, unknown>;
  const code = typeof c['code'] === 'string' && /^\d{4}$/.test(c['code']) ? c['code'] : null;
  const etaState = (ETA_STATES as readonly string[]).includes(e['state'] as string) ? e['state'] as Handover['etaState'] : null;
  const ahead = e['stopsBeforeYou'];
  const moving = etaState === 'not_started' || etaState === 'on_the_way';
  return {
    code, used: code !== null && c['used'] === true,
    eta: moving ? isoOrNull(e['estimatedArrivalAt']) : null,
    etaState,
    lastStopAt: etaState === null ? null : isoOrNull(e['lastStopStampedAt']),
    stopsBeforeYou: moving && Number.isInteger(ahead) && (ahead as number) >= 0 ? ahead as number : null,
  };
}

/** OB-351: a referral code as the customer types it — 8 letters and digits with no look-alikes (no 0, O, 1, I or L). */
export function readReferralCode(typed: string): string | undefined {
  const c = typed.trim().toUpperCase().replace(/\s+/g, '');
  return /^[2-9A-HJKMNP-Z]{8}$/.test(c) ? c : undefined;
}

/** OB-351: the reward one side earns, as the screen words it — an amount, or "not set" (nothing is given until then). */
export function referralWhy(reward: unknown): { readonly set: true; readonly amountMinor: number } | { readonly set: false } {
  const r = (reward ?? {}) as Record<string, unknown>;
  return r['state'] === 'set' && Number.isInteger(r['amountMinor']) && (r['amountMinor'] as number) >= 0 ? { set: true, amountMinor: r['amountMinor'] as number } : { set: false };
}

/** The A05 help topics a customer can choose (typed questions go to a person). */
export const HELP_TOPICS = ['order_status', 'return_policy', 'delivery_charges'] as const;

/** The substitution choices (FUL-14) the customer can make for every order. */
export const SUBSTITUTION_CHOICES = ['best_match', 'contact_me', 'no_substitution'] as const;
