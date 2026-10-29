// The shop's day on a SCREEN (OB-606 · M01-FR-02 · P-08) — what a page shows as "today", "this month" or a date.
//
// A page runs in a browser, and a browser's own clock reads in whatever zone its device is set to. The store PC and the
// tills are set to India time, but a manager's laptop on holiday, a head-office browser in a data centre, a CI runner and
// a phone set to another zone are not. From 18:30 to 24:00 UTC the shop (Asia/Kolkata) is already on the NEXT day, so a
// page that took its date from `getFullYear()/getMonth()/getDate()` or `toLocaleDateString()` opened on the shop's
// yesterday on any device not set to India time. Every screen reads its dates here instead.
//
// The zone: the store computer tells every page it serves the shop's zone from its SIGNED store pack (`shopTimeZone`,
// edge/store-edge/src/screen-server.ts) — no network call, so the till and the handhelds keep it offline. A page served
// without it (a page from an older box, the supplier portal, a test harness) takes the shop default (Asia/Kolkata,
// packages/calendar shop-clock) — never the device's own zone and never UTC.

import { DEFAULT_SHOP_CALENDAR, shopDateIn } from './shop-clock';
import { instantOf, shiftDate, wallClockIn } from './trading-day';

/** True when the runtime knows this IANA zone name. */
function knownZone(zone: unknown): zone is string {
  if (typeof zone !== 'string' || zone.trim() === '') return false;
  try { new Intl.DateTimeFormat('en-CA', { timeZone: zone }); return true; } catch { return false; }
}

/** The zone a page was told is the shop's — or the shop default when it was told none (or a name nobody knows). */
export function shopZoneOr(told: unknown): string {
  return knownZone(told) ? told : DEFAULT_SHOP_CALENDAR.timeZone;
}

/** The shop's zone as the store computer told this page (`window.shopTimeZone`), else the shop default. */
export function servedShopZone(): string {
  return shopZoneOr((globalThis as { shopTimeZone?: unknown }).shopTimeZone);
}

/**
 * The shop's date (YYYY-MM-DD) of a value a page was handed: an instant is read in the shop's zone; a plain date is
 * already a date and is kept as it is; anything else is '' (nothing is made up).
 */
export function shopDateOf(value: unknown, timeZone: string = servedShopZone()): string {
  if (typeof value !== 'string' || value.trim() === '') return '';
  const s = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (Number.isNaN(Date.parse(s))) return '';
  return shopDateIn(s, timeZone);
}

/** The shop's "YYYY-MM" one month before a "YYYY-MM". */
export function monthBefore(month: string): string {
  const y = Number(month.slice(0, 4)); const m = Number(month.slice(5, 7));
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

/** What a page needs of the shop's day, all at the shop's clock. */
export interface ShopDay {
  /** The shop's zone this page dates by. */
  readonly zone: string;
  /** Today in the shop (YYYY-MM-DD). */
  today(): string;
  /** n days before today in the shop (yesterday is 1). */
  daysAgo(n: number): string;
  /** This month in the shop (YYYY-MM). */
  thisMonth(): string;
  /** Last month in the shop (YYYY-MM). */
  lastMonth(): string;
  /** The shop's date of an instant (or a plain date kept as it is; '' for anything else). */
  dateOf(value: unknown): string;
  /** The shop's wall clock now, "YYYY-MM-DDTHH:MM" (what the trading-day rule reads). */
  wallClock(): string;
  /** The instant the shop's today began (its midnight). */
  startOfToday(): string;
  /** The end of the shop's today in a `datetime-local` field's shape ("YYYY-MM-DDT23:59"). */
  endOfTodayField(): string;
  /** The instant a `datetime-local` value means — it is the SHOP's wall clock, not the device's. Invalid → ''. */
  instantOfField(value: string): string;
  /** A date in words, in English or Tamil, on the shop's day (e.g. "Thursday, 29 October 2026"). */
  dayWords(value: unknown, lang: 'en' | 'ta'): string;
}

/** The shop's day for a page: its zone (told, or the shop default) and its clock (the browser's own moment by default). */
export function shopDay(zone: unknown = servedShopZone(), now: () => string = () => new Date().toISOString()): ShopDay {
  const z = shopZoneOr(zone);
  const today = (): string => shopDateIn(now(), z);
  return {
    zone: z,
    today,
    daysAgo: (n) => shiftDate(today(), -n),
    thisMonth: () => today().slice(0, 7),
    lastMonth: () => monthBefore(today().slice(0, 7)),
    dateOf: (value) => shopDateOf(value, z),
    wallClock: () => wallClockIn(now(), z),
    startOfToday: () => instantOf(`${today()}T00:00`, z),
    endOfTodayField: () => `${today()}T23:59`,
    instantOfField: (value) => {
      const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(value.trim());
      return m === null ? '' : instantOf(m[1]!, z);
    },
    dayWords: (value, lang) => {
      const day = shopDateOf(value, z);
      if (day === '') return '';
      // The day itself is already the shop's; it is written out at noon UTC of that date, in UTC, so no zone moves it.
      return new Intl.DateTimeFormat(lang === 'ta' ? 'ta-IN' : 'en-IN', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
        .format(new Date(`${day}T12:00:00.000Z`));
    },
  };
}
