// Durable idempotency — §31.1, SEC-03, hard rule #4 adjacent.
//
// `MemoryIdempotencyStore` carries the comment "real deployments swap the port for PostgreSQL",
// and `main()` was using it. The guard it backs is the one that refuses a **different** request
// sent under an already-used `Idempotency-Key` — the control that stops a sale of 400 being
// answered with the stored result of a sale of 250 — and in memory it fails in two ways that no
// test would show and every deployment would meet:
//
//   • a restart or a deploy empties it, so the guard silently stops applying to every key minted
//     before the restart;
//   • two API instances behind a load balancer never share it, so the guard does not apply at all.
//
// Neither is a crash. Both are the control quietly not being there.

import type { IdempotencyStore, StoredResult } from './pipeline';
import type { SqlClient } from '../../../packages/persistence/src/sql-client';

export class SqlIdempotencyStore implements IdempotencyStore {
  constructor(private readonly client: SqlClient) {}

  async get(tenantId: string, key: string): Promise<StoredResult | undefined> {
    const rows = await this.client.query(
      'SELECT request_hash, status, body FROM idempotency_keys WHERE tenant_id = $1 AND key = $2',
      [tenantId, key],
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    return {
      requestHash: String(row['request_hash']),
      status: Number(row['status']),
      body: row['body'],
    };
  }

  /**
   * Record what we answered — **once**.
   *
   * `ON CONFLICT DO NOTHING`, never an upsert. The first answer under a key is the answer, and
   * rewriting it is exactly the confusion the guard exists to prevent: two requests racing under
   * one key would otherwise leave the second's result stored against the first's hash, and every
   * subsequent retry would be told about a request that never happened.
   */
  async put(tenantId: string, key: string, record: StoredResult): Promise<void> {
    await this.client.query(
      `INSERT INTO idempotency_keys (tenant_id, key, request_hash, status, body)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, key) DO NOTHING`,
      [tenantId, key, record.requestHash, record.status, JSON.stringify(record.body ?? null)],
    );
  }
}
