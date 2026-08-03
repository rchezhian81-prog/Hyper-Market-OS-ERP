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
});
