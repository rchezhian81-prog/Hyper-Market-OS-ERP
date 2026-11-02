import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { theEvening, lastEveningInstant } from '../support/evening-clock';
import { shopDateIn } from '../../packages/calendar/src/shop-clock';

/**
 * **The suites that once failed only after 18:30 UTC run there EVERY time (M01-FR-02 · P-08 · 1 Nov 2026).**
 *
 * The shop is in Asia/Kolkata (UTC+5:30): from 18:30 to 24:00 UTC its date is already the next day. On 1 Nov 2026 ten tests
 * and one browser test failed on an unchanged main in that window and passed in daylight — two because the product mixed the
 * UTC date with the shop's (head office's price-change gate; the store computer's price day before a 02:00 cut-off), the rest
 * because a test built "today" from the UTC date. A suite run only in daylight UTC never sees the case, so each of these pins
 * its clock to an evening UTC moment (tests/support/evening-clock.ts, `pinTheEveningClock`: 01:00 the next morning in the
 * shop). This tripwire fails if one stops pinning it, or if the pinned moment ever stops being one where the dates differ.
 *
 * One fixed file is not pinned: tests/integration/p6-floor-devices-are-signed-switched-on-and-never-edit-a-ledger.test.ts
 * (its CCTV links now ask for the shop's date of the event). The pinned `Date` only moves between event-loop turns, so its
 * in-memory run gave two status changes of one device the same millisecond, and the device log keys a status change by
 * its time — a separate matter, reported. The shop's day of the CCTV links is proved under the pinned evening by
 * tests/integration/r16a-the-camera-and-the-claim-take-the-shops-day.test.ts and by the self-checkout suite below.
 */

const PINNED_SUITES: readonly string[] = [
  'tests/integration/the-owners-takings-are-net-of-refunds.test.ts',
  'tests/integration/price-list-effective-dating.test.ts',
  'tests/integration/a-price-set-just-after-the-shops-midnight-still-needs-a-second-person.test.ts',
  'tests/integration/a-rebate-claim-under-an-unapproved-scheme-warns-and-a-sent-claim-is-withdrawn-with-a-reason.test.ts',
  'tests/integration/production-moves-ordinary-stock.test.ts',
  'tests/integration/p6-a-self-checkout-basket-reaches-loss-prevention-and-the-camera-links.test.ts',
  'tests/e2e/round-a-the-office-pages-show-head-offices-records.e2e.ts',
  'tests/integration/r7d-an-expired-food-certificate-blocks-food-work-and-marks-are-relayed.test.ts',
  'tests/integration/r7d-the-roster-and-certificates-ride-the-signed-pack-to-the-box.test.ts',
  // W3 (money): the rebate period runs to the shop's today.
  'tests/e2e/w3-earned-rebates-are-measured-and-put-in-the-books-on-the-rebates-page.e2e.ts',
];

const code = (file: string): string => readFileSync(file, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

describe('the shop\'s small hours are always tested', () => {
  it('each suite that failed only after 18:30 UTC pins the evening clock, and gives the real clock back', () => {
    const missing = PINNED_SUITES.filter((f) => {
      const c = code(f);
      return !/import \{[^}]*\bpinTheEveningClock\b[^}]*\} from '\.\.\/support\/evening-clock'/.test(c)
        || !/\bpinTheEveningClock\(/.test(c)
        || !/vi\.useRealTimers\(\)/.test(c);
    });
    expect(missing).toEqual([]);
  });

  it('the browser suite pins its pages\' clocks too (a browser on UTC is on the shop\'s yesterday)', () => {
    for (const f of PINNED_SUITES.filter((s) => s.endsWith('.e2e.ts'))) expect(code(f), f).toMatch(/\bpinThePageClock\(/);
  });

  it('the pinned moment is always one where the shop is on the day after the UTC date', () => {
    // Whatever time the suite runs at — including midnight UTC, 18:29 and 18:31 UTC — the evening it pins is in the window.
    for (const at of ['2026-11-01T00:00:00.000Z', '2026-11-01T18:29:00.000Z', '2026-11-01T18:31:00.000Z', '2026-11-01T23:59:59.000Z', new Date().toISOString()]) {
      const e = theEvening(Date.parse(at));
      expect(Date.parse(e.at) <= Date.parse(at), at).toBe(true); // never a moment still to come (OB-422)
      expect(e.shopDate, at).not.toBe(e.utcDate);
      expect(e.shopDate).toBe(shopDateIn(lastEveningInstant(Date.parse(at))));
    }
  });
});
