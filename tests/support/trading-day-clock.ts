// A scripted store day that must sit inside ONE trading day — sales over the next hour, the shift closed, then "the next
// morning" for the day close — cannot start from the real wall clock. Started at 23:40 the script's later bills were rung
// after the shop's midnight, so the product (rightly, M01-FR-02) booked them on the next trading day, and "the next
// morning" the script jumped to was earlier than its own last bill. The journeys failed only when CI happened to run them
// in the last hour before the cut-off. This pins the test's clock instead.

import { vi } from 'vitest';

/** The hour of the shop's day a scripted journey starts at: mid-morning, well clear of any cut-off on either side. */
export const JOURNEY_STARTS_AT = '10:00';

/**
 * Pin `Date` (only — timers and I/O run normally, and the clock keeps moving) to the most recent 10:00 UTC that has already
 * passed — today's, or yesterday's before 10:00 UTC — and return that date. Never a 10:00 still to come: the store computer
 * stamps its handheld door's certificate from `Date` (valid from an hour before), while TLS checks it against the real clock,
 * so a pinned clock ahead of the real one served a certificate "not yet valid" whenever CI ran before 09:00 UTC (OB-422). The journeys that use it set the shop's time zone to UTC and its cut-off to 00:00, so this is 10:00 in
 * the shop's day, with fourteen hours of trading day ahead of the script. `vi.useRealTimers()` in the suite's `afterAll`
 * gives the real clock back.
 */
export function startTheJourneyMidMorning(): string {
  const now = Date.now();
  const today = new Date(now).toISOString().slice(0, 10);
  const day = Date.parse(`${today}T${JOURNEY_STARTS_AT}:00.000Z`) <= now ? today : new Date(now - 86_400_000).toISOString().slice(0, 10);
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
  vi.setSystemTime(new Date(`${day}T${JOURNEY_STARTS_AT}:00.000Z`));
  return day;
}
