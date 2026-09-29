// A NON-superuser PostgreSQL role for database tests that prove row-level security.
//
// A superuser bypasses RLS entirely, and the database CI (and many a local setup) connects as one. Suites that
// prove the policies therefore connect as an ordinary role they create here — the shape the deployment gives the
// API (`infra/compose/db-init/01-app-role.sh`), which `main.ts` insists on at boot.
//
// Several suites do this at once, and PostgreSQL catalogue updates do not queue: two concurrent GRANTs on the same
// table fail with "tuple concurrently updated". One session-wide advisory lock serialises the role/grant step across
// every suite that takes it, so the suites stay independent AND parallel-safe.

import type { Pool } from 'pg';

/** One key for every suite that provisions a test role — the lock, not the role name, is what serialises them. */
const ROLE_PROVISIONING_LOCK = 730_013;

/** Idempotently create `role` (LOGIN, NOSUPERUSER, NOBYPASSRLS) with ordinary read/write privileges on `public`. */
export async function ensureAppRole(platform: Pool, role: string): Promise<void> {
  if (!/^[a-z_][a-z0-9_]*$/.test(role)) throw new Error(`refusing to provision a role named ${JSON.stringify(role)}`);
  const c = await platform.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock($1)', [ROLE_PROVISIONING_LOCK]);
    await c.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS; END IF; END $$;`);
    await c.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await c.query(`GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO ${role}`);
    await c.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

/** The same connection string, as `role` (trust/peer auth in CI and the local cluster; no password travels). */
export const asRole = (url: string, role: string): string => { const u = new URL(url); u.username = role; u.password = ''; return u.toString(); };
