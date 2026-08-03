import { describe, it, expect } from 'vitest';
import {
  salesSummary,
  freshness,
  MixedCurrencyError,
  InvalidFreshnessTimeError,
  type SaleFact,
} from '../../packages/reporting/src/index';

// KPIs sum exactly and mean the same everywhere; freshness never shows stale data
// as fresh (M29-FR-01 / P-08).

function fact(overrides: Partial<SaleFact> & Pick<SaleFact, 'saleId'>): SaleFact {
  return {
    netMinor: 100_00,
    taxMinor: 18_00,
    totalMinor: 118_00,
    cogsMinor: 70_00,
    units: 3,
    tender: 'cash',
    currency: 'INR',
    ...overrides,
  };
}

describe('salesSummary', () => {
  it('aggregates the core KPIs exactly', () => {
    const summary = salesSummary([
      fact({ saleId: 's1' }),
      fact({ saleId: 's2', tender: 'upi' }),
    ]);
    expect(summary.grossSalesMinor).toBe(236_00); // 2 × 118
    expect(summary.netSalesMinor).toBe(200_00);
    expect(summary.taxMinor).toBe(36_00);
    expect(summary.cogsMinor).toBe(140_00);
    expect(summary.marginMinor).toBe(60_00); // 200 − 140
    expect(summary.marginPctBps).toBe(3000); // 60/200 = 30%
    expect(summary.basketCount).toBe(2);
    expect(summary.unitsSold).toBe(6);
    expect(summary.avgBasketMinor).toBe(118_00);
    expect(summary.tenderMix).toEqual({ cash: 118_00, upi: 118_00 });
  });

  it('returns a zeroed summary for no sales', () => {
    const summary = salesSummary([]);
    expect(summary.grossSalesMinor).toBe(0);
    expect(summary.marginPctBps).toBe(0);
    expect(summary.avgBasketMinor).toBe(0);
    expect(summary.basketCount).toBe(0);
  });

  it('refuses to blend currencies', () => {
    expect(() =>
      salesSummary([fact({ saleId: 's1', currency: 'INR' }), fact({ saleId: 's2', currency: 'USD' })]),
    ).toThrow(MixedCurrencyError);
  });
});

describe('freshness', () => {
  const asOf = '2026-08-02T12:00:00Z';

  it('reports fresh when within the staleness window', () => {
    const f = freshness('2026-08-02T11:59:30Z', asOf, 300); // 30s old, threshold 300s
    expect(f.state).toBe('fresh');
    expect(f.ageSeconds).toBe(30);
  });

  it('reports stale when older than the threshold', () => {
    const f = freshness('2026-08-02T11:50:00Z', asOf, 300); // 600s old
    expect(f.state).toBe('stale');
    expect(f.ageSeconds).toBe(600);
  });

  it('reports missing when never synced', () => {
    const f = freshness(null, asOf, 300);
    expect(f.state).toBe('missing');
    expect(f.ageSeconds).toBeNull();
  });

  it('rejects an invalid timestamp', () => {
    expect(() => freshness('not-a-date', asOf, 300)).toThrow(InvalidFreshnessTimeError);
  });
});
