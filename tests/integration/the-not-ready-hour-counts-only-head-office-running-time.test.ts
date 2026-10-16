import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore, InMemoryEventStore, type EventStore } from '../../packages/persistence/src/event-store';
import { SqlSnapshotStore, InMemorySnapshotStore, type SnapshotStore } from '../../packages/persistence/src/snapshot';
import { makeEvent } from '../../packages/contracts/src/event';
import {
  STREAM, streamName, storeComputerHistory, storeComputerChecksReadinessHistory, checksNotReadySince, observedHealthAdapter, boxHistoryBuilding,
  BOX_HISTORY_INLINE_MAX, HEAD_OFFICE_OFF_AFTER_MS,
} from '../../services/api/src/adapters';
import { seedGenesisOwner } from '../../services/api/src/access';
import { OWNER_ROLE_ID } from '../../services/api/src/roles';
import { raiseObservedAlerts, BUILT_IN_STORE_COMPUTER_CHECKS_RULE_ID } from '../../services/platform/src/observed-health';
import { OPS_ALERT_WORKER } from '../../services/platform/src/ops-alert-worker';
import { boxHistoryComponents, STORE_COMPUTER_CHECKS_STUCK_COMPONENT, type BoxHealthRecord } from '../../services/platform/src/box-health';
import { honestStore, iso, TEST_BOX_HISTORY_KEY } from '../support/box-history';

/**
 * **Round 35 · M35-FR-04 · owner decision OB-129 "A" (15 Oct 2026, in writing, "Count only running time"; verifier r34 NEW-5) —
 * the "not ready since" hour counts only the time head office is RUNNING; the time it was switched off is said separately;
 * on memory and on PostgreSQL.**
 *
 *   • a big store's checks are "being prepared" from 0:00; head office runs (its alert worker reading) until 0:40, then is
 *     switched OFF until 10:00. At 10:00 the new head-office process finds them still being prepared: the hour stands at 40
 *     minutes, "head office was off for 9 hours 20 minutes — not counted" is said, and NO stuck alert is raised (before round
 *     35 it was raised at once, "stuck for 600 minutes"). It is raised at 10:21, after 61 minutes of head office running —
 *     with the off time said in its words;
 *   • a quick restart (up to 15 minutes) counts as running (the round-34 restart test keeps its 1:01 alert);
 *   • a change of REASON (no seal key, then being prepared) does not start the hour again — it is noted and said; a reason
 *     that flips back and forth can never keep the owner from being told;
 *   • every note is one more append-only record — the first one is still as written; nothing is overwritten (hard rule #2).
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const BOX = streamName(STREAM.org, 'store-computer-health');
const OWNER = 'u-owner-r35-hour';

async function put(store: EventStore, T: string, records: readonly BoxHealthRecord[]): Promise<void> {
  for (let i = 0; i < records.length; i += 500) {
    await store.appendBatch(T, records.slice(i, i + 500).map((r, j) => ({
      stream: BOX,
      event: makeEvent({ id: `bh-${i + j}`, type: 'StoreComputerHealthReported', occurredAt: r.receivedAt, idempotencyKey: `bh-${T}-${i + j}`, source: 'test/r35', payload: r }),
    })));
  }
}
const plain = (r: BoxHealthRecord & { seq?: number }): BoxHealthRecord => { const { seq: _s, ...rest } = r; void _s; return rest as BoxHealthRecord; };

async function aLongOutageIsNotCounted(store: EventStore, freshSnapshots: () => SnapshotStore): Promise<void> {
  const T = randomUUID();
  await store.registerTenant(T, 'test/r35');
  const records = honestStore((BOX_HISTORY_INLINE_MAX + 760) / 5_760).map(plain);
  await put(store, T, records);
  await seedGenesisOwner(store, OWNER_ROLE_ID, T, OWNER, records[0]!.receivedAt);
  const start = Date.parse(records[records.length - 1]!.receivedAt) + 60_000;
  const at = (minutes: number): string => iso(start + minutes * 60_000);
  const gates: (() => void)[] = [];
  const made: SnapshotStore[] = [];
  const process = () => {
    const snapshots = freshSnapshots();
    made.push(snapshots);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    gates.push(release);
    return { snapshots, read: (when: string) => storeComputerHistory(store, T, when, { sealKey: TEST_BOX_HISTORY_KEY, snapshots, timeZone: 'UTC', waitMs: 0, buildPause: () => gate }) };
  };
  const stuckAt = async (snapshots: SnapshotStore, when: string) => {
    const r = await storeComputerHistory(store, T, when, { sealKey: TEST_BOX_HISTORY_KEY, snapshots, timeZone: 'UTC', waitMs: 0 });
    return { r, c: boxHistoryComponents({ preparing: r.preparing!, history: r.history, at: when }).find((x) => x.name === STORE_COMPUTER_CHECKS_STUCK_COMPONENT)! };
  };
  const builtInRaised = async (snapshots: SnapshotStore, when: string) => {
    const deps = observedHealthAdapter({ store, now: () => when, snapshots, boxHistorySealKey: TEST_BOX_HISTORY_KEY, storeTimeZone: async () => 'UTC', boxHistoryWaitMs: 0 });
    const raised = await raiseObservedAlerts(deps, T, OPS_ALERT_WORKER, when, { clear: true });
    return raised?.alerts.find((x) => x.alertId === BUILT_IN_STORE_COMPUTER_CHECKS_RULE_ID);
  };
  try {
    // Process A: being prepared from 0:00; its alert worker reads every 5 minutes until 0:40 — then head office is switched off.
    const a = process();
    expect((await a.read(at(0))).preparing).toBeDefined();
    for (let m = 5; m <= 40; m += 5) await a.read(at(m));
    const firstRecord = (await storeComputerChecksReadinessHistory(store, T))[0];

    // 10:00 — head office is switched on again (process B). Still being prepared: 40 minutes counted, 9 h 20 min off, said.
    const b = process();
    const back = await b.read(at(600));
    expect(back.preparing).toBeDefined();
    expect(back.history).toMatchObject({ notReadySince: at(0), notReadyCountedMs: 40 * 60_000, headOfficeOffMs: 560 * 60_000 });
    const { c: atTen } = await stuckAt(b.snapshots, at(600));
    expect(atTen.status).toBe('ok');
    expect(atTen.detail).toContain('for 40 minutes of head office running so far');
    expect(atTen.detail).toContain('head office was off for 9 hours 20 minutes in that time — not counted');
    expect(atTen.evidence).toMatchObject({ minutes: 40, headOfficeOffMinutes: 560 });
    // No false stuck alert straight after the outage.
    expect(await builtInRaised(b.snapshots, at(600))).toBeUndefined();

    // B's alert worker reads on: at 10:20 the hour stands at 60 minutes (not more than the line); at 10:21 it is 61 — raised.
    for (let m = 605; m <= 620; m += 5) await b.read(at(m));
    expect((await stuckAt(b.snapshots, at(620))).c.status).toBe('ok');
    const { c: stuck } = await stuckAt(b.snapshots, at(621));
    expect(stuck.status).toBe('down');
    expect(stuck.detail).toMatch(/not been ready for 61 minutes of head office running \(since .*; now being prepared; head office was off for 9 hours 20 minutes in that time — not counted\)/);
    expect(await builtInRaised(b.snapshots, at(621))).toMatchObject({ ownerUserId: OWNER, status: 'down' });

    // Append-only: the first record is exactly as written at 0:00; every note is a record of its own.
    const all = await storeComputerChecksReadinessHistory(store, T);
    expect(all[0]).toEqual(firstRecord);
    expect(all[0]).toEqual({ state: 'not_ready', since: at(0), why: 'being_prepared', seenAt: at(0), runningMs: 0, offMs: 0 });
    expect(all.find((x) => x.seenAt === at(600))).toEqual({ state: 'not_ready', since: at(0), why: 'being_prepared', seenAt: at(600), runningMs: 40 * 60_000, offMs: 560 * 60_000, basis: { seenAt: at(40), runningMs: 40 * 60_000, offMs: 0 }, trusted: { seenAt: at(40), runningMs: 40 * 60_000, offMs: 0 } }); // round 36 · NEW-3: what it counted from; round 37 · NEW-2: the note before the off gap is the one to trust
    expect(all.every((x) => x.state === 'not_ready' && x.since === at(0))).toBe(true);
  } finally {
    for (const g of gates) g();
    for (const s of made) await boxHistoryBuilding(s, T);
  }
}

/** The record logic itself: off gaps, quick restarts, and a reason that changes — or flips back and forth. */
async function theReasonAndTheGaps(store: EventStore): Promise<void> {
  const T = randomUUID();
  await store.registerTenant(T, 'test/r35');
  const start = Date.parse('2026-10-15T00:00:00.000Z');
  const at = (minutes: number): string => iso(start + minutes * 60_000);
  // No seal key from 0:00, read every 5 minutes to 0:50.
  expect(await checksNotReadySince(store, T, 'no_seal_key', at(0))).toEqual({ since: at(0), runningMs: 0, offMs: 0 });
  for (let m = 5; m <= 50; m += 5) await checksNotReadySince(store, T, 'no_seal_key', at(m));
  // The key is fixed by a quick restart (10 minutes — counted as running) and the history is being built: the hour goes on.
  const fixed = await checksNotReadySince(store, T, 'being_prepared', at(60));
  expect(fixed).toEqual({ since: at(0), runningMs: 60 * 60_000, offMs: 0, reasonChanged: { from: 'no_seal_key', at: at(60) } });
  const words = boxHistoryComponents({ preparing: { since: at(60), why: 'x' }, history: { sizeBytes: null, saveHeld: null, lastBuildFailed: null, notReadySince: fixed!.since, notReadyCountedMs: fixed!.runningMs, headOfficeOffMs: fixed!.offMs, notReadyReasonChanged: fixed!.reasonChanged! }, at: at(60) })
    .find((c) => c.name === STORE_COMPUTER_CHECKS_STUCK_COMPONENT)!;
  expect(words.detail).toContain(`until ${at(60)} the reason was that head office had no seal key — the time is counted from the start`);
  // A reason that flips back and forth (a second process holding the build lease) never starts the hour again.
  for (let m = 61; m <= 64; m += 1) {
    const r = await checksNotReadySince(store, T, m % 2 === 0 ? 'being_prepared' : 'no_seal_key', at(m));
    expect(r!.since).toBe(at(0));
    expect(r!.runningMs).toBe(m * 60_000);
  }
  // A gap of more than 15 minutes (head office off, or not reading) is not counted; one of 15 minutes or less is. The gap runs
  // from the last NOTE (1:00 — the reads at 1:01 to 1:04 were within 5 minutes of it, so not noted): 20 minutes, off.
  const afterGap = await checksNotReadySince(store, T, 'being_prepared', at(80));
  expect(afterGap).toMatchObject({ since: at(0), runningMs: 60 * 60_000, offMs: 20 * 60_000 });
  expect(HEAD_OFFICE_OFF_AFTER_MS).toBe(15 * 60_000);
  const shortGap = await checksNotReadySince(store, T, 'being_prepared', at(95));
  expect(shortGap).toMatchObject({ runningMs: 75 * 60_000, offMs: 20 * 60_000 });
  // Ready: one record; not ready again later is a NEW hour from its own moment, with nothing carried over.
  expect(await checksNotReadySince(store, T, false, at(100))).toBeUndefined();
  expect(await checksNotReadySince(store, T, 'being_prepared', at(300))).toEqual({ since: at(300), runningMs: 0, offMs: 0 });
  const all = await storeComputerChecksReadinessHistory(store, T);
  expect(all[0]).toEqual({ state: 'not_ready', since: at(0), why: 'no_seal_key', seenAt: at(0), runningMs: 0, offMs: 0 });
  expect(all.filter((x) => x.state === 'ready')).toEqual([{ state: 'ready', since: at(100) }]);
  expect(all.at(-1)).toEqual({ state: 'not_ready', since: at(300), why: 'being_prepared', seenAt: at(300), runningMs: 0, offMs: 0 });
}

describe('round 35 · M35-FR-04 · OB-129 "A": the not-ready hour counts only head-office running time (memory)', () => {
  it('M35-FR-04 OB-129 NEW-5: off 9 h 20 min — not counted, said; no alert at 10:00; raised at 10:21 after 61 minutes of running', async () => {
    await aLongOutageIsNotCounted(new InMemoryEventStore(), () => new InMemorySnapshotStore());
  }, 120_000);
  it('M35-FR-04 OB-129 NEW-5: a changed (or flipping) reason keeps the hour and is said; gaps over 15 minutes are off time; append-only', async () => {
    await theReasonAndTheGaps(new InMemoryEventStore());
  });
});

describe.skipIf(DATABASE_URL === undefined)('round 35 · M35-FR-04 · OB-129 "A": the not-ready hour counts only head-office running time (PostgreSQL)', () => {
  it('M35-FR-04 OB-129 NEW-5: off 9 h 20 min — not counted, said; no alert at 10:00; raised at 10:21 after 61 minutes of running', async () => {
    const pools: Pool[] = [];
    const pool = (): Pool => { const p = new Pool({ connectionString: DATABASE_URL, max: 8, options: '-c app.tenant_id=*' }); pools.push(p); return p; };
    try {
      await aLongOutageIsNotCounted(new SqlEventStore(pgPoolClient(pool())), () => new SqlSnapshotStore(pgPoolClient(pool())));
    } finally { await Promise.all(pools.map((p) => p.end())); }
  }, 300_000);
  it('M35-FR-04 OB-129 NEW-5: a changed (or flipping) reason keeps the hour and is said; gaps over 15 minutes are off time; append-only', async () => {
    const p = new Pool({ connectionString: DATABASE_URL, max: 4, options: '-c app.tenant_id=*' });
    try { await theReasonAndTheGaps(new SqlEventStore(pgPoolClient(p))); } finally { await p.end(); }
  }, 120_000);
});

