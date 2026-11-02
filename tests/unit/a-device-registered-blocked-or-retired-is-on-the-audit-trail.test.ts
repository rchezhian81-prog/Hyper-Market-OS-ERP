import { describe, it, expect } from 'vitest';
import { deviceRegistryRoutes, projectFleet, type DeviceRegistryEvent } from '../../services/platform/src/device-registry';
import type { AuditEntry } from '../../packages/audit/src/index';

// M34 · P-04 (Round 4c, Definition of Done): registering a device, re-labelling it, and blocking, retiring or reinstating it
// each leave a sealed audit entry — who did it, to which device, at which branch, what it was before and after, and the
// reason. Before this only the enrolment-code issue was on the audit trail.

function harness() {
  const log: DeviceRegistryEvent[] = [];
  const audits: AuditEntry[] = [];
  let clock = Date.parse('2030-06-01T06:00:00.000Z');
  const routes = deviceRegistryRoutes({
    fleet: (t) => projectFleet(t, log),
    recordDeviceEvent: (_t, e) => { log.push(e); },
    now: () => new Date(clock += 1000).toISOString(),
    recordAudit: (_t, e) => { audits.push(e); },
  });
  const call = (path: string, deviceId: string, body: unknown) => {
    const r = routes.find((x) => x.path === path && x.method === 'POST')!;
    return r.handler({ tenantId: 't', userId: 'u-admin', branchId: 'b1', scope: ['b1'], params: { deviceId }, body, query: {} } as unknown as Parameters<typeof r.handler>[0]);
  };
  return { audits, log, call };
}

describe('device registration and status changes are on the audit trail', () => {
  it('a first registration, a relabel, a block with its reason and a reinstate each leave one entry', async () => {
    const h = harness();
    await h.call('/v1/platform/devices/:deviceId/register', 'hh-7', { branchId: 'b1', kind: 'handheld', label: 'Dock handheld', appVersion: '1.10.0' });
    await h.call('/v1/platform/devices/:deviceId/register', 'hh-7', { branchId: 'b1', kind: 'handheld', label: 'Dock handheld 2' });
    await h.call('/v1/platform/devices/:deviceId/status', 'hh-7', { status: 'blocked', reason: 'reported lost at the dock' });
    await h.call('/v1/platform/devices/:deviceId/status', 'hh-7', { status: 'registered', reason: 'found in the cold room' });

    expect(h.audits.map((a) => a.action)).toEqual(['device.register', 'device.reregister', 'device.status.change', 'device.status.change']);
    for (const a of h.audits) expect(a).toMatchObject({ actorId: 'u-admin', objectType: 'device', objectId: 'hh-7', correlationId: 'hh-7' });
    expect(h.audits[0]).toMatchObject({ before: null, after: { branchId: 'b1', kind: 'handheld', label: 'Dock handheld', appVersion: '1.10.0' } });
    expect(h.audits[1]).toMatchObject({ before: { label: 'Dock handheld', status: 'registered' }, after: { label: 'Dock handheld 2' } });
    expect(h.audits[2]).toMatchObject({ before: { status: 'registered' }, after: { status: 'blocked' }, reason: 'reported lost at the dock' });
    expect(h.audits[3]).toMatchObject({ before: { status: 'blocked' }, after: { status: 'registered' }, reason: 'found in the cold room' });
    // Every value an audit entry carries is a string (the sealed chain's own shape).
    for (const a of h.audits) for (const v of [...Object.values(a.before ?? {}), ...Object.values(a.after ?? {})]) expect(typeof v).toBe('string');
  });

  it('a refused change leaves no audit entry — a status change on a device nobody registered, or an unreadable registration', async () => {
    const h = harness();
    await expect(h.call('/v1/platform/devices/:deviceId/status', 'ghost', { status: 'retired', reason: 'x' })).rejects.toMatchObject({ status: 404 });
    await expect(h.call('/v1/platform/devices/:deviceId/register', 'hh-8', { branchId: 'b1', kind: 'toaster', label: 'x' })).rejects.toMatchObject({ status: 400 });
    expect(h.audits).toEqual([]);
    expect(h.log).toEqual([]);
  });

  it('a registration at a branch the person does not hold is refused and not audited', async () => {
    const h = harness();
    await expect(h.call('/v1/platform/devices/:deviceId/register', 'till-9', { branchId: 'b2', kind: 'pos_lane', label: 'Lane 9' })).rejects.toBeDefined();
    expect(h.audits).toEqual([]);
  });
});
