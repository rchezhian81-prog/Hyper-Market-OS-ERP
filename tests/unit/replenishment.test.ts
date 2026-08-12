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

  describe('bounds a perishable order by remaining shelf life (D-3)', () => {
    // The order-up-to is capped at what can sell before the batch expires:
    // avgDailyDemand × remainingShelfLifeDays. An over-order is prevented.
    it('caps the order-up-to at days-of-supply when the cap is below the max level', () => {
      // demand 10/day × 3 days left = 30 sellable; max 50 → target is 30, not 50
      const proposal = proposeReplenishment(baseInput({
        onHand: 5, reorderPoint: 40, avgDailyDemand: 10, remainingShelfLifeDays: 3,
      }));
      expect(proposal?.suggestedQty).toBe(25); // 30 − 5, not 45
      expect(proposal?.reason).toBe('below_reorder_point');
      expect(proposal?.shelfLifeCap).toBe(30);
      expect(proposal?.shelfLifeCapped).toBe(true);
    });

    it('does not bind when the shelf-life ceiling is above the max level', () => {
      // 100/day × 5 days = 500 sellable, well above max 50 → the max binds, order is normal
      const proposal = proposeReplenishment(baseInput({
        onHand: 5, avgDailyDemand: 100, remainingShelfLifeDays: 5,
      }));
      expect(proposal?.suggestedQty).toBe(45); // 50 − 5, unchanged
      expect(proposal?.shelfLifeCap).toBe(500);
      expect(proposal?.shelfLifeCapped).toBeUndefined();
    });

    it('prevents an over-order: holds when the holding already covers the shelf life', () => {
      // 5/day × 2 days = 10 sellable, but 15 already on hand → ordering anything over-stocks a perishable
      const proposal = proposeReplenishment(baseInput({
        onHand: 15, reorderPoint: 40, avgDailyDemand: 5, remainingShelfLifeDays: 2,
      }));
      expect(proposal?.suggestedQty).toBe(0);
      expect(proposal?.reason).toBe('held_shelf_life'); // a visible exception, not a silent null
      expect(proposal?.shelfLifeCap).toBe(10);
      expect(proposal?.shelfLifeCapped).toBe(true);
    });

    it('holds a batch that expires today (nothing can sell before it expires)', () => {
      const proposal = proposeReplenishment(baseInput({
        onHand: 5, reorderPoint: 40, avgDailyDemand: 5, remainingShelfLifeDays: 0,
      }));
      expect(proposal?.reason).toBe('held_shelf_life');
      expect(proposal?.shelfLifeCap).toBe(0);
    });

    it('fits whole packs under the ceiling rather than letting a pack round-up breach it', () => {
      // 10/day × 4 days = 40 sellable; need 40, pack 12 rounds to 48 which breaches → fit 36 (3 packs)
      const proposal = proposeReplenishment(baseInput({
        onHand: 0, reorderPoint: 50, avgDailyDemand: 10, remainingShelfLifeDays: 4, orderMultiple: 12,
      }));
      expect(proposal?.suggestedQty).toBe(36); // largest full-pack quantity that stays ≤ 40
      expect(proposal?.shelfLifeCapped).toBe(true);
    });

    it('holds when even the supplier minimum would over-order the perishable', () => {
      // 5/day × 2 days = 10 sellable, but MOQ 20 → no compliant order fits under the ceiling → held
      const proposal = proposeReplenishment(baseInput({
        onHand: 0, reorderPoint: 50, avgDailyDemand: 5, remainingShelfLifeDays: 2, minOrderQty: 20,
      }));
      expect(proposal?.suggestedQty).toBe(0);
      expect(proposal?.reason).toBe('held_shelf_life');
    });

    it('does not cap when the demand rate is unknown (never guesses)', () => {
      // shelf life supplied but no demand → cannot compute days-of-supply → no bound, ordinary order
      const proposal = proposeReplenishment(baseInput({
        onHand: 5, reorderPoint: 40, remainingShelfLifeDays: 2,
      }));
      expect(proposal?.suggestedQty).toBe(45);
      expect(proposal?.shelfLifeCap).toBeUndefined();
      expect(proposal?.shelfLifeCapped).toBeUndefined();
    });
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
