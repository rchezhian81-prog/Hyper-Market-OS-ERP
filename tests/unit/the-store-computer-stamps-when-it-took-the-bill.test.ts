import { describe, it, expect } from 'vitest';
import { createEdgeNode, type DurableLog } from '../../edge/store-edge/src/index';
import { canonicalHash, stampTakenAt, IdempotencyGuard, STORE_COMPUTER_TAKEN_AT } from '../../edge/store-edge/src/idempotency';
import { toCloudSale } from '../../edge/store-edge/src/cloud-sale';
import { hmacSigner } from '../../services/catalogue/src/index';
import { SyncOutbox } from '../../packages/sync/src/outbox';
import { billFingerprint, type IncomingSale } from '../../services/pos/src/index';

/**
 * **Round 29 · OB-108 "A" (owner, 14 Oct 2026, in writing, "Use store computer time"; verifier r28 NEW-4) — the store computer
 * writes WHEN IT took each bill from the till, by its own clock, on the record it keeps and on what it sends.**
 *
 * Head office compares "said unused" times (the store computer's reports — its clock) with this, never with the till's clock.
 * The stamp is the box's, not the till's: it is not part of the sale's identity — a till re-sending the same sale (even after
 * a restart, when the guard is rebuilt from the disk) is still "the same sale", never a conflict — and it is never a reason
 * to refuse a sale (hard rule #1: nothing here touches the network).
 */

class TestLog implements DurableLog {
  readonly written: string[] = [];
  readonly capacityBytes = 10_000_000;
  async append(record: string): Promise<void> { this.written.push(record); }
  async usedBytes(): Promise<number> { return this.written.reduce((n, r) => n + r.length, 0); }
}
const signer = hmacSigner(['edge', 'test', 'key'].join('-').padEnd(40, '0'));
const SALE = { id: 'S-1', number: 'S1L1-000105', total: 1000, committedAt: '2026-03-01T10:40:35.000Z', lines: [], tenders: [{ kind: 'cash', amount: { minor: 1000 } }] };

describe('round 29 · OB-108: the store computer stamps when it took the bill', () => {
  it('the record on the disk and the sale it sends carry the store computer\'s own time; the till\'s committedAt is untouched', async () => {
    const log = new TestLog();
    const outbox = new SyncOutbox();
    const node = createEdgeNode({ tenantId: 't-sre', log, signer, outbox });
    const before = Date.now();
    expect((await node.commit('S-1', JSON.stringify(SALE))).committed).toBe(true);
    const kept = JSON.parse(log.written[0]!) as Record<string, unknown>;
    expect(kept['committedAt']).toBe(SALE.committedAt);
    const taken = Date.parse(kept[STORE_COMPUTER_TAKEN_AT] as string);
    expect(taken).toBeGreaterThanOrEqual(before);
    expect(taken).toBeLessThanOrEqual(Date.now());
    const sent = outbox.pending()[0]!.event.payload as IncomingSale;
    expect(sent.storeComputerTakenAt).toBe(kept[STORE_COMPUTER_TAKEN_AT]);
    expect(sent.committedAt).toBe(SALE.committedAt);
  });

  it('the stamp is not part of the sale\'s identity: a till re-sending the same sale — even after a restart — is the same sale, never a conflict', async () => {
    const log = new TestLog();
    const guard = new IdempotencyGuard();
    const node = createEdgeNode({ tenantId: 't-sre', log, signer, salesIdempotency: guard });
    expect((await node.commit('S-1', JSON.stringify(SALE))).committed).toBe(true);
    expect(canonicalHash(log.written[0]!)).toBe(canonicalHash(JSON.stringify(SALE)));
    // A restart: the guard is rebuilt from the disk (records carrying the stamp), and the till re-sends its own record.
    const rebuilt = new IdempotencyGuard(log.written.map((r) => [(JSON.parse(r) as { id: string }).id, canonicalHash(r)] as const));
    const again = createEdgeNode({ tenantId: 't-sre', log, signer, salesIdempotency: rebuilt });
    const replay = await again.commit('S-1', JSON.stringify(SALE));
    expect(replay).toMatchObject({ committed: true, durable: true });
    expect(replay.detail).toMatch(/already recorded with these details/);
    expect(log.written).toHaveLength(1);
    // A different sale under the same id is still a conflict (the stamp hides nothing else).
    expect((await again.commit('S-1', JSON.stringify({ ...SALE, total: 999 }))).committed).toBe(false);
  });

  it('head office takes the stamp only as a well-formed time; it never changes what makes a bill the same bill', () => {
    expect(toCloudSale({ ...SALE, storeComputerTakenAt: '2026-03-01T11:00:31.000Z' }, 1).storeComputerTakenAt).toBe('2026-03-01T11:00:31.000Z');
    for (const bad of ['yesterday', '2026-03-01 11:00', 12345, null]) expect(toCloudSale({ ...SALE, storeComputerTakenAt: bad }, 1)).not.toHaveProperty('storeComputerTakenAt');
    const a = toCloudSale(SALE, 1);
    expect(billFingerprint(a)).toBe(billFingerprint({ ...a, storeComputerTakenAt: '2026-03-01T11:00:31.000Z' }));
    expect(stampTakenAt('not json', 'x')).toBe('not json');
    expect(stampTakenAt('[1]', 'x')).toBe('[1]');
  });
});
