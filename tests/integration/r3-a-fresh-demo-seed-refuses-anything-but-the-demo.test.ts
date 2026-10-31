// Round 3 (screen gap audit, Round C · #852's corrected stock counts): the documented, repeatable FRESH SEED of the demo
// copy — refused, by name and before anything changes, for anything that is not the demo; and when it does run, the old
// ledger is KEPT under a retired name, never dropped (hard rules #2, #6, #7). On a REAL PostgreSQL (DATABASE_URL).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { demoReseedRefusals, tenantsInLedger, retireAndRecreate, grantSchemaToAppRole, retiredNameFor, DEMO_RESEED_CONFIRMATION } from '../../db/seed/pilot/reseed';
import { PILOT_DEMO_TENANT } from '../../db/seed/pilot/dataset';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';

const DATABASE_URL = process.env['DATABASE_URL'];
const DEMO = { tenantId: PILOT_DEMO_TENANT, operator: 'Mr Demo Operator', confirmation: DEMO_RESEED_CONFIRMATION, databaseName: 'sre_pilot', tenantsInLedger: [PILOT_DEMO_TENANT] } as const;

describe('a fresh seed of the demo copy — the refusals (pure)', () => {
  it('the demo copy, confirmed by its own label, by a named person: no refusal', () => {
    expect(demoReseedRefusals(DEMO)).toEqual([]);
    expect(demoReseedRefusals({ ...DEMO, tenantsInLedger: null })).toEqual([]); // an empty, fresh database
  });
  it('refuses another tenant in the settings, a production mark, no operator, no or a wrong confirmation, an odd database name', () => {
    expect(demoReseedRefusals({ ...DEMO, tenantId: randomUUID() }).join(' ')).toMatch(/not the synthetic demo tenant/);
    expect(demoReseedRefusals({ ...DEMO, migrationTargetKind: 'production' }).join(' ')).toMatch(/production/);
    expect(demoReseedRefusals({ ...DEMO, operator: ' ' }).join(' ')).toMatch(/no operator/);
    expect(demoReseedRefusals({ ...DEMO, confirmation: 'yes' }).join(' ')).toMatch(/not confirmed/);
    expect(demoReseedRefusals({ ...DEMO, databaseName: 'x"; DROP DATABASE y; --' }).join(' ')).toMatch(/not a plain name/);
  });
  it('refuses a ledger that holds ANY other tenant, whatever the settings say', () => {
    expect(demoReseedRefusals({ ...DEMO, tenantsInLedger: [PILOT_DEMO_TENANT, randomUUID()] }).join(' ')).toMatch(/other than the demo/);
  });
});

describe.skipIf(DATABASE_URL === undefined)('a fresh seed of the demo copy — on a real PostgreSQL', () => {
  const probe = `r3_reseed_probe_${Date.now().toString(36)}`;
  const at = new Date('2026-10-31T09:15:42.000Z');
  const retired = retiredNameFor(probe, at);
  const server = (db: string): pg.Client => { const u = new URL(DATABASE_URL!); u.pathname = `/${db}`; return new pg.Client({ connectionString: u.toString() }); };
  const admin = server('postgres');

  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE DATABASE "${probe}"`);
    const pool = new pg.Pool({ connectionString: (() => { const u = new URL(DATABASE_URL!); u.pathname = `/${probe}`; return u.toString(); })(), max: 1 });
    const dir = join(process.cwd(), 'db', 'migrations');
    await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
    await pool.end();
  }, 120_000);
  afterAll(async () => {
    for (const db of [probe, retired]) await admin.query(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`); // the test's own scratch copies
    await admin.end();
  });

  const writeEvent = async (tenant: string): Promise<void> => {
    const c = server(probe);
    await c.connect();
    try {
      await c.query(`INSERT INTO tenants (tenant_id, registered_by) VALUES ($1, 'test/r3') ON CONFLICT DO NOTHING`, [tenant]);
      await c.query(`INSERT INTO event_ledger (id, tenant_id, stream, type, occurred_at, idempotency_key, source, payload)
        VALUES ($1, $2, 'stock', 'Probe', now(), $3, 'test/r3', '{}'::jsonb)`, [randomUUID(), tenant, randomUUID()]);
    } finally { await c.end(); }
  };
  const tenantsOf = async (db: string): Promise<string[] | null> => { const c = server(db); await c.connect(); try { return await tenantsInLedger(c); } finally { await c.end(); } };

  it('reads the database\'s tenants: the demo only → no refusal; another tenant registered beside it → refused, nothing changed', async () => {
    await writeEvent(PILOT_DEMO_TENANT);
    expect(demoReseedRefusals({ ...DEMO, databaseName: probe, tenantsInLedger: await tenantsOf(probe) })).toEqual([]);
    await writeEvent(randomUUID());
    const refused = demoReseedRefusals({ ...DEMO, databaseName: probe, tenantsInLedger: await tenantsOf(probe) });
    expect(refused.join(' ')).toMatch(/other than the demo/);
    expect((await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [retired])).rows).toHaveLength(0);
  });

  it('when it runs, the old ledger is KEPT under its retired name with every record, and an empty one takes its name', async () => {
    const before = await tenantsOf(probe);
    const name = await retireAndRecreate(admin, { databaseName: probe, appRole: 'no_such_role_here', at });
    expect(name).toBe(retired);
    expect(await tenantsOf(retired)).toEqual(before);   // nothing dropped
    expect(await tenantsOf(probe)).toBeNull();          // a fresh, empty database
    const c = server(probe); await c.connect(); try { await grantSchemaToAppRole(c, 'no_such_role_here'); } finally { await c.end(); }
    // Run twice in the same second: refused, nothing changed — a retired copy is never overwritten.
    await expect(retireAndRecreate(admin, { databaseName: probe, appRole: 'no_such_role_here', at })).rejects.toThrow(/already exists/);
  }, 60_000);
});
