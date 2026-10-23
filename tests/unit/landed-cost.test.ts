import { describe, it, expect } from 'vitest';
import { apportionLandedCharges, landedCostDeltas, weightedAverageValuation, type ValuationMovement } from '../../packages/stock/src/index';
import { withLandedCost, type StockCostAdjustment } from '../../services/inventory/src/landed-cost';
import type { Movement } from '../../services/inventory/src/index';

// M07-FR-04 · D03-FR-05 (OB-288 P3): freight and duty apportioned to the paisa, posted as compensating value-only
// adjustments, and folded into the weighted-average value and COGS. Pure.

describe('apportioning landed charges', () => {
  it('splits by goods value then by quantity per place, summing to the charge exactly', () => {
    const shares = apportionLandedCharges(1_001, [{ productId: 'rice', valueMinor: 50_000 }, { productId: 'dal', valueMinor: 9_999 }], [
      { productId: 'rice', locationId: 'wh-1', quantityMinor: 7 }, { productId: 'rice', locationId: 'wh-2', quantityMinor: 3 },
      { productId: 'dal', locationId: 'wh-1', quantityMinor: 3 },
    ]);
    expect(shares.reduce((s, x) => s + x.valueMinor, 0)).toBe(1_001);
    expect(shares.filter((s) => s.productId === 'rice').reduce((s, x) => s + x.valueMinor, 0)).toBe(834);
    expect(shares.find((s) => s.productId === 'rice' && s.locationId === 'wh-1')!.valueMinor).toBe(584); // 834 × 7/10 = 583.8 → 584
  });

  it('a product nobody received carries nothing — the whole charge lands on stock that exists; nothing at all when no stock', () => {
    const shares = apportionLandedCharges(100, [{ productId: 'a', valueMinor: 500 }, { productId: 'b', valueMinor: 500 }], [{ productId: 'a', locationId: 'x', quantityMinor: 1 }]);
    expect(shares).toEqual([{ productId: 'a', locationId: 'x', quantityMinor: 1, valueMinor: 100 }]);
    expect(apportionLandedCharges(100, [{ productId: 'a', valueMinor: 500 }], [])).toEqual([]);
    expect(apportionLandedCharges(0, [{ productId: 'a', valueMinor: 500 }], [{ productId: 'a', locationId: 'x', quantityMinor: 1 }])).toEqual([]);
  });

  it('posts only the difference: nothing twice, a change as a delta, a withdrawn charge fully reversed', () => {
    const want = [{ productId: 'a', locationId: 'x', quantityMinor: 1, valueMinor: 100 }];
    expect(landedCostDeltas(want, [])).toEqual(want);
    expect(landedCostDeltas(want, want)).toEqual([]);
    expect(landedCostDeltas([{ ...want[0]!, valueMinor: 130 }], want)).toEqual([{ ...want[0]!, valueMinor: 30 }]);
    expect(landedCostDeltas([], [want[0]!, { ...want[0]!, valueMinor: 30 }])).toEqual([{ ...want[0]!, valueMinor: -130 }]);
  });
});

describe('a cost adjustment in the weighted-average fold', () => {
  const receipt = (q: number, cost: number): ValuationMovement => ({ productId: 'a', locationId: 'x', effect: 1, quantityMinor: q, isPurchaseReceipt: true, unitCostMinor: cost });
  const sale = (q: number): ValuationMovement => ({ productId: 'a', locationId: 'x', effect: -1, quantityMinor: q, isPurchaseReceipt: false });
  const adj = (q: number, v: number): ValuationMovement => ({ productId: 'a', locationId: 'x', effect: 1, quantityMinor: q, isPurchaseReceipt: false, isCostAdjustment: true, adjustmentMinor: v });

  it('raises the value of what is on hand and the average, never the quantity', () => {
    const [row] = weightedAverageValuation([receipt(10, 500), adj(10, 101)], 'INR');
    expect(row).toMatchObject({ onHandMinor: 10, value: { minor: 5_101 }, cogs: { minor: 0 }, unitCostMinor: 510 });
  });

  it('sends the sold share to COGS; stock + COGS move by exactly the adjustment, negative ones too', () => {
    const [row] = weightedAverageValuation([receipt(10, 500), sale(4), adj(10, 101)], 'INR');
    expect(row!.value.minor + row!.cogs.minor).toBe(5_000 + 101);
    expect(row).toMatchObject({ value: { minor: 3_061 }, cogs: { minor: 2_040 } }); // 6/10 of 101 = 60.6 → 61
    const [back] = weightedAverageValuation([receipt(10, 500), sale(4), adj(10, 101), adj(10, -101)], 'INR');
    expect(back!.value.minor + back!.cogs.minor).toBe(5_000);
    const [allSold] = weightedAverageValuation([receipt(10, 500), sale(10), adj(10, 50)], 'INR');
    expect(allSold).toMatchObject({ value: { minor: 0 }, cogs: { minor: 5_050 } });
  });

  it('merges adjustments into the movement order by time', () => {
    const m = (id: string, at: string, kind: Movement['kind'], q: number): Movement => ({ movementId: id, productId: 'a', locationId: 'x', kind, quantityMinor: q, uom: 'ea', occurredAt: at, enteredBy: 'u', ...(kind === 'received' ? { unitCostMinor: 500 } : {}) });
    const a: StockCostAdjustment = { adjustmentId: 'j', invoiceId: 'i', poId: 'p', productId: 'a', locationId: 'x', quantityMinor: 10, valueMinor: 100, occurredAt: '2026-10-02T00:00:00.000Z', postedBy: 'u', matchedAt: '2026-10-02T00:00:00.000Z' };
    const merged = withLandedCost([m('r', '2026-10-01T00:00:00.000Z', 'received', 10), m('s', '2026-10-03T00:00:00.000Z', 'sold', 5)], [a], (x) => ({ productId: x.productId, locationId: x.locationId, effect: x.kind === 'received' ? 1 : -1, quantityMinor: x.quantityMinor, isPurchaseReceipt: x.kind === 'received', ...(x.unitCostMinor === undefined ? {} : { unitCostMinor: x.unitCostMinor }) }));
    expect(merged.map((v) => v.isCostAdjustment === true)).toEqual([false, true, false]);
    const [row] = weightedAverageValuation(merged, 'INR');
    expect(row).toMatchObject({ value: { minor: 2_550 }, cogs: { minor: 2_550 } });
  });
});
