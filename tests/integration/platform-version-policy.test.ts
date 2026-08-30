import { describe, it, expect } from 'vitest';
import { apiHarness } from '../support/api-harness';

/**
 * **Durable version-policy store — the remote-kill write path, end to end (M33-FR-02/04 · A-10, API-10).**
 *
 * Until now the version policy the fleet is judged against was supplied in the request body on every call and
 * kept nowhere. This stores it: an admin sets the current/previous/minimum versions and withdraws (kills) a
 * broken release, durably and append-only, and the fleet-health read then judges against that STORED policy —
 * so a device on a killed version is told to move back. A policy that would brick the fleet (nothing could
 * trade, or no rollback path, or the current version killed) is refused before anything is stored (A-10);
 * the writes need `platform.device.manage`.
 */

const TENANT = 't-sre';
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
const setPolicy = (h: ReturnType<typeof apiHarness>, u: string, policy: unknown, key: string) =>
  h.request({ method: 'POST', path: '/v1/platform/version-policy', userId: u, tenantId: TENANT, idempotencyKey: key, body: { policy } });
const getPolicy = (h: ReturnType<typeof apiHarness>, u: string) =>
  h.request({ method: 'GET', path: '/v1/platform/version-policy', userId: u, tenantId: TENANT });

describe('durable version policy (M33 remote kill)', () => {
  it('sets a policy, reads it back, and reports not-set as not-set (never an empty all-clear)', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'u-owner');
    expect((await getPolicy(h, 'u-owner')).body).toMatchObject({ policy: null }); // not set yet

    const set = await setPolicy(h, 'u-owner', { currentVersion: '2.1.0', previousVersion: '2.0.0', minimumSupportedVersion: '2.0.0' }, 'p-1');
    expect(set.status).toBe(200);

    const got = await getPolicy(h, 'u-owner');
    expect((got.body as { policy: unknown }).policy).toMatchObject({ currentVersion: '2.1.0', previousVersion: '2.0.0', minimumSupportedVersion: '2.0.0' });
  });

  it('keeps the policy across a restart — a fresh process over the same store still sees it', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'u-owner');
    await setPolicy(h, 'u-owner', { currentVersion: '2.1.0', previousVersion: '2.0.0', minimumSupportedVersion: '2.0.0' }, 'p-1');

    const restarted = apiHarness({ store: h.store });
    const got = await restarted.request({ method: 'GET', path: '/v1/platform/version-policy', userId: 'u-owner', tenantId: TENANT });
    expect((got.body as { policy: { currentVersion: string } }).policy.currentVersion).toBe('2.1.0');
  });

  it('withdraws (kills) a broken release, adding it to the list; and re-killing it is idempotent', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'u-owner');
    await setPolicy(h, 'u-owner', { currentVersion: '2.1.0', previousVersion: '2.0.0', minimumSupportedVersion: '2.0.0' }, 'p-1');

    const kill = await h.request({ method: 'POST', path: '/v1/platform/version-policy/kill', userId: 'u-owner', tenantId: TENANT, idempotencyKey: 'k-1', body: { version: '2.0.5' } });
    expect(kill.status).toBe(200);
    expect((kill.body as { policy: { killedVersions: string[] } }).policy.killedVersions).toEqual(['2.0.5']);

    const again = await h.request({ method: 'POST', path: '/v1/platform/version-policy/kill', userId: 'u-owner', tenantId: TENANT, idempotencyKey: 'k-2', body: { version: '2.0.5' } });
    expect((again.body as { policy: { killedVersions: string[] } }).policy.killedVersions).toEqual(['2.0.5']); // no duplicate
  });

  it('refuses to kill the current version (nothing to move onto) and to kill with no policy set (A-10)', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'u-owner');
    // no policy yet
    const early = await h.request({ method: 'POST', path: '/v1/platform/version-policy/kill', userId: 'u-owner', tenantId: TENANT, idempotencyKey: 'k-0', body: { version: '2.0.0' } });
    expect(early.status).toBe(409);
    expect(codeOf(early)).toBe('no_version_policy');

    await setPolicy(h, 'u-owner', { currentVersion: '2.1.0', previousVersion: '2.0.0', minimumSupportedVersion: '2.0.0' }, 'p-1');
    const suicidal = await h.request({ method: 'POST', path: '/v1/platform/version-policy/kill', userId: 'u-owner', tenantId: TENANT, idempotencyKey: 'k-cur', body: { version: '2.1.0' } });
    expect(suicidal.status).toBe(422);
    expect(codeOf(suicidal)).toBe('unsafe_version_policy');
  });

  it('refuses an unsafe policy before storing it, and is closed without the manage permission', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'u-owner');
    // minimum above current → nothing could trade
    const unsafe = await setPolicy(h, 'u-owner', { currentVersion: '2.0.0', minimumSupportedVersion: '2.1.0' }, 'p-bad');
    expect(unsafe.status).toBe(422);
    expect(codeOf(unsafe)).toBe('unsafe_version_policy');
    expect((await getPolicy(h, 'u-owner')).body).toMatchObject({ policy: null }); // nothing stored

    const forbidden = await setPolicy(h, 'u-nobody', { currentVersion: '2.1.0', minimumSupportedVersion: '2.0.0' }, 'p-403');
    expect(forbidden.status).toBe(403);

    // a store_manager may set it too (holds platform.device.manage)
    await h.provisionRole(TENANT, 'u-mgr', 'store_manager');
    const byManager = await setPolicy(h, 'u-mgr', { currentVersion: '2.1.0', minimumSupportedVersion: '2.0.0' }, 'p-mgr');
    expect(byManager.status).toBe(200);
  });

  it('fleet-health judges the stored fleet against the STORED policy when the body supplies none — a kill takes effect', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'u-owner');
    // A device running 2.0.5, and a policy on 2.1.0 with 2.0.0 as the rollback target.
    await h.request({ method: 'POST', path: '/v1/platform/devices/till-3/register', userId: 'u-owner', tenantId: TENANT, idempotencyKey: 'r-1', body: { branchId: 'b-main', kind: 'pos_lane', label: 'Lane 3', appVersion: '2.0.5' } });
    await setPolicy(h, 'u-owner', { currentVersion: '2.1.0', previousVersion: '2.0.0', minimumSupportedVersion: '2.0.0' }, 'p-1');

    // With no body policy, fleet-health uses the stored one: 2.0.5 is fine (>= min, < current → upgrade_available).
    const before = await h.request({ method: 'POST', path: '/v1/platform/devices/fleet-health', userId: 'u-owner', tenantId: TENANT, idempotencyKey: 'fh-1', body: {} });
    expect(before.status).toBe(200);
    expect((before.body as { devices: { decision: { verdict: string } }[] }).devices[0]?.decision.verdict).toBe('upgrade_available');

    // Now WITHDRAW 2.0.5. The stored policy changes; the same body-less fleet-health now moves the device back.
    await h.request({ method: 'POST', path: '/v1/platform/version-policy/kill', userId: 'u-owner', tenantId: TENANT, idempotencyKey: 'k-1', body: { version: '2.0.5' } });
    const after = await h.request({ method: 'POST', path: '/v1/platform/devices/fleet-health', userId: 'u-owner', tenantId: TENANT, idempotencyKey: 'fh-2', body: {} });
    const d = (after.body as { devices: { decision: { verdict: string; targetVersion?: string; mustUpgrade: boolean } }[] }).devices[0]?.decision;
    expect(d?.verdict).toBe('version_killed');
    expect(d?.mustUpgrade).toBe(true);
    expect(d?.targetVersion).toBe('2.0.0'); // told to move BACK to the previous good build
  });

  it('still accepts a body-supplied policy for a what-if (backward compatible)', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'u-owner');
    await h.request({ method: 'POST', path: '/v1/platform/devices/till-3/register', userId: 'u-owner', tenantId: TENANT, idempotencyKey: 'r-1', body: { branchId: 'b-main', kind: 'pos_lane', label: 'Lane 3', appVersion: '1.10.0' } });
    const res = await h.request({ method: 'POST', path: '/v1/platform/devices/fleet-health', userId: 'u-owner', tenantId: TENANT, idempotencyKey: 'fh-1', body: { policy: { currentVersion: '1.10.0', minimumSupportedVersion: '1.9.0' } } });
    expect(res.status).toBe(200);
    expect((res.body as { summary: { trading: number } }).summary.trading).toBe(1);
  });
});
