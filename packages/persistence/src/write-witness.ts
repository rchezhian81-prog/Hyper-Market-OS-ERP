// Verifier r22 D1 (P-08) — what one request has already COMMITTED, so a failure can be told truthfully.
//
// A request runs several database transactions: the handler's reads and writes (each its own transaction on a pooled
// connection), then the idempotency row, then the audit write. When the database ends a session part-way, the transaction
// on it is rolled back whole — but an EARLIER transaction of the same request may already have committed. "Nothing was
// saved" is only true when nothing of the request committed before. The SQL adapter (pg-client.ts) notes on the witness of
// the request it runs inside (AsyncLocalStorage — no request object is threaded through the stores) every transaction that
// WROTE and committed, and how many transactions are still open; the pipeline reads it when the failure reaches it.

import { AsyncLocalStorage } from 'node:async_hooks';

export interface WriteWitness {
  /** Transactions of this request that wrote something and whose COMMIT succeeded. */
  committedWrites: number;
  /** Transactions of this request still running (another one may yet commit). */
  open: number;
}

const current = new AsyncLocalStorage<WriteWitness>();

export const newWriteWitness = (): WriteWitness => ({ committedWrites: 0, open: 0 });

/** Run `fn` with `w` as the witness every transaction it starts reports to. */
export function witnessing<T>(w: WriteWitness, fn: () => Promise<T>): Promise<T> {
  return current.run(w, fn);
}

/** The witness of the request this code runs inside, if any. */
export const currentWriteWitness = (): WriteWitness | undefined => current.getStore();

/**
 * A statement that cannot change anything: a SELECT (or SHOW) naming no data-changing word. Anything else counts as a write —
 * the safe direction: a read mistaken for a write only turns "not saved" into "check first", never the other way round.
 * (No function in the schema writes when SELECTed: db/migrations define only trigger guards and the tenant-scope reader.)
 * Verifier r23 (LOW): `SELECT … INTO` (creates a table), `pg_notify(…)` (sends a notification other sessions act on), the
 * large-object functions (`lo_unlink`, `lo_import`, `lo_create`, `lo_put` …) and `dblink_exec` change things from inside a
 * SELECT — each counts as a write too.
 */
export const isReadOnlyStatement = (sql: string): boolean =>
  /^\s*(SELECT|SHOW)\b/i.test(sql)
  && !/\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|CREATE|DROP|ALTER|COPY|INTO|nextval|setval|pg_notify|lo_\w+|dblink_exec)\b/i.test(sql);
