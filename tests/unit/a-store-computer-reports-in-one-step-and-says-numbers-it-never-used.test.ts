import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReceiptNumbers, UNUSED_NUMBERS_MAX, UNUSED_RANGES_MAX as EDGE_UNUSED_RANGES_MAX } from '../../edge/store-edge/src/receipt-numbers';
import { boxHealthReportOf, type BoxHealthSources } from '../../edge/sync-agent/src/box-health-report';
import {
  readBoxHealthReport, queueContradiction, unreceivedCandidates, UNRECEIVED_CHECK_CAP, UNUSED_RANGES_MAX, type BoxHealthRecord, type IssuedReport,
} from '../../services/platform/src/box-health';

/**
 * **Round 25 · OB-93 "A" and OB-94 "A" — the store computer's side (owner, 13 Oct 2026, in writing).**
 *
 *   1. OB-93 (verifier r24 NEW-1): the box's health report reads its queues' counts and its per-prefix lists of bills in
 *      ONE synchronous step, after everything it awaits (the filesystem, the sales log's size, the witness folder). A sale
 *      committed while the report is being made — here, during the disk await — is in both the count and the list, so an
 *      honest report never contradicts its own queue. (Before round 25 the counts were read before the sales log's size was
 *      awaited and the lists after it: exactly this sale made the report contradict itself.)
 *   2. OB-94 (verifier r24 NEW-2): the box says which numbers it took and never put on a bill (`unused`) — at or below what
 *      it sold, the newest, within head office's bounds — and head office never names them "never received".
 * The sale path is untouched: the report rides the sync loop after the drains (hard rule #1); the integration suites prove
 * the till keeps selling offline.
 */

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
const SERIES = [{ laneId: 'L1', prefix: 'A1L1-', padTo: 6, rangeStart: 1, rangeEnd: 999_999, bankedThrough: 0 }];
const register = async (): Promise<ReceiptNumbers> => {
  const dir = await mkdtemp(join(tmpdir(), 'sre-unused-'));
  dirs.push(dir);
  return ReceiptNumbers.open({ dataDir: dir, capacityBytes: 64 * 1_048_576, published: () => SERIES });
};
/** Take a number; when `use` is true a sale is saved with it (its use noted), otherwise it is given up. */
const take = async (reg: ReceiptNumbers, use: boolean): Promise<string> => {
  const got = await reg.issue({ laneId: 'L1', requestKey: `k-${Math.random()}`, issuedTo: 'u-cash' });
  if (!got.issued) throw new Error('not issued');
  if (use) {
    const check = reg.checkUse({ laneId: 'L1', receiptNumber: got.receiptNumber, recordId: `S-${got.receiptNumber}` });
    if (!check.ok) throw new Error('not usable');
    await check.record();
  }
  return got.receiptNumber;
};
const DISK = { freeBytes: 5e9, totalBytes: 1e10, salesLogUsedBytes: 1, salesLogCapacityBytes: 1e7, reserveBytes: 1 };

describe('OB-93: the store computer reads its queue counts and its lists in one step', () => {
  it('a sale committed while the report is being made is in both the count and the list — the report never contradicts itself', async () => {
    // A queue with 10 bills waiting (the line is down); a sale is committed WHILE the report awaits the disk.
    const pending: { payload: unknown; occurredAt: string }[] = Array.from({ length: 10 }, (_, i) => ({ payload: { receiptNumber: `A1L1-${String(101 + i).padStart(6, '0')}` }, occurredAt: '2026-03-01T08:00:00.000Z' }));
    const order: string[] = [];
    const sources: BoxHealthSources = {
      now: () => '2026-03-01T08:00:15.000Z',
      disk: async () => {
        order.push('disk awaited');
        await new Promise((r) => setTimeout(r, 5));
        pending.push({ payload: { receiptNumber: 'A1L1-000111' }, occurredAt: '2026-03-01T08:00:15.000Z' }); // the sale lands now
        return DISK;
      },
      billNumbering: async () => { order.push('witness awaited'); await new Promise((r) => setTimeout(r, 1)); return { witness: 'kept', restoreHeld: false, sharedWith: [] }; },
      queues: () => { order.push('counts read'); return [{ unsentCount: pending.length, deadLetterCount: 0 }]; },
      tills: () => [],
      issued: () => { order.push('lists read'); return [{ prefix: 'A1L1-', through: 111, soldThrough: 111 }]; },
      pending: () => pending,
      deadLetters: () => [],
    };
    const report = await boxHealthReportOf(sources);
    expect(order).toEqual(['disk awaited', 'witness awaited', 'counts read', 'lists read']);
    expect(report.queue).toEqual({ unsent: 11, deadLettered: 0 });
    expect(report.receiptNumbersIssued).toEqual([{ prefix: 'A1L1-', through: 111, soldThrough: 111, unsent: { count: 11, from: 101, to: 111, oldestAt: '2026-03-01T08:00:00.000Z' }, deadLettered: { count: 0 } }]);
    // Head office reads it as an honest report: it fits its own queue.
    const read = readBoxHealthReport(report, '2026-03-01T08:00:16.000Z');
    expect('problems' in read).toBe(false);
    if ('problems' in read) return;
    expect(queueContradiction(read.queue, read.receiptNumbersIssued!)).toBeUndefined();
  });
});

describe('OB-94: the store computer says which numbers it took and never used', () => {
  it('a number given and never put on a bill, below the last bill, is reported unused; one still in the till\'s hands is not', async () => {
    const reg = await register();
    await take(reg, true); // 1
    await take(reg, false); // 2: the sale could not be saved after its number was taken
    await take(reg, true); // 3
    await take(reg, false); // 4
    await take(reg, false); // 5
    await take(reg, true); // 6
    await take(reg, false); // 7: just taken — the till may still be saving the sale with it
    expect(reg.issuedThrough()).toEqual([{ prefix: 'A1L1-', through: 7, soldThrough: 6, unused: [[2, 2], [4, 5]] }]);
    await reg.close();
  });

  it('with nothing unused, the field is left out (an older head office sees what it always saw)', async () => {
    const reg = await register();
    for (let i = 0; i < 3; i += 1) await take(reg, true);
    expect(reg.issuedThrough()).toEqual([{ prefix: 'A1L1-', through: 3, soldThrough: 3 }]);
    await reg.close();
  });

  it('bounded: the newest numbers only — at most 500 numbers, at most 50 ranges — head office\'s own bounds', async () => {
    expect(UNUSED_NUMBERS_MAX).toBe(UNRECEIVED_CHECK_CAP);
    expect(EDGE_UNUSED_RANGES_MAX).toBe(UNUSED_RANGES_MAX);
    const reg = await register();
    // 120 single unused numbers between used ones: only the newest 50 ranges are said.
    for (let i = 0; i < 120; i += 1) { await take(reg, true); await take(reg, false); }
    await take(reg, true);
    const [x] = reg.issuedThrough();
    expect(x!.unused).toHaveLength(50);
    expect(x!.unused![0]).toEqual([142, 142]);
    expect(x!.unused!.at(-1)).toEqual([240, 240]);
    // 700 unused in a row: only the newest 500.
    for (let i = 0; i < 700; i += 1) await take(reg, false);
    await take(reg, true);
    const [y] = reg.issuedThrough();
    const count = y!.unused!.reduce((n, [a, z]) => n + z - a + 1, 0);
    expect(count).toBe(500);
    expect(y!.unused!.at(-1)).toEqual([442, 941]);
    // Head office accepts what the box sends.
    const read = readBoxHealthReport({ observedAt: '2026-03-01T08:00:00.000Z', disk: DISK, queue: { unsent: 0, deadLettered: 0 }, tills: [], receiptNumbersIssued: [{ ...y, unsent: { count: 0 } }] }, '2026-03-01T08:00:01.000Z');
    expect('problems' in read ? read.problems : []).toEqual([]);
    await reg.close();
  });

  it('end to end on the pure check: the box\'s unused number is never named, its waiting bills are held, an older box still names it', async () => {
    const reg = await register();
    for (let i = 0; i < 104; i += 1) await take(reg, true); // 1–104, banked at head office
    await take(reg, false); // 105: taken, never used
    for (let i = 0; i < 5; i += 1) await take(reg, true); // 106–110: waiting (the line is down)
    const [issued] = reg.issuedThrough();
    expect(issued).toEqual({ prefix: 'A1L1-', through: 110, soldThrough: 110, unused: [[105, 105]] });
    const t0 = Date.parse('2026-03-01T08:00:00.000Z');
    const rec = (min: number, x: IssuedReport): BoxHealthRecord => {
      const at = new Date(t0 + min * 60_000).toISOString();
      return { storeId: 'S1', observedAt: at, receivedAt: at, reportedBy: 'u-box', clockAheadCorrected: false, tills: [], disk: DISK, queue: { unsent: 5, deadLettered: 0 }, receiptNumbersIssued: [x] };
    };
    const withLists = { ...issued!, unsent: { count: 5, from: 106, to: 110 } };
    const records = Array.from({ length: 46 }, (_, k) => rec(k, withLists));
    const at = new Date(t0 + 46 * 60_000).toISOString();
    const banked = new Map([['A1L1-', 104]]);
    expect(unreceivedCandidates({ records, at, banked })).toEqual([]);
    // An older store computer (no `unused`): as before round 25, 105 is named.
    const { unused: _u, ...older } = withLists;
    void _u;
    expect(unreceivedCandidates({ records: Array.from({ length: 46 }, (_, k) => rec(k, older)), at, banked }).map((c) => c.numbers)).toEqual([[105]]);
    await reg.close();
  });
});
