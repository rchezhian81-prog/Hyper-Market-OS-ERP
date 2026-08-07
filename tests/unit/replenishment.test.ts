import { describe, it, expect } from 'vitest';
import {
  proposeReplenishment,
  proposeReplenishmentBatch,
  InvalidReplenishmentParameterError,
} from '../../packages/replenishment/src/index';

// Replenishment is advisory: parameters drive the numbers, and a proposal can never
// become a PO by itself — a buyer approves (M09-FR-02 / hard rule #5).

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    productId: 'p1',
    onHand: 5,
    maxLevel: 50,
    reorderPoint: 10,
    ...overrides,
  };
}

describe('proposeReplenishment', () => {
  it('proposes an order-up-to-max quantity when below the reorder point', () => {
    const proposal = proposeReplenishment(baseInput());
    expect(proposal).not.toBeNull();
    expect(proposal?.position).toBe(5);
    expect(proposal?.suggestedQty).toBe(45); // 50 − 5
    expect(proposal?.reason).toBe('below_reorder_point');
    expect(proposal?.advisoryOnly).toBe(true);
  });

  it('proposes nothing when the position is above the reorder point', () => {
    expect(proposeReplenishment(baseInput({ onHand: 20 }))).toBeNull();
  });

  it('reorders at exactly the reorder point', () => {
    expect(proposeReplenishment(baseInput({ onHand: 10 }))).not.toBeNull();
  });

  it('counts on-order toward the position (no double ordering)', () => {
    // on-hand 5 + on-order 20 = position 25 > reorder point 10 → no reorder
    expect(proposeReplenishment(baseInput({ onHand: 5, onOrder: 20 }))).toBeNull();
  });

  it('reduces the position by reserved stock', () => {
    // position = 15 + 0 − 8 = 7 <= 10 → reorder up to 50 − 7 = 43
    const proposal = proposeReplenishment(baseInput({ onHand: 15, reserved: 8 }));
    expect(proposal?.position).toBe(7);
    expect(proposal?.suggestedQty).toBe(43);
  });

  it('computes the reorder point from demand and lead time when not explicit', () => {
    // reorder point = safety 4 + ceil(3/day × 5 days) = 4 + 15 = 19; position 5 <= 19
    const proposal = proposeReplenishment({
      productId: 'p1',
      onHand: 5,
      maxLevel: 50,
      safetyStock: 4,
      avgDailyDemand: 3,
      leadTimeDays: 5,
    });
    expect(proposal?.reorderPoint).toBe(19);
    expect(proposal?.suggestedQty).toBe(45);
  });

  it('rounds the suggested quantity up to the order multiple (pack size)', () => {
    // need 45 → round up to a multiple of 12 → 48
    const proposal = proposeReplenishment(baseInput({ orderMultiple: 12 }));
    expect(proposal?.suggestedQty).toBe(48);
  });

  it('raises the suggestion to the supplier minimum order quantity', () => {
    // need = 50 − 48 = 2, but MOQ 24 → 24
    const proposal = proposeReplenishment(baseInput({ onHand: 48, reorderPoint: 50, minOrderQty: 24 }));
    expect(proposal?.suggestedQty).toBe(24);
  });

  it('suppresses a blocked / discontinued item', () => {
    expect(proposeReplenishment(baseInput({ blocked: true }))).toBeNull();
  });

  it('proposes nothing when the target is already met (max misconfigured vs position)', () => {
    // position 5 <= reorder point 10, but maxLevel 5 → suggested 0 → null
    expect(proposeReplenishment(baseInput({ maxLevel: 5 }))).toBeNull();
  });

  it('rejects an invalid max level', () => {
    expect(() => proposeReplenishment(baseInput({ maxLevel: 0 }))).toThrow(
      InvalidReplenishmentParameterError,
    );
  });
});

describe('proposeReplenishmentBatch', () => {
  it('returns proposals only for the products that need a reorder, in order', () => {
    const proposals = proposeReplenishmentBatch([
      baseInput({ productId: 'a', onHand: 5 }), // needs
      baseInput({ productId: 'b', onHand: 40 }), // fine
      baseInput({ productId: 'c', onHand: 2 }), // needs
    ]);
    expect(proposals.map((p) => p.productId)).toEqual(['a', 'c']);
  });
});
