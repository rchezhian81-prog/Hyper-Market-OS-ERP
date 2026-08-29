import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

/**
 * **Device & application-version control, on the cloud (M33-FR-02/FR-04 · A-10 · §35).**
 *
 * The disaster this prevents: a broken release ships, every till upgrades, the shop cannot sell. The
 * defences keep a way back — current AND previous supported, a floor (not the latest) forces only the
 * genuinely-too-old to move, a broken release is killed to move its devices back, and a kill NEVER
 * interrupts a sale. Both routes refuse a policy that would itself brick the fleet before deciding.
 * This drives the tested `evaluateDevice` / `fleetSummary` through the real authenticated surface.
 */

const TENANT = 't-sre';
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
const POLICY = { currentVersion: '1.10.0', previousVersion: '1.9.0', minimumSupportedVersion: '1.9.0' };
const device = (over: Record<string, unknown> = {}) =>
  ({ deviceId: 'till-3', tenantId: TENANT, branchId: 'b1', kind: 'pos_lane', label: 'Lane 3', status: 'registered', appVersion: '1.10.0', lastSeenAt: '2026-08-01T00:00:00Z', ...over });

const evaluate = (h: ApiHarness, userId: string, body: Record<string, unknown>, key: string) =>
  h.request({ method: 'POST', path: '/v1/platform/devices/evaluate', userId, tenantId: TENANT, idempotencyKey: key, body });

describe('device & version control on the API (A-10)', () => {
  it('lets a current registered device trade', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'u-owner');
    const res = await evaluate(h, 'u-owner', { device: device(), policy: POLICY }, 'd-ok');
    expect(res.status).toBe(200);
    const b = res.body as { verdict: string; mayTrade: boolean };
    expect(b.verdict).toBe('ok');
    expect(b.mayTrade).toBe(true);
  });

  it('keeps a device on a KILLED release trading, but defers the move to the next idle moment (never mid-sale)', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'u-owner');
    const res = await evaluate(h, 'u-owner', {
      device: device({ appVersion: '1.5.0' }),
      policy: { currentVersion: '2.0.0', previousVersion: '1.10.0', minimumSupportedVersion: '1.9.0', killedVersions: ['1.5.0'] },
    }, 'd-kill');
    expect(res.status).toBe(200);
    const b = res.body as { verdict: string; mayTrade: boolean; mustUpgrade: boolean; deferUntilIdle: boolean };
    expect(b.verdict).toBe('version_killed');
    expect(b.mayTrade).toBe(true);
    expect(b.deferUntilIdle).toBe(true);
    expect(b.mustUpgrade).toBe(true);
  });

  it('treats a device absent from the body as unregistered — a till nobody registered cannot trade', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'u-owner');
    const res = await evaluate(h, 'u-owner', { policy: POLICY }, 'd-unreg');
    expect(res.status).toBe(200);
    const b = res.body as { verdict: string; mayTrade: boolean };
    expect(b.verdict).toBe('unregistered');
    expect(b.mayTrade).toBe(false);
  });

  it('refuses a policy that would brick the fleet before it decides anything (A-10)', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'u-owner');
    const res = await evaluate(h, 'u-owner', { device: device(), policy: { ...POLICY, minimumSupportedVersion: '2.0.0' } }, 'd-unsafe');
    expect(res.status).toBe(422);
    expect(codeOf(res)).toBe('unsafe_version_policy');
  });

  it('summarises the fleet: who trades, who must upgrade, and who has gone silent', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'u-owner');
    const res = await h.request({
      method: 'POST', path: '/v1/platform/devices/fleet-summary', userId: 'u-owner', tenantId: TENANT, idempotencyKey: 'fleet-1',
      body: {
        policy: POLICY,
        silentAfterMinutes: 52_560_000, // a wide window: only a device that never reported reads as silent
        devices: [
          device({ deviceId: 'till-3', appVersion: '1.10.0' }),                  // trades, not silent
          device({ deviceId: 'till-4', appVersion: '1.2.0' }),                   // too old — must upgrade, blocked
          device({ deviceId: 'till-5', appVersion: '1.10.0', lastSeenAt: undefined }), // never reported — SILENT
        ],
      },
    });
    expect(res.status).toBe(200);
    const b = res.body as { total: number; trading: number; blocked: number; mustUpgrade: number; silent: string[]; byVersion: Record<string, number> };
    expect(b.total).toBe(3);
    expect(b.trading).toBe(2);
    expect(b.blocked).toBe(1);
    expect(b.mustUpgrade).toBe(1);
    expect(b.silent).toContain('till-5');
    expect(b.silent).not.toContain('till-3');
    expect(b.byVersion['1.10.0']).toBe(2);
  });

  it('refuses an unreadable body, and is closed without the permission', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'u-owner');
    const bad = await evaluate(h, 'u-owner', { device: device() }, 'd-bad'); // no policy
    expect(bad.status).toBe(400);
    expect(codeOf(bad)).toBe('not_readable_as_a_device_check');

    const forbidden = await evaluate(h, 'u-nobody', { device: device(), policy: POLICY }, 'd-403');
    expect(forbidden.status).toBe(403);
  });
});
