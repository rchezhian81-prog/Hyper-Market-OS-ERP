import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// M02 access surface — DURABILITY AND ISOLATION AS A WHOLE (M02-FR-02/03/04 · SEC-03 · P-04, API-01).
//
// The individual legs are already integration-tested: authorization-is-enforced.test.ts proves the
// authorization matrix + cross-tenant isolation + a real-Postgres write/read; approval-delegation and
// emergency-access each prove their own record survives a restart. The one property none of them asserts
// is the module-level one this test adds: after a cold restart, the CORE ROLE-GRANT AUTHORIZATION itself
// still resolves and still ENFORCES from the rebuilt event store — and grants, delegations and emergency
// grants all rebuild TOGETHER from one store, not just each in isolation. Nothing lives in memory.
//
// A "restart" is a fresh surface (`apiHarness({ store })`) over the same event store — the same technique
// the peer *-durability suites use. Test-only: the production access path is already event-sourced and
// rebuilt per request; this pins that it stays so.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const day = (n: number): string => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

/** A role grant as the product now records it (Wave 2b · PA-03): the REQUESTER asks under their own sign-in, the
 *  APPROVER approves under theirs — two calls, two people, no names in a body. */
async function grantInTwoActs(h: ApiHarness, o: { grantId: string; userId: string; requestedBy: string; approvedBy: string; key: string; tenantId?: string }) {
  const tenantId = o.tenantId ?? A;
  const asked = await h.request({ method: 'POST', path: '/v1/identity/grants', userId: o.requestedBy, tenantId, idempotencyKey: `${o.key}-ask`, body: { grantId: o.grantId, userId: o.userId, roleId: 'cashier', branchScope: 'all', reason: 'test cast' } });
  if (asked.status !== 202) return asked;
  return h.request({ method: 'POST', path: `/v1/identity/grants/${o.grantId}/approve`, userId: o.approvedBy, tenantId, idempotencyKey: `${o.key}-approve`, body: {} });
}

const me = (h: ApiHarness, userId: string, tenantId = A) =>
  h.request({ method: 'GET', path: '/v1/identity/me', userId, tenantId });

describe('M02 access surface rebuilds and keeps enforcing after a restart (durability + isolation)', () => {
  it('core role grants still resolve AND enforce on a fresh surface over the same store', async () => {
    const h = apiHarness();
    await h.provisionOwner(A, 'u-owner-1');
    await h.provisionOwner(A, 'u-owner-2');
    // A cashier granted through the REAL maker-checker route (two separate owners), not seeded directly.
    const granted = await grantInTwoActs(h, { grantId: 'g-cash', userId: 'u-cash', requestedBy: 'u-owner-1', approvedBy: 'u-owner-2', key: 'k-cash' });
    expect(granted.status).toBe(201);

    // Cold restart: a brand-new surface over the same event store.
    const restarted = apiHarness({ store: h.store });

    // The owner's authority rebuilt — they can still see it.
    const owner = await me(restarted, 'u-owner-1');
    expect(owner.status).toBe(200);
    expect((owner.body as { permissions: string[] }).permissions).toContain('identity.role.grant');

    // The cashier's authority rebuilt too — present, but exactly a cashier's (no grant power).
    const cash = await me(restarted, 'u-cash');
    expect(cash.status).toBe(200);
    expect((cash.body as { permissions: string[] }).permissions).not.toContain('identity.role.grant');

    // And it still ENFORCES after the restart: the cashier cannot grant a role.
    const denied = await restarted.request({
      method: 'POST', path: '/v1/identity/grants', userId: 'u-cash', tenantId: A, idempotencyKey: 'k-x',
      body: { grantId: 'g-x', userId: 'u-y', roleId: 'cashier', branchScope: 'all' },
    });
    expect(denied.status).toBe(403);
  });

  it('cross-tenant isolation still holds after a restart — authority never leaks between tenants', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner'); // owner in A only
    const restarted = apiHarness({ store: h.store });
    // Same user, a token scoped to tenant B where they hold nothing → denied, even across the restart.
    expect((await me(restarted, 'u-owner', B)).status).toBe(403);
    // And still fully authorized in their own tenant A.
    expect((await me(restarted, 'u-owner', A)).status).toBe(200);
  });

  it('grants, delegations and emergency grants all rebuild together from one store', async () => {
    const h = apiHarness();
    await h.provisionOwner(A, 'u-owner-1');
    await h.provisionOwner(A, 'u-owner-2');
    await h.provisionRole(A, 'u-boss', 'store_manager', ['b1']); // the lender must hold what they lend (Wave 2b · PA-03)
    // A role grant (maker-checker), a delegation, and an emergency grant — three different record kinds.
    await grantInTwoActs(h, { grantId: 'g-cash2', userId: 'u-cash', requestedBy: 'u-owner-1', approvedBy: 'u-owner-2', key: 'k-cash2' });
    await h.request({
      method: 'POST', path: '/v1/access/delegations/d1', userId: 'u-owner-1', tenantId: A, idempotencyKey: 'k-d1',
      body: { fromUserId: 'u-boss', toUserId: 'u-deputy', fromDate: day(0), untilDate: day(10), subjectTypes: ['refund'], reason: 'annual leave', granter: { userId: 'u-boss', branchScope: ['b1'], authorityLimit: { minor: 50000, currency: 'INR' } }, valueCap: { minor: 30000, currency: 'INR' }, branchScope: ['b1'] },
    });
    await h.request({
      method: 'POST', path: '/v1/access/emergency/e1', userId: 'u-owner-1', tenantId: A, idempotencyKey: 'k-e1',
      body: { userId: 'u-support', roleId: 'store_manager', branchScope: 'all', reason: 'diagnose the till freeze on lane 3', minutes: 60, requestedBy: 'u-support' },
    });

    // One restart — all three kinds must come back from the same rebuilt store.
    const restarted = apiHarness({ store: h.store });

    expect((await me(restarted, 'u-cash')).status).toBe(200); // the grant
    const dels = (await restarted.request({ method: 'GET', path: '/v1/access/delegations', userId: 'u-owner-1', tenantId: A })).body as { rows: { delegationId: string }[] };
    expect(dels.rows.some((r) => r.delegationId === 'd1')).toBe(true); // the delegation
    const emg = (await restarted.request({ method: 'GET', path: '/v1/access/emergency', userId: 'u-owner-1', tenantId: A })).body as { count: number };
    expect(emg.count).toBe(1); // the emergency grant
  });
});
