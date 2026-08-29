import { describe, it, expect } from 'vitest';
import { projectFleet, type DeviceRegistryEvent } from '../../services/platform/src/device-registry';

// The pure fold under the durable device registry (M33-FR-02/04): the append-only device log becomes the
// current fleet, latest state per deviceId, in event order.

const T = 't1';
const reg = (deviceId: string, at: string, over: Partial<DeviceRegistryEvent> = {}): DeviceRegistryEvent =>
  ({ kind: 'registered', deviceId, at, branchId: 'b1', deviceKind: 'pos_lane', label: deviceId, appVersion: '1.10.0', by: 'u-owner', ...over });

describe('projectFleet — the fleet is a projection of the append-only log', () => {
  it('registers a device with its current state', () => {
    const fleet = projectFleet(T, [reg('till-3', '2026-08-01T00:00:00Z')]);
    expect(fleet).toHaveLength(1);
    expect(fleet[0]).toMatchObject({ deviceId: 'till-3', tenantId: T, status: 'registered', appVersion: '1.10.0', lastSeenAt: '2026-08-01T00:00:00Z' });
  });

  it('re-registering updates the SAME record, never forks a second', () => {
    const fleet = projectFleet(T, [
      reg('till-3', '2026-08-01T00:00:00Z', { label: 'Old' }),
      reg('till-3', '2026-08-02T00:00:00Z', { label: 'Lane 3', appVersion: '1.11.0' }),
    ]);
    expect(fleet).toHaveLength(1);
    expect(fleet[0]).toMatchObject({ label: 'Lane 3', appVersion: '1.11.0' });
  });

  it('moves a device on a status change, keeping the rest of its state', () => {
    const fleet = projectFleet(T, [
      reg('till-3', '2026-08-01T00:00:00Z'),
      { kind: 'status', deviceId: 'till-3', status: 'blocked', reason: 'stolen', by: 'u-owner', at: '2026-08-03T00:00:00Z' },
    ]);
    expect(fleet[0]).toMatchObject({ deviceId: 'till-3', status: 'blocked', appVersion: '1.10.0' });
  });

  it('a heartbeat updates when it was last seen and what it runs', () => {
    const fleet = projectFleet(T, [
      reg('till-3', '2026-08-01T00:00:00Z', { appVersion: '1.9.0' }),
      { kind: 'reported', deviceId: 'till-3', at: '2026-08-05T09:00:00Z', appVersion: '1.10.0', integrityCompromised: true },
    ]);
    expect(fleet[0]).toMatchObject({ lastSeenAt: '2026-08-05T09:00:00Z', appVersion: '1.10.0', integrityCompromised: true });
  });

  it('ignores a status or heartbeat for a device that was never registered — no phantom till', () => {
    const fleet = projectFleet(T, [
      { kind: 'status', deviceId: 'ghost', status: 'blocked', reason: 'x', by: 'u-owner', at: '2026-08-01T00:00:00Z' },
      { kind: 'reported', deviceId: 'ghost', at: '2026-08-02T00:00:00Z' },
    ]);
    expect(fleet).toHaveLength(0);
  });

  it('returns the fleet sorted by deviceId, so the list is stable', () => {
    const fleet = projectFleet(T, [reg('till-9', '2026-08-01T00:00:00Z'), reg('till-1', '2026-08-01T00:00:00Z')]);
    expect(fleet.map((d) => d.deviceId)).toEqual(['till-1', 'till-9']);
  });
});
