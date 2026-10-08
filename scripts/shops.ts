// The shops, read and changed ON THE SERVER by a named person (OB-15-d-3 · owner decision OB-21 "A").
//
//   pnpm run shop:list     -- [--env-file infra/compose/.env]
//   pnpm run shop:features -- --tenant <uuid> --operator <yourName> [--on f1,f2] [--off f3] [--dry-run] [--env-file …]
//
// The wall between shops stays (db/migrations/0012): head office's online system never looks across shops. Only the
// LIST of shops is read across them — from the `tenants` table, under the platform scope a person at the server sets,
// like the backup does — and every shop's own details are then read in that shop's own scope. A change of features is
// written to ONE shop, in its own scope, as the same record head office's own feature switch writes, with the name of
// the person who made it. The logic is tested in services/platform/src/shop-directory.ts.

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { SqlEventStore } from '../packages/persistence/src/event-store';
import { pgPoolClient } from '../packages/persistence/src/pg-client';
import { makeEvent } from '../packages/contracts/src/event';
import { STREAM, PLATFORM_BILLING_STREAM } from '../services/api/src/adapters';
import { shopLine, renderShopList, planFeatureChange, type ShopEvent, type TenantRow } from '../services/platform/src/shop-directory';
import { parseEnvText, parseFlags } from './lib/operator-env';

const out = (s = ''): void => { process.stdout.write(`${s}\n`); };
const command = process.argv[2];
const flags = parseFlags(process.argv.slice(3));
const str = (k: string): string => (typeof flags[k] === 'string' ? (flags[k] as string).trim() : '');
const list = (k: string): string[] => str(k).split(',').map((s) => s.trim()).filter((s) => s !== '');

if (command !== 'list' && command !== 'features') {
  out('Usage: pnpm run shop:list -- [--env-file PATH]');
  out('       pnpm run shop:features -- --tenant <uuid> --operator <yourName> [--on f1,f2] [--off f3] [--dry-run] [--env-file PATH]');
  process.exit(2);
}

const envFile = str('env-file') !== '' ? resolve(str('env-file')) : join(process.cwd(), 'infra', 'compose', '.env');
const env: Readonly<Record<string, string>> = existsSync(envFile) ? parseEnvText(readFileSync(envFile, 'utf8')) : {};
const databaseUrl = env['DATABASE_URL'];
if (databaseUrl === undefined || databaseUrl === '') {
  // The env FILE is the box — the process environment is deliberately not consulted (see bootstrap-tenant.ts).
  out(`DATABASE_URL is not in the env file (${envFile}) — cannot reach the ledger. Nothing was read or written.`);
  process.exit(2);
}

/** Every registered shop — the ONE read across shops, under the platform scope a person at the server sets. */
async function registeredShops(): Promise<TenantRow[]> {
  const platform = new Pool({ connectionString: databaseUrl, max: 1, options: '-c app.tenant_id=*' });
  try {
    const res = await platform.query('SELECT tenant_id::text AS id, registered_at, registered_by FROM tenants ORDER BY registered_at');
    return res.rows.map((r: { id: string; registered_at: Date; registered_by: string }) => ({ tenantId: r.id, registeredAt: new Date(r.registered_at).toISOString(), registeredBy: r.registered_by }));
  } finally {
    await platform.end().catch(() => undefined);
  }
}

/** One shop's details — read in THAT shop's own scope. */
async function detailsOf(store: SqlEventStore, tenantId: string): Promise<ShopEvent[]> {
  const read = async (stream: string): Promise<ShopEvent[]> =>
    (await store.readStream(tenantId, stream, {})).map((e) => ({ type: e.event.type, payload: e.event.payload as Record<string, unknown>, occurredAt: e.event.occurredAt }));
  return [...await read(STREAM.platform), ...await read(PLATFORM_BILLING_STREAM)]
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
}

async function main(): Promise<void> {
  const db = new Pool({ connectionString: databaseUrl, max: 2 });
  const store = new SqlEventStore(pgPoolClient(db));
  try {
    const shops = await registeredShops();
    if (command === 'list') {
      const lines = [];
      for (const row of shops) lines.push(shopLine(row, await detailsOf(store, row.tenantId)));
      for (const l of renderShopList(lines)) out(l);
      process.exit(0);
    }

    const tenantId = str('tenant');
    const row = shops.find((s) => s.tenantId === tenantId);
    const current = row === undefined ? [] : shopLine(row, await detailsOf(store, tenantId)).featuresOn;
    const plan = planFeatureChange({
      tenantId, on: list('on'), off: list('off'), operator: str('operator'), targetKind: env['MIGRATION_TARGET_KIND'],
      knownShops: shops.map((s) => s.tenantId), currentlyOn: current,
    });
    if (!plan.ok) {
      out('NOT CHANGED — nothing was written:');
      for (const p of plan.problems) out(`  • ${p}`);
      process.exit(1);
    }
    for (const c of plan.changes) out(`  ${c.enabled ? 'turn ON ' : 'turn OFF'} ${c.feature}`);
    for (const f of plan.unchanged) out(`  already so: ${f}`);
    if (plan.changes.length === 0) { out('Nothing to change.'); process.exit(0); }
    if (flags['dry-run'] === true) { out('DRY RUN — nothing was written.'); process.exit(0); }
    const by = `operator:${str('operator')}`;
    for (const c of plan.changes) {
      const at = new Date().toISOString();
      await store.append(tenantId, STREAM.platform, makeEvent({
        id: `entitlement-${c.feature}-${at}`, type: 'TenantEntitlementSet', occurredAt: at,
        idempotencyKey: `entitlement-${tenantId}-${c.feature}-${at}`, source: 'operator/shop-features',
        payload: { feature: c.feature, enabled: c.enabled, at, by },
      }));
    }
    const after = shopLine(row!, await detailsOf(store, tenantId)).featuresOn;
    out(`CHANGED — recorded in shop ${tenantId}'s own history by ${str('operator')}. Features on now: ${after.length === 0 ? 'none' : after.join(', ')}.`);
    process.exit(0);
  } catch (e) {
    out(`Could not reach the ledger: ${e instanceof Error ? e.message : String(e)}. Nothing was written.`);
    process.exit(2);
  } finally {
    await db.end().catch(() => undefined);
  }
}

await main();
