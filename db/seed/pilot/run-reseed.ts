// Operator entry point for a FRESH SEED of the hosted DEMO copy (see reseed.ts for why, and what it refuses). Bundled and
// run by `scripts/demo-reseed.mjs`; a PERSON runs it on the demo box, in their own terminal, from the repository root:
//
//   pnpm run demo:reseed -- --operator "<your name>" --this-is-the-demo pilot-demo
//
// The steps, each said before it is done; any step that fails stops the rest (P-08 — never a half-done reseed said done):
//   1. read the box's settings file; refuse anything that is not the demo (the settings AND the ledger's own tenants);
//   2. stop the services that write (api, edge and its relay, the demo front), so nothing writes while the ledger changes;
//   3. KEEP the old ledger: its database is renamed `<name>_retired_<UTC time>` — never dropped (hard rule #6);
//      KEEP the demo store box's old disk: archived to a file under --keep-dir before the box starts empty (its outbox
//      belongs to the retired ledger and must not be replayed into the new one); the bill-number witness is untouched,
//      so no bill number is ever issued twice;
//   4. make an empty database under the old name, with the application role's grants;
//   5. bring the stack up (the migrations run first) and wait for READY.
// It then names what a person runs next — the seed, the catalogue pack and the till PINs — each its own human act (#5).
// Never prints a secret.

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import { demoReseedRefusals, tenantsInLedger, retireAndRecreate, grantSchemaToAppRole } from './reseed';

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq !== -1) out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};

function step(words: string, command: readonly string[], cwd: string): boolean {
  console.log(`→ ${words}`);
  const r = spawnSync(command[0]!, command.slice(1), { cwd, stdio: 'inherit', shell: false });
  if (r.status !== 0) console.error(`✗ ${words} — did not complete (exit ${r.status ?? '?'}). Stopped here; nothing after this step was done.`);
  return r.status === 0;
}

async function main(): Promise<number> {
  const composeDir = arg('compose-dir') ?? 'infra/compose';
  const envFile = arg('env-file') ?? '.env.pilot';
  const project = arg('project') ?? 'sre-pilot';
  const keepDir = arg('keep-dir') ?? '/opt/sre/retired';
  const operator = arg('operator') ?? '';
  const env = parseEnv(readFileSync(`${composeDir}/${envFile}`, 'utf8'));
  const database = env['POSTGRES_DB'] ?? '';
  const connect = (db: string): pg.Client => new pg.Client({
    host: '127.0.0.1', port: Number(env['POSTGRES_PORT'] ?? '5432'), user: env['POSTGRES_USER'], password: env['POSTGRES_PASSWORD'], database: db,
  });

  // 1. The settings, then the ledger itself.
  const ledger = connect(database);
  let tenants: string[] | null;
  try {
    await ledger.connect();
    tenants = await tenantsInLedger(ledger);
  } finally {
    await ledger.end().catch(() => undefined);
  }
  const refusals = demoReseedRefusals({
    tenantId: env['EDGE_TENANT_ID'] ?? '', operator, confirmation: arg('this-is-the-demo') ?? '', databaseName: database, tenantsInLedger: tenants,
    ...(env['MIGRATION_TARGET_KIND'] === undefined ? {} : { migrationTargetKind: env['MIGRATION_TARGET_KIND'] }),
  });
  if (refusals.length > 0) {
    for (const r of refusals) console.error(`REFUSED — ${r}`);
    console.error('Usage: pnpm run demo:reseed -- --operator "<your name>" --this-is-the-demo pilot-demo');
    return 2;
  }
  console.log(`A fresh seed of the DEMO copy (synthetic tenant only), by ${operator}. The old ledger is kept, renamed; nothing is deleted.`);

  const compose = ['docker', 'compose', '-p', project, '-f', 'docker-compose.yml', '-f', 'docker-compose.pilot.yml', '--env-file', envFile];
  // 2. Nothing writes while the ledger changes.
  if (!step('stopping the services that write (api, edge, edge-relay, web, demo-login)', [...compose, 'stop', 'api', 'edge', 'edge-relay', 'web', 'demo-login'], composeDir)) return 1;

  // 3. Keep the store box's old disk as a file, then let it start empty (the witness volume is not touched).
  const stamp = new Date();
  const archive = `edge-data-${stamp.toISOString().replace(/[-:T]/g, '').slice(0, 14)}.tar.gz`;
  if (!step(`keeping the demo store box's old disk as ${keepDir}/${archive}`, ['docker', 'run', '--rm', '-v', `${project}_edge-data:/from:ro`, '-v', `${keepDir}:/to`, 'alpine:3', 'tar', 'czf', `/to/${archive}`, '-C', '/from', '.'], composeDir)) return 1;
  if (!step('removing the edge container so its disk can start empty (the archive above keeps it)', [...compose, 'rm', '-f', 'edge', 'edge-relay'], composeDir)) return 1;
  if (!step('emptying the demo store box\'s disk volume (kept above)', ['docker', 'volume', 'rm', `${project}_edge-data`], composeDir)) return 1;

  // 3–4. Keep the old ledger under its retired name; make an empty one.
  const admin = connect('postgres');
  try {
    await admin.connect();
    const retired = await retireAndRecreate(admin, { databaseName: database, appRole: env['APP_DB_USER'] ?? 'sre_app', at: stamp });
    console.log(`✓ the old ledger is kept as database "${retired}" (renamed, not deleted)`);
  } finally {
    await admin.end().catch(() => undefined);
  }
  const fresh = connect(database);
  try {
    await fresh.connect();
    await grantSchemaToAppRole(fresh, env['APP_DB_USER'] ?? 'sre_app');
  } finally {
    await fresh.end().catch(() => undefined);
  }

  // 5. Up again — the migrations run first on the empty database.
  if (!step('bringing the stack up (the migrations run first)', [...compose, 'up', '-d'], composeDir)) return 1;
  console.log('GREEN — the demo copy has an empty ledger. Next, each its own act by a named person:');
  console.log(`  1. pnpm run seed:pilot -- --operator "${operator}"`);
  console.log(`  2. pnpm run demo:publish-pack -- --operator "${operator}"`);
  console.log(`  3. pnpm run demo:till-pins -- --by "${operator}"   (each person types their own PIN; the old disk held the old ones)`);
  return 0;
}

process.exitCode = await main();
