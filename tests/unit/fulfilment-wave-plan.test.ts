import { describe, it, expect } from 'vitest';
import { planWave, pickBinFor, type WaveOrder, type WaveProduct } from '../../packages/fulfilment/src/index';
import type { Bin } from '../../packages/warehouse/src/movements';

// M19-FR-01 · WF-14 · OB-300 — a picker's wave built from confirmed orders: the bin from the register, the price from the
// pack, an order NEVER split, every order accounted for. Synthetic data.

const BINS: Bin[] = [
  { binId: 'A-01', storeId: 'S1', capacityMinor: 100, pickable: true, zone: 'ambient' },
  { binId: 'A-02', storeId: 'S1', capacityMinor: 100, pickable: true, zone: 'ambient' },
  { binId: 'H-01', storeId: 'S1', capacityMinor: 100, pickable: false },
  { binId: 'Q-01', storeId: 'S1', capacityMinor: 100, pickable: true, zone: 'quarantine' },
  { binId: 'B-01', storeId: 'S2', capacityMinor: 100, pickable: true },
];
const CONTENTS = {
  'A-01|RICE|': 4, 'A-02|RICE|': 9, 'A-02|DAL|b1': 3, 'H-01|OIL|': 50, 'Q-01|OIL|': 50, 'B-01|OIL|': 5,
};
const PRODUCTS: Record<string, WaveProduct> = {
  RICE: { productId: 'RICE', name: 'Rice 1kg', baseUom: 'each', unitPriceMinor: 80_00 },
  DAL: { productId: 'DAL', name: 'Toor dal 500g', baseUom: 'each', unitPriceMinor: 75_00 },
  OIL: { productId: 'OIL', name: 'Groundnut oil 1L', baseUom: 'each', unitPriceMinor: 190_00 },
};
const facts = { binOf: (p: string) => pickBinFor(p, 'S1', BINS, CONTENTS), productOf: (p: string) => PRODUCTS[p] };

describe('pickBinFor — the bin a picker goes to', () => {
  it('is the pickable bin of THIS store holding the most; never a holding bin, a quarantine bin, an empty bin or another store\'s', () => {
    expect(pickBinFor('RICE', 'S1', BINS, CONTENTS)).toBe('A-02');
    expect(pickBinFor('DAL', 'S1', BINS, CONTENTS)).toBe('A-02');
    expect(pickBinFor('OIL', 'S1', BINS, CONTENTS)).toBeUndefined(); // only a holding bin and a quarantine bin hold it here
    expect(pickBinFor('OIL', 'S2', BINS, CONTENTS)).toBe('B-01');
    expect(pickBinFor('SALT', 'S1', BINS, CONTENTS)).toBeUndefined();
  });
  it('breaks a tie on the bin id, so the same facts give the same bin', () => {
    expect(pickBinFor('RICE', 'S1', BINS, { 'A-02|RICE|': 5, 'A-01|RICE|': 5 })).toBe('A-01');
  });
});

describe('planWave — confirmed orders into a wave (OB-300: never split)', () => {
  const order = (orderId: string, lines: [string, number][], locationId = 'S1'): WaveOrder => ({ orderId, locationId, lines: lines.map(([productId, quantityMinor]) => ({ productId, quantityMinor })) });

  it('makes every line from head office\'s facts — bin, name, unit and price — and walks the bins in order', () => {
    const plan = planWave({ waveId: 'W1', storeId: 'S1', orders: [order('O1', [['RICE', 2], ['DAL', 1]])], ...facts });
    expect(plan.orderIds).toEqual(['O1']);
    expect(plan.lines).toEqual([
      { lineId: 'O1:DAL', orderRef: 'O1', productId: 'DAL', description: 'Toor dal 500g', bin: 'A-02', requiredQty: 1, uom: 'each', unitPriceMinor: 75_00 },
      { lineId: 'O1:RICE', orderRef: 'O1', productId: 'RICE', description: 'Rice 1kg', bin: 'A-02', requiredQty: 2, uom: 'each', unitPriceMinor: 80_00 },
    ]);
  });

  it('keeps an order out WHOLE when one line has no bin or no price, names why, and still waves the rest', () => {
    const plan = planWave({ waveId: 'W1', storeId: 'S1', orders: [order('O1', [['RICE', 1], ['OIL', 1]]), order('O2', [['RICE', 1], ['SALT', 1]]), order('O3', [['RICE', 3]])], ...facts });
    expect(plan.orderIds).toEqual(['O3']);
    expect(plan.lines.map((l) => l.orderRef)).toEqual(['O3']); // nothing of O1 or O2 — not half an order
    expect(plan.refused).toEqual([
      expect.objectContaining({ orderId: 'O1', reason: 'no_bin', productIds: ['OIL'] }),
      expect.objectContaining({ orderId: 'O2', reason: 'not_in_pack', productIds: ['SALT'] }),
    ]);
    expect(plan.refused[0]!.detail).toMatch(/never guessed/);
  });

  it('refuses an order held at another store, an empty order and an order chosen twice — by name', () => {
    const plan = planWave({ waveId: 'W1', storeId: 'S1', orders: [order('O1', [['RICE', 1]], 'S2'), order('O2', [['RICE', 0]]), order('O3', [['RICE', 1]]), order('O3', [['RICE', 1]])], ...facts });
    expect(plan.refused.map((r) => [r.orderId, r.reason])).toEqual([['O1', 'other_store'], ['O2', 'no_lines'], ['O3', 'chosen_twice']]);
    expect(plan.lines).toHaveLength(1);
  });

  it('accounts for every order chosen — on the wave or refused, never neither (a property over many shapes)', () => {
    const products = ['RICE', 'DAL', 'OIL', 'SALT'];
    for (let seed = 1; seed <= 200; seed += 1) {
      const orders: WaveOrder[] = [];
      for (let i = 0; i < (seed % 7) + 1; i += 1) {
        const lines: [string, number][] = [];
        for (let j = 0; j < ((seed + i) % 3) + 1; j += 1) lines.push([products[(seed * (i + 1) + j) % 4]!, (seed + j) % 4]);
        orders.push(order(`O${(seed + i) % 5}`, lines, (seed + i) % 6 === 0 ? 'S2' : 'S1'));
      }
      const plan = planWave({ waveId: `W${seed}`, storeId: 'S1', orders, ...facts });
      expect(plan.accountedFor).toBe(orders.length);
      // An order is on the wave whole, or not at all.
      for (const id of plan.orderIds) expect(plan.refused.some((r) => r.orderId === id && r.reason !== 'chosen_twice')).toBe(false);
    }
  });

  it('is deterministic: the same orders give the same lines in the same order', () => {
    const orders = [order('O2', [['DAL', 1]]), order('O1', [['RICE', 1]])];
    expect(planWave({ waveId: 'W', storeId: 'S1', orders, ...facts })).toEqual(planWave({ waveId: 'W', storeId: 'S1', orders, ...facts }));
  });
});
