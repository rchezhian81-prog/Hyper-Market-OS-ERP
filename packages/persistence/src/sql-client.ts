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
}
