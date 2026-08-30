import { describe, it, expect } from 'vitest';
import { apiHarness } from '../support/api-harness';
import { createFleetSession, type FleetDeviceRow, type FleetPorts } from '../../apps/web-erp/src/fleet-session';
import { deviceChangeRequest, type FleetDeliveryPort } from '../../apps/web-erp/src/fleet-device-delivery';
import { SyncOutbox } from '../../packages/sync/src/outbox';

/**
 * **The fleet change reaches the registry — end to end, as the person who made it (M33-FR-02/04 · P-04 · P-05).**
 *
 * The whole write path: a manager blocks a device on the screen (`requestDeviceChange` → the offline outbox),
 * then the explicit deliver drains it through an operator-authenticated port to the durable registry, where
 * the change actually lands. The port here POSTs to the registry AS the given operator — exactly what the
 * browser's `credentials: 'same-origin'` achieves — so this proves the authority model: a change delivered by
 * a manager applies; the SAME change delivered by someone without `platform.device.manage` is refused (403)
 * and dead-lettered for a person, never applied under a borrowed identity.
 */

const TENANT = 't-sre';

/** A delivery port that POSTs each queued command to the registry AS `userId` (the authenticated operator). */
const harnessPort = (h: ReturnType<typeof apiHarness>, userId: string): FleetDeliveryPort => ({
  post: async (command, idempotencyKey) => {
    const { path, body } = deviceChangeRequest(command);
    const res = await h.request({ method: 'POST', path, userId, tenantId: TENANT, idempotencyKey, body });
    return res.status;
  },
});

const registeredRow: FleetDeviceRow = {
  deviceId: 'till-3', label: 'Lane 3', kind: 'pos_lane', branchId: 'b-main', status: 'registered',
  appVersion: '1.10.0', verdict: 'ok', mayTrade: true, mustUpgrade: false, detail: '', silent: false,
};

const managerPorts = (userId: string | null, outbox: SyncOutbox, port: FleetDeliveryPort): FleetPorts => ({
  fleet: () => ({ summary: { total: 1, trading: 1, blocked: 0, mustUpgrade: 0, silent: 0, byVersion: {} }, devices: [registeredRow] }),
  mayRead: () => true,
  mayManage: () => userId !== null,
  outbox: () => outbox,
  deliveryPort: () => port,
});

const statusOf = async (h: ReturnType<typeof apiHarness>, u: string, deviceId: string): Promise<string | undefined> => {
  const list = await h.request({ method: 'GET', path: '/v1/platform/devices', userId: u, tenantId: TENANT });
  return (list.body as { devices: { deviceId: string; status: string }[] }).devices.find((d) => d.deviceId === deviceId)?.status;
};

describe('a device change made on the screen reaches the registry', () => {
  it('a manager’s block is queued offline, then delivered to the registry and applied', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'u-mgr');
    await h.request({
      method: 'POST', path: '/v1/platform/devices/till-3/register', userId: 'u-mgr', tenantId: TENANT, idempotencyKey: 'r-1',
      body: { branchId: 'b-main', kind: 'pos_lane', label: 'Lane 3', appVersion: '1.10.0' },
    });
    expect(await statusOf(h, 'u-mgr', 'till-3')).toBe('registered');

    const outbox = new SyncOutbox();
    const session = createFleetSession({ userId: 'u-mgr' }, managerPorts('u-mgr', outbox, harnessPort(h, 'u-mgr')));
    // 1) the manager blocks the device on the screen — captured offline, nothing sent yet
    const queued = session.requestDeviceChange({ deviceId: 'till-3', change: 'block', reason: 'reported stolen', at: '2026-08-30T05:00:00Z' });
    expect(queued.ok).toBe(true);
    expect(outbox.unsentCount()).toBe(1);
    expect(await statusOf(h, 'u-mgr', 'till-3')).toBe('registered'); // still not applied

    // 2) the explicit deliver drains it to the registry
    const report = await session.deliver();
    expect(report.delivered).toHaveLength(1);
    expect(outbox.unsentCount()).toBe(0);
    expect(await statusOf(h, 'u-mgr', 'till-3')).toBe('blocked'); // now applied in the durable fleet
  });

  it('the same change delivered by someone without the manage permission is refused (403) and dead-lettered', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'u-mgr');
    await h.request({
      method: 'POST', path: '/v1/platform/devices/till-3/register', userId: 'u-mgr', tenantId: TENANT, idempotencyKey: 'r-1',
      body: { branchId: 'b-main', kind: 'pos_lane', label: 'Lane 3', appVersion: '1.10.0' },
    });

    // The command is queued by the manager, but DELIVERED under an operator who does not hold the permission.
    const outbox = new SyncOutbox();
    const session = createFleetSession({ userId: 'u-mgr' }, managerPorts('u-mgr', outbox, harnessPort(h, 'u-nobody')));
    session.requestDeviceChange({ deviceId: 'till-3', change: 'block', reason: 'x', at: '2026-08-30T05:00:00Z' });
    const report = await session.deliver();

    expect(report.refused).toHaveLength(1);
    expect(report.delivered).toHaveLength(0);
    expect(outbox.deadLetters()).toHaveLength(1); // kept for a person, never applied under a borrowed identity
    expect(await statusOf(h, 'u-mgr', 'till-3')).toBe('registered'); // unchanged — the refusal did not apply
  });
});
