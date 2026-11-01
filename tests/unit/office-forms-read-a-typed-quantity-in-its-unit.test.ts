import { describe, it, expect } from 'vitest';
import { typedQuantity } from '../../apps/web-erp/src/buying-stock-browser-wiring';

// OB-31 (Round 4b): the one shared reading the Record a write-off form now uses (window.sreTypedQuantity) — a quantity typed in
// the item's own unit becomes the smallest steps stored, NaN when it does not read (so the form refuses it, never rounds it),
// and back again for a form restored from a saved draft. Before, the form read "2.5" kg as 2 (Math.trunc).

describe('a typed quantity in its own unit (OB-31)', () => {
  it('reads kg and litres to the gram and millilitre, items whole; refuses what does not read', () => {
    expect([typedQuantity.minor('2.5', 'kg'), typedQuantity.minor('1.25', 'L'), typedQuantity.minor('12', 'ea')]).toEqual([2_500, 1_250, 12]);
    for (const [t, u] of [['2.5', 'ea'], ['2.5005', 'kg'], ['', 'kg'], ['0', 'kg'], ['x', 'kg'], ['2', 'crate']] as const) expect(typedQuantity.minor(t, u), `${t} ${u}`).toBeNaN();
    expect(typedQuantity.minor('0', 'kg', true)).toBe(0);
    expect([typedQuantity.typed(2_500, 'kg'), typedQuantity.typed(12, 'ea'), typedQuantity.typed(3, 'crate')]).toEqual(['2.500', '12', '3']);
  });
});
