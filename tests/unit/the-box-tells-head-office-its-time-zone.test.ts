import { describe, it, expect } from 'vitest';
import { boxHealthReportOf, zoneReport } from '../../edge/sync-agent/src/box-health-report';
import { zoneCheck } from '../../edge/store-edge/src/shop-zone';
import { readBoxHealthReport } from '../../services/platform/src/box-health';

// R3 · P-08: the box's own time-zone check rides its health report to head office — four facts, no staff sentences — and
// head office reads it (or refuses an unreadable one by name). An older box that says nothing is read as before.

const pack = (timeZone?: string) => ({ policies: { known: true, value: { tradingDayCutoff: '00:00', ...(timeZone === undefined ? {} : { timeZone }) } } });
const sources = (zone?: () => ReturnType<typeof zoneCheck>) => ({
  now: () => '2026-10-26T05:00:00.000Z',
  disk: async () => ({ freeBytes: 10, totalBytes: 20, salesLogUsedBytes: 1, salesLogCapacityBytes: 10, reserveBytes: 1 }),
  queues: () => [{ unsentCount: 0, deadLetterCount: 0 }],
  tills: () => [],
  ...(zone === undefined ? {} : { zone }),
});

describe('the box tells head office its time zone (R3 · P-08)', () => {
  it('the report carries the four facts of the check — never the staff sentences — and none when the box does not say', async () => {
    const r = await boxHealthReportOf(sources(() => zoneCheck(pack('Asia/Kolkata'), 'UTC')));
    expect(r.zoneCheck).toEqual({ verdict: 'differs', shopTimeZone: 'Asia/Kolkata', shopTimeZoneFrom: 'store_pack', machineTimeZone: 'UTC' });
    expect(JSON.stringify(r)).not.toContain('Tell IT');
    expect((await boxHealthReportOf(sources(() => zoneCheck(pack(), 'Asia/Kolkata')))).zoneCheck).toEqual({ verdict: 'in_step', shopTimeZone: 'Asia/Kolkata', shopTimeZoneFrom: 'shop_default', machineTimeZone: 'Asia/Kolkata' });
    expect('zoneCheck' in (await boxHealthReportOf(sources()))).toBe(false);
    expect(zoneReport({ verdict: 'differs', shopTimeZone: 'x'.repeat(100), shopTimeZoneFrom: 'store_pack', machineTimeZone: 'UTC' }).shopTimeZone.length).toBe(64);
  });

  it('head office reads it, refuses an unreadable one by name, and reads an older box as before', async () => {
    const report = await boxHealthReportOf(sources(() => zoneCheck(pack('Asia/Kolkata'), 'UTC')));
    const read = readBoxHealthReport(report, '2026-10-26T05:00:01.000Z');
    expect('problems' in read ? read.problems : read.zoneCheck).toEqual({ verdict: 'differs', shopTimeZone: 'Asia/Kolkata', shopTimeZoneFrom: 'store_pack', machineTimeZone: 'UTC' });
    for (const bad of [{ verdict: 'maybe', shopTimeZone: 'Asia/Kolkata', shopTimeZoneFrom: 'store_pack', machineTimeZone: 'UTC' }, { verdict: 'differs' }, 'UTC', { verdict: 'differs', shopTimeZone: 'Asia/Kolkata', shopTimeZoneFrom: 'guess', machineTimeZone: 'UTC' }]) {
      const r = readBoxHealthReport({ ...report, zoneCheck: bad }, '2026-10-26T05:00:01.000Z');
      expect('problems' in r ? r.problems.join(' ') : 'read').toMatch(/zoneCheck needs verdict/);
    }
    const older = Object.fromEntries(Object.entries(report).filter(([k]) => k !== 'zoneCheck'));
    const r = readBoxHealthReport(older, '2026-10-26T05:00:01.000Z');
    expect('problems' in r ? 'refused' : 'zoneCheck' in r).toBe(false);
  });
});
