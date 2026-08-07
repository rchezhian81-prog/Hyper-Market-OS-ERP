import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { pgClient } from '../../packages/persistence/src/pg-client';
import { runMigrations, type Migration } from '../../packages/persistence/src/migrations';

// Schema migrations — hard rules #2, #6, #7. The standing rule on this project is explicit:
// **additive, reversible, versioned migrations only. Never destructive.**
//
// That rule is enforced by discipline today, which means it is enforced until the first evening
// somebody needs a column gone and the change looks obviously safe. A destructive migration is
// not like other bad code: it runs once, it succeeds, and the data it removed is not in the diff.
// You cannot review your way back to it, and the person who finds out is a customer asking about
// a receipt from March.
//
// So the rule is a test:
//
//   • **THE FILES ARE SCANNED FOR DESTRUCTIVE STATEMENTS**, with a tripwire proving the scanner
//     fires on a known-bad sample — a detector nobody has seen catch anything is a detector
//     nobody should trust.
//   • **THE WHOLE SET IS APPLIED TWICE** against a real PostgreSQL. A migration runner that is
//     idempotent in theory and not in practice fails at exactly one moment: the deploy that was
//     interrupted halfway.
//   • **THE APPEND-ONLY GUARDS ARE VERIFIED AFTER THE FACT**, in the database, rather than
//     trusted because migration 0004 says it installs them.

const DIR = 'db/migrations';
const FILES = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
const MIGRATIONS: readonly Migration[] = FILES.map((name) => ({
  name, sql: readFileSync(join(DIR, name), 'utf8'),
}));

/**
 * Statements that remove or rewrite data or structure.
 *
 * Kept deliberately blunt. A cleverer scanner that understands context would let through the
 * case somebody argues for, and the entire value here is that there is nothing to argue with:
 * if a migration needs one of these, that is a conversation with the owner, not a regex to
 * refine.
 */
const DESTRUCTIVE: readonly { readonly id: string; readonly pattern: RegExp; readonly why: string }[] = [
  { id: 'drop_table', pattern: /\bDROP\s+TABLE\b/i, why: 'drops a table and everything in it' },
  { id: 'drop_column', pattern: /\bDROP\s+COLUMN\b/i, why: 'drops a column — the data in it is not in the diff' },
  { id: 'drop_database', pattern: /\bDROP\s+DATABASE\b/i, why: 'drops the database' },
  { id: 'drop_schema', pattern: /\bDROP\s+SCHEMA\b/i, why: 'drops a schema' },
  { id: 'truncate', pattern: /\bTRUNCATE\b/i, why: 'empties a table with no row-level record of what went' },
  { id: 'delete_from', pattern: /\bDELETE\s+FROM\b/i, why: 'deletes rows — a migration is not the place to correct data' },
  { id: 'alter_column_type', pattern: /\bALTER\s+COLUMN\b[\s\S]{0,80}\bTYPE\b/i, why: 'retypes a column, which silently truncates or rounds' },
  { id: 'drop_constraint', pattern: /\bDROP\s+CONSTRAINT\b/i, why: 'removes a constraint — whatever it was protecting is now unprotected' },
  { id: 'drop_not_null', pattern: /\bDROP\s+NOT\s+NULL\b/i, why: 'weakens a column that something relies on being present' },
];

/**
 * A migration may declare an exception, with a reason, in its own header:
 *
 *     -- MIGRATION-EXCEPTION: alter_column_type — uuid to text is lossless in this direction…
 *
 * This is the same shape as every other exception in this product (hard rule #6, MG-04): the
 * dangerous thing is not permitted quietly, and it is not forbidden absolutely — it is **kept,
 * named and argued for**, where a reviewer sees it in the diff.
 *
 * Two rules make the mechanism honest, and the second is the one that matters: a flagged
 * statement with no declaration fails, **and a declaration with no flagged statement fails too**.
 * Without that second rule the block rots into a blanket exemption somebody copies forward into
 * a migration that genuinely does drop a column.
 */
const EXCEPTION_LINE = /--\s*MIGRATION-EXCEPTION:\s*([a-z_]+)\s*[—-]\s*(.+)$/gim;

function declaredExceptions(sql: string): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const m of sql.matchAll(EXCEPTION_LINE)) out.set(m[1]!, m[2]!.trim());
  return out;
}

/** Strip comments before scanning: migration 0004's own prose explains what it does NOT do. */
function statementsOf(sql: string): string {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

describe('every migration is additive — the rule, as a test', () => {
  it('finds the migrations at all', () => {
    // A scan over an empty list passes silently. Guard the guard.
    expect(FILES.length).toBeGreaterThanOrEqual(5);
    expect(FILES[0]).toMatch(/^0001_/);
  });

  it('contains no UNDECLARED destructive statement in any migration', () => {
    const found: string[] = [];
    for (const migration of MIGRATIONS) {
      const sql = statementsOf(migration.sql);
      const declared = declaredExceptions(migration.sql);
      for (const { id, pattern, why } of DESTRUCTIVE) {
        if (pattern.test(sql) && !declared.has(id)) {
          found.push(`${migration.name}: ${why} (declare it with "-- MIGRATION-EXCEPTION: ${id} — <reason>" if it is genuinely safe)`);
        }
      }
    }
    expect(found).toEqual([]);
  });

  it('refuses a declaration for something the migration does not actually do', () => {
    // The rule that stops the mechanism rotting. A stale exception is a lie sitting in a header,
    // and the next person copies the whole block into a migration that really does drop a column.
    const stale: string[] = [];
    for (const migration of MIGRATIONS) {
      const sql = statementsOf(migration.sql);
      for (const [id] of declaredExceptions(migration.sql)) {
        const rule = DESTRUCTIVE.find((d) => d.id === id);
        if (rule === undefined) {
          stale.push(`${migration.name}: declares an unknown exception "${id}"`);
        } else if (!rule.pattern.test(sql)) {
          stale.push(`${migration.name}: declares "${id}" but contains no such statement`);
        }
      }
    }
    expect(stale).toEqual([]);
  });

  it('requires a real reason on every declared exception, not a word', () => {
    for (const migration of MIGRATIONS) {
      for (const [id, reason] of declaredExceptions(migration.sql)) {
        expect(reason.length, `${migration.name}: "${id}" is declared with no real reason`)
          .toBeGreaterThan(40);
      }
    }
  });

  it('declares exactly the two exceptions the schema currently needs, and no more', () => {
    // A count, deliberately. If this number grows, somebody widened the exemption surface and a
    // reviewer should be made to notice.
    const all = MIGRATIONS.flatMap((m) => [...declaredExceptions(m.sql).keys()]);
    expect(all.sort()).toEqual(['alter_column_type', 'drop_constraint']);
  });

  it('and the scanner FIRES on each destructive statement — a detector nobody has seen catch anything', () => {
    const samples: readonly string[] = [
      'ALTER TABLE event_ledger DROP COLUMN payload;',
      'DROP TABLE sync_outbox;',
      'TRUNCATE event_ledger;',
      'DELETE FROM event_ledger WHERE occurred_at < now() - interval \'1 year\';',
      'ALTER TABLE config_versions ALTER COLUMN version TYPE smallint;',
      'ALTER TABLE event_ledger DROP CONSTRAINT event_ledger_tenant_key;',
      'ALTER TABLE event_ledger ALTER COLUMN source DROP NOT NULL;',
      'DROP SCHEMA public CASCADE;',
    ];
    for (const sample of samples) {
      const caught = DESTRUCTIVE.some(({ pattern }) => pattern.test(statementsOf(sample)));
      expect(caught, `NOT caught: ${sample}`).toBe(true);
      // And an undeclared one is a failure, because a bare file declares nothing.
      expect(declaredExceptions(sample).size).toBe(0);
    }
  });

  it('does not fire on the additive statements a real migration uses', () => {
    // A scanner that flags legitimate work gets switched off within a fortnight.
    const legitimate: readonly string[] = [
      'CREATE TABLE IF NOT EXISTS event_ledger (id text PRIMARY KEY);',
      'ALTER TABLE event_ledger ADD COLUMN IF NOT EXISTS branch_id text;',
      'CREATE INDEX IF NOT EXISTS idx_ledger_tenant ON event_ledger (tenant_id);',
      'CREATE UNIQUE INDEX IF NOT EXISTS uq_ledger_key ON event_ledger (tenant_id, idempotency_key);',
      'CREATE OR REPLACE FUNCTION refuse_update() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION \'append-only\'; END; $$ LANGUAGE plpgsql;',
      'CREATE TRIGGER no_update BEFORE UPDATE ON event_ledger FOR EACH ROW EXECUTE FUNCTION refuse_update();',
    ];
    for (const sample of legitimate) {
      const caught = DESTRUCTIVE.some(({ pattern }) => pattern.test(statementsOf(sample)));
      expect(caught, `wrongly flagged: ${sample}`).toBe(false);
    }
  });

  it('ignores the word "drop" inside a comment, so a migration may explain itself', () => {
    // Migration 0004's own header says "A superuser can drop a trigger" — a sentence explaining
    // the limits of what it claims. A scanner that reads prose as SQL punishes documentation.
    const documented = '-- Note: a superuser can DROP TABLE here; this is defence in depth.\nCREATE INDEX IF NOT EXISTS i ON t (c);';
    expect(DESTRUCTIVE.some(({ pattern }) => pattern.test(statementsOf(documented)))).toBe(false);
  });

  it('numbers every migration uniquely and in sequence — a gap is a file somebody forgot to commit', () => {
    const numbers = FILES.map((f) => Number(f.slice(0, 4)));
    expect(new Set(numbers).size).toBe(numbers.length);
    for (let i = 0; i < numbers.length; i += 1) {
      expect(numbers[i], `sequence breaks at ${FILES[i]}`).toBe(i + 1);
    }
  });

  it('gives every migration a header explaining WHY, not only what', () => {
    // The SQL says what changed. In three years the only useful question is why, and the answer
    // has to be in the file — the pull request that carried it will be unfindable.
    for (const migration of MIGRATIONS) {
      const header = migration.sql.split('\n').slice(0, 6).join('\n');
      expect(header.startsWith('--'), `${migration.name} has no header comment`).toBe(true);
      expect(header.length, `${migration.name} header is too thin to explain anything`).toBeGreaterThan(80);
    }
  });
});

// ─── Against a real PostgreSQL ────────────────────────────────────────────────

const DATABASE_URL = process.env['DATABASE_URL'];

describe.skipIf(!DATABASE_URL)('the migration set applies, re-applies and holds (real PostgreSQL)', () => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
  });

  it('applies cleanly, then applies AGAIN and changes nothing', async () => {
    const sql = pgClient(client);

    const first = await runMigrations(sql, MIGRATIONS);
    expect(first.applied.length + first.skipped.length).toBe(MIGRATIONS.length);

    // The interrupted-deploy case. A runner that is idempotent in theory and not in practice
    // fails at exactly one moment: the deploy somebody stopped halfway at eleven at night.
    const second = await runMigrations(sql, MIGRATIONS);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(FILES);

    const third = await runMigrations(sql, MIGRATIONS);
    expect(third.applied).toEqual([]);
  });

  it('records exactly one row per migration, however many times it runs', async () => {
    const rows = await client.query<{ name: string }>('SELECT name FROM schema_migrations ORDER BY name');
    const names = rows.rows.map((r) => r.name);

    // Each REAL migration appears exactly once. Deliberately not an equality check against the
    // whole table: this database is shared across the suite and persists between runs, so an
    // exact match would make the assertion depend on what any other test happened to apply —
    // which is a test that passes on a fresh database and fails on the second run, and that is
    // the failure mode this whole file exists to catch in migrations.
    for (const file of FILES) {
      expect(names.filter((n) => n === file), file).toHaveLength(1);
    }
    expect(new Set(names).size).toBe(names.length);
  });

  it('leaves the append-only guards actually installed, verified in the database', async () => {
    // Migration 0004 SAYS it installs triggers. This checks the database agrees — the difference
    // between a migration that ran and a guarantee that holds.
    const triggers = await client.query<{ tgname: string }>(
      `SELECT tgname FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       WHERE c.relname = 'event_ledger' AND NOT t.tgisinternal`,
    );
    expect(triggers.rows.length).toBeGreaterThan(0);
  });

  it('refuses an UPDATE and a DELETE on the ledger, by name (hard rule #2)', async () => {
    await expect(client.query("UPDATE event_ledger SET source = 'tampered'"))
      .rejects.toThrow(/append-only/i);
    await expect(client.query('DELETE FROM event_ledger'))
      .rejects.toThrow(/append-only/i);
  });

  it('holds the tenant-scoped uniqueness that makes a replay one effect (§31.1)', async () => {
    const indexes = await client.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE tablename = 'event_ledger'",
    );
    const defs = indexes.rows.map((r) => r.indexdef).join('\n');
    // Uniqueness is ALWAYS tenant-scoped in this product (ADR-0003). A global unique key on an
    // idempotency key would make one tenant's replay collide with another's first write.
    expect(defs).toMatch(/UNIQUE/i);
    expect(defs).toMatch(/tenant_id/i);
  });

  it('applies a NEW migration on top without disturbing what is already recorded', async () => {
    // The realistic future: migration 0006 arrives. It must apply, be recorded once, and leave
    // the previous five untouched — including their applied_at stamps.
    //
    // The probe carries a FIXED name, so re-running this suite against the same database applies
    // it the first time and skips it thereafter. A name with a timestamp in it would add a row
    // per run and slowly fill the tracking table with junk — and would make the assertion above
    // fail on the second run, which is precisely the interrupted-deploy failure being tested for.
    const PROBE = '9999_probe_additive.sql';
    const before = await client.query<{ name: string; applied_at: Date }>(
      'SELECT name, applied_at FROM schema_migrations WHERE name = ANY($1) ORDER BY name', [FILES],
    );

    const added: Migration = {
      name: PROBE,
      sql: 'CREATE TABLE IF NOT EXISTS migration_probe (id text PRIMARY KEY);',
    };
    const outcome = await runMigrations(pgClient(client), [...MIGRATIONS, added]);
    // Applied on a fresh database, skipped on a repeat — both are correct, and asserting one of
    // them would make this test order-dependent.
    expect([...outcome.applied, ...outcome.skipped]).toContain(PROBE);
    for (const file of FILES) expect(outcome.skipped).toContain(file);

    const after = await client.query<{ name: string; applied_at: Date }>(
      'SELECT name, applied_at FROM schema_migrations WHERE name = ANY($1) ORDER BY name', [FILES],
    );
    expect(after.rows.map((r) => r.name)).toEqual(before.rows.map((r) => r.name));
    expect(after.rows.map((r) => r.applied_at.toISOString()))
      .toEqual(before.rows.map((r) => r.applied_at.toISOString()));

    // And the probe is recorded exactly once, however many times this suite has run.
    const probeRows = await client.query('SELECT name FROM schema_migrations WHERE name = $1', [PROBE]);
    expect(probeRows.rowCount).toBe(1);
  });
});
