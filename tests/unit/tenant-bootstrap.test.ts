import { describe, it, expect } from 'vitest';
import { planTenantBootstrap, isTenantUuid } from '../../packages/migration/src/index';
import { seedInitialAdmins } from '../../services/api/src/access';
import { OWNER_ROLE_ID, ROLE_CATALOGUE } from '../../services/api/src/roles';
import { STREAM } from '../../services/api/src/adapters';
import { apiHarness } from '../support/api-harness';

// A SECOND, REAL tenant beside the demo (STEP-1 plan §4 item 3): the guards are pure and the seeding is
// one atomic, once-only append — proven here against the real RBAC the API runs.

const REAL = 'ab000000-0000-4000-8000-000000000042';
const DEMO = 'de300000-0000-4000-8000-000000000001';
const AT = '2026-10-01T09:00:00.000Z';
const KNOWN = ROLE_CATALOGUE.map((r) => r.id);

const req = {
  tenantId: REAL, owner: 'u-chezhian', admins: [{ userId: 'u-ca', roleId: 'chartered_accountant' }],
  targetKind: 'rehearsal', demoTenantIds: [DEMO], knownRoleIds: KNOWN, operator: 'u-tech', ownerRoleId: OWNER_ROLE_ID,
};

describe('planTenantBootstrap — the guards', () => {
  it('plans the owner FIRST, then the rest of the initial admin set', () => {
    const plan = planTenantBootstrap(req);
    expect(plan).toEqual({ ok: true, tenantId: REAL, operator: 'u-tech', admins: [{ userId: 'u-chezhian', roleId: 'owner' }, { userId: 'u-ca', roleId: 'chartered_accountant' }] });
  });
  it('an unset MIGRATION_TARGET_KIND is the API\'s default, rehearsal', () => {
    expect(planTenantBootstrap({ ...req, targetKind: undefined }).ok).toBe(true);
  });
  it.each([
    ['production', 'production_target', { targetKind: 'production' }],
    ['a kind nobody recognises', 'unknown_target_kind', { targetKind: 'prod' }],
    ['a readable label instead of a UUID', 'not_a_uuid', { tenantId: 'sre-real' }],
    ['the demo tenant', 'demo_tenant', { tenantId: DEMO }],
    ['no owner', 'no_owner', { owner: ' ' }],
    ['no operator', 'no_operator', { operator: '' }],
    ['a role the catalogue does not know', 'unknown_role', { admins: [{ userId: 'u-x', roleId: 'superuser' }] }],
    ['the same person twice in one role', 'duplicate_admin', { admins: [{ userId: 'u-chezhian', roleId: 'owner' }] }],
  ] as const)('refuses %s (%s)', (_label, refusedBecause, override) => {
    expect(planTenantBootstrap({ ...req, ...override })).toMatchObject({ ok: false, refusedBecause });
  });
  it('knows a tenant UUID when it sees one', () => {
    expect(isTenantUuid(REAL)).toBe(true);
    expect(isTenantUuid('pilot-demo')).toBe(false);
    expect(isTenantUuid('ab000000-0000-4000-8000-00000000004')).toBe(false);
  });
});

describe('seedInitialAdmins — one atomic, once-only append the real RBAC then honours', () => {
  it('seeds the set; the owner may act as owner and the accountant only as accountant', async () => {
    const h = apiHarness();
    const outcome = await seedInitialAdmins(h.store, REAL, planTenantBootstrap(req).ok ? (planTenantBootstrap(req) as { admins: readonly { userId: string; roleId: string }[] }).admins : [], 'u-tech', AT);
    expect(outcome).toEqual({ outcome: 'seeded', granted: 2 });

    const asOwner = await h.request({ method: 'GET', path: '/v1/identity/roles', userId: 'u-chezhian', tenantId: REAL });
    expect(asOwner.status).toBe(200);
    const caReads = await h.request({ method: 'GET', path: '/v1/migration/verification', userId: 'u-ca', tenantId: REAL });
    expect(caReads.status).not.toBe(403);
    const caPublishes = await h.request({
      method: 'POST', path: '/v1/catalogue/products/P-1/publish', userId: 'u-ca', tenantId: REAL, idempotencyKey: 'k1',
      body: { product: { sku: 'S', name: 'N', baseUom: 'each', primaryCategoryId: 'c', taxClass: 't', lifecycle: 'active' }, categories: [{ categoryId: 'c', name: 'C', parentId: null }] },
    });
    expect(caPublishes.status).toBe(403);

    const events = await h.store.readStream(REAL, STREAM.identity, { type: 'RoleGranted' });
    expect(events).toHaveLength(2);
    expect(events[0]!.event.id).toBe(`grant-genesis-${REAL}`); // the same id the boot-time genesis path uses
    expect((events[1]!.event.payload as { provenance: unknown }).provenance).toEqual({ kind: 'initial_admin_set', laidDownBy: 'u-tech' });
  });
  it('a tenant that already holds any grant is left exactly as it was', async () => {
    const h = apiHarness();
    await h.seedOwner(REAL, 'u-first');
    const outcome = await seedInitialAdmins(h.store, REAL, [{ userId: 'u-intruder', roleId: 'owner' }], 'u-tech', AT);
    expect(outcome).toEqual({ outcome: 'already_bootstrapped', granted: 0 });
    expect(await h.store.readStream(REAL, STREAM.identity, { type: 'RoleGranted' })).toHaveLength(1);
    expect((await h.request({ method: 'GET', path: '/v1/identity/roles', userId: 'u-intruder', tenantId: REAL })).status).toBe(403);
  });
  it('the demo tenant\'s grants are untouched by seeding a real one (isolation)', async () => {
    const h = apiHarness();
    await h.seedOwner(DEMO, 'chezhian.owner');
    await seedInitialAdmins(h.store, REAL, [{ userId: 'u-chezhian', roleId: 'owner' }], 'u-tech', AT);
    expect((await h.request({ method: 'GET', path: '/v1/identity/roles', userId: 'u-chezhian', tenantId: DEMO })).status).toBe(403);
    expect((await h.request({ method: 'GET', path: '/v1/identity/roles', userId: 'chezhian.owner', tenantId: REAL })).status).toBe(403);
  });
});
