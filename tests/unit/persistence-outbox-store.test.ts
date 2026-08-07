import { describe, it, expect } from 'vitest';
import {
  InMemoryOutboxStore,
  SqlOutboxStore,
  type OutboxStore,
  type SqlClient,
  type SqlRow,
} from '../../packages/persistence/src/index';
import { makeEvent } from '../../packages/contracts/src/event';

// The durable outbox is tenant-scoped, idempotent, retries then dead-letters poison
// items (never dropped, hard rule #6). The in-memory reference defines the contract;
// the SQL adapter is checked against a fake client.

const AT = '2026-08-02T09:00:00Z';

function ev(id: string, key: string) {
  return makeEvent({ id, type: 'SaleCommitted', occurredAt: AT, idempotencyKey: key, source: 'lane-1', payload: {} });
}

function outboxContract(makeStore: () => OutboxStore) {
  it('enqueues idempotently and lists pending per tenant', async () => {
    const store = makeStore();
    await store.enqueue('t1', ev('e1', 'k1'));
    await store.enqueue('t1', ev('e1', 'k1')); // replay
    expect(await store.pending('t1')).toHaveLength(1);
  });

  it('acknowledges an item out of pending', async () => {
    const store = makeStore();
    await store.enqueue('t1', ev('e1', 'k1'));
    await store.acknowledge('t1', 'k1');
    expect(await store.pending('t1')).toHaveLength(0);
    expect((await store.find('t1', 'k1'))?.state).toBe('acknowledged');
  });

  it('retries then dead-letters after maxAttempts (never dropped)', async () => {
    const store = makeStore();
    await store.enqueue('t1', ev('e1', 'k1'));
    await store.recordFailure('t1', 'k1', 'apply failed', 3);
    await store.recordFailure('t1', 'k1', 'apply failed', 3);
    expect((await store.find('t1', 'k1'))?.state).toBe('pending'); // still retrying
    const dead = await store.recordFailure('t1', 'k1', 'apply failed', 3);
    expect(dead?.state).toBe('dead_letter');
    expect(await store.deadLetters('t1')).toHaveLength(1);
    expect(await store.pending('t1')).toHaveLength(0);
  });

  it('isolates tenants — same key under two tenants is two items', async () => {
    const store = makeStore();
    await store.enqueue('t1', ev('e1', 'shared'));
    await store.enqueue('t2', ev('e2', 'shared'));
    expect(await store.pending('t1')).toHaveLength(1);
    expect(await store.pending('t2')).toHaveLength(1);
    await store.acknowledge('t1', 'shared');
    expect(await store.pending('t1')).toHaveLength(0);
    expect(await store.pending('t2')).toHaveLength(1); // t2 untouched
  });
}

describe('InMemoryOutboxStore (reference contract)', () => {
  outboxContract(() => new InMemoryOutboxStore());
});

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
    tenant_id: 't1',
    idem_key: 'k1',
    event: { id: 'e1', type: 'SaleCommitted', occurredAt: AT, idempotencyKey: 'k1', source: 'lane-1', version: 1, payload: {} },
    state: 'pending',
    attempts: 0,
    reason: null,
    ...overrides,
  };
}

describe('SqlOutboxStore', () => {
  it('enqueues with an idempotent upsert and maps the row', async () => {
    const client = new FakeSqlClient().program([row()]);
    const store = new SqlOutboxStore(client);
    const rec = await store.enqueue('t1', ev('e1', 'k1'));
    expect(rec.key).toBe('k1');
    expect(rec.state).toBe('pending');
    const sql = client.calls[0]?.sql ?? '';
    expect(sql).toContain('INSERT INTO sync_outbox');
    expect(sql).toContain('ON CONFLICT (tenant_id, idem_key) DO NOTHING');
  });

  it('acknowledges by binding the target state as a parameter (no SQL literal)', async () => {
    const client = new FakeSqlClient().program([]);
    const store = new SqlOutboxStore(client);
    await store.acknowledge('t1', 'k1');
    const sql = client.calls[0]?.sql ?? '';
    expect(sql).toContain('UPDATE sync_outbox');
    expect(sql).toContain('SET state = $1'); // state is a bound parameter
    expect(client.calls[0]?.params?.[0]).toBe('acknowledged');
  });

  it('dead-letters a poison item after maxAttempts and returns it', async () => {
    const client = new FakeSqlClient().program([row({ state: 'dead_letter', attempts: 3, reason: 'apply failed' })]);
    const store = new SqlOutboxStore(client);
    const rec = await store.recordFailure('t1', 'k1', 'apply failed', 3);
    expect(rec?.state).toBe('dead_letter');
    // the dead-letter state is passed as a parameter, never inlined into the statement
    const params = client.calls[0]?.params ?? [];
    expect(params).toContain('dead_letter');
  });

  it('lists the dead-letter queue scoped to the tenant', async () => {
    const client = new FakeSqlClient().program([row({ state: 'dead_letter' })]);
    const store = new SqlOutboxStore(client);
    const dead = await store.deadLetters('t1');
    expect(dead).toHaveLength(1);
    expect(client.calls[0]?.sql).toContain('WHERE tenant_id = $1 AND state = $2');
  });
});
