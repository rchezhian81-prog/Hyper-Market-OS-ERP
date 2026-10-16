import { describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool, Client } from 'pg';
import { pgPoolClient, pgDedicatedSession, DedicatedSessionTimeoutError } from '../../packages/persistence/src/pg-client';
import { SqlEventStore, InMemoryEventStore, type EventStore } from '../../packages/persistence/src/event-store';
import { SqlSnapshotStore, InMemorySnapshotStore, PROJECTION_BUILD_LEASE_CLASS, type BuildLeaseAnswer, type Snapshot } from '../../packages/persistence/src/snapshot';
import { makeEvent } from '../../packages/contracts/src/event';
import {
  STREAM, streamName, storeComputerHistory, boxHistoryBuilding, boxHistoryLeaseKept, BOX_HISTORY_INLINE_MAX, type StoreComputerHistoryReading,
} from '../../services/api/src/adapters';
import type { BoxHealthRecord } from '../../services/platform/src/box-health';
import { honestStore, TEST_BOX_HISTORY_KEY, iso } from '../support/box-history';
import { takeHeldTransactionTurn } from '../support/held-transaction-turn';

/**
 * **Round 36 · M35-FR-03 · OB-106 / OB-124 (5) · verifier r35 NEW-2, NEW-5, NEW-7 — the build lease kept while a result waits to
 * be saved; on memory and on PostgreSQL.**
 *
 *   • NEW-2: saving is held back (an open transaction holds the visibility fence). The builder keeps the lease. More than 64
 *     new reports arrive and a read folds them onto the held result, holding a NEWER one. Before round 36 the keeper then let go
 *     of the lease with nothing saved (another head-office process could build it all again). Now the lease is kept until the
 *     newest held result is saved — then let go. PostgreSQL: the lock is seen in pg_locks all along, and a second head-office
 *     instance says "another head-office process is building it now" and never builds;
 *   • NEW-5: a kept lease no longer counts against the builds' limit — with the builds' room (1 here) taken by nobody and the
 *     kept room full, a SMALL shop folds at once (before: "waiting its turn" for up to 30 minutes) and a big one builds; only
 *     builds themselves take turns. With no room left to keep, a lease is let go (said in STATUS: extra work only);
 *   • NEW-7: the late reports the keeper folds are judged with the bill counts, registered tills and acts as they are WHEN it
 *     folds — the answers equal those of a normal read folding the same reports at that moment.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const BOX = streamName(STREAM.org, 'store-computer-health');
const LANES = streamName(STREAM.org, 'store-computer-lane-prefixes');
const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

const plain = (r: BoxHealthRecord & { seq?: number }): BoxHealthRecord => { const { seq: _s, ...rest } = r; void _s; return rest as BoxHealthRecord; };
async function put(store: EventStore, T: string, records: readonly BoxHealthRecord[], from = 0): Promise<void> {
  for (let i = 0; i < records.length; i += 500) {
    await store.appendBatch(T, records.slice(i, i + 500).map((r, j) => ({
      stream: BOX,
      event: makeEvent({ id: `bh-${from + i + j}`, type: 'StoreComputerHealthReported', occurredAt: r.receivedAt, idempotencyKey: `bh-${T}-${from + i + j}`, source: 'test/r36', payload: r }),
    })));
  }
}

class HeldFenceStore extends InMemoryEventStore {
  hold = true;
  override fenceSettled(): Promise<boolean> { return Promise.resolve(!this.hold); }
}
/** A memory snapshot store with a cluster-wide lease, counted (one holder; `keep` as the SQL store's). */
class LeasingSnapshots extends InMemorySnapshotStore {
  holders = 0; taken = 0; saves = 0; kept = 0;
  override save<S>(s: Snapshot<S>): Promise<void> { this.saves += 1; return super.save<S>(s); }
  buildLease(): Promise<BuildLeaseAnswer> {
    if (this.holders > 0) return Promise.resolve(undefined);
    this.holders += 1; this.taken += 1;
    let freed = false;
    return Promise.resolve(Object.assign(async () => { if (!freed) { freed = true; this.holders -= 1; } }, { lost: () => false, keep: () => { this.kept += 1; return true; } }));
  }
}

/** A big store's first reports, 200 more after them (in order, about 50 minutes of one store computer), and the read moments. */
function aBigStore() {
  const all = honestStore((BOX_HISTORY_INLINE_MAX + 760 + 200) / 5_760).map(plain);
  const first = all.slice(0, BOX_HISTORY_INLINE_MAX + 760);
  const later = all.slice(BOX_HISTORY_INLINE_MAX + 760);
  return { all, first, later, at1: iso(Date.parse(first.at(-1)!.receivedAt) + 60_000), at2: iso(Date.parse(all.at(-1)!.receivedAt) + 15 * 60_000) };
}

/** Round 37: a memory snapshot store whose saves wait at a gate (a slow database), counted, with the saved results kept. */
class GatedSnapshots extends LeasingSnapshots {
  gate: Promise<void> | undefined;
  waiting = false;
  savedCounts: number[] = [];
  override async save<S>(s: Snapshot<S>): Promise<void> {
    if (this.gate !== undefined) { this.waiting = true; await this.gate; }
    this.savedCounts.push((s.result as { eventCount: number }).eventCount);
    return super.save<S>(s);
  }
}

describe('round 37 · M35-FR-03 · OB-106 · coordinator (CI on PR #785): a newer result held while a save is under way is never dropped (memory)', () => {
  it('M35-FR-03 OB-106 NEW-2: the kept lease saves, a read holds a NEWER result meanwhile — it stays held and is saved next', async () => {
    const store = new HeldFenceStore();
    const snaps = new GatedSnapshots();
    const T = randomUUID();
    const all = honestStore((BOX_HISTORY_INLINE_MAX + 760 + 300) / 5_760).map(plain);
    const first = all.slice(0, BOX_HISTORY_INLINE_MAX + 760);
    const later = all.slice(first.length, first.length + 200);
    const more = all.slice(first.length + 200);
    let at = iso(Date.parse(first.at(-1)!.receivedAt) + 60_000);
    const read = () => storeComputerHistory(store, T, at, { sealKey: TEST_BOX_HISTORY_KEY, snapshots: snaps, timeZone: 'UTC', waitMs: 0, saveRetryMs: 50 });
    await put(store, T, first);
    await read();
    await boxHistoryBuilding(snaps, T);
    await put(store, T, later, first.length);
    // (Read a minute after the 200: the reports that come after them are never "late" for the result the keeper saves.)
    at = iso(Date.parse(later.at(-1)!.receivedAt) + 60_000);
    await read(); // holds a newer result (first + 200)
    // The fence settles: the kept lease starts saving — and the database is slow.
    let open: () => void = () => undefined;
    snaps.gate = new Promise<void>((r) => { open = r; });
    store.hold = false;
    for (let i = 0; i < 500 && !snaps.waiting; i += 1) await sleep(20);
    expect(snaps.waiting).toBe(true); // the kept lease's save is under way
    // While that save waits, the fence is held again and a read folds 100 more reports onto the held result (newer still).
    store.hold = true;
    await put(store, T, more, first.length + later.length);
    at = iso(Date.parse(all.at(-1)!.receivedAt) + 15 * 60_000);
    const r = await read();
    expect(r.preparing).toBeUndefined(); // folded onto the held result, not set aside
    expect(r.resumed).toBe(true);
    expect(r.history.saveHeld).not.toBeNull();
    open();
    snaps.gate = undefined;
    await sleep(300);
    expect(snaps.savedCounts).toHaveLength(1); // the save that was under way: the older result
    // Round 36: the save's end dropped the newer result (held: nothing; lease let go) — it was never saved.
    expect(snaps.holders).toBe(1); // still kept: there is a newer result to save
    store.hold = false;
    await boxHistoryLeaseKept(snaps, T);
    expect(snaps.holders).toBe(0);
    // The NEWEST result (it folded the 100 more) is the one saved last.
    expect(snaps.savedCounts).toHaveLength(2);
    expect(snaps.savedCounts[1]).toBeGreaterThan(snaps.savedCounts[0]!);
  }, 120_000);
});

describe('round 36 · M35-FR-03 · OB-106 · verifier r35 NEW-2: the kept lease is held until the NEWEST held result is saved (memory)', () => {
  it('M35-FR-03 OB-106 NEW-2: 200 new reports folded onto the held result — the lease stays held, unsaved, until the fence settles; then saved and let go', async () => {
    const store = new HeldFenceStore();
    const snaps = new LeasingSnapshots();
    const T = randomUUID();
    const { first, later, at1, at2 } = aBigStore();
    await put(store, T, first);
    let at = at1;
    const read = () => storeComputerHistory(store, T, at, { sealKey: TEST_BOX_HISTORY_KEY, snapshots: snaps, timeZone: 'UTC', waitMs: 0, saveRetryMs: 50 });
    await read();
    await boxHistoryBuilding(snaps, T);
    await sleep(200);
    expect([snaps.holders, snaps.saves, snaps.kept]).toEqual([1, 0, 1]); // kept (round 35), out of the builds' count (NEW-5)
    await put(store, T, later, first.length);
    at = at2;
    const r = await read();
    expect(r.resumed).toBe(true);
    expect(r.history.saveHeld).not.toBeNull();
    await sleep(300);
    // Before round 36: holders 0, saves 0 — let go with nothing saved.
    expect([snaps.holders, snaps.saves, snaps.taken]).toEqual([1, 0, 1]);
    store.hold = false;
    await boxHistoryLeaseKept(snaps, T);
    expect([snaps.holders, snaps.saves, snaps.taken]).toEqual([0, 1, 1]);
    // What was saved is the newest result (its position past the 200 new reports): the next read reads nothing old again.
    const next = await read();
    expect(next.resumed).toBe(true);
    expect(next.reportsRead).toBeLessThan(later.length);
  }, 120_000);
});

describe('round 36 · M35-FR-03 · OB-104 · verifier r35 NEW-7: the keeper folds late reports as a fresh read would (memory)', () => {
  it('M35-FR-03 OB-104 NEW-7: bills banked after the build — the keeper judges the late reports on them, and its saved fold equals a normal read\'s', async () => {
    const { first, later } = aBigStore();
    // The store computer's tills are registered (S1L0- … S1L10-). 40 more reports (10 minutes) arrive after the build, while
    // saving is held back; they also say till S1L10- has given 15,000 bills — believable only once head office has banked
    // enough of them (PLAUSIBLE_ISSUED_AHEAD), which it does after the build. 20 minutes pass (this process's clock) before the
    // fence settles, so the keeper folds them itself: judged on the bill counts as they were at the build, S1L10- would be
    // "too far ahead" (and the next read would set the whole saved result aside and build it again).
    const late = later.slice(0, 40).map((r) => ({ ...r, receiptNumbersIssued: [...(r.receiptNumbersIssued ?? []), { prefix: 'S1L10-', through: 15_000, soldThrough: 15_000, unsent: { count: 0 } }] }) as BoxHealthRecord);
    const atBuild = iso(Date.parse(first.at(-1)!.receivedAt) + 60_000);
    const atLater = iso(Date.parse(atBuild) + 20 * 60_000);
    const run = async (keeper: boolean): Promise<{ last: StoreComputerHistoryReading; saves: number }> => {
      const store = new HeldFenceStore();
      const snaps = keeper ? new LeasingSnapshots() : new InMemorySnapshotStore();
      const T = 't-new7';
      await store.append(T, LANES, makeEvent({
        id: 'lanes', type: 'StoreComputerLanePrefixesRegistered', occurredAt: first[0]!.receivedAt, idempotencyKey: 'lanes', source: 'test/r36',
        payload: { computer: 'u-box', storeId: 'S1', prefixes: Array.from({ length: 11 }, (_, k) => `S1L${k}-`), by: 'u-owner', at: first[0]!.receivedAt, via: 'install' },
      }));
      await put(store, T, first);
      const read = (at: string) => storeComputerHistory(store, T, at, { sealKey: TEST_BOX_HISTORY_KEY, snapshots: snaps, timeZone: 'UTC', waitMs: 0, saveRetryMs: 50 });
      vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
      try {
        await read(atBuild);
        await boxHistoryBuilding(snaps, T);
        // After the build: the late reports arrive, and head office banks bill S1L10-015000 (a sale synced late).
        await put(store, T, late, first.length);
        await store.append(T, STREAM.sales, makeEvent({ id: 'rn-S1L10-015000', type: 'ReceiptNumberIssued', occurredAt: atBuild, idempotencyKey: 'rn-S1L10-015000', source: 'test/r36', payload: { receiptNumber: 'S1L10-015000' } }));
        vi.setSystemTime(Date.now() + 20 * 60_000);
        store.hold = false;
        if (keeper) await boxHistoryLeaseKept(snaps, T); // the keeper saves by itself — no read in between
        // (Without a keeper, this read folds the late reports and saves.) Then one more read, from what was saved.
        await read(atLater);
        const last = await read(atLater);
        return { last, saves: keeper ? (snaps as LeasingSnapshots).saves : -1 };
      } finally { vi.useRealTimers(); }
    };
    const byKeeper = await run(true);
    const byRead = await run(false);
    expect(byKeeper.saves).toBe(1); // the keeper saved it (and nothing was set aside and built again)
    expect(byKeeper.last.preparing).toBeUndefined();
    expect(byKeeper.last.resumed).toBe(true);
    expect(byKeeper.last.setAside).toBeUndefined();
    const answers = (r: StoreComputerHistoryReading) => JSON.stringify([[...r.findings], [...r.unused], [...r.unusedCapped], r.bindings, r.view.latestEach('S1', () => true), r.facts!('S1').lastByPrefix]);
    expect(answers(byKeeper.last)).toBe(answers(byRead.last));
    // Till S1L10- is believed at 15,000 in both (judged on the bills banked when the fold was made).
    expect(byKeeper.last.facts!('S1').lastByPrefix.find(([prefix]) => prefix === 'S1L10-')?.[1].x.through).toBe(15_000);
  }, 120_000);
});

// ───────────────────────────────── PostgreSQL ─────────────────────────────────

interface Instance { readonly pool: Pool; readonly store: EventStore; readonly snapshots: SqlSnapshotStore; problems: string[] }
function instance(limits: { builds?: number; kept?: number } = {}): Instance {
  const pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
  const problems: string[] = [];
  const leaseSession = pgDedicatedSession(() => new Client({ connectionString: DATABASE_URL, options: '-c app.tenant_id=*', connectionTimeoutMillis: 10_000, keepAlive: true }), { queryTimeoutMs: 30_000 });
  return {
    pool, store: new SqlEventStore(pgPoolClient(pool)), problems,
    snapshots: new SqlSnapshotStore(pgPoolClient(pool), {
      leaseSession, onLeaseProblem: (d) => { problems.push(d); },
      ...(limits.builds === undefined ? {} : { maxConcurrentLeases: limits.builds }), ...(limits.kept === undefined ? {} : { maxKeptLeases: limits.kept }),
    }),
  };
}
const leaseHolders = async (pool: Pool, T: string): Promise<number> =>
  (await pool.query('SELECT pid FROM pg_locks WHERE locktype = \'advisory\' AND classid = $1 AND objid = hashtext($2)::oid AND granted', [PROJECTION_BUILD_LEASE_CLASS, `${T}:box-health-history@1`])).rows.length;
const savedRow = async (pool: Pool, T: string): Promise<boolean> =>
  (await pool.query('SELECT 1 FROM projection_snapshot WHERE tenant_id = $1 AND projection = $2', [T, 'box-health-history@1'])).rows.length === 1;
/** A write transaction held open elsewhere (it has a transaction id), and a later one committed: the fence cannot settle. */
async function holdTheFence(pool: Pool): Promise<Client> {
  const blocker = new Client({ connectionString: DATABASE_URL, options: '-c app.tenant_id=*' });
  await blocker.connect();
  await blocker.query('BEGIN');
  await blocker.query('SELECT pg_current_xact_id()');
  await pool.query('SELECT pg_current_xact_id()');
  return blocker;
}
const until = async (what: string, ok: () => Promise<boolean> | boolean, ms = 60_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!(await ok())) { if (Date.now() > deadline) throw new Error(`never: ${what}`); await sleep(50); }
};

describe.skipIf(DATABASE_URL === undefined)('round 36 · M35-FR-03 · OB-106 · verifier r35 NEW-2 / NEW-5: the kept lease (PostgreSQL)', () => {
  it('M35-FR-03 OB-106 NEW-2: reports added while the fence is held and folded by a read — the lease stays held (pg_locks) until the newest result is saved; the other instance never builds', async () => {
    const endTurn = await takeHeldTransactionTurn(DATABASE_URL!);
    const [a, b] = [instance(), instance()];
    let blocker: Client | undefined;
    try {
      const T = randomUUID();
      await a.store.registerTenant(T, 'test/r36');
      const { first, later, at1, at2 } = aBigStore();
      await put(a.store, T, first);
      blocker = await holdTheFence(a.pool);
      const read = (x: Instance, at: string) => storeComputerHistory(x.store, T, at, { sealKey: TEST_BOX_HISTORY_KEY, snapshots: x.snapshots, timeZone: 'UTC', waitMs: 0, saveRetryMs: 50 });
      expect((await read(a, at1)).preparing).toBeDefined();
      await boxHistoryBuilding(a.snapshots, T);
      await until('the lease is kept', () => a.snapshots.buildLeasesKept === 1);
      expect([a.snapshots.buildLeasesHeld, await leaseHolders(a.pool, T), await savedRow(a.pool, T)]).toEqual([0, 1, false]);
      // 200 reports arrive while the fence is held, and A's next read folds them onto the held result (a newer one, unsaved).
      await put(a.store, T, later, first.length);
      const folded = await read(a, at2);
      expect(folded.resumed).toBe(true);
      expect(folded.reportsRead).toBeGreaterThanOrEqual(later.length);
      for (let k = 0; k < 5; k += 1) {
        await sleep(200);
        // Before round 36 the lease was let go here with nothing saved.
        expect([await leaseHolders(a.pool, T), await savedRow(a.pool, T), a.snapshots.buildLeasesKept]).toEqual([1, false, 1]);
        expect((await read(b, at2)).preparing?.why).toMatch(/another head-office process is building it now/);
      }
      await blocker.query('ROLLBACK');
      // A saves by itself and lets go; B then reads only the reports after the saved position — never builds.
      await boxHistoryLeaseKept(a.snapshots, T);
      expect([await savedRow(a.pool, T), await leaseHolders(a.pool, T), a.snapshots.buildLeasesKept]).toEqual([true, 0, 0]);
      // Round 37 (coordinator, CI on PR #785): the saved result is the NEWEST one — checked on the saved row itself: it folded
      // EVERY report, the 200 late ones included (round 36 counted B's reads, which also depends on the saved POSITION: on a
      // busy database another transaction can keep the newest fence from settling while an older one has, so the result is
      // saved at that older, proven-visible position with the 200 listed as folded — correct, and B then reads past them).
      const row = (await a.pool.query<{ n: string; seq: string }>("SELECT data->'result'->>'eventCount' AS n, data->'result'->>'watermarkSeq' AS seq FROM projection_snapshot WHERE tenant_id = $1 AND projection = $2", [T, 'box-health-history@1'])).rows[0]!;
      const newest = Number((await a.pool.query<{ s: string }>('SELECT max(seq) AS s FROM event_ledger WHERE tenant_id = $1 AND stream = $2', [T, BOX])).rows[0]!.s);
      expect(Number(row.n)).toBe(first.length + later.length); // the newest result: every report folded
      expect(Number(row.seq)).toBeLessThanOrEqual(newest);
      const fromB = await read(b, at2);
      expect(fromB.preparing).toBeUndefined();
      expect(fromB.resumed).toBe(true); // B used A's saved result — it never built
      if (Number(row.seq) === newest) expect(fromB.reportsRead).toBeLessThan(later.length); // saved at the newest position: nothing old re-read
      expect([...a.problems, ...b.problems]).toEqual([]);
    } finally {
      if (blocker !== undefined) await blocker.end().catch(() => undefined);
      await Promise.all([a.pool.end(), b.pool.end()]);
      await endTurn();
    }
  }, 300_000);

  it('M35-FR-03 OB-106 NEW-6: a lease query that never answers is cut off in bounded time, its connection destroyed — and the server then lets the lock go', async () => {
    const pool = new Pool({ connectionString: DATABASE_URL, max: 2, options: '-c app.tenant_id=*' });
    const holder = new Client({ connectionString: DATABASE_URL, options: '-c app.tenant_id=*' });
    const key = `r36-new6-${randomUUID()}`;
    const locks = async (): Promise<number> => (await pool.query('SELECT count(*)::int AS n FROM pg_locks WHERE locktype = \'advisory\' AND classid = $1 AND objid = hashtext($2)::oid', [PROJECTION_BUILD_LEASE_CLASS, key])).rows[0].n as number;
    try {
      await holder.connect();
      await holder.query('SELECT pg_advisory_lock($1::int, hashtext($2))', [PROJECTION_BUILD_LEASE_CLASS, key]);
      let socket: { destroyed?: boolean } | undefined;
      const session = pgDedicatedSession(() => {
        const c = new Client({ connectionString: DATABASE_URL, options: '-c app.tenant_id=*', keepAlive: true });
        socket = (c as unknown as { connection: { stream: { destroyed?: boolean } } }).connection.stream;
        return c;
      }, { queryTimeoutMs: 300 });
      const started = Date.now();
      // A query that waits for ever (as one on a half-open connection would): bounded, named, the socket destroyed.
      await expect(session(async (conn) => { await conn.query('SELECT pg_advisory_lock($1::int, hashtext($2))', [PROJECTION_BUILD_LEASE_CLASS, key]); })).rejects.toBeInstanceOf(DedicatedSessionTimeoutError);
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(socket?.destroyed).toBe(true);
      // Once the lock it waited for is free, the server finds the connection gone and ends that session — nothing is left held.
      await holder.query('SELECT pg_advisory_unlock($1::int, hashtext($2))', [PROJECTION_BUILD_LEASE_CLASS, key]);
      await until('the destroyed session\'s lock is gone', async () => (await locks()) === 0, 30_000);
    } finally {
      await holder.end().catch(() => undefined);
      await pool.end();
    }
  }, 120_000);

  it('M35-FR-03 OB-106 NEW-5: kept leases never make a small shop wait its turn; builds still take turns; with no room to keep, the lease is let go', async () => {
    const endTurn = await takeHeldTransactionTurn(DATABASE_URL!);
    const a = instance({ builds: 1, kept: 1 });
    let blocker: Client | undefined;
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    try {
      const [big1, big2, big3, small] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
      const { first, at1 } = aBigStore();
      for (const T of [big1, big2, big3, small]) await a.store.registerTenant(T, 'test/r36');
      for (const T of [big1, big2, big3]) await put(a.store, T, first);
      await put(a.store, small, first.slice(0, 500));
      blocker = await holdTheFence(a.pool);
      const read = (T: string, pause?: () => Promise<void>) => storeComputerHistory(a.store, T, at1, { sealKey: TEST_BOX_HISTORY_KEY, snapshots: a.snapshots, timeZone: 'UTC', waitMs: 0, saveRetryMs: 50, ...(pause === undefined ? {} : { buildPause: pause }) });
      // Big shop 1 builds; saving is held back: its lease is KEPT — outside the builds' count.
      await read(big1);
      await boxHistoryBuilding(a.snapshots, big1);
      await until('big1 kept', () => a.snapshots.buildLeasesKept === 1);
      expect(a.snapshots.buildLeasesHeld).toBe(0);
      // A small shop with nothing saved folds at once (before round 36: "waiting its turn" while the lease was kept).
      const s = await read(small);
      expect(s.preparing).toBeUndefined();
      expect(s.reportsRead).toBe(500);
      // A big shop builds (the builds' room is free) — held at its gate, so it is in progress…
      expect((await read(big2, () => gate)).preparing).toBeDefined();
      await until('big2 building', () => a.snapshots.buildLeasesHeld === 1);
      // …and the next big shop waits its turn: builds still take turns (at most 1 here).
      const waiting = await read(big3);
      expect(waiting.preparing?.why).toMatch(/waiting its turn/);
      // Big shop 2 finishes; the kept room (1) is full, so its lease is let go (said in STATUS: extra work only, never wrong).
      open();
      await boxHistoryBuilding(a.snapshots, big2);
      await until('big2 let go', () => a.snapshots.buildLeasesHeld === 0);
      expect(a.snapshots.buildLeasesKept).toBe(1);
      expect(await leaseHolders(a.pool, big2)).toBe(0);
      await blocker.query('ROLLBACK');
      await boxHistoryLeaseKept(a.snapshots, big1);
      expect([a.snapshots.buildLeasesHeld, a.snapshots.buildLeasesKept, await savedRow(a.pool, big1)]).toEqual([0, 0, true]);
      expect(a.problems).toEqual([]);
    } finally {
      open();
      if (blocker !== undefined) await blocker.end().catch(() => undefined);
      await a.pool.end();
      await endTurn();
    }
  }, 300_000);
});
