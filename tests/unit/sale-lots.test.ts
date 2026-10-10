import { describe, it, expect } from 'vitest';
import { assignSaleLots } from '../../services/pos/src/sale-lots';
import type { IncomingSale } from '../../services/pos/src/sale-intake';

/** OB-35 "A": the pure FEFO assignment of a synced sale's batch-tracked lines (head office side). */
const sale = (lines: IncomingSale['lines']): IncomingSale => ({
  saleId: 'S', receiptNumber: 'R', laneId: 'l', cashierId: 'c', tradingDay: '2026-10-10', committedAt: '2026-10-10T10:00:00.000Z',
  totalMinor: lines.reduce((n, l) => n + l.lineTotalMinor, 0), currency: 'INR', packVersion: 1, lines, tenders: [],
} as IncomingSale);
const line = (productId: string, qty: number, unit = 1_000) => ({ productId, quantityMinor: qty, uom: 'each', unitPriceMinor: unit, lineTotalMinor: qty * unit });

describe('assignSaleLots (OB-35)', () => {
  const lots = (p: string) => (p === 'MILK' ? [{ batchId: 'B1', onHandMinor: 3, expiry: '2026-10-12' }, { batchId: 'B2', onHandMinor: 5, expiry: '2026-10-20' }, { batchId: null, onHandMinor: 9 }] : []);

  it('two lines of the same product draw the batches down in turn — no unit assigned twice', () => {
    const out = assignSaleLots(sale([line('MILK', 2), line('MILK', 2)]), (p) => p === 'MILK', lots);
    expect(out.sale.lines.map((l) => [l.batchId, l.quantityMinor, l.lineTotalMinor, l.batchAssigned])).toEqual([
      ['B1', 2, 2_000, 'fefo'], ['B1', 1, 1_000, 'fefo'], ['B2', 1, 1_000, 'fefo'],
    ]);
    expect(out.sale.lines.reduce((n, l) => n + l.lineTotalMinor, 0)).toBe(4_000);
  });

  it('keeps a line total to the paise when a split does not divide evenly', () => {
    const odd = { productId: 'MILK', quantityMinor: 4, uom: 'each', unitPriceMinor: 333, lineTotalMinor: 1_333 };
    const out = assignSaleLots(sale([odd]), () => true, lots);
    expect(out.sale.lines.map((l) => l.lineTotalMinor)).toEqual([1_000, 333]);
  });

  it('leaves untracked products, lines the till gave a batch, and products with no batch on hand untouched', () => {
    const given = { ...line('MILK', 1), batchId: 'B2' };
    const input = sale([line('DAL', 1), given, line('CURD', 1)]);
    const out = assignSaleLots(input, (p) => p !== 'DAL', lots);
    expect(out.assigned).toBe(0);
    expect(out.sale).toBe(input);
  });
});
