import { describe, it, expect } from 'vitest';
import { money } from '../../packages/contracts/src/money';
import { Ledger, InMemoryLedgerStore } from '../../packages/ledger/src/index';
import { SyncOutbox } from '../../packages/sync/src/index';
import { commitReturn, recallOfProduct, returnLineRecallHeld } from '../../packages/returns/src/returns';
import { createTillSession } from '../../apps/pos/src/till-session';
import { holdRecalledReturnLines } from '../../edge/store-edge/src/return-recall';

/**
 * **M13-FR-02 "recall-blocked item handled per M10" — at the TILL (audit-2 P3).** Before this, the till called
 * `commitReturn(full, ledger, outbox)` with no recall set, and the record it sent the box kept the cashier's "resell":
 * a recalled unit coming back at the till went back on the shelf. Now the till's own signed pack is the recall set
 * (offline), the record the box keeps says `quarantine` with `recallHeld`, and the box runs the rule again from ITS pack.
 */

const AT = '2026-10-23T10:00:00.000Z';
const PACK = [
  { productId: 'p-whole', recallBlock: true },                              // a recall flag on the product itself
  { productId: 'p-batch', recallBlock: true, blockedBatches: ['LOT-BAD'] }, // one named batch is recalled
  { productId: 'p-fine' },
];
const productOf = (id: string) => PACK.find((p) => p.productId === id);

describe('M13-FR-02 — the recall check a lane runs from its own pack', () => {
  const check = recallOfProduct(productOf);
  it('holds a whole-product recall whatever unit comes back, a named batch only for that batch, and an UNKNOWN batch of a batch recall (OB-139 "A")', () => {
    expect(check(undefined, 'p-whole')).toBe(true);
    expect(check('ANY', 'p-whole')).toBe(true);
    expect(check('LOT-BAD', 'p-batch')).toBe(true);
    expect(check('LOT-GOOD', 'p-batch')).toBe(false);
    expect(check(undefined, 'p-batch')).toBe(true);
    expect(check(undefined, 'p-fine')).toBe(false);
    expect(check(undefined, 'p-unknown')).toBe(false);
  });
  it('only a line the desk chose to RESELL is held — quarantine and scrap are already off the shelf', () => {
    expect(returnLineRecallHeld({ productId: 'p-whole', disposition: 'resell' }, check)).toBe(true);
    expect(returnLineRecallHeld({ productId: 'p-whole', disposition: 'scrap' }, check)).toBe(false);
    expect(returnLineRecallHeld({ productId: 'p-batch', disposition: 'resell', batchId: 'LOT-GOOD' }, check)).toBe(false);
  });
  it('the engine counts a product-wide hold too (not only a known batch)', () => {
    const ret = commitReturn({
      id: 'r1', number: 'R1', originalSaleId: 's1', laneId: 'lane-1', processedBy: 'c1', processedAt: AT, reasonCode: 'faulty',
      lines: [{ productId: 'p-whole', uom: 'ea', quantityMinor: 1, originalQtyMinor: 1, disposition: 'resell' }],
      refund: money(1_000, 'INR'), refundTender: 'cash', maxRefund: money(1_000, 'INR'), approvalThresholdMinor: 100_000,
    }, new Ledger(new InMemoryLedgerStore()), new SyncOutbox(), check);
    expect(ret.recallHeldLines).toBe(1);
    expect(ret.restockedLines).toBe(0);
  });
});

describe('M13-FR-02 — the till sends the box a HELD disposition, and holds its own stock movement', () => {
  const refundOf = (productId: string, batchId?: string) => ({
    id: `r-${productId}`, number: `R-${productId}`, originalSaleId: 's1', processedAt: AT, reasonCode: 'faulty',
    lines: [{ productId, uom: 'ea', quantityMinor: 1, originalQtyMinor: 1, disposition: 'resell' as const, ...(batchId === undefined ? {} : { batchId }) }],
    refund: money(1_000, 'INR'), refundTender: 'cash' as const, maxRefund: money(1_000, 'INR'), approvalThresholdMinor: 100_000,
  });
  const tillWith = (recallOf: typeof productOf | undefined) => {
    const sent: Record<string, unknown>[] = [];
    const ledger = new Ledger(new InMemoryLedgerStore());
    const till = createTillSession({ laneId: 'lane-1', cashierId: 'c1', ...(recallOf === undefined ? {} : { recallOf }) }, ledger, new SyncOutbox(), {
      durableReturn: async (_id, record) => { sent.push(JSON.parse(record) as Record<string, unknown>); return { committed: true } as never; },
    });
    return { till, sent, ledger };
  };

  it('a recalled product: the record says quarantine + recallHeld + what the cashier chose; the till\'s movement is NOT on hand; the refund is still paid', async () => {
    const { till, sent, ledger } = tillWith(productOf);
    const out = await till.refund(refundOf('p-whole'));
    expect(out.refundStatus).toBe('settled');
    expect(sent[0]?.['lines']).toEqual([{ productId: 'p-whole', uom: 'ea', quantityMinor: 1, disposition: 'quarantine', recallHeld: true, chosenDisposition: 'resell' }]);
    expect((ledger.entries()[0]?.event.payload as { state?: string }).state).toBe('quarantine');
  });

  it('a sibling batch of a batch recall goes back for sale, and keeps its batch on the record', async () => {
    const { till, sent } = tillWith(productOf);
    await till.refund(refundOf('p-batch', 'LOT-GOOD'));
    expect(sent[0]?.['lines']).toEqual([{ productId: 'p-batch', uom: 'ea', quantityMinor: 1, disposition: 'resell', batchId: 'LOT-GOOD' }]);
  });

  it('with no recall set (an older page) nothing is changed at the till — the box decides', async () => {
    const { till, sent } = tillWith(undefined);
    await till.refund(refundOf('p-whole'));
    expect((sent[0]?.['lines'] as { disposition: string }[])[0]?.disposition).toBe('resell');
  });
});

describe('M13-FR-02 — the store computer runs the rule again from its own pack', () => {
  it('a record that still says resell for a recalled product is held before the disk; a fine one is untouched (the same object)', () => {
    const record = { returnId: 'r1', lines: [{ productId: 'p-whole', disposition: 'resell' }, { productId: 'p-fine', disposition: 'resell' }] };
    const out = holdRecalledReturnLines(record, PACK);
    expect(out.held).toBe(1);
    expect(out.record['lines']).toEqual([
      { productId: 'p-whole', disposition: 'quarantine', recallHeld: true, chosenDisposition: 'resell' },
      { productId: 'p-fine', disposition: 'resell' },
    ]);
    const fine = { returnId: 'r2', lines: [{ productId: 'p-fine', disposition: 'resell' }] };
    expect(holdRecalledReturnLines(fine, PACK).record).toBe(fine);
    // Deterministic: the held record judged again is unchanged (a re-sent refund hashes the same).
    expect(holdRecalledReturnLines(out.record, PACK).record).toBe(out.record);
  });
});
