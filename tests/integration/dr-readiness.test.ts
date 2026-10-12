import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { runMigrations } from '../../packages/persistence/src/migrations';

// DR-drill scoring & backup-retention eligibility, end to end (M35-FR-02, API-11, §32, hard rule #6). The
// readiness posture around a proven backup: can the shop come back inside the roadmap's RPO/RTO, and which
// aged backups may be pruned WITHOUT ever emptying the shelf. Stateless rulings on the tested @sre/ops
// engine. Gated backup.verify.read.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

const targets = (h: ApiHarness, u: string) =>
  h.request({ method: 'GET', path: '/v1/platform/recovery-targets', userId: u, tenantId: A });
const score = (h: ApiHarness, u: string, body: Record<string, unknown>, key = `s-${Math.random()}`) =>
  h.request({ method: 'POST', path: '/v1/platform/dr-drills/score', userId: u, tenantId: A, idempotencyKey: key, body });
const eligible = (h: ApiHarness, u: string, body: Record<string, unknown>, key = `e-${Math.random()}`) =>
  h.request({ method: 'POST', path: '/v1/platform/backups/eligible-for-removal', userId: u, tenantId: A, idempotencyKey: key, body });
const record = (h: ApiHarness, u: string, body: Record<string, unknown>, key = `r-${Math.random()}`) =>
  h.request({ method: 'POST', path: '/v1/platform/dr-drills', userId: u, tenantId: A, idempotencyKey: key, body });
const register = (h: ApiHarness, u: string) =>
  h.request({ method: 'GET', path: '/v1/platform/dr-drills', userId: u, tenantId: A });

async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');                // backup.verify.read
  await h.provisionRole(A, 'u-cash', 'cashier');  // none
  return h;
}

// Five backups oldest-to-newest gaps, to exercise the retention window and the keep floor.
const MANIFESTS = [
  { backupId: 'b1', startedAt: '2026-09-01T02:00:00Z' }, // newest
  { backupId: 'b2', startedAt: '2026-08-20T02:00:00Z' },
  { backupId: 'b3', startedAt: '2026-08-10T02:00:00Z' }, // inside a 30-day window from 2026-09-03
  { backupId: 'b4', startedAt: '2026-07-01T02:00:00Z' }, // older than the window
  { backupId: 'b5', startedAt: '2026-06-01T02:00:00Z' }, // older than the window
];

describe('DR readiness: recovery targets, drill scoring, retention eligibility (M35-FR-02)', () => {
  it('publishes the §32 recovery targets — committed local sales must not be lost at all (RPO 0)', async () => {
    const h = await cast();
    const res = await targets(h, 'u-owner');
    expect(res.status).toBe(200);
    const body = res.body as { targets: { service: string; rpoSeconds: number; rtoSeconds: number }[] };
    const edge = body.targets.find((t) => t.service.includes('store-edge'));
    expect(edge?.rpoSeconds).toBe(0);              // §32: no data loss for committed sales
    expect(body.targets.find((t) => t.service === 'cloud')?.rtoSeconds).toBe(14_400);
  });

  it('scores a rehearsal pass, and NAMES an RPO miss and an RTO miss against the target', async () => {
    const h = await cast();

    // By service name: within both targets → passed.
    const ok = await score(h, 'u-owner', { service: 'cloud', dataLossSeconds: 300, recoverySeconds: 3600 });
    expect(ok.body).toMatchObject({ passed: true, metRpo: true, metRto: true });

    // Committed local sales, any loss at all fails the RPO of 0 — the miss is named.
    const rpoMiss = await score(h, 'u-owner', { service: 'store-edge (committed sales)', dataLossSeconds: 5, recoverySeconds: 100 });
    expect(rpoMiss.body).toMatchObject({ passed: false, metRpo: false, metRto: true });
    expect((rpoMiss.body as { detail: string }).detail).toContain('RPO of 0s');

    // Explicit target, recovery too slow → RTO miss named.
    const rtoMiss = await score(h, 'u-owner', { target: { service: 'depot', rpoSeconds: 60, rtoSeconds: 120 }, dataLossSeconds: 30, recoverySeconds: 200 });
    expect(rtoMiss.body).toMatchObject({ passed: false, metRpo: true, metRto: false });
    expect((rtoMiss.body as { detail: string }).detail).toContain('RTO of 120s');
  });

  it('reports aged backups eligible for removal — but never empties the shelf (hard rule #6)', async () => {
    const h = await cast();

    // 30-day window from 2026-09-03, keep the newest 2: b4 and b5 are past both the floor and the window.
    const r = await eligible(h, 'u-owner', { manifests: MANIFESTS, asOf: '2026-09-03T00:00:00Z', retentionDays: 30, keepAtLeast: 2 });
    const body = r.body as { eligibleForRemoval: { backupId: string }[]; eligibleCount: number; keptCount: number };
    expect(body.eligibleForRemoval.map((m) => m.backupId).sort()).toEqual(['b4', 'b5']);
    expect(body.eligibleCount).toBe(2);
    expect(body.keptCount).toBe(3);

    // The floor is load-bearing: keepAtLeast at or above the count keeps EVERY backup, however old.
    const allKept = await eligible(h, 'u-owner', { manifests: MANIFESTS, asOf: '2026-09-03T00:00:00Z', retentionDays: 30, keepAtLeast: 5 });
    expect(allKept.body).toMatchObject({ eligibleCount: 0, keptCount: 5 });
  });

  it('refuses a drill with no target / no measured seconds, an unknown service, a bad removal request, and gates on backup.verify.read', async () => {
    const h = await cast();

    expect(codeOf(await score(h, 'u-owner', { dataLossSeconds: 10, recoverySeconds: 20 }))).toBe('drill_needs_a_target');
    expect(codeOf(await score(h, 'u-owner', { service: 'cloud' }))).toBe('drill_needs_measured_seconds');
    expect(codeOf(await score(h, 'u-owner', { service: 'no-such-service', dataLossSeconds: 1, recoverySeconds: 1 }))).toBe('unknown_recovery_target');
    expect(codeOf(await score(h, 'u-owner', { target: { service: 'x', rpoSeconds: -1, rtoSeconds: 1 }, dataLossSeconds: 1, recoverySeconds: 1 }))).toBe('target_not_a_recovery_target');

    expect(codeOf(await eligible(h, 'u-owner', { asOf: '2026-09-03T00:00:00Z', retentionDays: 30 }))).toBe('removal_needs_manifests');
    expect(codeOf(await eligible(h, 'u-owner', { manifests: MANIFESTS, retentionDays: 30 }))).toBe('removal_needs_asof_and_retention');
    expect(codeOf(await eligible(h, 'u-owner', { manifests: MANIFESTS, asOf: '2026-09-03T00:00:00Z', retentionDays: 30, keepAtLeast: 1.5 }))).toBe('keep_at_least_not_a_count');

    // A cashier holds no backup.verify.read → refused on every route.
    expect((await targets(h, 'u-cash')).status).toBe(403);
    expect((await score(h, 'u-cash', { service: 'cloud', dataLossSeconds: 1, recoverySeconds: 1 })).status).toBe(403);
    expect((await eligible(h, 'u-cash', { manifests: MANIFESTS, asOf: '2026-09-03T00:00:00Z', retentionDays: 30 })).status).toBe(403);
  });
});

describe('DR-drill register: the durable §32 evidence over N quarters (M35-FR-02, hard rule #6)', () => {
  it('records drills — a pass AND a miss — and the register keeps both, with a per-service posture', async () => {
    const h = await cast();

    // An empty register before anything is recorded — not an error.
    const empty = (await register(h, 'u-owner')).body as { drills: unknown[]; summary: { recorded: number } };
    expect(empty.drills).toEqual([]);
    expect(empty.summary.recorded).toBe(0);

    // Q3 cloud drill passes; a later Q3 cloud drill MISSES (took too long). The miss is kept, not re-run away.
    expect((await record(h, 'u-owner', { drillId: 'q3-cloud-a', service: 'cloud', dataLossSeconds: 100, recoverySeconds: 3600 })).status).toBe(201);
    expect((await record(h, 'u-owner', { drillId: 'q3-cloud-b', service: 'cloud', dataLossSeconds: 100, recoverySeconds: 20000 })).status).toBe(201);
    expect((await record(h, 'u-owner', { drillId: 'q3-edge', service: 'store-edge (committed sales)', dataLossSeconds: 0, recoverySeconds: 60 })).status).toBe(201);

    const reg = (await register(h, 'u-owner')).body as {
      drills: { drillId: string; result: { passed: boolean; service: string } }[];
      posture: { service: string; passed: boolean }[];
      summary: { recorded: number; passed: number; missed: number; servicesCovered: number };
    };
    // Every drill kept — the miss included (hard rule #6).
    expect(reg.summary).toMatchObject({ recorded: 3, passed: 2, missed: 1, servicesCovered: 2 });
    expect(reg.drills.map((d) => d.drillId).sort()).toEqual(['q3-cloud-a', 'q3-cloud-b', 'q3-edge']);
    // Posture is the LATEST drill per service — cloud's latest MISSED, so the current cloud posture is a fail.
    expect(reg.posture.find((p) => p.service === 'cloud')?.passed).toBe(false);
    expect(reg.posture.find((p) => p.service === 'store-edge (committed sales)')?.passed).toBe(true);
  });

  it('gates the register read (backup.verify.read) and the record write (backup.drill.record), and refuses a drill with no id', async () => {
    const h = await cast();
    // Malformed: recording needs a drillId.
    expect(codeOf(await record(h, 'u-owner', { service: 'cloud', dataLossSeconds: 1, recoverySeconds: 1 }))).toBe('drill_needs_an_id');
    // A cashier holds neither scope → refused on both the write and the read.
    expect((await record(h, 'u-cash', { drillId: 'x', service: 'cloud', dataLossSeconds: 1, recoverySeconds: 1 })).status).toBe(403);
    expect((await register(h, 'u-cash')).status).toBe(403);
  });
});

// ── the register on real PostgreSQL (M35-FR-02 · §32 · hard rule #6) ──────────────────────────────────────────────────
// The register is the evidence that recovery passed N quarters running, so it must survive a restart: drills recorded
// through one head-office instance are read back — the miss included — by a second instance over the same database; a
// re-sent record (the same idempotency key) is one drill; the refusals hold.
const DATABASE_URL = process.env['DATABASE_URL'];
const PG_TENANT = `d${Date.now().toString(16).slice(-7)}-d8d8-4ddd-8ddd-${'d'.repeat(12)}`;

describe.skipIf(!DATABASE_URL)('DR-drill register on real PostgreSQL (M35-FR-02)', () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 4, options: '-c app.tenant_id=*' });
    const dir = 'db/migrations';
    await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
      .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
  });
  afterAll(async () => { await pool.end(); });
  const harness = (): ApiHarness => { const sql = pgPoolClient(pool); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); };
  const on = (h: ApiHarness, method: 'GET' | 'POST', path: string, userId: string, body?: unknown, key?: string) =>
    h.request({ method, path, userId, tenantId: PG_TENANT, ...(key === undefined ? {} : { idempotencyKey: key }), ...(body === undefined ? {} : { body }) });

  it('a pass and a miss are kept across a restart, a re-sent record is one drill, and the cashier is refused', async () => {
    const h = harness();
    await h.seedOwner(PG_TENANT, 'u-owner');
    await h.provisionRole(PG_TENANT, 'u-cash', 'cashier');
    expect((await on(h, 'POST', '/v1/platform/dr-drills', 'u-owner', { drillId: 'q4-cloud', service: 'cloud', dataLossSeconds: 60, recoverySeconds: 3_600 }, 'pg-q4-cloud')).status).toBe(201);
    const miss = await on(h, 'POST', '/v1/platform/dr-drills', 'u-owner', { drillId: 'q4-edge', service: 'store-edge (committed sales)', dataLossSeconds: 0, recoverySeconds: 2_700 }, 'pg-q4-edge');
    expect(miss.status).toBe(201);
    expect((miss.body as { recorded: { result: { passed: boolean; detail: string } } }).recorded.result).toMatchObject({ passed: false, detail: 'took 2700s to recover against an RTO of 1800s' });
    // The same record re-sent (a lost answer, a retried click) is the same drill — not a second one.
    expect((await on(h, 'POST', '/v1/platform/dr-drills', 'u-owner', { drillId: 'q4-edge', service: 'store-edge (committed sales)', dataLossSeconds: 0, recoverySeconds: 2_700 }, 'pg-q4-edge')).status).toBe(201);
    // Refused, and nothing recorded: a cashier, and a drill with no id.
    expect((await on(h, 'POST', '/v1/platform/dr-drills', 'u-cash', { drillId: 'x', service: 'cloud', dataLossSeconds: 1, recoverySeconds: 1 }, 'pg-cash')).status).toBe(403);
    expect(codeOf(await on(h, 'POST', '/v1/platform/dr-drills', 'u-owner', { service: 'cloud', dataLossSeconds: 1, recoverySeconds: 1 }, 'pg-noid'))).toBe('drill_needs_an_id');

    // A second head-office instance over the same database (a restart) reads the same register.
    const again = harness();
    const reg = (await on(again, 'GET', '/v1/platform/dr-drills', 'u-owner')).body as {
      drills: { drillId: string; drilledBy: string; result: { passed: boolean } }[];
      posture: { service: string; passed: boolean }[];
      summary: { recorded: number; passed: number; missed: number; servicesCovered: number };
    };
    expect(reg.summary).toEqual({ recorded: 2, passed: 1, missed: 1, servicesCovered: 2 });
    expect(reg.drills.map((d) => [d.drillId, d.drilledBy, d.result.passed]).sort()).toEqual([['q4-cloud', 'u-owner', true], ['q4-edge', 'u-owner', false]]);
    expect(reg.posture.find((p) => p.service === 'store-edge (committed sales)')?.passed).toBe(false);
    expect((await on(again, 'GET', '/v1/platform/dr-drills', 'u-cash')).status).toBe(403);
  });
});
