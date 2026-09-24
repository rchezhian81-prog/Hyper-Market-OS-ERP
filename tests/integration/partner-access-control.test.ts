import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// API-11 M36-FR-04 — the partner credential registry + access-check, end to end. A partner ecosystem is
// a set of people we do not employ holding credentials to systems we are responsible for, so the platform
// registers a credential scoped to the tenants that engaged the partner and decides every partner call
// against the STORED credential (the security principal is authoritative from the ledger, never the body).
// The tested checkPartnerAccess engine refuses a sandbox credential in production (hard rule #7), a tenant
// the partner is not scoped to, a revoked/expired credential, and an unversioned call. Writes are gated
// platform.partner.manage, the read/decision platform.partner.read. Proven against the real pipeline + RBAC.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const register = (h: ApiHarness, user: string, id: string, body: unknown) =>
  h.request({ method: 'POST', path: `/v1/platform/partners/${id}`, userId: user, tenantId: A, idempotencyKey: `reg-${id}`, body });
const revoke = (h: ApiHarness, user: string, id: string, body: unknown = {}) =>
  h.request({ method: 'POST', path: `/v1/platform/partners/${id}/revoke`, userId: user, tenantId: A, idempotencyKey: `rev-${id}`, body });
const getCred = (h: ApiHarness, user: string, id: string) =>
  h.request({ method: 'GET', path: `/v1/platform/partners/${id}`, userId: user, tenantId: A });
const check = (h: ApiHarness, user: string, body: unknown) =>
  h.request({ method: 'POST', path: '/v1/platform/partners/access-check', userId: user, tenantId: A, idempotencyKey: `chk-${JSON.stringify(body).length}-${Math.random()}`, body });

const VERSIONS = [{ contract: 'orders', version: 'v2', status: 'current' }];
const prodCred = { partnerId: 'acme-integrations', environment: 'production', scopedTenantIds: ['shop-1'], scopes: ['orders.read'], issuedOn: '2026-01-01', expiresOn: '2030-01-01' };
const okCheck = { environment: 'production', tenantId: 'shop-1', requiredScope: 'orders.read', contract: 'orders', requestedVersion: 'v2', versions: VERSIONS };

async function admin(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-admin', 'platform_admin'); // holds platform.partner.manage/read
  await h.provisionRole(A, 'u-cash', 'cashier');          // holds neither
  return h;
}

describe('partner credential registry + access-check (M36-FR-04)', () => {
  it('registers a credential, reads it back, and allows a well-formed call', async () => {
    const h = await admin();
    expect((await register(h, 'u-admin', 'cred-1', prodCred)).status).toBe(201);
    expect((await getCred(h, 'u-admin', 'cred-1')).status).toBe(200);

    const res = await check(h, 'u-admin', { credentialId: 'cred-1', ...okCheck });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ allowed: true, outcome: 'allowed', credentialId: 'cred-1' });
  });

  it('refuses a SANDBOX credential presented against production — a security event (hard rule #7)', async () => {
    const h = await admin();
    await register(h, 'u-admin', 'cred-sb', { ...prodCred, environment: 'sandbox' });
    const res = await check(h, 'u-admin', { credentialId: 'cred-sb', ...okCheck }); // environment: production
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ allowed: false, outcome: 'sandbox_credential_in_production', securityEvent: true });
  });

  it('refuses a tenant the partner is not scoped to — an over-broad key is the failure that ends a SaaS', async () => {
    const h = await admin();
    await register(h, 'u-admin', 'cred-2', prodCred); // scoped to shop-1 only
    const res = await check(h, 'u-admin', { credentialId: 'cred-2', ...okCheck, tenantId: 'shop-9' });
    expect(res.body).toMatchObject({ allowed: false, outcome: 'tenant_not_in_scope', securityEvent: true });
  });

  it('refuses an unversioned call — refused, never defaulted to the latest', async () => {
    const h = await admin();
    await register(h, 'u-admin', 'cred-3', prodCred);
    const { requestedVersion, ...noVersion } = okCheck;
    void requestedVersion;
    const res = await check(h, 'u-admin', { credentialId: 'cred-3', ...noVersion });
    expect(res.body).toMatchObject({ allowed: false, outcome: 'unversioned' });
  });

  it('refuses a call on a revoked credential, and the credential is not deleted (hard rule #6)', async () => {
    const h = await admin();
    await register(h, 'u-admin', 'cred-4', prodCred);
    expect((await revoke(h, 'u-admin', 'cred-4', { revokedOn: '2026-01-15' })).status).toBe(200);
    const res = await check(h, 'u-admin', { credentialId: 'cred-4', ...okCheck });
    expect(res.body).toMatchObject({ allowed: false, outcome: 'revoked', securityEvent: true });
    // The credential still reads back (history stays) — now carrying its revocation date.
    expect((await getCred(h, 'u-admin', 'cred-4')).body).toMatchObject({ revokedOn: '2026-01-15' });
  });

  it('404s an unknown credential on both the check and the read', async () => {
    const h = await admin();
    expect((await check(h, 'u-admin', { credentialId: 'ghost', ...okCheck })).status).toBe(404);
    expect((await getCred(h, 'u-admin', 'ghost')).status).toBe(404);
  });

  it('gates writes on platform.partner.manage and the check on platform.partner.read', async () => {
    const h = await admin();
    expect((await register(h, 'u-cash', 'cred-x', prodCred)).status).toBe(403);
    await register(h, 'u-admin', 'cred-y', prodCred);
    expect((await check(h, 'u-cash', { credentialId: 'cred-y', ...okCheck })).status).toBe(403);
  });
});
