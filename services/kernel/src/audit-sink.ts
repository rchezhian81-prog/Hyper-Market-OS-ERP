// The audit trail — SEC-03, SEC-07, hard rule #6, §27, audit FND-02.
//
// The kernel writes an audit entry for every write and every refusal, through an **optional**
// port — and the composition root never supplied one, so `writeAudit` returned immediately on
// every request. Hard rule #6 says never delete audit evidence; there was none to delete.
//
// Not a crash, and not something any test would have shown: the trail simply was not being kept,
// and the first anybody would know is the day somebody asks who changed a supplier's bank details.
//
// Now the trail is not only kept but **sealed**: each row carries the SHA-256 hash of the row before
// it (per tenant, §35), so a row inserted, removed or reordered behind the database is detectable by
// `verifyAuditChain` (audit FND-02 / GAP-SEC-03). The seal is computed here and checked by the
// verify tool from the SAME definition in `./audit-chain`, so the two cannot drift.

import type { AuditSink } from './pipeline';
import type { SqlClient } from '../../../packages/persistence/src/sql-client';
import { GENESIS_HASH, auditChainHash, type SealedAuditFields } from './audit-chain';

export class SqlAuditSink implements AuditSink {
  /**
   * @param client The database. When it offers the transaction primitive (a `pgPoolClient`, as the
   *   deployment wires — audit FND-01), each write runs in one transaction that first takes a
   *   per-tenant advisory lock, so two concurrent audit writes cannot fork the chain. A query-only
   *   client (a test's `pg.Client`) writes without the lock, which is safe under the sequential use
   *   those callers make.
   * @param onFailure Called when an entry cannot be written. **Not optional in spirit**: an audit
   *   write that fails silently is worse than no audit at all, because the gap is invisible.
   * @param now The clock, injected so the sealed timestamp is deterministic and testable.
   */
  constructor(
    private readonly client: SqlClient,
    private readonly onFailure: (detail: string) => void,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async record(entry: {
    readonly tenantId: string; readonly userId: string; readonly method: string;
    readonly path: string; readonly status: number; readonly traceId: string;
    readonly permission: string; readonly idempotencyKey?: string;
  }): Promise<void> {
    const sealed: SealedAuditFields = {
      tenantId: entry.tenantId, userId: entry.userId, method: entry.method, path: entry.path,
      status: entry.status, permission: entry.permission, traceId: entry.traceId,
      idempotencyKey: entry.idempotencyKey ?? null, recordedAt: this.now(),
    };
    try {
      // Serialize a tenant's chain when we can (a real transaction), so the read of the previous
      // hash and the insert of the next row are one atomic, non-interleaved step. Without the
      // primitive, fall back to a direct write — correct under the sequential use of a plain client.
      if (this.client.transaction !== undefined) {
        await this.client.transaction((tx) => this.appendSealed(tx, sealed, true));
      } else {
        await this.appendSealed(this.client, sealed, false);
      }
    } catch (e) {
      // **Reported, never rethrown.** This runs *after* the handler, so the effect has already
      // happened: a sale is banked, a movement is appended, money has moved. Turning a failed
      // audit write into a 500 would tell the till that a sale which succeeded had failed — the
      // exact `wasItSaved: unknown` confusion the three-part error exists to prevent, manufactured
      // by the logging. So the request keeps its true answer and the missing entry becomes loud.
      this.onFailure(
        `AUDIT NOT WRITTEN for ${entry.method} ${entry.path} by ${entry.userId} of ${entry.tenantId} (trace ${entry.traceId}): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /** Read the tenant's last seal, chain this row onto it, and append — all on the one client `q`. */
  private async appendSealed(q: SqlClient, sealed: SealedAuditFields, serialize: boolean): Promise<void> {
    if (serialize) {
      // Per-tenant lock, held to the end of the transaction: the next writer for this tenant waits,
      // so it reads THIS row as the predecessor rather than racing to the same one.
      await q.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [sealed.tenantId]);
    }
    const previous = await q.query<{ hash: string | null }>(
      'SELECT hash FROM audit_log WHERE tenant_id = $1 ORDER BY seq DESC LIMIT 1',
      [sealed.tenantId],
    );
    // A predecessor with no seal (an unsealed legacy row) is treated as the genesis, so the chain
    // begins cleanly at the first sealed row after this migration.
    const prevHash = previous[0]?.hash ?? GENESIS_HASH;
    const hash = auditChainHash(prevHash, sealed);
    await q.query(
      `INSERT INTO audit_log
         (tenant_id, user_id, method, path, status, permission, trace_id, idempotency_key, recorded_at, prev_hash, hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        sealed.tenantId, sealed.userId, sealed.method, sealed.path, sealed.status,
        sealed.permission, sealed.traceId, sealed.idempotencyKey, sealed.recordedAt, prevHash, hash,
      ],
    );
  }
}
