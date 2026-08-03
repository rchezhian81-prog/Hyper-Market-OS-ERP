import { describe, it, expect } from 'vitest';
import {
  pgClient,
  runMigrations,
  type PgQueryable,
  type SqlClient,
  type SqlRow,
  type Migration,
} from '../../packages/persistence/src/index';

// The PostgreSQL connector adapts a pg Pool to the SqlClient port; the migration
// runner applies ordered migrations idempotently. Both are tested without a live
// database — the pg Pool and the SqlClient are faked.

describe('pgClient', () => {
  it('unwraps the rows from a pg query result', async () => {
    const pool: PgQueryable = {
      query: () => Promise.resolve({ rows: [{ n: 1 }, { n: 2 }] }),
    };
    const client = pgClient(pool);
    expect(await client.query('SELECT n FROM t')).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('passes the SQL and bound parameters straight through', async () => {
    let captured: { text: string; values?: unknown[] } | undefined;
    const pool: PgQueryable = {
      query: (text, values) => {
        captured = { text, values };
        return Promise.resolve({ rows: [] });
      },
    };
    await pgClient(pool).query('SELECT * FROM t WHERE id = $1', ['x']);
    expect(captured).toEqual({ text: 'SELECT * FROM t WHERE id = $1', values: ['x'] });
  });
});

// A fake SqlClient that understands only the runner's own statements plus records
// which migration DDLs were executed and in what order.
class FakeMigrationClient implements SqlClient {
  readonly applied = new Set<string>();
  readonly executed: string[] = [];

  query<R extends SqlRow = SqlRow>(sql: string, params?: readonly unknown[]): Promise<readonly R[]> {
    if (sql.includes('CREATE TABLE IF NOT EXISTS schema_migrations')) {
      return Promise.resolve([]);
    }
    if (sql.startsWith('SELECT name FROM schema_migrations')) {
      return Promise.resolve([...this.applied].map((name) => ({ name })) as unknown as R[]);
    }
    if (sql.startsWith('INSERT INTO schema_migrations')) {
      this.applied.add(String(params?.[0]));
      return Promise.resolve([]);
    }
    this.executed.push(sql); // a migration's DDL
    return Promise.resolve([]);
  }
}

const MIGS: Migration[] = [
  { name: '0001_a.sql', sql: 'CREATE TABLE a ();' },
  { name: '0002_b.sql', sql: 'CREATE TABLE b ();' },
];

describe('runMigrations', () => {
  it('applies all pending migrations in order and records them', async () => {
    const client = new FakeMigrationClient();
    const outcome = await runMigrations(client, MIGS);
    expect(outcome.applied).toEqual(['0001_a.sql', '0002_b.sql']);
    expect(outcome.skipped).toEqual([]);
    expect(client.executed).toEqual(['CREATE TABLE a ();', 'CREATE TABLE b ();']);
    expect([...client.applied]).toEqual(['0001_a.sql', '0002_b.sql']);
  });

  it('is idempotent — a re-run applies nothing new', async () => {
    const client = new FakeMigrationClient();
    await runMigrations(client, MIGS);
    const second = await runMigrations(client, MIGS);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(['0001_a.sql', '0002_b.sql']);
    expect(client.executed).toHaveLength(2); // the DDL ran once only
  });

  it('applies only the new migration when one is added', async () => {
    const client = new FakeMigrationClient();
    await runMigrations(client, MIGS);
    const withNew = [...MIGS, { name: '0003_c.sql', sql: 'CREATE TABLE c ();' }];
    const outcome = await runMigrations(client, withNew);
    expect(outcome.applied).toEqual(['0003_c.sql']);
    expect(outcome.skipped).toEqual(['0001_a.sql', '0002_b.sql']);
  });
});
