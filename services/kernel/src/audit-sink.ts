// The audit trail — SEC-03, hard rule #6, §27.
//
// The kernel writes an audit entry for every write and every refusal, through an **optional**
// port — and the composition root never supplied one, so `writeAudit` returned immediately on
// every request. Hard rule #6 says never delete audit evidence; there was none to delete.
//
// Not a crash, and not something any test would have shown: the trail simply was not being kept,
// and the first anybody would know is the day somebody asks who changed a supplier's bank details.

import type { AuditSink } from './pipeline';
import type { SqlClient } from '../../../packages/persistence/src/sql-client';

export class SqlAuditSink implements AuditSink {
  /**
   * @param onFailure Called when an entry cannot be written. **Not optional in spirit**: an audit
   * write that fails silently is worse than no audit at all, because the gap is invisible.
   */
  constructor(
    private readonly client: SqlClient,
    private readonly onFailure: (detail: string) => void,
  ) {}

  async record(entry: {
    readonly tenantId: string; readonly userId: string; readonly method: string;
    readonly path: string; readonly status: number; readonly traceId: string;
    readonly permission: string; readonly idempotencyKey?: string;
  }): Promise<void> {
    try {
      await this.client.query(
        `INSERT INTO audit_log (tenant_id, user_id, method, path, status, permission, trace_id, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          entry.tenantId, entry.userId, entry.method, entry.path,
          entry.status, entry.permission, entry.traceId, entry.idempotencyKey ?? null,
        ],
      );
    } catch (e) {
      // **Reported, never rethrown.** This runs *after* the handler, so the effect has already
      // happened: a sale is banked, a movement is appended, money has moved. Turning a failed
      // audit write into a 500 would tell the till that a sale which succeeded had failed — the
      // exact `wasItSaved: unknown` confusion the three-part error exists to prevent, manufactured
      // by the logging.
      //
      // So the request keeps its true answer and the missing entry becomes loud instead. A gap in
      // an audit trail that nobody is told about is the worst of the three outcomes.
      this.onFailure(
        `AUDIT NOT WRITTEN for ${entry.method} ${entry.path} by ${entry.userId} of ${entry.tenantId} (trace ${entry.traceId}): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}
