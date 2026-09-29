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

  /**
   * A view of this client whose every statement runs under ONE tenant's scope — the database's row-level
   * security (migration 0012, GAP-DATA-02) then shows and accepts only that tenant's rows, whatever the SQL
   * says. The scope is `app.tenant_id`, set per TRANSACTION from the SIGNED token's tenant and nothing else;
   * `PLATFORM_TENANT_SCOPE` ('*') is the operator tools' whole-database view, never the API's.
   *
   * OPTIONAL: an embedded engine or a fake may not offer it. A store calls `client.forTenant?.(tenantId) ??
   * client` — where the view is absent the statement runs as before, and a database with RLS then refuses an
   * unscoped statement (fail closed) rather than leaking.
   */
  forTenant?(tenantScope: string): SqlClient;
}

/** The operator tools' whole-database scope for row-level security. The API never sets it. */
export const PLATFORM_TENANT_SCOPE = '*';

/** The client to run a tenant's statements on: its scoped view where the port offers one, else itself. */
export const scopedTo = (client: SqlClient, tenantScope: string): SqlClient => client.forTenant?.(tenantScope) ?? client;
