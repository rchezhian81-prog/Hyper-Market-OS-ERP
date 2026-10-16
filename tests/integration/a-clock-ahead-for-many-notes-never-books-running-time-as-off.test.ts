import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore, InMemoryEventStore, type EventStore } from '../../packages/persistence/src/event-store';
import {
  storeComputerChecksReadinessHistory, checksNotReadySince, READINESS_SEEN_EVERY_MS, type ChecksNotReady, type ReadinessNoter,
} from '../../services/api/src/adapters';
import { boxHistoryComponents, STORE_COMPUTER_CHECKS_STUCK_COMPONENT } from '../../services/platform/src/box-health';
import { iso } from '../support/box-history';

/**
 * **Round 37 · M35-FR-04 · OB-129 "A" (count only running time) · verifier r36 NEW-2 and NEW-3 — a head-office clock that stays
 * AHEAD for many notes and then steps back never books running time as "off" and never freezes the count; and a process writes
 * at most one note per 5 minutes of its own clock. On memory and on PostgreSQL.**
 *
 *   • NEW-2 (the verifier's probe): honest reads each minute 0:00-0:10; the clock then runs an hour AHEAD for 30 real minutes
 *     (0:11-0:40 read as 1:11-1:40 — six notes on the wrong clock); NTP steps it back and honest reads go on to 1:20. Round 36
 *     went back only one note and at 1:20 said 69 minutes running and 61 "off" (the alert about 11 minutes late). Now the whole
 *     run of notes stamped ahead is set aside, counted from the note before the jump: 80 of 80 minutes running, none off; the
 *     count goes up by one minute on every read after the step back (no freeze); every earlier record is unchanged
 *     (append-only); the page says a note from a clock ahead was set aside and never says "head office was off".
 *     The same with this process's own note-taking (`ReadinessNoter`, as production composes it).
 *   • a real outage after the step back is still off time.
 *   • NEW-3: two head-office processes whose clocks are 10 minutes apart, each reading every minute for 10 hours, write at most
 *     one note each per 5 minutes of their own clock (round 36: two a minute, 1,202 records) and the hour stays within the
 *     clock difference of the real time, never "off" (the stated limitation: one process for the pilot, OB-126).
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const start = Date.parse('2026-10-16T00:00:00.000Z');
const at = (minutes: number): string => iso(start + minutes * 60_000);
const MIN = 60_000;
const words = (r: ChecksNotReady, when: string) => boxHistoryComponents({
  preparing: { since: r.since, why: 'x' }, at: when,
  history: {
    sizeBytes: null, saveHeld: null, lastBuildFailed: null, notReadySince: r.since, notReadyCountedMs: r.runningMs, headOfficeOffMs: r.offMs,
    ...(r.clockAhead === undefined ? {} : { notReadyClockAhead: r.clockAhead }), ...(r.beforeNotesMs === undefined ? {} : { notReadyBeforeNotesMs: r.beforeNotesMs }),
  },
}).find((c) => c.name === STORE_COMPUTER_CHECKS_STUCK_COMPONENT)!;

async function aRunOfNotesAheadIsSetAside(store: EventStore, noter?: ReadinessNoter): Promise<void> {
  const T = randomUUID();
  await store.registerTenant(T, 'test/r37');
  for (let m = 0; m <= 10; m += 1) await checksNotReadySince(store, T, 'being_prepared', at(m), noter);
  for (let m = 11; m <= 40; m += 1) await checksNotReadySince(store, T, 'being_prepared', at(m + 60), noter); // an hour ahead
  const before = await storeComputerChecksReadinessHistory(store, T);
  expect(before.filter((r) => r.seenAt !== undefined && Date.parse(r.seenAt) > Date.parse(at(60))).length).toBeGreaterThanOrEqual(5); // several notes ahead
  // NTP steps the clock back.
  let prev = -1;
  let last: ChecksNotReady | undefined;
  for (let m = 41; m <= 80; m += 1) {
    last = await checksNotReadySince(store, T, 'being_prepared', at(m), noter);
    expect(last!.runningMs).toBeGreaterThan(prev); // never freezes
    expect(last!.offMs).toBe(0); // the jump is never booked as "head office was off"
    prev = last!.runningMs;
  }
  expect(last).toMatchObject({ since: at(0), runningMs: 80 * MIN, offMs: 0 }); // round 36: 69 running, 61 off
  const c = words(last!, at(80));
  expect(c.status).toBe('down');
  expect(c.detail).toContain('(ahead of head office\'s clock) was set aside');
  expect(c.detail).not.toContain('head office was off');
  // Append-only: every record written before the step back is still there, unchanged.
  const after = await storeComputerChecksReadinessHistory(store, T);
  expect(after.slice(0, before.length)).toEqual(before);
  expect(after.length).toBeGreaterThan(before.length);
  // A real outage after that is still off: head office off from 1:20 to 3:00.
  const back = await checksNotReadySince(store, T, 'being_prepared', at(180), noter);
  // (Up to five minutes before an outage may be counted as off — the time since the last note, as round 35 stated.)
  expect(back!.runningMs + back!.offMs).toBe(180 * MIN);
  expect(back!.runningMs).toBeGreaterThanOrEqual(75 * MIN);
  expect(back!.offMs).toBeGreaterThanOrEqual(100 * MIN);
}

async function twoProcessesWithClocksApart(store: EventStore): Promise<void> {
  const T = randomUUID();
  await store.registerTenant(T, 'test/r37');
  const p1: ReadinessNoter = {};
  const p2: ReadinessNoter = {};
  let r1: ChecksNotReady | undefined;
  let r2: ChecksNotReady | undefined;
  for (let m = 0; m <= 600; m += 1) {
    r1 = await checksNotReadySince(store, T, 'being_prepared', at(m), p1);
    r2 = await checksNotReadySince(store, T, 'being_prepared', at(m - 10 + 0.5), p2); // 9.5 minutes behind
  }
  const records = (await storeComputerChecksReadinessHistory(store, T)).length;
  expect(records).toBeLessThanOrEqual(2 * (600 / (READINESS_SEEN_EVERY_MS / MIN)) + 4); // at most one note each per 5 minutes (round 36: 1,202)
  // Within the clock difference of the real time (600 minutes), never "off" (the stated limitation; OB-126 runs one process).
  expect(Math.abs(r1!.runningMs - 600 * MIN)).toBeLessThanOrEqual(11 * MIN);
  expect(Math.abs(r2!.runningMs - 600 * MIN)).toBeLessThanOrEqual(11 * MIN);
  expect(r1!.offMs + r2!.offMs).toBe(0);
}

async function oneProcessNotesAsBefore(store: EventStore): Promise<void> {
  // One process with an honest clock: its own note-taking changes nothing — a note every 5 minutes, as round 35.
  const T = randomUUID();
  await store.registerTenant(T, 'test/r37');
  const noter: ReadinessNoter = {};
  let r: ChecksNotReady | undefined;
  for (let m = 0; m <= 120; m += 1) r = await checksNotReadySince(store, T, 'being_prepared', at(m), noter);
  expect(r).toMatchObject({ runningMs: 120 * MIN, offMs: 0 });
  expect((await storeComputerChecksReadinessHistory(store, T)).length).toBe(1 + 120 / 5);
  // Off for 2 hours, then back: off counted, noted at once.
  r = await checksNotReadySince(store, T, 'being_prepared', at(240), noter);
  expect(r).toMatchObject({ runningMs: 120 * MIN, offMs: 120 * MIN });
  expect((await storeComputerChecksReadinessHistory(store, T)).at(-1)).toMatchObject({ seenAt: at(240) });
}

describe('round 37 · M35-FR-04 · OB-129 · verifier r36 NEW-2 / NEW-3: a clock ahead for many notes (memory)', () => {
  it('M35-FR-04 OB-129 NEW-2: an hour ahead for 30 minutes, then stepped back — 80 of 80 minutes running, none off, no freeze, append-only', async () => {
    await aRunOfNotesAheadIsSetAside(new InMemoryEventStore());
  });
  it('M35-FR-04 OB-129 NEW-2: the same with the process\'s own note-taking (as production)', async () => {
    await aRunOfNotesAheadIsSetAside(new InMemoryEventStore(), {});
  });
  it('M35-FR-04 OB-129 NEW-3: two processes 10 minutes apart write at most one note each per 5 minutes; the hour stays within the difference', async () => {
    await twoProcessesWithClocksApart(new InMemoryEventStore());
  });
  it('M35-FR-04 OB-129 NEW-3: one honest process notes every 5 minutes as before, and an outage is still off', async () => {
    await oneProcessNotesAsBefore(new InMemoryEventStore());
  });
});

describe.skipIf(DATABASE_URL === undefined)('round 37 · M35-FR-04 · OB-129 · verifier r36 NEW-2 / NEW-3: a clock ahead for many notes (PostgreSQL)', () => {
  const withStore = async (fn: (s: EventStore) => Promise<void>): Promise<void> => {
    const pool = new Pool({ connectionString: DATABASE_URL, max: 4, options: '-c app.tenant_id=*' });
    try { await fn(new SqlEventStore(pgPoolClient(pool))); } finally { await pool.end(); }
  };
  it('M35-FR-04 OB-129 NEW-2: an hour ahead for 30 minutes, then stepped back — 80 of 80 minutes running, none off, no freeze, append-only', async () => {
    await withStore((s) => aRunOfNotesAheadIsSetAside(s, {}));
  }, 120_000);
  it('M35-FR-04 OB-129 NEW-3: two processes 10 minutes apart write at most one note each per 5 minutes; the hour stays within the difference', async () => {
    await withStore(twoProcessesWithClocksApart);
  }, 300_000);
});
