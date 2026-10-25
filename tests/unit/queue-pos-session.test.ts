import { describe, it, expect } from 'vitest';
import { createQueueSession, type QueueBasketPorts, type QueueTill } from '../../apps/queue-pos/src/queue-session';
import { bootPos } from '../../apps/pos/src/browser-entry';
import type { CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';

/**
 * **D04-FR-05 — the queue till's model on top of the till's own session.** The basket is priced by the till's tested
 * session from the signed pack; what this model adds is the code each line was scanned with (so a till can re-ring it),
 * the hand-over (the basket clears only once the store computer has it), and whether the handheld may take money.
 */

const CATALOGUE: CatalogueSnapshot = {
  tenantId: 't-sre', version: 1, builtAt: '2026-10-24T00:00:00.000Z',
  products: [
    { productId: 'P-DAL', sku: 'DAL', name: 'Toor dal 1kg', baseUom: 'ea', unitPriceMinor: 12_000, taxBps: 500, status: 'active' },
    { productId: 'P-BAN', sku: '000123', name: 'Banana (loose)', baseUom: 'kg', unitPriceMinor: 9_999, taxBps: 0, status: 'active' },
  ],
  barcodes: [{ code: '8901234567890', productId: 'P-DAL', kind: 'standard' }],
  embeddedRules: [{ prefix: '2', itemStart: 1, itemLength: 6, valueStart: 7, valueLength: 5, valueKind: 'weight' }],
};

const ports = (over: Partial<QueueBasketPorts> = {}): QueueBasketPorts & { sent: unknown[] } => {
  const sent: unknown[] = [];
  return {
    sent,
    handOver: async (body) => { sent.push(body); return { handedOver: true, code: '4821', lineCount: body.lines.length, laneMessage: 'Basket handed over.', laneMessageTa: 'கூடை ஒப்படைக்கப்பட்டது.' }; },
    waiting: async () => ({ waiting: [{ code: '4821', basketId: 'B', handedOverAt: 'x', lineCount: 1, handheldTotalMinor: 12_000 }] }),
    giveUp: async () => ({ givenUp: true, laneMessage: 'Basket given up. It stays on the record.' }),
    ...over,
  };
};
const tillOf = (mirror = false) => bootPos({ laneId: 'device:hh-q1', catalogue: CATALOGUE, ...(mirror ? { mirrorPilot: true } : {}) });

describe('the queue till prices with the till\'s own session and remembers what it scanned', () => {
  it('scans through the signed pack and hands the lines over by their scanned codes — never a price', async () => {
    const p = ports();
    const q = createQueueSession(tillOf(), p, { payments: false });
    q.scan('8901234567890');
    q.scan('8901234567890');
    expect(q.till.payableMinor()).toBe(24_000);
    const out = await q.handOver();
    expect(out).toMatchObject({ ok: true, code: '4821', lineCount: 2, laneMessageTa: 'கூடை ஒப்படைக்கப்பட்டது.' });
    expect(p.sent).toEqual([{ basketId: expect.any(String), lines: [
      { productId: 'P-DAL', name: 'Toor dal 1kg', barcode: '8901234567890', quantityMinor: 1 },
      { productId: 'P-DAL', name: 'Toor dal 1kg', barcode: '8901234567890', quantityMinor: 1 },
    ], handheldTotalMinor: 24_000 }]);
    // Kept on the store computer: the basket clears here for the next customer.
    expect(q.till.basket()).toEqual([]);
  });

  it('a handheld names no scale (B6), so a weighed label is refused at the scan by the till\'s own rule — nothing goes over', () => {
    const q = createQueueSession(tillOf(), ports(), { payments: false });
    expect(() => q.scan('2000123003330')).toThrow(/weighed_without_verified_scale/);
    expect(q.handOverLines()).toEqual({ ok: true, lines: [] });
  });

  it('where a scale IS named, a scale label goes over as ONE label (its code carries the weight), never as grams', () => {
    const due = new Date(Date.now() + 86_400_000 * 90).toISOString().slice(0, 10);
    const till = bootPos({ laneId: 'device:hh-q1', catalogue: CATALOGUE, laneScales: { known: true, scales: [{ assetId: 'SCALE-1', reverificationDueOn: due }] } });
    const q = createQueueSession(till, ports(), { payments: false });
    q.scan('2000123003330');
    expect(till.basket()[0]).toMatchObject({ productId: 'P-BAN', qty: 333 });
    expect(q.handOverLines()).toEqual({ ok: true, lines: [{ productId: 'P-BAN', name: 'Banana (loose)', barcode: '2000123003330', quantityMinor: 1 }] });
  });

  it('a quantity changed on the line goes over as that count', async () => {
    const p = ports();
    const q = createQueueSession(tillOf(), p, { payments: false });
    const line = q.scan('8901234567890');
    q.till.setQuantity(line.lineId, 3);
    expect(q.handOverLines()).toEqual({ ok: true, lines: [{ productId: 'P-DAL', name: 'Toor dal 1kg', barcode: '8901234567890', quantityMinor: 3 }] });
  });

  it('a voided line stays off the hand-over; a line not scanned here is refused by name, never dropped', async () => {
    const till = tillOf();
    const q = createQueueSession(till, ports(), { payments: false });
    const line = q.scan('8901234567890');
    till.voidLine(line.lineId, 'Scanned by mistake');
    expect(q.handOverLines()).toEqual({ ok: true, lines: [] });
    expect(await q.handOver()).toMatchObject({ ok: false, refusedBecause: 'empty_basket' });
    till.scan({ productId: 'P-DAL', description: 'Toor dal 1kg', unitPriceMinor: 12_000, qty: 1 });
    expect(q.handOverLines()).toEqual({ ok: false, missing: ['Toor dal 1kg'] });
    expect(await q.handOver()).toMatchObject({ ok: false, refusedBecause: 'line_without_code', lines: ['Toor dal 1kg'] });
  });

  it('the store computer refusing, or not answering, keeps the basket here — never cleared on a hope', async () => {
    const refused = createQueueSession(tillOf(), ports({ handOver: async () => ({ handedOver: false, refusedBecause: 'queue_busting_off', laneMessage: 'off', laneMessageTa: 'அணை' }) }), { payments: false });
    refused.scan('8901234567890');
    expect(await refused.handOver()).toEqual({ ok: false, refusedBecause: 'queue_busting_off', laneMessage: 'off', laneMessageTa: 'அணை' });
    expect(refused.till.basket()).toHaveLength(1);
    const down = createQueueSession(tillOf(), ports({ handOver: async () => { throw new Error('ENETUNREACH'); } }), { payments: false });
    down.scan('8901234567890');
    expect(await down.handOver()).toMatchObject({ ok: false, refusedBecause: 'box_unreachable' });
    expect(down.till.basket()).toHaveLength(1);
    const odd = createQueueSession(tillOf(), ports({ handOver: async () => ({ handedOver: true, code: 'ABCD' }) }), { payments: false });
    odd.scan('8901234567890');
    expect(await odd.handOver()).toMatchObject({ ok: false });
    expect(odd.till.basket()).toHaveLength(1);
  });
});

describe('whether the handheld takes money', () => {
  it('only where the shop switched it on — and never in the mirror pilot', () => {
    expect(createQueueSession(tillOf(), ports(), { payments: true }).paymentsHere()).toBe(true);
    expect(createQueueSession(tillOf(), ports(), { payments: false }).paymentsHere()).toBe(false);
    expect(createQueueSession(tillOf(true), ports(), { payments: true }).paymentsHere()).toBe(false);
  });
});

describe('the baskets waiting for a till, and giving one up', () => {
  it('lists them and gives one up with a reason; an unreachable box changes nothing and says so', async () => {
    const q = createQueueSession(tillOf(), ports(), { payments: false });
    expect(await q.waiting()).toEqual({ ok: true, baskets: [{ code: '4821', basketId: 'B', handedOverAt: 'x', lineCount: 1, handheldTotalMinor: 12_000 }] });
    expect(await q.giveUp('4821', 'Customer left the queue')).toEqual({ ok: true, laneMessage: 'Basket given up. It stays on the record.' });
    const down = createQueueSession(tillOf(), ports({ waiting: async () => { throw new Error('x'); }, giveUp: async () => { throw new Error('x'); } }), { payments: false });
    expect(await down.waiting()).toMatchObject({ ok: false, baskets: [] });
    expect(await down.giveUp('4821', 'left')).toMatchObject({ ok: false });
    const odd = createQueueSession(tillOf(), ports({ waiting: async () => ({ refusedBecause: 'queue_busting_off', laneMessage: 'off' }) }), { payments: false });
    expect(await odd.waiting()).toEqual({ ok: false, baskets: [], laneMessage: 'off' });
  });

  it('a new customer clears the basket and the remembered codes', () => {
    const q = createQueueSession(tillOf(), ports(), { payments: false });
    q.scan('8901234567890');
    q.newCustomer();
    expect(q.till.basket()).toEqual([]);
    expect(q.handOverLines()).toEqual({ ok: true, lines: [] });
  });

  it('the model asks only for what the till session offers (a stand-in till type-checks against it)', () => {
    const stand: QueueTill = { scanBarcode: () => ({ lineId: 'l', description: 'd', qty: 1, amountMinor: 0 }), basket: () => [], payableMinor: () => 0, newSale: () => undefined, currentBillRef: () => 'B', mirrorPilot: () => false };
    expect(createQueueSession(stand, ports(), { payments: true }).paymentsHere()).toBe(true);
  });
});
