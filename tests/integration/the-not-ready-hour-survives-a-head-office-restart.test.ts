import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore, InMemoryEventStore, type EventStore } from '../../packages/persistence/src/event-store';
import { SqlSnapshotStore, InMemorySnapshotStore, type SnapshotStore } from '../../packages/persistence/src/snapshot';
import { makeEvent } from '../../packages/contracts/src/event';
import { STREAM, streamName, storeComputerHistory, storeComputerChecksReadinessHistory, observedHealthAdapter, boxHistoryBuilding, boxHistoryLeaseKept, BOX_HISTORY_INLINE_MAX } from '../../services/api/src/adapters';
import { seedGenesisOwner } from '../../services/api/src/access';
import { OWNER_ROLE_ID } from '../../services/api/src/roles';
import { raiseObservedAlerts, BUILT_IN_STORE_COMPUTER_CHECKS_RULE_ID } from '../../services/platform/src/observed-health';
import { OPS_ALERT_WORKER } from '../../services/platform/src/ops-alert-worker';
import { boxHistoryComponents, STORE_COMPUTER_CHECKS_STUCK_COMPONENT, type BoxHealthRecord } from '../../services/platform/src/box-health';
import { honestStore, iso, TEST_BOX_HISTORY_KEY } from '../support/box-history';

/**
 * **Round 34 · M35-FR-04 · owner decision OB-124 (3) "A" (15 Oct 2026, in writing, "Build all five before pilot"), finishing
 * OB-114 "A" — the "not ready since" hour is KEPT, so a head-office restart neither restarts the hour nor delays the owner's
 * alert; on memory and on PostgreSQL.**
 *
 *   • a big store's checks are "being prepared" from 0:00 (process A). Head office RESTARTS (process B: a fresh snapshot store
 *     and fresh memory, the same database) and is still preparing at 1:01 — the checks are said not ready SINCE 0:00, the
 *     component is down and the built-in alert is raised at 1:01, not at 2:01 (before round 34 B started the hour again);
 *   • every change is ONE append-only record (`StoreComputerChecksReadiness`): not ready from 0:00, ready again, not ready
 *     again from a new moment; nothing is ever overwritten (hard rule #2). Round 35 · OB-129 "A": while not ready, head
 *     office also notes that it is still running, at most every 5 minutes (one more record, carrying the running time so far)
 *     — a read within 5 minutes of the last note writes nothing. A quick restart (here 6 minutes) counts as running; a long
 *     outage does not (tests/integration/the-not-ready-hour-counts-only-head-office-running-time.test.ts);
 *   • two head-office processes finding the same change at the same moment land ONE record (the write guard), never two.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const BOX = streamName(STREAM.org, 'store-computer-health');
const OWNER = 'u-owner-r34-hour';

async function put(store: EventStore, T: string, records: readonly BoxHealthRecord[]): Promise<void> {
  for (let i = 0; i < records.length; i += 500) {
    await store.appendBatch(T, records.slice(i, i + 500).map((r, j) => ({
      stream: BOX,
      event: makeEvent({ id: `bh-${i + j}`, type: 'StoreComputerHealthReported', occurredAt: r.receivedAt, idempotencyKey: `bh-${T}-${i + j}`, source: 'test/r34', payload: r }),
    })));
  }
}
const plain = (r: BoxHealthRecord & { seq?: number }): BoxHealthRecord => { const { seq: _s, ...rest } = r; void _s; return rest as BoxHealthRecord; };

async function theHourSurvivesARestart(store: EventStore, freshSnapshots: () => SnapshotStore): Promise<void> {
  const T = randomUUID();
  await store.registerTenant(T, 'test/r34');
  const records = honestStore((BOX_HISTORY_INLINE_MAX + 760) / 5_760).map(plain);
  await put(store, T, records);
  await seedGenesisOwner(store, OWNER_ROLE_ID, T, OWNER, records[0]!.receivedAt);
  const start = Date.parse(records[records.length - 1]!.receivedAt) + 60_000;
  const at = (minutes: number): string => iso(start + minutes * 60_000);
  // Each "process" has its own snapshot store (its own memory); its background build is HELD until the test lets it go.
  const gates: (() => void)[] = [];
  const process = (): { snapshots: SnapshotStore; read: (when: string) => ReturnType<typeof storeComputerHistory> } => {
    const snapshots = freshSnapshots();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    gates.push(release);
    return { snapshots, read: (when) => storeComputerHistory(store, T, when, { sealKey: TEST_BOX_HISTORY_KEY, snapshots, timeZone: 'UTC', waitMs: 0, buildPause: () => gate }) };
  };
  try {
    const a = process();
    const first = await a.read(at(0));
    expect(first.preparing).toBeDefined();
    expect(first.history.notReadySince).toBe(at(0));
    expect(await storeComputerChecksReadinessHistory(store, T)).toEqual([{ state: 'not_ready', since: at(0), why: 'being_prepared', seenAt: at(0), runningMs: 0, offMs: 0 }]);
    // A's alert worker reads as it runs (here every 5 minutes until 0:55); a read within 5 minutes of the last note writes nothing.
    expect((await a.read(at(3))).history.notReadyCountedMs).toBe(3 * 60_000);
    expect(await storeComputerChecksReadinessHistory(store, T)).toHaveLength(1);
    for (let m = 5; m <= 55; m += 5) expect((await a.read(at(m))).history).toMatchObject({ notReadySince: at(0), notReadyCountedMs: m * 60_000, headOfficeOffMs: 0 });
    expect(await storeComputerChecksReadinessHistory(store, T)).toHaveLength(12);

    // Head office restarts: process B (fresh memory, same database), still preparing at 1:01 — the hour is NOT restarted
    // (a 6-minute restart counts as running: OB-129 "A" leaves out only an outage of more than 15 minutes).
    const b = process();
    const late = await b.read(at(61));
    expect(late.preparing).toBeDefined();
    expect(late.history.notReadySince).toBe(at(0));
    const stuck = boxHistoryComponents({ preparing: late.preparing!, history: late.history, at: at(61) }).find((c) => c.name === STORE_COMPUTER_CHECKS_STUCK_COMPONENT);
    expect(stuck).toMatchObject({ status: 'down' });
    expect(stuck!.detail).toMatch(/not been ready for 61 minutes/);
    // …so the built-in alert is raised to the owner at 1:01 by B's alert worker (not an hour later).
    const deps = observedHealthAdapter({ store, now: () => at(61), snapshots: b.snapshots, boxHistorySealKey: TEST_BOX_HISTORY_KEY, storeTimeZone: async () => 'UTC', boxHistoryWaitMs: 0 });
    const raised = await raiseObservedAlerts(deps, T, OPS_ALERT_WORKER, at(61), { clear: true });
    expect(raised?.alerts.find((x) => x.alertId === BUILT_IN_STORE_COMPUTER_CHECKS_RULE_ID)).toMatchObject({ ownerUserId: OWNER, status: 'down' });
    // B noted it once at 1:01 (6 minutes after A's last note); the alert worker's read at 1:01 wrote nothing more. Every
    // record is kept as written (append-only): the first is still the one written at 0:00.
    const kept = await storeComputerChecksReadinessHistory(store, T);
    expect(kept).toHaveLength(13);
    expect(kept[0]).toEqual({ state: 'not_ready', since: at(0), why: 'being_prepared', seenAt: at(0), runningMs: 0, offMs: 0 });
    expect(kept[12]).toEqual({ state: 'not_ready', since: at(0), why: 'being_prepared', seenAt: at(61), runningMs: 61 * 60_000, offMs: 0 });

    // Ready: B's build is let go and finishes; the next read records "ready" once.
    for (const g of gates) g();
    await boxHistoryBuilding(b.snapshots, T);
    await boxHistoryBuilding(a.snapshots, T);
    // Round 35 · NEW-4: on PostgreSQL the builder (A, which took the lease at 0:00) keeps its lease until its result is SAVED —
    // a busy database can hold saving back for a moment; meanwhile B says "another head-office process is building it now".
    await boxHistoryLeaseKept(a.snapshots, T);
    await boxHistoryLeaseKept(b.snapshots, T);
    const ready = await b.read(at(70));
    expect(ready.preparing).toBeUndefined();
    expect(ready.history.notReadySince).toBeUndefined();
    expect((await a.read(at(71))).history.notReadySince).toBeUndefined();
    expect((await storeComputerChecksReadinessHistory(store, T)).map((x) => x.state).filter((x, i, all) => i === 0 || x !== all[i - 1])).toEqual(['not_ready', 'ready']);
    expect((await storeComputerChecksReadinessHistory(store, T)).filter((x) => x.state === 'ready')).toEqual([{ state: 'ready', since: at(70) }]);

    // Not ready again (a process started without the seal key trusts nothing saved, so this big store is prepared again) —
    // a NEW hour, from its own first moment, kept as a third record.
    const nk = freshSnapshots();
    const noKey = (when: string) => storeComputerHistory(store, T, when, { snapshots: nk, timeZone: 'UTC', waitMs: 0 });
    expect((await noKey(at(200))).history.notReadySince).toBe(at(200));
    // Nothing read it for 30 minutes (head office off, or not reading): not counted, said as off time (OB-129 "A").
    expect((await noKey(at(230))).history).toMatchObject({ notReadySince: at(200), notReadyCountedMs: 0, headOfficeOffMs: 30 * 60_000 });
    const all = await storeComputerChecksReadinessHistory(store, T);
    expect(all.map((x) => [x.state, x.since, x.why]).filter((x, i, l) => i === 0 || JSON.stringify(x) !== JSON.stringify(l[i - 1]))).toEqual([
      ['not_ready', at(0), 'being_prepared'], ['ready', at(70), undefined], ['not_ready', at(200), 'being_prepared'],
    ]);
    await boxHistoryBuilding(nk, T);
  } finally { for (const g of gates) g(); }
}

/** Two processes find the same change at the same moment: ONE record lands; both say the same hour. */
async function twoProcessesOneRecord(store: EventStore, freshSnapshots: () => SnapshotStore): Promise<void> {
  const T = randomUUID();
  await store.registerTenant(T, 'test/r34');
  const records = honestStore(50 / 5_760).map(plain);
  await put(store, T, records);
  const start = Date.parse(records[records.length - 1]!.receivedAt) + 60_000;
  // Without the seal key the checks are not ready — eight processes read at once, each a different moment a few ms apart.
  const reads = await Promise.all(Array.from({ length: 8 }, (_, k) =>
    storeComputerHistory(store, T, iso(start + k), { snapshots: freshSnapshots(), timeZone: 'UTC', waitMs: 0 })));
  const kept = await storeComputerChecksReadinessHistory(store, T);
  expect(kept).toHaveLength(1);
  expect(kept[0]).toMatchObject({ state: 'not_ready', why: 'no_seal_key' });
  for (const r of reads) expect(r.history.notReadySince).toBe(kept[0]!.since);
}

describe('round 34 · M35-FR-04 · OB-124 (3) / OB-114: the "not ready since" hour survives a head-office restart (memory)', () => {
  it('M35-FR-04 OB-124 OB-114: a restart keeps the hour — alert at 1:01 not 2:01; each change one append-only record', async () => {
    await theHourSurvivesARestart(new InMemoryEventStore(), () => new InMemorySnapshotStore());
  }, 120_000);
  it('M35-FR-04 OB-124 OB-114: two processes finding the same change at once land one record', async () => {
    await twoProcessesOneRecord(new InMemoryEventStore(), () => new InMemorySnapshotStore());
  });
});

describe.skipIf(DATABASE_URL === undefined)('round 34 · M35-FR-04 · OB-124 (3) / OB-114: the "not ready since" hour survives a head-office restart (PostgreSQL)', () => {
  const onPg = async (run: (store: EventStore, fresh: () => SnapshotStore) => Promise<void>): Promise<void> => {
    // Each "process" its own pool, as two head-office processes would have.
    const pools: Pool[] = [];
    const pool = (): Pool => { const p = new Pool({ connectionString: DATABASE_URL, max: 8, options: '-c app.tenant_id=*' }); pools.push(p); return p; };
    try { await run(new SqlEventStore(pgPoolClient(pool())), () => new SqlSnapshotStore(pgPoolClient(pool()))); } finally { await Promise.all(pools.map((p) => p.end())); }
  };
  it('M35-FR-04 OB-124 OB-114: a restart keeps the hour — alert at 1:01 not 2:01; each change one append-only record', async () => {
    await onPg(theHourSurvivesARestart);
  }, 300_000);
  it('M35-FR-04 OB-124 OB-114: two processes finding the same change at once land one record (the write guard)', async () => {
    const pools: Pool[] = [];
    const pool = (): Pool => { const p = new Pool({ connectionString: DATABASE_URL, max: 4, options: '-c app.tenant_id=*' }); pools.push(p); return p; };
    try {
      // Each process its OWN event store and pool on the same database.
      const T = randomUUID();
      const stores = Array.from({ length: 4 }, () => new SqlEventStore(pgPoolClient(pool())));
      await stores[0]!.registerTenant(T, 'test/r34');
      const records = honestStore(50 / 5_760).map(plain);
      await put(stores[0]!, T, records);
      const start = Date.parse(records[records.length - 1]!.receivedAt) + 60_000;
      const reads = await Promise.all(stores.flatMap((s, i) => [0, 1].map((k) =>
        storeComputerHistory(s, T, iso(start + i * 2 + k), { snapshots: new SqlSnapshotStore(pgPoolClient(pool())), timeZone: 'UTC', waitMs: 0 }))));
      const kept = await storeComputerChecksReadinessHistory(stores[0]!, T);
      expect(kept, JSON.stringify(kept)).toHaveLength(1);
      for (const r of reads) expect(r.history.notReadySince).toBe(kept[0]!.since);
    } finally { await Promise.all(pools.map((p) => p.end())); }
  }, 120_000);
});
