// A scripted store day that must sit inside ONE trading day — sales over the next hour, the shift closed, then "the next
// morning" for the day close — cannot start from the real wall clock. Started at 23:40 the script's later bills were rung
// after the shop's midnight, so the product (rightly, M01-FR-02) booked them on the next trading day, and "the next
// morning" the script jumped to was earlier than its own last bill. The journeys failed only when CI happened to run them
// in the last hour before the cut-off. This pins the test's clock instead.

import { vi } from 'vitest';

/** The hour of the shop's day a scripted journey starts at: mid-morning, well clear of any cut-off on either side. */
export const JOURNEY_STARTS_AT = '10:00';

/**
 * Pin `Date` (only — timers and I/O run normally, and the clock keeps moving) to 10:00 UTC on the current UTC date, and
 * return that date. The journeys that use it set the shop's time zone to UTC and its cut-off to 00:00, so this is 10:00 in
 * the shop's day, with fourteen hours of trading day ahead of the script. `vi.useRealTimers()` in the suite's `afterAll`
 * gives the real clock back.
 */
export function startTheJourneyMidMorning(): string {
  // Never AHEAD of the real clock: the store computer makes its handheld-door certificate from this pinned time
  // (OB-422), and TLS checks it against the REAL clock — a 10:00 pin before 10:00 UTC made it "not yet valid". So before
  // 10:00 UTC the script's day is yesterday; the script still has a whole trading day ahead of it.
  const real = Date.now();
  const today = new Date(real).toISOString().slice(0, 10);
  const day = Date.parse(`${today}T${JOURNEY_STARTS_AT}:00.000Z`) <= real ? today : new Date(real - 86_400_000).toISOString().slice(0, 10);
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
  vi.setSystemTime(new Date(`${day}T${JOURNEY_STARTS_AT}:00.000Z`));
  return day;
}
