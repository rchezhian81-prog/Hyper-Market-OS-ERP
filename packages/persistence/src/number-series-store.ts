// Durable gap-free number series (M01-FR-02) — the persistent backing for the numbering engine
// (packages/numbering). `allocate` hands out the next sequence number for a (tenant, doc_type),
// gap-free and unique, even under concurrent callers; `peek` reads the next number without taking
// it. Multi-tenant (ADR-0003): the series is per (tenant, doc_type), so tenants never share a run.
// Depends only on the `SqlClient` port; the in-memory store is the behavioural contract.

import type { SqlClient, SqlRow } from './sql-client';

export interface NumberSeriesStore {
  /** Allocate the next sequence number for a tenant's document type (gap-free, unique, >= 1). */
  allocate(tenantId: string, docType: string): Promise<number>;
  /** The next number that WOULD be allocated (1 when the series has never been used). */
  peek(tenantId: string, docType: string): Promise<number>;
}

// A colon separates the two parts — neither a tenant id (a UUID) nor a document type (a bare word)
// contains one, so two distinct (tenant, doc_type) pairs never fold to the same map key.
function key(tenantId: string, docType: string): string {
  return `${tenantId}:${docType}`;
}

/** In-memory reference implementation — the behavioural contract, tenant-scoped. */
export class InMemoryNumberSeriesStore implements NumberSeriesStore {
  private readonly next = new Map<string, number>();

  allocate(tenantId: string, docType: string): Promise<number> {
    const k = key(tenantId, docType);
    const seq = this.next.get(k) ?? 1;
    this.next.set(k, seq + 1);
    return Promise.resolve(seq);
  }

  peek(tenantId: string, docType: string): Promise<number> {
    return Promise.resolve(this.next.get(key(tenantId, docType)) ?? 1);
  }
}

/**
 * SQL-backed gap-free series over `number_series` (migration 0009) via the `SqlClient` port.
 *
 * Allocation is a single atomic statement: the `ON CONFLICT DO UPDATE` takes a row lock, so two
 * concurrent allocations for the same (tenant, doc_type) serialize on the row — they can neither
 * hand out the same number nor leave a gap. `RETURNING next_seq - 1` yields the number just taken
 * (the row now holds the NEXT one). This is the standard, contention-safe sequence generator; the
 * in-memory store above is the same behaviour for single-threaded tests.
 */
export class SqlNumberSeriesStore implements NumberSeriesStore {
  constructor(private readonly client: SqlClient) {}

  async allocate(tenantId: string, docType: string): Promise<number> {
    const rows = await this.client.query<SqlRow>(
      `INSERT INTO number_series (tenant_id, doc_type, next_seq)
       VALUES ($1, $2, 2)
       ON CONFLICT (tenant_id, doc_type)
       DO UPDATE SET next_seq = number_series.next_seq + 1, updated_at = now()
       RETURNING next_seq - 1 AS seq`,
      [tenantId, docType],
    );
    return Number(rows[0]!['seq']);
  }

  async peek(tenantId: string, docType: string): Promise<number> {
    const rows = await this.client.query<SqlRow>(
      `SELECT next_seq FROM number_series WHERE tenant_id = $1 AND doc_type = $2`,
      [tenantId, docType],
    );
    return rows.length > 0 ? Number(rows[0]!['next_seq']) : 1;
  }
}
