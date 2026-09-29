import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { makeEvent } from '../../packages/contracts/src/event';
import { ensureAppRole, asRole } from '../support/db-app-role';

/**
 * **Tenant isolation is enforced by the DATABASE, not only by the application (GAP-DATA-02 · ADR-0003 · §35 ·
 * OB-01).** Migration 0012 puts row-level security on every tenant-scoped table, keyed on a per-transaction
 * `app.tenant_id` the application sets from the SIGNED token. Proven here against real PostgreSQL, as the table
 * OWNER (the role the application connects as — `FORCE ROW LEVEL SECURITY` binds it too):
 *
 *   • with NO scope set, a query that forgets its tenant filter sees NOTHING and can write nothing (fail closed);
 *   • under tenant A's scope, `SELECT * FROM event_ledger` with no filter at all returns only A's rows;
 *   • an INSERT for tenant B under A's scope is refused by the database;
 *   • the platform scope `'*'` (operator tools only) sees every row;
 *   • the SqlEventStore, through `pgPoolClient(...).forTenant`, needs no help — and cannot be tricked into another
 *     tenant's rows by a caller that passes the wrong tenant to a read.
 *
 * Set DATABASE_URL to run; without it the suite skips rather than passing quietly.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const RUN = `rls-${Date.now().toString(36)}`;
/**
 * PostgreSQL SUPERUSERS bypass row-level security entirely, and the database CI (and many a local setup) connects as
 * one. So the "application" here connects as a NON-superuser role this suite creates — the role the deployment gives
 * the API (`infra/compose/db-init`); `main.ts` refuses to start on a superuser for exactly this reason.
 */
const APP_ROLE = 'sre_rls_app';
const hex = Date.now().toString(16).slice(-7);
const A = `a${hex}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
const B = `b${hex}-bbbb-4bbb-8bbb-bbbbbbbbbbbb`;
const AT = new Date(Date.now() - 60_000).toISOString();

const ev = (id: string) => makeEvent({ id: `${RUN}-${id}`, type: 'SaleCommitted', occurredAt: AT, idempotencyKey: `${RUN}-${id}`, source: 'api/pos', payload: { note: id } });

const describeOrSkip = DATABASE_URL ? describe : describe.skip;

describeOrSkip('row-level security isolates tenants in the database itself (migration 0012)', () => {
  // The application's pool: NO session scope. Every statement is scoped per transaction by `forTenant`, exactly as
  // main.ts composes it. Raw statements on this pool run with no scope at all — which is the point of the test.
  let app: Pool;
  // The operator's pool: the platform scope, as backup / restore / migration tools set it explicitly.
  let platform: Pool;
  let store: SqlEventStore;
  const stream = `${RUN}/sales`;

  beforeAll(async () => {
    // The owner's connection (the CI superuser): migrates, and reads as the platform scope for the checks.
    platform = new Pool({ connectionString: DATABASE_URL, max: 2, options: '-c app.tenant_id=*' });
    const dir = 'db/migrations';
    await runMigrations(pgPoolClient(platform), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
      .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
    // The application's role: no superuser, no BYPASSRLS, ordinary table privileges — bound by the policies.
    await ensureAppRole(platform, APP_ROLE);
    app = new Pool({ connectionString: asRole(DATABASE_URL!, APP_ROLE), max: 4 });
    store = new SqlEventStore(pgPoolClient(app));
    await store.registerTenant(A, 'tests'); // a tenant may register itself under its own scope (db/migrations/0013)
    await store.registerTenant(B, 'tests');
    await store.append(A, stream, ev('a1'));
    await store.append(A, stream, ev('a2'));
    await store.append(B, stream, ev('b1'));
  });

  afterAll(async () => { await app?.end(); await platform?.end(); });

  const count = async (pool: Pool, tenant?: string): Promise<number> => {
    const conn = await pool.connect();
    try {
      await conn.query('BEGIN');
      if (tenant !== undefined) await conn.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
      const r = await conn.query('SELECT count(*)::int AS n FROM event_ledger WHERE stream = $1', [stream]);
      await conn.query('COMMIT');
      return Number(r.rows[0]!['n']);
    } finally { conn.release(); }
  };

  it('with NO scope set, a query that forgets its tenant filter sees nothing — fail closed', async () => {
    expect(await count(app)).toBe(0);
    expect(await count(platform)).toBe(3); // the same rows ARE there — the platform scope sees them
  });

  it('under tenant A, an unfiltered read returns only A’s rows; under B, only B’s', async () => {
    expect(await count(app, A)).toBe(2);
    expect(await count(app, B)).toBe(1);
  });

  it('an INSERT for tenant B under tenant A’s scope is REFUSED by the database', async () => {
    const conn = await app.connect();
    try {
      await conn.query('BEGIN');
      await conn.query("SELECT set_config('app.tenant_id', $1, true)", [A]);
      await expect(conn.query(
        `INSERT INTO event_ledger (id, tenant_id, stream, type, occurred_at, idempotency_key, source, version, payload)
         VALUES ($1, $2, $3, 'SaleCommitted', $4, $5, 'api/pos', 1, '{}'::jsonb)`,
        [`${RUN}-smuggled`, B, stream, AT, `${RUN}-smuggled`],
      )).rejects.toThrow(/row-level security/i);
      await conn.query('ROLLBACK');
    } finally { conn.release(); }
    expect(await count(platform)).toBe(3); // nothing landed
  });

  it('with NO scope, an INSERT is refused too — a connection nobody scoped cannot write anything', async () => {
    await expect(app.query(
      `INSERT INTO event_ledger (id, tenant_id, stream, type, occurred_at, idempotency_key, source, version, payload)
       VALUES ($1, $2, $3, 'SaleCommitted', $4, $5, 'api/pos', 1, '{}'::jsonb)`,
      [`${RUN}-unscoped`, A, stream, AT, `${RUN}-unscoped`],
    )).rejects.toThrow(/row-level security/i);
  });

  it('the SqlEventStore scopes every statement itself: A reads A, B reads B, and a whole-tenant export never widens', async () => {
    expect((await store.readStream(A, stream)).map((e) => e.event.id).sort()).toEqual([`${RUN}-a1`, `${RUN}-a2`]);
    expect((await store.readStream(B, stream)).map((e) => e.event.id)).toEqual([`${RUN}-b1`]);
    expect((await store.exportTenant(A)).filter((e) => e.stream === stream)).toHaveLength(2);
    // The atomic batch path (one transaction) is scoped the same way.
    const results = await store.appendBatch(B, [{ stream, event: ev('b2') }, { stream, event: ev('b3') }]);
    expect(results.map((r) => r.deduped)).toEqual([false, false]);
    expect(await count(app, B)).toBe(3);
    expect(await count(app, A)).toBe(2);
  });

  it('the application role is neither superuser nor BYPASSRLS — the only kind of role the policies bind', async () => {
    const r = await app.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
    expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it('the other tenant-scoped tables carry the same policy', async () => {
    const r = await platform.query(
      `SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY c.relname`,
    );
    const byTable = new Map(r.rows.map((row) => [String(row['relname']), { rls: Boolean(row['rls']), forced: Boolean(row['forced']) }]));
    for (const t of ['event_ledger', 'sync_outbox', 'config_versions', 'idempotency_keys', 'number_series', 'audit_log', 'projection_snapshot']) {
      expect(byTable.get(t), t).toEqual({ rls: true, forced: true });
    }
    expect(byTable.get('schema_migrations')).toEqual({ rls: false, forced: false }); // carries no tenant
  });
});
