// Create a NEW shop, on the server, with one guided command (OB-15-d-2 · owner decision OB-20 "A").
//
//   pnpm run shop:new -- --name "<Shop name>" --owner <userId> --operator <yourName>
//                        --realm sre-<shop> --origin https://<the shop's address>
//                        [--tenant <uuid>] [--admin <userId>:<roleId>[,…]] [--out <file>] [--dry-run]
//                        [--env-file infra/compose/.env] [--demo-tenant <uuid>]
//
// Everything is checked FIRST (services/platform/src/new-shop.ts): the tested tenant-bootstrap rules (never a production
// box, never the demo shop, an owner, a named operator, known roles) and the shop's realm file (OB-19). Only then, in
// order: the shop and its first owner recorded in one atomic append; its name, realm and address on the platform's
// record; its realm file written for the administrator to load. Then the next steps, printed. A shop that already
// exists is left untouched. No identity-server key is held or used (OB-19).

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { SqlEventStore } from '../packages/persistence/src/event-store';
import { pgPoolClient } from '../packages/persistence/src/pg-client';
import { makeEvent } from '../packages/contracts/src/event';
import { seedInitialAdmins } from '../services/api/src/access';
import { STREAM } from '../services/api/src/adapters';
import { OWNER_ROLE_ID, ROLE_CATALOGUE } from '../services/api/src/roles';
import { planNewShop, nextSteps } from '../services/platform/src/new-shop';
import { parseEnvText, parseFlags, demoTenantIds } from './lib/operator-env';

const out = (s = ''): void => { process.stdout.write(`${s}\n`); };

function usage(): never {
  out('Usage: pnpm run shop:new -- --name "<Shop name>" --owner <userId> --operator <yourName> --realm sre-<shop> --origin https://<address>');
  out('                            [--tenant <uuid>] [--admin u:role[,u:role]] [--out <file>] [--dry-run] [--env-file PATH]');
  out();
  out(`  Roles the catalogue knows: ${ROLE_CATALOGUE.map((r) => r.id).join(', ')}`);
  process.exit(2);
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const str = (k: string): string => (typeof flags[k] === 'string' ? (flags[k] as string).trim() : '');
  if (str('name') === '' || str('owner') === '' || str('realm') === '' || str('origin') === '' || flags['help'] !== undefined) usage();
  const dryRun = flags['dry-run'] === true;
  const tenantId = str('tenant') || randomUUID();

  const envFile = str('env-file') !== '' ? resolve(str('env-file')) : join(process.cwd(), 'infra', 'compose', '.env');
  let env: Readonly<Record<string, string>> = {};
  if (existsSync(envFile)) env = parseEnvText(readFileSync(envFile, 'utf8'));
  else out(`Note: no env file at ${envFile} — MIGRATION_TARGET_KIND treated as unset (rehearsal).`);

  const plan = planNewShop({
    tenantId, name: str('name'), owner: str('owner'), operator: str('operator'), realm: str('realm'), webOrigin: str('origin'),
    audience: str('audience') || env['IDP_AUDIENCE'] || 'sre-retail-os-api', allowHttp: flags['allow-http'] === true,
    admins: str('admin').split(',').map((s) => s.trim()).filter((s) => s !== '')
      .map((pair) => { const [userId = '', roleId = ''] = pair.split(':'); return { userId: userId.trim(), roleId: roleId.trim() }; }),
    targetKind: env['MIGRATION_TARGET_KIND'], demoTenantIds: demoTenantIds(env, flags['demo-tenant']),
    knownRoleIds: ROLE_CATALOGUE.map((r) => r.id), ownerRoleId: OWNER_ROLE_ID,
    realmTemplate: JSON.parse(readFileSync(resolve(process.cwd(), 'infra/keycloak/realm-sre-store.json'), 'utf8')) as Record<string, unknown>,
  });
  if (!plan.ok) {
    out('NOT CREATED — nothing was written:');
    for (const p of plan.problems) out(`  • ${p}`);
    process.exit(1);
  }
  const file = resolve(process.cwd(), str('out') || `realm-${plan.shop.realm}.json`);
  if (existsSync(file)) {
    out(`NOT CREATED — ${file} already exists. Move it away or name another --out. Nothing was written.`);
    process.exit(1);
  }

  out(`Shop "${plan.shop.name}" — ${plan.shop.tenantId}`);
  out(`  sign-in area ${plan.shop.realm}, address ${plan.shop.webOrigin}`);
  out(`  created by ${plan.shop.createdBy}; first people:`);
  for (const a of plan.bootstrap.admins) out(`    • ${a.userId} as ${a.roleId}`);
  if (dryRun) { out('DRY RUN — nothing was written.'); process.exit(0); }

  // The env FILE is the box — the process environment is deliberately not consulted (see bootstrap-tenant.ts).
  const databaseUrl = env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl === '') {
    out(`DATABASE_URL is not in the env file (${envFile}) — cannot reach the ledger. Nothing was written.`);
    process.exit(2);
  }
  const db = new Pool({ connectionString: databaseUrl, max: 2 });
  try {
    const store = new SqlEventStore(pgPoolClient(db));
    const at = new Date().toISOString();
    const seeded = await seedInitialAdmins(store, plan.bootstrap.tenantId, plan.bootstrap.admins, plan.bootstrap.operator, at);
    if (seeded.outcome === 'already_bootstrapped') {
      out(`NOT CHANGED — shop ${plan.bootstrap.tenantId} already exists with people in it. A shop is never re-created over itself. Nothing was written.`);
      process.exit(1);
    }
    await store.append(plan.bootstrap.tenantId, STREAM.platform, makeEvent({
      id: `shop-registered-${plan.bootstrap.tenantId}`, type: 'ShopRegistered', occurredAt: at,
      idempotencyKey: `shop-registered-${plan.bootstrap.tenantId}`, source: `operator:${plan.bootstrap.operator}`,
      payload: { ...plan.shop, at },
    }));
    writeFileSync(file, `${JSON.stringify(plan.realmFile, null, 2)}\n`, { mode: 0o600 });
    out(`CREATED — the shop and its ${seeded.granted} first grant(s) recorded; its sign-in area file written to ${file}.`);
    out();
    out('Next, in order:');
    nextSteps(plan.shop, plan.bootstrap.admins[0]!.userId, file).forEach((s, i) => out(`  ${i + 1}. ${s}`));
    process.exit(0);
  } catch (e) {
    out(`Could not write to the ledger: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  } finally {
    await db.end().catch(() => undefined);
  }
}

await main();
