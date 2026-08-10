import { describe, it, expect } from 'vitest';
import {
  InMemorySnapshotStore, SqlSnapshotStore,
  type Snapshot, type SnapshotStore,
} from '../../packages/persistence/src/index';
import type { SqlClient, SqlRow } from '../../packages/persistence/src/index';

// CORE-03 inc2: the durable SQL snapshot store must behave exactly like the in-memory reference —
// round-trip, load-missing, newest-write-wins, and independent (tenant, stream, projection) keys.
// The in-memory store defines the contract; the SQL adapter is checked against a fake client that
// models the one table's SELECT and its UPSERT (incl. the JSONB round-trip through JSON, so a
// non-serialisable state would be caught here rather than in production).

const snap = <S>(over: Partial<Snapshot<S>> & { state: S }): Snapshot<S> => ({
  tenantId: 't1', stream: 'finance', projection: 'p@1',
  result: { state: over.state, watermarkSeq: 7, lastEventAt: '2026-08-10T00:00:00Z', eventCount: 3 },
  takenAt: '2026-08-10T00:00:00Z',
  ...over,
});

/** The behavioural contract — reusable to validate any SnapshotStore. */
function snapshotStoreContract(make: () => SnapshotStore) {
  it('round-trips a saved snapshot', async () => {
    const store = make();
    await store.save(snap({ state: { a: 1, b: 2 } }));
    const got = await store.load<{ a: number; b: number }>('t1', 'finance', 'p@1');
    expect(got?.result.state).toEqual({ a: 1, b: 2 });
    expect(got?.result.watermarkSeq).toBe(7);
  });

  it('returns undefined for a key that was never saved', async () => {
    const store = make();
    expect(await store.load('t1', 'finance', 'never')).toBeUndefined();
  });

  it('newest write wins for a key (a snapshot advances, it does not accumulate)', async () => {
    const store = make();
    await store.save(snap({ state: { n: 1 } }));
    await store.save(snap({ state: { n: 2 }, result: { state: { n: 2 }, watermarkSeq: 12, lastEventAt: null, eventCount: 5 } }));
    const got = await store.load<{ n: number }>('t1', 'finance', 'p@1');
    expect(got?.result.state).toEqual({ n: 2 });
    expect(got?.result.watermarkSeq).toBe(12);
  });

  it('keeps (tenant, stream, projection) keys independent', async () => {
    const store = make();
    await store.save(snap({ state: { v: 'a' }, tenantId: 't1' }));
    await store.save(snap({ state: { v: 'b' }, tenantId: 't2' }));
    await store.save(snap({ state: { v: 'c' }, stream: 'other' }));
    await store.save(snap({ state: { v: 'd' }, projection: 'p@2' }));
    expect((await store.load<{ v: string }>('t1', 'finance', 'p@1'))?.result.state.v).toBe('a');
    expect((await store.load<{ v: string }>('t2', 'finance', 'p@1'))?.result.state.v).toBe('b');
    expect((await store.load<{ v: string }>('t1', 'other', 'p@1'))?.result.state.v).toBe('c');
    expect((await store.load<{ v: string }>('t1', 'finance', 'p@2'))?.result.state.v).toBe('d');
  });
}

describe('InMemorySnapshotStore (reference contract)', () => {
  snapshotStoreContract(() => new InMemorySnapshotStore());
});

/** A SqlClient that models `projection_snapshot`: SELECT by key, and INSERT … ON CONFLICT DO UPDATE. */
class FakeSnapshotSqlClient implements Pick<SqlClient, 'query'> {
  private readonly table = new Map<string, unknown>();
  private key(t: unknown, s: unknown, p: unknown): string { return `${t} ${s} ${p}`; }

  query<R extends SqlRow = SqlRow>(sql: string, params: readonly unknown[] = []): Promise<readonly R[]> {
    if (/^\s*SELECT/i.test(sql)) {
      const data = this.table.get(this.key(params[0], params[1], params[2]));
      return Promise.resolve((data === undefined ? [] : [{ data }]) as unknown as readonly R[]);
    }
    // INSERT … ON CONFLICT DO UPDATE — round-trip through JSON exactly as JSONB would.
    this.table.set(this.key(params[0], params[1], params[2]), JSON.parse(params[3] as string));
    return Promise.resolve([] as R[]);
  }
}

describe('SqlSnapshotStore (against a fake client modelling the table)', () => {
  snapshotStoreContract(() => new SqlSnapshotStore(new FakeSnapshotSqlClient()));

  it('loads via SELECT by the composite key and saves via an UPSERT', async () => {
    const calls: { sql: string; params: readonly unknown[] }[] = [];
    const recording: Pick<SqlClient, 'query'> = {
      query: <R extends SqlRow = SqlRow>(sql: string, params: readonly unknown[] = []) => {
        calls.push({ sql, params });
        return Promise.resolve([] as R[]);
      },
    };
    const store = new SqlSnapshotStore(recording);
    await store.save(snap({ state: { x: 1 } }));
    await store.load('t1', 'finance', 'p@1');

    expect(calls[0]!.sql).toMatch(/INSERT INTO projection_snapshot[\s\S]*ON CONFLICT[\s\S]*DO UPDATE/i);
    expect(calls[0]!.params.slice(0, 3)).toEqual(['t1', 'finance', 'p@1']);
    expect(calls[1]!.sql).toMatch(/^\s*SELECT data FROM projection_snapshot/i);
  });
}
);
