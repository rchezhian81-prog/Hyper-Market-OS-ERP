import { describe, it, expect } from 'vitest';
import { toCloudSale } from '../../edge/store-edge/src/cloud-sale';

/**
 * **The seam between the lane's sale and the cloud's sale, in isolation.**
 *
 * The store edge writes a sale to disk as `{ id, number, total, tenders: [{ kind, amount: { minor } }] }`
 * — the shape its own read model and a receipt reprint need. The cloud intake reads
 * `{ saleId, receiptNumber, totalMinor, packVersion, tenders: [{ kind, amountMinor }] }`. Both are
 * right; before this mapper existed, the outbox carried the first verbatim to `/v1/sales`, which
 * answered 400 and dead-lettered a real, paid-for sale. These prove the translation is faithful, and
 * that it can never turn a record already in the cloud shape into a wrong one.
 */

// The record a real lane commits — exactly the shape apps/pos/src/session.ts writes to disk.
const LANE_RECORD = {
  id: 'S-1', number: 'R-0001', laneId: 'lane-1', cashierId: 'u-meena',
  tradingDay: '2026-08-05', committedAt: '2026-08-05T10:00:00Z',
  lines: [{ productId: 'P1', quantityMinor: 1, uom: 'each', unitPriceMinor: 64_000, lineTotalMinor: 75_520, taxRateBps: 1800 }],
  tenders: [{ kind: 'cash', amount: { minor: 75_520, currency: 'INR' }, status: 'settled' }],
  total: 75_520, netMinor: 64_000, taxMinor: 11_520, currency: 'INR',
};

describe('toCloudSale — the lane record → the cloud contract', () => {
  it('renames id→saleId, number→receiptNumber, total→totalMinor and maps the tender amount', () => {
    const sale = toCloudSale(LANE_RECORD, 7);
    expect(sale.saleId).toBe('S-1');
    expect(sale.receiptNumber).toBe('R-0001');
    expect(sale.totalMinor).toBe(75_520);
    expect(sale.currency).toBe('INR');
    expect(sale.tenders).toEqual([{ kind: 'cash', amountMinor: 75_520 }]);
  });

  it('stamps the packVersion the disk record never carried — the pack the edge holds', () => {
    expect(toCloudSale(LANE_RECORD, 7).packVersion).toBe(7);
    expect(toCloudSale(LANE_RECORD, 0).packVersion).toBe(0);
  });

  it('carries the rich lines through untouched (prices + frozen HSN/tax the GST return needs)', () => {
    const sale = toCloudSale(LANE_RECORD, 7);
    expect(sale.lines).toEqual([
      { productId: 'P1', quantityMinor: 1, uom: 'each', unitPriceMinor: 64_000, lineTotalMinor: 75_520, taxRateBps: 1800 },
    ]);
  });

  it('is the identity on a record ALREADY in the cloud shape — a correct payload can never be made wrong', () => {
    const cloudShaped = {
      saleId: 'C-9', receiptNumber: 'CR-9', laneId: 'lane-2', cashierId: 'u-x',
      tradingDay: '2026-08-05', committedAt: '2026-08-05T11:00:00Z',
      totalMinor: 20_001, currency: 'INR', packVersion: 3,
      lines: [{ productId: 'P2', quantityMinor: 1, uom: 'each', unitPriceMinor: 20_001, lineTotalMinor: 20_001 }],
      tenders: [{ kind: 'cash', amountMinor: 20_001 }],
    };
    // packVersion 99 is offered but the record names its own (3) — its own wins.
    expect(toCloudSale(cloudShaped, 99)).toEqual(cloudShaped);
  });

  it('keeps a provider reference on a tender, and never invents a missing amount', () => {
    const withRef = {
      ...LANE_RECORD,
      tenders: [
        { kind: 'upi', amount: { minor: 75_520, currency: 'INR' }, ref: 'txn-abc' },
        { kind: 'cash' }, // no amount — the cloud must see it as absent and raise it, not read 0
      ],
    };
    const sale = toCloudSale(withRef, 1);
    expect(sale.tenders[0]).toEqual({ kind: 'upi', amountMinor: 75_520, ref: 'txn-abc' });
    expect(sale.tenders[1]).toEqual({ kind: 'cash' });
    expect('amountMinor' in (sale.tenders[1] as object)).toBe(false);
  });

  it('does not throw on unreadable junk off the disk — it degrades to a sale the cloud will flag', () => {
    const sale = toCloudSale('not an object', 2);
    expect(sale.saleId).toBe('');
    expect(sale.totalMinor).toBe(0);
    expect(sale.packVersion).toBe(2);
    expect(sale.lines).toEqual([]);
    expect(sale.tenders).toEqual([]);
  });
});
