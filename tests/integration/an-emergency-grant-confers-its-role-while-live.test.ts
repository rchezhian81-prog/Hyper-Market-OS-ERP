import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { sentWithApproval } from '../support/approval-request';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore, type EventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { tenantAccessResolver } from '../../services/api/src/access';
import { ROLE_CATALOGUE } from '../../services/api/src/roles';

/**
 * **M02-FR-04 · SEC-03 · SEC-11 (round 6 re-audit) — an emergency grant gives REAL access, for exactly as long as it is live.**
 *
 * Before, the owner could approve a time-bound emergency grant and the review showed it as active, but the per-request
 * authority (`tenantAccessResolver`) folded only the role ledger — so the person who was granted the access still got 403
 * on everything. Now a live (approved, unexpired, unrevoked) grant confers its role inside its own branch scope; the moment
 * it expires or is revoked the next request is refused; and the owner's review still lists it. In memory and — with
 * DATABASE_URL — on real PostgreSQL, across a cold restart.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
let pool: Pool | undefined;
beforeAll(async () => {
  if (DATABASE_URL === undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
  const dir = 'db/migrations';
  await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
});
afterAll(async () => { await pool?.end(); });

type Backing = { name: string; stores: () => { store?: EventStore; idempotency?: SqlIdempotencyStore } };
const backings: Backing[] = [{ name: 'the in-memory event store', stores: () => ({}) }];
if (DATABASE_URL !== undefined) backings.push({ name: 'real PostgreSQL', stores: () => { const sql = pgPoolClient(pool!); return { store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }; } });

const REASON = 'diagnose the till freeze on lane 3';
type Review = { review: { grantId: string; userId: string; reason: string; approvedBy: string; active: boolean; endedEarly: boolean }[] };

describe.each(backings)('an emergency grant confers its role while live, and stops when it ends — on $name', ({ stores }) => {
  // The access check reads THIS clock, so a test can step past the grant's expiry without waiting an hour.
  let offsetMs = 0;
  const now = (): string => new Date(Date.now() + offsetMs).toISOString();
  let h: ApiHarness;
  let T: string;
  const availability = (who: string, on = h) => on.request({ method: 'GET', path: '/v1/inventory/availability', userId: who, tenantId: T });
  const grant = (id: string, body: Record<string, unknown>) =>
    sentWithApproval(h, T, 'u-mgr', 'u-owner', { kind: 'emergency_access', subjectRef: id, pathIds: { grantId: id } }, body,
      (b) => h.request({ method: 'POST', path: `/v1/access/emergency/${id}`, userId: 'u-mgr', tenantId: T, idempotencyKey: `eg-${id}`, body: b }));
  const review = async (): Promise<Review> => (await h.request({ method: 'GET', path: '/v1/access/emergency', userId: 'u-owner', tenantId: T })).body as Review;

  async function cast(): Promise<void> {
    offsetMs = 0;
    T = randomUUID();
    h = apiHarness({ ...stores(), now });
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
  }

  it('the granted person can act while the grant is live, is refused once it expires, and the owner still sees it', async () => {
    await cast();
    // No role at all: refused.
    expect((await availability('u-support')).status).toBe(403);
    const g = await grant('e-live', { userId: 'u-support', roleId: 'store_manager', branchScope: 'all', reason: REASON, minutes: 60 });
    expect(g.status, JSON.stringify(g.body)).toBe(201);

    // Live: the store manager's permission is really there.
    expect((await availability('u-support')).status).toBe(200);
    // A cold restart rebuilds it from the ledger — nothing held in memory.
    const restarted = apiHarness({ store: h.store, now });
    expect((await availability('u-support', restarted)).status).toBe(200);

    // 61 minutes on, the grant has run out on its own: the very next request is refused.
    offsetMs = 61 * 60_000;
    expect((await availability('u-support')).status).toBe(403);
    expect((await availability('u-support', restarted)).status).toBe(403);
    // The owner's review still lists it — never erased. (The review reads the surface's own wall clock, which this test
    // does not step, so its "active" flag is not asserted here; emergency-access.test.ts covers the review's flags.)
    expect((await review()).review.find((r) => r.grantId === 'e-live')).toMatchObject({ userId: 'u-support', approvedBy: 'u-owner', reason: REASON });
  });

  it('a grant revoked early stops conferring access at once, and stays in the review as ended early', async () => {
    await cast();
    expect((await grant('e-rev', { userId: 'u-support', roleId: 'store_manager', branchScope: 'all', reason: REASON, minutes: 60 })).status).toBe(201);
    expect((await availability('u-support')).status).toBe(200);
    const rv = await h.request({ method: 'POST', path: '/v1/access/emergency/e-rev/revoke', userId: 'u-owner', tenantId: T, idempotencyKey: 'rv-e-rev', body: {} });
    expect(rv.status).toBe(200);
    expect((await availability('u-support')).status).toBe(403);
    expect((await review()).review.find((r) => r.grantId === 'e-rev')).toMatchObject({ active: false, endedEarly: true });
  });

  it('the access stays inside the grant\'s own branch scope — never wider', async () => {
    await cast();
    expect((await grant('e-scope', { userId: 'u-support', roleId: 'store_manager', branchScope: ['S1'], reason: REASON, minutes: 60 })).status).toBe(201);
    const access = await tenantAccessResolver(h.store, ROLE_CATALOGUE, now)(T);
    expect(access.can({ userId: 'u-support', permission: 'inventory.availability.read', branchId: 'S1' })).toBe(true);
    expect(access.can({ userId: 'u-support', permission: 'inventory.availability.read', branchId: 'S2' })).toBe(false);
    // A company-wide action needs an "all" grant — a one-branch emergency grant is not one.
    expect(access.can({ userId: 'u-support', permission: 'inventory.availability.read', branchId: null })).toBe(false);
    // Nor does a store manager's emergency grant carry anything a store manager does not hold.
    expect(access.can({ userId: 'u-support', permission: 'identity.role.grant', branchId: 'S1' })).toBe(false);
    offsetMs = 61 * 60_000;
    const later = await tenantAccessResolver(h.store, ROLE_CATALOGUE, now)(T);
    expect(later.can({ userId: 'u-support', permission: 'inventory.availability.read', branchId: 'S1' })).toBe(false);
  });
});
