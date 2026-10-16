import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore, InMemoryEventStore, type EventStore } from '../../packages/persistence/src/event-store';
import { makeEvent } from '../../packages/contracts/src/event';
import {
  STREAM, streamName, storeComputerChecksReadinessHistory, checksNotReadySince, READINESS_CLOCK_TOLERANCE_MS, type ChecksNotReady,
} from '../../services/api/src/adapters';
import { boxHistoryComponents, STORE_COMPUTER_CHECKS_STUCK_COMPONENT } from '../../services/platform/src/box-health';
import { iso } from '../support/box-history';

/**
 * **Round 36 · M35-FR-04 · OB-129 "A" (count only running time) · verifier r35 NEW-3 and NEW-4 — a clock ahead, or a record
 * written before round 35, never books head office's running time as "off" and never freezes the count; on memory and on
 * PostgreSQL.**
 *
 *   • NEW-3: not ready from 0:00, read each minute to 0:10; ONE read stamped 1:10 (a second head-office process whose clock runs
 *     an hour ahead, or a clock that jumped forward and stepped back); honest reads 0:11 to 1:20. Before round 36 the hour stood
 *     at 20 minutes running, 60 minutes "off" at 1:20 (the alert about two hours late). Now the note from the clock ahead is set
 *     aside (counted from the note before it), the very next honest read notes its own time, and at 1:20 all 80 minutes are
 *     running, none off; the page says a note from a clock ahead was set aside. The stuck alert's line is crossed at 1:01.
 *   • NEW-4: a round-34 record ("not ready since 0:00", no running notes). Round 35 is deployed at 0:51: the first read counts
 *     all 51 minutes as running (as round 34 did) — never "head office was off for 51 minutes" — and says that part is from
 *     before head office noted its running time. A real outage after that is still off time.
 *   • every note is one more append-only record; nothing is overwritten (hard rule #2).
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const READINESS = streamName(STREAM.org, 'store-computer-checks-readiness');
const start = Date.parse('2026-10-16T00:00:00.000Z');
const at = (minutes: number): string => iso(start + minutes * 60_000);
const words = (r: ChecksNotReady, when: string) => boxHistoryComponents({
  preparing: { since: r.since, why: 'x' }, at: when,
  history: {
    sizeBytes: null, saveHeld: null, lastBuildFailed: null, notReadySince: r.since, notReadyCountedMs: r.runningMs, headOfficeOffMs: r.offMs,
    ...(r.clockAhead === undefined ? {} : { notReadyClockAhead: r.clockAhead }), ...(r.beforeNotesMs === undefined ? {} : { notReadyBeforeNotesMs: r.beforeNotesMs }),
  },
}).find((c) => c.name === STORE_COMPUTER_CHECKS_STUCK_COMPONENT)!;

async function aClockAheadIsSetAside(store: EventStore): Promise<void> {
  const T = randomUUID();
  await store.registerTenant(T, 'test/r36');
  for (let m = 0; m <= 10; m += 1) await checksNotReadySince(store, T, 'being_prepared', at(m));
  const skewed = await checksNotReadySince(store, T, 'being_prepared', at(70)); // a clock an hour ahead
  expect(skewed).toMatchObject({ since: at(0), offMs: 60 * 60_000 }); // that process can only see a gap (its own clock)
  const firstHonest = await checksNotReadySince(store, T, 'being_prepared', at(11));
  expect(firstHonest).toMatchObject({ since: at(0), runningMs: 11 * 60_000, offMs: 0, clockAhead: { stamped: at(70), noticedAt: at(11) } });
  // Noted at once with this process's own time — the count does not freeze waiting for real time to pass 1:10.
  expect((await storeComputerChecksReadinessHistory(store, T)).at(-1)).toMatchObject({ seenAt: at(11), runningMs: 11 * 60_000, offMs: 0 });
  let last: ChecksNotReady | undefined;
  for (let m = 12; m <= 80; m += 1) {
    last = await checksNotReadySince(store, T, 'being_prepared', at(m));
    expect(last!.runningMs).toBe(m * 60_000);
  }
  expect(last).toMatchObject({ since: at(0), runningMs: 80 * 60_000, offMs: 0 });
  const c = words(last!, at(80));
  expect(c.status).toBe('down'); // 80 minutes of running: past the hour (before round 36: 20 minutes, "ok")
  expect(c.detail).toContain(`a running note stamped ${at(70)} (ahead of head office's clock) was set aside at ${at(11)}`);
  expect(c.detail).not.toContain('head office was off');
  expect(c.evidence).toMatchObject({ clockAheadNoteStamped: at(70), headOfficeOffMinutes: 0 });
  // Within the tolerance (a minute) a note slightly ahead is simply counted from — nothing set aside, nothing noted.
  expect(READINESS_CLOCK_TOLERANCE_MS).toBe(60_000);
  // Append-only: the note from the clock ahead is still there, as written.
  const all = await storeComputerChecksReadinessHistory(store, T);
  expect(all.filter((x) => x.seenAt === at(70))).toHaveLength(1);
  expect(all[0]).toEqual({ state: 'not_ready', since: at(0), why: 'being_prepared', seenAt: at(0), runningMs: 0, offMs: 0 });
}

async function aRound34RecordIsRunningTime(store: EventStore): Promise<void> {
  const T = randomUUID();
  await store.registerTenant(T, 'test/r36');
  // Exactly as round 34 wrote it (guarded, append-only): not ready since 0:00, no running notes.
  const key = `store-computer-checks-readiness-${T}-v1`;
  await store.appendBatch(T, [{
    stream: READINESS,
    event: makeEvent({ id: `r34-${T}`, type: 'StoreComputerChecksReadiness', occurredAt: at(0), idempotencyKey: key, source: 'api/platform', payload: { state: 'not_ready', since: at(0), why: 'being_prepared' } }),
  }], { guard: { key: 'store-computer-checks-readiness', expectedVersion: 0 } });
  // Head office ran 50 minutes under round 34; round 35/36 is deployed (a one-minute restart). The first read:
  const first = await checksNotReadySince(store, T, 'being_prepared', at(51));
  expect(first).toEqual({ since: at(0), runningMs: 51 * 60_000, offMs: 0, beforeNotesMs: 51 * 60_000 });
  const c = words(first!, at(51));
  expect(c.status).toBe('ok');
  expect(c.detail).not.toContain('head office was off'); // round 35 said "off for 51 minutes — not counted" (false)
  expect(c.detail).toContain('51 minutes of it is from before head office noted its running time (an earlier version) — counted as running');
  expect(c.evidence).toMatchObject({ minutes: 51, headOfficeOffMinutes: 0, countedBeforeNotesMinutes: 51 });
  // It was noted at once (the next read counts from 0:51), and the hour is on time: past it at 1:01.
  expect((await storeComputerChecksReadinessHistory(store, T)).at(-1)).toMatchObject({ seenAt: at(51), runningMs: 51 * 60_000, beforeNotesMs: 51 * 60_000 });
  for (let m = 56; m <= 61; m += 5) await checksNotReadySince(store, T, 'being_prepared', at(m));
  const due = await checksNotReadySince(store, T, 'being_prepared', at(62));
  expect(due).toMatchObject({ runningMs: 62 * 60_000, offMs: 0 });
  expect(words(due!, at(62)).status).toBe('down');
  // A real outage AFTER the notes began is still off time (OB-129 "A" unchanged), counted from the last NOTE (1:01).
  const back = await checksNotReadySince(store, T, 'being_prepared', at(200));
  expect(back).toMatchObject({ runningMs: 61 * 60_000, offMs: 139 * 60_000, beforeNotesMs: 51 * 60_000 });
  // The round-34 record is untouched.
  expect((await storeComputerChecksReadinessHistory(store, T))[0]).toEqual({ state: 'not_ready', since: at(0), why: 'being_prepared' });
}

describe('round 36 · M35-FR-04 · OB-129 · verifier r35 NEW-3 / NEW-4: a clock ahead or a round-34 record never books running time as off (memory)', () => {
  it('M35-FR-04 OB-129 NEW-3: a note from a clock an hour ahead is set aside; 80 of 80 minutes counted; said', async () => {
    await aClockAheadIsSetAside(new InMemoryEventStore());
  });
  it('M35-FR-04 OB-129 NEW-4: a round-34 record counts as running up to the first note; said; a later outage is still off', async () => {
    await aRound34RecordIsRunningTime(new InMemoryEventStore());
  });
});

describe.skipIf(DATABASE_URL === undefined)('round 36 · M35-FR-04 · OB-129 · verifier r35 NEW-3 / NEW-4: a clock ahead or a round-34 record never books running time as off (PostgreSQL)', () => {
  it('M35-FR-04 OB-129 NEW-3: a note from a clock an hour ahead is set aside; 80 of 80 minutes counted; said', async () => {
    const p = new Pool({ connectionString: DATABASE_URL, max: 4, options: '-c app.tenant_id=*' });
    try { await aClockAheadIsSetAside(new SqlEventStore(pgPoolClient(p))); } finally { await p.end(); }
  }, 120_000);
  it('M35-FR-04 OB-129 NEW-4: a round-34 record counts as running up to the first note; said; a later outage is still off', async () => {
    const p = new Pool({ connectionString: DATABASE_URL, max: 4, options: '-c app.tenant_id=*' });
    try { await aRound34RecordIsRunningTime(new SqlEventStore(pgPoolClient(p))); } finally { await p.end(); }
  }, 120_000);
});
