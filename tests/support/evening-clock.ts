// The shop's day is Asia/Kolkata (UTC+5:30). From 18:30 to 24:00 UTC the shop's date is ALREADY the next day, while
// the UTC date — what `new Date().toISOString().slice(0, 10)` gives — is still today. On 28 Oct 2026, 13 browser test
// files failed between 19:00 and 19:25 UTC and passed at 14:30 UTC the same day: each took "today" from the UTC date
// (or a screen did). A test that only runs in daylight UTC never sees that case, so the tests that were fixed for it pin
// their clock to an EVENING UTC moment, and prove the evening case whenever CI happens to run them.
//
// The pinned moment is the most recent 19:30 UTC that has already passed — today's, or yesterday's before 19:30 UTC —
// never one still to come: the store computer dates its handheld door's TLS certificate from `Date` (valid from an hour
// before), and a clock pinned ahead of the real one served a certificate "not yet valid" (OB-422, as
// tests/support/trading-day-clock.ts found). Only `Date` is pinned — timers and I/O run normally, and the clock keeps
// moving from the pinned moment, so a journey of a few minutes stays inside the same shop day (19:30 UTC is 01:00 in
// the shop; the shop's day runs on until 18:30 UTC).

import { vi } from 'vitest';
import type { BrowserContext } from 'playwright-core';
import { shopDateIn } from '../../packages/calendar/src/shop-clock';

/** The UTC time of day the evening tests run at: 01:00 the next morning in the shop. */
export const EVENING_UTC = '19:30';

/** The most recent 19:30 UTC at or before `nowMs` (an ISO instant). */
export function lastEveningInstant(nowMs: number = Date.now()): string {
  const utcDay = new Date(nowMs).toISOString().slice(0, 10); // the UTC date on purpose: 19:30 is a UTC time of day
  const todays = Date.parse(`${utcDay}T${EVENING_UTC}:00.000Z`);
  return new Date(todays <= nowMs ? todays : todays - 86_400_000).toISOString();
}

/** What a pinned evening is: the instant, the shop's own date then, and the UTC date then (the day before the shop's). */
export interface Evening {
  readonly at: string;
  readonly shopDate: string;
  readonly utcDate: string;
}

/** The evening a test file will pin, worked out once (before the pin) so module-level dates can be read from it. */
export function theEvening(nowMs: number = Date.now()): Evening {
  const at = lastEveningInstant(nowMs);
  return { at, shopDate: shopDateIn(at), utcDate: at.slice(0, 10) };
}

/**
 * Pin the test process's `Date` (and so the in-process API's and store computer's) to `evening.at`, moving on from there.
 * Call `vi.useRealTimers()` in the suite's `afterAll` to give the real clock back.
 */
export function pinTheEveningClock(evening: Evening = theEvening()): Evening {
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
  vi.setSystemTime(new Date(evening.at));
  return evening;
}

/**
 * Give a browser context the same evening as the test process: its pages' `Date` starts at the process's (pinned) `now`
 * and keeps moving. The browser runs in the machine's zone (UTC on CI), so a screen that took its date from the browser's
 * local day would see the UTC date — exactly the case the shop must never get.
 */
export async function pinThePageClock(context: BrowserContext): Promise<void> {
  await context.clock.install({ time: new Date() });
}
