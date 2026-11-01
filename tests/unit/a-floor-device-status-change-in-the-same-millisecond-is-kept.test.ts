import { describe, it, expect } from 'vitest';
import { InMemoryEventStore } from '../../packages/persistence/src/event-store';
import { floorDevicesAdapter, StandInEslVendor } from '../../services/api/src/floor-devices-adapters';

// Found while pinning the shop's clock (1 Nov 2026): two status changes to one floor device in the SAME millisecond shared
// one event identity, so the store kept the first and silently dropped the second as a replay — a device blocked and then
// switched back on read as still blocked (P-08, CLAUDE.md rule 10). Each change is its own fact; the same change twice is one.
describe('a floor device status change in the same millisecond is kept (M33 · P-08)', () => {
  const AT = '2026-11-01T20:00:00.000Z';
  const change = (status: 'active' | 'blocked', reason: string) =>
    ({ entry: 'status' as const, deviceId: 'ESL-1', status, reason, by: 'u-it', at: AT });

  it('blocked then active in one millisecond: both are stored, in order', async () => {
    const deps = floorDevicesAdapter({ store: new InMemoryEventStore(), now: () => AT, eslVendor: new StandInEslVendor() }, []);
    await deps.recordLog('t-1', change('blocked', 'battery swap'));
    await deps.recordLog('t-1', change('active', 'battery replaced'));
    const log = await deps.log('t-1');
    expect(log.map((e) => (e.entry === 'status' ? e.status : e.entry))).toEqual(['blocked', 'active']);
  });

  it('the same change sent twice is still one record', async () => {
    const deps = floorDevicesAdapter({ store: new InMemoryEventStore(), now: () => AT, eslVendor: new StandInEslVendor() }, []);
    await deps.recordLog('t-1', change('blocked', 'battery swap'));
    await deps.recordLog('t-1', change('blocked', 'battery swap'));
    expect(await deps.log('t-1')).toHaveLength(1);
  });
});
