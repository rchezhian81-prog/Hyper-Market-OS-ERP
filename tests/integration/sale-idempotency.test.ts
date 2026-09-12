import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startEdge } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';
import { canonicalHash, IdempotencyGuard } from '../../edge/store-edge/src/idempotency';

/**
 * **GAP-SALE-IDEMPOTENCY-01 — a sale id is an operation identity, not a slot to overwrite.**
 *
 * The sale path had the same reused-id exposure RR-F03 fixed for refunds: `createEdgeNode.commit`
 * appended a sale on every call with no operation-identity guard, so the same sale id committed twice
 * with a different payload wrote two conflicting records and both "succeeded" (the outbox deduped the
 * cloud send on the key, hiding the split). Now the edge enforces operation identity + canonical
 * payload identity before anything is written — the exact mirror of the returns guard: an identical
 * retry returns the original outcome with no new effect; a reused id with a different payload is an
 * explicit conflict. Proven across retries, concurrency and restart, with the ordinary fresh sale
 * left untouched. Synthetic data; nothing touches production (hard rule #7).
 */

const KEY = ['sale', 'idem', 'signing', 'key'].join('-').padEnd(48, '0');
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
const rec = (id: string, minor: number) => JSON.stringify({
  id, number: `BILL-${id}`, laneId: 'lane-1', cashierId: 'u-meena', total: minor, currency: 'INR',
  soldAt: '2026-09-11T10:00:00Z',
  lines: [{ productId: 'P1', qty: 1, unitPriceMinor: minor }],
  tenders: [{ kind: 'cash', amount: { minor } }],
});

describe('GAP-SALE-IDEMPOTENCY-01 — the edge enforces sale operation identity', () => {
  it('same id, different money: the second is an explicit conflict and writes nothing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'salei-')); dirs.push(dir);
    const edge = await start(dir);
    const first = await edge.node.commit('S-dup', rec('S-dup', 5_000));
    const second = await edge.node.commit('S-dup', rec('S-dup', 6_000));
    expect(first.committed).toBe(true);
    expect(second.committed).toBe(false);
    expect(second.refusedBecause).toBe('idempotency_conflict');
    expect(await readLog(edge.log.path)).toHaveLength(1);   // only the first was written
    expect(edge.outbox.all()).toHaveLength(1);              // only the first was queued
  });

  it('identical retry: returns the original outcome with no extra durable or queued effect', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'salei-')); dirs.push(dir);
    const edge = await start(dir);
    const first = await edge.node.commit('S-1', rec('S-1', 5_000));
    const retry = await edge.node.commit('S-1', rec('S-1', 5_000));
    expect(first.committed).toBe(true);
    expect(retry.committed).toBe(true);
    expect(await readLog(edge.log.path)).toHaveLength(1);
    expect(edge.outbox.all()).toHaveLength(1);
  });

  it('an ordinary fresh sale still commits and queues — the guard does not block the happy path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'salei-')); dirs.push(dir);
    const edge = await start(dir);
    const a = await edge.node.commit('S-1', rec('S-1', 5_000));
    const b = await edge.node.commit('S-2', rec('S-2', 7_000));  // a genuinely different sale
    expect(a.committed).toBe(true);
    expect(b.committed).toBe(true);
    expect(await readLog(edge.log.path)).toHaveLength(2);
    expect(edge.outbox.all()).toHaveLength(2);
  });

  it('the conflict is still enforced after a restart (rebuilt from the durable log)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'salei-')); dirs.push(dir);
    const edge = await start(dir);
    await edge.node.commit('S-1', rec('S-1', 5_000));
    await edge.stop();
    stops.length = 0;
    const back = await start(dir);
    const afterRestart = await back.node.commit('S-1', rec('S-1', 6_000)); // different money
    expect(afterRestart.committed).toBe(false);
    expect(afterRestart.refusedBecause).toBe('idempotency_conflict');
    expect(await readLog(back.log.path)).toHaveLength(1);
    // and an identical retry after restart is still a harmless duplicate, not a second write
    const dupAfterRestart = await back.node.commit('S-1', rec('S-1', 5_000));
    expect(dupAfterRestart.committed).toBe(true);
    expect(await readLog(back.log.path)).toHaveLength(1);
  });

  it('two concurrent calls with the same id race to at most one durable write', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'salei-')); dirs.push(dir);
    const edge = await start(dir);
    const [a, b] = await Promise.all([
      edge.node.commit('S-conc', rec('S-conc', 5_000)),
      edge.node.commit('S-conc', rec('S-conc', 6_000)),
    ]);
    expect([a, b].filter((o) => o.committed)).toHaveLength(1);   // exactly one won
    expect(await readLog(edge.log.path)).toHaveLength(1);
    expect(edge.outbox.all()).toHaveLength(1);
  });
});

describe('GAP-SALE-IDEMPOTENCY-01 — canonical payload identity for a sale record', () => {
  it('same content in a different key order hashes the same; different money hashes differently', () => {
    const a = JSON.stringify({ id: 'S', total: 5_000, laneId: 'lane-1' });
    const b = JSON.stringify({ laneId: 'lane-1', id: 'S', total: 5_000 }); // reordered
    const c = JSON.stringify({ id: 'S', total: 6_000, laneId: 'lane-1' }); // different money
    expect(canonicalHash(a)).toBe(canonicalHash(b));
    expect(canonicalHash(a)).not.toBe(canonicalHash(c));
  });

  it('the guard classifies fresh / duplicate / conflict for a sale id', () => {
    const g = new IdempotencyGuard([['S-1', canonicalHash(rec('S-1', 5_000))]]);
    expect(g.verdict('S-2', 'anything').kind).toBe('fresh');
    expect(g.verdict('S-1', canonicalHash(rec('S-1', 5_000))).kind).toBe('duplicate');
    expect(g.verdict('S-1', canonicalHash(rec('S-1', 6_000))).kind).toBe('conflict');
  });
});
