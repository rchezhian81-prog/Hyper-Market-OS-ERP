import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { TenantNotRegisteredError } from '../../packages/persistence/src/tenants';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { makeEvent } from '../../packages/contracts/src/event';
import { ensureAppRole, asRole } from '../support/db-app-role';

/**
 * **A tenant nobody provisioned cannot accumulate rows (GAP-DATA-02, the `tenants` FK half · ADR-0003 · §35 · M36).**
 * Migration 0013 adds the register of provisioned tenants and a FOREIGN KEY from every uuid-keyed tenant table to it.
 * Proven against real PostgreSQL: a write for an unregistered tenant is refused by the database and reported by the
 * store as `TenantNotRegisteredError`; registration is idempotent; once registered the same write lands; the
 * register is row-level-secured like everything else; every uuid tenant table carries the FK and it is VALIDATED.
 *
 * The row-level-security leg connects as a NON-superuser role this suite creates (a superuser bypasses RLS, and the
 * database CI connects as one) via the shared tests/support/db-app-role.ts helper, as row-level-security.test.ts does.
 *
 * Set DATABASE_URL to run; without it the suite skips rather than passing quietly.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const APP_ROLE = 'sre_tenants_app';
const RUN = `tenants-${Date.now().toString(36)}`;
const hex = Date.now().toString(16).slice(-7);
const REGISTERED = `1${hex}-1111-4111-8111-111111111111`;
const UNKNOWN = `2${hex}-2222-4222-8222-222222222222`;
const AT = new Date(Date.now() - 60_000).toISOString();
const ev = (id: string) => makeEvent({ id: `${RUN}-${id}`, type: 'SaleCommitted', occurredAt: AT, idempotencyKey: `${RUN}-${id}`, source: 'api/pos', payload: { note: id } });

const describeOrSkip = DATABASE_URL ? describe : describe.skip;

describeOrSkip('the tenants register and its foreign keys (migration 0013)', () => {
  let platform: Pool;
  let store: SqlEventStore;
  const stream = `${RUN}/sales`;

  beforeAll(async () => {
    platform = new Pool({ connectionString: DATABASE_URL, max: 2, options: '-c app.tenant_id=*' });
    const dir = 'db/migrations';
    await runMigrations(pgPoolClient(platform), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
      .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
    store = new SqlEventStore(pgPoolClient(platform));
    // The application's role for the RLS leg: no superuser, no BYPASSRLS, ordinary table privileges.
    await ensureAppRole(platform, APP_ROLE);
  });
  afterAll(async () => { await platform?.end(); });

  it('a write for a tenant nobody registered is refused by the DATABASE, and the store says so by name', async () => {
    await expect(store.append(UNKNOWN, stream, ev('u1'))).rejects.toBeInstanceOf(TenantNotRegisteredError);
    await expect(store.append(UNKNOWN, stream, ev('u1'))).rejects.toThrow(/not registered/);
    const rows = await platform.query('SELECT count(*)::int AS n FROM event_ledger WHERE tenant_id = $1', [UNKNOWN]);
    expect(rows.rows[0]!['n']).toBe(0);
    // The register itself does not know it either.
    expect((await platform.query('SELECT 1 FROM tenants WHERE tenant_id = $1', [UNKNOWN])).rowCount).toBe(0);
  });

  it('registering is an explicit, idempotent act that records who did it; the same write then lands', async () => {
    await store.registerTenant(REGISTERED, 'test:provisioning');
    await store.registerTenant(REGISTERED, 'test:provisioning-again'); // a second registration changes nothing
    const reg = await platform.query('SELECT registered_by FROM tenants WHERE tenant_id = $1', [REGISTERED]);
    expect(reg.rows).toEqual([{ registered_by: 'test:provisioning' }]);
    const r = await store.append(REGISTERED, stream, ev('r1'));
    expect(r.deduped).toBe(false);
    expect((await store.readStream(REGISTERED, stream)).map((e) => e.event.id)).toEqual([`${RUN}-r1`]);
  });

  it('the other uuid-keyed tenant tables refuse an unknown tenant too (idempotency keys, number series, config)', async () => {
    await expect(platform.query('INSERT INTO idempotency_keys (tenant_id, key, request_hash, status, body) VALUES ($1, $2, $3, 200, $4)', [UNKNOWN, `${RUN}-k`, 'h', '{}']))
      .rejects.toThrow(/foreign key|tenant_fk/i);
    await expect(platform.query('INSERT INTO number_series (tenant_id, doc_type, next_seq) VALUES ($1, $2, 2)', [UNKNOWN, `${RUN}-doc`]))
      .rejects.toThrow(/foreign key|tenant_fk/i);
    await expect(platform.query(`INSERT INTO config_versions (tenant_id, config_key, version, value, author, reason, effective_at) VALUES ($1, $2, 1, '"x"'::jsonb, 'a', 'r', now())`, [UNKNOWN, `${RUN}-key`]))
      .rejects.toThrow(/foreign key|tenant_fk/i);
  });

  it('every uuid tenant table carries a VALIDATED foreign key to the register; the text-keyed tables do not', async () => {
    const r = await platform.query(
      `SELECT conrelid::regclass::text AS tbl, convalidated FROM pg_constraint WHERE conname LIKE '%_tenant_fk' ORDER BY 1`,
    );
    const byTable = new Map(r.rows.map((row) => [String(row['tbl']), Boolean(row['convalidated'])]));
    for (const t of ['event_ledger', 'sync_outbox', 'config_versions', 'idempotency_keys', 'number_series', 'write_guards']) {
      expect(byTable.get(t), `${t} carries a validated tenant FK`).toBe(true);
    }
    expect(byTable.has('audit_log')).toBe(false);
    expect(byTable.has('projection_snapshot')).toBe(false);
  });

  it('the register is row-level-secured: a tenant scope sees only itself; no scope sees nothing', async () => {
    const app = new Pool({ connectionString: asRole(DATABASE_URL!, APP_ROLE), max: 1 });
    try {
      expect((await app.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user')).rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
      const own = new SqlEventStore(pgPoolClient(app));
      await own.registerTenant(REGISTERED, 'ignored — already registered'); // allowed for one's own tenant
      const conn = await app.connect();
      try {
        await conn.query('BEGIN');
        await conn.query("SELECT set_config('app.tenant_id', $1, true)", [REGISTERED]);
        expect((await conn.query('SELECT count(*)::int AS n FROM tenants')).rows[0]!['n']).toBe(1);
        await conn.query('COMMIT');
      } finally { conn.release(); }
      const c2 = await app.connect();
      try {
        expect((await c2.query('SELECT count(*)::int AS n FROM tenants')).rows[0]!['n']).toBe(0);
      } finally { c2.release(); }
    } finally { await app.end(); }
  });
});
