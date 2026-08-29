import { describe, it, expect } from 'vitest';
import { apiHarness } from '../support/api-harness';

/**
 * **Durable device registry, end to end (M33-FR-02/04 · A-10 · §35, API-10).**
 *
 * The write path under the stateless device decisions: the shop's REAL fleet, event-sourced and folded
 * latest-per-device so it survives a restart. A till nobody registered is a till nobody is accountable
 * for; a status change on one nobody registered is refused; and the fleet-health rollup runs the tested
 * engine over the STORED fleet, refusing a policy that would brick the fleet before it reports (A-10).
 */

const TENANT = 't-sre';
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
const POLICY = { currentVersion: '1.10.0', previousVersion: '1.9.0', minimumSupportedVersion: '1.9.0' };
const register = (h: ReturnType<typeof apiHarness>, u: string, id: string, body: Record<string, unknown>, key: string) =>
  h.request({ method: 'POST', path: `/v1/platform/devices/${id}/register`, userId: u, tenantId: TENANT, idempotencyKey: key, body });

describe('durable device registry (M33-FR-02/04)', () => {
  it('registers a device and lists it in the stored fleet', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'u-owner');
    const reg = await register(h, 'u-owner', 'till-3', { branchId: 'b-main', kind: 'pos_lane', label: 'Lane 3', appVersion: '1.10.0' }, 'r-1');
    expect(reg.status).toBe(201);

    const list = await h.request({ method: 'GET', path: '/v1/platform/devices', userId: 'u-owner', tenantId: TENANT });
    expect(list.status).toBe(200);
    const body = list.body as { devices: { deviceId: string; label: string; status: string; appVersion?: string }[]; count: number };
    expect(body.count).toBe(1);
    expect(body.devices[0]).toMatchObject({ deviceId: 'till-3', label: 'Lane 3', status: 'registered', appVersion: '1.10.0' });
  });

  it('blocks a device — reflected in the fleet and in fleet-health', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'u-owner');
    await register(h, 'u-owner', 'till-3', { branchId: 'b-main', kind: 'pos_lane', label: 'Lane 3', appVersion: '1.10.0' }, 'r-1');
    const blocked = await h.request({
      method: 'POST', path: '/v1/platform/devices/till-3/status', userId: 'u-owner', tenantId: TENANT, idempotencyKey: 'b-1',
      body: { status: 'blocked', reason: 'reported stolen' },
    });
    expect(blocked.status).toBe(200);

    const health = await h.request({
      method: 'POST', path: '/v1/platform/devices/fleet-health', userId: 'u-owner', tenantId: TENANT, idempotencyKey: 'fh-1',
      body: { policy: POLICY },
    });
    expect(health.status).toBe(200);
    const b = health.body as { summary: { total: number; trading: number; blocked: number }; devices: { device: { deviceId: string }; decision: { verdict: string; mayTrade: boolean } }[] };
    expect(b.summary.total).toBe(1);
    expect(b.summary.trading).toBe(0);
    expect(b.summary.blocked).toBe(1);
    expect(b.devices[0]?.decision.verdict).toBe('blocked');
    expect(b.devices[0]?.decision.mayTrade).toBe(false);
  });

  it('keeps the fleet across a restart — a fresh process over the same store still sees it', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'u-owner');
    await register(h, 'u-owner', 'till-3', { branchId: 'b-main', kind: 'pos_lane', label: 'Lane 3', appVersion: '1.10.0' }, 'r-1');

    const restarted = apiHarness({ store: h.store });
    const list = await restarted.request({ method: 'GET', path: '/v1/platform/devices', userId: 'u-owner', tenantId: TENANT });
    expect((list.body as { count: number }).count).toBe(1);
    expect((list.body as { devices: { deviceId: string }[] }).devices[0]?.deviceId).toBe('till-3');
  });

  it('refuses a status change on a device nobody registered', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'u-owner');
    const res = await h.request({
      method: 'POST', path: '/v1/platform/devices/ghost/status', userId: 'u-owner', tenantId: TENANT, idempotencyKey: 's-ghost',
      body: { status: 'retired', reason: 'never existed' },
    });
    expect(res.status).toBe(404);
    expect(codeOf(res)).toBe('device_not_registered');
  });

  it('reports fleet-health over the stored fleet: who trades and who must upgrade', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'u-owner');
    await register(h, 'u-owner', 'till-3', { branchId: 'b-main', kind: 'pos_lane', label: 'Lane 3', appVersion: '1.10.0' }, 'r-3');
    await register(h, 'u-owner', 'till-4', { branchId: 'b-main', kind: 'pos_lane', label: 'Lane 4', appVersion: '1.2.0' }, 'r-4'); // too old
    const health = await h.request({
      method: 'POST', path: '/v1/platform/devices/fleet-health', userId: 'u-owner', tenantId: TENANT, idempotencyKey: 'fh-2',
      body: { policy: POLICY },
    });
    const b = health.body as { summary: { total: number; trading: number; mustUpgrade: number; blocked: number } };
    expect(b.summary.total).toBe(2);
    expect(b.summary.trading).toBe(1);   // only the 1.10.0 device
    expect(b.summary.mustUpgrade).toBe(1); // the 1.2.0 device is below the floor

    // And an unsafe policy is refused before it reports anything (A-10).
    const unsafe = await h.request({
      method: 'POST', path: '/v1/platform/devices/fleet-health', userId: 'u-owner', tenantId: TENANT, idempotencyKey: 'fh-unsafe',
      body: { policy: { ...POLICY, minimumSupportedVersion: '2.0.0' } },
    });
    expect(unsafe.status).toBe(422);
    expect(codeOf(unsafe)).toBe('unsafe_version_policy');
  });

  it('refuses an unreadable registration, and is closed without the manage permission', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'u-owner');
    const bad = await register(h, 'u-owner', 'till-3', { branchId: 'b-main' }, 'r-bad'); // no kind/label
    expect(bad.status).toBe(400);
    expect(codeOf(bad)).toBe('not_readable_as_a_device');

    const forbidden = await register(h, 'u-nobody', 'till-3', { branchId: 'b-main', kind: 'pos_lane', label: 'Lane 3' }, 'r-403');
    expect(forbidden.status).toBe(403);
  });
});
