import { describe, it, expect } from 'vitest';
import {
  InMemoryEventStore,
  SqlEventStore,
  type EventStore,
  type SqlClient,
  type SqlRow,
} from '../../packages/persistence/src/index';
import { makeEvent } from '../../packages/contracts/src/event';

// The durable event store is append-only, idempotent per tenant, and tenant-isolated
// (§30.2 / §31.1 / ADR-0003). The in-memory reference implementation defines the
// behavioural contract; the SQL adapter is checked against a fake client.

const AT = '2026-08-02T09:00:00Z';

function ev(id: string, key: string, payload: Record<string, unknown> = {}) {
  return makeEvent({
    id,
    type: 'InventoryMoved',
    occurredAt: AT,
    idempotencyKey: key,
    source: 'lane-1',
    payload,
  });
}

/** The behavioural contract — reusable to validate any EventStore (incl. the real DB one). */
function eventStoreContract(makeStore: () => EventStore) {
  it('appends and reads back a tenant stream in order', async () => {
    const store = makeStore();
    await store.append('t1', 'stock', ev('e1', 'k1', { deltaMinor: 5 }));
    await store.append('t1', 'stock', ev('e2', 'k2', { deltaMinor: -2 }));
    const stream = await store.readStream('t1', 'stock');
    expect(stream.map((r) => r.event.id)).toEqual(['e1', 'e2']);
    expect(stream.map((r) => r.seq)).toEqual([1, 2]);
  });

  it('is idempotent on (tenant, idempotency key) — a replay is deduped', async () => {
    const store = makeStore();
    const first = await store.append('t1', 'stock', ev('e1', 'k1'));
    const replay = await store.append('t1', 'stock', ev('e1', 'k1'));
    expect(first.deduped).toBe(false);
    expect(replay.deduped).toBe(true);
    expect(replay.record.seq).toBe(first.record.seq);
    expect(await store.readStream('t1', 'stock')).toHaveLength(1);
  });

  it('isolates tenants — the same key under two tenants is two events', async () => {
    const store = makeStore();
    await store.append('t1', 'stock', ev('e1', 'shared-key'));
    const other = await store.append('t2', 'stock', ev('e2', 'shared-key'));
    expect(other.deduped).toBe(false); // not deduped across tenants
    expect(await store.readStream('t1', 'stock')).toHaveLength(1);
    expect(await store.readStream('t2', 'stock')).toHaveLength(1);
    // a lookup never crosses the tenant boundary
    expect(await store.findByIdempotencyKey('t1', 'shared-key')).toBeDefined();
    expect((await store.findByIdempotencyKey('t2', 'shared-key'))?.event.id).toBe('e2');
  });

  it('separates logical streams within a tenant', async () => {
    const store = makeStore();
    await store.append('t1', 'stock', ev('e1', 'k1'));
    await store.append('t1', 'cash', ev('e2', 'k2'));
    expect(await store.readStream('t1', 'stock')).toHaveLength(1);
    expect(await store.readStream('t1', 'cash')).toHaveLength(1);
  });

  it('exports a tenant\'s whole dataset — every stream, append order, its own tenant only (M36-FR-03)', async () => {
    const store = makeStore();
    await store.append('t1', 'stock', ev('e1', 'k1'));
    await store.append('t1', 'cash', ev('e2', 'k2'));
    await store.append('t2', 'stock', ev('e3', 'k3')); // another tenant's row — must never appear
    const dump = await store.exportTenant('t1');
    expect(dump.map((r) => r.event.id)).toEqual(['e1', 'e2']); // both streams, in seq order
    expect(dump.map((r) => r.seq)).toEqual([1, 2]);
    expect(dump.every((r) => r.tenantId === 't1')).toBe(true); // §35 isolation
    expect(await store.exportTenant('t2')).toHaveLength(1);
  });

  // ---- appendBatch: atomic multi-event append (FND-01 / GAP-DATA-01) ----

  it('appends a batch in order, with consecutive seqs, results lined up one-to-one', async () => {
    const store = makeStore();
    const results = await store.appendBatch('t1', [
      { stream: 'sales', event: ev('e1', 'k1', { n: 1 }) },
      { stream: 'sales', event: ev('e2', 'k2', { n: 2 }) },
    ]);
    expect(results.map((r) => r.deduped)).toEqual([false, false]);
    expect(results.map((r) => r.record.seq)).toEqual([1, 2]);
    expect(results.map((r) => r.record.event.id)).toEqual(['e1', 'e2']);
    expect((await store.readStream('t1', 'sales')).map((r) => r.event.id)).toEqual(['e1', 'e2']);
  });

  it('dedups a whole-batch replay — every event collapses to its first append', async () => {
    const store = makeStore();
    const entries = [
      { stream: 'sales', event: ev('e1', 'k1') },
      { stream: 'sales', event: ev('e2', 'k2') },
    ];
    await store.appendBatch('t1', entries);
    const replay = await store.appendBatch('t1', entries);
    expect(replay.map((r) => r.deduped)).toEqual([true, true]);
    expect(replay.map((r) => r.record.seq)).toEqual([1, 2]); // same rows, no new seqs
    expect(await store.readStream('t1', 'sales')).toHaveLength(2); // nothing appended twice
  });

  it('spans logical streams in one batch and stays tenant-scoped', async () => {
    const store = makeStore();
    await store.appendBatch('t1', [
      { stream: 'sales', event: ev('e1', 'k1') },
      { stream: 'receipts', event: ev('e2', 'k2') },
    ]);
    expect(await store.readStream('t1', 'sales')).toHaveLength(1);
    expect(await store.readStream('t1', 'receipts')).toHaveLength(1);
    expect(await store.readStream('t2', 'sales')).toHaveLength(0);
  });

  it('collapses a duplicate key WITHIN one batch to a single append', async () => {
    const store = makeStore();
    const results = await store.appendBatch('t1', [
      { stream: 'sales', event: ev('e1', 'dup') },
      { stream: 'sales', event: ev('e2', 'dup') },
    ]);
    expect(results[0]!.deduped).toBe(false);
    expect(results[1]!.deduped).toBe(true);
    expect(results[1]!.record.event.id).toBe('e1'); // the second dedups to the first
    expect(await store.readStream('t1', 'sales')).toHaveLength(1);
  });
}

describe('InMemoryEventStore (reference contract)', () => {
  eventStoreContract(() => new InMemoryEventStore());
});

// ---- SqlEventStore adapter, checked against a recording fake SqlClient ----

class FakeSqlClient implements SqlClient {
  readonly calls: { sql: string; params: readonly unknown[] }[] = [];
  private readonly responses: SqlRow[][] = [];

  program(rows: SqlRow[]): this {
    this.responses.push(rows);
    return this;
  }

  query<R extends SqlRow = SqlRow>(sql: string, params: readonly unknown[] = []): Promise<readonly R[]> {
    this.calls.push({ sql, params });
    return Promise.resolve((this.responses.shift() ?? []) as R[]);
  }
}

function row(overrides: Partial<SqlRow> = {}): SqlRow {
  return {
    seq: 1,
    id: 'e1',
    tenant_id: 't1',
    stream: 'stock',
    type: 'InventoryMoved',
    occurred_at: AT,
    idempotency_key: 'k1',
    source: 'lane-1',
    version: 1,
    payload: { deltaMinor: 5 },
    ...overrides,
  };
}

describe('SqlEventStore', () => {
  it('appends with an append-only upsert and maps the returned row', async () => {
    const client = new FakeSqlClient().program([row()]);
    const store = new SqlEventStore(client);
    const result = await store.append('t1', 'stock', ev('e1', 'k1', { deltaMinor: 5 }));

    expect(result.deduped).toBe(false);
    expect(result.record.seq).toBe(1);
    expect(result.record.event.idempotencyKey).toBe('k1');
    // the statement is INSERT … ON CONFLICT DO NOTHING (never DO UPDATE — append-only)
    const sql = client.calls[0]?.sql ?? '';
    expect(sql).toContain('INSERT INTO event_ledger');
    expect(sql).toContain('ON CONFLICT (tenant_id, idempotency_key) DO NOTHING');
    expect(sql).not.toContain('DO UPDATE');
    expect(client.calls[0]?.params?.[1]).toBe('t1'); // tenant_id bound as a parameter
  });

  it('treats a conflict as a deduped replay and reads the existing row', async () => {
    const client = new FakeSqlClient()
      .program([]) // INSERT hit the conflict → no row
      .program([row()]); // follow-up SELECT returns the existing event
    const store = new SqlEventStore(client);
    const result = await store.append('t1', 'stock', ev('e1', 'k1'));
    expect(result.deduped).toBe(true);
    expect(result.record.event.id).toBe('e1');
    expect(client.calls[1]?.sql).toContain('SELECT');
  });

  it('reads a stream ordered by seq and scoped to the tenant', async () => {
    const client = new FakeSqlClient().program([row({ seq: 1, id: 'e1' }), row({ seq: 2, id: 'e2' })]);
    const store = new SqlEventStore(client);
    const stream = await store.readStream('t1', 'stock');
    expect(stream.map((r) => r.event.id)).toEqual(['e1', 'e2']);
    const sql = client.calls[0]?.sql ?? '';
    expect(sql).toContain('WHERE tenant_id = $1 AND stream = $2');
    expect(sql).toContain('ORDER BY seq ASC');
  });

  it('coerces a Date timestamp from the driver to an ISO string', async () => {
    const client = new FakeSqlClient().program([row({ occurred_at: new Date('2026-08-02T09:00:00Z') })]);
    const store = new SqlEventStore(client);
    const found = await store.findByIdempotencyKey('t1', 'k1');
    expect(found?.event.occurredAt).toBe('2026-08-02T09:00:00.000Z');
  });

  it('exports a tenant across all streams, scoped by tenant_id and ordered by seq (M36-FR-03)', async () => {
    const client = new FakeSqlClient().program([
      row({ seq: 1, id: 'e1', stream: 'stock' }),
      row({ seq: 2, id: 'e2', stream: 'cash' }),
    ]);
    const store = new SqlEventStore(client);
    const dump = await store.exportTenant('t1');
    expect(dump.map((r) => r.event.id)).toEqual(['e1', 'e2']);
    const sql = client.calls[0]?.sql ?? '';
    // No stream filter — the whole tenant; the tenant is the ONLY bound scope (§35 isolation).
    expect(sql).toContain('WHERE tenant_id = $1');
    expect(sql).not.toContain('stream = $2');
    expect(sql).toContain('ORDER BY seq ASC');
    expect(client.calls[0]?.params).toEqual(['t1']);
  });
});

// ---- SqlEventStore.appendBatch atomicity, against a client that models real transactions ----

/**
 * A SqlClient that actually models `event_ledger` with ON CONFLICT DO NOTHING **and** genuine
 * transaction semantics: a transaction stages into a private copy of the table and publishes it
 * only if the callback resolves, so a throw mid-batch leaves the committed table untouched. This is
 * what lets us prove `SqlEventStore.appendBatch` is crash-atomic (FND-01) without a live database —
 * a fake that just recorded calls could not.
 */
class TransactionalSqlClient implements SqlClient {
  private committed = new Map<string, SqlRow>();
  private seq = 0;
  /** When set, an INSERT for this idempotency key throws — a failure part-way through a batch. */
  failOnKey?: string;

  query<R extends SqlRow = SqlRow>(sql: string, params: readonly unknown[] = []): Promise<readonly R[]> {
    return Promise.resolve(this.exec(this.committed, sql, params) as R[]);
  }

  async transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> {
    const staging = new Map(this.committed);
    const seqBefore = this.seq;
    const tx = {
      query: (sql: string, params: readonly unknown[] = []) =>
        Promise.resolve(this.exec(staging, sql, params)),
    } as SqlClient;
    try {
      const out = await fn(tx);
      this.committed = staging; // COMMIT — publish the staged rows
      return out;
    } catch (err) {
      this.seq = seqBefore; // ROLLBACK — discard staging and the seqs it consumed
      throw err;
    }
  }

  private exec(rows: Map<string, SqlRow>, sql: string, params: readonly unknown[]): SqlRow[] {
    if (sql.includes('INSERT INTO event_ledger')) {
      const [id, tenantId, stream, type, occurredAt, key, source, version, payload] = params as [
        string, string, string, string, string, string, string, number, string,
      ];
      if (this.failOnKey === key) throw new Error(`simulated failure inserting ${key}`);
      const composite = `${tenantId}::${key}`;
      if (rows.has(composite)) return []; // ON CONFLICT DO NOTHING
      this.seq += 1;
      const record: SqlRow = {
        seq: this.seq, id, tenant_id: tenantId, stream, type,
        occurred_at: occurredAt, idempotency_key: key, source, version,
        payload: JSON.parse(payload) as unknown,
      };
      rows.set(composite, record);
      return [record];
    }
    if (sql.includes('idempotency_key = $2')) { // conflict read-back / findByIdempotencyKey
      const [tenantId, key] = params as [string, string];
      const found = rows.get(`${tenantId}::${key}`);
      return found ? [found] : [];
    }
    return [];
  }
}

describe('SqlEventStore.appendBatch atomicity (FND-01)', () => {
  it('commits a batch through the transaction primitive and dedups a whole-batch replay', async () => {
    const store = new SqlEventStore(new TransactionalSqlClient());
    const entries = [
      { stream: 'sales', event: ev('e1', 'k1') },
      { stream: 'sales', event: ev('e2', 'k2') },
    ];
    const first = await store.appendBatch('t1', entries);
    expect(first.map((r) => r.deduped)).toEqual([false, false]);
    expect(await store.findByIdempotencyKey('t1', 'k1')).toBeDefined();
    const replay = await store.appendBatch('t1', entries);
    expect(replay.map((r) => r.deduped)).toEqual([true, true]);
  });

  it('rolls the WHOLE batch back when one append fails — no partial set survives', async () => {
    const client = new TransactionalSqlClient();
    client.failOnKey = 'k2'; // the second event blows up after the first has inserted
    const store = new SqlEventStore(client);
    await expect(store.appendBatch('t1', [
      { stream: 'sales', event: ev('e1', 'k1') },
      { stream: 'sales', event: ev('e2', 'k2') },
    ])).rejects.toThrow(/simulated/);
    // The first insert was rolled back with the failing second — neither is in the ledger.
    expect(await store.findByIdempotencyKey('t1', 'k1')).toBeUndefined();
    expect(await store.findByIdempotencyKey('t1', 'k2')).toBeUndefined();
  });

  it('reads a conflict back on the transaction\'s own connection — sees its uncommitted write', async () => {
    // Same key twice in one batch: the second conflicts with the first, which is visible ONLY on the
    // transactional connection (not yet committed). A read-back on a different pool connection would
    // find nothing and throw "conflicted but no row was found" — so this passing proves appendBatch
    // reads back on the transaction client, the subtle correctness point the port contract calls out.
    const store = new SqlEventStore(new TransactionalSqlClient());
    const results = await store.appendBatch('t1', [
      { stream: 'sales', event: ev('e1', 'dup') },
      { stream: 'sales', event: ev('e2', 'dup') },
    ]);
    expect(results[0]!.deduped).toBe(false);
    expect(results[1]!.deduped).toBe(true);
    expect(results[1]!.record.event.id).toBe('e1'); // dedups to the first
  });
});
