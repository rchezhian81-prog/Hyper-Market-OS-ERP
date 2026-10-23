import { describe, it, expect } from 'vitest';
import { money } from '../../packages/contracts/src/money';
import { Ledger, InMemoryLedgerStore } from '../../packages/ledger/src/index';
import { SyncOutbox } from '../../packages/sync/src/index';
import { commitReturn, expiredOfProduct, recallOfProduct, returnLineHoldReason, type CommitReturnInput } from '../../packages/returns/src/returns';
import type { OriginalSale } from '../../packages/returns/src/return-register';
import { createRefundView } from '../../apps/pos/src/refund-view';
import type { DecidedRequest } from '../../packages/approvals/src/approvals';
import { createTillSession } from '../../apps/pos/src/till-session';
import { holdRecalledReturnLines } from '../../edge/store-edge/src/return-recall';
import { toOriginalSale } from '../../edge/store-edge/src/receipt-lookup';

/**
 * **M13-FR-02 — a returned unit of an EXPIRED batch is held, never put back for sale, at the till and again on the store
 * computer, offline, from the signed pack's `expiredBatches` (the M10-FR-01 expiry move's facts, carried by the integration
 * lane).** As at the scan (`scanGs1`), only a unit whose batch is KNOWN is matched; a recall wins over an expiry when both
 * apply (one reason, the stronger). The refund itself is always paid. Synthetic data only.
 */

const AT = '2026-10-23T10:00:00.000Z';
const PACK = [
  { productId: 'p-milk', expiredBatches: [{ batchId: 'LOT-OLD', expiry: '2026-10-20' }] },
  { productId: 'p-both', recallBlock: true, blockedBatches: ['LOT-X'], expiredBatches: [{ batchId: 'LOT-X', expiry: '2026-10-19' }] },
  { productId: 'p-fine' },
];
const productOf = (id: string) => PACK.find((p) => p.productId === id);

describe('M13-FR-02 — the expired-batch check a lane runs from its own pack', () => {
  const expired = expiredOfProduct(productOf);
  const recalled = recallOfProduct(productOf);
  it('holds only a KNOWN expired batch; a fresh sibling batch, an unknown batch and an unknown product are not held by it', () => {
    expect(expired('LOT-OLD', 'p-milk')).toBe(true);
    expect(expired('LOT-NEW', 'p-milk')).toBe(false);
    expect(expired(undefined, 'p-milk')).toBe(false);
    expect(expired('LOT-OLD', 'p-unknown')).toBe(false);
  });
  it('gives one reason per line: recall before expiry; only a RESELL line is held', () => {
    expect(returnLineHoldReason({ productId: 'p-milk', disposition: 'resell', batchId: 'LOT-OLD' }, recalled, expired)).toBe('expired');
    expect(returnLineHoldReason({ productId: 'p-both', disposition: 'resell', batchId: 'LOT-X' }, recalled, expired)).toBe('recall');
    expect(returnLineHoldReason({ productId: 'p-milk', disposition: 'scrap', batchId: 'LOT-OLD' }, recalled, expired)).toBeNull();
    expect(returnLineHoldReason({ productId: 'p-fine', disposition: 'resell' }, recalled, expired)).toBeNull();
  });
  it('the engine forces quarantine, counts it, marks the movement and the event, and still refunds', () => {
    const ledger = new Ledger(new InMemoryLedgerStore());
    const outbox = new SyncOutbox();
    const ret = commitReturn({
      id: 'r1', number: 'R1', originalSaleId: 's1', laneId: 'lane-1', processedBy: 'c1', processedAt: AT, reasonCode: 'changed_mind',
      lines: [{ productId: 'p-milk', uom: 'ea', quantityMinor: 1, originalQtyMinor: 1, disposition: 'resell', batchId: 'LOT-OLD' }],
      refund: money(6_000, 'INR'), refundTender: 'cash', maxRefund: money(6_000, 'INR'), approvalThresholdMinor: 100_000,
    }, ledger, outbox, recalled, expired);
    expect(ret.expiredHeldLines).toBe(1);
    expect(ret.recallHeldLines).toBe(0);
    expect(ret.restockedLines).toBe(0);
    expect(ret.refundStatus).toBe('settled');
    expect(ledger.entries()[0]?.event.payload).toMatchObject({ state: 'quarantine', disposition: 'quarantine', batchId: 'LOT-OLD', expiredHeld: true });
    const accepted = outbox.pending()[0]?.event.payload as { lines: Record<string, unknown>[] };
    expect(accepted.lines[0]).toMatchObject({ disposition: 'quarantine', expiredHeld: true, batchId: 'LOT-OLD' });
  });
  it('without an expired set (the old call) nothing changes — the desk\'s resell stands', () => {
    const ret = commitReturn({
      id: 'r2', number: 'R2', originalSaleId: 's1', laneId: 'lane-1', processedBy: 'c1', processedAt: AT, reasonCode: 'changed_mind',
      lines: [{ productId: 'p-milk', uom: 'ea', quantityMinor: 1, originalQtyMinor: 1, disposition: 'resell', batchId: 'LOT-OLD' }],
      refund: money(6_000, 'INR'), refundTender: 'cash', maxRefund: money(6_000, 'INR'), approvalThresholdMinor: 100_000,
    }, new Ledger(new InMemoryLedgerStore()), new SyncOutbox(), recalled);
    expect(ret.restockedLines).toBe(1);
  });
});

describe('M13-FR-02 — the till sends the box a HELD disposition for an expired batch', () => {
  const tillWith = () => {
    const sent: Record<string, unknown>[] = [];
    const ledger = new Ledger(new InMemoryLedgerStore());
    const till = createTillSession({ laneId: 'lane-1', cashierId: 'c1', recallOf: productOf }, ledger, new SyncOutbox(), {
      durableReturn: async (_id, record) => { sent.push(JSON.parse(record) as Record<string, unknown>); return { committed: true } as never; },
    });
    return { till, sent, ledger };
  };
  const refundOf = (batchId: string | undefined) => ({
    id: `r-${batchId ?? 'none'}`, number: `R-${batchId ?? 'none'}`, originalSaleId: 's1', processedAt: AT, reasonCode: 'changed_mind',
    lines: [{ productId: 'p-milk', uom: 'ea', quantityMinor: 1, originalQtyMinor: 1, disposition: 'resell' as const, ...(batchId === undefined ? {} : { batchId }) }],
    refund: money(6_000, 'INR'), refundTender: 'cash' as const, maxRefund: money(6_000, 'INR'), approvalThresholdMinor: 100_000,
  });

  it('the expired batch: quarantine + expiredHeld + what the cashier chose; not on hand at the till; paid', async () => {
    const { till, sent, ledger } = tillWith();
    const out = await till.refund(refundOf('LOT-OLD'));
    expect(out.refundStatus).toBe('settled');
    expect(sent[0]?.['lines']).toEqual([{ productId: 'p-milk', uom: 'ea', quantityMinor: 1, disposition: 'quarantine', batchId: 'LOT-OLD', expiredHeld: true, chosenDisposition: 'resell' }]);
    expect((ledger.entries()[0]?.event.payload as { state?: string }).state).toBe('quarantine');
  });
  it('a fresh batch of the same product, and a unit with no batch, go back for sale as the cashier chose', async () => {
    for (const batch of ['LOT-NEW', undefined]) {
      const { till, sent } = tillWith();
      await till.refund(refundOf(batch));
      expect((sent[0]?.['lines'] as { disposition: string }[])[0]?.disposition).toBe('resell');
    }
  });
});

describe('M13-FR-02 — the store computer holds an expired batch again from its own pack', () => {
  it('a record that still says resell for an expired batch is held before the disk; deterministic on a re-send', () => {
    const record = { returnId: 'r1', lines: [{ productId: 'p-milk', disposition: 'resell', batchId: 'LOT-OLD' }, { productId: 'p-milk', disposition: 'resell', batchId: 'LOT-NEW' }] };
    const out = holdRecalledReturnLines(record, PACK);
    expect(out.held).toBe(1);
    expect(out.record['lines']).toEqual([
      { productId: 'p-milk', disposition: 'quarantine', batchId: 'LOT-OLD', expiredHeld: true, chosenDisposition: 'resell' },
      { productId: 'p-milk', disposition: 'resell', batchId: 'LOT-NEW' },
    ]);
    expect(holdRecalledReturnLines(out.record, PACK).record).toBe(out.record);
  });
});

describe('M13-FR-02 — the refund screen carries the unit\'s batch from the BILL, and says when a unit was held', () => {
  // A bill that sold milk from LOT-OLD (now expired) and dal from two batches.
  const SALE: OriginalSale = {
    saleId: 'S-1', number: 'B-1', tradingDay: '2026-10-23', committedAt: '2026-10-23T09:00:00.000Z', totalMinor: 21_000,
    lines: [
      { productId: 'p-milk', uom: 'ea', quantityMinor: 1, lineTotalMinor: 6_000, batchId: 'LOT-OLD' },
      { productId: 'p-fine', uom: 'ea', quantityMinor: 1, lineTotalMinor: 7_500, batchId: 'D-1' },
      { productId: 'p-fine', uom: 'ea', quantityMinor: 1, lineTotalMinor: 7_500, batchId: 'D-2' },
    ],
  };
  const viewOver = () => {
    const sent: Record<string, unknown>[] = [];
    const till = createTillSession({ laneId: 'lane-1', cashierId: 'c1', recallOf: productOf }, new Ledger(new InMemoryLedgerStore()), new SyncOutbox(), {
      durableReturn: async (_id, record) => { sent.push(JSON.parse(record) as Record<string, unknown>); return { committed: true } as never; },
    });
    const calls: CommitReturnInput[] = [];
    const view = createRefundView({
      refund: (input) => { calls.push(input as CommitReturnInput); return till.refund(input); },
      now: () => AT, policy: { approvalThresholdMinor: 100_000, noReceiptCapMinor: 50_000 },
    });
    return { view, sent, calls };
  };
  const line = (productId: string, batchId?: string) => ({ productId, uom: 'ea', quantityMinor: 1, disposition: 'resell' as const, ...(batchId === undefined ? {} : { batchId }) });

  it('the bill\'s only batch is used; the expired unit is held; the screen says so in its outcome', async () => {
    const { view, sent } = viewOver();
    const out = await view.submit({ returnId: 'R-1', number: 'RET-1', originalSale: SALE, reasonCode: 'changed_mind', lines: [line('p-milk')], refundMinor: 6_000, refundTender: 'cash' });
    expect(out).toMatchObject({ kind: 'settled', held: { recall: 0, expired: 1 } });
    expect((sent[0]?.['lines'] as Record<string, unknown>[])[0]).toMatchObject({ batchId: 'LOT-OLD', disposition: 'quarantine', expiredHeld: true });
  });
  it('a batch the bill did not sell is never trusted; two batches with none chosen stay unknown; a chosen one of them is used', async () => {
    const a = viewOver();
    await a.view.submit({ returnId: 'R-2', number: 'RET-2', originalSale: SALE, reasonCode: 'changed_mind', lines: [line('p-milk', 'LOT-FRESH')], refundMinor: 6_000, refundTender: 'cash' });
    expect(a.calls[0]?.lines[0]?.batchId).toBeUndefined();
    const b = viewOver();
    await b.view.submit({ returnId: 'R-3', number: 'RET-3', originalSale: SALE, reasonCode: 'changed_mind', lines: [line('p-fine')], refundMinor: 7_500, refundTender: 'cash' });
    expect(b.calls[0]?.lines[0]?.batchId).toBeUndefined();
    const c = viewOver();
    const out = await c.view.submit({ returnId: 'R-4', number: 'RET-4', originalSale: SALE, reasonCode: 'changed_mind', lines: [line('p-fine', 'D-2')], refundMinor: 7_500, refundTender: 'cash' });
    expect(c.calls[0]?.lines[0]?.batchId).toBe('D-2');
    expect(out.kind === 'settled' && out.held === undefined).toBe(true); // nothing held → nothing said
  });
  it('a no-receipt return takes the batch read off the unit', async () => {
    const { view, sent } = viewOver();
    const approval: DecidedRequest = {
      id: 'ap-1', subjectType: 'pos.return', subjectRef: 'R-5', requestedBy: 'c1', branchId: null, value: null,
      status: 'approved', decidedBy: 'u-mgr', reason: 'no receipt, checked', decidedAt: AT,
    };
    const out = await view.submit({ returnId: 'R-5', number: 'RET-5', noReceipt: true, reasonCode: 'changed_mind', lines: [line('p-milk', 'LOT-OLD')], refundMinor: 6_000, refundTender: 'cash', approval });
    expect(out).toMatchObject({ held: { expired: 1 } });
    expect((sent[0]?.['lines'] as Record<string, unknown>[])[0]).toMatchObject({ batchId: 'LOT-OLD', expiredHeld: true });
  });
});

describe('M13-FR-02 — the box\'s bill lookup keeps the batch each line was sold from', () => {
  it('a line with a batch keeps it (and its date); a line without stays without', () => {
    const sale = toOriginalSale({
      id: 'S-9', number: 'B-9', tradingDay: '2026-10-23', committedAt: AT, totalMinor: 12_000,
      lines: [
        { productId: 'p-milk', uom: 'ea', quantityMinor: 1, lineTotalMinor: 6_000, batchId: 'LOT-OLD', batchExpiry: '2026-10-20' },
        { productId: 'p-fine', uom: 'ea', quantityMinor: 1, lineTotalMinor: 6_000 },
      ],
    })!;
    expect(sale.lines).toEqual([
      { productId: 'p-milk', uom: 'ea', quantityMinor: 1, lineTotalMinor: 6_000, batchId: 'LOT-OLD', batchExpiry: '2026-10-20' },
      { productId: 'p-fine', uom: 'ea', quantityMinor: 1, lineTotalMinor: 6_000 },
    ]);
  });
});
