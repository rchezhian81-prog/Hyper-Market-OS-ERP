import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startEdge } from '../../edge/store-edge/src/main';
import { returnRegister, returnableLines } from '../../packages/returns/src/return-register';

/**
 * **Receipt lookup end-to-end at the lane (M13-FR-01, §31).**
 *
 * Drives the REAL startEdge: a sale committed through node.commit, then a refund through
 * node.commitReturn, then node.lookupSale — proving the lookup reads the durable logs LIVE (so a
 * bill rung earlier in this same session is found, not just those on disk at boot) and that its
 * output folds through the register into what is still returnable. No database needed; synthetic
 * data only (hard rule #7).
 */

const KEY = ['receipt', 'lookup', 'signing', 'key'].join('-').padEnd(48, '0');
const dirs: string[] = [];
const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const env = (dir: string) => ({
  EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
});
const start = async (dir: string) => {
  const edge = (await startEdge(env(dir), () => {}))!;
  stops.push(() => edge.stop());
  return edge;
};

const saleRecord = JSON.stringify({
  id: 'S-1', number: 'B-1', laneId: 'lane-1', cashierId: 'u-meena',
  tradingDay: '2026-08-05', committedAt: '2026-08-05T10:00:00Z',
  total: 20_000, currency: 'INR',
  lines: [
    { productId: 'P1', quantityMinor: 2, uom: 'ea', unitPriceMinor: 7_500 },
    { productId: 'P2', quantityMinor: 1, uom: 'ea', unitPriceMinor: 5_000 },
  ],
  tenders: [{ kind: 'cash', amount: { minor: 20_000, currency: 'INR' }, status: 'settled' }],
});

const refundRecord = JSON.stringify({
  returnId: 'R-1', number: 'RET-1', originalSaleId: 'S-1', processedBy: 'u-meena',
  reasonCode: 'damaged', refundMinor: 7_500, currency: 'INR', refundTender: 'cash',
  processedAt: '2026-08-05T11:00:00Z',
  lines: [{ productId: 'P1', uom: 'ea', quantityMinor: 1, disposition: 'resell' }],
});

describe('the lane can look up a bill it rang', () => {
  it('finds a sale committed in this session, by receipt number and by id', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rlk-')); dirs.push(dir);
    const edge = await start(dir);
    await edge.node.commit('S-1', saleRecord);

    const byNumber = await edge.node.lookupSale('B-1');
    const byId = await edge.node.lookupSale('S-1');
    expect(byNumber?.sale.saleId).toBe('S-1');
    expect(byId?.sale.number).toBe('B-1');
    expect(byId?.sale.totalMinor).toBe(20_000);
    expect(byId?.returns).toHaveLength(0); // nothing returned yet
  });

  it('reflects a refund taken in the same session — returnable drops', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rlk-')); dirs.push(dir);
    const edge = await start(dir);
    await edge.node.commit('S-1', saleRecord);
    const refund = await edge.node.commitReturn('R-1', refundRecord);
    expect(refund.committed).toBe(true);

    const result = (await edge.node.lookupSale('B-1'))!;
    expect(result.returns).toHaveLength(1);
    const p1 = returnableLines(result.sale, returnRegister(result.returns)).find((l) => l.productId === 'P1')!;
    expect(p1).toMatchObject({ soldMinor: 2, alreadyReturnedMinor: 1, returnableMinor: 1 });
  });

  it('survives a restart — the bill is rebuilt from the durable log', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rlk-')); dirs.push(dir);
    const edge = await start(dir);
    await edge.node.commit('S-1', saleRecord);
    await edge.stop();
    stops.length = 0;

    const back = await start(dir);
    expect((await back.node.lookupSale('S-1'))?.sale.totalMinor).toBe(20_000);
  });

  it('resolves undefined for a bill this lane did not ring', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rlk-')); dirs.push(dir);
    const edge = await start(dir);
    expect(await edge.node.lookupSale('B-nope')).toBeUndefined();
  });
});
