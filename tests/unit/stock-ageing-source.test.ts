import { describe, it, expect } from 'vitest';
import { agedStockLots, weightedAverageValuation, type DatedMovement } from '../../packages/stock/src';

// The ageing SOURCE (M08-FR-04): folds the movement ledger into the current remaining stock, aged by
// receipt date and valued at weighted-average cost. The two properties that make it trustworthy are
// RECONCILIATION (the lots' total value equals the WAC stock value, their total quantity equals
// on-hand) and FIFO physical draw-down (an issue takes the oldest stock first). Value is the pooled
// WAC value apportioned across on-hand units; uncosted receipts are surfaced as an unvalued quantity.

const recv = (id: string, on: string, qty: number, cost?: number): DatedMovement => ({
  productId: id, locationId: 'L1', effect: 1, quantityMinor: qty, isPurchaseReceipt: true,
  occurredAt: `${on}T10:00:00.000Z`, ...(cost === undefined ? {} : { unitCostMinor: cost }),
});
const issue = (id: string, on: string, qty: number): DatedMovement => ({
  productId: id, locationId: 'L1', effect: -1, quantityMinor: qty, isPurchaseReceipt: false,
  occurredAt: `${on}T10:00:00.000Z`,
});
const back = (id: string, on: string, qty: number): DatedMovement => ({ // a return / transfer-in
  productId: id, locationId: 'L1', effect: 1, quantityMinor: qty, isPurchaseReceipt: false,
  occurredAt: `${on}T10:00:00.000Z`,
});

const totalValue = (r: ReturnType<typeof agedStockLots>): number =>
  r.lots.reduce((s, l) => s + l.value.minor, 0);
const totalQty = (r: ReturnType<typeof agedStockLots>): number =>
  r.lots.reduce((s, l) => s + l.quantityMinor, 0);

describe('agedStockLots folds the ledger into WAC-valued, receipt-dated remaining stock', () => {
  it('keeps a lot per receipt and values them at their share of the WAC stock value', () => {
    // 100 @ ₹10.00 then 100 @ ₹10.50 → WAC value 205,000 over 200 units.
    const { lots, unvaluedMinor } = agedStockLots([recv('P1', '2026-01-01', 100, 1000), recv('P1', '2026-02-01', 100, 1050)], 'INR');
    expect(lots).toHaveLength(2);
    expect(lots.map((l) => l.receivedOn)).toEqual(['2026-01-01', '2026-02-01']);
    expect(lots.map((l) => l.value.minor)).toEqual([102500, 102500]);
    expect(unvaluedMinor).toBe(0);
  });

  it('draws an issue down FIFO — the OLDEST stock leaves first', () => {
    const r = agedStockLots([
      recv('P1', '2026-01-01', 100, 1000), recv('P1', '2026-02-01', 100, 1050), issue('P1', '2026-03-01', 50),
    ], 'INR');
    // Oldest lot reduced 100 → 50; newest untouched.
    expect(r.lots.map((l) => ({ on: l.receivedOn, qty: l.quantityMinor }))).toEqual([
      { on: '2026-01-01', qty: 50 }, { on: '2026-02-01', qty: 100 },
    ]);
    expect(r.lots.map((l) => l.value.minor)).toEqual([51250, 102500]); // reconciles to 153,750
  });

  it('reconciles EXACTLY to the weighted-average valuation — same value, same quantity', () => {
    const moves = [
      recv('P1', '2026-01-01', 100, 1000), recv('P1', '2026-02-01', 100, 1050),
      issue('P1', '2026-03-01', 70), back('P1', '2026-03-15', 10),
    ];
    const aged = agedStockLots(moves, 'INR');
    const valn = weightedAverageValuation(
      moves.map((m) => ({ productId: m.productId, locationId: m.locationId, effect: m.effect, quantityMinor: m.quantityMinor, isPurchaseReceipt: m.isPurchaseReceipt, ...(m.unitCostMinor === undefined ? {} : { unitCostMinor: m.unitCostMinor }) })),
      'INR',
    );
    const p1 = valn.find((v) => v.productId === 'P1')!;
    expect(totalValue(aged)).toBe(p1.value.minor);
    expect(totalQty(aged)).toBe(p1.onHandMinor);
  });

  it('re-ages a return as of the day it came back, not its original receipt', () => {
    const r = agedStockLots([recv('P1', '2026-01-01', 100, 1000), back('P1', '2026-06-01', 20)], 'INR');
    expect(r.lots.map((l) => l.receivedOn)).toEqual(['2026-01-01', '2026-06-01']);
    expect(totalQty(r)).toBe(120);
  });

  it('surfaces an uncosted receipt as unvalued quantity, and still reconciles on value', () => {
    // 20 @ ₹5.00 (valued) then 40 with no cost. Valued stock value 10,000; 40 units unvalued.
    const r = agedStockLots([recv('P2', '2026-01-01', 20, 500), recv('P2', '2026-02-01', 40)], 'INR');
    expect(r.unvaluedMinor).toBe(40);
    expect(totalQty(r)).toBe(60);
    expect(totalValue(r)).toBe(10000); // the value that IS known, apportioned across on-hand
  });

  it('never overstates quantity — an overdraw leaves nothing to age, and it always reconciles', () => {
    // An issue larger than everything received: on-hand is not positive, nothing remains to age.
    const neg = agedStockLots([recv('P3', '2026-01-01', 30, 1000), issue('P3', '2026-02-01', 50)], 'INR');
    expect(neg.lots).toEqual([]);
    // Whatever the valuation makes of an out-of-order issue (negative stock is an M08 exception the
    // valuation values at zero), the ageing quantity matches it exactly — the two never disagree.
    const moves = [issue('P4', '2026-01-01', 40), recv('P4', '2026-02-01', 100, 1000)];
    const ooo = agedStockLots(moves, 'INR');
    const valn = weightedAverageValuation(
      moves.map((m) => ({ productId: m.productId, locationId: m.locationId, effect: m.effect, quantityMinor: m.quantityMinor, isPurchaseReceipt: m.isPurchaseReceipt, ...(m.unitCostMinor === undefined ? {} : { unitCostMinor: m.unitCostMinor }) })),
      'INR',
    );
    expect(totalQty(ooo)).toBe(valn.find((v) => v.productId === 'P4')!.onHandMinor);
  });

  it('separates products and locations — a product ages only its own stock', () => {
    const r = agedStockLots([
      recv('P1', '2026-01-01', 100, 1000),
      { productId: 'P1', locationId: 'L2', effect: 1, quantityMinor: 50, isPurchaseReceipt: true, occurredAt: '2026-01-02T10:00:00.000Z', unitCostMinor: 2000 },
    ], 'INR');
    expect(totalValue(r)).toBe(100000 + 100000);
    expect(totalQty(r)).toBe(150);
  });
});
