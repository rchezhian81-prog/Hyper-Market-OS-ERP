import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { OPTIONAL_FEATURES } from '../../packages/tenant/src/index';

// Per-tenant feature entitlements, end to end through the real API (M36-FR-01, API-11). Optional
// modules are DEFAULT-OFF: a tenant gets only what it enables. A tenant sees only its entitled
// modules, and the authoritative entitlement DECISION carries its SOURCE — "not entitled" is a
// sales conversation, "suspended" a billing one — through the same `checkEntitlement` engine the
// paid-plan tier will use. Entitlements are the caller's tenant only (§35), append-only and
// audited. Enabling a feature the product does not offer is refused, never invented.
//
// SCOPE: this is the entitlement CONTROL PLANE (manage + read + decision). Hard per-route
// enforcement (refusing an actual optional-feature call) is a follow-on retrofit, and the
// paid-plan tier is owner-blocked on the plans/pricing model (OA-12) — see docs/traceability.md.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

interface Catalogue { entitled: string[]; available: string[]; off: string[] }
interface Decision { tenantId: string; feature: string; entitled: boolean; source: string }

const list = async (h: ApiHarness, tenant: string, user: string): Promise<Catalogue> =>
  (await h.request({ method: 'GET', path: '/v1/platform/entitlements', userId: user, tenantId: tenant })).body as Catalogue;
const decide = async (h: ApiHarness, tenant: string, user: string, feature: string) =>
  h.request({ method: 'GET', path: `/v1/platform/entitlements/${feature}`, userId: user, tenantId: tenant });
const setFeature = (h: ApiHarness, tenant: string, user: string, feature: string, enabled: boolean, key = 'ent') =>
  h.request({ method: 'PUT', path: `/v1/platform/entitlements/${feature}`, userId: user, tenantId: tenant, idempotencyKey: `${key}-${tenant}-${feature}-${enabled}`, body: { enabled } });

const codeOf = (r: { body: unknown }): string | undefined => (r.body as { error?: { code: string } }).error?.code;

describe('per-tenant feature entitlements, end to end (M36-FR-01, API-11)', () => {
  it('is default-off, then reflects an enable and a revoke (append-only, latest wins)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');

    // Default-off: nothing entitled, the whole catalogue is available and off.
    const before = await list(h, A, 'u-owner');
    expect(before.entitled).toEqual([]);
    expect(before.available).toEqual([...OPTIONAL_FEATURES]);
    expect(before.off).toEqual([...OPTIONAL_FEATURES]);
    expect(((await decide(h, A, 'u-owner', 'b2b')).body as Decision)).toMatchObject({ entitled: false, source: 'not_entitled' });

    // Enable one.
    expect((await setFeature(h, A, 'u-owner', 'b2b', true)).status).toBe(200);
    expect((await list(h, A, 'u-owner')).entitled).toContain('b2b');
    expect(((await decide(h, A, 'u-owner', 'b2b')).body as Decision)).toMatchObject({ entitled: true, source: 'explicit_grant' });

    // Revoke it — a compensating fact, latest wins; default-off restored.
    expect((await setFeature(h, A, 'u-owner', 'b2b', false)).status).toBe(200);
    expect((await list(h, A, 'u-owner')).entitled).not.toContain('b2b');
    expect(((await decide(h, A, 'u-owner', 'b2b')).body as Decision).entitled).toBe(false);
  });

  it('refuses a feature the product does not offer, and a change with no state (never invented)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const unknown = await setFeature(h, A, 'u-owner', 'dept.teleportation', true);
    expect(unknown.status).toBe(404);
    expect(codeOf(unknown)).toBe('unknown_feature');
    expect(codeOf(await decide(h, A, 'u-owner', 'dept.teleportation'))).toBe('unknown_feature');

    const noState = await h.request({ method: 'PUT', path: '/v1/platform/entitlements/b2b', userId: 'u-owner', tenantId: A, idempotencyKey: 'nostate', body: {} });
    expect(noState.status).toBe(400);
    expect(codeOf(noState)).toBe('entitlement_state_not_given');
  });

  it('never crosses a tenant — one tenant\'s entitlement is invisible to another (§35)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.seedOwner(B, 'u-owner-b');
    await setFeature(h, A, 'u-owner', 'delivery', true);

    expect((await list(h, A, 'u-owner')).entitled).toContain('delivery');
    expect((await list(h, B, 'u-owner-b')).entitled).toEqual([]); // B sees none of A's
    expect(((await decide(h, B, 'u-owner-b', 'delivery')).body as Decision).entitled).toBe(false);
  });

  it('is gated: a cashier can neither read nor change entitlements (403)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier');
    expect((await h.request({ method: 'GET', path: '/v1/platform/entitlements', userId: 'u-cash', tenantId: A })).status).toBe(403);
    expect((await setFeature(h, A, 'u-cash', 'b2b', true, 'cash')).status).toBe(403);
  });
});
