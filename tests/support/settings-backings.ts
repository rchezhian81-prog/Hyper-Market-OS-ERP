// The two backings a test runs head office on when it also needs the tenant SETTINGS to survive a cold restart (the
// owner's approval rules and high-impact settings live in `config_versions`, not on the event ledger): the in-memory
// stores, and — with DATABASE_URL — real PostgreSQL over the same migrations production runs. `harness()` again over the
// same backing is the cold restart: a fresh head office, nothing carried in memory but what the stores hold.

import { beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from './api-harness';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { InMemoryConfigVersionStore, SqlConfigVersionStore } from '../../packages/persistence/src/config-store';
import { DurableTenantSettings } from '../../packages/tenant/src/durable-settings';

export interface SettingsBacking { readonly harness: () => ApiHarness }

export function useSettingsBackings(): readonly { readonly name: string; readonly make: () => SettingsBacking }[] {
  const DATABASE_URL = process.env['DATABASE_URL'];
  let pool: Pool | undefined;
  beforeAll(async () => {
    if (DATABASE_URL === undefined) return;
    pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
    const dir = 'db/migrations';
    await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
  });
  afterAll(async () => { await pool?.end(); });
  const out: { name: string; make: () => SettingsBacking }[] = [{
    name: 'the in-memory stores',
    make: () => {
      const settings = new DurableTenantSettings(new InMemoryConfigVersionStore());
      const first = apiHarness({ settings });
      let used = false;
      return { harness: () => { if (!used) { used = true; return first; } return apiHarness({ store: first.store, settings }); } };
    },
  }];
  if (DATABASE_URL !== undefined) {
    out.push({
      name: 'real PostgreSQL',
      make: () => ({
        harness: () => {
          // A fresh event store, idempotency store and settings store on every call: nothing carried across the "restart".
          const sql = pgPoolClient(pool!);
          return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql), settings: new DurableTenantSettings(new SqlConfigVersionStore(sql)) });
        },
      }),
    });
  }
  return out;
}
