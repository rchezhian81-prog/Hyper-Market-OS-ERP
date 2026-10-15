import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore, InMemoryEventStore, type EventStore, type ReadOptions } from '../../packages/persistence/src/event-store';
import { SqlSnapshotStore, InMemorySnapshotStore, PROJECTION_BUILD_LEASE_CLASS, type SnapshotStore } from '../../packages/persistence/src/snapshot';
import { makeEvent } from '../../packages/contracts/src/event';
import { STREAM, streamName, storeComputerHistory, boxHistoryBuilding, BOX_HISTORY_INLINE_MAX } from '../../services/api/src/adapters';
import type { BoxHealthRecord } from '../../services/platform/src/box-health';
import { honestStore, TEST_BOX_HISTORY_KEY, iso } from '../support/box-history';

/**
 * **Round 34 · M35-FR-03 · owner decision OB-124 (5) "A" (15 Oct 2026, in writing, "Build all five before pilot"), finishing
 * OB-106 "A" — the background build of the saved store-computer history is single-flight ACROSS head-office processes.**
 *
 *   • PostgreSQL: two (and four) INDEPENDENT head-office service instances — each its own connection pool, event store and
 *     snapshot store — on ONE database read a big store with nothing saved at the same moment. Exactly ONE builds (it holds
 *     the build lease: a session advisory lock, seen in pg_locks); the others never fold a report, never read the whole
 *     stream, and say "being prepared — another head-office process is building it". When it is done, the others use ITS
 *     saved result (resumed, a few rows) and never build it again;
 *   • the lease itself: one holder at a time, never waiting; let go on release — and when the holder's process dies (its
 *     connection ends), so a lock can never be left stuck;
 *   • memory: one process, one build (the in-process guard, kept).
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const BOX = streamName(STREAM.org, 'store-computer-health');

async function put(store: EventStore, T: string, records: readonly BoxHealthRecord[]): Promise<void> {
  for (let i = 0; i < records.length; i += 500) {
    await store.appendBatch(T, records.slice(i, i + 500).map((r, j) => ({
      stream: BOX,
      event: makeEvent({ id: `bh-${i + j}`, type: 'StoreComputerHealthReported', occurredAt: r.receivedAt, idempotencyKey: `bh-${T}-${i + j}`, source: 'test/r34', payload: r }),
    })));
  }
}
const plain = (r: BoxHealthRecord & { seq?: number }): BoxHealthRecord => { const { seq: _s, ...rest } = r; void _s; return rest as BoxHealthRecord; };

/** Reads of the store-computer reports, counted: rows returned, and whole-stream reads (no position, no window). */
function counting(base: EventStore): { store: EventStore; rows: () => number; whole: () => number } {
  let rows = 0;
  let whole = 0;
  const store = new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === 'readStream') {
        return async (tenantId: string, stream: string, opts?: ReadOptions) => {
          const out = await target.readStream(tenantId, stream, opts);
          if (stream === BOX) { rows += out.length; if (opts?.sinceSeq === undefined && opts?.from === undefined) whole += 1; }
          return out;
        };
      }
      const v = Reflect.get(target, prop, receiver) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  return { store, rows: () => rows, whole: () => whole };
}

interface Instance { readonly pool: Pool; readonly store: EventStore; readonly snapshots: SnapshotStore; readonly count: ReturnType<typeof counting>; steps: number }
function instance(): Instance {
  const pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
  const count = counting(new SqlEventStore(pgPoolClient(pool)));
  return { pool, store: count.store, snapshots: new SqlSnapshotStore(pgPoolClient(pool)), count, steps: 0 };
}

async function onlyOneInstanceBuilds(n: number): Promise<void> {
  const instances = Array.from({ length: n }, instance);
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  try {
    const T = randomUUID();
    await instances[0]!.store.registerTenant(T, 'test/r34');
    const records = honestStore((BOX_HISTORY_INLINE_MAX + 760) / 5_760).map(plain);
    await put(instances[0]!.store, T, records);
    const at = iso(Date.parse(records[records.length - 1]!.receivedAt) + 3_600_000);
    // Every instance's build step is counted and HELD at the gate (so a build in progress stays in progress).
    const read = (x: Instance) => storeComputerHistory(x.store, T, at, {
      sealKey: TEST_BOX_HISTORY_KEY, snapshots: x.snapshots, timeZone: 'UTC', waitMs: 0, buildPause: () => { x.steps += 1; return gate; },
    });
    // All at the same moment.
    const first = await Promise.all(instances.map(read));
    for (const r of first) expect(r.preparing).toBeDefined();
    // Wait (bounded) until the one builder has taken its first step.
    const deadline = Date.now() + 60_000;
    while (instances.every((x) => x.steps === 0)) {
      if (Date.now() > deadline) throw new Error('no instance started building');
      await new Promise((resolve) => { setTimeout(resolve, 20); });
    }
    const builders = instances.filter((x) => x.steps > 0);
    expect(builders).toHaveLength(1);
    const builder = builders[0]!;
    const others = instances.filter((x) => x !== builder);
    // The builder holds the lease — a session advisory lock — and only it.
    const locks = await builder.pool.query('SELECT count(*)::int AS n FROM pg_locks WHERE locktype = \'advisory\' AND classid = $1 AND granted', [PROJECTION_BUILD_LEASE_CLASS]);
    expect((locks.rows[0] as { n: number }).n).toBeGreaterThanOrEqual(1);
    // Read again and again from the others while it builds: still "being prepared", never a build, never every report.
    for (let k = 0; k < 3; k += 1) {
      for (const x of others) {
        const r = await read(x);
        expect(r.preparing?.why).toMatch(/another head-office process is building it now/);
      }
    }
    for (const x of others) expect([x.steps, x.count.whole(), x.count.rows()]).toEqual([0, 0, 0]);
    expect(builder.count.whole()).toBe(1); // the one whole read, by the one builder

    // Let it finish: it saves; every other instance then uses ITS result (resumed, a few rows) and builds nothing.
    release();
    await boxHistoryBuilding(builder.snapshots, T);
    for (const x of others) {
      const before = x.count.rows();
      const after = await read(x);
      expect(after.preparing).toBeUndefined();
      expect(after.resumed).toBe(true);
      expect(x.count.rows() - before).toBeLessThan(records.length / 2);
      expect([x.steps, x.count.whole()]).toEqual([0, 0]);
    }
    // The lease was let go.
    const after = await builder.pool.query('SELECT count(*)::int AS n FROM pg_locks l WHERE locktype = \'advisory\' AND classid = $1 AND granted AND l.objid = hashtext($2)::oid', [PROJECTION_BUILD_LEASE_CLASS, `${T}:box-health-history@1`]);
    expect((after.rows[0] as { n: number }).n).toBe(0);
  } finally {
    release();
    await Promise.all(instances.map((x) => x.pool.end()));
  }
}

describe('round 34 · M35-FR-03 · OB-124 (5) / OB-106: one build per shop within a process (memory, the in-process guard)', () => {
  it('M35-FR-03 OB-124 OB-106: reads at the same moment on one process join ONE background build', async () => {
    const counted = counting(new InMemoryEventStore());
    const store = counted.store;
    const snapshots = new InMemorySnapshotStore();
    const T = randomUUID();
    const records = honestStore((BOX_HISTORY_INLINE_MAX + 760) / 5_760).map(plain);
    await put(store, T, records);
    const at = iso(Date.parse(records[records.length - 1]!.receivedAt) + 3_600_000);
    let steps = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const read = () => storeComputerHistory(store, T, at, { sealKey: TEST_BOX_HISTORY_KEY, snapshots, timeZone: 'UTC', waitMs: 0, buildPause: () => { steps += 1; return gate; } });
    const reads = await Promise.all([read(), read(), read(), read()]);
    for (const r of reads) expect(r.preparing).toBeDefined();
    expect(counted.whole()).toBe(1);
    release();
    await boxHistoryBuilding(snapshots, T);
    expect(steps).toBeGreaterThan(0);
    const done = await read();
    expect([done.preparing, done.resumed, counted.whole()]).toEqual([undefined, true, 1]);
  }, 120_000);
});

describe.skipIf(DATABASE_URL === undefined)('round 34 · M35-FR-03 · OB-124 (5) / OB-106: the background build is single-flight across head-office processes (PostgreSQL)', () => {
  it('M35-FR-03 OB-124 OB-106: two independent service instances on one database — exactly one builds; the other waits for its result and never builds', async () => {
    await onlyOneInstanceBuilds(2);
  }, 300_000);
  it('M35-FR-03 OB-124 OB-106: four independent service instances at the same moment — exactly one builds', async () => {
    await onlyOneInstanceBuilds(4);
  }, 300_000);
  it('M35-FR-03 OB-124 OB-106: the lease — one holder, never waiting; let go on release, and when the holder\'s process dies', async () => {
    const a = new Pool({ connectionString: DATABASE_URL, max: 2, options: '-c app.tenant_id=*' });
    const b = new Pool({ connectionString: DATABASE_URL, max: 2, options: '-c app.tenant_id=*' });
    try {
      const A = new SqlSnapshotStore(pgPoolClient(a));
      const B = new SqlSnapshotStore(pgPoolClient(b));
      const T = randomUUID();
      const held = await A.buildLease(T, 'box-health-history@1');
      expect(held).toBeDefined();
      expect(await B.buildLease(T, 'box-health-history@1')).toBeUndefined();
      // Another shop, or another projection, is not held up.
      const other = await B.buildLease(randomUUID(), 'box-health-history@1');
      expect(other).toBeDefined();
      await other!();
      await held!();
      const next = await B.buildLease(T, 'box-health-history@1');
      expect(next).toBeDefined();
      // B's process dies while it holds the lease: its database session is ended (as a crash, or an administrator would),
      // and the lock goes with it.
      const holder = await a.query('SELECT pid FROM pg_locks WHERE locktype = \'advisory\' AND classid = $1 AND objid = hashtext($2)::oid AND granted', [PROJECTION_BUILD_LEASE_CLASS, `${T}:box-health-history@1`]);
      expect(holder.rows).toHaveLength(1);
      await a.query('SELECT pg_terminate_backend($1)', [(holder.rows[0] as { pid: number }).pid]);
      let again: (() => Promise<void>) | undefined;
      const deadline = Date.now() + 30_000;
      while ((again = await A.buildLease(T, 'box-health-history@1')) === undefined) {
        if (Date.now() > deadline) throw new Error('the lock outlived its holder');
        await new Promise((resolve) => { setTimeout(resolve, 50); });
      }
      await again();
      await next!(); // B's own release after its session ended: said nowhere, thrown nowhere
    } finally {
      await a.end();
      await b.end().catch(() => undefined);
    }
  }, 120_000);
});
