// The shop's clock (M01-FR-02 · P-08 · re-audit lane 1 R1, section 6) — the ONE way a business date is read from a moment.
//
// Every moment the system keeps (`now`, `at`, `committedAt`, …) is a UTC instant. Its first ten characters are the UTC
// date, which in Tamil Nadu is the PREVIOUS day for the five and a half hours after the shop's midnight (and the previous
// MONTH from 00:00 to 05:30 IST on the 1st). A server in a data centre, a container on UTC and a CI runner all agree with
// UTC, not with the shop. So no business date — a trading day, a journal date, a GST time of supply, a period, a "today"
// for a validity check — is ever taken by slicing a moment or from whatever zone the machine runs in. It is read here,
// from the shop's own calendar: its IANA time zone (`locale.time_zone`) and its trading-day cut-off (`trading_day.cutoff`).
//
// Two kinds of date:
// - the TRADING DAY (cut-off applied) — what the till stamps on a sale, and what the books, the day close and the GST
//   return go by: `tradingDayIn`, `shopClock(...).tradingDayOf`, `tradingMonthIn`;
// - the CALENDAR DATE in the shop's zone (no cut-off) — "is this licence / contract / voucher in force today", a GRN's
//   received-on date, an attendance mark's date: `shopDateIn`, `shopClock(...).today`, `shopClock(...).dateOf`.
// With the shop's cut-off at midnight (the default) the two agree.

import { makeTradingDayRule, tradingDate, tradingDayIn, wallClockIn, type TradingCalendar } from './trading-day';

/**
 * The shop's calendar when no one has said otherwise: the tenant settings' own defaults (`locale.time_zone` =
 * Asia/Kolkata, `trading_day.cutoff` = 00:00 — packages/tenant/src/settings.ts; a unit test keeps the two equal). Never
 * the machine's zone and never UTC.
 */
export const DEFAULT_SHOP_CALENDAR: TradingCalendar = Object.freeze({ timeZone: 'Asia/Kolkata', tradingDayCutoff: '00:00' });

/** Where a service reads a tenant's calendar (its zone and cut-off) — built once from the tenant settings. */
export type ShopCalendarOf = (tenantId: string) => Promise<TradingCalendar> | TradingCalendar;

/** The calendar date (YYYY-MM-DD) an instant falls on in a zone — the shop's when named, the shop default otherwise. */
export function shopDateIn(isoInstant: string, timeZone: string = DEFAULT_SHOP_CALENDAR.timeZone): string {
  return wallClockIn(isoInstant, timeZone).slice(0, 10);
}

/** The calendar month (YYYY-MM) an instant falls in, in the shop's zone. */
export function shopMonthIn(isoInstant: string, timeZone: string = DEFAULT_SHOP_CALENDAR.timeZone): string {
  return shopDateIn(isoInstant, timeZone).slice(0, 7);
}

/** The month (YYYY-MM) of the trading day an instant belongs to — the period a journal posted from it belongs to. */
export function tradingMonthIn(isoInstant: string, calendar: TradingCalendar = DEFAULT_SHOP_CALENDAR): string {
  return tradingDayIn(isoInstant, calendar).slice(0, 7);
}

/** The shop's clock for one service: every business date it needs, per tenant, from that tenant's calendar. */
export interface ShopClock {
  /** The tenant's calendar (the shop default when the service was given no reader). */
  readonly calendar: (tenantId: string) => Promise<TradingCalendar>;
  /** The trading day (cut-off applied) an instant belongs to. */
  readonly tradingDayOf: (tenantId: string, isoInstant: string) => Promise<string>;
  /** The month of that trading day — the period of a journal or a month close. */
  readonly tradingMonthOf: (tenantId: string, isoInstant: string) => Promise<string>;
  /** The calendar date an instant falls on in the shop's zone. */
  readonly dateOf: (tenantId: string, isoInstant: string) => Promise<string>;
  /** The calendar month an instant falls in, in the shop's zone. */
  readonly monthOf: (tenantId: string, isoInstant: string) => Promise<string>;
  /** "Today" in the shop's zone, at the moment `nowIso` — for validity checks and defaults. */
  readonly today: (tenantId: string, nowIso: string) => Promise<string>;
}

/** Build the shop's clock from a calendar reader — or, given none, from the shop default (never UTC, never the machine). */
export function shopClock(calendarOf?: ShopCalendarOf): ShopClock {
  const calendar = async (tenantId: string): Promise<TradingCalendar> => (calendarOf === undefined ? DEFAULT_SHOP_CALENDAR : calendarOf(tenantId));
  return {
    calendar,
    tradingDayOf: async (t, iso) => tradingDayIn(iso, await calendar(t)),
    tradingMonthOf: async (t, iso) => tradingMonthIn(iso, await calendar(t)),
    dateOf: async (t, iso) => shopDateIn(iso, (await calendar(t)).timeZone),
    monthOf: async (t, iso) => shopMonthIn(iso, (await calendar(t)).timeZone),
    today: async (t, nowIso) => shopDateIn(nowIso, (await calendar(t)).timeZone),
  };
}

/** "Today" in the shop's zone for a service's deps (`now` and its optional `calendar`) — the `shopToday(tenant)` port. */
export async function shopToday(deps: { readonly now: () => string; readonly calendar?: ShopCalendarOf }, tenantId: string): Promise<string> {
  return shopClock(deps.calendar).today(tenantId, deps.now());
}

/** The zone this machine resolves (what a bare `wallClockIn(x)` would use) — for the store box's zone check (P-08). */
export function machineTimeZone(): string {
  return new Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * The shop trading day of a time stamp that may be EITHER an instant (it names its zone: `Z` or `+05:30`) or the shop's own
 * local wall-clock time with no zone (as an old system's export may write it). An instant is read in the shop's calendar;
 * a local stamp is already the shop's clock, so only the cut-off applies. Nothing is guessed: the stamp says which it is.
 */
export function tradingDayOfStamp(stamp: string, calendar: TradingCalendar = DEFAULT_SHOP_CALENDAR): string {
  const s = stamp.trim();
  if (/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(s)) return tradingDayIn(s, calendar);
  const local = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?)?$/.exec(s);
  if (local === null) throw new RangeError(`"${stamp}" is neither an instant nor a local date-time.`);
  return tradingDate(`${local[1]}T${local[2] ?? '12'}:${local[3] ?? '00'}`, makeTradingDayRule(calendar.tradingDayCutoff));
}
