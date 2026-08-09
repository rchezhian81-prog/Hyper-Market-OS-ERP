import { describe, it, expect } from 'vitest';
import { weightedAverageValuation, type ValuationMovement } from '../../packages/stock/src/valuation';

// M08-FR-04 / owner accounting policy (9 Aug 2026): value stock at the WEIGHTED AVERAGE cost.
// The average re-computes on every costed receipt; issues leave at that average and become COGS;
// nothing is stored, it is a fold over the movements — the same shape as on-hand.

const recv = (qty: number, unitCostMinor: number, over: Partial<ValuationMovement> = {}): ValuationMovement =>
  ({ productId: 'P1', locationId: 'L1', effect: 1, quantityMinor: qty, isPurchaseReceipt: true, unitCostMinor, ...over });
const issue = (qty: number, over: Partial<ValuationMovement> = {}): ValuationMovement =>
  ({ productId: 'P1', locationId: 'L1', effect: -1, quantityMinor: qty, isPurchaseReceipt: false, ...over });
const only = (ms: ValuationMovement[]) => weightedAverageValuation(ms, 'INR')[0]!;

describe('weighted-average stock valuation (M08-FR-04, owner policy)', () => {
  it('re-averages the cost of everything on hand when a new receipt arrives at a different price', () => {
    // 100 @ ₹10 then 100 @ ₹14 → 200 on hand worth ₹2400, average ₹12.
    const v = only([recv(100, 1000), recv(100, 1400)]);
    expect(v.onHandMinor).toBe(200);
    expect(v.value.minor).toBe(240_000);
    expect(v.unitCostMinor).toBe(1200);
  });

  it('issues at the running average and books that as cost of goods sold', () => {
    // From 200 @ avg ₹12, sell 50 → COGS ₹600, 150 left worth ₹1800, average still ₹12.
    const v = only([recv(100, 1000), recv(100, 1400), issue(50)]);
    expect(v.onHandMinor).toBe(150);
    expect(v.cogs.minor).toBe(60_000);
    expect(v.value.minor).toBe(180_000);
    expect(v.unitCostMinor).toBe(1200); // the sale does not move the average
  });

  it('a return / transfer-in re-enters at the average and does NOT change it', () => {
    // 100 @ ₹10, sell 10 (avg ₹10), then a customer return of 5 comes back at ₹10, not a new price.
    const v = only([recv(100, 1000), issue(10), { productId: 'P1', locationId: 'L1', effect: 1, quantityMinor: 5, isPurchaseReceipt: false }]);
    expect(v.onHandMinor).toBe(95);
    expect(v.unitCostMinor).toBe(1000);
    expect(v.value.minor).toBe(95_000);
  });

  it('reports an uncosted receipt as UNVALUED rather than folding it in at zero (P-08)', () => {
    // 100 @ ₹10, then 50 received with NO cost. The average stays ₹10 on the valued 100; the 50 are
    // on hand but flagged unvalued, so they do not drag the average to ₹6.67.
    const v = only([recv(100, 1000), { productId: 'P1', locationId: 'L1', effect: 1, quantityMinor: 50, isPurchaseReceipt: true }]);
    expect(v.onHandMinor).toBe(150);
    expect(v.unvaluedMinor).toBe(50);
    expect(v.unitCostMinor).toBe(1000); // not 667
    expect(v.value.minor).toBe(100_000);
  });

  it('reports the average as not_known when nothing valued is on hand', () => {
    const v = only([{ productId: 'P1', locationId: 'L1', effect: 1, quantityMinor: 10, isPurchaseReceipt: true }]); // uncosted only
    expect(v.unitCostMinor).toBe('not_known');
    expect(v.value.minor).toBe(0);
    expect(v.unvaluedMinor).toBe(10);
  });

  it('separates products and locations', () => {
    const rows = weightedAverageValuation([
      recv(100, 1000), recv(100, 1000, { productId: 'P2' }), recv(100, 2000, { locationId: 'L2' }),
    ], 'INR');
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.productId === 'P2')!.unitCostMinor).toBe(1000);
    expect(rows.find((r) => r.locationId === 'L2')!.unitCostMinor).toBe(2000);
  });

  it('is deterministic and exact under an awkward average (integer minor units)', () => {
    // 3 @ ₹10 then 1 @ ₹11 → 4 on hand worth ₹41, average ₹10.25 = 1025 minor. Sell 1 → COGS 1025.
    const v = only([recv(3, 1000), recv(1, 1100), issue(1)]);
    expect(v.value.minor).toBe(3_075);
    expect(v.cogs.minor).toBe(1_025);
    expect(v.onHandMinor).toBe(3);
    expect(v.unitCostMinor).toBe(1025);
  });
});
