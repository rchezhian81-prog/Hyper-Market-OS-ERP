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

/** A date-time with no zone named ("YYYY-MM-DDTHH:MM", optional seconds) — already a SHOP wall clock (e.g. a lane's
 *  `lastReportShop`), never a moment for this device to read in its own zone. */
const ZONELESS = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?$/;
/** An instant: an ISO-8601 date-time WITH its zone ("Z" or "±HH:MM"). */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i;

/**
 * The SHOP's wall clock ("YYYY-MM-DDTHH:MM") of a value a page was handed (OB-607): an instant (an ISO string with its
 * zone, a `Date`, or epoch milliseconds) is read in the shop's zone; a date-time with no zone is already the shop's wall
 * clock and is kept as it is (this device's zone never reads it); anything else — a plain date, words, nothing — is ''.
 */
export function shopWallClockOf(value: unknown, timeZone: string = servedShopZone()): string {
  const zone = shopZoneOr(timeZone);
  let ms: number;
  if (value instanceof Date) ms = value.getTime();
  else if (typeof value === 'number') ms = value;
  else if (typeof value === 'string') {
    const s = value.trim();
    const kept = ZONELESS.exec(s);
    if (kept !== null) return `${kept[1]!}T${kept[2]!}`;
    if (!INSTANT.test(s)) return '';
    ms = Date.parse(s);
  } else return '';
  if (!Number.isFinite(ms)) return '';
  return wallClockIn(new Date(ms).toISOString(), zone);
}

/**
 * OB-608: the instant a date-time TYPED into a form means. A `datetime-local` field (or any "YYYY-MM-DDTHH:MM[:SS]" with no
 * zone) holds the SHOP's wall clock — never the device's: on a laptop set to New York, "10:30" read by `new Date(…)` was
 * sent as 10:30 New York, 20:00 in the shop. It is read in the shop's zone (the one the store computer served this page,
 * `window.shopTimeZone`, else the shop default) — no network call. A value that already names its zone ("Z" or "±HH:MM")
 * is kept as that instant. Anything else (a plain date, words, an impossible time, nothing) is '' — nothing is made up.
 */
export function instantOfTyped(value: unknown, timeZone: string = servedShopZone()): string {
  if (typeof value !== 'string') return '';
  const v = value.trim();
  if (INSTANT.test(v)) {
    const ms = Date.parse(v);
    return Number.isNaN(ms) ? '' : new Date(ms).toISOString();
  }
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::(\d{2})(\.\d+)?)?$/.exec(v);
  if (m === null) return '';
  const day = m[1]!; const hhmm = m[2]!;
  // An impossible wall clock (month 13, 25:00, 30 February) is refused, not rolled over into another day.
  const asIfUtc = Date.parse(`${day}T${hhmm}:00.000Z`);
  if (Number.isNaN(asIfUtc) || new Date(asIfUtc).toISOString().slice(0, 16) !== `${day}T${hhmm}`) return '';
  if (m[3] !== undefined && Number(m[3]) > 59) return '';
  try {
    const base = Date.parse(instantOf(`${day}T${hhmm}`, shopZoneOr(timeZone)));
    const extra = (m[3] === undefined ? 0 : Number(m[3]) * 1000) + (m[4] === undefined ? 0 : Math.round(Number(m[4]) * 1000));
    return new Date(base + extra).toISOString();
  } catch { return ''; }
}

/**
 * OB-607 (outside screen code — printed labels, staff messages): a moment as a person reads it, "YYYY-MM-DD HH:MM" on the
 * shop's clock in `timeZone` (the caller's calendar or the store pack's zone; a zone nobody knows → the shop default, never
 * UTC). A plain date is already a date and is kept; a date-time with no zone is already the shop's wall clock and is kept;
 * anything else is shown exactly as it was given — never a clock made up.
 */
export function shownShopDateTime(value: string, timeZone: unknown): string {
  const v = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const shown = shopDateTimeOf(v, shopZoneOr(timeZone));
  return shown !== '' ? shown : v;
}

/** The shop's time of day ("HH:MM", 24-hour) of a value a page was handed — '' when it is not a moment. */
export function shopTimeOf(value: unknown, timeZone: string = servedShopZone()): string {
  return shopWallClockOf(value, timeZone).slice(11, 16);
}

/** The shop's date and time ("YYYY-MM-DD HH:MM") of a value a page was handed — '' when it is not a moment. */
export function shopDateTimeOf(value: unknown, timeZone: string = servedShopZone()): string {
  return shopWallClockOf(value, timeZone).replace('T', ' ');
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
  /** OB-607: the shop's time of day of a moment, "HH:MM" (24-hour) — '' when it is not a moment. */
  timeOf(value: unknown): string;
  /** OB-607: the shop's date and time of a moment, "YYYY-MM-DD HH:MM" — '' when it is not a moment. */
  dateTimeOf(value: unknown): string;
  /** OB-607: the shop's wall clock of a moment in a `datetime-local` field's shape, "YYYY-MM-DDTHH:MM" — '' when not one. */
  fieldOf(value: unknown): string;
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
    instantOfField: (value) => instantOfTyped(value, z),
    dayWords: (value, lang) => {
      const day = shopDateOf(value, z);
      if (day === '') return '';
      // The day itself is already the shop's; it is written out at noon UTC of that date, in UTC, so no zone moves it.
      return new Intl.DateTimeFormat(lang === 'ta' ? 'ta-IN' : 'en-IN', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
        .format(new Date(`${day}T12:00:00.000Z`));
    },
    timeOf: (value) => shopTimeOf(value, z),
    dateTimeOf: (value) => shopDateTimeOf(value, z),
    fieldOf: (value) => shopWallClockOf(value, z),
  };
}

/**
 * Give a page its shop's day as `window.sreShopDay` (OB-606/OB-607), read from the zone the store computer served it
 * (`window.shopTimeZone`, from the signed pack — no network call). Each app's bundle calls this once as it loads, before
 * the page's own script runs (module scripts run in order), so every plain page script shows dates and times by it.
 */
export function attachShopDay(win: unknown): void {
  if (win === null || typeof win !== 'object') return;
  (win as { sreShopDay?: ShopDay }).sreShopDay = shopDay((win as { shopTimeZone?: unknown }).shopTimeZone);
}
