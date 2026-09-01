import { describe, it, expect } from 'vitest';
import { apiHarness } from '../support/api-harness';

/**
 * **Status centre — the admin's first screen, composed from real state (M33-FR-04, API-11).**
 *
 * One read folds real health (from the evidence the edge reports — an absent signal is `unknown`, never a
 * cheerful ok, P-08), the device fleet at a glance (trading vs blocked, judged against the stored version
 * policy), and how many support sessions are open right now, into one verdict with a plain-English headline
 * worst-thing-first (P-03). A pure read; it writes nothing. Gated `platform.health.read`.
 */

const TENANT = 't-sre';
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
const POLICY = { currentVersion: '1.10.0', previousVersion: '1.9.0', minimumSupportedVersion: '1.9.0' };

const register = (h: ReturnType<typeof apiHarness>, id: string, key: string) =>
  h.request({ method: 'POST', path: `/v1/platform/devices/${id}/register`, userId: 'u-owner', tenantId: TENANT, idempotencyKey: key, body: { branchId: 'b-main', kind: 'pos_lane', label: id, appVersion: '1.10.0' } });
const block = (h: ReturnType<typeof apiHarness>, id: string, key: string) =>
  h.request({ method: 'POST', path: `/v1/platform/devices/${id}/status`, userId: 'u-owner', tenantId: TENANT, idempotencyKey: key, body: { status: 'blocked', reason: 'reported stolen' } });
const setPolicy = (h: ReturnType<typeof apiHarness>, key: string) =>
  h.request({ method: 'POST', path: '/v1/platform/version-policy', userId: 'u-owner', tenantId: TENANT, idempotencyKey: key, body: { policy: POLICY } });
const openSupportSession = async (h: ReturnType<typeof apiHarness>): Promise<void> => {
  await h.provisionRole(TENANT, 'u-support', 'platform_admin');
  await h.request({ method: 'POST', path: '/v1/platform/support-access/requests', userId: 'u-support', tenantId: TENANT, idempotencyKey: 'sq-1', body: { requestId: 'sr-1', requesterName: 'Vendor Eng', reason: 'investigate the failing settings pack build', scopes: ['config.read'], minutes: 60 } });
  await h.request({ method: 'POST', path: '/v1/platform/support-access/requests/sr-1/decision', userId: 'u-owner', tenantId: TENANT, idempotencyKey: 'sd-1', body: { decision: 'approved' } });
};
let keyCounter = 0;
const statusCentre = (h: ReturnType<typeof apiHarness>, u: string, signals: Record<string, unknown>) =>
  h.request({ method: 'POST', path: '/v1/platform/status-centre', userId: u, tenantId: TENANT, idempotencyKey: `sc-${keyCounter++}`, body: { signals } });

interface Centre { fleet: { total: number; trading: number; blocked: number }; activeSupportSessions: number; entitlementsExpiringSoon: unknown[]; health: { status: string; canTrade: boolean }; headline: string }

describe('status centre (M33-FR-04)', () => {
  it('folds real health, the fleet at a glance and open support sessions into one verdict', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'u-owner');
    await register(h, 'till-1', 'r-1');
    await register(h, 'till-2', 'r-2');
    await block(h, 'till-2', 'b-1'); // one of the two cannot trade
    await setPolicy(h, 'p-1');
    await openSupportSession(h); // one live session

    // A degraded signal (the cloud database is unreachable) must show through as real health — never a
    // cheerful ok — while the shop can still trade (P-01: a cloud outage is not "stop selling").
    const res = await statusCentre(h, 'u-owner', { databaseReachable: false, localStoreWritable: true });
    expect(res.status).toBe(200);
    const c = res.body as Centre;
    expect(c.fleet).toMatchObject({ total: 2, trading: 1, blocked: 1 });
    expect(c.activeSupportSessions).toBe(1);
    expect(c.health.status).not.toBe('ok');
    expect(c.health.canTrade).toBe(true);
    // Worst-thing-first headline names the blocked device and the open session.
    expect(c.headline).toContain('cannot trade');
    expect(c.headline).toContain('support session');
  });

  it('reports an absent signal as unknown, never a cheerful ok (P-08)', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'u-owner');
    const c = (await statusCentre(h, 'u-owner', {})).body as Centre;
    expect(c.health.status).toBe('unknown');
    expect(c.fleet).toMatchObject({ total: 0, trading: 0, blocked: 0 });
    expect(c.activeSupportSessions).toBe(0);
  });

  it('judges the fleet by registration status when no version policy is set yet', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'u-owner');
    await register(h, 'till-1', 'r-1');
    await register(h, 'till-2', 'r-2');
    await block(h, 'till-2', 'b-1');
    // No version policy set — the fleet still reports total/trading/blocked from registration status.
    const c = (await statusCentre(h, 'u-owner', { localStoreWritable: true })).body as Centre;
    expect(c.fleet).toMatchObject({ total: 2, trading: 1, blocked: 1 });
  });

  it('reads "everything normal" when every signal is fresh and healthy, and never claims an entitlement is expiring (licence data not stored yet)', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'u-owner');
    // A COMPLETE, fresh evidence set (timestamps at ~now, matching the harness clock) → health ok, and with
    // no devices and no support sessions there is nothing to flag.
    const fresh = new Date().toISOString();
    const healthy = { lastSyncAt: fresh, queueDepth: 0, deadLetterCount: 0, catalogueBuiltAt: fresh, databaseReachable: true, localStoreWritable: true, lastBackupAt: fresh, backupMaxAgeSeconds: 86_400 };
    const c = (await statusCentre(h, 'u-owner', healthy)).body as Centre;
    expect(c.health.status).toBe('ok');
    expect(c.headline).toBe('Everything normal');
    expect(c.entitlementsExpiringSoon).toEqual([]);
  });

  it('is a read any health-reader may make, refuses a no-role user, and refuses malformed evidence', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'u-owner');
    await h.provisionRole(TENANT, 'u-mgr', 'store_manager'); // holds platform.health.read

    expect((await statusCentre(h, 'u-mgr', { localStoreWritable: true })).status).toBe(200);
    expect((await statusCentre(h, 'u-nobody', {})).status).toBe(403);

    const bad = await statusCentre(h, 'u-owner', { queueDepth: 'lots' }); // wrong type
    expect(bad.status).toBe(400);
    expect(codeOf(bad)).toBe('not_readable_as_health_evidence');
  });
});
