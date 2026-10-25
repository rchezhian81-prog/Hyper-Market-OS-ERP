import { describe, it, expect, afterEach } from 'vitest';
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QueueBaskets } from '../../edge/store-edge/src/queue-baskets';
import { readLog } from '../../edge/store-edge/src/file-log';

/**
 * **D04-FR-05 queue-busting — the store computer's queue-basket register, on a real disk.** A hand-over is on the fsync'd
 * log before the handheld hears its code; two tills keying the same code at the same moment are answered in turn and only
 * one gets the lines; everything survives a cold restart exactly as it stood; a record that cannot be read is counted and
 * kept, never repaired; a write that fails changes nothing and says so. Nothing is ever deleted (hard rule #6).
 */

const HH = 'device:hh-q1';
const LINES = [{ productId: 'P-DAL', name: 'Toor dal 1kg', barcode: '8901234567890', quantityMinor: 2 }];
const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
const fresh = async (): Promise<string> => { const d = await mkdtemp(join(tmpdir(), 'sre-queue-baskets-')); dirs.push(d); return d; };
const open = (dir: string, codes: readonly string[] = ['0042', '0043', '0044']) => QueueBaskets.open({ dataDir: dir, capacityBytes: 10_000_000, codes: () => codes });

describe('queue baskets on the store computer\'s disk', () => {
  it('a hand-over is on the log before its code is given; two tills keying one code at once — only one gets it', async () => {
    const dir = await fresh();
    const reg = await open(dir);
    const handed = await reg.handOver({ handheldLane: HH, by: 'u-ravi', basketId: 'B-1', lines: LINES, handheldTotalMinor: 24_000 });
    expect(handed).toMatchObject({ handedOver: true, code: '0042', lineCount: 1 });
    expect((await readLog(join(dir, 'queue-baskets.log'))).filter((r) => r.ok)).toHaveLength(1);
    const [a, b] = await Promise.all([
      reg.recall({ code: '0042', laneId: 'lane-1', cashierId: 'u-asha' }),
      reg.recall({ code: '0042', laneId: 'lane-2', cashierId: 'u-meena' }),
    ]);
    expect(a).toMatchObject({ recalled: true, code: '0042', lines: LINES, handheldTotalMinor: 24_000, handedOverBy: 'u-ravi' });
    expect(b).toEqual({ recalled: false, refusedBecause: 'already_recalled', laneMessage: expect.stringMatching(/brought up on lane-1/) });
    await reg.close();
  });

  it('a lost reply re-sent is the same hand-over — one record, one code', async () => {
    const dir = await fresh();
    const reg = await open(dir);
    const first = await reg.handOver({ handheldLane: HH, by: 'u-ravi', basketId: 'B-1', lines: LINES, handheldTotalMinor: 24_000 });
    const again = await reg.handOver({ handheldLane: HH, by: 'u-ravi', basketId: 'B-1', lines: LINES, handheldTotalMinor: 24_000 });
    expect([first, again].map((x) => (x.handedOver ? x.code : x.refusedBecause))).toEqual(['0042', '0042']);
    expect((await readLog(join(dir, 'queue-baskets.log'))).filter((r) => r.ok)).toHaveLength(1);
    await reg.close();
  });

  it('a cold restart reads every basket back as it stood — waiting, recalled, given up — and the history stays on the disk', async () => {
    const dir = await fresh();
    const reg = await open(dir);
    await reg.handOver({ handheldLane: HH, by: 'u-ravi', basketId: 'B-1', lines: LINES, handheldTotalMinor: 24_000 });
    await reg.handOver({ handheldLane: HH, by: 'u-ravi', basketId: 'B-2', lines: LINES, handheldTotalMinor: 24_000 });
    await reg.handOver({ handheldLane: HH, by: 'u-ravi', basketId: 'B-3', lines: LINES, handheldTotalMinor: 24_000 });
    await reg.recall({ code: '0042', laneId: 'lane-1', cashierId: 'u-asha' });
    expect(await reg.giveUp({ handheldLane: HH, by: 'u-ravi', code: '0043', reason: 'Customer left the queue' })).toMatchObject({ givenUp: true });
    await reg.close();

    const back = await open(dir);
    expect(back.unreadableRecords).toBe(0);
    expect(back.waiting(HH).map((w) => w.code)).toEqual(['0044']);
    expect(await back.recall({ code: '0042', laneId: 'lane-2', cashierId: 'u-meena' })).toMatchObject({ recalled: false, refusedBecause: 'already_recalled' });
    expect(await back.recall({ code: '0043', laneId: 'lane-2', cashierId: 'u-meena' })).toMatchObject({ recalled: false, refusedBecause: 'given_up' });
    expect(await back.recall({ code: '0044', laneId: 'lane-2', cashierId: 'u-meena' })).toMatchObject({ recalled: true });
    // Every state each basket passed through is still on the log (hard rule #6): 3 hand-overs, 2 recalls, 1 give-up.
    const states = (await readLog(join(dir, 'queue-baskets.log'))).flatMap((r) => (r.ok ? [(JSON.parse(r.record) as { state: string }).state] : []));
    expect(states.sort()).toEqual(['given_up', 'recalled', 'recalled', 'waiting', 'waiting', 'waiting']);
    await back.close();
  });

  it('a record that cannot be read is counted and kept, never repaired; a failed write changes nothing and says so', async () => {
    const dir = await fresh();
    const reg = await open(dir);
    await reg.handOver({ handheldLane: HH, by: 'u-ravi', basketId: 'B-1', lines: LINES, handheldTotalMinor: 24_000 });
    await reg.close();
    // One whole record that is not a basket, and one cut off half-way (a power cut mid-write).
    const notABasket = JSON.stringify({ not: 'a basket' });
    await appendFile(join(dir, 'queue-baskets.log'), `${Buffer.byteLength(notABasket)} ${notABasket}\n40 {"basketId":"B-9"`, 'utf8');
    const back = await open(dir);
    expect(back.unreadableRecords).toBe(2);
    expect(back.waiting(HH).map((w) => w.code)).toEqual(['0042']);
    // The disk goes away under the register: the hand-over is refused in words and nothing changes here.
    await back.close();
    const refused = await back.handOver({ handheldLane: HH, by: 'u-ravi', basketId: 'B-2', lines: LINES, handheldTotalMinor: 1 });
    expect(refused).toMatchObject({ handedOver: false, refusedBecause: 'could_not_write_durably', laneMessage: expect.stringMatching(/still on this handheld — do not clear it/), laneMessageTa: expect.stringMatching(/[஀-௿]/) });
    const recall = await back.recall({ code: '0042', laneId: 'lane-1', cashierId: 'u-asha' });
    expect(recall).toMatchObject({ recalled: false, refusedBecause: 'could_not_write_durably' });
    expect(back.waiting(HH).map((w) => w.code)).toEqual(['0042']);
  });
});
