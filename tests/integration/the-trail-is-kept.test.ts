import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { pgClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import {
  buildRouter, handle, SqlIdempotencyStore, SqlAuditSink, type HttpRequest,
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
  tenant_id: string; user_id: string; method: string; path: string;
  status: number; permission: string; trace_id: string; idempotency_key: string | null;
}

describe.skipIf(!DATABASE_URL)('the audit trail is actually kept (real PostgreSQL)', () => {
  let client: Client;
  let kernel: Parameters<typeof handle>[0];
  const failures: string[] = [];

  const rows = async (): Promise<readonly AuditRow[]> => (await client.query<AuditRow>(
    'SELECT * FROM audit_log WHERE tenant_id = $1 ORDER BY seq ASC', [TENANT],
  )).rows;

  beforeAll(async () => {
    client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    const sql = pgClient(client);
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
      audit: new SqlAuditSink(sql, (d) => failures.push(d)),
      newTraceId: () => `trace-${RUN}`,
    };
  });

  afterAll(async () => { await client.end(); });

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

    const anon = (await client.query<AuditRow>(
      "SELECT * FROM audit_log WHERE tenant_id = 'unauthenticated' AND trace_id = $1", [`trace-${RUN}`],
    )).rows;
    expect(anon.length).toBeGreaterThan(0);
  });

  it('cannot be edited or deleted, at the database (hard rule #6)', async () => {
    // The entry that says who did it is the one somebody would want to change.
    await expect(client.query('UPDATE audit_log SET user_id = $1 WHERE tenant_id = $2', ['somebody-else', TENANT]))
      .rejects.toThrow(/append-only/i);
    await expect(client.query('DELETE FROM audit_log WHERE tenant_id = $1', [TENANT]))
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
