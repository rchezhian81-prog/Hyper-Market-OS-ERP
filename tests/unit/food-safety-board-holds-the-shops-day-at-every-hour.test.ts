import { describe, it, expect } from 'vitest';
import { foodSafetyStatus, type FoodSafetyCheck } from '../../packages/facilities/src/food-safety';
import { startOfToday } from '../../apps/web-erp/src/store-ops-session';

/**
 * **OB-154 / OB-606 — the food-safety board is the SHOP's today at EVERY hour, not just the evening the browser test pins.**
 *
 * tests/e2e/store-ops-screens-on-the-production-api.e2e.ts failed in CI on 25 Oct 2026 at about 00:30 UTC: the board then
 * started "today" at the BROWSER's midnight (a device on UTC), so the 23:00 UTC slot — 04:30 in the shop, the same shop
 * day — fell off the board and the test timed out waiting for it. Round 13 (OB-606) made the board start at the shop's
 * midnight and the browser test now pins 19:30 UTC. That pin proves one hour; this proves the same board at every half
 * hour of a whole UTC day, with the risky moments named: just after the UTC midnight (the 25 Oct failure), 23:00 UTC,
 * and either side of the shop's midnight (18:30 UTC).
 *
 * The oracle is independent of the code under test: Asia/Kolkata is UTC+05:30 all year (no daylight saving), so the
 * shop's midnight before `now` is plain arithmetic.
 */

const SHOP = 'Asia/Kolkata';
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const IST = 5.5 * HOUR;
const shopMidnightBefore = (ms: number): number => Math.floor((ms + IST) / DAY) * DAY - IST;

// The browser test's check: hourly on the shop's hours (XX:30 UTC), 59 minutes' grace, started days ago.
const chiller: FoodSafetyCheck = {
  checkId: 'fs-chiller', branchId: 'br-1', title: 'Dairy chiller', kind: 'temperature', everyMinutes: 60,
  startsAt: '2026-10-20T00:30:00.000Z', graceMinutes: 59, minTenthsC: 0, maxTenthsC: 50, items: [],
  assignedRole: 'store_manager', escalatesTo: 'u-owner', active: true,
};

/** The board as the page asks for it at `nowIso`: from the shop's midnight (startOfToday), as of now. */
const boardAt = (nowIso: string) => {
  const from = startOfToday(new Date(nowIso), SHOP);
  return { from, status: foodSafetyStatus({ checks: [chiller], records: [], from, asAt: nowIso }) };
};
const stateOf = (status: ReturnType<typeof foodSafetyStatus>, slotMs: number) =>
  status.slots.find((s) => s.slotDueAt === new Date(slotMs).toISOString())?.state;

describe('the food-safety board holds the shop\'s day at every hour (OB-154 · OB-606)', () => {
  it('at every half hour of a UTC day: from the shop\'s midnight; this hour\'s slot DUE, the last one MISSED, none from yesterday', () => {
    const dayStart = Date.parse('2026-10-24T00:00:00.000Z');
    for (let k = 0; k < 48; k += 1) {
      const nowMs = dayStart + k * 30 * MIN + MIN; // a minute into each half hour
      const now = new Date(nowMs).toISOString();
      const { from, status } = boardAt(now);
      const midnight = shopMidnightBefore(nowMs);
      expect(from, `from at ${now}`).toBe(new Date(midnight).toISOString());
      // No slot from the shop's yesterday is on today's board.
      expect(status.slots.every((s) => Date.parse(s.slotDueAt) >= midnight), `yesterday's slots at ${now}`).toBe(true);
      // This hour's slot (the latest XX:30 at or before now) is DUE; the one before it is MISSED when it is today's.
      const thisSlot = Math.floor((nowMs - 30 * MIN) / HOUR) * HOUR + 30 * MIN;
      expect(stateOf(status, thisSlot), `this hour's slot at ${now}`).toBe('due');
      if (thisSlot - HOUR >= midnight) expect(stateOf(status, thisSlot - HOUR), `last hour's slot at ${now}`).toBe('missed');
      else expect(stateOf(status, thisSlot - HOUR), `yesterday's last slot at ${now}`).toBeUndefined();
      // Every slot since the shop's midnight before this hour's is on the board, MISSED.
      expect(status.missed.length, `missed count at ${now}`).toBe(Math.round((thisSlot - midnight) / HOUR));
    }
  });

  it('25 Oct, 00:31 UTC (the CI failure): the 23:30 UTC slot of the UTC yesterday is the shop\'s today, and MISSED', () => {
    const { from, status } = boardAt('2026-10-25T00:31:00.000Z');
    expect(from).toBe('2026-10-24T18:30:00.000Z'); // a board from the UTC midnight would start at 2026-10-25T00:00
    expect(stateOf(status, Date.parse('2026-10-24T23:30:00.000Z'))).toBe('missed');
    expect(stateOf(status, Date.parse('2026-10-25T00:30:00.000Z'))).toBe('due');
  });

  it('23:01 UTC: the board is the shop\'s today (from 18:30 UTC), not the UTC date\'s', () => {
    const { from, status } = boardAt('2026-10-24T23:01:00.000Z');
    expect(from).toBe('2026-10-24T18:30:00.000Z');
    expect(status.missed.map((s) => s.slotDueAt)).toEqual(['2026-10-24T18:30:00.000Z', '2026-10-24T19:30:00.000Z', '2026-10-24T20:30:00.000Z', '2026-10-24T21:30:00.000Z']);
    expect(stateOf(status, Date.parse('2026-10-24T22:30:00.000Z'))).toBe('due');
  });

  it('either side of the shop\'s midnight: at 18:29 UTC yesterday\'s board; at 18:31 UTC a fresh board with only 00:00 due', () => {
    const before = boardAt('2026-10-24T18:29:00.000Z');
    expect(before.from).toBe('2026-10-23T18:30:00.000Z');
    expect(before.status.missed.length).toBe(23); // 00:00 to 22:00 in the shop; 23:00 (17:30 UTC) still due
    expect(stateOf(before.status, Date.parse('2026-10-24T17:30:00.000Z'))).toBe('due');
    const after = boardAt('2026-10-24T18:31:00.000Z');
    expect(after.from).toBe('2026-10-24T18:30:00.000Z');
    expect(after.status.missed).toEqual([]);
    expect(stateOf(after.status, Date.parse('2026-10-24T17:30:00.000Z'))).toBeUndefined();
    expect(stateOf(after.status, Date.parse('2026-10-24T18:30:00.000Z'))).toBe('due');
  });
});
