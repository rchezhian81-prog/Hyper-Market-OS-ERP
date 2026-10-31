// A FRESH SEED of the hosted DEMO copy — and only the demo copy (Round 3 of the screen gap audit, 31 Oct 2026).
//
// Why it is needed: the ledgers are append-only (hard rule #2). A receipt, an order or a payment the seed laid down is
// history; re-running the seed after its data changed does NOT re-do it ("landed earlier under this key"). Round B (#852)
// corrected the demo's opening stock from thousands to pieces (OB-31), so the demo box's ledger still holds the old,
// 1000-times counts and nothing may overwrite them. The honest way to the corrected figures on a SYNTHETIC copy is a new,
// empty ledger seeded again — with the old one KEPT, never deleted (hard rule #6): its database is RENAMED to
// `<name>_retired_<UTC time>` and stays on the server, readable, until a person decides otherwise in writing.
//
// It refuses to touch anything that is not the demo (hard rule #7), by name, before it changes anything:
//   • the settings must name the synthetic demo tenant (`EDGE_TENANT_ID`) and must not be production-marked;
//   • the person running it must name themselves, and type the demo's own label to confirm (`--this-is-the-demo pilot-demo`);
//   • the LEDGER itself must hold the demo tenant's records and nobody else's — a database with any other tenant in it is a
//     real shop's (or a mistake), and is refused whatever the settings say.
// The rules are pure and tested; the database steps are tested against a real PostgreSQL. The box's compose steps are in
// `run-reseed.ts`, and the person's steps in docs/runbooks/demo-practice-environment.md ("A fresh seed of the demo").

import { PILOT_DEMO_TENANT, PILOT_DEMO_TENANT_LABEL } from './dataset';

/** What the person types to confirm they mean the demo copy: its own label, never a yes/no. */
export const DEMO_RESEED_CONFIRMATION = PILOT_DEMO_TENANT_LABEL;

/** A database name this tool will rename or create — a plain identifier, nothing a shell or SQL could read twice. */
const DB_NAME = /^[a-z_][a-z0-9_]{0,40}$/;

export interface DemoReseedFacts {
  /** `EDGE_TENANT_ID` from the box's settings file. */
  readonly tenantId: string;
  readonly migrationTargetKind?: string;
  readonly operator: string;
  /** What the person typed after `--this-is-the-demo`. */
  readonly confirmation: string;
  /** `POSTGRES_DB` — the database to retire and make again. */
  readonly databaseName: string;
  /** The tenants the ledger holds records for (`null` = the ledger has no table yet: an empty, fresh database). */
  readonly tenantsInLedger: readonly string[] | null;
}

/** Why a fresh seed must not start. Empty = it is the demo copy and the person said so. */
export function demoReseedRefusals(f: DemoReseedFacts): string[] {
  const out: string[] = [];
  if (f.tenantId !== PILOT_DEMO_TENANT) {
    out.push(`the settings name tenant "${f.tenantId}", not the synthetic demo tenant "${PILOT_DEMO_TENANT}" — a fresh seed is only ever made of the demo copy`);
  }
  if (f.migrationTargetKind === 'production') {
    out.push('MIGRATION_TARGET_KIND is "production" — a fresh seed never runs against a production-marked environment (hard rule #7)');
  }
  if (f.operator.trim() === '') out.push('no operator named — the retired ledger and the new seed must both record the person who did it');
  if (f.confirmation !== DEMO_RESEED_CONFIRMATION) {
    out.push(`not confirmed — type --this-is-the-demo ${DEMO_RESEED_CONFIRMATION} to say this is the demo copy`);
  }
  if (!DB_NAME.test(f.databaseName)) out.push(`the database name "${f.databaseName}" is not a plain name this tool will rename`);
  const others = (f.tenantsInLedger ?? []).filter((t) => t !== PILOT_DEMO_TENANT);
  if (others.length > 0) {
    out.push(`the ledger holds records for ${others.length} tenant(s) other than the demo (${others.slice(0, 3).join(', ')}${others.length > 3 ? ', …' : ''}) — this is not the demo copy's database, and nothing was changed`);
  }
  return out;
}

/** The smallest surface of a PostgreSQL client these steps need (`pg.Client` / `pg.Pool` satisfy it). */
export interface SqlRunner {
  query(text: string, values?: readonly unknown[]): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
}

/**
 * Which tenants this database knows — every tenant REGISTERED on it (the tenant register, migration 0013) and every tenant
 * the ledger holds records for — or `null` when the database has no ledger table yet (fresh). Read as the administrator,
 * so row-level security hides nothing.
 */
export async function tenantsInLedger(db: SqlRunner): Promise<string[] | null> {
  const table = await db.query(`SELECT to_regclass('public.event_ledger') IS NOT NULL AS ledger, to_regclass('public.tenants') IS NOT NULL AS register`);
  if (table.rows[0]?.['ledger'] !== true) return null;
  const rows = await db.query(table.rows[0]?.['register'] === true
    ? 'SELECT tenant_id::text AS tenant FROM tenants UNION SELECT DISTINCT tenant_id::text FROM event_ledger'
    : 'SELECT DISTINCT tenant_id::text AS tenant FROM event_ledger');
  return rows.rows.map((r) => String(r['tenant'])).sort();
}

/** The name the old database is kept under: `<name>_retired_<YYYYMMDDHHMMSS>` (UTC). */
export function retiredNameFor(databaseName: string, at: Date): string {
  return `${databaseName}_retired_${at.toISOString().replace(/[-:T]/g, '').slice(0, 14)}`;
}

/**
 * Keep the old database under its retired name and make an empty one under the old name, with the application role's
 * grants a fresh volume gives it (infra/compose/db-init/01-app-role.sh). Run as the database ADMINISTRATOR, connected to
 * the server's maintenance database (`postgres`), with nothing else connected to the demo database (the runner stops the
 * stack's services first). Nothing is dropped. Returns the retired name.
 */
export async function retireAndRecreate(admin: SqlRunner, input: { readonly databaseName: string; readonly appRole: string; readonly at: Date }): Promise<string> {
  if (!DB_NAME.test(input.databaseName) || !DB_NAME.test(input.appRole)) throw new Error('refused: the database or role name is not a plain name');
  const retired = retiredNameFor(input.databaseName, input.at);
  const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [retired]);
  if (exists.rows.length > 0) throw new Error(`refused: a retired database named ${retired} already exists — nothing was changed`);
  await admin.query(`ALTER DATABASE "${input.databaseName}" RENAME TO "${retired}"`);
  await admin.query(`CREATE DATABASE "${input.databaseName}"`);
  const role = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [input.appRole]);
  if (role.rows.length > 0) await admin.query(`GRANT CONNECT, TEMPORARY ON DATABASE "${input.databaseName}" TO "${input.appRole}"`);
  return retired;
}

/** The schema grant the application role needs inside the NEW database (run connected to it, as the administrator). */
export async function grantSchemaToAppRole(adminInNewDb: SqlRunner, appRole: string): Promise<void> {
  if (!DB_NAME.test(appRole)) throw new Error('refused: the role name is not a plain name');
  const role = await adminInNewDb.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [appRole]);
  if (role.rows.length > 0) await adminInNewDb.query(`GRANT ALL ON SCHEMA public TO "${appRole}"`);
}
