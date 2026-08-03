// PostgreSQL connector — adapts a node-postgres `Pool` (or `PoolClient`) to the
// driver-agnostic `SqlClient` port. It is written against a STRUCTURAL interface
// (`PgQueryable`) that `pg.Pool` satisfies, so `packages/persistence` never imports
// `pg` and stays portable (P-06) and typecheckable without the driver present. The
// deployment creates the real `Pool` and passes it here:
//
//   import { Pool } from 'pg';
//   import { pgClient } from '@sre/persistence';
//   const pool = new Pool({ connectionString: process.env.DATABASE_URL });
//   const client = pgClient(pool);   // now any store (SqlEventStore, …) is durable
//
// node-postgres already uses bound parameters ($1, $2, …), so injection is
// impossible; this adapter just unwraps the `.rows` from each result.

import type { SqlClient, SqlRow } from './sql-client';

/** The shape of a node-postgres query result (only `rows` is used). */
export interface PgQueryResult {
  readonly rows: SqlRow[];
}

/** The subset of `pg.Pool` / `pg.PoolClient` this adapter needs. */
export interface PgQueryable {
  query(text: string, values?: unknown[]): Promise<PgQueryResult>;
}

/** Adapt a node-postgres `Pool`/`PoolClient` to the `SqlClient` port. */
export function pgClient(pool: PgQueryable): SqlClient {
  return {
    async query<R extends SqlRow = SqlRow>(
      sql: string,
      params?: readonly unknown[],
    ): Promise<readonly R[]> {
      const result = await pool.query(sql, params ? [...params] : undefined);
      return result.rows as R[];
    },
  };
}
