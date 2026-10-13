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
import { currentWriteWitness, isReadOnlyStatement } from './write-witness';

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
  /** Return the connection to the pool. MUST be called once, in a `finally`, or the pool leaks. `release(err)` discards it. */
  release(err?: unknown): void;
  /**
   * Verifier r21 IDLE-CRASH: a checked-out node-postgres client is an EventEmitter that emits `'error'` when the server ends
   * its session between statements (idle_in_transaction_session_timeout, an administrator's pg_terminate_backend, a server
   * restart). The pool takes its own listener OFF while the client is checked out, so with nobody listening Node turns that
   * `'error'` into an uncaught exception and the whole API process exits. Optional so a plain fake still fits.
   */
  on?(event: 'error', listener: (err: Error) => void): unknown;
  removeListener?(event: 'error', listener: (err: Error) => void): unknown;
}

/**
 * The subset of `pg.Pool` the transactional adapter needs: it can check out a dedicated connection
 * that is pinned for a transaction's lifetime. `pg.Pool.connect()` matches this; `pg.Client.connect`
 * does NOT (it returns `void` and re-establishes the socket), which is exactly why a transaction is
 * offered only through `pgPoolClient` over a real Pool, never inferred from a bare queryable.
 */
export interface PgPool extends PgQueryable {
  connect(): Promise<PgPoolClient>;
  /** node-postgres emits `'error'` on the POOL when an IDLE pooled connection is ended by the server (see {@link pgPoolClient}). */
  on?(event: 'error', listener: (err: Error) => void): unknown;
}

/** What {@link pgPoolClient} tells its owner (the API's log) when the database ends one of its connections. */
export interface PgPoolOptions {
  /** Said once per ended idle connection — loudly, never swallowed (P-08). Default: written to stderr. */
  readonly onConnectionEnded?: (detail: string) => void;
}

/**
 * Verifier r21 IDLE-CRASH: the database ended the session a transaction was running on — `idle_in_transaction_session_timeout`
 * fired, an administrator terminated it, or the server restarted — BEFORE that transaction's COMMIT was sent. PostgreSQL rolls
 * an unfinished transaction back when its session ends, so the transaction saved NOTHING (all-or-nothing, FND-01). The API
 * answers it as a visible 500 that says so (services/kernel/src/pipeline.ts), never as a crash and never as "unknown".
 */
export class DatabaseSessionEndedError extends Error {
  override readonly name = 'DatabaseSessionEndedError';
  readonly ended: unknown;
  constructor(ended: unknown) {
    super(`the database ended this transaction before it finished, so nothing in it was saved (${describeDbError(ended)})`);
    this.ended = ended;
  }
}

/** A database error in one line: its SQLSTATE (when it has one) and message. */
export function describeDbError(e: unknown): string {
  if (e instanceof Error) {
    const code = (e as { code?: unknown }).code;
    return typeof code === 'string' ? `${code}: ${e.message}` : e.message;
  }
  return String(e);
}

/**
 * SQLSTATEs that mean the SESSION is gone (not that one statement was refused): 25P03 idle-in-transaction timeout, 57P01
 * admin shutdown / pg_terminate_backend, 57P02 crash shutdown, 57P03 cannot connect now, 57P05 idle-session timeout, and
 * class 08 connection exceptions. Plus node-postgres's own words for a socket that died under it.
 */
const SESSION_ENDED_CODES = new Set(['25P03', '57P01', '57P02', '57P03', '57P05']);
export function isSessionEnded(err: unknown): boolean {
  if (err instanceof DatabaseSessionEndedError) return true;
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && (SESSION_ENDED_CODES.has(code) || code.startsWith('08'))) return true;
  return /Connection terminated|not queryable|terminating connection|ECONNRESET|EPIPE/i.test(err.message);
}

/**
 * Verifier r22 D7: was this error raised BY the database driver (node-postgres) — not merely worded like one? True for our own
 * {@link DatabaseSessionEndedError}, and for an error whose stack shows it was made inside `pg`, `pg-pool` or `pg-protocol`
 * (the deployment loads them from node_modules: scripts/build-service.mjs keeps npm packages external). A socket error from
 * anything else ("ECONNRESET" from an HTTP client, "EPIPE" from a log pipe) is not the database's, whatever its message says.
 */
export function fromDatabaseDriver(err: unknown): boolean {
  if (err instanceof DatabaseSessionEndedError) return true;
  return err instanceof Error && /[\\/]node_modules[\\/]pg(?:-pool|-protocol)?[\\/]/.test(err.stack ?? '');
}

/**
 * Check a connection out for one transaction, LISTENING for its `'error'` the whole time it is checked out (verifier r21
 * IDLE-CRASH), and hand it back WITH the error when its session ended, so the pool DISCARDS it rather than lending a dead
 * socket to the next request. `run` gets the connection and a probe saying whether the server already ended the session.
 */
async function pinned<T>(pool: PgPool, run: (conn: PgPoolClient, ended: () => unknown) => Promise<T>): Promise<T> {
  const conn = await pool.connect();
  let ended: unknown;
  const onError = (e: Error): void => { ended ??= e; };
  conn.on?.('error', onError);
  let releaseWith: unknown;
  try {
    return await run(conn, () => ended);
  } catch (err) {
    if (ended !== undefined || isSessionEnded(err)) releaseWith = ended ?? err;
    throw err;
  } finally {
    conn.release(releaseWith);
    // A healthy connection goes back to the pool with only the pool's own listener on it. A broken one KEEPS ours: the
    // socket's last words ("Connection terminated unexpectedly") can arrive after the release, and they are already said.
    if (releaseWith === undefined) conn.removeListener?.('error', onError);
  }
}

/**
 * BEGIN → setup → fn → COMMIT on one pinned connection. Any failure before COMMIT was SENT, on a session the server ended,
 * becomes a {@link DatabaseSessionEndedError} — true by construction, because PostgreSQL rolls back an unfinished transaction
 * when its session ends. A COMMIT that itself failed on a dying socket keeps its raw error: whether it landed is unknown.
 */
async function inTransaction<T>(
  pool: PgPool, setup: readonly (readonly [string, readonly unknown[]])[], fn: (conn: PgQueryable) => Promise<T>,
): Promise<T> {
  // Verifier r22 D1: the request this runs for learns whether it WROTE and committed, and that it is still open.
  const witness = currentWriteWitness();
  if (witness !== undefined) witness.open += 1;
  try {
    return await pinned(pool, async (conn, ended) => {
      let commitSent = false;
      let wrote = false;
      const watched: PgQueryable = { query: (text, values) => { if (!isReadOnlyStatement(text)) wrote = true; return conn.query(text, values); } };
      try {
        await conn.query('BEGIN');
        for (const [sql, params] of setup) await conn.query(sql, [...params]);
        const out = await fn(watched);
        const before = ended();
        if (before !== undefined) throw new DatabaseSessionEndedError(before);
        commitSent = true;
        await conn.query('COMMIT');
        if (wrote && witness !== undefined) witness.committedWrites += 1;
        return out;
      } catch (err) {
        const sessionEnded = ended() !== undefined || isSessionEnded(err);
        // Best-effort rollback on a live connection; a dead one has already been rolled back by the server.
        if (!sessionEnded) { try { await conn.query('ROLLBACK'); } catch { /* connection unusable — released by `pinned` */ } }
        if (sessionEnded && !commitSent && !(err instanceof DatabaseSessionEndedError)) throw new DatabaseSessionEndedError(ended() ?? err);
        // A COMMIT that failed may still have landed: a write in it is counted as committed (the request is "unknown").
        if (commitSent && wrote && witness !== undefined) witness.committedWrites += 1;
        throw err;
      }
    });
  } finally {
    if (witness !== undefined) witness.open -= 1;
  }
}

const unwrap = async <R extends SqlRow>(
  q: PgQueryable, sql: string, params?: readonly unknown[],
): Promise<readonly R[]> => {
  const result = await q.query(sql, params ? [...params] : undefined);
  return result.rows as R[];
};

/**
 * A statement run straight on the pool (autocommit, no transaction of ours): verifier r22 D1 — a write that may have run is
 * noted on the request's witness as committed (an autocommit statement commits as it ends; one that failed may have, too).
 */
const autocommit = async <R extends SqlRow>(pool: PgQueryable, sql: string, params?: readonly unknown[]): Promise<readonly R[]> => {
  const witness = currentWriteWitness();
  const writes = !isReadOnlyStatement(sql);
  if (witness !== undefined) witness.open += 1;
  try {
    return await unwrap<R>(pool, sql, params);
  } finally {
    if (witness !== undefined) { witness.open -= 1; if (writes) witness.committedWrites += 1; }
  }
};

/**
 * Adapt a node-postgres `Pool`/`PoolClient`/`Client` to the `SqlClient` port. Query-only: it has no
 * transaction primitive, so `EventStore.appendBatch` over it falls back to best-effort sequential
 * writes, and NO tenant-scoped view — a statement runs under whatever scope the CONNECTION carries
 * (a single `Client` opened with `options: '-c app.tenant_id=…'`, as the operator tools and the
 * database tests do). Under row-level security an unscoped connection sees and writes nothing (fail
 * closed). The application composes `pgPoolClient`, which scopes every statement per transaction.
 */
export function pgClient(pool: PgQueryable): SqlClient {
  return { query: (sql, params) => autocommit(pool, sql, params) };
}

/**
 * Adapt a node-postgres `Pool` to the `SqlClient` port **with** the transaction primitive, so
 * `EventStore.appendBatch` becomes crash-atomic (audit FND-01): the whole batch commits or none of
 * it does. A transaction needs one connection pinned for its lifetime, which only a Pool can hand
 * out — hence a distinct factory rather than sniffing an ambiguous `connect` at runtime.
 */
export function pgPoolClient(pool: PgPool, options: PgPoolOptions = {}): SqlClient {
  listenForEndedConnections(pool, options);
  return {
    query: (sql, params) => autocommit(pool, sql, params),
    // Row-level security (migration 0012): every statement through the returned view runs inside a pinned
    // transaction that first sets `app.tenant_id` for THAT transaction only (`set_config(..., true)`), so a
    // pooled connection carries no scope from one request into the next.
    forTenant: (tenantScope) => tenantScopedPool(pool, tenantScope),
    // One pinned connection for the whole transaction, so the callback's reads see its own uncommitted writes (see the
    // SqlClient.transaction contract). BEGIN → run → COMMIT, and any throw rolls the whole thing back before it propagates.
    transaction: <T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> =>
      inTransaction(pool, [], (conn) => fn({ query: (sql, params) => unwrap(conn, sql, params) })),
  };
}

/** The pools already listened to — one pool feeds several adapters (main.ts), and each ended connection is said ONCE. */
const LISTENED = new WeakSet<object>();

/**
 * Pool-level handling (verifier r21 IDLE-CRASH): node-postgres emits `'error'` on the pool when the server ends an IDLE pooled
 * connection, and an EventEmitter with no `'error'` listener throws — the process would exit. The pool has already removed the
 * dead connection and opens a fresh one on the next checkout, so the right answer is to SAY it and keep serving.
 */
export function listenForEndedConnections(pool: PgPool, options: PgPoolOptions): void {
  if (pool.on === undefined || LISTENED.has(pool)) return;
  LISTENED.add(pool);
  const say = options.onConnectionEnded ?? ((detail: string) => { process.stderr.write(`${detail}\n`); });
  pool.on('error', (e) => {
    say(`database: the server ended a pooled connection (${describeDbError(e)}); it was discarded and the next request opens a fresh one`);
  });
}

/** The SQL that binds the transaction to one tenant's rows (migration 0012). Transaction-local: gone at COMMIT. */
const SET_TENANT_SCOPE = "SELECT set_config('app.tenant_id', $1, true)";

/**
 * One tenant's view of a pool: each `query` is BEGIN → scope → statement → COMMIT on ONE pinned connection,
 * and `transaction` sets the scope right after BEGIN so every statement in the callback is bound. The
 * connection is released in every path, so a scope never leaks to the next borrower.
 */
function tenantScopedPool(pool: PgPool, tenantScope: string): SqlClient {
  const inScope = <T>(fn: (conn: PgQueryable) => Promise<T>): Promise<T> =>
    inTransaction(pool, [[SET_TENANT_SCOPE, [tenantScope]]], fn);
  return {
    query: (sql, params) => inScope((conn) => unwrap(conn, sql, params)),
    transaction: <T>(fn: (tx: SqlClient) => Promise<T>) =>
      inScope((conn) => fn({ query: (sql, params) => unwrap(conn, sql, params) })),
    forTenant: (scope) => tenantScopedPool(pool, scope),
  };
}
