import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  attachShopDay, servedShopZone, shopDateTimeOf, shopDay, shopTimeOf, shopWallClockOf, type ShopDay,
} from '../../packages/calendar/src/shop-day';
import { shopTime } from '../../apps/web-erp/src/approvals-session';
import { zoneWords } from '../../apps/web-erp/src/store-computers-session';

/**
 * **OB-607 (owner, 29 Oct 2026 · round 14, R14-A) — every time of day and date-time a screen shows is the SHOP's clock.**
 *
 * The moment used throughout is 19:30 UTC on 29 Oct 2026: 01:00 on 30 Oct in the shop (Asia/Kolkata), 15:30 on 29 Oct in
 * New York, 23:30 on 29 Oct in Dubai. Before round 14 a screen showed it as New York's (or the UTC) clock. What is STORED
 * is unchanged: instants stay UTC ISO; only what is shown (or put in a field) is read at the shop's clock.
 */

const AT = '2026-10-29T19:30:00.000Z';
const g = globalThis as { shopTimeZone?: unknown };
const realTz = process.env['TZ'];
afterEach(() => {
  delete g.shopTimeZone;
  if (realTz === undefined) delete process.env['TZ']; else process.env['TZ'] = realTz;
});

describe('the shop\'s clock of a moment (packages/calendar/src/shop-day.ts)', () => {
  it('an instant is read in the shop\'s zone — HH:MM and YYYY-MM-DD HH:MM, 24-hour', () => {
    expect(shopWallClockOf(AT, 'Asia/Kolkata')).toBe('2026-10-30T01:00');
    expect(shopTimeOf(AT, 'Asia/Kolkata')).toBe('01:00');
    expect(shopDateTimeOf(AT, 'Asia/Kolkata')).toBe('2026-10-30 01:00');
    // the same moment written with an offset, as a Date, and as epoch milliseconds
    expect(shopDateTimeOf('2026-10-29T15:30:00-04:00', 'Asia/Kolkata')).toBe('2026-10-30 01:00');
    expect(shopDateTimeOf(new Date(AT), 'Asia/Kolkata')).toBe('2026-10-30 01:00');
    expect(shopDateTimeOf(Date.parse(AT), 'Asia/Kolkata')).toBe('2026-10-30 01:00');
  });

  it('another shop zone moves it; an unknown zone takes the shop default, never the device\'s or UTC', () => {
    expect(shopDateTimeOf(AT, 'Asia/Dubai')).toBe('2026-10-29 23:30');
    expect(shopDateTimeOf(AT, 'Not/AZone')).toBe('2026-10-30 01:00');
    expect(shopDateTimeOf(AT, '')).toBe('2026-10-30 01:00');
  });

  it('a date-time with no zone is ALREADY a shop wall clock and is kept — this device never reads it in its own zone', () => {
    expect(shopWallClockOf('2026-10-30T01:00', 'Asia/Dubai')).toBe('2026-10-30T01:00');
    expect(shopDateTimeOf('2026-10-30T01:00:59.123', 'Asia/Kolkata')).toBe('2026-10-30 01:00');
    expect(shopTimeOf('2026-10-30 07:45', 'Asia/Kolkata')).toBe('07:45');
  });

  it('nothing is made up: a plain date, words, nothing, a bad number → \'\'', () => {
    for (const bad of ['2026-10-30', 'later', '', '   ', null, undefined, Number.NaN, Number.POSITIVE_INFINITY, {}, new Date('x')]) {
      expect(shopDateTimeOf(bad, 'Asia/Kolkata'), String(bad)).toBe('');
      expect(shopTimeOf(bad, 'Asia/Kolkata'), String(bad)).toBe('');
    }
  });

  it('the device\'s own zone changes nothing (this process set to New York)', () => {
    process.env['TZ'] = 'America/New_York';
    expect(new Date(AT).getHours()).toBe(15); // the device really is in New York
    expect(shopDateTimeOf(AT, 'Asia/Kolkata')).toBe('2026-10-30 01:00');
    expect(shopDateTimeOf('2026-10-30T01:00', 'Asia/Kolkata')).toBe('2026-10-30 01:00');
    expect(shopDay('Asia/Kolkata', () => AT).wallClock()).toBe('2026-10-30T01:00');
  });

  it('a page\'s shop\'s day carries the same: timeOf, dateTimeOf, fieldOf (a datetime-local value)', () => {
    const day = shopDay('Asia/Kolkata', () => AT);
    expect(day.timeOf(AT)).toBe('01:00');
    expect(day.dateTimeOf(AT)).toBe('2026-10-30 01:00');
    expect(day.fieldOf(AT)).toBe('2026-10-30T01:00');
    // a field's value, read back, is the instant it was made from — what is stored stays the UTC instant
    expect(day.instantOfField(day.fieldOf(AT))).toBe(AT);
    expect(day.timeOf('2026-10-30')).toBe('');
  });
});

describe('the zone a page is served (window.shopTimeZone) — no network call', () => {
  it('every helper defaults to the served zone, else the shop default', () => {
    expect(servedShopZone()).toBe('Asia/Kolkata');
    expect(shopTimeOf(AT)).toBe('01:00');
    g.shopTimeZone = 'Asia/Dubai';
    expect(shopTimeOf(AT)).toBe('23:30');
    expect(shopDateTimeOf(AT)).toBe('2026-10-29 23:30');
  });

  it('attachShopDay gives a page window.sreShopDay in the zone the store computer served it', () => {
    const win: { shopTimeZone?: string; sreShopDay?: ShopDay } = { shopTimeZone: 'Asia/Dubai' };
    attachShopDay(win);
    expect(win.sreShopDay?.zone).toBe('Asia/Dubai');
    expect(win.sreShopDay?.timeOf(AT)).toBe('23:30');
    const told: { sreShopDay?: ShopDay } = {};
    attachShopDay(told);
    expect(told.sreShopDay?.zone).toBe('Asia/Kolkata');
    expect(() => { attachShopDay(undefined); attachShopDay(null); }).not.toThrow();
  });

  it('every app\'s bundle attaches the shop\'s day, so each page script reads times from it', () => {
    const apps = readdirSync('apps').filter((a) => existsSync(join('apps', a, 'src', 'browser-entry.ts')));
    expect(apps.length).toBeGreaterThanOrEqual(12);
    for (const app of apps) {
      const src = readFileSync(join('apps', app, 'src', 'browser-entry.ts'), 'utf8');
      expect(/attachShopDay\(\(globalThis as \{ window\?: unknown \}\)\.window\)|\.sreShopDay = shopDay\(\)/.test(src), app).toBe(true);
    }
  });
});

describe('screen helpers that showed a fixed offset or the UTC clock', () => {
  it('approvals: a time is the served shop zone\'s, DD-MM-YYYY HH:MM (was a fixed +05:30)', () => {
    expect(shopTime(AT)).toBe('30-10-2026 01:00');
    g.shopTimeZone = 'Asia/Dubai';
    expect(shopTime(AT)).toBe('29-10-2026 23:30');
    expect(shopTime('later')).toBe('later');
    expect(shopTime(null)).toBe('');
  });

  it('store computers: "has not reported since" is that store\'s own clock (was the UTC clock)', () => {
    const row = { storeId: 'S9', computer: 'u-b9', verdict: 'in_step' as const, machineTimeZone: 'Asia/Dubai', shopTimeZone: 'Asia/Dubai', shopTimeZoneFrom: 'store_pack' as const, lastReportAt: AT, stale: true };
    expect(zoneWords('en', row)).toContain('since 2026-10-29 23:30');
    expect(zoneWords('en', { ...row, shopTimeZone: 'Asia/Kolkata' })).toContain('since 2026-10-30 01:00');
  });
});
