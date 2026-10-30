import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { reconcileDsd, dsdBatchesHeld, signDeliveryNote, DsdRefusedError, type DsdScan, type DsdHandBack } from '../../packages/receiving/src/dsd-checkin';
import { DsdDoorSession, DSD_FEEDBACK_CODES, DSD_CHECK_IN_CLOSED } from '../../apps/warehouse-app/src/dsd-door';
import { SyncOutbox } from '../../packages/sync/src/outbox';

/**
 * **OB-611 (owner, 30 Oct 2026 · round 16, R16-A): goods handed back at the DSD door name the batch they came from.**
 *
 * The engine (packages/receiving/src/dsd-checkin.ts, the SAME on the handheld and at head office): a product that came off
 * the van in more than one batch needs the batch named (`hand_back_batch_required`); a batch that never came off the van is
 * refused (`hand_back_batch_not_scanned`), and so is more than a batch came in with (`hand_back_more_than_batch_held`). The
 * per-batch figures are what the hand-backs NAMED — round 11's "batch scanned last" rule is gone. A product in one batch is
 * handed back from it with no question. The handheld (apps/warehouse-app/src/dsd-door.ts) offers the batches, offline, and
 * the record it queues carries the batch chosen. English and Tamil words for every refusal; 56 px targets (the e2e).
 */

const AT = '2030-06-01T06:00:00.000Z';
const B1 = { batchId: 'OIL-1', expiry: '2031-03-31', manufacturedOn: null };
const B2 = { batchId: 'OIL-2', expiry: '2031-04-30', manufacturedOn: null };
const scans: DsdScan[] = [
  { scanId: 's1', productId: 'p-oil', quantityMinor: 3, at: AT, batchId: 'OIL-1', expiry: '2031-03-31' },
  { scanId: 's2', productId: 'p-oil', quantityMinor: 4, at: AT, batchId: 'OIL-2', expiry: '2031-04-30' },
  { scanId: 's3', productId: 'p-salt', quantityMinor: 5, at: AT, batchId: 'SALT-1' },
  { scanId: 's4', productId: 'p-brm', quantityMinor: 2, at: AT },
];
const expected = [{ productId: 'p-oil', expectedMinor: 7, unitCostMinor: 100 }, { productId: 'p-salt', expectedMinor: 5 }, { productId: 'p-brm', expectedMinor: 2 }];
const hb = (handBackId: string, productId: string, quantityMinor: number, batch?: DsdHandBack['batch']): DsdHandBack => ({ handBackId, productId, quantityMinor, reason: 'damaged', note: null, at: AT, ...(batch === undefined ? {} : { batch }) });
const refusal = (handBacks: DsdHandBack[]): string | undefined => {
  try { reconcileDsd({ against: 'po', expected, scans, handBacks }); return undefined; } catch (e) { return e instanceof DsdRefusedError ? e.code : String(e); }
};

describe('the engine: a hand-back of a product in several batches names its batch (OB-611)', () => {
  it('no batch named, a batch never scanned, or more than the batch came in with — each refused by name', () => {
    expect(refusal([hb('h1', 'p-oil', 1)])).toBe('hand_back_batch_required');
    expect(refusal([hb('h1', 'p-oil', 1, { batchId: 'OIL-9', expiry: '2031-03-31', manufacturedOn: null })])).toBe('hand_back_batch_not_scanned');
    expect(refusal([hb('h1', 'p-oil', 4, B1)])).toBe('hand_back_more_than_batch_held');
    expect(refusal([hb('h1', 'p-oil', 2, B1), hb('h2', 'p-oil', 2, B1)])).toBe('hand_back_more_than_batch_held'); // summed per batch
    expect(refusal([hb('h1', 'p-oil', 8, B2)])).toBe('hand_back_more_than_scanned'); // the product's own cap comes first
  });

  it('the named batch is the one handed back — not the batch scanned last; the rest is received in scan order', () => {
    const r = reconcileDsd({ against: 'po', expected, scans, handBacks: [hb('h1', 'p-oil', 2, B1)] });
    const oil = r.lines.find((l) => l.productId === 'p-oil')!;
    expect(oil).toMatchObject({ scannedMinor: 7, handedBackMinor: 2, keptMinor: 5, receivableMinor: 5, heldMinor: 0 });
    expect(oil.batches!.map((b) => [b.batchId, b.scannedMinor, b.handedBackMinor, b.keptMinor, b.receivableMinor, b.heldMinor])).toEqual([['OIL-1', 3, 2, 1, 1, 0], ['OIL-2', 4, 0, 4, 4, 0]]);
    const note = signDeliveryNote({ body: { deliveryNote: { noteRef: 'N', driverSignedName: 'Ravi' } }, reconciliation: r, receiverId: 'u-recv', at: AT });
    expect(note.handedBack).toEqual([{ productId: 'p-oil', quantityMinor: 2, reason: 'damaged', batch: B1 }]);
  });

  it('one batch only: no batch is needed (that batch is meant); a product with no batch facts is as it always was', () => {
    const r = reconcileDsd({ against: 'po', expected, scans, handBacks: [hb('h1', 'p-salt', 1), hb('h2', 'p-brm', 1)] });
    expect(r.lines.find((l) => l.productId === 'p-salt')!.batches).toEqual([{ batchId: 'SALT-1', expiry: null, manufacturedOn: null, scannedMinor: 5, handedBackMinor: 1, keptMinor: 4, receivableMinor: 4, heldMinor: 0 }]);
    expect('batches' in r.lines.find((l) => l.productId === 'p-brm')!).toBe(false);
    expect(refusal([hb('h1', 'p-salt', 1, { batchId: 'SALT-2', expiry: null, manufacturedOn: null })])).toBe('hand_back_batch_not_scanned');
  });

  it('the batches held of a product, in the order first scanned, with what is left of each', () => {
    expect(dsdBatchesHeld(scans, [hb('h1', 'p-oil', 1, B2)], 'p-oil')).toEqual([
      { ...B1, scannedMinor: 3, handedBackMinor: 0, leftMinor: 3 },
      { ...B2, scannedMinor: 4, handedBackMinor: 1, leftMinor: 3 },
    ]);
    expect(dsdBatchesHeld(scans, [], 'p-brm')).toEqual([{ batchId: null, expiry: null, manufacturedOn: null, scannedMinor: 2, handedBackMinor: 0, leftMinor: 2 }]);
    expect(dsdBatchesHeld(scans, [], 'p-none')).toEqual([]);
  });
});

describe('the handheld asks which batch, offline, and the record it queues carries it (OB-611)', () => {
  const door = (outbox = new SyncOutbox()) => {
    const s = new DsdDoorSession({
      workerId: 'u-recv', storeId: 'S-A', barcodes: [{ barcode: '890OIL', productId: 'p-oil', level: 'unit' }] as never,
      openDeliveries: [{ poId: 'po-1', number: 'PO-1', supplierId: 'sup-1', ordered: [{ productId: 'p-oil', quantityMinor: 5, unitCost: { minor: 100 } }] }],
    }, outbox, () => AT);
    s.start({ checkInId: 'D-1', poId: 'po-1', driverName: 'Ravi' });
    return s;
  };

  it('one batch scanned: one choice (no question); two batches: both offered with what is left', () => {
    const s = door();
    s.scan('a', '890OIL', { batchId: 'OIL-1', expiry: '2031-03-31' });
    expect(s.handBackBatches('p-oil')).toHaveLength(1);
    s.scan('b', '890OIL', { batchId: 'OIL-2', expiry: '2031-04-30' });
    expect(s.handBackBatches('p-oil').map((b) => [b.batchId, b.leftMinor])).toEqual([['OIL-1', 1], ['OIL-2', 1]]);
  });

  it('a hand-back with no batch named is refused on the phone; with the batch it is taken, and the queued record carries it', () => {
    const outbox = new SyncOutbox();
    const s = door(outbox);
    s.scan('a', '890OIL', { batchId: 'OIL-1', expiry: '2031-03-31' });
    s.scan('b', '890OIL', { batchId: 'OIL-2', expiry: '2031-04-30' });
    expect(s.handBack('h1', 'p-oil', 1, 'damaged').code).toBe('hand_back_batch_required');
    expect(s.handBack('h1', 'p-oil', 2, 'damaged', B1).code).toBe('hand_back_more_than_batch_held');
    expect(s.handBack('h1', 'p-oil', 1, 'damaged', B1)).toMatchObject({ feedback: 'accept', code: 'dsd_handed_back' });
    expect(s.handBackBatches('p-oil').map((b) => [b.batchId, b.leftMinor])).toEqual([['OIL-1', 0], ['OIL-2', 1]]);
    expect(s.close({ noteRef: 'N-1', driverSignedName: 'Ravi' }).feedback).toBe('accept');
    const queued = outbox.pending().find((i) => i.event.type === DSD_CHECK_IN_CLOSED)!.event.payload as { handBacks: DsdHandBack[] };
    expect(queued.handBacks).toEqual([expect.objectContaining({ handBackId: 'h1', productId: 'p-oil', quantityMinor: 1, batch: B1 })]);
  });

  it('every refusal has words in English and Tamil, and the batch question is on the sheet', () => {
    for (const c of ['hand_back_batch_required', 'hand_back_batch_not_scanned', 'hand_back_more_than_batch_held'] as const) expect(DSD_FEEDBACK_CODES).toContain(c);
    const js = readFileSync('apps/warehouse-app/web/app.js', 'utf8');
    const words = js.slice(js.indexOf('const DSD_WORDS'), js.indexOf('const dt = '));
    for (const k of ['hand_back_batch_required', 'hand_back_batch_not_scanned', 'hand_back_more_than_batch_held', 'whichBatch', 'batchLeft']) {
      expect(words.split(new RegExp(`(?<![\\w])${k}:`)).length - 1, k).toBe(2);
    }
    expect(js).toMatch(/dsd\.handBack\(nextId\('dsd-back'\), dsdBack\.productId, dsdBack\.quantityMinor, reason, dsdBack\.batch\)/);
    expect(js).toContain("dsd.handBackBatches(l.productId)");
    expect(readFileSync('apps/warehouse-app/web/index.html', 'utf8')).toContain('id="dsd-back-batches"');
  });
});
