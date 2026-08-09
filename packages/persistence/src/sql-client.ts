// SqlClient — the driver-agnostic port to a SQL database. The persistence adapters
// depend only on this interface, never on a concrete driver, so the core stays
// portable (P-06) and testable without a live database. At deployment a thin adapter
// implements it over node-postgres (`pg`) for the cloud and an embedded SQL engine
// for the store edge — see the package README. Parameters are positional ($1, $2…),
// matching PostgreSQL.

export type SqlRow = Record<string, unknown>;

export interface SqlClient {
  /**
   * Execute a parameterised statement and return the result rows (empty for
   * statements that return nothing). Implementations MUST use bound parameters —
   * never string interpolation — so injection is impossible.
   */
  query<R extends SqlRow = SqlRow>(sql: string, params?: readonly unknown[]): Promise<readonly R[]>;

  /**
   * Run `fn` inside a single database transaction: commit if it resolves, roll back if it throws
   * (the error still propagates). This is the port's ATOMICITY primitive — it is how a command that
   * writes more than one row leaves either all of them or none, never a partial set after a crash
   * (audit FND-01 / GAP-DATA-01, hard rule #2's "no silent last-write-wins" cousin).
   *
   * The `tx` handed to `fn` MUST route every query through the SAME connection, so a read inside the
   * callback sees the transaction's own uncommitted writes — a read-back on a different pool
   * connection would not, and that is the subtle bug this contract exists to forbid.
   *
   * OPTIONAL: an embedded engine or a fake test client may not offer real transactions. A caller
   * that needs atomicity checks for `transaction` and, when it is absent, falls back to best-effort
   * sequential writes — and MUST document that a crash can then leave a partial set. Never assume
   * it is present.
   */
  transaction?<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T>;
}
