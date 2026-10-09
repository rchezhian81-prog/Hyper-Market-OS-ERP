import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';
import { bootPos } from '../../apps/pos/src/browser-entry';
import { prepareTillBox, signInTill } from '../support/till-operator';

/**
 * **PF-05 — a held basket survives a reload, and comes back to one till, once (Wave 4 · M12-FR-02 · P-01 · hard rules
 * #1, #6).**
 *
 * The audit reproduced it with the real `bootPos`: "Hold" was a flag in the browser, so a reload lost the customer's
 * basket. A real store computer, its lane socket and disk, and the real till, no cloud: the basket is on the box's disk
 * before the till clears; a reloaded till lists it, recalls it at the prices it was held at and sells it; a second recall
 * of the same basket is refused naming the till that has it; a restart of the box keeps it; nothing is deleted.
 */

const KEY = ['held', 'basket', 'box', 'key'].join('-').padEnd(48, '0');
const dirs: string[] = [];
const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const startBox = async (opts: { dir?: string; pack?: Record<string, unknown> } = {}): Promise<{ edge: EdgeProcess; dir: string }> => {
  const dir = opts.dir ?? await mkdtemp(join(tmpdir(), 'sre-held-basket-'));
  if (opts.dir === undefined) dirs.push(dir);
  const ready = opts.dir !== undefined
    ? { EDGE_LANE_ID: 'lane-1', EDGE_PACK_FILE: join(dir, 'store-pack.json') }
    : await prepareTillBox({ dir, key: KEY, ...(opts.pack === undefined ? {} : { pack: opts.pack }) });
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
const basketOf = (t: Awaited<ReturnType<typeof till>>) => {
  t.scan({ productId: 'P1', description: 'Toor dal 1kg', unitPriceMinor: 12_000, qty: 2 });
  t.scan({ productId: 'P2', description: 'Sunflower oil 1L', unitPriceMinor: 18_000, qty: 1 });
};
const heldLog = async (dir: string) => (await readLog(join(dir, 'held-bills.log'))).flatMap((r) => (r.ok ? [JSON.parse(r.record) as { billId: string; state: string }] : []));

describe('PF-05 — Hold puts the basket on the store computer, not in the browser', () => {
  it('THE AUDIT\'S CASE: hold, reload, the basket is listed, recalled at its held prices, and sold', async () => {
    const { edge, dir } = await startBox();
    const first = await till(edge);
    basketOf(first);
    expect(first.payableMinor()).toBe(42_000);
    const held = await first.holdAtTill();
    expect(held).toMatchObject({ ok: true, billId: expect.stringMatching(/^H-lane-1-/) });
    expect(first.basket()).toHaveLength(0); // the till cleared only once the box had it
    expect(await heldLog(dir)).toEqual([expect.objectContaining({ billId: held.billId, state: 'suspended' })]);

    // The page reloads: a fresh till that remembers nothing.
    const reloaded = await till(edge);
    expect(await reloaded.heldAtTill()).toEqual([expect.objectContaining({ billId: held.billId, laneId: 'lane-1', cashierId: 'u-lanecash', lineCount: 2, valueMinor: 42_000, firstItem: 'Toor dal 1kg' })]);
    expect(await reloaded.recallAtTill(held.billId!)).toMatchObject({ ok: true });
    expect(reloaded.basket().map((l) => [l.description, l.qty, l.unitPriceMinor])).toEqual([['Toor dal 1kg', 2, 12_000], ['Sunflower oil 1L', 1, 18_000]]);
    expect(reloaded.payableMinor()).toBe(42_000);
    expect(await reloaded.heldAtTill()).toEqual([]);

    const n = await reloaded.nextReceipt();
    expect(await reloaded.tenderCash(`S-${n}`, n, new Date().toISOString())).toBe(n);
    const sold = (await readLog(edge.log.path)).flatMap((r) => (r.ok ? [JSON.parse(r.record) as { total: number }] : []));
    expect(sold).toEqual([expect.objectContaining({ total: 42_000 })]);
    // Nothing deleted: the hold and the recall are both on the box's record.
    expect((await heldLog(dir)).map((b) => b.state)).toEqual(['suspended', 'resumed']);
  });

  it('a recall is a claim: the second till to ask for the same basket is refused, and gets nothing', async () => {
    const { edge } = await startBox();
    const a = await till(edge);
    basketOf(a);
    const held = await a.holdAtTill();
    const tabB = await till(edge);
    const tabC = await till(edge);
    const [b, c] = await Promise.all([tabB.recallAtTill(held.billId!), tabC.recallAtTill(held.billId!)]);
    expect([b.ok, c.ok].sort()).toEqual([false, true]);
    const loser = b.ok ? c : b;
    expect(loser).toMatchObject({ refusedBecause: 'already_resumed', laneMessage: expect.stringMatching(/already recalled.*charge the customer twice/) });
    expect((b.ok ? tabC : tabB).basket()).toHaveLength(0);
  });

  it('the box restarts: the held basket is still there', async () => {
    const { edge, dir } = await startBox();
    const t = await till(edge);
    basketOf(t);
    const held = await t.holdAtTill();
    await edge.stop();
    stops.splice(0);
    const again = await startBox({ dir });
    expect((await (await till(again.edge)).heldAtTill()).map((b) => b.billId)).toEqual([held.billId]);
  });

  it('nothing to hold, nobody signed in, a box that cannot be reached: refused, and the basket stays on the till', async () => {
    const { edge } = await startBox();
    const t = await till(edge);
    expect(await t.holdAtTill()).toMatchObject({ ok: false, refusedBecause: 'empty_basket' });
    const nobody = bootPos({ laneId: 'lane-1', taxPercent: 0, lanePort: edge.lane!.port });
    nobody.scan({ productId: 'P1', description: 'Toor dal 1kg', unitPriceMinor: 12_000, qty: 1 });
    expect(await nobody.holdAtTill()).toMatchObject({ ok: false, refusedBecause: 'operator_not_signed_in' });
    const cut = bootPos({ laneId: 'lane-1', taxPercent: 0, lanePort: 1, cashierId: 'u-lanecash' });
    cut.scan({ productId: 'P1', description: 'Toor dal 1kg', unitPriceMinor: 12_000, qty: 1 });
    expect(await cut.holdAtTill()).toMatchObject({ ok: false, refusedBecause: 'lane_unreachable', laneMessage: expect.stringMatching(/still on the till/) });
    expect(cut.basket()).toHaveLength(1);
  });

  it('a recall never lands on a basket already on the till; the shop\'s limit on held baskets is kept', async () => {
    const { edge } = await startBox({ pack: { suspensionPolicy: { maxPerLane: 1 } } });
    const t = await till(edge);
    basketOf(t);
    const held = await t.holdAtTill();
    basketOf(t);
    expect(await t.recallAtTill(held.billId!)).toMatchObject({ ok: false, refusedBecause: 'basket_not_empty' });
    expect(await t.holdAtTill()).toMatchObject({ ok: false, refusedBecause: 'lane_limit_reached' });
    expect(t.basket()).toHaveLength(2); // refused: still on the till
  });

  it('a basket given up is kept on the record with who and why — and can no longer be recalled', async () => {
    const { edge, dir } = await startBox();
    const t = await till(edge);
    basketOf(t);
    const held = await t.holdAtTill();
    expect(await t.abandonAtTill(held.billId!, '')).toMatchObject({ ok: false });
    expect(await t.abandonAtTill(held.billId!, 'customer left')).toMatchObject({ ok: true });
    expect(await t.heldAtTill()).toEqual([]);
    expect(await t.recallAtTill(held.billId!)).toMatchObject({ ok: false, refusedBecause: 'abandoned' });
    expect((await heldLog(dir)).map((b) => b.state)).toEqual(['suspended', 'abandoned']);
  });
});
