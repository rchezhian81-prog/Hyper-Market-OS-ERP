import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SHOP_CALENDAR, shopClock, shopDateIn, shopMonthIn, shopToday, tradingMonthIn, machineTimeZone,
} from '../../packages/calendar/src/index';
import { SETTINGS } from '../../packages/tenant/src/settings';

// Re-audit lane 1 R1 (M01-FR-02 · section 6): every business date is read from the shop's own clock — its zone and its
// cut-off — never from the UTC date of a moment and never from the machine's zone. 00:40 IST on 1 Nov 2026 is
// 19:10 UTC on 31 Oct: slicing the moment says "31 October", the shop says "1 November".
const AT_0040_IST_ON_THE_1ST = '2026-10-31T19:10:00.000Z';

describe('the shop clock', () => {
  it('defaults to the tenant settings defaults, never UTC', () => {
    expect(DEFAULT_SHOP_CALENDAR).toEqual({ timeZone: SETTINGS.STORE_TIME_ZONE.defaultValue, tradingDayCutoff: SETTINGS.TRADING_DAY_CUTOFF.defaultValue });
  });

  it('reads the calendar date and month in the shop zone at 00:40 IST on the 1st (the UTC slice is the previous month)', () => {
    expect(AT_0040_IST_ON_THE_1ST.slice(0, 10)).toBe('2026-10-31');
    expect(shopDateIn(AT_0040_IST_ON_THE_1ST)).toBe('2026-11-01');
    expect(shopMonthIn(AT_0040_IST_ON_THE_1ST)).toBe('2026-11');
    expect(shopDateIn(AT_0040_IST_ON_THE_1ST, 'UTC')).toBe('2026-10-31');
    expect(tradingMonthIn(AT_0040_IST_ON_THE_1ST)).toBe('2026-11');
  });

  it('applies the cut-off for the trading day but not for the calendar date', async () => {
    const clock = shopClock(() => ({ timeZone: 'Asia/Kolkata', tradingDayCutoff: '02:00' }));
    expect(await clock.tradingDayOf('t1', AT_0040_IST_ON_THE_1ST)).toBe('2026-10-31');
    expect(await clock.tradingMonthOf('t1', AT_0040_IST_ON_THE_1ST)).toBe('2026-10');
    expect(await clock.dateOf('t1', AT_0040_IST_ON_THE_1ST)).toBe('2026-11-01');
    expect(await clock.today('t1', AT_0040_IST_ON_THE_1ST)).toBe('2026-11-01');
    expect(await clock.monthOf('t1', AT_0040_IST_ON_THE_1ST)).toBe('2026-11');
  });

  it('follows each tenant its own calendar', async () => {
    const clock = shopClock((t) => (t === 'dubai' ? { timeZone: 'Asia/Dubai', tradingDayCutoff: '00:00' } : DEFAULT_SHOP_CALENDAR));
    // 19:10 UTC is 23:10 in Dubai — still the 31st there.
    expect(await clock.today('dubai', AT_0040_IST_ON_THE_1ST)).toBe('2026-10-31');
    expect(await clock.today('sre', AT_0040_IST_ON_THE_1ST)).toBe('2026-11-01');
  });

  it('gives a service its "today" from its deps', async () => {
    expect(await shopToday({ now: () => AT_0040_IST_ON_THE_1ST }, 't1')).toBe('2026-11-01');
    expect(await shopToday({ now: () => AT_0040_IST_ON_THE_1ST, calendar: async () => ({ timeZone: 'UTC', tradingDayCutoff: '00:00' }) }, 't1')).toBe('2026-10-31');
  });

  it('names the machine zone (for the store box zone check)', () => {
    expect(typeof machineTimeZone()).toBe('string');
    expect(machineTimeZone().length).toBeGreaterThan(0);
  });
});
