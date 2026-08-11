import { describe, it, expect } from 'vitest';
import { attributeSalesFifo, InvalidAttribution, type BatchReceipt, type HistoricalSaleLine } from '../../packages/fefo/src/index';

// M10-FR-03 batch-on-sale inc3b / ADR-0006: head office attributes a FIFO-by-receipt best-estimate batch
// to a batch-tracked sale that arrived with no captured batch. Estimates are labelled, never invented.

const receipts: BatchReceipt[] = [
  { batchId: 'B1', receivedDate: '2026-08-01', qty: 3 }, // received first → drawn first (FIFO)
  { batchId: 'B2', receivedDate: '2026-08-05', qty: 5 },
];
const sale = (o: Partial<HistoricalSaleLine> = {}): HistoricalSaleLine =>
  ({ saleId: 's1', soldDate: '2026-08-06', qty: 2, batchTracked: true, ...o });

describe('attributeSalesFifo — cloud best-estimate batch attribution (inc3b / ADR-0006)', () => {
  it('estimates the earliest-received batch first, labelled as an estimate', () => {
    const { estimates } = attributeSalesFifo({ receipts, sales: [sale({ qty: 2 })] });
    expect(estimates).toEqual([{ saleId: 's1', soldDate: '2026-08-06', batchId: 'B1', qty: 2, basis: 'fifo_receipt_estimate' }]);
  });

  it('spans batches FIFO when one is not enough', () => {
    const { estimates } = attributeSalesFifo({ receipts, sales: [sale({ qty: 4 })] });
    expect(estimates.map((e) => [e.batchId, e.qty])).toEqual([['B1', 3], ['B2', 1]]); // 3 from B1 then 1 from B2
  });

  it('does not let a later sale re-draw units an earlier sale already took (consumes across sales)', () => {
    const { estimates } = attributeSalesFifo({
      receipts,
      sales: [sale({ saleId: 'a', soldDate: '2026-08-06', qty: 3 }), sale({ saleId: 'b', soldDate: '2026-08-07', qty: 2 })],
    });
    expect(estimates.filter((e) => e.saleId === 'a').map((e) => e.batchId)).toEqual(['B1']);    // takes all of B1
    expect(estimates.filter((e) => e.saleId === 'b').map((e) => e.batchId)).toEqual(['B2']);    // B1 gone → B2
  });

  it('lets a captured-batch sale consume its OWN batch without being estimated, so others stay accurate', () => {
    // s-cap captured B1 (3 units); the un-captured s-est must then estimate B2, not B1.
    const { estimates } = attributeSalesFifo({
      receipts,
      sales: [
        { saleId: 's-cap', soldDate: '2026-08-06', qty: 3, batchTracked: true, capturedBatchId: 'B1' },
        { saleId: 's-est', soldDate: '2026-08-07', qty: 2, batchTracked: true },
      ],
    });
    expect(estimates.map((e) => e.saleId)).toEqual(['s-est']);       // the captured sale is not estimated
    expect(estimates[0]!.batchId).toBe('B2');                        // B1 was consumed by the captured sale
  });

  it('ignores a non-batch-tracked line entirely', () => {
    const { estimates } = attributeSalesFifo({ receipts, sales: [sale({ batchTracked: false })] });
    expect(estimates).toEqual([]);
  });

  it('reports units it cannot place rather than inventing a batch', () => {
    // Only 8 units received; a sale for 10 leaves 2 unattributed.
    const { estimates, unattributedQty } = attributeSalesFifo({ receipts, sales: [sale({ qty: 10 })] });
    expect(estimates.reduce((s, e) => s + e.qty, 0)).toBe(8);
    expect(unattributedQty).toBe(2);
  });

  it('refuses a bad date, a negative quantity, and a receipt with no batchId', () => {
    expect(() => attributeSalesFifo({ receipts: [{ batchId: '', receivedDate: '2026-08-01', qty: 1 }], sales: [] })).toThrow(InvalidAttribution);
    expect(() => attributeSalesFifo({ receipts: [{ batchId: 'B', receivedDate: 'Aug', qty: 1 }], sales: [] })).toThrow(InvalidAttribution);
    expect(() => attributeSalesFifo({ receipts, sales: [sale({ qty: -1 })] })).toThrow(InvalidAttribution);
  });
});
