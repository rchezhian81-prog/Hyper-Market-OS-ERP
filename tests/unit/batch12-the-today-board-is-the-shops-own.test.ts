import { describe, it, expect } from 'vitest';
import { todayBoard } from '../../edge/store-edge/src/screen-data';
import type { ScreenInput } from '../../edge/store-edge/src/screen-data';
import type { LoggedSale } from '../../edge/store-edge/src/read-model';

/**
 * **The Today board is the shop's own figures — never a made-up comparison (batch 12 · owner's Today look · P-08).**
 *
 * The owner's new Today page shows each card against the previous day, a chart by the hour and by the week, the last
 * bills, and when the box last sent its records to head office. Every one of them comes from this box's log:
 *   • "vs. previous day" is the most recent EARLIER day the box holds, counted only up to the same time of day as now —
 *     a morning is never compared with a whole day;
 *   • a box that holds no earlier day says so (`previous: null`) — the page then says "no previous day yet", never +0%;
 *   • the recent bills are today's, newest first, at the shop's clock (Asia/Kolkata), at most eight;
 *   • the last sync is the box's own record of it, and absent on a box that does not keep one ("Not known" on the page).
 */

const pack = { policies: { known: true, value: { tradingDayCutoff: '02:00', timeZone: 'Asia/Kolkata' } } };
const sale = (id: string, tradingDay: string, committedAt: string | undefined, total: number): LoggedSale => ({
  id, number: `B-${id}`, laneId: 'lane-1', cashierId: 'u-cashier', tradingDay, total, ...(committedAt === undefined ? {} : { committedAt }),
});
const input = (sales: readonly LoggedSale[], extra: Partial<Record<string, unknown>> = {}): ScreenInput =>
  ({ pack, sales, tradingDay: '2026-11-17', now: '2026-11-17T06:30:00.000Z' /* 12:00 in the shop */, ...extra }) as unknown as ScreenInput;

describe('the Today board', () => {
  it('compares today with the previous held day BY THIS TIME, never with the whole of it', () => {
    const board = todayBoard(input([
      sale('t1', '2026-11-17', '2026-11-17T04:00:00.000Z', 10_000), // 09:30 today
      sale('t2', '2026-11-17', '2026-11-17T05:00:00.000Z', 5_000), //  10:30 today
      sale('y1', '2026-11-16', '2026-11-16T04:00:00.000Z', 8_000), //  09:30 yesterday — counts
      sale('y2', '2026-11-16', '2026-11-16T12:00:00.000Z', 90_000), // 17:30 yesterday — later than now, does not count
      sale('y3', '2026-11-16', undefined, 1_000), //                   no time — cannot be placed, does not count
    ]));
    expect(board.today).toEqual({ tradingDay: '2026-11-17', bills: 2, takenMinor: 15_000 });
    expect(board.previous).toEqual({ tradingDay: '2026-11-16', bills: 1, takenMinor: 8_000, byThisTime: true });
  });

  it('skips a gap: the previous day is the last EARLIER day the box holds, moved by the whole days between', () => {
    const board = todayBoard(input([
      sale('t1', '2026-11-17', '2026-11-17T04:00:00.000Z', 100),
      sale('w1', '2026-11-14', '2026-11-14T03:00:00.000Z', 700), // 08:30 three days ago — counts
      sale('w2', '2026-11-14', '2026-11-14T08:00:00.000Z', 900), // 13:30 three days ago — does not
    ]));
    expect(board.previous).toEqual({ tradingDay: '2026-11-14', bills: 1, takenMinor: 700, byThisTime: true });
  });

  it('says there is no previous day when the box holds none — never a comparison made from nothing', () => {
    const board = todayBoard(input([sale('t1', '2026-11-17', '2026-11-17T04:00:00.000Z', 100)]));
    expect(board.previous).toBeNull();
    expect(todayBoard(input([])).today).toEqual({ tradingDay: '2026-11-17', bills: 0, takenMinor: 0 });
  });

  it('lists today\'s last eight bills, newest first, at the shop\'s clock', () => {
    const sales = Array.from({ length: 10 }, (_, i) => sale(`t${i}`, '2026-11-17', `2026-11-17T0${i % 10}:00:00.000Z`, 100 * (i + 1)));
    const board = todayBoard(input([...sales, sale('old', '2026-11-16', '2026-11-16T05:00:00.000Z', 5)]));
    expect(board.recent).toHaveLength(8);
    expect(board.recent[0]).toEqual({ id: 't9', number: 'B-t9', at: '14:30', laneId: 'lane-1', cashierId: 'u-cashier', totalMinor: 1_000 });
    expect(board.recent.map((r) => r.id)).not.toContain('old');
  });

  it('gives the chart today by the shop\'s hour and the days it holds', () => {
    const board = todayBoard(input([
      sale('t1', '2026-11-17', '2026-11-17T04:00:00.000Z', 100),
      sale('t2', '2026-11-17', '2026-11-17T04:10:00.000Z', 200),
      sale('y1', '2026-11-16', '2026-11-16T04:00:00.000Z', 50),
    ]));
    expect(board.byHour).toEqual([{ hour: '09', bills: 2, takenMinor: 300 }]);
    expect(board.week).toEqual([{ tradingDay: '2026-11-16', bills: 1, takenMinor: 50 }, { tradingDay: '2026-11-17', bills: 2, takenMinor: 300 }]);
  });

  it('carries the box\'s own last sync at the shop\'s clock — and nothing at all where the box keeps no such record', () => {
    expect(todayBoard(input([], { laneLink: { lastSentAt: '2026-11-17T05:15:00.000Z' } }))).toMatchObject({ lastSentAt: '2026-11-17T05:15:00.000Z', lastSentShop: '10:45' });
    expect(todayBoard(input([], { laneLink: { lastSentAt: null } }))).toMatchObject({ lastSentAt: null, lastSentShop: null });
    expect('lastSentAt' in todayBoard(input([]))).toBe(false);
  });
});
