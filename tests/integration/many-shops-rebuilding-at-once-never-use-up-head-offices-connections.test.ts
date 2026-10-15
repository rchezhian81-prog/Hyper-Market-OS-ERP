import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool, Client } from 'pg';
import { pgPoolClient, pgDedicatedSession } from '../../packages/persistence/src/pg-client';
import { SqlEventStore, type EventStore } from '../../packages/persistence/src/event-store';
import { SqlSnapshotStore } from '../../packages/persistence/src/snapshot';
import { makeEvent } from '../../packages/contracts/src/event';
import { STREAM, streamName, storeComputerHistory, boxHistoryBuilding, boxHistoryLeaseKept, BOX_HISTORY_INLINE_MAX } from '../../services/api/src/adapters';
import type { BoxHealthRecord } from '../../services/platform/src/box-health';
import { honestStore, TEST_BOX_HISTORY_KEY, iso } from '../support/box-history';

/**
 * **Round 35 · M35-FR-03 · verifier r34 NEW-2 (OB-124 (5) / OB-106) — many shops rebuilding their store-computer history at
 * the same moment never use up head office's database connections.**
 *
 * Before round 35 each shop's background build held its lease on a connection from the API's ONE pool (ten connections) for
 * the whole build, and the build then needed more connections from that same pool: ten shops rebuilding at once (the first
 * read after a deploy, a seal-key change) would hold all ten and wait for ever — and every request with them.
 *
 *   • with the request pool cut to TWO connections and ten shops each above BOX_HISTORY_INLINE_MAX reading at once: every read
 *     answers ("being prepared"); at most four builds run at once, each lease on a connection of its OWN (outside the pool),
 *     and the other shops say "waiting its turn"; while the builds are held open the pool still answers a request at once and
 *     never holds more than its two connections; then every shop's history is built and ready, and no lease is left held;
 *   • with no connection of its own to use (a client that only has the pool), a lease is taken from the pool but at most ONE
 *     at a time and the connection is discarded afterwards — three shops at once on a two-connection pool all finish.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const BOX = streamName(STREAM.org, 'store-computer-health');
const plain = (r: BoxHealthRecord & { seq?: number }): BoxHealthRecord => { const { seq: _s, ...rest } = r; void _s; return rest as BoxHealthRecord; };
const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

async function put(store: EventStore, T: string, records: readonly BoxHealthRecord[]): Promise<void> {
  for (let i = 0; i < records.length; i += 500) {
    await store.appendBatch(T, records.slice(i, i + 500).map((r, j) => ({
      stream: BOX,
      event: makeEvent({ id: `bh-${i + j}`, type: 'StoreComputerHealthReported', occurredAt: r.receivedAt, idempotencyKey: `bh-${T}-${i + j}`, source: 'test/r35', payload: r }),
    })));
  }
}

async function manyShopsAtOnce(shops: number, ownSessions: boolean): Promise<void> {
  // The requests' pool, cut to two connections; a connect timeout so a starved request FAILS here rather than hang the test.
  const pool = new Pool({ connectionString: DATABASE_URL, max: 2, connectionTimeoutMillis: 20_000, options: '-c app.tenant_id=*' });
  const filler = new Pool({ connectionString: DATABASE_URL, max: 4, options: '-c app.tenant_id=*' });
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  try {
    const store = new SqlEventStore(pgPoolClient(pool));
    const snapshots = new SqlSnapshotStore(pgPoolClient(pool), ownSessions
      ? { leaseSession: pgDedicatedSession(() => new Client({ connectionString: DATABASE_URL, options: '-c app.tenant_id=*', connectionTimeoutMillis: 10_000 })) }
      : {});
    const max = ownSessions ? 4 : 1;
    const records = honestStore((BOX_HISTORY_INLINE_MAX + 760) / 5_760).map(plain);
    const at = iso(Date.parse(records[records.length - 1]!.receivedAt) + 3_600_000);
    const tenants = Array.from({ length: shops }, () => randomUUID());
    const fill = new SqlEventStore(pgPoolClient(filler));
    await Promise.all(tenants.map(async (T) => { await fill.registerTenant(T, 'test/r35'); await put(fill, T, records); }));

    const steps = new Map<string, number>();
    const read = (T: string, held: boolean) => storeComputerHistory(store, T, at, {
      sealKey: TEST_BOX_HISTORY_KEY, snapshots, timeZone: 'UTC', waitMs: 0, saveRetryMs: 50,
      buildPause: () => { steps.set(T, (steps.get(T) ?? 0) + 1); return held ? gate : Promise.resolve(); },
    });
    // Every shop at the same moment: every read answers.
    const first = await Promise.all(tenants.map((T) => read(T, true)));
    for (const r of first) expect(r.preparing).toBeDefined();
    const deadline = Date.now() + 60_000;
    while ([...steps.keys()].length < max) { if (Date.now() > deadline) throw new Error('the builds never started'); await sleep(20); }
    // At most `max` builds at once; the other shops wait their turn and say so.
    expect(steps.size).toBe(max);
    expect(snapshots.buildLeasesHeld).toBe(max);
    const waiting = tenants.filter((T) => !steps.has(T));
    for (const T of waiting) expect((await read(T, true)).preparing?.why).toMatch(/waiting its turn/);
    // While every build is held open, the requests' pool answers at once and holds no more than its two connections.
    const t0 = Date.now();
    await pool.query('SELECT 1');
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(pool.totalCount).toBeLessThanOrEqual(2);
    expect(pool.waitingCount).toBe(0);
    if (ownSessions) expect(pool.totalCount - pool.idleCount).toBe(0); // no lease on any of the requests' connections

    // Let them go: every shop's history is built in turn and becomes ready.
    open();
    const until = Date.now() + 240_000;
    const pending = new Set(tenants);
    while (pending.size > 0) {
      if (Date.now() > until) throw new Error(`still being prepared: ${pending.size} shops`);
      for (const T of [...pending]) {
        const r = await read(T, false);
        expect(snapshots.buildLeasesHeld).toBeLessThanOrEqual(max);
        if (r.preparing === undefined) { expect(r.history.lastBuildFailed).toBeNull(); pending.delete(T); }
      }
      await sleep(50);
    }
    for (const T of tenants) { await boxHistoryBuilding(snapshots, T); await boxHistoryLeaseKept(snapshots, T); }
    expect(snapshots.buildLeasesHeld).toBe(0);
    expect(pool.waitingCount).toBe(0);
  } finally {
    open();
    await pool.end();
    await filler.end();
  }
}

describe.skipIf(DATABASE_URL === undefined)('round 35 · M35-FR-03 · NEW-2: many shops rebuilding at once never use up head office\'s connections (PostgreSQL)', () => {
  it('M35-FR-03 OB-106 NEW-2: ten shops at once on a two-connection pool — leases on connections of their own, at most four builds at once, the pool always answers, all ten built', async () => {
    await manyShopsAtOnce(10, true);
  }, 600_000);
  it('M35-FR-03 OB-106 NEW-2: with only the pool to lease from — one lease at a time, discarded after; three shops at once on two connections all finish', async () => {
    await manyShopsAtOnce(3, false);
  }, 600_000);
});
