// OB-288 wave 3 — the customer app's commerce rules, DOM-free and tested (WF-13 · M20-FR-02/03/04 · M21-FR-02 · OB-303 ·
// D08-FR-03 · A04 · A05 · AI-NFR-11). The page (web/customer-commerce.js) shows what these return; it decides nothing.
//
//   • THE SHOP'S PRICE (WF-13): the basket priced by the shop with the till's own promotions and coupon engine. The app
//     pays exactly the shop's quoted payable for exactly the basket it quoted — a basket changed since is quoted again.
//   • REPEAT ORDERS (OB-303): what the customer chose, checked before anything is sent; paid for in the app each time.
//   • DELIVERY CODE / ARRIVAL TIME: the slot for the handover code and the driver's arrival time — "not given yet" until
//     the shop's delivery record carries them (the delivery-code work is not on this branch yet).

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

/**
 * The handover code and the arrival time, as the shop's delivery record gives them — `null` is "not given yet", never a
 * made-up code or a guessed time. Reads `handoverCode` / `eta` when the delivery work adds them.
 */
export function deliveryHandover(delivery: unknown): { readonly code: string | null; readonly eta: string | null } {
  const d = (delivery ?? {}) as Record<string, unknown>;
  const code = typeof d['handoverCode'] === 'string' && /^\d{4,6}$/.test(d['handoverCode']) ? d['handoverCode'] : null;
  const eta = typeof d['eta'] === 'string' && !Number.isNaN(Date.parse(d['eta'])) ? d['eta'] : null;
  return { code, eta };
}

/** The A05 help topics a customer can choose (typed questions go to a person). */
export const HELP_TOPICS = ['order_status', 'return_policy', 'delivery_charges'] as const;

/** The substitution choices (FUL-14) the customer can make for every order. */
export const SUBSTITUTION_CHOICES = ['best_match', 'contact_me', 'no_substitution'] as const;
