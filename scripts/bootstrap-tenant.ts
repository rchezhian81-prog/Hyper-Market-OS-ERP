// Create a SECOND, REAL tenant beside the demo: its first owner and the rest of its initial admin set,
// laid down once, atomically, straight into the event ledger — the same thing the API does at boot for
// the ONE tenant `BOOTSTRAP_OWNER_*` names, made repeatable for the next tenant by a named person.
//
//   pnpm run tenant:bootstrap -- --tenant <uuid> --owner <userId> --operator <yourName>
//                                [--admin <userId>:<roleId>[,<userId>:<roleId>]] [--dry-run]
//                                [--env-file infra/compose/.env] [--demo-tenant <uuid>]
//
// Refuses, by name (see packages/migration/src/tenant-bootstrap.ts): a production box, a tenant id that
// is not a UUID, the demo tenant, no owner, an unknown role, the same person twice, no operator. A tenant
// that already holds any grant is left untouched (exit 1, said plainly). Exit 2: cannot read the env or
// reach the database. Every later grant in the new tenant is maker-checker between these people (§28).

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { SqlEventStore } from '../packages/persistence/src/event-store';
import { pgPoolClient } from '../packages/persistence/src/pg-client';
import { seedInitialAdmins } from '../services/api/src/access';
import { OWNER_ROLE_ID, ROLE_CATALOGUE } from '../services/api/src/roles';
import { planTenantBootstrap } from '../packages/migration/src/tenant-bootstrap';
import { parseEnvText, parseFlags, demoTenantIds } from './lib/operator-env';

const out = (s = ''): void => { process.stdout.write(`${s}\n`); };

function usage(): never {
  out('Usage: pnpm run tenant:bootstrap -- --tenant <uuid> --owner <userId> --operator <name> [--admin u:role[,u:role]] [--dry-run] [--env-file PATH] [--demo-tenant ID]');
  out();
  out(`  Roles the catalogue knows: ${ROLE_CATALOGUE.map((r) => r.id).join(', ')}`);
  process.exit(2);
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const tenantId = typeof flags['tenant'] === 'string' ? flags['tenant'] : undefined;
  const owner = typeof flags['owner'] === 'string' ? flags['owner'] : undefined;
  const operator = typeof flags['operator'] === 'string' ? flags['operator'] : '';
  if (tenantId === undefined || owner === undefined || flags['help'] !== undefined) usage();
  const dryRun = flags['dry-run'] === true;

  const envFile = typeof flags['env-file'] === 'string' ? resolve(flags['env-file']) : join(process.cwd(), 'infra', 'compose', '.env');
  let env: Readonly<Record<string, string>> = {};
  if (existsSync(envFile)) env = parseEnvText(readFileSync(envFile, 'utf8'));
  else out(`Note: no env file at ${envFile} — MIGRATION_TARGET_KIND treated as unset (rehearsal).`);

  const admins = (typeof flags['admin'] === 'string' ? flags['admin'].split(',') : [])
    .map((s) => s.trim()).filter((s) => s !== '')
    .map((pair) => { const [userId = '', roleId = ''] = pair.split(':'); return { userId: userId.trim(), roleId: roleId.trim() }; });

  const plan = planTenantBootstrap({
    tenantId, owner, admins, targetKind: env['MIGRATION_TARGET_KIND'], demoTenantIds: demoTenantIds(env, flags['demo-tenant']),
    knownRoleIds: ROLE_CATALOGUE.map((r) => r.id), operator, ownerRoleId: OWNER_ROLE_ID,
  });
  if (!plan.ok) {
    out(`REFUSED (${plan.refusedBecause}) — ${plan.detail}`);
    process.exit(1);
  }
  out(`Tenant ${plan.tenantId} — initial admin set, laid down by ${plan.operator}:`);
  for (const a of plan.admins) out(`  • ${a.userId} as ${a.roleId}`);
  if (dryRun) { out('DRY RUN — nothing was written.'); process.exit(0); }

  // The env FILE is the box. Deliberately no fall-back to the process environment: a database address
  // inherited from a shell nobody named is exactly how a tenant ends up seeded into the wrong ledger
  // (it happened once, in CI, to the test that expected "no database").
  const databaseUrl = env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl === '') {
    out(`DATABASE_URL is not in the env file (${envFile}) — cannot reach the ledger. Nothing was written. (The process environment is deliberately NOT consulted.)`);
    process.exit(2);
  }
  const db = new Pool({ connectionString: databaseUrl, max: 2 });
  try {
    const store = new SqlEventStore(pgPoolClient(db));
    const outcome = await seedInitialAdmins(store, plan.tenantId, plan.admins, plan.operator, new Date().toISOString());
    if (outcome.outcome === 'already_bootstrapped') {
      out(`NOT CHANGED — tenant ${plan.tenantId} already holds grants; a bootstrap never widens an existing tenant. Grants there are made person-to-person under maker-checker.`);
      process.exit(1);
    }
    out(`SEEDED — ${outcome.granted} grant(s) recorded in one atomic append. Every further grant in this tenant needs a requester and a different approver (§28).`);
    process.exit(0);
  } catch (e) {
    out(`Could not write to the ledger: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  } finally {
    await db.end().catch(() => undefined);
  }
}

await main();
