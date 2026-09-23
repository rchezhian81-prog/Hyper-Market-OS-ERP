import { describe, it, expect } from 'vitest';
import { planBackorder, type OrderLine } from '../../services/orders/src/index';

// M18-FR-02 — the backorder engine, in isolation. A promise reserves what it can; the un-promised
// remainder must not vanish. `planBackorder` works out that remainder as ORDERED minus RESERVED —
// a figure already on the ledger, never a fresh availability guess, so recording it can never
// oversell. A line held in full has no shortfall; a line held in part or not at all is backordered
// for exactly the gap. This is the pure kernel the API route records append-only.

const line = (productId: string, quantityMinor: number): OrderLine => ({ productId, quantityMinor });
const reserved = (entries: readonly (readonly [string, number])[]): ReadonlyMap<string, number> => new Map(entries);

describe('planBackorder — the un-promised remainder of an order (M18-FR-02)', () => {
  it('backorders nothing when every line is reserved in full', () => {
    const plan = planBackorder({
      orderId: 'o1',
      lines: [line('RICE', 5), line('OIL', 2)],
      reserved: reserved([['RICE', 5], ['OIL', 2]]),
    });
    expect(plan.outcome).toBe('nothing_to_backorder');
    expect(plan.lines).toEqual([]);
    expect(plan.detail).toContain('nothing to backorder');
  });

  it('backorders exactly the gap on a partially-held line', () => {
    const plan = planBackorder({
      orderId: 'o2',
      lines: [line('RICE', 5)],
      reserved: reserved([['RICE', 3]]),
    });
    expect(plan.outcome).toBe('backordered');
    expect(plan.lines).toEqual([{ productId: 'RICE', requestedMinor: 5, reservedMinor: 3, shortfallMinor: 2 }]);
  });

  it('backorders the whole line when nothing at all was reserved', () => {
    const plan = planBackorder({
      orderId: 'o3',
      lines: [line('RICE', 5)],
      reserved: reserved([]),
    });
    expect(plan.outcome).toBe('backordered');
    expect(plan.lines).toEqual([{ productId: 'RICE', requestedMinor: 5, reservedMinor: 0, shortfallMinor: 5 }]);
  });

  it('backorders only the short lines on a mixed order, leaving the held ones out', () => {
    const plan = planBackorder({
      orderId: 'o4',
      lines: [line('RICE', 5), line('OIL', 2), line('SALT', 4)],
      reserved: reserved([['RICE', 5], ['OIL', 0], ['SALT', 1]]),
    });
    expect(plan.outcome).toBe('backordered');
    expect(plan.lines).toEqual([
      { productId: 'OIL', requestedMinor: 2, reservedMinor: 0, shortfallMinor: 2 },
      { productId: 'SALT', requestedMinor: 4, reservedMinor: 1, shortfallMinor: 3 },
    ]);
  });

  it('never reports a negative shortfall — an over-reserved line is simply not short', () => {
    // Defensive: a reserved figure that somehow exceeds the order is clamped to zero, never a
    // negative backorder that would read as "we owe the customer minus two bags".
    const plan = planBackorder({
      orderId: 'o5',
      lines: [line('RICE', 5)],
      reserved: reserved([['RICE', 7]]),
    });
    expect(plan.outcome).toBe('nothing_to_backorder');
    expect(plan.lines).toEqual([]);
  });
});
