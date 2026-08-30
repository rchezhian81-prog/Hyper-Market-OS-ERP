import { describe, it, expect } from 'vitest';
import { fleetPortsFromData, bootFleet } from '../../apps/web-erp/src/browser-entry';
import { deviceChangeKey, type DeviceChangePayload } from '../../apps/web-erp/src/fleet-device-command';
import { SyncOutbox } from '../../packages/sync/src/outbox';

// The browser-entry wiring for the fleet screen (inc-2c-ii): the register/block/retire action a manager
// takes on the shell must land in the SAME device-backed outbox the sync agent later drains (P-01, §31).

const READ = 'platform.health.read';
const MANAGE = 'platform.device.manage';
const aDevice = { deviceId: 'till-3', label: 'Till 3', kind: 'pos_lane', branchId: 'main', status: 'registered', verdict: 'ok' as const, mayTrade: true, mustUpgrade: false, detail: '', silent: false };

describe('fleetPortsFromData — permissions and the injected outbox', () => {
  it('default-deny: an absent permission list can read or manage nothing', () => {
    const ports = fleetPortsFromData(undefined);
    expect(ports.mayRead()).toBe(false);
    expect(ports.mayManage()).toBe(false);
  });

  it('grants read/manage only for the held permissions and exposes the injected outbox', () => {
    const outbox = new SyncOutbox();
    const ports = fleetPortsFromData({ permissions: [READ, MANAGE] }, outbox);
    expect(ports.mayRead()).toBe(true);
    expect(ports.mayManage()).toBe(true);
    expect(ports.outbox?.()).toBe(outbox); // the SAME instance the sync agent will drain
  });

  it('read without manage: can see the fleet but not change it', () => {
    const ports = fleetPortsFromData({ permissions: [READ] });
    expect(ports.mayRead()).toBe(true);
    expect(ports.mayManage()).toBe(false);
  });
});

describe('bootFleet — a change taken on the screen lands in the shared outbox', () => {
  it('returns null when the box carried no fleet payload', () => {
    expect(bootFleet(undefined)).toBeNull();
  });

  it('commits a manager’s block to the injected outbox, attributed to them', () => {
    const outbox = new SyncOutbox();
    const session = bootFleet({ userId: 'u-mgr', permissions: [READ, MANAGE], devices: [aDevice] }, outbox);
    expect(session).not.toBeNull();
    const r = session!.requestDeviceChange({ deviceId: 'till-3', change: 'block', reason: 'cracked', at: '2026-08-30T05:00:00Z' });
    expect(r.ok).toBe(true);
    const item = outbox.find(deviceChangeKey('till-3', 'block', 'registered'));
    expect(item).toBeDefined();
    expect((item!.event.payload as DeviceChangePayload).requestedBy).toBe('u-mgr');
  });

  it('a viewer without manage cannot queue a change', () => {
    const outbox = new SyncOutbox();
    const session = bootFleet({ userId: 'u-1', permissions: [READ], devices: [aDevice] }, outbox);
    expect(session!.requestDeviceChange({ deviceId: 'till-3', change: 'block', reason: 'x', at: '2026-08-30T05:00:00Z' }))
      .toEqual({ ok: false, reason: 'not_permitted' });
    expect(outbox.unsentCount()).toBe(0);
  });
});
