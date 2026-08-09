// Durable event store (roadmap §30.2 / §31.1, hard rule #2) — the async, tenant-
// scoped persistence behind the append-only ledger. The offline-first EDGE hot path
// commits to the synchronous in-memory `LedgerStore` (packages/ledger) and queues to
// the outbox; this store is the DURABLE log (embedded SQL at the edge, PostgreSQL in
// the cloud) that events are written through and that the sync agent drains into.
//
// The contract mirrors the sync `LedgerStore` but async and multi-tenant:
//   • append is idempotent on (tenantId, idempotencyKey) — a replay returns the
//     existing row (deduped), never a second effect (§31.1);
//   • the key is scoped to the tenant, so the same key under two tenants is two
//     distinct events (ADR-0003 / §35 — never cross-tenant);
//   • there is NO update/delete — a correction is a new compensating event (#2).

import type { DomainEvent } from '../../contracts/src/event';
import type { SqlClient, SqlRow } from './sql-client';

/** An event as persisted: the domain event plus its tenant, stream and append seq. */
export interface PersistedEvent<TType extends string = string, TPayload = unknown> {
  readonly seq: number;
  readonly tenantId: string;
  readonly stream: string;
  readonly event: DomainEvent<TType, TPayload>;
}

export interface ReadOptions {
  /** Only events after this append sequence — the tail behind a snapshot. */
  readonly sinceSeq?: number;
  readonly type?: string;
  /**
   * Only events that happened in `[from, to)`, by `occurredAt`.
   *
   * Served by `event_ledger_type_idx` on `(tenant_id, type, occurred_at)`. This is what makes
   * "today's takings" a read of today rather than a read of every sale the shop has ever made
   * followed by a filter — and the owner looks at that number daily, so it is the one query in the
   * system guaranteed to be run against the largest table every morning forever.
   */
  readonly from?: string;
  readonly to?: string;
}

export interface AppendResult {
  readonly record: PersistedEvent;
  readonly deduped: boolean;
}

/** One event bound for a stream — the unit of an atomic multi-event append. */
export interface BatchEntry {
  readonly stream: string;
  readonly event: DomainEvent;
}

/** The durable, append-only, tenant-scoped event store. */
export interface EventStore {
  /** Append an event to a tenant's logical stream; idempotent on its idempotency key. */
  append(tenantId: string, stream: string, event: DomainEvent): Promise<AppendResult>;
  /**
   * Append several events for one tenant **atomically** — all of them commit, or none do. This is
   * the boundary a money-critical command draws around its events (audit FND-01 / GAP-DATA-01): a
   * sale writes both its `SaleCommitted` and its receipt-number index, and a crash between the two
   * must not leave a sale with no receipt or a receipt with no sale. Each entry keeps its own
   * idempotency key, so a whole-batch retry dedups every event independently and the result array
   * lines up one-to-one with `entries`, in order.
   *
   * Atomicity comes from the SQL store running the batch inside one transaction; a store or client
   * that cannot (an embedded engine, a fake) writes sequentially, which is still idempotent but no
   * longer crash-atomic — the SQL adapter is the one that guarantees the boundary.
   */
  appendBatch(tenantId: string, entries: readonly BatchEntry[]): Promise<readonly AppendResult[]>;
  /** Find an event by its idempotency key within a tenant (dedupe lookup). */
  findByIdempotencyKey(tenantId: string, idempotencyKey: string): Promise<PersistedEvent | undefined>;
  /**
   * Events in a tenant's stream, in append order — the projection scan.
   *
   * `sinceSeq` and `type` narrow it **at the store**, not afterwards. That distinction is the
   * whole value: a caller that reads a million events and keeps forty has still read a million,
   * and no amount of filtering in the application makes the read cheaper. It is also invisible to
   * a timing test, because filtering a million rows is quick compared with folding them — which is
   * why the test that guards this counts rows rather than milliseconds.
   */
  readStream(tenantId: string, stream: string, opts?: ReadOptions): Promise<readonly PersistedEvent[]>;
  /**
   * The most recent event of one type in a stream, **without reading the ones before it**.
   *
   * "Current" is a fold, and folding is what makes the ledger the only truth — but *the latest of
   * a type* is a fold with an answer at the end of the stream, and reading forward to reach it is
   * work nobody needs. The catalogue is the case that forced this: a shop publishing a price list
   * a day has 365 packs a year, each one holding its entire product master, and answering "which
   * version are we on?" was deserialising all of them to look at the last.
   */
  latestOfType(tenantId: string, stream: string, type: string): Promise<PersistedEvent | undefined>;
  /**
   * Every event a tenant holds, across all its streams, in append order — the tenant's whole
   * dataset, for export (M36-FR-03: a tenant owns and can export its data, P-06 / OD-09).
   * Strictly tenant-scoped: it never returns another tenant's rows, which is the critical
   * isolation guarantee (§35). A full read by design — an export reads everything — so it is a
   * deliberate, governed call, not a hot path, and it removes nothing (hard rule #6).
   */
  exportTenant(tenantId: string): Promise<readonly PersistedEvent[]>;
}

function tenantKey(tenantId: string, idempotencyKey: string): string {
  // NUL separator can't appear in either id, so the composite key is unambiguous.
  return `${tenantId}\u0000${idempotencyKey}`;
}

/**
 * In-memory reference implementation — the behavioural contract every EventStore
 * must satisfy (used in tests and at the store edge before a durable store is
 * wired). Append-only: it exposes no way to change or remove a stored event.
 */
export class InMemoryEventStore implements EventStore {
  private readonly records: PersistedEvent[] = [];
  private readonly byKey = new Map<string, PersistedEvent>();
  /**
   * Streams, indexed.
   *
   * Without this, `readStream` filtered every record the store held — so reading a stream with
   * three events in it cost the same as reading one with three hundred thousand, and the reference
   * implementation quietly stopped modelling the contract it exists to define. It matters beyond
   * tests: this is the store the edge runs on.
   */
  private readonly byStream = new Map<string, PersistedEvent[]>();
  private seq = 0;

  append(tenantId: string, stream: string, event: DomainEvent): Promise<AppendResult> {
    return this.appendBatch(tenantId, [{ stream, event }]).then((r) => r[0]!);
  }

  appendBatch(tenantId: string, entries: readonly BatchEntry[]): Promise<readonly AppendResult[]> {
    // All-or-nothing without a database: STAGE every entry (resolving dedups against both the
    // committed store and earlier entries in this same batch), then apply the staged records in one
    // mutation pass. Single-threaded JS has no await points here, so the batch is atomic by
    // construction — the crash-in-the-middle a partial batch would represent cannot occur.
    const results: AppendResult[] = [];
    const staged: PersistedEvent[] = [];
    const stagedByKey = new Map<string, PersistedEvent>();
    let nextSeq = this.seq;
    for (const { stream, event } of entries) {
      const key = tenantKey(tenantId, event.idempotencyKey);
      const existing = this.byKey.get(key) ?? stagedByKey.get(key);
      if (existing) {
        results.push({ record: existing, deduped: true });
        continue;
      }
      nextSeq += 1;
      const record: PersistedEvent = Object.freeze({ seq: nextSeq, tenantId, stream, event });
      staged.push(record);
      stagedByKey.set(key, record);
      results.push({ record, deduped: false });
    }
    // Commit — one pass, no interleaving, so either every staged record lands or (on no staging) none.
    for (const record of staged) {
      this.records.push(record);
      this.byKey.set(tenantKey(record.tenantId, record.event.idempotencyKey), record);
      const skey = tenantKey(record.tenantId, record.stream);
      const inStream = this.byStream.get(skey);
      if (inStream === undefined) this.byStream.set(skey, [record]); else inStream.push(record);
    }
    this.seq = nextSeq;
    return Promise.resolve(results);
  }

  findByIdempotencyKey(tenantId: string, idempotencyKey: string): Promise<PersistedEvent | undefined> {
    return Promise.resolve(this.byKey.get(tenantKey(tenantId, idempotencyKey)));
  }

  readStream(tenantId: string, stream: string, opts?: ReadOptions): Promise<readonly PersistedEvent[]> {
    const inStream = this.byStream.get(tenantKey(tenantId, stream)) ?? [];
    // Binary search rather than a filter: the array is seq-ordered by construction, so the tail
    // can be found without touching the head. Scanning past a million events to reach the last
    // forty is the exact cost this parameter exists to avoid, and doing it here would mean the
    // reference implementation quietly did not honour its own contract.
    const from = opts?.sinceSeq === undefined ? 0 : lowerBound(inStream, opts.sinceSeq);
    const tail = from === 0 ? inStream : inStream.slice(from);
    const matches = (r: PersistedEvent): boolean =>
      (opts?.type === undefined || r.event.type === opts.type)
      && (opts?.from === undefined || r.event.occurredAt >= opts.from)
      && (opts?.to === undefined || r.event.occurredAt < opts.to);
    return Promise.resolve(
      opts === undefined || (opts.type === undefined && opts.from === undefined && opts.to === undefined)
        ? tail : tail.filter(matches),
    );
  }

  exportTenant(tenantId: string): Promise<readonly PersistedEvent[]> {
    // The master list is seq-ordered by construction, so a filter over it yields the tenant's
    // whole history in append order. Only this tenant's rows — never another's (§35).
    return Promise.resolve(this.records.filter((r) => r.tenantId === tenantId));
  }

  latestOfType(tenantId: string, stream: string, type: string): Promise<PersistedEvent | undefined> {
    const inStream = this.byStream.get(tenantKey(tenantId, stream)) ?? [];
    for (let i = inStream.length - 1; i >= 0; i -= 1) {
      const record = inStream[i]!;
      if (record.event.type === type) return Promise.resolve(record);
    }
    return Promise.resolve(undefined);
  }
}

/** Index of the first record with `seq > since`, by binary search over a seq-ordered array. */
function lowerBound(records: readonly PersistedEvent[], since: number): number {
  let lo = 0;
  let hi = records.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (records[mid]!.seq > since) hi = mid; else lo = mid + 1;
  }
  return lo;
}

/** Map an event_ledger row (snake_case) to a PersistedEvent. */
function rowToPersisted(row: SqlRow): PersistedEvent {
  const occurredAt = row['occurred_at'];
  return Object.freeze({
    seq: Number(row['seq']),
    tenantId: String(row['tenant_id']),
    stream: String(row['stream']),
    event: Object.freeze({
      id: String(row['id']),
      type: String(row['type']),
      // The client returns timestamptz as an ISO-8601 string (driver type parser).
      occurredAt: typeof occurredAt === 'string' ? occurredAt : new Date(String(occurredAt)).toISOString(),
      idempotencyKey: String(row['idempotency_key']),
      source: String(row['source']),
      version: Number(row['version']),
      payload: row['payload'],
    }),
  });
}

const COLUMNS = 'seq, id, tenant_id, stream, type, occurred_at, idempotency_key, source, version, payload';

/**
 * SQL-backed event store over the `event_ledger` table (migration 0001). Depends
 * only on the `SqlClient` port, so it runs against PostgreSQL in the cloud or an
 * embedded SQL engine at the edge, and is testable with a fake client. Append uses
 * INSERT … ON CONFLICT DO NOTHING (a mutating upsert is deliberately never used —
 * this log is append-only) and reads back on conflict, so a replay is idempotent.
 */
export class SqlEventStore implements EventStore {
  constructor(private readonly client: SqlClient) {}

  async append(tenantId: string, stream: string, event: DomainEvent): Promise<AppendResult> {
    return (await this.appendBatch(tenantId, [{ stream, event }]))[0]!;
  }

  appendBatch(tenantId: string, entries: readonly BatchEntry[]): Promise<readonly AppendResult[]> {
    // A batch of two or more runs in ONE transaction when the client offers one, so a crash between
    // two events of a command leaves the ledger with all of them or none (FND-01). A single event is
    // already atomic on its own — a lone INSERT needs no transaction, so the common single-append
    // path pays no BEGIN/COMMIT overhead. A client without a transaction primitive (an embedded
    // engine, a fake) falls back to sequential appends: still idempotent, but the atomicity of a
    // multi-event batch then rests on the SQL adapter, as the contract says.
    const run = (client: SqlClient): Promise<AppendResult[]> => this.appendAllWith(client, tenantId, entries);
    return entries.length > 1 && this.client.transaction
      ? this.client.transaction(run)
      : run(this.client);
  }

  /**
   * Append every entry through one client, in order. The read-back after a conflict uses the SAME
   * `client` — inside a transaction that is the transactional connection, so it sees this batch's
   * own uncommitted inserts; using `this.client` (a different pool connection) would not.
   */
  private async appendAllWith(
    client: SqlClient, tenantId: string, entries: readonly BatchEntry[],
  ): Promise<AppendResult[]> {
    const results: AppendResult[] = [];
    for (const { stream, event } of entries) {
      const inserted = await client.query(
        `INSERT INTO event_ledger (id, tenant_id, stream, type, occurred_at, idempotency_key, source, version, payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
         RETURNING ${COLUMNS}`,
        [
          event.id,
          tenantId,
          stream,
          event.type,
          event.occurredAt,
          event.idempotencyKey,
          event.source,
          event.version,
          JSON.stringify(event.payload),
        ],
      );
      if (inserted.length > 0) {
        results.push({ record: rowToPersisted(inserted[0]!), deduped: false });
        continue;
      }
      // A conflicting row already exists — read it back on this same client and dedup.
      const existing = await client.query(
        `SELECT ${COLUMNS} FROM event_ledger WHERE tenant_id = $1 AND idempotency_key = $2`,
        [tenantId, event.idempotencyKey],
      );
      if (existing.length === 0) {
        throw new Error(`Append for "${event.idempotencyKey}" conflicted but no row was found.`);
      }
      results.push({ record: rowToPersisted(existing[0]!), deduped: true });
    }
    return results;
  }

  async findByIdempotencyKey(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<PersistedEvent | undefined> {
    const rows = await this.client.query(
      `SELECT ${COLUMNS} FROM event_ledger WHERE tenant_id = $1 AND idempotency_key = $2`,
      [tenantId, idempotencyKey],
    );
    return rows.length > 0 ? rowToPersisted(rows[0]!) : undefined;
  }

  async readStream(
    tenantId: string, stream: string, opts?: ReadOptions,
  ): Promise<readonly PersistedEvent[]> {
    // `event_ledger_stream_idx` is (tenant_id, stream, seq), so `seq > $3` is a range scan from a
    // position rather than a read of the stream with a filter over it; `event_ledger_type_idx` on
    // (tenant_id, type, occurred_at) serves the time window.
    const rows = await this.client.query(
      `SELECT ${COLUMNS} FROM event_ledger
       WHERE tenant_id = $1 AND stream = $2
         AND ($3::bigint IS NULL OR seq > $3::bigint)
         AND ($4::text IS NULL OR type = $4::text)
         AND ($5::timestamptz IS NULL OR occurred_at >= $5::timestamptz)
         AND ($6::timestamptz IS NULL OR occurred_at < $6::timestamptz)
       ORDER BY seq ASC`,
      [tenantId, stream, opts?.sinceSeq ?? null, opts?.type ?? null, opts?.from ?? null, opts?.to ?? null],
    );
    return rows.map(rowToPersisted);
  }

  async latestOfType(
    tenantId: string, stream: string, type: string,
  ): Promise<PersistedEvent | undefined> {
    // `event_ledger_stream_type_idx` (migration 0006) makes this an index scan of one row rather
    // than a read of the whole stream. Without the index it is still correct and still slow, which
    // is the failure mode worth being explicit about.
    const rows = await this.client.query(
      `SELECT ${COLUMNS} FROM event_ledger
       WHERE tenant_id = $1 AND stream = $2 AND type = $3
       ORDER BY seq DESC LIMIT 1`,
      [tenantId, stream, type],
    );
    return rows.length > 0 ? rowToPersisted(rows[0]!) : undefined;
  }

  async exportTenant(tenantId: string): Promise<readonly PersistedEvent[]> {
    // One tenant's whole ledger, in append order. `WHERE tenant_id = $1` is the isolation
    // boundary — a bug here leaks one retailer's data to another (§35), so the export never
    // widens beyond the single bound parameter.
    const rows = await this.client.query(
      `SELECT ${COLUMNS} FROM event_ledger WHERE tenant_id = $1 ORDER BY seq ASC`,
      [tenantId],
    );
    return rows.map(rowToPersisted);
  }
}
