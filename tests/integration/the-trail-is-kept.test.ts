import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { pgClient, pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import {
  buildRouter, handle, SqlIdempotencyStore, SqlAuditSink,
  verifyAuditChain, type ChainedAuditRow, type HttpRequest,
} from '../../services/kernel/src/index';
import { AccessControl } from '../../packages/rbac/src/rbac';
import { buildSurface } from '../../services/api/src/main';

/**
 * **Hard rule #6 protects evidence that must first exist.**
 *
 * The kernel writes an audit entry for every write and every refusal, through an *optional* port —
 * and the composition root never supplied one, so `writeAudit` returned immediately on every
 * request. The rule about never deleting audit evidence was guarding a trail that was never kept.
 *
 * Not a crash, and nothing any test would have shown. The first anybody would know is the day
 * somebody asks who changed a supplier's bank details.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const RUN = `a${Date.now().toString(36)}`;
const TENANT = `6${Date.now().toString(16).slice(-7)}-6666-4666-8666-${'6'.repeat(12)}`;
const KEY = ['the', 'trail', 'is', 'kept', 'signing'].join('-').padEnd(48, '0');
const COMMITTED = new Date(Date.now() - 60_000).toISOString();

const ACCESS = new AccessControl(
  [{ id: 'lane', name: 'Lane', permissions: ['pos.sale.sync'] }],
  [{ userId: 'u-meena', roleId: 'lane', branchScope: 'all' }],
);

interface AuditRow {
  seq: number; tenant_id: string; user_id: string; method: string; path: string;
  status: number; permission: string; trace_id: string; idempotency_key: string | null;
  recorded_at: string | Date; prev_hash: string | null; hash: string | null;
}

describe.skipIf(!DATABASE_URL)('the audit trail is actually kept (real PostgreSQL)', () => {
  let pool: Pool;
  let kernel: Parameters<typeof handle>[0];
  const failures: string[] = [];

  const rows = async (): Promise<readonly AuditRow[]> => (await pool.query<AuditRow>(
    'SELECT * FROM audit_log WHERE tenant_id = $1 ORDER BY seq ASC', [TENANT],
  )).rows;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    const sql = pgClient(pool);
    const dir = 'db/migrations';
    await runMigrations(sql, readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
      .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));

    const built = buildRouter(buildSurface({
      signingKey: KEY, migrationTargetKind: 'rehearsal', store: new SqlEventStore(sql),
    }));
    kernel = {
      router: built.router!,
      authenticate: (token) => (token === 'good'
        ? { tenantId: TENANT, userId: 'u-meena', branchId: 'b-main' } : undefined),
      access: ACCESS,
      idempotency: new SqlIdempotencyStore(sql),
      // The TRANSACTIONAL adapter, as the deployment wires it (main.ts) — so the sink seals each row
      // under a per-tenant advisory lock, exactly the production hash-chain path (audit FND-02).
      audit: new SqlAuditSink(pgPoolClient(pool), (d) => failures.push(d)),
      newTraceId: () => `trace-${RUN}`,
    };
  });

  afterAll(async () => { await pool.end(); });

  const sale = {
    saleId: `${RUN}-S1`, receiptNumber: `${RUN}-R1`, laneId: 'lane-1', cashierId: 'u-meena',
    tradingDay: COMMITTED.slice(0, 10), committedAt: COMMITTED, totalMinor: 64_000,
    currency: 'INR', packVersion: 0,
    lines: [{ productId: 'P1', quantityMinor: 1, uom: 'each', unitPriceMinor: 64_000, lineTotalMinor: 64_000 }],
    tenders: [{ kind: 'cash', amountMinor: 64_000 }],
  };
  const post = (body: unknown, key: string, token = 'good'): HttpRequest => ({
    method: 'POST', path: '/v1/sales', body,
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': key },
  });

  it('records a write, with who did it and under which permission', async () => {
    expect((await handle(kernel, post(sale, `k-${RUN}-1`))).status).toBe(202);

    const entries = await rows();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      user_id: 'u-meena', method: 'POST', path: '/v1/sales',
      status: 202, permission: 'pos.sale.sync', idempotency_key: `k-${RUN}-1`,
    });
    expect(failures).toEqual([]);
  });

  it('records a REFUSAL too — the event an audit trail exists for', async () => {
    // A refused write leaving no trace is the fault this codebase already fixed once inside the
    // kernel. It would have been reintroduced by there being no sink at all.
    const res = await handle(kernel, post({ nonsense: true }, `k-${RUN}-2`));
    expect(res.status).toBe(400);

    const entries = await rows();
    expect(entries).toHaveLength(2);
    expect(entries[1]?.status).toBe(400);
  });

  it('records an attempt by somebody who is not authenticated', async () => {
    // Exactly the kind worth keeping, and the row `event_ledger` could not hold: its tenant_id is
    // a uuid and this caller has no tenant. Here it is text, and 'unauthenticated' is a real value
    // rather than a row that could not be written.
    const res = await handle(kernel, post(sale, `k-${RUN}-3`, 'bad'));
    expect(res.status).toBe(401);

    const anon = (await pool.query<AuditRow>(
      "SELECT * FROM audit_log WHERE tenant_id = 'unauthenticated' AND trace_id = $1", [`trace-${RUN}`],
    )).rows;
    expect(anon.length).toBeGreaterThan(0);
  });

  it('seals each row onto the one before it, and the whole chain verifies (audit FND-02)', async () => {
    // The rows written above now carry a SHA-256 chain: row 1 from the genesis, each next row's
    // prev_hash equal to the previous row's hash. This is what makes a row dropped or edited behind
    // the database DETECTABLE (GAP-SEC-03) — append-only stops edits through the app; the seal
    // catches an out-of-band one.
    const entries = await rows();
    expect(entries.length).toBeGreaterThanOrEqual(2);
    expect(entries[0]?.prev_hash).toBe(''); // genesis
    expect(entries[0]?.hash).toMatch(/^[0-9a-f]{64}$/); // a real SHA-256, hex
    for (let i = 1; i < entries.length; i += 1) {
      expect(entries[i]?.prev_hash).toBe(entries[i - 1]?.hash); // the links join up
    }

    // And the shared verifier — the same one `pnpm verify:audit` runs — agrees the chain is intact.
    const chained: ChainedAuditRow[] = entries.map((r) => ({
      sequence: Number(r.seq), tenantId: r.tenant_id, userId: r.user_id, method: r.method,
      path: r.path, status: Number(r.status), permission: r.permission, traceId: r.trace_id,
      idempotencyKey: r.idempotency_key ?? null, recordedAt: new Date(r.recorded_at).toISOString(),
      prevHash: r.prev_hash!, hash: r.hash!,
    }));
    const result = verifyAuditChain(chained);
    expect(result.intact, JSON.stringify(result.findings)).toBe(true);
    expect(result.recordsChecked).toBe(entries.length);
  });

  it('refuses a forked chain at the database — two rows cannot claim one predecessor', async () => {
    // The unique index on (tenant_id, prev_hash) is the belt-and-suspenders fork guard: even a bug
    // or a race cannot silently branch a tenant's chain. A hand-crafted second genesis row (prev_hash
    // '') for this tenant collides with the real first row and is refused.
    await expect(pool.query(
      `INSERT INTO audit_log (tenant_id, user_id, method, path, status, permission, trace_id, prev_hash, hash)
       VALUES ($1, 'forger', 'POST', '/v1/sales', 202, 'pos.sale.sync', 'trace-forge', '', 'f'||repeat('0',63))`,
      [TENANT],
    )).rejects.toThrow(/duplicate key|unique/i);
  });

  it('cannot be edited or deleted, at the database (hard rule #6)', async () => {
    // The entry that says who did it is the one somebody would want to change.
    await expect(pool.query('UPDATE audit_log SET user_id = $1 WHERE tenant_id = $2', ['somebody-else', TENANT]))
      .rejects.toThrow(/append-only/i);
    await expect(pool.query('DELETE FROM audit_log WHERE tenant_id = $1', [TENANT]))
      .rejects.toThrow(/append-only/i);
    // And it is still there, unchanged.
    expect((await rows())[0]?.user_id).toBe('u-meena');
  });

  it('reports a failed audit write instead of swallowing it — and does NOT fail the request', async () => {
    // This runs after the handler, so the effect has already happened: the sale is banked and the
    // money is in the drawer. Turning a failed audit write into a 500 would tell the till that a
    // sale which succeeded had failed, manufacturing the exact confusion the three-part error
    // exists to prevent. So the request keeps its true answer and the gap becomes loud.
    const seen: string[] = [];
    const broken = new SqlAuditSink(
      { query: () => Promise.reject(new Error('audit table is unreachable')) },
      (d) => seen.push(d),
    );
    await expect(broken.record({
      tenantId: TENANT, userId: 'u-meena', method: 'POST', path: '/v1/sales',
      status: 202, traceId: 'trace-x', permission: 'pos.sale.sync',
    })).resolves.toBeUndefined();

    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('AUDIT NOT WRITTEN');
    expect(seen[0]).toContain('u-meena');
    expect(seen[0]).toContain('trace-x');
  });
});
