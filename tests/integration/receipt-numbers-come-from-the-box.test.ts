import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';
import { bootPos } from '../../apps/pos/src/browser-entry';
import { prepareTillBox, signInTill, signInAtLane, operatorHeader } from '../support/till-operator';

/**
 * **PF-04 — receipt numbers come from the store computer's disk, never from the browser's memory (Wave 4 · M01-FR-02 ·
 * M12-FR-02 · P-01 · P-08).**
 *
 * The audit reproduced it: reload the till and the next bill was numbered from the start of the range again — two bills,
 * one number. A real store computer, its lane socket and disk, and the real `bootPos` till, no cloud: each number is
 * issued by the box and saved before the till hears it; a reload, a second tab and a restart all continue; a lost reply
 * re-asked gets the same number; a spent range refuses (no money is taken — a box that cannot save is proved in
 * tests/unit/receipt-numbers.test.ts); a bill can only
 * carry a number this box gave this till and no other bill used; and a number given but never used stays visible.
 */

const KEY = ['receipt', 'numbers', 'box', 'key'].join('-').padEnd(48, '0');
const dirs: string[] = [];
const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const SERIES = { laneId: 'lane-1', prefix: 'R-L1-', padTo: 4, rangeStart: 1, rangeEnd: 5, warnAtRemaining: 2 };

const startBox = async (opts: { dir?: string; series?: unknown } = {}): Promise<{ edge: EdgeProcess; dir: string }> => {
  const dir = opts.dir ?? await mkdtemp(join(tmpdir(), 'sre-receipt-numbers-'));
  if (opts.dir === undefined) dirs.push(dir);
  const ready = opts.dir !== undefined
    ? { EDGE_LANE_ID: 'lane-1', EDGE_PACK_FILE: join(dir, 'store-pack.json') }
    : await prepareTillBox({ dir, key: KEY, pack: opts.series === null ? {} : { receiptSeries: [opts.series ?? SERIES] } });
  const edge = (await startEdge({
    EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0', ...ready,
  }, () => {}))!;
  stops.push(() => edge.stop());
  return { edge, dir };
};
const till = async (edge: EdgeProcess) => {
  const t = bootPos({ laneId: 'lane-1', taxPercent: 0, lanePort: edge.lane!.port });
  await signInTill(t, 'u-lanecash');
  return t;
};
const ring = async (t: Awaited<ReturnType<typeof till>>, receipt: string) => {
  t.scan({ productId: 'P1', description: 'Toor dal 1kg', unitPriceMinor: 12_000, qty: 1 });
  const done = await t.tenderCash(`S-${receipt}`, receipt, new Date().toISOString());
  t.newSale();
  return done;
};
const status = async (edge: EdgeProcess) => (await fetch(`http://127.0.0.1:${edge.lane!.port}/lane/receipt-numbers`)).json() as Promise<Record<string, unknown>>;
const sales = async (edge: EdgeProcess) => (await readLog(edge.log.path)).flatMap((r) => (r.ok ? [JSON.parse(r.record) as { id: string; number: string }] : []));

describe('PF-04 — a reload, a second tab and a restart never repeat a receipt number', () => {
  it('THE AUDIT\'S CASE: two bills, then the till is reloaded — the next bill is 0003, not 0001 again', async () => {
    const { edge } = await startBox();
    const first = await till(edge);
    const a = await first.nextReceipt();
    await ring(first, a);
    const b = await first.nextReceipt();
    await ring(first, b);
    expect([a, b]).toEqual(['R-L1-0001', 'R-L1-0002']);

    // The page is reloaded: a fresh till, nothing remembered in the browser.
    const reloaded = await till(edge);
    const c = await reloaded.nextReceipt();
    expect(c).toBe('R-L1-0003');
    await ring(reloaded, c);
    expect((await sales(edge)).map((s) => s.number)).toEqual(['R-L1-0001', 'R-L1-0002', 'R-L1-0003']);
  });

  it('two tabs asking at the same moment get two different numbers', async () => {
    const { edge } = await startBox();
    const tabA = await till(edge);
    const tabB = bootPos({ laneId: 'lane-1', taxPercent: 0, lanePort: edge.lane!.port });
    const both = await Promise.all([tabA.nextReceipt(), tabB.nextReceipt(), tabA.nextReceipt()]);
    expect(new Set(both).size).toBe(3);
    expect([...both].sort()).toEqual(['R-L1-0001', 'R-L1-0002', 'R-L1-0003']);
  });

  it('the box restarts: it carries on from its disk', async () => {
    const { edge, dir } = await startBox();
    const t = await till(edge);
    await ring(t, await t.nextReceipt());
    await t.nextReceipt(); // given, never used
    await edge.stop();
    stops.splice(0);
    const again = await startBox({ dir });
    const t2 = await till(again.edge);
    expect(await t2.nextReceipt()).toBe('R-L1-0003');
  });

  it('a reply lost on the way back, re-asked with the same request key, gets the same number — not a second one', async () => {
    const { edge } = await startBox();
    const token = await signInAtLane(edge.lane!.port, 'u-lanecash');
    const ask = async (requestKey: string) => (await fetch(`http://127.0.0.1:${edge.lane!.port}/lane/receipt-numbers`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...operatorHeader(token) }, body: JSON.stringify({ requestKey }),
    })).json() as Promise<{ receiptNumber?: string }>;
    const once = await ask('rq-lost-reply');
    const twice = await ask('rq-lost-reply');
    expect(once.receiptNumber).toBe('R-L1-0001');
    expect(twice.receiptNumber).toBe('R-L1-0001');
    expect((await ask('rq-next')).receiptNumber).toBe('R-L1-0002');
  });

  it('nobody signed in: no number is given', async () => {
    const { edge } = await startBox();
    const t = bootPos({ laneId: 'lane-1', taxPercent: 0, lanePort: edge.lane!.port });
    await expect(t.nextReceipt()).rejects.toMatchObject({ laneMessage: expect.stringMatching(/sign in/i) });
    expect(await status(edge)).toMatchObject({ issued: 0 });
  });
});

describe('PF-04 — a spent range or a box that cannot save stops the till; nothing is invented', () => {
  it('the range runs low (said on the answer), then is spent: refused, take no money', async () => {
    const { edge } = await startBox();
    const t = await till(edge);
    for (let i = 0; i < 2; i += 1) await t.nextReceipt();
    expect(t.receiptNotice()).toBeUndefined(); // 3 left, above the warning of 2
    await t.nextReceipt(); // 0003 — 2 left: running low
    expect(t.receiptNotice()).toMatch(/2 receipt number\(s\) left/);
    await t.nextReceipt();
    expect(await t.nextReceipt()).toBe('R-L1-0005');
    await expect(t.nextReceipt()).rejects.toMatchObject({ refusedBecause: 'receipt_numbers_used_up', laneMessage: expect.stringMatching(/Do not take money/) });
  });

  it('no range published for this till: the box numbers its bills itself and says so on every answer and on its account', async () => {
    const { edge } = await startBox({ series: null });
    const t = await till(edge);
    const n = await t.nextReceipt();
    expect(n).toBe('R-lane-1-000001');
    expect(t.receiptNotice()).toMatch(/Head office has not set up a receipt-number range/);
    expect(await status(edge)).toMatchObject({ source: 'this_box', laneMessage: expect.stringMatching(/not set up/) });
  });
});

describe('PF-04 — a bill carries only a number this box gave this till, once', () => {
  it('a number the box never gave is refused before the disk', async () => {
    const { edge } = await startBox();
    const t = await till(edge);
    await expect(ring(t, 'R-MADE-UP-1')).rejects.toThrow(/was not given to this till/);
    expect(await sales(edge)).toHaveLength(0);
  });

  it('a number already on one bill is refused on another; the same bill re-sent is the same use', async () => {
    const { edge } = await startBox();
    const t = await till(edge);
    const n = await t.nextReceipt();
    await ring(t, n);
    t.scan({ productId: 'P2', description: 'Sugar 1kg', unitPriceMinor: 5_000, qty: 1 });
    await expect(t.tenderCash('S-other', n, new Date().toISOString())).rejects.toThrow(/already on another bill/);
    expect((await sales(edge)).map((s) => s.id)).toEqual([`S-${n}`]);
  });

  it('the account: issued, used, left — and the number given but never used is listed with who asked and when', async () => {
    const { edge } = await startBox();
    const t = await till(edge);
    await ring(t, await t.nextReceipt());
    const unused = await t.nextReceipt();
    await ring(t, await t.nextReceipt());
    expect(await status(edge)).toMatchObject({
      source: 'published', prefix: 'R-L1-', issued: 3, used: 2, remaining: 2,
      issuedNotUsed: [{ receiptNumber: unused, issuedTo: 'u-lanecash', issuedAt: expect.any(String) }],
    });
  });
});
