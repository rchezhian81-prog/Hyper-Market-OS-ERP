import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, TEST_IDP } from '../support/api-harness';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { runMigrations } from '../../packages/persistence/src/migrations';
import {
  SqlIdempotencyStore, SqlAuditSink, TokenBucketRateLimiter, AuditedRefusalTally, parseRefusalTallyRow, type AuditSink,
} from '../../services/kernel/src/index';


/** The tally, built where the kernel has one (before the fix it had none: then nothing is tallied and every refusal is written). */
const tallyOver = (sink: AuditSink, cfg: { windowSeconds: number; maxKeys: number }, now: () => number): AuditedRefusalTally =>
  typeof AuditedRefusalTally === 'function' ? new AuditedRefusalTally(sink, cfg, now) : ({ flush: async () => {} } as unknown as AuditedRefusalTally);
const parse = (r: { readonly path: string; readonly permission: string }) => (typeof parseRefusalTallyRow === 'function' ? parseRefusalTallyRow(r) : undefined);

/**
 * **Audit 27 Nov 2026, item 2 — through the REAL head-office router: the per-address limit runs before the route is
 * looked up, and anonymous refusals are counted rather than written one row each — in memory and on PostgreSQL.**
 *
 * Kept on the record exactly as before (hard rule 6, M02 "every login … audited", M34-FR-01): every refusal of a signed-in
 * person, and every refused sign-in (a token presented and not believed). Counted, never dropped: a 404 for a path that
 * does not exist and a 401 for a call that carried no sign-in at all — the first of each kind at once, the rest as one row
 * with the count. A count of anonymous junk is the evidence; a database write per junk request is the attack.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const T = 'ab000000-0000-4000-8000-00000000a273';
type Row = Parameters<AuditSink['record']>[0];

describe('audit 27 Nov item 2 — real router, in memory', () => {
  it('an unknown path spends the per-address allowance: 429 once it is spent', async () => {
    const h = apiHarness({ rateLimit: new TokenBucketRateLimiter({ capacity: 4, refillPerSecond: 0.0001 }, () => 0) });
    for (let i = 0; i < 4; i += 1) expect((await h.raw({ method: 'GET', path: `/v1/does-not-exist-${i}`, clientIp: '203.0.113.9' })).status).toBe(404);
    expect((await h.raw({ method: 'GET', path: '/v1/does-not-exist-9', clientIp: '203.0.113.9' })).status).toBe(429);
  });

  it('200 anonymous refusals are counted (two rows now, the rest as counts); a forged sign-in is a row of its own', async () => {
    let nowMs = 5_000_000;
    const rows: Row[] = [];
    const sink: AuditSink = { record: (r) => { rows.push(r); } };
    const refusalTally = tallyOver(sink, { windowSeconds: 60, maxKeys: 1000 }, () => nowMs);
    const h = apiHarness({ audit: sink, refusalTally });
    await h.seedOwner(T, 'u-owner');
    for (let i = 0; i < 100; i += 1) expect((await h.raw({ method: 'GET', path: `/v1/scan-${i}`, clientIp: '203.0.113.9' })).status).toBe(404);
    for (let i = 0; i < 100; i += 1) expect((await h.raw({ method: 'GET', path: '/v1/identity/me', clientIp: '203.0.113.9' })).status).toBe(401);
    expect(rows).toHaveLength(2);
    // A forged sign-in: its own row (a refused login is evidence on its own).
    const forged = TEST_IDP.withDifferentKey('x'.repeat(40)).issue({ sub: 'u-owner', tenantId: T });
    expect((await h.raw({ method: 'GET', path: '/v1/identity/me', token: forged, clientIp: '203.0.113.9' })).status).toBe(401);
    expect(rows).toHaveLength(3);
    nowMs += 61_000;
    await refusalTally.flush();
    expect(rows.map((r) => parse(r)?.count ?? 1).reduce((a, b) => a + b, 0)).toBe(201);
  });
});

describe.skipIf(!DATABASE_URL)('audit 27 Nov item 2 — on PostgreSQL, in the real audit_log', () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 4, options: '-c app.tenant_id=*' });
    const dir = 'db/migrations';
    await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(`${dir}/${name}`, 'utf8') })));
  }, 120_000);
  afterAll(async () => { await pool.end(); });

  it('the anonymous flood is a few chained rows whose counts add up; signed-in refusals stay one row each', async () => {
    const sql = pgPoolClient(pool);
    const run = `a27i2-${randomUUID()}`;
    let nowMs = 9_000_000;
    const failures: string[] = [];
    const sink = new SqlAuditSink(sql, (d) => { failures.push(d); });
    const refusalTally = tallyOver(sink, { windowSeconds: 60, maxKeys: 1000 }, () => nowMs);
    const tenant = randomUUID();
    const h = apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql), audit: sink, refusalTally });
    await h.seedOwner(tenant, 'u-owner');
    await h.provisionRole(tenant, 'u-cashier', 'cashier');
    const trace = (n: string) => ({ 'x-correlation-id': `${run}-${n}` });

    for (let i = 0; i < 60; i += 1) expect((await h.raw({ method: 'GET', path: `/v1/scan-${i}`, clientIp: '198.51.100.20', headers: trace(`404-${i}`) })).status).toBe(404);
    for (let i = 0; i < 60; i += 1) expect((await h.raw({ method: 'GET', path: '/v1/identity/me', clientIp: '198.51.100.20', headers: trace(`401-${i}`) })).status).toBe(401);
    // A signed-in cashier reaching for the security report three times: three rows, under her name.
    const cashier = TEST_IDP.issue({ sub: 'u-cashier', tenantId: tenant });
    for (let i = 0; i < 3; i += 1) expect((await h.raw({ method: 'GET', path: '/v1/reports/security', token: cashier, clientIp: '198.51.100.20', headers: trace(`403-${i}`) })).status).toBe(403);

    const anonymousRows = async () => (await pool.query<{ path: string; status: number; trace_id: string; user_id: string; tenant_id: string; method: string; permission: string }>(
      'SELECT tenant_id, user_id, method, path, status, permission, trace_id FROM audit_log WHERE tenant_id = $1 AND trace_id LIKE $2 ORDER BY seq', ['unauthenticated', `${run}-%`])).rows;
    expect((await anonymousRows()).length, 'only the first of each kind while the window is open').toBe(2);

    nowMs += 61_000;
    await refusalTally.flush();
    const rows = await anonymousRows();
    expect(rows.length).toBe(4);
    const counts = rows.map((r) => parse({ path: r.path, permission: r.permission })?.count ?? 1);
    expect(counts.reduce((a, b) => a + b, 0), 'all 120 refusals are on the record').toBe(120);

    const signedIn = await pool.query('SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1 AND user_id = $2 AND status = 403 AND trace_id LIKE $3', [tenant, 'u-cashier', `${run}-403-%`]);
    expect(signedIn.rows[0].n).toBe(3);
    expect(failures).toEqual([]);
  }, 120_000);
});
