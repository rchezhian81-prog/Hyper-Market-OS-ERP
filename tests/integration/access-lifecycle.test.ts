import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { apiHarness, TEST_IDP, type ApiHarness } from '../support/api-harness';
import { LocalIdp } from '../support/local-idp';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';

/**
 * **Joiner / mover / leaver — the access change TAKES EFFECT (M02-FR-04 · SEC-11 · §28 · API-01 · Wave 2b-i · audit
 * PA-02).** The audit executed the old route: `leaverDecision = 200, applied: true, grants: [], closeSessions: true`,
 * then the leaver's very next request was 200 — nothing had been written, nothing closed, and the "current grants" the
 * decision folded came from the request body. Now the route is a durable command: it reads what the person holds from
 * the ledger (a body carrying `currentGrants` is refused by name), appends the grants and revocations as one batch every
 * reader of authority folds, and cuts every token issued up to that moment through the same revocation list the
 * authenticator consults. The proof is the effect: the old token is 401 on the very next request, a fresh token holds
 * exactly the new scope (a leaver: nothing), and a restart over the same store changes none of it — in memory and on
 * real PostgreSQL.
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OWNER = 'u-owner';
const grant = (userId: string, role: string, branch: string[] | 'all' = 'all') => ({ userId, roleId: role, branchScope: branch });
const lifecycle = (h: ApiHarness, u: string, id: string, body: Record<string, unknown>, key?: string, tenantId = A) =>
  h.request({ method: 'POST', path: `/v1/access/lifecycle/${id}`, userId: u, tenantId, idempotencyKey: key ?? `lc-${id}`, body });
const me = (h: ApiHarness, token: string) => h.raw({ method: 'GET', path: '/v1/identity/me', token });
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
const permissionsOf = (res: { body: unknown }): readonly string[] => (res.body as { permissions: string[] }).permissions;
interface Outcome { applied: boolean; recorded: boolean; sessionsClosed: boolean; grants: { roleId: string }[]; removed: { roleId: string }[]; closeSessions: boolean; prioritySync: boolean; blockers: string[] }

/** A token minted NOW, and one minted as if five seconds later — after a revocation's cut-off moment. */
const tokenNow = (userId: string, tenantId = A, branchId?: string) => TEST_IDP.issue({ sub: userId, tenantId, ...(branchId === undefined ? {} : { branchId }) });
const tokenLater = (userId: string, tenantId = A, branchId?: string) =>
  new LocalIdp({ ...TEST_IDP.policy(), now: () => Date.now() + 5_000 }).issue({ sub: userId, tenantId, ...(branchId === undefined ? {} : { branchId }) });

async function cast(h = apiHarness(), tenantId = A): Promise<ApiHarness> {
  await h.seedOwner(tenantId, OWNER);                     // identity.role.grant
  await h.provisionRole(tenantId, 'u-ref-cashier', 'cashier');
  await h.provisionRole(tenantId, 'u-ref-mgr', 'store_manager');
  return h;
}

describe('a joiner holds exactly what was granted — and can act on it', () => {
  it('the new person could do nothing before; after the joiner they hold the cashier\'s permissions in their branch, no more', async () => {
    const h = await cast();
    expect((await me(h, tokenNow('u-new', A, 'b1'))).status).toBe(403); // no grants yet: default deny
    const r = (await lifecycle(h, OWNER, 'j1', {
      event: 'joiner', userId: 'u-new', requestedBy: 'u-hr', reason: 'new cashier starting Monday', grants: [grant('u-new', 'cashier', ['b1'])],
    })).body as Outcome;
    expect(r.applied).toBe(true);
    expect(r.recorded).toBe(true);
    expect(r.sessionsClosed).toBe(false);
    const after = await me(h, tokenNow('u-new', A, 'b1'));
    expect(after.status).toBe(200);
    expect(permissionsOf(after)).toEqual(permissionsOf(await h.request({ method: 'GET', path: '/v1/identity/me', userId: 'u-ref-cashier', tenantId: A })));
    // the grant is scoped to b1: company-wide (no branch on the token) it covers nothing
    expect((await me(h, tokenNow('u-new'))).status).toBe(403);
    // idempotent: the same request again is the same answer, not a second grant
    const again = (await lifecycle(h, OWNER, 'j1', { event: 'joiner', userId: 'u-new', requestedBy: 'u-hr', reason: 'new cashier starting Monday', grants: [grant('u-new', 'cashier', ['b1'])] })).body as Outcome;
    expect(again.recorded).toBe(true);
  });
});

describe('a mover REPLACES scope — the old authority is gone on the next request, the old session is cut', () => {
  it('cashier → store manager: the old token is 401 at once; a fresh token holds the manager\'s permissions and not the cashier\'s union', async () => {
    const h = await cast();
    await h.provisionRole(A, 'u-move', 'cashier');
    const oldToken = tokenNow('u-move');
    expect((await me(h, oldToken)).status).toBe(200);
    const r = (await lifecycle(h, OWNER, 'm1', {
      event: 'mover', userId: 'u-move', requestedBy: 'u-hr', reason: 'moved from the till to the office', grants: [grant('u-move', 'store_manager')],
    })).body as Outcome;
    expect(r.applied).toBe(true);
    expect(r.grants.map((g) => g.roleId)).toEqual(['store_manager']);
    expect(r.removed.map((g) => g.roleId)).toEqual(['cashier']);
    expect(r.closeSessions).toBe(true);
    expect(r.sessionsClosed).toBe(true);
    expect(r.recorded).toBe(true);
    // the session they were using is over
    expect((await me(h, oldToken)).status).toBe(401);
    // signed in afresh, they are a store manager — exactly that
    const fresh = await me(h, tokenLater('u-move'));
    expect(fresh.status).toBe(200);
    expect(permissionsOf(fresh)).toEqual(permissionsOf(await h.request({ method: 'GET', path: '/v1/identity/me', userId: 'u-ref-mgr', tenantId: A })));
  });

  it('a mover keeping their one role is not cut: nothing removed, sessions stay', async () => {
    const h = await cast();
    await h.provisionRole(A, 'u-stay', 'cashier');
    const token = tokenNow('u-stay');
    const r = (await lifecycle(h, OWNER, 'm2', {
      event: 'mover', userId: 'u-stay', requestedBy: 'u-hr', reason: 'same job, new desk', grants: [grant('u-stay', 'cashier')],
    })).body as Outcome;
    expect(r.applied).toBe(true);
    expect(r.removed).toHaveLength(0);
    expect(r.sessionsClosed).toBe(false);
    expect((await me(h, token)).status).toBe(200);
  });
});

describe('a leaver is reassigned first, then their access actually ends', () => {
  it('blocked while they own open items — nothing recorded, they still work; then revoked: old token 401, a fresh token holds nothing, and a restart changes none of it', async () => {
    const h = await cast();
    await h.provisionRole(A, 'u-leaver', 'store_manager');
    const oldToken = tokenNow('u-leaver');
    expect((await me(h, oldToken)).status).toBe(200);

    const blocked = (await lifecycle(h, OWNER, 'l1', {
      event: 'leaver', userId: 'u-leaver', requestedBy: 'u-hr', reason: 'resigned, last day Friday',
      ownedOpenItems: [{ itemId: 'po-42', kind: 'purchase order', description: 'unapproved PO' }],
    })).body as Outcome;
    expect(blocked.applied).toBe(false);
    expect(blocked.recorded).toBe(false);
    expect(blocked.blockers.join(' ')).toContain('reassigned first');
    expect(blocked.grants.map((g) => g.roleId)).toEqual(['store_manager']); // what they still hold — the ledger's answer
    expect((await me(h, oldToken)).status).toBe(200);                       // nothing moved while blocked

    const done = (await lifecycle(h, OWNER, 'l2', {
      event: 'leaver', userId: 'u-leaver', requestedBy: 'u-hr', reason: 'resigned, last day Friday', ownedOpenItems: [],
    })).body as Outcome;
    expect(done.applied).toBe(true);
    expect(done.recorded).toBe(true);
    expect(done.sessionsClosed).toBe(true);
    expect(done.grants).toHaveLength(0);
    expect(done.removed.map((g) => g.roleId)).toEqual(['store_manager']);
    expect(done.prioritySync).toBe(true);
    // THE audit's reproduction, inverted: the very next request with the token they were using is refused
    expect((await me(h, oldToken)).status).toBe(401);
    // and signing in again gives them nothing — default deny over an empty set of grants
    expect((await me(h, tokenLater('u-leaver'))).status).toBe(403);
    // a restart (a fresh surface over the same store) rebuilds the same answer from the ledger
    const restarted = apiHarness({ store: h.store });
    expect((await me(restarted, oldToken)).status).toBe(401);
    expect((await me(restarted, tokenLater('u-leaver'))).status).toBe(403);
    // the owner still is one
    expect((await h.request({ method: 'GET', path: '/v1/identity/me', userId: OWNER, tenantId: A })).status).toBe(200);
  });
});

describe('what the route refuses', () => {
  it('a body that supplies currentGrants is refused by name — the server reads them', async () => {
    const h = await cast();
    const r = await lifecycle(h, OWNER, 'x1', { event: 'leaver', userId: 'u-ref-cashier', requestedBy: 'u-hr', reason: 'left', currentGrants: [] });
    expect(r.status).toBe(400);
    expect(codeOf(r)).toBe('current_grants_are_the_servers');
    expect((await h.request({ method: 'GET', path: '/v1/identity/me', userId: 'u-ref-cashier', tenantId: A })).status).toBe(200); // untouched
  });

  it('self-approval (§28), an unknown role, a cashier at the route, and a malformed change', async () => {
    const h = await cast();
    expect(codeOf(await lifecycle(h, OWNER, 's1', { event: 'joiner', userId: 'u-x', requestedBy: OWNER, reason: 'x', grants: [grant('u-x', 'cashier')] }))).toBe('self_service_access_refused');
    expect(codeOf(await lifecycle(h, OWNER, 's2', { event: 'joiner', userId: 'u-x', requestedBy: 'u-hr', reason: 'x', grants: [grant('u-x', 'fresh_counter')] }))).toBe('unknown_role');
    expect((await me(h, tokenNow('u-x'))).status).toBe(403); // the refused joiner holds nothing
    expect((await lifecycle(h, 'u-ref-cashier', 's3', { event: 'joiner', userId: 'u-x', requestedBy: 'u-hr', reason: 'x', grants: [grant('u-x', 'cashier')] })).status).toBe(403);
    expect(codeOf(await lifecycle(h, OWNER, 's4', { event: 'promotion', userId: 'u-x', requestedBy: 'u-hr', reason: 'x' }))).toBe('not_readable_as_a_lifecycle_change');
    expect(codeOf(await lifecycle(h, OWNER, 's5', { event: 'joiner', userId: 'u-x', requestedBy: 'u-hr', reason: 'x', grants: [{ userId: 'u-x', roleId: 'cashier' }] }))).toBe('not_readable_as_a_lifecycle_change');
  });
});

// ── the same on real PostgreSQL — the leaver's access ends on the database every instance reads ──────────────────────────
const DATABASE_URL = process.env['DATABASE_URL'];
const PG_TENANT = `e${Date.now().toString(16).slice(-7)}-eeee-4eee-8eee-${'e'.repeat(12)}`;

describe.skipIf(!DATABASE_URL)('a leaver\'s access ends on real PostgreSQL (Wave 2b-i · PA-02)', () => {
  let pool: Pool;
  beforeAll(async () => {
    // The TRANSACTIONAL pool client — the wiring main.ts uses (a guarded append refuses a client without one).
    pool = new Pool({ connectionString: DATABASE_URL, max: 4, options: '-c app.tenant_id=*' });
    const dir = 'db/migrations';
    await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
      .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
  });
  afterAll(async () => { await pool.end(); });
  const harness = () => { const sql = pgPoolClient(pool); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); };

  it('old token 401 on the next request, a fresh token holds nothing, a second instance over the same database agrees', async () => {
    const h = await cast(harness(), PG_TENANT);
    await h.provisionRole(PG_TENANT, 'u-leaver', 'store_manager');
    const oldToken = tokenNow('u-leaver', PG_TENANT);
    expect((await me(h, oldToken)).status).toBe(200);
    const done = (await lifecycle(h, OWNER, 'pg-l1', { event: 'leaver', userId: 'u-leaver', requestedBy: 'u-hr', reason: 'resigned', ownedOpenItems: [] }, undefined, PG_TENANT)).body as Outcome;
    expect(done.applied).toBe(true);
    expect(done.recorded).toBe(true);
    expect(done.sessionsClosed).toBe(true);
    expect((await me(h, oldToken)).status).toBe(401);
    expect((await me(h, tokenLater('u-leaver', PG_TENANT))).status).toBe(403);
    const other = harness(); // another API instance, same database
    expect((await me(other, oldToken)).status).toBe(401);
    expect((await me(other, tokenLater('u-leaver', PG_TENANT))).status).toBe(403);
    expect((await other.request({ method: 'GET', path: '/v1/identity/me', userId: OWNER, tenantId: PG_TENANT })).status).toBe(200);
  });
});
