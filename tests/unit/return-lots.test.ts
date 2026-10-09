import { describe, it, expect } from 'vitest';
import { lotsOfReturn, lotProblemWords } from '../../packages/returns/src/return-lots';
import type { OriginalSale } from '../../packages/returns/src/return-register';

/** PF-14 — a returned unit takes its lot from the bill (M13-FR-02 · M10-FR-03). Pure. */
const SALE: OriginalSale = {
  saleId: 'S1', number: 'R-1', tradingDay: '2026-10-09', committedAt: '2026-10-09T10:00:00.000Z', totalMinor: 0,
  lines: [
    { productId: 'DAL', uom: 'each', quantityMinor: 3, batchId: 'D-07', batchExpiry: '2026-12-31' },
    { productId: 'MILK', uom: 'each', quantityMinor: 2, batchId: 'M-1', batchExpiry: '2026-10-12' },
    { productId: 'MILK', uom: 'each', quantityMinor: 2, batchId: 'M-2' },
    { productId: 'SALT', uom: 'each', quantityMinor: 1 },
  ],
};
const line = (productId: string, batchId?: string) => ({ productId, uom: 'each', quantityMinor: 1, disposition: 'resell' as const, ...(batchId === undefined ? {} : { batchId }) });

describe('lotsOfReturn', () => {
  it('one batch on the bill: carried with its use-by date; a named batch the bill sold is kept (trimmed)', () => {
    expect(lotsOfReturn(SALE, [line('DAL'), line('MILK', ' M-1 ')])).toEqual({ problems: [], lines: [
      { ...line('DAL'), batchId: 'D-07', batchExpiry: '2026-12-31' },
      { ...line('MILK'), batchId: 'M-1', batchExpiry: '2026-10-12' },
    ] });
    // a batch sold with no use-by date carries none
    expect(lotsOfReturn(SALE, [line('MILK', 'M-2')]).lines).toEqual([{ ...line('MILK'), batchId: 'M-2' }]);
  });

  it('a product the bill sold with no batch keeps what the return says; nothing to check against', () => {
    expect(lotsOfReturn(SALE, [line('SALT'), line('SALT', 'S-1')])).toEqual({ problems: [], lines: [line('SALT'), line('SALT', 'S-1')] });
  });

  it('a batch the bill never sold, and none named where it sold several, are problems — said in words', () => {
    const r = lotsOfReturn(SALE, [line('DAL', 'X-99'), line('MILK')]);
    expect(r.problems).toEqual([
      { kind: 'batch_not_on_the_sale', productId: 'DAL', batchId: 'X-99', soldBatches: ['D-07'] },
      { kind: 'batch_not_named', productId: 'MILK', soldBatches: ['M-1', 'M-2'] },
    ]);
    expect(r.problems.map(lotProblemWords)).toEqual([
      'DAL batch X-99 was not sold on this bill — it sold D-07.',
      'This bill sold MILK from more than one batch (M-1, M-2) — say which batch the returned unit is from.',
    ]);
  });
});
