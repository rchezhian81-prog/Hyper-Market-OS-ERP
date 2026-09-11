import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startEdge } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';
import { ReturnEntitlement } from '../../edge/store-edge/src/entitlement';
import { createTillSession, RefundNotEntitledError, type DurableReturnWrite } from '../../apps/pos/src/till-session';
import { Ledger, InMemoryLedgerStore } from '../../packages/ledger/src/ledger';
import { SyncOutbox } from '../../packages/sync/src/outbox';
import { money } from '../../packages/contracts/src/money';
import type { CommitOutcome } from '../../edge/store-edge/src/durability';

/**
 * **RR-F04 — entitlement from trusted data, not the caller's memory.**
 *
 * The at-most-once rule was enforced against `originalQtyMinor` and a prior-return total the request
 * supplied, so a second refund with a NEW id for the same unit passed by re-asserting
 * `originalQtyMinor=1` and omitting the prior return. Now the edge computes entitlement from what it
 * durably knows — how much the sale it rang actually sold, and how much has already come back — and
 * reserves the returned quantity atomically. A sale this edge did not ring cannot be checked here and
 * follows an explicit safe policy (allowed under the existing controls; global at-most-once is the
 * cloud's job, never claimed locally). Drives the real edge; synthetic data only.
 */

const KEY = ['refund', 'entitle', 'signing', 'key'].join('-').padEnd(48, '0');
const dirs: string[] = [];
const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const boot = async (dir: string) => {
  const edge = (await startEdge({
    EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
  }, () => {}))!;
  stops.push(() => edge.stop());
  return edge;
};
const fresh = async () => { const dir = await mkdtemp(join(tmpdir(), 'rrf04-')); dirs.push(dir); return { dir, edge: await boot(dir) }; };
const sale = (id: string, qty: number) => JSON.stringify({
  id, number: `INV-${id}`, laneId: 'lane-1',
  lines: [{ productId: 'P1', quantityMinor: qty, uom: 'ea', unitPriceMinor: 10_000, lineTotalMinor: 10_000 }],
  tenders: [{ kind: 'cash', amountMinor: 10_000 }],
});
const refund = (id: string, saleId: string, qty: number) => JSON.stringify({
  id, returnId: id, originalSaleId: saleId, number: `RET-${id}`, processedBy: 'u-meena',
  reasonCode: 'damaged', refundMinor: 10_000, currency: 'INR', refundTender: 'cash',
  processedAt: '2026-09-11T10:00:00Z', lines: [{ productId: 'P1', uom: 'ea', quantityMinor: qty, disposition: 'resell' }],
});

describe('RR-F04 — the edge enforces refund entitlement from trusted local data', () => {
  it('valid first refund succeeds; a second full refund of the same unit is refused (over_return)', async () => {
    const { edge } = await fresh();
    await edge.node.commit('S-1', sale('S-1', 1));            // sold: 1 unit
    const first = await edge.node.commitReturn('RET-A', refund('RET-A', 'S-1', 1));
    const second = await edge.node.commitReturn('RET-B', refund('RET-B', 'S-1', 1)); // new id, no history
    expect(first.committed).toBe(true);
    expect(second.committed).toBe(false);
    expect(second.refusedBecause).toBe('over_return');
    expect(await readLog(edge.returnsLog.path)).toHaveLength(1);
  });

  it('does NOT reject every refund: legitimate partial refunds up to the sold quantity all pass', async () => {
    const { edge } = await fresh();
    await edge.node.commit('S-3', sale('S-3', 3));            // sold: 3 units
    const outcomes = [];
    for (const i of [1, 2, 3, 4]) outcomes.push(await edge.node.commitReturn(`P${i}`, refund(`P${i}`, 'S-3', 1)));
    expect(outcomes.slice(0, 3).every((o) => o.committed)).toBe(true);   // three of three sold — all fine
    expect(outcomes[3]!.committed).toBe(false);                          // the fourth exceeds
    expect(outcomes[3]!.refusedBecause).toBe('over_return');
  });

  it('is enforced after a restart, rebuilt from the durable logs', async () => {
    const { dir, edge } = await fresh();
    await edge.node.commit('S-1', sale('S-1', 1));
    await edge.node.commitReturn('RET-A', refund('RET-A', 'S-1', 1));
    await edge.stop(); stops.length = 0;
    const back = await boot(dir);
    const afterRestart = await back.node.commitReturn('RET-C', refund('RET-C', 'S-1', 1)); // new id
    expect(afterRestart.committed).toBe(false);
    expect(afterRestart.refusedBecause).toBe('over_return');
  });

  it('two concurrent refunds of the last unit: at most one is entitled', async () => {
    const { edge } = await fresh();
    await edge.node.commit('S-4', sale('S-4', 1));
    const [a, b] = await Promise.all([
      edge.node.commitReturn('C1', refund('C1', 'S-4', 1)),
      edge.node.commitReturn('C2', refund('C2', 'S-4', 1)),
    ]);
    expect([a, b].filter((o) => o.committed)).toHaveLength(1);
    expect(await readLog(edge.returnsLog.path)).toHaveLength(1);
  });

  it('a refund against a sale this edge did not ring is allowed (safe policy, not locally claimed)', async () => {
    const { edge } = await fresh();
    // No local sale S-OTHER — cross-lane / disconnected. The edge cannot establish entitlement, so it
    // does not block the refund; global at-most-once is left to cloud reconciliation.
    const outcome = await edge.node.commitReturn('RET-X', refund('RET-X', 'S-OTHER', 1));
    expect(outcome.committed).toBe(true);
  });
});

describe('RR-F04 — the till surfaces an over-return explicitly', () => {
  it('throws RefundNotEntitledError when the edge reports over_return', async () => {
    const till = createTillSession(
      { tillId: 'till-1', laneId: 'lane-1', cashierId: 'u-meena', tradingDay: '2026-09-11', varianceToleranceMinor: 10_000 },
      new Ledger(new InMemoryLedgerStore()), new Ledger(new InMemoryLedgerStore()), new SyncOutbox(),
      (async () => ({ committed: false, refusedBecause: 'over_return', detail: 'already refunded', laneMessage: 'Already refunded.' } as CommitOutcome)) as DurableReturnWrite,
    );
    await expect(till.refund({
      id: 'R-till', number: 'RET-till', originalSaleId: 'S-1', processedAt: '2026-09-11T10:00:00Z', reasonCode: 'damaged',
      lines: [{ productId: 'P1', uom: 'ea', quantityMinor: 1, originalQtyMinor: 1, disposition: 'resell' }],
      refund: money(10_000, 'INR'), refundTender: 'cash', maxRefund: money(10_000, 'INR'), approvalThresholdMinor: 100_000,
    })).rejects.toBeInstanceOf(RefundNotEntitledError);
  });
});

describe('RR-F04 — the entitlement calculation, unit-tested', () => {
  it('allows up to the sold quantity across accumulating returns, then refuses', () => {
    const ent = new ReturnEntitlement([{ saleId: 'S', lines: [{ productId: 'P1', quantityMinor: 2 }] }], []);
    expect(ent.check('S', [{ productId: 'P1', quantityMinor: 2 }]).ok).toBe(true);
    ent.reserve('S', [{ productId: 'P1', quantityMinor: 1 }]);
    expect(ent.check('S', [{ productId: 'P1', quantityMinor: 1 }]).ok).toBe(true);  // 1 already back, 1 more ok
    ent.reserve('S', [{ productId: 'P1', quantityMinor: 1 }]);
    expect(ent.check('S', [{ productId: 'P1', quantityMinor: 1 }]).ok).toBe(false); // 2 back of 2 sold
    expect(ent.saleKnown('S')).toBe(true);
    expect(ent.saleKnown('OTHER')).toBe(false);
  });
});
