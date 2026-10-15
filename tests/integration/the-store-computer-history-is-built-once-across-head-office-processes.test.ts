import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool, Client } from 'pg';
import { pgPoolClient, pgDedicatedSession } from '../../packages/persistence/src/pg-client';
import { SqlEventStore, InMemoryEventStore, type EventStore, type ReadOptions } from '../../packages/persistence/src/event-store';
import { SqlSnapshotStore, InMemorySnapshotStore, PROJECTION_BUILD_LEASE_CLASS, type SnapshotStore, type BuildLeaseHeld } from '../../packages/persistence/src/snapshot';
import { makeEvent } from '../../packages/contracts/src/event';
import { STREAM, streamName, storeComputerHistory, boxHistoryBuilding, boxHistoryLeaseKept, BOX_HISTORY_INLINE_MAX } from '../../services/api/src/adapters';
import type { BoxHealthRecord } from '../../services/platform/src/box-health';
import { honestStore, TEST_BOX_HISTORY_KEY, iso } from '../support/box-history';

/**
 * **Round 34 · M35-FR-03 · owner decision OB-124 (5) "A" (15 Oct 2026, in writing, "Build all five before pilot"), finishing
 * OB-106 "A" — the background build of the saved store-computer history is single-flight ACROSS head-office processes.**
 * **Round 35 · verifier r34 NEW-4 — and it stays single-flight under load.**
 *
 *   • PostgreSQL: two (and four) INDEPENDENT head-office service instances — each its own connection pool, event store and
 *     snapshot store, its build lease on a connection of its own — on ONE database read a big store with nothing saved at the
 *     same moment. Exactly ONE builds (it holds the build lease: a session advisory lock, seen in pg_locks); the others never
 *     fold a report, never read the whole stream, and say "being prepared — another head-office process is building it";
 *   • round 35 (NEW-4): this is run TWICE — on a quiet database, and with a write transaction held open elsewhere for the
 *     whole build, which holds the visibility fence back (exactly what a busy database does) so the builder cannot save its
 *     result at once. Before round 35 the builder then let go of the lease with its result only in its memory, and another
 *     instance built the whole history again. Now the builder KEEPS the lease until the result is saved — the others keep
 *     saying "being prepared — another head-office process is building it now", reading nothing — and once the transaction
 *     ends it saves by itself (no read needed), its position moved up, and lets go. The others then read only the reports
 *     after it (a few rows, never every report) and NEVER build;
 *   • round 35 (NEW-4): a builder whose lease session is ended under it (idle-session timeout, network, administrator) STOPS
 *     at its next step and says so — it never builds alongside the instance that takes the lease next;
 *   • the lease itself: one holder at a time, never waiting; let go on release — and when the holder's process dies (its
 *     connection ends), so a lock can never be left stuck;
 *   • memory: one process, one build (the in-process guard, kept).
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const BOX = streamName(STREAM.org, 'store-computer-health');
const LEASE_KEY = (T: string): string => `${T}:box-health-history@1`;

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

interface Instance { readonly pool: Pool; readonly store: EventStore; readonly snapshots: SqlSnapshotStore; readonly count: ReturnType<typeof counting>; steps: number; problems: string[] }
function instance(): Instance {
  const pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
  const count = counting(new SqlEventStore(pgPoolClient(pool)));
  const problems: string[] = [];
  // As main.ts composes it: the build lease on a connection of its own (round 35 · NEW-2), with a connect timeout.
  const leaseSession = pgDedicatedSession(() => new Client({ connectionString: DATABASE_URL, options: '-c app.tenant_id=*', connectionTimeoutMillis: 10_000 }));
  return { pool, store: count.store, snapshots: new SqlSnapshotStore(pgPoolClient(pool), { leaseSession, onLeaseProblem: (d) => { problems.push(d); } }), count, steps: 0, problems };
}
const leaseHolders = async (pool: Pool, T: string): Promise<number[]> =>
  (await pool.query('SELECT pid FROM pg_locks WHERE locktype = \'advisory\' AND classid = $1 AND objid = hashtext($2)::oid AND granted', [PROJECTION_BUILD_LEASE_CLASS, LEASE_KEY(T)])).rows.map((r) => (r as { pid: number }).pid);
const savedRow = async (pool: Pool, T: string): Promise<boolean> =>
  (await pool.query('SELECT 1 FROM projection_snapshot WHERE tenant_id = $1 AND projection = $2', [T, 'box-health-history@1'])).rows.length === 1;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

async function onlyOneInstanceBuilds(n: number, opts: { readonly holdFence: boolean }): Promise<void> {
  const instances = Array.from({ length: n }, instance);
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  // A write transaction held open elsewhere on the database (it has a transaction id): the visibility fence cannot settle.
  const blocker = opts.holdFence ? new Client({ connectionString: DATABASE_URL, options: '-c app.tenant_id=*' }) : undefined;
  try {
    const T = randomUUID();
    await instances[0]!.store.registerTenant(T, 'test/r34');
    const records = honestStore((BOX_HISTORY_INLINE_MAX + 760) / 5_760).map(plain);
    await put(instances[0]!.store, T, records);
    if (blocker !== undefined) {
      await blocker.connect();
      await blocker.query('BEGIN');
      await blocker.query('SELECT pg_current_xact_id()');
      // ...and a later transaction commits (as on any busy database): the open one is now below every fence's horizon.
      await instances[0]!.pool.query('SELECT pg_current_xact_id()');
    }
    const at = iso(Date.parse(records[records.length - 1]!.receivedAt) + 3_600_000);
    // Every instance's build step is counted and HELD at the gate (so a build in progress stays in progress).
    const read = (x: Instance) => storeComputerHistory(x.store, T, at, {
      sealKey: TEST_BOX_HISTORY_KEY, snapshots: x.snapshots, timeZone: 'UTC', waitMs: 0, saveRetryMs: 50, buildPause: () => { x.steps += 1; return gate; },
    });
    // All at the same moment.
    const first = await Promise.all(instances.map(read));
    for (const r of first) expect(r.preparing).toBeDefined();
    // Wait (bounded) until the one builder has taken its first step.
    const deadline = Date.now() + 60_000;
    while (instances.every((x) => x.steps === 0)) {
      if (Date.now() > deadline) throw new Error('no instance started building');
      await sleep(20);
    }
    const builders = instances.filter((x) => x.steps > 0);
    expect(builders).toHaveLength(1);
    const builder = builders[0]!;
    const others = instances.filter((x) => x !== builder);
    // The builder holds the lease — a session advisory lock — and only it.
    expect(await leaseHolders(builder.pool, T)).toHaveLength(1);
    // Read again and again from the others while it builds: still "being prepared", never a build, never every report.
    for (let k = 0; k < 3; k += 1) {
      for (const x of others) {
        const r = await read(x);
        expect(r.preparing?.why).toMatch(/another head-office process is building it now/);
      }
    }
    for (const x of others) expect([x.steps, x.count.whole(), x.count.rows()]).toEqual([0, 0, 0]);
    expect(builder.count.whole()).toBe(1); // the one whole read, by the one builder

    // Let it finish building.
    release();
    await boxHistoryBuilding(builder.snapshots, T);
    if (blocker !== undefined) {
      // NEW-4: saving is held back by the open transaction. The builder KEEPS the lease (its result only in its memory), and
      // every other instance keeps saying "being prepared — another head-office process is building it now", reading nothing.
      expect(await savedRow(builder.pool, T)).toBe(false);
      expect(boxHistoryLeaseKept(builder.snapshots, T)).toBeDefined();
      expect(await leaseHolders(builder.pool, T)).toHaveLength(1);
      for (let k = 0; k < 3; k += 1) {
        for (const x of others) expect((await read(x)).preparing?.why).toMatch(/another head-office process is building it now/);
        await sleep(100);
      }
      for (const x of others) expect([x.steps, x.count.whole(), x.count.rows()]).toEqual([0, 0, 0]);
      // The transaction ends: the builder saves by ITSELF (nobody reads it) and lets go of the lease.
      await blocker.query('ROLLBACK');
    }
    // The others read meanwhile, every 100 ms — each answer is "being prepared — another process is building it" until the
    // saved result is there, then that result; they NEVER build, never read every report. (Bounded: a busy database may hold
    // a fence back for a while — the builder keeps its lease until then.)
    const until = Date.now() + 120_000;
    const pending = new Set(others);
    while (pending.size > 0) {
      if (Date.now() > until) throw new Error('the builder never saved its result');
      for (const x of [...pending]) {
        const before = x.count.rows();
        const r = await read(x);
        if (r.preparing !== undefined) { expect(r.preparing.why).toMatch(/another head-office process is building it now/); expect(x.count.rows()).toBe(before); continue; }
        expect(r.resumed).toBe(true);
        // Only the reports after the saved result's position — its position moved up when it was saved — never every report.
        expect(x.count.rows() - before).toBeLessThan(records.length / 10);
        pending.delete(x);
      }
      await sleep(100);
    }
    for (const x of others) expect([x.steps, x.count.whole()]).toEqual([0, 0]);
    expect(builder.count.whole()).toBe(1);
    expect(await savedRow(builder.pool, T)).toBe(true);
    // The lease was let go once the result was saved.
    await boxHistoryLeaseKept(builder.snapshots, T);
    expect(await leaseHolders(builder.pool, T)).toEqual([]);
    for (const x of instances) expect(x.problems).toEqual([]);
  } finally {
    release();
    if (blocker !== undefined) await blocker.end().catch(() => undefined);
    await Promise.all(instances.map((x) => x.pool.end()));
  }
}

describe('round 34 · M35-FR-03 · OB-124 (5) / OB-106: one build per shop within a process (memory, the in-process guard)', () => {
  it('M35-FR-03 OB-124 OB-106: reads at the same moment on one process join ONE background build', async () => {
    const counted = counting(new InMemoryEventStore());
    const store = counted.store;
    const snapshots: SnapshotStore = new InMemorySnapshotStore();
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
    await onlyOneInstanceBuilds(2, { holdFence: false });
  }, 300_000);
  it('M35-FR-03 OB-124 OB-106: four independent service instances at the same moment — exactly one builds', async () => {
    await onlyOneInstanceBuilds(4, { holdFence: false });
  }, 300_000);
  it('M35-FR-03 OB-124 OB-106 NEW-4: saving held back by an open transaction — the builder keeps the lease until it is saved; the other three never build again', async () => {
    await onlyOneInstanceBuilds(4, { holdFence: true });
  }, 300_000);
  it('M35-FR-03 OB-124 OB-106 NEW-4: the builder\'s lease session is ended mid-build — it stops at its next step and says so; never two builders at once', async () => {
    const [a, b] = [instance(), instance()];
    let openA: () => void = () => undefined;
    const gateA = new Promise<void>((resolve) => { openA = resolve; });
    let openB: () => void = () => undefined;
    const gateB = new Promise<void>((resolve) => { openB = resolve; });
    try {
      const T = randomUUID();
      await a.store.registerTenant(T, 'test/r35');
      const records = honestStore((BOX_HISTORY_INLINE_MAX + 760) / 5_760).map(plain);
      await put(a.store, T, records);
      const at = iso(Date.parse(records[records.length - 1]!.receivedAt) + 3_600_000);
      const read = (x: Instance, gate: Promise<void>) => storeComputerHistory(x.store, T, at, {
        sealKey: TEST_BOX_HISTORY_KEY, snapshots: x.snapshots, timeZone: 'UTC', waitMs: 0, saveRetryMs: 50, buildPause: () => { x.steps += 1; return gate; },
      });
      expect((await read(a, gateA)).preparing).toBeDefined();
      const deadline = Date.now() + 60_000;
      while (a.steps === 0) { if (Date.now() > deadline) throw new Error('A never started'); await sleep(20); }
      // The database ends A's lease session (as an idle-session timeout, a network cut or an administrator would).
      const [pid] = await leaseHolders(a.pool, T);
      await a.pool.query('SELECT pg_terminate_backend($1)', [pid]);
      while ((await leaseHolders(a.pool, T)).length > 0) await sleep(20);
      // B now takes the lease and builds; A, let go at its gate, STOPS at its next step — it takes no further step.
      expect((await read(b, gateB)).preparing).toBeDefined();
      while (b.steps === 0) { if (Date.now() > deadline) throw new Error('B never started'); await sleep(20); }
      const stepsA = a.steps;
      openA();
      await boxHistoryBuilding(a.snapshots, T);
      expect(a.steps).toBe(stepsA);
      const saidByA = await read(a, gateA);
      expect(saidByA.history.lastBuildFailed?.error).toMatch(/build lease's database session ended under the build/);
      expect(saidByA.preparing?.why).toMatch(/another head-office process is building it now/);
      expect(await savedRow(a.pool, T)).toBe(false);
      // B finishes and saves; A then uses B's result.
      openB();
      await boxHistoryBuilding(b.snapshots, T);
      await boxHistoryLeaseKept(b.snapshots, T);
      const until = Date.now() + 120_000;
      let done = await read(a, gateA);
      while (done.preparing !== undefined) { if (Date.now() > until) throw new Error('never saved'); await sleep(100); done = await read(a, gateA); }
      expect(done.resumed).toBe(true);
      expect(a.count.whole()).toBe(1); // its one read before the lease was lost — never a second
      expect(b.count.whole()).toBe(1);
    } finally {
      openA(); openB();
      await Promise.all([a.pool.end(), b.pool.end()]);
    }
  }, 300_000);
  it('M35-FR-03 OB-124 OB-106: the lease — one holder, never waiting; let go on release, and when the holder\'s process dies', async () => {
    const a = new Pool({ connectionString: DATABASE_URL, max: 2, options: '-c app.tenant_id=*' });
    const b = new Pool({ connectionString: DATABASE_URL, max: 2, options: '-c app.tenant_id=*' });
    try {
      const A = new SqlSnapshotStore(pgPoolClient(a));
      const B = new SqlSnapshotStore(pgPoolClient(b));
      const T = randomUUID();
      const held = await A.buildLease(T, 'box-health-history@1') as BuildLeaseHeld | undefined;
      expect(held).toBeDefined();
      expect(await B.buildLease(T, 'box-health-history@1')).toBeUndefined();
      // Another shop, or another projection, is not held up.
      const other = await B.buildLease(randomUUID(), 'box-health-history@1') as BuildLeaseHeld | undefined;
      expect(other).toBeDefined();
      await other!();
      await held!();
      const next = await B.buildLease(T, 'box-health-history@1') as BuildLeaseHeld | undefined;
      expect(next).toBeDefined();
      expect(next!.lost()).toBe(false);
      // B's process dies while it holds the lease: its database session is ended (as a crash, or an administrator would),
      // and the lock goes with it.
      const holder = await leaseHolders(a, T);
      expect(holder).toHaveLength(1);
      await a.query('SELECT pg_terminate_backend($1)', [holder[0]]);
      let again: BuildLeaseHeld | undefined;
      const deadline = Date.now() + 30_000;
      while ((again = await A.buildLease(T, 'box-health-history@1') as BuildLeaseHeld | undefined) === undefined) {
        if (Date.now() > deadline) throw new Error('the lock outlived its holder');
        await sleep(50);
      }
      expect(next!.lost()).toBe(true); // round 35 · NEW-4: the holder can tell
      await again();
      await next!(); // B's own release after its session ended: thrown nowhere
      // Round 35 · NEW-3: a pooled lease session is never handed back — nothing of it is left in either pool.
      expect([a.totalCount - a.idleCount, b.totalCount - b.idleCount]).toEqual([0, 0]);
    } finally {
      await a.end();
      await b.end().catch(() => undefined);
    }
  }, 120_000);
});
