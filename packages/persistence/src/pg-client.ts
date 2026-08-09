// PostgreSQL connector — adapts a node-postgres `Pool` (or `PoolClient`) to the
// driver-agnostic `SqlClient` port. It is written against a STRUCTURAL interface
// (`PgQueryable`) that `pg.Pool` satisfies, so `packages/persistence` never imports
// `pg` and stays portable (P-06) and typecheckable without the driver present. The
// deployment creates the real `Pool` and passes it here:
//
//   import { Pool } from 'pg';
//   import { pgClient, pgPoolClient } from '@sre/persistence';
//   const pool = new Pool({ connectionString: process.env.DATABASE_URL });
//   const client = pgClient(pool);        // a query-only client — reads and single appends
//   const txClient = pgPoolClient(pool);  // adds the transaction primitive (atomic appendBatch)
//
// node-postgres already uses bound parameters ($1, $2, …), so injection is
// impossible; this adapter just unwraps the `.rows` from each result.

import type { SqlClient, SqlRow } from './sql-client';

/** The shape of a node-postgres query result (only `rows` is used). */
export interface PgQueryResult {
  readonly rows: SqlRow[];
}

/**
 * The subset of `pg.Pool` / `pg.PoolClient` / `pg.Client` this query adapter needs. Kept to `query`
 * alone so every node-postgres surface satisfies it structurally — the connector never imports `pg`.
 */
export interface PgQueryable {
  query(text: string, values?: unknown[]): Promise<PgQueryResult>;
}

/** A single connection checked out of a pool — queryable and, crucially, releasable. */
export interface PgPoolClient extends PgQueryable {
  /** Return the connection to the pool. MUST be called once, in a `finally`, or the pool leaks. */
  release(err?: unknown): void;
}

/**
 * The subset of `pg.Pool` the transactional adapter needs: it can check out a dedicated connection
 * that is pinned for a transaction's lifetime. `pg.Pool.connect()` matches this; `pg.Client.connect`
 * does NOT (it returns `void` and re-establishes the socket), which is exactly why a transaction is
 * offered only through `pgPoolClient` over a real Pool, never inferred from a bare queryable.
 */
export interface PgPool extends PgQueryable {
  connect(): Promise<PgPoolClient>;
}

const unwrap = async <R extends SqlRow>(
  q: PgQueryable, sql: string, params?: readonly unknown[],
): Promise<readonly R[]> => {
  const result = await q.query(sql, params ? [...params] : undefined);
  return result.rows as R[];
};

/**
 * Adapt a node-postgres `Pool`/`PoolClient`/`Client` to the `SqlClient` port. Query-only: it has no
 * transaction primitive, so `EventStore.appendBatch` over it falls back to best-effort sequential
 * writes. Use this for reads and single appends; use `pgPoolClient` where atomic multi-event appends
 * matter (the money path).
 */
export function pgClient(pool: PgQueryable): SqlClient {
  return { query: (sql, params) => unwrap(pool, sql, params) };
}

/**
 * Adapt a node-postgres `Pool` to the `SqlClient` port **with** the transaction primitive, so
 * `EventStore.appendBatch` becomes crash-atomic (audit FND-01): the whole batch commits or none of
 * it does. A transaction needs one connection pinned for its lifetime, which only a Pool can hand
 * out — hence a distinct factory rather than sniffing an ambiguous `connect` at runtime.
 */
export function pgPoolClient(pool: PgPool): SqlClient {
  return {
    query: (sql, params) => unwrap(pool, sql, params),
    async transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> {
      // One pinned connection for the whole transaction, so the callback's reads see its own
      // uncommitted writes (see the SqlClient.transaction contract). BEGIN → run → COMMIT, and any
      // throw rolls the whole thing back before the error propagates.
      const conn = await pool.connect();
      const tx: SqlClient = { query: (sql, params) => unwrap(conn, sql, params) };
      try {
        await conn.query('BEGIN');
        const out = await fn(tx);
        await conn.query('COMMIT');
        return out;
      } catch (err) {
        // Best-effort rollback; if the connection is already broken this throws, but the release in
        // `finally` still returns/destroys it, and the original error is what the caller must see.
        try { await conn.query('ROLLBACK'); } catch { /* connection unusable — released below */ }
        throw err;
      } finally {
        conn.release();
      }
    },
  };
}
