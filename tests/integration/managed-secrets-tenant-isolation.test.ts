import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Managed-secrets per-tenant isolation, end to end through the real API (M32-FR-03, SEC-04, hard rule #4,
// P-04, OB-01). The secrets surface holds NO secret material — only a vault REFERENCE, its owner and dates —
// but even a reference is sensitive: it names where another shop's live payment/connector credential lives and
// its rotation state. managed-secrets.test.ts proves registration/rotation/revocation/review and RBAC + a
// restart, but only within ONE tenant. This proves the property a shared credential registry must never get
// wrong: one shop can neither SEE nor ROTATE nor REVOKE another shop's secret references.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const register = (h: ApiHarness, u: string, t: string, id: string, key: string) =>
  h.request({ method: 'POST', path: `/v1/integration/secrets/${id}`, userId: u, tenantId: t, idempotencyKey: key,
    body: { kind: 'payment_provider', vaultRef: 'vault://payments/live#v1', owner: u, protects: 'the live payment key', rotateEveryDays: 90, environment: 'production' } });
const rotate = (h: ApiHarness, u: string, t: string, id: string, key: string) =>
  h.request({ method: 'POST', path: `/v1/integration/secrets/${id}/rotation`, userId: u, tenantId: t, idempotencyKey: key, body: { newVaultRef: 'vault://payments/live#v2', graceDays: 7 } });
const revoke = (h: ApiHarness, u: string, t: string, id: string, key: string) =>
  h.request({ method: 'POST', path: `/v1/integration/secrets/${id}/revocation`, userId: u, tenantId: t, idempotencyKey: key, body: { reason: 'attempt from another tenant' } });
const inventory = (h: ApiHarness, u: string, t: string) =>
  h.request({ method: 'GET', path: '/v1/integration/secrets', userId: u, tenantId: t });

interface Inv { count: number; secrets: { secretId: string; state: string; version: number }[] }

describe('managed secrets are per-tenant isolated: one shop never sees or rotates another shop’s credential references (M32-FR-03)', () => {
  it('a secret reference registered in tenant A is invisible and untouchable from tenant B', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.seedOwner(B, 'u-owner-b');

    expect((await register(h, 'u-owner', A, 'pay', 'a-k1')).status).toBe(201);
    // Positive control: tenant A holds exactly its one active reference.
    expect((await inventory(h, 'u-owner', A)).body as Inv).toMatchObject({ count: 1 });

    // Tenant B — a legitimate owner of a DIFFERENT shop — sees no secrets at all.
    const bInv = (await inventory(h, 'u-owner-b', B)).body as Inv;
    expect(bInv.count, 'tenant B saw tenant A’s secret references').toBe(0);
    expect(bInv.secrets).toEqual([]);

    // Tenant B cannot rotate or revoke tenant A's reference — the id does not exist in B's tenant.
    expect((await rotate(h, 'u-owner-b', B, 'pay', 'b-k1')).status, 'tenant B could rotate tenant A’s secret').toBeGreaterThanOrEqual(400);
    expect((await revoke(h, 'u-owner-b', B, 'pay', 'b-k2')).status, 'tenant B could revoke tenant A’s secret').toBeGreaterThanOrEqual(400);

    // Tenant A's reference is entirely unaffected by B's attempts — still its original active v1.
    expect((await inventory(h, 'u-owner', A)).body as Inv).toMatchObject({ count: 1, secrets: [{ secretId: 'pay', state: 'active', version: 1 }] });
  });
});
