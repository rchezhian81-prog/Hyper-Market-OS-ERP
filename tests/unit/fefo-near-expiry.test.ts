import { describe, it, expect } from 'vitest';
import { nearExpiryStock, type ReceiptWithExpiry, type SaleForNetOnHand } from '../../packages/fefo/src/index';

// Near-expiry stock over NET on-hand (M10-FR-01 · A03 · ADR-0015 + ADR-0006). It composes the tested
// FIFO-by-receipt attribution (what has sold) with the tested expiry-action decision (markdown/dispose),
// so it acts on what is STILL on hand, not on what was ever received. Pure and deterministic.

const r = (over: Partial<ReceiptWithExpiry> & Pick<ReceiptWithExpiry, 'batchId' | 'productId' | 'expiry'>): ReceiptWithExpiry =>
  ({ receivedDate: '2026-09-01', qty: 100, ...over });
const sale = (over: Partial<SaleForNetOnHand> & Pick<SaleForNetOnHand, 'saleId' | 'productId' | 'qty'>): SaleForNetOnHand =>
  ({ soldDate: '2026-09-05', batchTracked: true, ...over });

describe('nearExpiryStock — markdown/dispose over net-of-sales on-hand', () => {
  it('flags a near-expiry batch for markdown, on its NET remaining quantity', () => {
    const out = nearExpiryStock({
      receipts: [r({ batchId: 'b1', productId: 'p1', expiry: '2026-09-20', qty: 100 })],
      sales: [sale({ saleId: 's1', productId: 'p1', qty: 30 })], // 30 of the 100 already sold (FIFO)
      asOf: '2026-09-15', nearExpiryDays: 7, // expiry 5 days out → within window
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.batchId).toBe('b1');
    expect(out[0]!.action).toBe('markdown');
    expect(out[0]!.status).toBe('near_expiry');
    expect(out[0]!.qty).toBe(70); // 100 received − 30 sold
    expect(out[0]!.daysToExpiry).toBe(5);
  });

  it('flags an already-expired batch for disposal', () => {
    const out = nearExpiryStock({
      receipts: [r({ batchId: 'b1', productId: 'p1', expiry: '2026-09-10', qty: 40 })],
      sales: [], asOf: '2026-09-15', nearExpiryDays: 7,
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.action).toBe('dispose');
    expect(out[0]!.status).toBe('expired');
    expect(out[0]!.qty).toBe(40);
  });

  it('says nothing about a batch sold through — net on hand is zero', () => {
    const out = nearExpiryStock({
      receipts: [r({ batchId: 'b1', productId: 'p1', expiry: '2026-09-20', qty: 50 })],
      sales: [sale({ saleId: 's1', productId: 'p1', qty: 50 })],
      asOf: '2026-09-15', nearExpiryDays: 7,
    });
    expect(out).toEqual([]);
  });

  it('nets a sale that NAMED its batch (capturedBatchId), not only FIFO-estimated sales', () => {
    // A captured-batch line consumes its named batch but produces NO FIFO estimate — net-on-hand must still
    // fall by it (regression: reading `estimates` alone left captured sales invisible, over-stating on hand).
    const out = nearExpiryStock({
      receipts: [r({ batchId: 'b1', productId: 'p1', expiry: '2026-09-20', qty: 100 })],
      sales: [sale({ saleId: 's1', productId: 'p1', qty: 30, capturedBatchId: 'b1' })],
      asOf: '2026-09-15', nearExpiryDays: 7,
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.qty).toBe(70); // 100 received − 30 named-batch sold
  });

  it('subtracts wastage from on hand as well as sales', () => {
    const out = nearExpiryStock({
      receipts: [r({ batchId: 'b1', productId: 'p1', expiry: '2026-09-20', qty: 100 })],
      sales: [sale({ saleId: 's1', productId: 'p1', qty: 40 })],
      wastage: [{ batchId: 'b1', qty: 60 }],
      asOf: '2026-09-15', nearExpiryDays: 7,
    });
    expect(out).toEqual([]); // 100 − 40 − 60 = 0
  });

  it('ignores a batch that is not near expiry yet', () => {
    const out = nearExpiryStock({
      receipts: [r({ batchId: 'b1', productId: 'p1', expiry: '2026-12-31', qty: 100 })],
      sales: [], asOf: '2026-09-15', nearExpiryDays: 7,
    });
    expect(out).toEqual([]);
  });

  it('skips a receipt with no expiry recorded — not expiry-trackable, never guessed', () => {
    const out = nearExpiryStock({
      receipts: [{ batchId: 'b1', productId: 'p1', receivedDate: '2026-09-01', qty: 100 }], // no expiry
      sales: [], asOf: '2026-09-15', nearExpiryDays: 7,
    });
    expect(out).toEqual([]);
  });

  it('attributes sales FIFO across two batches of one product, then flags each on its remainder', () => {
    // b1 received first (older), b2 later. 120 sold FIFO drains b1 (100) then 20 of b2.
    const out = nearExpiryStock({
      receipts: [
        r({ batchId: 'b1', productId: 'p1', receivedDate: '2026-09-01', expiry: '2026-09-18', qty: 100 }),
        r({ batchId: 'b2', productId: 'p1', receivedDate: '2026-09-05', expiry: '2026-09-19', qty: 100 }),
      ],
      sales: [sale({ saleId: 's1', productId: 'p1', qty: 120, soldDate: '2026-09-10' })],
      asOf: '2026-09-15', nearExpiryDays: 7,
    });
    // b1 fully sold (net 0 → gone); b2 has 80 left, expiring in 4 days → markdown.
    expect(out.map((i) => i.batchId)).toEqual(['b2']);
    expect(out[0]!.qty).toBe(80);
  });

  it('is deterministic and earliest-expiry-first across products', () => {
    const receipts = [
      r({ batchId: 'a', productId: 'p1', expiry: '2026-09-19', qty: 10 }),
      r({ batchId: 'b', productId: 'p2', expiry: '2026-09-16', qty: 10 }),
    ];
    const first = nearExpiryStock({ receipts, sales: [], asOf: '2026-09-15', nearExpiryDays: 7 });
    expect(first.map((i) => i.batchId)).toEqual(['b', 'a']); // earliest expiry first
    expect(nearExpiryStock({ receipts, sales: [], asOf: '2026-09-15', nearExpiryDays: 7 })).toEqual(first);
  });
});
