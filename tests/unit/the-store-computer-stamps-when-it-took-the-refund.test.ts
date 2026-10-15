import { describe, it, expect } from 'vitest';
import { createEdgeNode, type DurableLog } from '../../edge/store-edge/src/index';
import { canonicalHash, IdempotencyGuard, STORE_COMPUTER_TAKEN_AT } from '../../edge/store-edge/src/idempotency';
import { toCloudReturn } from '../../edge/store-edge/src/cloud-return';
import { hmacSigner } from '../../services/catalogue/src/index';
import { SyncOutbox } from '../../packages/sync/src/outbox';
import { storeComputerTakenAtOf } from '../../services/pos/src/returns';

/**
 * **Round 34 · M35-FR-04 · owner decision OB-124 (1) "A" (15 Oct 2026, in writing), finishing OB-108 "A" for RETURNS — the
 * store computer writes WHEN IT took each refund from the till, by its own clock, on the record it keeps and on what it sends.**
 *
 * Exactly as for a sale (round 29): the stamp is the box's, not the till's; it is not part of the refund's identity — a till
 * re-sending the same refund, even after a restart (the guard rebuilt from the disk), is still "the same refund", never a
 * conflict — and it is never a reason to refuse a refund (hard rule #1: nothing here touches the network).
 */

class TestLog implements DurableLog {
  readonly written: string[] = [];
  readonly capacityBytes = 10_000_000;
  async append(record: string): Promise<void> { this.written.push(record); }
  async usedBytes(): Promise<number> { return this.written.reduce((n, r) => n + r.length, 0); }
}
const signer = hmacSigner(['edge', 'test', 'key'].join('-').padEnd(40, '0'));
const REFUND = {
  returnId: 'RT-1', number: 'S1L1-000105', originalSaleId: 'S-1', processedBy: 'u-cash', reasonCode: 'damaged', refundMinor: 100, refundTender: 'cash',
  processedAt: '2026-03-01T10:40:35.000Z', lines: [{ productId: 'P1', uom: 'ea', quantityMinor: 1, disposition: 'resell' }],
};

describe('round 34 · M35-FR-04 · OB-124 (1) / OB-108: the store computer stamps when it took the refund', () => {
  it('M35-FR-04 OB-124: the refund on the disk and the refund it sends carry the store computer\'s own time; the till\'s processedAt is untouched', async () => {
    const log = new TestLog();
    const returnsLog = new TestLog();
    const returnsOutbox = new SyncOutbox();
    const node = createEdgeNode({ tenantId: 't-sre', log, signer, returnsLog, returnsOutbox });
    const before = Date.now();
    expect((await node.commitReturn('RT-1', JSON.stringify(REFUND))).committed).toBe(true);
    const kept = JSON.parse(returnsLog.written[0]!) as Record<string, unknown>;
    expect(kept['processedAt']).toBe(REFUND.processedAt);
    const taken = Date.parse(kept[STORE_COMPUTER_TAKEN_AT] as string);
    expect(taken).toBeGreaterThanOrEqual(before);
    expect(taken).toBeLessThanOrEqual(Date.now());
    const sent = returnsOutbox.pending()[0]!.event.payload as ReturnType<typeof toCloudReturn>;
    expect(sent.storeComputerTakenAt).toBe(kept[STORE_COMPUTER_TAKEN_AT]);
    expect(sent.processedAt).toBe(REFUND.processedAt);
    // What the sync agent re-sends after a restart (it re-reads the disk) carries the same stamp.
    expect(toCloudReturn(kept).storeComputerTakenAt).toBe(kept[STORE_COMPUTER_TAKEN_AT]);
  });

  it('M35-FR-04 OB-124: the stamp is not part of the refund\'s identity — a re-sent refund, even after a restart, is the same refund; a different one is still a conflict', async () => {
    const returnsLog = new TestLog();
    const guard = new IdempotencyGuard();
    const node = createEdgeNode({ tenantId: 't-sre', log: new TestLog(), signer, returnsLog, returnsIdempotency: guard });
    expect((await node.commitReturn('RT-1', JSON.stringify(REFUND))).committed).toBe(true);
    expect(canonicalHash(returnsLog.written[0]!)).toBe(canonicalHash(JSON.stringify(REFUND)));
    const rebuilt = new IdempotencyGuard(returnsLog.written.map((r) => [(JSON.parse(r) as { returnId: string }).returnId, canonicalHash(r)] as const));
    const again = createEdgeNode({ tenantId: 't-sre', log: new TestLog(), signer, returnsLog, returnsIdempotency: rebuilt });
    const replay = await again.commitReturn('RT-1', JSON.stringify(REFUND));
    expect(replay).toMatchObject({ committed: true, durable: true });
    expect(replay.detail).toMatch(/already recorded with these details/);
    expect(returnsLog.written).toHaveLength(1);
    expect((await again.commitReturn('RT-1', JSON.stringify({ ...REFUND, refundMinor: 99 }))).committed).toBe(false);
  });

  it('M35-FR-04 OB-124: only a well-formed time is carried; head office keeps it never later than it received the refund', () => {
    expect(toCloudReturn({ ...REFUND, storeComputerTakenAt: '2026-03-01T11:00:31.000Z' }).storeComputerTakenAt).toBe('2026-03-01T11:00:31.000Z');
    for (const bad of ['yesterday', '2026-03-01 11:00', 12345, null]) expect(toCloudReturn({ ...REFUND, storeComputerTakenAt: bad })).not.toHaveProperty('storeComputerTakenAt');
    const received = '2026-03-01T11:00:00.000Z';
    expect(storeComputerTakenAtOf('2026-03-01T10:59:00.000Z', received)).toBe('2026-03-01T10:59:00.000Z');
    expect(storeComputerTakenAtOf('2026-03-11T10:59:00.000Z', received)).toBe(received);
    for (const bad of ['yesterday', 7, undefined, '2026-02-30T99:00:00Z']) expect(storeComputerTakenAtOf(bad, received)).toBeUndefined();
  });
});
