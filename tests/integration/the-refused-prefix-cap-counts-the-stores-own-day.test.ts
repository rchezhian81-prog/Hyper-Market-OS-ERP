import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore, InMemoryEventStore, type EventStore } from '../../packages/persistence/src/event-store';
import { SqlSnapshotStore, InMemorySnapshotStore, type SnapshotStore } from '../../packages/persistence/src/snapshot';
import { makeEvent } from '../../packages/contracts/src/event';
import { STREAM, streamName, storeComputerReading, storeComputerHistory, boxHealthAdapter } from '../../services/api/src/adapters';
import { REFUSED_NEW_PER_DAY_MAX, type BoxHealthRecord, type BillNumberFinding } from '../../services/platform/src/box-health';
import { TEST_BOX_HISTORY_KEY } from '../support/box-history';

/**
 * **Round 31 · owner decision OB-113 "A" (14 Oct 2026, in writing, "Store's own day") — at the store, on memory and on
 * PostgreSQL: the 20-a-day cap on new refused words about prefixes that are not the store's counts the store's own day
 * (midnight to midnight in its `locale.time_zone`, Asia/Kolkata by default).**
 *
 *   • 25 new bogus prefixes at 23:50 IST and 25 more at 00:10 IST: two store days, 20 kept on each, 10 counted in one line
 *     (the UTC day of round 30 would have kept 20 and counted 30);
 *   • the health read from the saved result (`storeComputerHistory`) says exactly what the full reading over every report
 *     (`storeComputerReading`) says — read from nothing, and resumed from the saved result;
 *   • changing the shop's time zone sets the saved result aside ("settings") and the answers are then the full reading's in
 *     the new zone.
 */

const BOX = streamName(STREAM.org, 'store-computer-health');
const DATABASE_URL = process.env['DATABASE_URL'];
const IST_MIDNIGHT = Date.parse('2026-02-28T18:30:00.000Z'); // 1 March 2026, 00:00 in India
const isoMs = (ms: number): string => new Date(ms).toISOString();

interface Ctx { readonly store: EventStore; readonly snapshots: SnapshotStore; readonly T: string }
async function onMemory(run: (c: Ctx) => Promise<void>): Promise<void> {
  await run({ store: new InMemoryEventStore(), snapshots: new InMemorySnapshotStore(), T: randomUUID() });
}
async function onPg(run: (c: Ctx) => Promise<void>): Promise<void> {
  const pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
  const sql = pgPoolClient(pool);
  const store = new SqlEventStore(sql);
  const T = randomUUID();
  await store.registerTenant(T, 'r31');
  try { await run({ store, snapshots: new SqlSnapshotStore(sql), T }); } finally { await pool.end(); }
}

const DISK = { freeBytes: 5e9, totalBytes: 1e10, salesLogUsedBytes: 1, salesLogCapacityBytes: 1e9, reserveBytes: 1e6 };
const report = (ms: number, prefixes: readonly string[]): BoxHealthRecord => ({
  storeId: 'S1', observedAt: isoMs(ms), receivedAt: isoMs(ms), reportedBy: 'u-box', clockAheadCorrected: false, tills: [], disk: DISK,
  queue: { unsent: 0, deadLettered: 0 },
  receiptNumbersIssued: [{ prefix: 'R-S1L0-', through: 0, soldThrough: 0, unsent: { count: 0 } }],
  receiptNumbersRefused: prefixes.map((prefix) => ({ prefix, through: 5, because: 'prefix_of_another_store' as const, bankedThrough: 0 })),
} as BoxHealthRecord);

async function put(store: EventStore, T: string, records: readonly BoxHealthRecord[]): Promise<void> {
  await store.appendBatch(T, records.map((r, i) => ({
    stream: BOX,
    event: makeEvent({ id: `bh-${i}`, type: 'StoreComputerHealthReported', occurredAt: r.receivedAt, idempotencyKey: `bh-${T}-${i}`, source: 'test/r31', payload: r }),
  })));
}
const refusedLines = (f: ReadonlyMap<string, readonly BillNumberFinding[]>): BillNumberFinding[] =>
  [...(f.get('S1') ?? [])].filter((x) => x.kind === 'report_refused' || x.kind === 'report_refused_not_kept');

async function storesOwnDay(c: Ctx): Promise<void> {
  // Reports every 5 minutes from 23:00 IST; the two floods at 23:50 and 00:10 IST.
  const records: BoxHealthRecord[] = [];
  for (let m = -60; m <= 120; m += 5) {
    const ms = IST_MIDNIGHT + m * 60_000;
    const list = m === -10 ? Array.from({ length: 25 }, (_, k) => `Za${k}-`) : m === 10 ? Array.from({ length: 25 }, (_, k) => `Zb${k}-`) : [];
    records.push(report(ms, list));
  }
  await put(c.store, c.T, records);
  const at = isoMs(IST_MIDNIGHT + 180 * 60_000); // 03:00 IST — every report settled (FOLD_SETTLE_MINUTES before)
  const full = async (timeZone: string) => storeComputerReading(c.store, c.T, await boxHealthAdapter({ store: c.store }).records(c.T), at, { timeZone, snapshots: new InMemorySnapshotStore() });
  const read = (timeZone: string) => storeComputerHistory(c.store, c.T, at, { sealKey: TEST_BOX_HISTORY_KEY, snapshots: c.snapshots, timeZone });

  const india = refusedLines((await full('Asia/Kolkata')).findings);
  expect(india.filter((x) => x.kind === 'report_refused')).toHaveLength(2 * REFUSED_NEW_PER_DAY_MAX);
  expect(india.find((x) => x.kind === 'report_refused_not_kept')).toMatchObject({ count: 10 });
  // The UTC day (round 30) would have said otherwise: one day, 20 kept, 30 counted.
  const utc = refusedLines((await full('UTC')).findings);
  expect(utc.find((x) => x.kind === 'report_refused_not_kept')).toMatchObject({ count: 30 });

  // From nothing: the saved result's answer is the full reading's. On a busy PostgreSQL other writers' short transactions can
  // hold the visibility fence back a moment (then nothing is saved yet): read again until it is saved (within 30 s).
  let first = await read('Asia/Kolkata');
  expect(refusedLines(first.findings)).toEqual(india);
  const deadline = Date.now() + 30_000;
  while ((first.history.saveHeld !== null || (await c.snapshots.load<unknown>(c.T, BOX, 'box-health-history@1')) === undefined) && Date.now() < deadline) {
    await new Promise((resolve) => { setTimeout(resolve, 200); });
    first = await read('Asia/Kolkata');
  }
  expect(first.history.saveHeld, 'the fence settles and the result is saved').toBeNull();
  // Resumed from the saved result: the same answer.
  const again = await read('Asia/Kolkata');
  expect(again.resumed).toBe(true);
  expect(again.setAside).toBeUndefined();
  expect(refusedLines(again.findings)).toEqual(india);
  // The shop's time zone changes: the saved result is set aside, and the answer is the full reading's in the new zone.
  const changed = await read('UTC');
  expect(changed.setAside).toBe('settings');
  expect(refusedLines(changed.findings)).toEqual(utc);
}

describe('round 31 · OB-113 at the store (memory)', () => {
  it('23:50 and 00:10 IST are two store days; the saved result and the full reading agree; a time-zone change sets it aside', async () => { await onMemory(storesOwnDay); }, 120_000);
});
describe.skipIf(DATABASE_URL === undefined)('round 31 · OB-113 at the store (PostgreSQL)', () => {
  it('23:50 and 00:10 IST are two store days; the saved result and the full reading agree; a time-zone change sets it aside', async () => { await onPg(storesOwnDay); }, 300_000);
});
