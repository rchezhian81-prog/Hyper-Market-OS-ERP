import { describe, it, expect } from 'vitest';
import {
  stockAgeing,
  inventoryTurns,
  gmroi,
  stockoutImpact,
  ratioBp,
  formatRatio,
  DEFAULT_AGEING_BUCKETS,
  type StockLot,
} from '../../packages/stock/src/index';
import { money } from '../../packages/contracts/src/money';

// M08-FR-04 — is the money tied up in this stock working, or dying? Exact maths, and
// a ratio that cannot be computed says so rather than inventing a number (P-08).

const INR = 'INR' as const;

describe('ratioBp — exact ratios, honest about the impossible', () => {
  it('computes an exact ratio in basis points', () => {
    expect(ratioBp(300, 100, 'x')).toEqual({ kind: 'ratio', bp: 30_000 }); // 3.00×
    expect(ratioBp(1, 3, 'x')).toEqual({ kind: 'ratio', bp: 3333 }); // 0.3333
  });

  it('never returns Infinity, NaN or a silent zero for a zero denominator', () => {
    const r = ratioBp(500, 0, 'no stock was held');
    expect(r).toEqual({ kind: 'not_meaningful', because: 'no stock was held' });
    expect(formatRatio(r)).toBe('not meaningful — no stock was held');
    expect(formatRatio({ kind: 'ratio', bp: 32_000 })).toBe('3.20×');
  });
});

describe('stockAgeing — how long the money has been asleep', () => {
  const LOTS: StockLot[] = [
    { productId: 'rice', batchId: 'B1', quantityMinor: 10, receivedOn: '2026-07-20', value: money(50_000, INR) },
    { productId: 'rice', batchId: 'B2', quantityMinor: 5, receivedOn: '2026-06-15', value: money(25_000, INR) },
    { productId: 'oil', batchId: null, quantityMinor: 3, receivedOn: '2026-01-10', value: money(25_000, INR) },
  ];

  it('buckets stock by age and values each bucket', () => {
    const report = stockAgeing(LOTS, '2026-08-01', INR);
    expect(report.rows[0]?.label).toBe('0-30 days');
    expect(report.rows[0]?.value).toEqual({ minor: 50_000, currency: INR }); // 12 days old
    expect(report.rows[1]?.value).toEqual({ minor: 25_000, currency: INR }); // 47 days old
    expect(report.rows[3]?.value).toEqual({ minor: 25_000, currency: INR }); // 203 days old
    expect(report.totalValue).toEqual({ minor: 100_000, currency: INR });
  });

  it('shows each bucket’s share of the money, so the risk is obvious', () => {
    const report = stockAgeing(LOTS, '2026-08-01', INR);
    expect(report.rows[0]?.shareBp).toBe(5000); // 50%
    expect(report.rows[3]?.shareBp).toBe(2500); // 25% of the cash is over 90 days old
    expect(report.oldestBucketValue).toEqual({ minor: 25_000, currency: INR });
  });

  it('takes the tenant’s own buckets, not ours', () => {
    const report = stockAgeing(LOTS, '2026-08-01', INR, [
      { label: 'fresh', fromDays: 0, toDays: 15 },
      { label: 'stale', fromDays: 15 },
    ]);
    expect(report.rows.map((r) => r.label)).toEqual(['fresh', 'stale']);
    expect(report.rows[0]?.quantityMinor).toBe(10);
    expect(report.rows[1]?.quantityMinor).toBe(8);
  });

  it('keeps a future-dated lot in the report instead of losing it', () => {
    // A data error must be visible, not silently dropped from the totals.
    const report = stockAgeing(
      [{ productId: 'x', batchId: null, quantityMinor: 4, receivedOn: '2026-09-01', value: money(9_000, INR) }],
      '2026-08-01',
      INR,
    );
    expect(report.totalValue).toEqual({ minor: 9_000, currency: INR });
    expect(report.rows[0]?.quantityMinor).toBe(4);
  });

  it('reports an empty shop as empty, not as an error', () => {
    const report = stockAgeing([], '2026-08-01', INR);
    expect(report.totalValue).toEqual({ minor: 0, currency: INR });
    expect(report.rows).toHaveLength(DEFAULT_AGEING_BUCKETS.length);
    expect(report.rows.every((r) => r.shareBp === 0)).toBe(true);
  });
});

describe('inventoryTurns and gmroi — is the shelf space earning its keep?', () => {
  it('computes turns, the annualised rate, and days of cover', () => {
    const result = inventoryTurns({
      cogs: money(1_200_000, INR), // ₹12,000 sold at cost in the period
      averageInventory: money(400_000, INR), // ₹4,000 held on average
      periodDays: 90,
    });
    expect(result.turns).toEqual({ kind: 'ratio', bp: 30_000 }); // 3.00× in 90 days
    expect(formatRatio(result.annualisedTurns)).toBe('12.17×');
    expect(formatRatio(result.daysOfCover)).toBe('30.00×'); // 30 days of stock
  });

  it('says plainly when nothing was held or nothing sold', () => {
    const noStock = inventoryTurns({
      cogs: money(500_000, INR),
      averageInventory: money(0, INR),
      periodDays: 30,
    });
    expect(noStock.turns.kind).toBe('not_meaningful');
    expect(noStock.annualisedTurns.kind).toBe('not_meaningful');

    const noSales = inventoryTurns({
      cogs: money(0, INR),
      averageInventory: money(500_000, INR),
      periodDays: 30,
    });
    expect(noSales.turns).toEqual({ kind: 'ratio', bp: 0 });
    expect(noSales.daysOfCover).toEqual({
      kind: 'not_meaningful',
      because: 'nothing sold in the period',
    });
  });

  it('computes GMROI — margin earned per rupee of stock held', () => {
    expect(gmroi({ grossMargin: money(300_000, INR), averageInventory: money(200_000, INR) })).toEqual({
      kind: 'ratio',
      bp: 15_000,
    }); // ₹1.50 of margin per ₹1 held

    // Below 1.00× the line consumes more cash than it returns, however good the
    // percentage margin looks — that is the whole point of the measure.
    const weak = gmroi({ grossMargin: money(80_000, INR), averageInventory: money(200_000, INR) });
    expect(weak).toEqual({ kind: 'ratio', bp: 4_000 });
    expect(formatRatio(weak)).toBe('0.40×');
  });

  it('does not invent a GMROI when no stock was held', () => {
    expect(gmroi({ grossMargin: money(50_000, INR), averageInventory: money(0, INR) })).toEqual({
      kind: 'not_meaningful',
      because: 'no stock was held, so there is no investment to return on',
    });
  });
});

describe('stockoutImpact — the loss that never reaches a sales report', () => {
  it('estimates the units and the margin the empty shelf cost', () => {
    const result = stockoutImpact(
      [
        {
          productId: 'milk',
          daysOutOfStock: 6,
          periodDays: 30,
          averageDailyUnits: 40,
          marginPerUnit: money(500, INR), // ₹5.00
        },
        {
          productId: 'rice',
          daysOutOfStock: 3,
          periodDays: 30,
          averageDailyUnits: 10,
          marginPerUnit: money(1_200, INR),
        },
      ],
      INR,
    );
    expect(result.rows[0]?.outOfStockBp).toBe(2000); // empty 20% of the month
    expect(result.rows[0]?.estimatedLostUnits).toBe(240);
    expect(result.rows[0]?.estimatedLostMargin).toEqual({ minor: 120_000, currency: INR });
    expect(result.totalLostMargin).toEqual({ minor: 156_000, currency: INR }); // ₹1,560.00
  });

  it('reports nothing lost when the shelf was never empty', () => {
    const result = stockoutImpact(
      [{ productId: 'milk', daysOutOfStock: 0, periodDays: 30, averageDailyUnits: 40, marginPerUnit: money(500, INR) }],
      INR,
    );
    expect(result.totalLostMargin).toEqual({ minor: 0, currency: INR });
    expect(result.rows[0]?.outOfStockBp).toBe(0);
  });
});
