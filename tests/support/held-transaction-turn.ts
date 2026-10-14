import pg from 'pg';

/**
 * Tests that deliberately hold a database transaction open take turns.
 *
 * PostgreSQL's visibility fence (`fenceSettled`, the bill-number high-water and the saved store-computer history) waits on
 * ANY open transaction in the cluster — transaction ids are cluster-wide. So two such tests running side by side in
 * `test:db` (files run in parallel on one database) see each other's held transaction and fail on timing alone. Each
 * describe block that holds one takes this turn first: a session-level advisory lock on its own connection, held OUTSIDE
 * any transaction (so it holds no transaction id itself and never stalls anyone's fence).
 */
const TURN_KEY = 7_316_029; // any fixed number; shared by every test that holds a transaction open

export async function takeHeldTransactionTurn(databaseUrl: string): Promise<() => Promise<void>> {
  const client = new pg.Client({ connectionString: databaseUrl, application_name: 'test-held-transaction-turn' });
  await client.connect();
  await client.query('SELECT pg_advisory_lock($1)', [TURN_KEY]);
  return async () => {
    try { await client.query('SELECT pg_advisory_unlock($1)', [TURN_KEY]); } finally { await client.end(); }
  };
}
