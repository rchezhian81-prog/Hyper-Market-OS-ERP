import { describe, it, expect } from 'vitest';
import {
  pgClient,
  pgPoolClient,
  runMigrations,
  type PgPool,
  type PgPoolClient,
  type PgQueryable,
  type PgQueryResult,
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

  it('exposes no transaction primitive — a query-only client cannot pin a connection', () => {
    // `pgClient` is deliberately transaction-free; atomicity comes from `pgPoolClient` over a real
    // Pool. `EventStore.appendBatch` over this client falls back to sequential writes (audit FND-01).
    const client = pgClient({ query: () => Promise.resolve({ rows: [] }) });
    expect(client.transaction).toBeUndefined();
  });
});

// A fake pooled connection that records every statement it runs in order and whether it was
// released — enough to prove the transaction envelope (BEGIN/COMMIT/ROLLBACK) and no pool leak.
class FakeConn implements PgPoolClient {
  readonly log: string[] = [];
  released = false;
  constructor(private readonly responses: SqlRow[][] = []) {}
  query(text: string): Promise<PgQueryResult> {
    this.log.push(text);
    // BEGIN/COMMIT/ROLLBACK carry no result rows and must not consume a programmed response —
    // those belong to the callback's own statements.
    if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
      return Promise.resolve({ rows: [] });
    }
    return Promise.resolve({ rows: this.responses.shift() ?? [] });
  }
  release(): void { this.released = true; }
}

class FakePool implements PgPool {
  constructor(private readonly conn: FakeConn) {}
  query(): Promise<PgQueryResult> { return Promise.resolve({ rows: [] }); }
  connect(): Promise<PgPoolClient> { return Promise.resolve(this.conn); }
}

describe('pgPoolClient transaction (FND-01 atomicity primitive)', () => {
  it('wraps the callback in BEGIN … COMMIT on success and releases the connection', async () => {
    const conn = new FakeConn([[{ n: 1 }]]);
    const client = pgPoolClient(new FakePool(conn));
    const out = await client.transaction!(async (tx) => {
      const rows = await tx.query('INSERT INTO t VALUES ($1) RETURNING n', [1]);
      return rows[0]!.n;
    });
    expect(out).toBe(1);
    expect(conn.log).toEqual(['BEGIN', 'INSERT INTO t VALUES ($1) RETURNING n', 'COMMIT']);
    expect(conn.released).toBe(true);
  });

  it('rolls back and rethrows when the callback throws — and still releases', async () => {
    const conn = new FakeConn();
    const client = pgPoolClient(new FakePool(conn));
    await expect(client.transaction!(async (tx) => {
      await tx.query('INSERT INTO t VALUES ($1)', [1]);
      throw new Error('boom');
    })).rejects.toThrow('boom');
    // BEGIN, the one insert, then ROLLBACK — never COMMIT.
    expect(conn.log).toEqual(['BEGIN', 'INSERT INTO t VALUES ($1)', 'ROLLBACK']);
    expect(conn.log).not.toContain('COMMIT');
    expect(conn.released).toBe(true);
  });

  it('runs the callback\'s queries on the pinned connection, not the pool', async () => {
    // Everything the callback issues must land on the checked-out connection, so its reads see its
    // own uncommitted writes. Proven by the connection's log carrying the callback's statement.
    const conn = new FakeConn([[{ v: 'seen' }]]);
    const client = pgPoolClient(new FakePool(conn));
    const seen = await client.transaction!((tx) => tx.query('SELECT v'));
    expect(seen).toEqual([{ v: 'seen' }]);
    expect(conn.log).toContain('SELECT v');
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
