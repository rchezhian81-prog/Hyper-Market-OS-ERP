import { describe, it, expect } from 'vitest';
import { takingsByHourOf, recentDaysOf } from '../../edge/store-edge/src/screen-data';
import type { LoggedSale } from '../../edge/store-edge/src/read-model';
import { createOwnerSession } from '../../apps/owner-app/src/owner-session';

/**
 * **The owner's trend charts are the shop's own figures, at the shop's clock (UI-3 · M29-FR-01 · D13 hourly · OB-607 · P-08).**
 *
 * The owner app draws today by the hour and the last days the store computer holds. The figures come from the store
 * computer's own log, the same bill totals the takings add up:
 *   • the hour is the SHOP's hour (Asia/Kolkata here) — 12:30 UTC is 18:00 in the shop, never "12:00";
 *   • a trading day that runs past midnight keeps its hours in the order the day ran (23:00 before 00:30);
 *   • a bill with no time is in no hour; a day the box does not hold is absent, never a day of nought;
 *   • the owner session hands them over as sent — `null` when the box did not send them (the phone then says so).
 */

const pack = (timeZone?: string) => ({ policies: { known: true, value: { tradingDayCutoff: '02:00', ...(timeZone === undefined ? {} : { timeZone }) } } });
const sale = (id: string, committedAt: string | undefined, total: number, tradingDay = '2026-11-01'): LoggedSale => ({
  id, tradingDay, total, ...(committedAt === undefined ? {} : { committedAt }),
});

describe('today by the shop\'s hour', () => {
  it('puts each bill in the shop\'s hour, adds the bill totals, and counts the bills', () => {
    const hours = takingsByHourOf(pack('Asia/Kolkata'), [
      sale('a', '2026-11-01T12:30:00.000Z', 10_000), // 18:00 IST
      sale('b', '2026-11-01T12:45:00.000Z', 5_000), //  18:15 IST
      sale('c', '2026-11-01T04:00:00.000Z', 2_000), //  09:30 IST
    ]);
    expect(hours).toEqual([{ hour: '09', bills: 1, takenMinor: 2_000 }, { hour: '18', bills: 2, takenMinor: 15_000 }]);
  });

  it('keeps a day that runs past midnight in the order it ran, and leaves a bill with no time out of every hour', () => {
    const hours = takingsByHourOf(pack('Asia/Kolkata'), [
      sale('late', '2026-11-01T19:00:00.000Z', 300), // 00:30 IST next calendar day, same trading day (cut-off 02:00)
      sale('eve', '2026-11-01T17:40:00.000Z', 700), //  23:10 IST
      sale('notime', undefined, 999),
      sale('bad', 'not a time', 999),
    ]);
    expect(hours.map((h) => h.hour)).toEqual(['23', '00']);
    expect(hours.reduce((t, h) => t + h.bills, 0)).toBe(2);
  });

  it('defaults to the shop\'s published zone, never UTC', () => {
    expect(takingsByHourOf(pack(), [sale('a', '2026-11-01T12:30:00.000Z', 1)])[0]!.hour).toBe('18');
  });
});

describe('the last days the store computer holds', () => {
  it('only the days it holds, oldest first, up to seven, each with its bills and their totals', () => {
    const sales = [
      ...Array.from({ length: 9 }, (_, i) => sale(`d${i}`, undefined, 1_000 * (i + 1), `2026-10-${String(20 + i).padStart(2, '0')}`)),
      sale('x', undefined, 500, '2026-10-28'),
      { id: 'undated', total: 99_999 } as LoggedSale,
    ];
    const days = recentDaysOf(sales);
    expect(days.map((d) => d.tradingDay)).toEqual(['2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28']);
    expect(days.at(-1)).toEqual({ tradingDay: '2026-10-28', bills: 2, takenMinor: 9_500 });
    // a gap day is absent, not nought
    expect(recentDaysOf([sale('a', undefined, 1, '2026-10-01'), sale('b', undefined, 2, '2026-10-05')]).map((d) => d.tradingDay)).toEqual(['2026-10-01', '2026-10-05']);
  });
});

describe('the owner session hands the trend over as sent', () => {
  const base = { branchId: 'b1', name: 'Main', lastSyncedAt: '2026-11-01T12:00:00.000Z', sales: [], exceptions: [], approvals: [] };
  const config = { owner: { userId: 'owner', branchScope: 'all' as const, authorityLimit: null }, staleAfterSeconds: 900, acknowledgeStaleDecisions: true };
  it('returns the figures the store computer sent for the branch in view, and null for what it did not send', () => {
    const session = createOwnerSession(config, [
      { ...base, takingsByHour: [{ hour: '18', bills: 2, takenMinor: 15_000 }], recentDays: [{ tradingDay: '2026-11-01', bills: 2, takenMinor: 15_000 }] },
      { ...base, branchId: 'b2', name: 'Second' },
    ], () => '2026-11-01T12:05:00.000Z');
    expect(session.trends()).toEqual({ byHour: [{ hour: '18', bills: 2, takenMinor: 15_000 }], recentDays: [{ tradingDay: '2026-11-01', bills: 2, takenMinor: 15_000 }] });
    session.viewBranch('b2');
    expect(session.trends()).toEqual({ byHour: null, recentDays: null });
  });
});
