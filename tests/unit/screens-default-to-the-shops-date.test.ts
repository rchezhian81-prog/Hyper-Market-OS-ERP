import { describe, it, expect, afterEach, vi } from 'vitest';
import { todayAtShop as wasteToday } from '../../apps/web-erp/src/store-ops-session';
import { todayAtShop as heatMapToday } from '../../apps/web-erp/src/floor-heat-map-session';
import { todayAtShop as customerToday, repeatOrderBody } from '../../apps/customer-app/src/customer-commerce';
import { lastEveningInstant, theEvening } from '../support/evening-clock';

// Round 12 (R12-A): the screens whose default day is "today" take the SHOP's today (Asia/Kolkata), never the UTC date and
// never the browser's own date. From 18:30 to 24:00 UTC the shop is already on the next day; a customer or a member of
// staff at 00:00–05:30 shop time must get the shop's date. The browser tests prove the screens; these prove the rule
// without a browser, at fixed moments, so CI's unit run checks it at any hour.

describe('the screens default to the shop\'s date, at any hour', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('at 19:30 UTC on 28 Oct 2026 (01:00 on the 29th in the shop) every default is the 29th', () => {
    for (const today of [wasteToday, heatMapToday, customerToday]) {
      expect(today('2026-10-28T19:30:00.000Z')).toBe('2026-10-29');
      expect(today('2026-10-28T18:29:59.000Z')).toBe('2026-10-28'); // 23:59:59 in the shop — still the 28th
      expect(today('2026-10-28T00:30:00.000Z')).toBe('2026-10-28'); // 06:00 in the shop
    }
  });

  it('with no moment given, each reads the clock — pinned here to an evening, the shop\'s date and not the UTC one', () => {
    const evening = theEvening(Date.parse('2026-10-28T20:00:00.000Z'));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(evening.at));
    expect(evening).toEqual({ at: '2026-10-28T19:30:00.000Z', shopDate: '2026-10-29', utcDate: '2026-10-28' });
    expect([wasteToday(), heatMapToday(), customerToday()]).toEqual(['2026-10-29', '2026-10-29', '2026-10-29']);
  });

  it('a repeat order starting on the shop\'s today is accepted; the UTC date (the shop\'s yesterday) is refused', () => {
    const today = customerToday('2026-10-28T19:30:00.000Z');
    const form = { lines: [{ productId: 'MILK', quantityMinor: 1 }], locationId: 'store-01', today, every: 'days' as const, days: 7, fulfilment: 'pickup' as const };
    expect(repeatOrderBody({ ...form, startsOn: '2026-10-29' }).ok).toBe(true);
    expect(repeatOrderBody({ ...form, startsOn: '2026-10-28' })).toEqual({ ok: false, why: 'bad_start' });
  });

  it('the evening the browser tests pin is the most recent 19:30 UTC already passed — never one still to come', () => {
    expect(lastEveningInstant(Date.parse('2026-10-28T19:30:00.000Z'))).toBe('2026-10-28T19:30:00.000Z');
    expect(lastEveningInstant(Date.parse('2026-10-28T23:59:00.000Z'))).toBe('2026-10-28T19:30:00.000Z');
    expect(lastEveningInstant(Date.parse('2026-10-28T19:29:59.000Z'))).toBe('2026-10-27T19:30:00.000Z');
    expect(lastEveningInstant(Date.parse('2026-11-01T03:00:00.000Z'))).toBe('2026-10-31T19:30:00.000Z');
    const now = Date.now();
    expect(Date.parse(lastEveningInstant(now))).toBeLessThanOrEqual(now);
    expect(theEvening(Date.parse('2026-12-31T21:00:00.000Z'))).toEqual({ at: '2026-12-31T19:30:00.000Z', shopDate: '2027-01-01', utcDate: '2026-12-31' });
  });
});
