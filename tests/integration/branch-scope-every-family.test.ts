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
 * **Every branch-keyed family keeps to the caller's branches (PA-01-r1, round 2 · audit PA-01 · M01-FR-01 · M02-FR-02 ·
 * M25 · M26 · M27 · M33 · M34 · SEC-02 · P-08).** Wave 2b-ii named the families that took a branch from the body or the
 * query and trusted the token's branch alone. Each is driven here as a person whose authority (the owner's role, so
 * every permission is held) reaches ONE branch, br-1 — never as an owner simulating one — against br-2's records: a
 * branch named that is not held is refused by name; a read with none named narrows to br-1 (and shop-wide rows); a
 * write at br-2, or over a record on file at br-2, is refused; a record naming no branch is company-wide work. The
 * company-wide owner still sees and does everything.
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaab1';
const OWNER = 'u-owner'; const B1 = 'u-br1';
const AT = '2026-08-07T10:00:00.000Z';
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
type H = ApiHarness;

let n = 0;
const post = (h: H, t: string, userId: string, path: string, body: Record<string, unknown>) =>
  h.request({ method: 'POST', path, userId, tenantId: t, ...(userId === B1 ? { branchId: 'br-1' } : {}), idempotencyKey: `k${++n}`, body });
const get = (h: H, t: string, userId: string, path: string, query: Record<string, string> = {}) =>
  h.request({ method: 'GET', path, userId, tenantId: t, ...(userId === B1 ? { branchId: 'br-1' } : {}), query });
const OUT = 'outside_your_branch_scope'; const NOT_HELD = 'scope_not_held'; const SHOP_WIDE = 'shop_wide_record_needs_company_scope';

async function shop(h: H, t: string): Promise<void> {
  await h.seedOwner(t, OWNER);
  await h.provisionRole(t, B1, 'owner', ['br-1']); // every permission, one branch
  await h.enableFeature(t, 'dept.concession');
}

async function workforce(h: H, t: string): Promise<void> {
  const checklist = (branchId?: string) => ({ kind: 'opening', items: [{ itemId: 'i1', description: 'Lights on', done: true, blocking: false }], ...(branchId === undefined ? {} : { branchId }) });
  expect((await post(h, t, OWNER, '/v1/hr/workforce/checklists/C2', checklist('br-2'))).status).toBe(200);
  expect((await post(h, t, OWNER, '/v1/hr/workforce/checklists/C0', checklist())).status).toBe(200); // shop-wide
  expect((await post(h, t, B1, '/v1/hr/workforce/checklists/C1', checklist('br-1'))).status).toBe(200);
  const listed = (await get(h, t, B1, '/v1/hr/workforce/checklists')).body as { checklists: { checklistId: string }[] };
  expect(listed.checklists.map((c) => c.checklistId).sort()).toEqual(['C0', 'C1']);
  expect(codeOf(await get(h, t, B1, '/v1/hr/workforce/checklists', { branchId: 'br-2' }))).toBe(NOT_HELD);
  expect(codeOf(await get(h, t, B1, '/v1/hr/workforce/checklists/C2/status'))).toBe(OUT);
  expect(codeOf(await post(h, t, B1, '/v1/hr/workforce/checklists/C2', checklist('br-1')))).toBe(OUT); // no re-homing
  expect(codeOf(await post(h, t, B1, '/v1/hr/workforce/checklists/C3', checklist('br-2')))).toBe(OUT);
  expect(codeOf(await post(h, t, B1, '/v1/hr/workforce/checklists/C4', checklist()))).toBe(SHOP_WIDE);

  const task = (branchId: string) => ({ description: 'Face up aisle 3', forRole: 'store_manager', dueAt: AT, critical: false, branchId });
  expect((await post(h, t, OWNER, '/v1/hr/workforce/tasks/T2', task('br-2'))).status).toBe(200);
  expect((await post(h, t, B1, '/v1/hr/workforce/tasks/T1', task('br-1'))).status).toBe(200);
  const tasks = (await get(h, t, B1, '/v1/hr/workforce/tasks', { asOf: AT })).body as { tasks: { taskId: string }[] };
  expect(tasks.tasks.map((x) => x.taskId)).toEqual(['T1']);
  expect(codeOf(await get(h, t, B1, '/v1/hr/workforce/tasks', { branchId: 'br-2' }))).toBe(NOT_HELD);
  expect(codeOf(await post(h, t, B1, '/v1/hr/workforce/tasks/T2/complete', { doneBy: B1 }))).toBe(OUT);
  expect(codeOf(await post(h, t, B1, '/v1/hr/workforce/tasks/T2', task('br-1')))).toBe(OUT);

  const emp = (branchId: string) => ({ name: 'Asha', branchId, roles: ['cashier'], active: true, hourlyRateMinor: 12_000 });
  expect((await post(h, t, OWNER, '/v1/hr/workforce/employees/E1', emp('br-1'))).status).toBe(200);
  expect((await post(h, t, OWNER, '/v1/hr/workforce/employees/E2', emp('br-2'))).status).toBe(200);
  expect((await post(h, t, OWNER, '/v1/hr/workforce/attendance/E2/2026-08-07', { hours: 8 })).status).toBe(200);
  expect(codeOf(await post(h, t, B1, '/v1/hr/workforce/attendance/E2/2026-08-07', { hours: 1 }))).toBe(OUT);
  expect((await post(h, t, B1, '/v1/hr/workforce/attendance/E1/2026-08-07', { hours: 6 })).status).toBe(200);
  const att = (await get(h, t, B1, '/v1/hr/workforce/attendance', { date: '2026-08-07' })).body as { attendance: { employeeId: string }[] };
  expect(att.attendance.map((a) => a.employeeId)).toEqual(['E1']);
  expect(codeOf(await get(h, t, B1, '/v1/hr/workforce/labour-cost', { branchId: 'br-2', date: '2026-08-07', salesMinor: '100000' }))).toBe(OUT);
  // the owner still sees both
  expect(((await get(h, t, OWNER, '/v1/hr/workforce/attendance', { date: '2026-08-07' })).body as { attendance: unknown[] }).attendance).toHaveLength(2);
}

async function facilities(h: H, t: string): Promise<void> {
  const schedule = (branchId: string) => ({ branchId, title: 'Mop the floor', category: 'cleaning', frequency: 'daily', assignedRole: 'store_manager', escalatesTo: OWNER, evidenceRequired: false, verificationRequired: false });
  expect((await post(h, t, OWNER, '/v1/facilities/schedules/S2', schedule('br-2'))).status).toBe(201);
  expect((await post(h, t, OWNER, '/v1/facilities/schedules/S2/tasks/ft2', { dueOn: '2026-08-01' })).status).toBeLessThan(300);
  expect(codeOf(await post(h, t, B1, '/v1/facilities/schedules/S2', schedule('br-1')))).toBe(OUT);
  expect(codeOf(await post(h, t, B1, '/v1/facilities/schedules/S3', schedule('br-2')))).toBe(OUT);
  expect(codeOf(await post(h, t, B1, '/v1/facilities/schedules/S2/tasks/ft3', { dueOn: '2026-08-02' }))).toBe(OUT);
  expect(codeOf(await post(h, t, B1, '/v1/facilities/tasks/ft2/complete', {}))).toBe(OUT);
  expect(((await get(h, t, B1, '/v1/facilities/overdue', { asOf: '2026-08-07' })).body as { overdue: unknown[] }).overdue).toEqual([]);
  expect(((await get(h, t, OWNER, '/v1/facilities/overdue', { asOf: '2026-08-07' })).body as { overdue: unknown[] }).overdue.length).toBeGreaterThan(0);
  expect(codeOf(await get(h, t, B1, '/v1/facilities/overdue', { asOf: '2026-08-07', branchId: 'br-2' }))).toBe(NOT_HELD);
  const incident = { branchId: 'br-2', kind: 'near_miss', severity: 'minor', occurredAt: AT, reportedAt: AT, reportedBy: B1, description: 'wet floor' };
  expect(codeOf(await post(h, t, B1, '/v1/facilities/incidents/I2', incident))).toBe(OUT);
  expect(codeOf(await get(h, t, B1, '/v1/facilities/evidence', { branchId: 'br-2', from: '2026-08-01', to: '2026-08-31' }))).toBe(OUT);
  expect(codeOf(await post(h, t, B1, '/v1/facilities/energy/r2', { branchId: 'br-2', onDate: '2026-08-07', kilowattHours: 10, costMinor: 1000, source: 'meter' }))).toBe(OUT);
}

async function commercialAndPlatform(h: H, t: string): Promise<void> {
  // concession
  const contract = { concessionaireId: 'c-sweets', name: 'Sweets counter', branchId: 'br-2', startsOn: '2026-08-01', endsOn: '2027-07-31', basis: 'fixed_rent', depositMinor: 0, fixedRentMinor: 100_000 };
  expect(codeOf(await post(h, t, B1, '/v1/concession/contracts/K2', contract))).toBe(OUT);
  expect(codeOf(await get(h, t, B1, '/v1/concession/branches/br-2/store-valuation'))).toBe(OUT);
  expect(codeOf(await post(h, t, B1, '/v1/concession/valuation', { branchId: 'br-2', lots: [] }))).toBe(OUT);
  // device registry
  expect((await post(h, t, OWNER, '/v1/platform/devices/D2/register', { branchId: 'br-2', kind: 'handheld', label: 'Back store phone' })).status).toBe(201);
  expect((await post(h, t, B1, '/v1/platform/devices/D1/register', { branchId: 'br-1', kind: 'handheld', label: 'Floor phone' })).status).toBe(201);
  expect(((await get(h, t, B1, '/v1/platform/devices')).body as { devices: { deviceId: string }[] }).devices.map((d) => d.deviceId)).toEqual(['D1']);
  expect(codeOf(await get(h, t, B1, '/v1/platform/devices', { branchId: 'br-2' }))).toBe(NOT_HELD);
  expect(codeOf(await post(h, t, B1, '/v1/platform/devices/D2/status', { status: 'blocked', reason: 'lost' }))).toBe(OUT);
  expect(codeOf(await post(h, t, B1, '/v1/platform/devices/D2/register', { branchId: 'br-1', kind: 'handheld', label: 'mine now' }))).toBe(OUT);
  expect(codeOf(await post(h, t, B1, '/v1/platform/devices/D2/report', { appVersion: '1.0.0' }))).toBe(OUT);
  // compliance obligations
  const obligation = (branchId?: string) => ({ kind: 'licence', name: 'Trade licence', authority: 'Corporation', validFrom: '2026-01-01', expiresOn: '2026-12-31', responsible: { userId: OWNER, name: 'Owner' }, ...(branchId === undefined ? {} : { branchId }) });
  expect((await post(h, t, OWNER, '/v1/compliance/obligations/O2', obligation('br-2'))).status).toBeLessThan(300);
  expect(codeOf(await post(h, t, B1, '/v1/compliance/obligations/O3', obligation('br-2')))).toBe(OUT);
  expect(codeOf(await post(h, t, B1, '/v1/compliance/obligations/O4', obligation()))).toBe(SHOP_WIDE);
  expect(codeOf(await get(h, t, B1, '/v1/compliance/status', { branchId: 'br-2' }))).toBe(OUT);
  expect(codeOf(await post(h, t, B1, '/v1/compliance/obligations/O2/close', { reason: 'not ours' }))).toBe(OUT);
  // price integrity, branch lifecycle
  expect(codeOf(await post(h, t, B1, '/v1/pricing/integrity/audit', { branchId: 'br-2', asAt: AT, products: [], displayed: [] }))).toBe(OUT);
  const money = { minor: 0, currency: 'INR' };
  expect(codeOf(await post(h, t, B1, '/v1/platform/branches/transition/evaluate', {
    request: { branchId: 'br-2', transition: 'temporarily_close', requestedBy: B1, reason: 'repairs', at: AT },
    currentState: 'open', readiness: { stockValue: money, cashBalance: money },
  }))).toBe(OUT);
  // the stored audit trail
  expect(codeOf(await get(h, t, B1, '/v1/audit/trail', { branchId: 'br-2' }))).toBe(NOT_HELD);
  expect(codeOf(await get(h, t, B1, '/v1/audit/trail/verify'))).toBe(NOT_HELD);
  expect((await get(h, t, B1, '/v1/audit/trail')).status).toBe(200);
  expect((await get(h, t, OWNER, '/v1/audit/trail/verify')).status).toBe(200);
}

describe('every branch-keyed family keeps to the caller\'s branches (PA-01-r1 round 2)', () => {
  it('workforce: checklists, tasks and attendance', async () => { const h = apiHarness(); await shop(h, A); await workforce(h, A); });
  it('facilities: schedules, tasks, overdue, incidents, evidence, energy', async () => { const h = apiHarness(); await shop(h, A); await facilities(h, A); });
  it('concession, devices, obligations, price integrity, branch lifecycle and the audit trail', async () => { const h = apiHarness(); await shop(h, A); await commercialAndPlatform(h, A); });
});

// ── on real PostgreSQL ────────────────────────────────────────────────────────────────────────────────────────
const DATABASE_URL = process.env['DATABASE_URL'];
const PG_TENANT = `b${Date.now().toString(16).slice(-7)}-bbbb-4bbb-8bbb-${'b'.repeat(12)}`;

describe.skipIf(!DATABASE_URL)('every branch-keyed family on real PostgreSQL (PA-01-r1 round 2)', () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 4, options: '-c app.tenant_id=*' });
    const dir = 'db/migrations';
    await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
      .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
  });
  afterAll(async () => { await pool.end(); });
  const harness = () => { const sql = pgPoolClient(pool); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); };

  it('all three family groups, then a second instance agrees', async () => {
    const h = harness();
    await shop(h, PG_TENANT);
    await workforce(h, PG_TENANT);
    await facilities(h, PG_TENANT);
    await commercialAndPlatform(h, PG_TENANT);
    expect(codeOf(await get(harness(), PG_TENANT, B1, '/v1/hr/workforce/checklists/C2/status'))).toBe(OUT);
  });
});
