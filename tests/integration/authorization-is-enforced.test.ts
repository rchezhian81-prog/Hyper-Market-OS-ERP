import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { apiHarness, TEST_IDP, type ApiHarness } from '../support/api-harness';
import { LocalIdp, tamperSignature } from '../support/local-idp';
import { STREAM } from '../../services/api/src/adapters';

/**
 * Authorization is REAL and per-tenant on the actual API surface (M02-FR-02, SEC-03, P-04).
 *
 * The production composition used to wire `new AccessControl([], [])` — a global, empty table that
 * authorised nothing and was never rebuilt from anyone's grants, so the whole least-privilege
 * apparatus was inert on the live surface, and no test drove an authenticated-AND-authorized request
 * against it. This proves the whole matrix through the shared E2E harness (`tests/support`), which
 * composes the surface, the real token verifier, and the real per-tenant resolver the way `main()`
 * does. It also proves the guarded genesis bootstrap that stops a provisioned-but-ungranted tenant
 * being a permanent 403.
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const P = TEST_IDP.policy();
/** A role grant as the product now records it (Wave 2b · PA-03): the REQUESTER asks under their own sign-in, the
 *  APPROVER approves under theirs — two calls, two people, no names in a body. */
async function grantInTwoActs(h: ApiHarness, o: { grantId: string; userId: string; requestedBy: string; approvedBy: string; key: string; tenantId?: string }) {
  const tenantId = o.tenantId ?? A;
  const asked = await h.request({ method: 'POST', path: '/v1/identity/grants', userId: o.requestedBy, tenantId, idempotencyKey: `${o.key}-ask`, body: { grantId: o.grantId, userId: o.userId, roleId: 'cashier', branchScope: 'all', reason: 'test cast' } });
  if (asked.status !== 202) return asked;
  return h.request({ method: 'POST', path: `/v1/identity/grants/${o.grantId}/approve`, userId: o.approvedBy, tenantId, idempotencyKey: `${o.key}-approve`, body: {} });
}

describe('authorization is enforced on the real API surface (in-memory)', () => {
  it('a genesis-seeded owner performs an authenticated + authorized request (200)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const res = await h.request({ method: 'GET', path: '/v1/identity/me', userId: 'u-owner', tenantId: A });
    expect(res.status).toBe(200);
    expect((res.body as { permissions: string[] }).permissions).toContain('identity.role.grant');
  });

  it('an authenticated but UNAUTHORIZED user is refused (403)', async () => {
    const h = apiHarness();
    await h.provisionOwner(A, 'u-owner-1');
    await h.provisionOwner(A, 'u-owner-2');
    const granted = await grantInTwoActs(h, { grantId: 'g1', userId: 'u-cash', requestedBy: 'u-owner-1', approvedBy: 'u-owner-2', key: 'k-g1' });
    expect(granted.status).toBe(201);

    // The cashier does not hold identity.role.request → forbidden, before the body is even read.
    const denied = await h.request({
      method: 'POST', path: '/v1/identity/grants', userId: 'u-cash', tenantId: A, idempotencyKey: 'k-g2',
      body: { grantId: 'g2', userId: 'u-x', roleId: 'cashier', branchScope: 'all' },
    });
    expect(denied.status).toBe(403);
  });

  it('rejects unauthenticated, malformed, expired, wrong-key, alg-none and wrong-issuer tokens (401)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const me = { method: 'GET' as const, path: '/v1/identity/me' };
    const status = async (token?: string): Promise<number> => (await h.raw({ ...me, token })).status;

    expect(await status(undefined)).toBe(401); // no Authorization header
    expect(await status('not-a-three-part-token')).toBe(401);
    expect(await status(tamperSignature(TEST_IDP.issue({ sub: 'u-owner', tenantId: A })))).toBe(401);
    expect(await status(TEST_IDP.issue({ sub: 'u-owner', tenantId: A, ttlSeconds: -3600 }))).toBe(401);
    expect(await status(TEST_IDP.withDifferentKey('a-different-key-that-is-long-enough-000000').issue({ sub: 'u-owner', tenantId: A }))).toBe(401);
    expect(await status(new LocalIdp({ ...P, alg: 'none' }).issue({ sub: 'u-owner', tenantId: A }))).toBe(401);
    expect(await status(new LocalIdp({ ...P, issuer: 'https://evil.example' }).issue({ sub: 'u-owner', tenantId: A }))).toBe(401);
  });

  it('is per-tenant: an owner in tenant A has no authority in tenant B (403)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner'); // owner in A only
    // Same user, token scoped to tenant B, where they hold nothing → denied. Authority never leaks.
    const res = await h.request({ method: 'GET', path: '/v1/identity/me', userId: 'u-owner', tenantId: B });
    expect(res.status).toBe(403);
  });

  it('maker-checker: a self-approved grant is refused (422); a two-person grant succeeds (201)', async () => {
    const h = apiHarness();
    await h.provisionOwner(A, 'u-owner-1');
    await h.provisionOwner(A, 'u-owner-2');

    // The same person asking and approving is refused at the approval (§28) — and nobody's access changed.
    const selfApproved = await grantInTwoActs(h, { grantId: 'gs', userId: 'u-cash', requestedBy: 'u-owner-1', approvedBy: 'u-owner-1', key: 'k-self' });
    expect(selfApproved.status).toBe(422);

    const twoPerson = await grantInTwoActs(h, { grantId: 'gok', userId: 'u-cash', requestedBy: 'u-owner-1', approvedBy: 'u-owner-2', key: 'k-ok' });
    expect(twoPerson.status).toBe(201);
  });

  it('genesis is once-only: a second seed is refused and never grants the intruder', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.seedOwner(A, 'u-intruder'); // no-op: tenant already has a grant
    const res = await h.request({ method: 'GET', path: '/v1/identity/me', userId: 'u-intruder', tenantId: A });
    expect(res.status).toBe(403);
  });
});

const DATABASE_URL = process.env['DATABASE_URL'];
const DB_TENANT = `c${Date.now().toString(16).slice(-7)}-cccc-4ccc-8ccc-${'c'.repeat(12)}`;

describe.skipIf(!DATABASE_URL)('authorization end-to-end: app → API → authorization → database (real PostgreSQL)', () => {
  let client: Pool;

  beforeAll(async () => {
    // The TRANSACTIONAL pool client — the wiring main.ts uses. Wave 2a's write guards (the audit chain's among them) run inside
    // the append's own transaction, and the store refuses a guarded append on a client that offers none (fail closed, by name).
    client = new Pool({ connectionString: DATABASE_URL, max: 4, options: '-c app.tenant_id=*' });
    const sql = pgPoolClient(client);
    const dir = 'db/migrations';
    await runMigrations(sql, readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
      .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
  });
  afterAll(async () => { await client.end(); });

  it('an authorized write reaches the ledger; an unauthorized one does not', async () => {
    const sql = pgPoolClient(client);
    const h = apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) });
    await h.provisionOwner(DB_TENANT, 'u-owner-1');
    await h.provisionOwner(DB_TENANT, 'u-owner-2');

    const ok = await grantInTwoActs(h, { grantId: 'db-ok', userId: 'u-cash', requestedBy: 'u-owner-1', approvedBy: 'u-owner-2', key: 'k-db-ok', tenantId: DB_TENANT });
    expect(ok.status).toBe(201);

    const grants = await h.store.readStream(DB_TENANT, STREAM.identity, { type: 'RoleGranted' });
    expect(grants.some((e) => (e.event.payload as { userId: string }).userId === 'u-cash')).toBe(true);

    const before = grants.length;
    const denied = await h.request({
      method: 'POST', path: '/v1/identity/grants', userId: 'u-cash', tenantId: DB_TENANT, idempotencyKey: 'k-db-x',
      body: { grantId: 'db-x', userId: 'u-y', roleId: 'cashier', branchScope: 'all' },
    });
    expect(denied.status).toBe(403);
    expect((await h.store.readStream(DB_TENANT, STREAM.identity, { type: 'RoleGranted' })).length).toBe(before);
  });
});
