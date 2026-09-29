import { describe, it, expect } from 'vitest';
import { resolveSaleStockLocation, saleStockMovements } from '../../services/pos/src/sale-stock';
import type { IncomingSale } from '../../services/pos/src/sale-intake';

// A sale is a stock movement (M08-FR-01). These are the pure rules that turn a banked sale into the
// `sold` movements the ledger folds — the fix for hosted-demo finding H-13 ("a till sale did not reduce
// on-hand stock"). The live-API proof is tests/integration/sale-reduces-stock.test.ts.

const sale: IncomingSale = {
  saleId: 'S-1', receiptNumber: 'R-1', laneId: 'lane-3', cashierId: 'u-meena',
  tradingDay: '2026-09-28', committedAt: '2026-09-28T10:15:00Z', totalMinor: 700, currency: 'INR', packVersion: 4,
  lines: [
    { productId: 'RICE', quantityMinor: 2, uom: 'each', unitPriceMinor: 100, lineTotalMinor: 200 },
    { productId: 'MILK', quantityMinor: 5, uom: 'each', unitPriceMinor: 100, lineTotalMinor: 500, batchId: 'B-7' },
  ],
  tenders: [{ kind: 'cash', amountMinor: 700 }],
};

describe('where a sale draws its stock from (M08-FR-01)', () => {
  it('takes the location the lane declared first', () => {
    expect(resolveSaleStockLocation({ ...sale, locationId: 'shop-floor' }, 'store-1'))
      .toEqual({ locationId: 'shop-floor', basis: 'declared_by_lane' });
  });

  it('falls back to the store the pack was published for', () => {
    expect(resolveSaleStockLocation(sale, 'store-1')).toEqual({ locationId: 'store-1', basis: 'store_of_pack' });
  });

  it('assumes the lane only when nothing else names a location — and says so', () => {
    expect(resolveSaleStockLocation(sale, undefined)).toEqual({ locationId: 'lane-3', basis: 'assumed_from_lane' });
    expect(resolveSaleStockLocation({ ...sale, locationId: '   ' }, '')).toEqual({ locationId: 'lane-3', basis: 'assumed_from_lane' });
  });
});

describe('the sold movements a banked sale appends', () => {
  it('appends one outbound `sold` movement per line, carrying the captured batch', () => {
    const moves = saleStockMovements(sale, { locationId: 'store-1', basis: 'store_of_pack' });
    expect(moves).toEqual([
      { movementId: 'sale-S-1-0', productId: 'RICE', locationId: 'store-1', kind: 'sold', quantityMinor: 2, uom: 'each', occurredAt: '2026-09-28T10:15:00Z', enteredBy: 'u-meena' },
      { movementId: 'sale-S-1-1', productId: 'MILK', locationId: 'store-1', kind: 'sold', quantityMinor: 5, uom: 'each', occurredAt: '2026-09-28T10:15:00Z', enteredBy: 'u-meena', batchId: 'B-7' },
    ]);
  });

  it('keys the movements on the sale and line, so a resent sale yields the same movements', () => {
    const a = saleStockMovements(sale, { locationId: 'store-1', basis: 'store_of_pack' });
    const b = saleStockMovements({ ...sale, receiptNumber: 'R-1-reprint' }, { locationId: 'store-1', basis: 'store_of_pack' });
    expect(b.map((m) => m.movementId)).toEqual(a.map((m) => m.movementId));
  });

  it('states an assumed location on the movement itself (P-08), never silently', () => {
    const [m] = saleStockMovements(sale, { locationId: 'lane-3', basis: 'assumed_from_lane' });
    expect(m?.locationId).toBe('lane-3');
    expect(m?.reason).toContain('assumed from lane lane-3');
  });

  it('skips a line that cannot be a movement without refusing the sale (hard rule #1)', () => {
    const odd: IncomingSale = {
      ...sale,
      lines: [
        { productId: 'VOID', quantityMinor: 0, uom: 'each', unitPriceMinor: 0, lineTotalMinor: 0 },
        { productId: 'NEG', quantityMinor: -1, uom: 'each', unitPriceMinor: 100, lineTotalMinor: -100 },
        { productId: 'FRAC', quantityMinor: 1.5, uom: 'kg', unitPriceMinor: 100, lineTotalMinor: 150 },
        { productId: 'OK', quantityMinor: 3, uom: 'each', unitPriceMinor: 100, lineTotalMinor: 300 },
      ],
    };
    expect(saleStockMovements(odd, { locationId: 'store-1', basis: 'store_of_pack' }).map((m) => m.productId)).toEqual(['OK']);
  });
});
