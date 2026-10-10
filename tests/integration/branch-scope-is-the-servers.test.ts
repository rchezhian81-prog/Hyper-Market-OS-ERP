import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';

/**
 * **Branch scope is the server's (Wave 2b-ii · audit PA-01 / EA-03 · M01-FR-01 · M02-FR-02 · M25-FR-01 · M29-FR-01 ·
 * M29-FR-02 · SEC-02 · §28 · P-08).** The audit executed the real pipeline: a manager signed in for br-1 with a grant
 * for [br-1] read BOTH branches' consolidation with no `?scope=` (200), read br-2 with `?scope=br-2` (200), and wrote
 * another branch's pay rate (200). The pipeline now derives the caller's scope for the route's permission from their
 * grants and puts it on the request; the reads narrow to it and the writes refuse by name. These are the audit's
 * three reproductions inverted, driven as the branch-limited manager (never an owner simulating one), on the
 * in-memory store and on real PostgreSQL.
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OWNER = 'u-owner'; const MGR1 = 'u-mgr-br1'; const MGR2 = 'u-mgr-br2';
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

// ── consolidation (EA-03) ──────────────────────────────────────────────────────────────────────────────────────
const member = (h: ApiHarness, t: string, branchId: string) =>
  h.request({ method: 'POST', path: '/v1/consolidation/memberships', userId: OWNER, tenantId: t, idempotencyKey: `mem-${branchId}`, body: { branchId, parentId: 'co-1', from: '2026-01-01' } });
const contribute = (h: ApiHarness, t: string, branchId: string, grossMinor: number) =>
  h.request({ method: 'POST', path: '/v1/consolidation/contributions', userId: OWNER, tenantId: t, idempotencyKey: `con-${branchId}`, body: { branchId, period: '2026-09', family: 'sales', measures: { grossMinor }, lastRefreshAt: '2026-09-25T09:30:00.000Z', revision: 1 } });
const Q = { node: 'co-1', family: 'sales', period: '2026-09', asOf: '2026-09-25T10:00:00.000Z' };
const rollup = (h: ApiHarness, t: string, userId: string, branchId: string | undefined, q: Record<string, string> = {}) =>
  h.request({ method: 'GET', path: '/v1/consolidation', userId, tenantId: t, ...(branchId === undefined ? {} : { branchId }), query: { ...Q, ...q } });
interface Report { measures: Record<string, number>; reportedBranches: string[]; withheldByScope: string[] }

// ── roster (PA-01) ─────────────────────────────────────────────────────────────────────────────────────────────
const putEmployee = (h: ApiHarness, t: string, userId: string, branchId: string | undefined, id: string, body: Record<string, unknown>, key = `emp-${id}-${userId}`) =>
  h.request({ method: 'POST', path: `/v1/hr/workforce/employees/${id}`, userId, tenantId: t, ...(branchId === undefined ? {} : { branchId }), idempotencyKey: key, body });
const roster = (h: ApiHarness, t: string, userId: string, branchId: string | undefined, query: Record<string, string> = {}) =>
  h.request({ method: 'GET', path: '/v1/hr/workforce/roster', userId, tenantId: t, ...(branchId === undefined ? {} : { branchId }), query });
const emp = (branchId: string, rate: number) => ({ name: 'Asha', branchId, roles: ['cashier'], active: true, hourlyRateMinor: rate });
interface RosterBody { employees: { employeeId: string; branchId: string; hourlyRateMinor?: number }[] }

async function company(h: ApiHarness, t: string): Promise<ApiHarness> {
  await h.seedOwner(t, OWNER);
  await h.provisionRole(t, MGR1, 'store_manager', ['br-1']); // a manager of ONE branch — the audit's subject
  await h.provisionRole(t, MGR2, 'store_manager', ['br-2']);
  await member(h, t, 'br-1'); await member(h, t, 'br-2');
  await contribute(h, t, 'br-1', 100_000); await contribute(h, t, 'br-2', 250_000);
  await putEmployee(h, t, OWNER, undefined, 'E1', emp('br-1', 12_000));
  await putEmployee(h, t, OWNER, undefined, 'E2', emp('br-2', 15_000));
  return h;
}

async function theAuditsThreeReproductionsInverted(h: ApiHarness, t: string): Promise<void> {
  // EA-03 (1): no scope asked for → exactly the branch held, the other NAMED as withheld — never both
  const mine = (await rollup(h, t, MGR1, 'br-1')).body as Report;
  expect(mine.reportedBranches).toEqual(['br-1']);
  expect(mine.withheldByScope).toEqual(['br-2']);
  expect(mine.measures['grossMinor']).toBe(100_000);
  // EA-03 (2): asking for the other branch is refused by name, not answered
  const theirs = await rollup(h, t, MGR1, 'br-1', { scope: 'br-2' });
  expect(theirs.status).toBe(403);
  expect(codeOf(theirs)).toBe('scope_not_held');
  // asking for one's own branch is fine; the owner sees everything
  expect(((await rollup(h, t, MGR1, 'br-1', { scope: 'br-1' })).body as Report).reportedBranches).toEqual(['br-1']);
  expect(((await rollup(h, t, OWNER, undefined)).body as Report).reportedBranches).toEqual(['br-1', 'br-2']);

  // PA-01 (3): the other branch's pay rate cannot be written — by naming it, or by pulling its record into mine
  const write = await putEmployee(h, t, MGR1, 'br-1', 'E2', emp('br-2', 99_000));
  expect(write.status).toBe(403);
  expect(codeOf(write)).toBe('outside_your_branch_scope');
  const pull = await putEmployee(h, t, MGR1, 'br-1', 'E2', emp('br-1', 99_000)); // direct id, re-homed into my branch
  expect(pull.status).toBe(403);
  expect(codeOf(pull)).toBe('outside_your_branch_scope');
  expect((await putEmployee(h, t, MGR1, 'br-1', 'E1', emp('br-1', 13_000))).status).toBe(200); // my own branch: fine
  // and the other branch's pay rate cannot be READ: omitted narrows to mine; named is refused
  const grid = (await roster(h, t, MGR1, 'br-1')).body as RosterBody;
  expect(grid.employees.map((e) => e.employeeId)).toEqual(['E1']);
  expect(grid.employees[0]!.hourlyRateMinor).toBe(13_000);
  const peek = await roster(h, t, MGR1, 'br-1', { branchId: 'br-2' });
  expect(peek.status).toBe(403);
  expect(codeOf(peek)).toBe('outside_your_branch_scope');
  // br-2's own manager still sees br-2 at its true rate — nothing was written across
  const other = (await roster(h, t, MGR2, 'br-2')).body as RosterBody;
  expect(other.employees).toEqual([expect.objectContaining({ employeeId: 'E2', branchId: 'br-2', hourlyRateMinor: 15_000 })]);
  // the owner sees the whole grid
  expect(((await roster(h, t, OWNER, undefined)).body as RosterBody).employees.map((e) => e.employeeId).sort()).toEqual(['E1', 'E2']);
}

describe('branch scope is the server\'s — the audit\'s reproductions inverted (PA-01 / EA-03)', () => {
  it('a br-1 manager reads only br-1, is refused br-2 by name, cannot write or pull br-2\'s pay rate, and a restart agrees', async () => {
    const h = await company(apiHarness(), A);
    await theAuditsThreeReproductionsInverted(h, A);
    // a fresh surface over the same store derives the same scope from the ledger
    const restarted = apiHarness({ store: h.store });
    expect(((await rollup(restarted, A, MGR1, 'br-1')).body as Report).withheldByScope).toEqual(['br-2']);
    expect((await putEmployee(restarted, A, MGR1, 'br-1', 'E2', emp('br-2', 1), 'again')).status).toBe(403);
  });

  it('the caller-rows drill is retired (EA-05) — scope on the governed drill is proven over head office\'s own bills', async () => {
    // tests/integration/a-drill-reaches-its-day-and-only-the-readers-branches.test.ts: a branch-limited manager sees
    // only their branch's bills AND headline; asking for another branch, or for everything, is refused by name.
    const h = await company(apiHarness(), A);
    const old = await h.request({ method: 'POST', path: '/v1/reporting/drill', userId: MGR1, tenantId: A, branchId: 'br-1', idempotencyKey: 'd1', body: { metric: 'sales', kpiValueMinor: 1, transactions: [] } });
    expect([403, 410]).toContain(old.status);
  });
});

// ── on real PostgreSQL — the scope is derived from the ledger every instance reads ─────────────────────────────
const DATABASE_URL = process.env['DATABASE_URL'];
const PG_TENANT = `f${Date.now().toString(16).slice(-7)}-ffff-4fff-8fff-${'f'.repeat(12)}`;

describe.skipIf(!DATABASE_URL)('branch scope on real PostgreSQL (Wave 2b-ii)', () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 4, options: '-c app.tenant_id=*' });
    const dir = 'db/migrations';
    await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
      .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
  });
  afterAll(async () => { await pool.end(); });
  const harness = () => { const sql = pgPoolClient(pool); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); };

  it('the br-1 manager reads br-1 only, is refused br-2 by name, cannot write br-2\'s pay rate — and a second instance agrees', async () => {
    const h = await company(harness(), PG_TENANT);
    await theAuditsThreeReproductionsInverted(h, PG_TENANT);
    const other = harness();
    expect(((await rollup(other, PG_TENANT, MGR1, 'br-1')).body as Report).withheldByScope).toEqual(['br-2']);
  });
});
