import { describe, it, expect } from 'vitest';
import { apiHarness } from '../support/api-harness';

/**
 * **Licence/entitlement expiry + alerting — an expiring licence alerts a named owner (M33-FR-04, API-11).**
 *
 * A licence is time-bound and has a named owner who must renew it. When it is close to (or past) its expiry it
 * keeps alerting that owner until renewed — and the same expiring licences surface in the status centre. A
 * licence with no named owner is refused. Writes gated platform.entitlement.manage, reads
 * platform.entitlement.read.
 */

const TENANT = 't-sre';
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
// Dates relative to the surface's real clock, so the test does not pin an absolute "today".
const inDays = (n: number): string => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

const setLicence = (h: ReturnType<typeof apiHarness>, u: string, moduleId: string, key: string, over: Record<string, unknown> = {}) =>
  h.request({ method: 'POST', path: `/v1/platform/licences/${moduleId}`, userId: u, tenantId: TENANT, idempotencyKey: key,
    body: { name: `${moduleId} licence`, enabled: true, ownerUserId: 'u-owner', ownerName: 'Chezhian', ...over } });
const licences = (h: ReturnType<typeof apiHarness>, u: string) =>
  h.request({ method: 'GET', path: '/v1/platform/licences', userId: u, tenantId: TENANT });
const alerts = (h: ReturnType<typeof apiHarness>, u: string) =>
  h.request({ method: 'GET', path: '/v1/platform/licences/alerts', userId: u, tenantId: TENANT });
const statusCentre = (h: ReturnType<typeof apiHarness>, u: string, key: string) =>
  h.request({ method: 'POST', path: '/v1/platform/status-centre', userId: u, tenantId: TENANT, idempotencyKey: key, body: { signals: { localStoreWritable: true } } });

describe('licence expiry + alerting (M33-FR-04)', () => {
  it('records a licence, raises an expiry alert naming the owner, and surfaces it in the status centre', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'u-owner');

    expect((await setLicence(h, 'u-owner', 'gst-filing', 'l-1', { expiresOn: inDays(10) })).status).toBe(200); // expiring soon
    expect((await setLicence(h, 'u-owner', 'weighing-scale', 'l-2', { expiresOn: inDays(400) })).status).toBe(200); // far off

    expect(((await licences(h, 'u-owner')).body as { licences: unknown[] }).licences).toHaveLength(2);

    // Only the soon one alerts, and it names the owner.
    const al = (await alerts(h, 'u-owner')).body as { alerts: { moduleId: string; ownerName: string; message: string }[] };
    expect(al.alerts).toHaveLength(1);
    expect(al.alerts[0]).toMatchObject({ moduleId: 'gst-filing', ownerName: 'Chezhian' });
    expect(al.alerts[0]?.message).toContain('Chezhian');

    // The status centre's expiring-entitlements list is now live (within its 30-day warn window).
    const centre = (await statusCentre(h, 'u-owner', 'sc-1')).body as { entitlementsExpiringSoon: { moduleId: string }[]; headline: string };
    expect(centre.entitlementsExpiringSoon.map((e) => e.moduleId)).toContain('gst-filing');
    expect(centre.headline).toContain('entitlement');
  });

  it('keeps alerting a licence that has already EXPIRED — it does not go quiet the day it lapses', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'u-owner');
    await setLicence(h, 'u-owner', 'gst-filing', 'l-1', { expiresOn: inDays(-5) }); // already expired

    const al = (await alerts(h, 'u-owner')).body as { alerts: { level: string; message: string }[]; expired: number };
    expect(al.expired).toBe(1);
    expect(al.alerts[0]?.level).toBe('expired');
    expect(al.alerts[0]?.message).toContain('EXPIRED');
  });

  it('refuses a licence with no named owner, and a bad expiry date', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'u-owner');

    const unnamed = await setLicence(h, 'u-owner', 'gst-filing', 'l-x', { ownerUserId: '', ownerName: '' });
    expect(unnamed.status).toBe(422);
    expect(codeOf(unnamed)).toBe('licence_owner_unnamed');

    const badDate = await setLicence(h, 'u-owner', 'gst-filing', 'l-y', { expiresOn: 'next year' });
    expect(badDate.status).toBe(400);
    expect(codeOf(badDate)).toBe('expires_on_not_a_date');
  });

  it('a perpetual licence never alerts, and the surface is default-deny', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'u-owner');
    await setLicence(h, 'u-owner', 'core', 'l-1'); // no expiresOn → perpetual

    expect(((await alerts(h, 'u-owner')).body as { alerts: unknown[] }).alerts).toEqual([]);
    expect((await setLicence(h, 'u-nobody', 'x', 'l-9')).status).toBe(403);
    expect((await alerts(h, 'u-nobody')).status).toBe(403);
  });
});
