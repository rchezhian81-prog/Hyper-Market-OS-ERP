import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startEdge } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';
import { canonicalHash, IdempotencyGuard } from '../../edge/store-edge/src/idempotency';
import { createTillSession, RefundConflictError, LocalRefundRefusedError, type DurableReturnWrite } from '../../apps/pos/src/till-session';
import { Ledger, InMemoryLedgerStore } from '../../packages/ledger/src/ledger';
import { SyncOutbox } from '../../packages/sync/src/outbox';
import { money } from '../../packages/contracts/src/money';
import type { CommitOutcome } from '../../edge/store-edge/src/durability';

/**
 * **RR-F03 — a refund id is an operation identity, not a slot to overwrite.**
 *
 * Before: the edge appended a refund to its durable log on every call, so the same id sent twice with
 * different money wrote two conflicting records and both "succeeded"; the outbox deduped the cloud
 * send on the key, hiding the split. Now the edge enforces operation identity + canonical payload
 * identity before anything is written: identical retry -> original outcome, no new effect; different
 * money under the same id -> explicit conflict. Proven across retries, concurrency and restart.
 */

const KEY = ['refund', 'idem', 'signing', 'key'].join('-').padEnd(48, '0');
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
  id, returnId: id, originalSaleId: 'S-1', number: `RET-${id}`, processedBy: 'u-meena',
  reasonCode: 'damaged', refundMinor: minor, currency: 'INR', refundTender: 'cash',
  processedAt: '2026-09-11T10:00:00Z', lines: [{ productId: 'P1', uom: 'ea', quantityMinor: 1, disposition: 'resell' }],
});

describe('RR-F03 — the edge enforces refund operation identity', () => {
  it('same id, different money: the second is an explicit conflict and writes nothing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rrf03-')); dirs.push(dir);
    const edge = await start(dir);
    const first = await edge.node.commitReturn('R-repeat', rec('R-repeat', 5_000));
    const second = await edge.node.commitReturn('R-repeat', rec('R-repeat', 6_000));
    expect(first.committed).toBe(true);
    expect(second.committed).toBe(false);
    expect(second.refusedBecause).toBe('idempotency_conflict');
    expect(await readLog(edge.returnsLog.path)).toHaveLength(1);       // only the first was written
    expect(edge.returnsOutbox.all()).toHaveLength(1);                  // only the first was queued
  });

  it('identical retry: returns the original outcome with no extra durable or queued effect', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rrf03-')); dirs.push(dir);
    const edge = await start(dir);
    await edge.node.commitReturn('R-1', rec('R-1', 5_000));
    const retry = await edge.node.commitReturn('R-1', rec('R-1', 5_000));
    expect(retry.committed).toBe(true);
    expect(await readLog(edge.returnsLog.path)).toHaveLength(1);
    expect(edge.returnsOutbox.all()).toHaveLength(1);
  });

  it('the conflict is still enforced after a restart (rebuilt from the durable log)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rrf03-')); dirs.push(dir);
    const edge = await start(dir);
    await edge.node.commitReturn('R-1', rec('R-1', 5_000));
    await edge.stop();
    stops.length = 0;
    const back = await start(dir);
    const afterRestart = await back.node.commitReturn('R-1', rec('R-1', 6_000)); // different money
    expect(afterRestart.committed).toBe(false);
    expect(afterRestart.refusedBecause).toBe('idempotency_conflict');
    expect(await readLog(back.returnsLog.path)).toHaveLength(1);
  });

  it('two concurrent calls with the same id race to at most one durable write', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rrf03-')); dirs.push(dir);
    const edge = await start(dir);
    const [a, b] = await Promise.all([
      edge.node.commitReturn('R-conc', rec('R-conc', 5_000)),
      edge.node.commitReturn('R-conc', rec('R-conc', 6_000)),
    ]);
    expect([a, b].filter((o) => o.committed)).toHaveLength(1);        // exactly one won
    expect(await readLog(edge.returnsLog.path)).toHaveLength(1);
  });
});

describe('RR-F03 — the till surfaces the conflict explicitly', () => {
  const tillWith = (durableReturn: DurableReturnWrite) => createTillSession(
    { tillId: 'till-1', laneId: 'lane-1', cashierId: 'u-meena', tradingDay: '2026-09-11', varianceToleranceMinor: 10_000 },
    new Ledger(new InMemoryLedgerStore()), new Ledger(new InMemoryLedgerStore()), new SyncOutbox(), durableReturn,
  );
  const refundInput = (minor: number) => ({
    id: 'R-till', number: 'RET-till', originalSaleId: 'S-1', processedAt: '2026-09-11T10:00:00Z', reasonCode: 'damaged',
    lines: [{ productId: 'P1', uom: 'ea' as const, quantityMinor: 1, originalQtyMinor: 1, disposition: 'resell' as const }],
    refund: money(minor, 'INR'), refundTender: 'cash' as const, maxRefund: money(minor, 'INR'), approvalThresholdMinor: 100_000,
  });

  it('throws RefundConflictError (not a plain refusal) when the edge reports a conflict', async () => {
    const conflict: DurableReturnWrite = async () => ({
      committed: false, refusedBecause: 'idempotency_conflict', detail: 'reused id', laneMessage: 'This refund ID was already used.',
    } as CommitOutcome);
    await expect(tillWith(conflict).refund(refundInput(6_000))).rejects.toBeInstanceOf(RefundConflictError);
  });

  it('still throws LocalRefundRefusedError for an ordinary durable-write refusal', async () => {
    const refused: DurableReturnWrite = async () => ({
      committed: false, refusedBecause: 'could_not_write_durably', detail: 'disk', laneMessage: 'Could not save.',
    } as CommitOutcome);
    await expect(tillWith(refused).refund(refundInput(5_000))).rejects.toBeInstanceOf(LocalRefundRefusedError);
  });
});

describe('RR-F03 — canonical payload identity, unit-tested', () => {
  it('same content in a different key order hashes the same; different money hashes differently', () => {
    const a = JSON.stringify({ id: 'R', refundMinor: 5_000, reasonCode: 'damaged' });
    const b = JSON.stringify({ reasonCode: 'damaged', id: 'R', refundMinor: 5_000 }); // reordered
    const c = JSON.stringify({ id: 'R', refundMinor: 6_000, reasonCode: 'damaged' }); // different money
    expect(canonicalHash(a)).toBe(canonicalHash(b));
    expect(canonicalHash(a)).not.toBe(canonicalHash(c));
  });

  it('the guard classifies fresh / duplicate / conflict', () => {
    const g = new IdempotencyGuard([['R-1', canonicalHash(rec('R-1', 5_000))]]);
    expect(g.verdict('R-2', 'anything').kind).toBe('fresh');
    expect(g.verdict('R-1', canonicalHash(rec('R-1', 5_000))).kind).toBe('duplicate');
    expect(g.verdict('R-1', canonicalHash(rec('R-1', 6_000))).kind).toBe('conflict');
  });
});
