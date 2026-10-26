import { describe, it, expect } from 'vitest';
import { limitsInForce, readLimit, positionOf, judgeVmiProposal, type VmiLimit } from '../../packages/purchasing/src/vmi';

// FG-4 · D03-FR-04: vendor-managed inventory. The buyer's limits are the supplier's items; a proposal stays inside the
// maximum; an item without a limit is not the supplier's.

const lim = (over: Partial<VmiLimit> = {}): VmiLimit => ({ supplierId: 'S1', storeId: 'st', productId: 'rice', minQty: 20, maxQty: 50, uom: 'ea', setBy: 'b', setAt: '2026-10-26T00:00:00Z', ...over });

describe('vendor-managed inventory (D03-FR-04)', () => {
  it('the latest limit per supplier, store and item stands; one taken off is gone', () => {
    expect(limitsInForce([lim(), lim({ maxQty: 60 })]).map((l) => l.maxQty)).toEqual([60]);
    expect(limitsInForce([lim(), lim({ minQty: null, maxQty: null })])).toEqual([]);
    expect(limitsInForce([lim(), lim({ supplierId: 'S2' })])).toHaveLength(2);
  });

  it('reads a limit strictly', () => {
    expect(readLimit(20, 50)).toEqual({ ok: true, minQty: 20, maxQty: 50 });
    for (const [a, b] of [[60, 50], [-1, 5], [0, 0], [1.5, 5], ['1', 5]] as const) expect(readLimit(a, b).ok).toBe(false);
  });

  it('room is the maximum less on hand and on order, never below zero', () => {
    expect(positionOf(lim(), 15, 0)).toMatchObject({ room: 35, belowMinimum: true });
    expect(positionOf(lim(), 15, 10)).toMatchObject({ room: 25, belowMinimum: false });
    expect(positionOf(lim(), 70, 0)).toMatchObject({ room: 0 });
  });

  it('judges each line: not the supplier\'s, a bad quantity, past the maximum, twice; inside — said against the minimum', () => {
    const positions = [positionOf(lim(), 15, 0)];
    const j = judgeVmiProposal({ positions, lines: [{ productId: 'dal', quantity: 1 }, { productId: 'rice', quantity: 0 }] });
    expect(j.ok).toBe(false);
    expect(j.lines.map((l) => l.refusal)).toEqual(['not_your_item', 'bad_quantity']);
    expect(judgeVmiProposal({ positions, lines: [{ productId: 'rice', quantity: 36 }] }).lines[0]).toMatchObject({ refusal: 'above_the_agreed_maximum' });
    expect(judgeVmiProposal({ positions, lines: [{ productId: 'rice', quantity: 5 }, { productId: 'rice', quantity: 5 }] }).lines[1]).toMatchObject({ refusal: 'repeated_item' });
    const fine = judgeVmiProposal({ positions, lines: [{ productId: 'rice', quantity: 35 }] });
    expect(fine.ok).toBe(true);
    expect(fine.lines[0]!.detail).toMatch(/below its minimum/);
    expect(judgeVmiProposal({ positions: [positionOf(lim(), 30, 0)], lines: [{ productId: 'rice', quantity: 5 }] }).lines[0]!.detail).toMatch(/not yet at the minimum/);
    expect(judgeVmiProposal({ positions, lines: [] }).ok).toBe(false);
  });
});
