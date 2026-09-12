import { describe, it, expect } from 'vitest';
import { buildReceiptLookup, toOriginalSale, toRecordedReturn } from '../../edge/store-edge/src/receipt-lookup';
import { returnRegister, returnableLines } from '../../packages/returns/src/return-register';

/**
 * **Lane-local receipt lookup (M13-FR-01, §31) — the offline half of the refund screen.**
 *
 * Given this lane's own durable sale and returns logs (the exact strings `readLog` yields), the
 * assembler produces the read model the refund screen needs: the original bill, and the return/refund
 * history the register folds. Pure — no disk here. Synthetic data only (hard rule #7).
 */

const sale = (over: Record<string, unknown> = {}) => JSON.stringify({
  id: 'S-1', number: 'B-1', laneId: 'lane-1', cashierId: 'u-meena',
  tradingDay: '2026-08-05', committedAt: '2026-08-05T10:00:00Z',
  total: 20_000, netMinor: 17_000, taxMinor: 3_000, currency: 'INR',
  lines: [
    { productId: 'P1', quantityMinor: 2, uom: 'ea', unitPriceMinor: 7_500, lineTotalMinor: 15_000 },
    { productId: 'P2', quantityMinor: 1, uom: 'ea', unitPriceMinor: 5_000, lineTotalMinor: 5_000 },
  ],
  tenders: [{ kind: 'cash', amount: { minor: 20_000, currency: 'INR' }, status: 'settled' }],
  ...over,
});

const ret = (over: Record<string, unknown> = {}) => JSON.stringify({
  returnId: 'R-1', number: 'RET-1', originalSaleId: 'S-1', processedBy: 'u-meena',
  reasonCode: 'damaged', refundMinor: 7_500, currency: 'INR', refundTender: 'cash',
  processedAt: '2026-08-05T11:00:00Z',
  lines: [{ productId: 'P1', uom: 'ea', quantityMinor: 1, disposition: 'resell' }],
  ...over,
});

describe('turning a sale record into an OriginalSale', () => {
  it('reads id, number, total, tenders and lines defensively', () => {
    const s = toOriginalSale(JSON.parse(sale()))!;
    expect(s.saleId).toBe('S-1');
    expect(s.number).toBe('B-1');
    expect(s.totalMinor).toBe(20_000);
    expect(s.lines).toEqual([
      { productId: 'P1', uom: 'ea', quantityMinor: 2 },
      { productId: 'P2', uom: 'ea', quantityMinor: 1 },
    ]);
    expect(s.tenders).toEqual([{ kind: 'cash', amountMinor: 20_000 }]);
  });

  it('tolerates the older/simpler line shape (qty, no tenders)', () => {
    const s = toOriginalSale({ id: 'S-9', total: 1_200, lines: [{ productId: 'P1', qty: 1 }] })!;
    expect(s.lines).toEqual([{ productId: 'P1', uom: 'ea', quantityMinor: 1 }]);
    expect(s.tenders).toBeUndefined();
  });

  it('skips a record with no id or no usable line', () => {
    expect(toOriginalSale({ total: 100 })).toBeUndefined();
    expect(toOriginalSale({ id: 'S-x', lines: [] })).toBeUndefined();
    expect(toOriginalSale('not an object')).toBeUndefined();
  });
});

describe('turning a returns record into a RecordedReturn + refund value', () => {
  it('reads the return id, the bill, the lines and the refund money', () => {
    const m = toRecordedReturn(JSON.parse(ret()))!;
    expect(m.ret).toEqual({
      returnId: 'R-1', originalSaleId: 'S-1', processedAt: '2026-08-05T11:00:00Z',
      lines: [{ productId: 'P1', uom: 'ea', quantityMinor: 1 }],
    });
    expect(m.refund).toEqual({ returnId: 'R-1', originalSaleId: 'S-1', refundMinor: 7_500 });
  });
});

describe('buildReceiptLookup over a lane\'s logs', () => {
  it('finds a bill by BOTH its receipt number and its sale id', () => {
    const lookup = buildReceiptLookup([sale()], []);
    expect(lookup('B-1')!.sale.saleId).toBe('S-1');
    expect(lookup('S-1')!.sale.number).toBe('B-1');
  });

  it('returns undefined for a bill this lane did not ring', () => {
    expect(buildReceiptLookup([sale()], [])('B-999')).toBeUndefined();
  });

  it('carries the return/refund history, and the register folds it into what is still returnable', () => {
    const result = buildReceiptLookup([sale()], [ret()])('B-1')!;
    expect(result.returns).toHaveLength(1);
    expect(result.refunds).toEqual([{ returnId: 'R-1', originalSaleId: 'S-1', refundMinor: 7_500 }]);

    const returnable = returnableLines(result.sale, returnRegister(result.returns));
    const p1 = returnable.find((l) => l.productId === 'P1')!;
    expect(p1).toMatchObject({ soldMinor: 2, alreadyReturnedMinor: 1, returnableMinor: 1 });
    const p2 = returnable.find((l) => l.productId === 'P2')!;
    expect(p2).toMatchObject({ soldMinor: 1, alreadyReturnedMinor: 0, returnableMinor: 1 });
  });

  it('counts the same return id once, however many times it appears in the log', () => {
    const result = buildReceiptLookup([sale()], [ret(), ret()])('S-1')!; // re-queued/re-read duplicate
    expect(result.returns).toHaveLength(1);
    const p1 = returnableLines(result.sale, returnRegister(result.returns)).find((l) => l.productId === 'P1')!;
    expect(p1.alreadyReturnedMinor).toBe(1); // not 2
  });

  it('keeps the FIRST record for a duplicate sale id/number, so a bad re-append cannot shadow it', () => {
    const good = sale();
    const shadow = sale({ total: 1, lines: [{ productId: 'PX', quantityMinor: 1, uom: 'ea' }] });
    expect(buildReceiptLookup([good, shadow], [])('S-1')!.sale.totalMinor).toBe(20_000);
  });

  it('ignores a no-receipt return (against no bill) and malformed lines', () => {
    const noReceipt = ret({ returnId: 'R-nr', originalSaleId: null });
    const garbage = '{ not json';
    const result = buildReceiptLookup([sale(), garbage], [ret(), noReceipt, garbage])('S-1')!;
    expect(result.returns.map((r) => r.returnId)).toEqual(['R-1']); // R-nr not attributed to any bill
  });
});
