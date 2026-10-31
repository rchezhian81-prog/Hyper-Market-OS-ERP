import { describe, it, expect } from 'vitest';
import { readPack } from '../../edge/store-edge/src/store-pack';
import { warehousePayload } from '../../edge/store-edge/src/screen-data';
import { WarehouseSession, handheldQuantity, type WarehouseAssignment } from '../../apps/warehouse-app/src/warehouse-session';
import { SyncOutbox } from '../../packages/sync/src/outbox';
import { drainToBox, type FetchLike } from '../../packages/sync/src/device-drain';

// Screen gap audit 31 Oct 2026 (Round B, OB-614 "wrong numbers first"):
//   • the warehouse handheld showed "prod-rice 200000 units · kg" — the product's CODE, and a kg line's grams read as units;
//   • the warehouse, picker and driver handhelds said "the store computer could not be reached, trying again" when the box
//     had answered 403 "not allowed" — and kept retrying for ever.
// Synthetic data only.

const NOW = '2026-10-31T06:00:00.000Z';

const ASSIGNMENT: WarehouseAssignment = {
  assignmentId: 'wa-1', workerId: 'u-wh', storeId: 'store-1',
  bins: [{ binId: 'BIN-A', storeId: 'store-1', capacityMinor: 1_000_000, pickable: true, zone: 'ambient' }],
  goodsIn: [{ productId: 'prod-rice-loose', batchId: null, quantityMinor: 200_000, uom: 'kg', state: 'on_hand', expiry: null, recalled: false }],
  productNames: { 'prod-rice-loose': 'Demo Ponni Rice (loose)' },
  productNamesTa: { 'prod-rice-loose': 'டெமோ பொன்னி அரிசி' },
};

describe('the warehouse handheld names the product and reads a quantity in its unit', () => {
  it('the store computer serves the product names (and Tamil names, where recorded) with the warehouse work', () => {
    const pack = readPack({
      version: 1,
      products: [
        { productId: 'prod-rice-loose', name: 'Demo Ponni Rice (loose)', nameTa: 'டெமோ பொன்னி அரிசி', categoryId: 'cat-food', unitPriceMinor: 6800, uom: 'kg', barcodes: ['8900000000999'] },
        { productId: 'prod-soap', name: 'Demo Bath Soap 100g', categoryId: 'cat-household', unitPriceMinor: 3500, uom: 'ea', barcodes: ['8900000000012'] },
      ],
      warehouse: {
        assignmentId: 'wa-1', workerId: 'u-wh', storeId: 'store-1',
        bins: [{ binId: 'BIN-A', storeId: 'store-1', capacityMinor: 1_000_000, pickable: true }],
        goodsIn: [{ productId: 'prod-rice-loose', batchId: null, quantityMinor: 200_000, uom: 'kg', state: 'on_hand', expiry: null }],
      },
    }, NOW);
    const payload = warehousePayload({ pack, sales: [], unreadableRecords: 0, outbox: new SyncOutbox(), now: NOW, tradingDay: '2026-10-31' }) as Record<string, unknown>;
    expect(payload['productNames']).toEqual({ 'prod-rice-loose': 'Demo Ponni Rice (loose)', 'prod-soap': 'Demo Bath Soap 100g' });
    expect(payload['productNamesTa']).toEqual({ 'prod-rice-loose': 'டெமோ பொன்னி அரிசி' });
  });

  it('a kg line of 200000 g reads "200.000 kg" (never "200000 units"); a count of pieces stays a count', () => {
    expect(handheldQuantity(200_000, 'kg')).toEqual({ amount: '200.000', unit: 'kg' });
    expect(handheldQuantity(1_500, 'L')).toEqual({ amount: '1.500', unit: 'L' });
    expect(handheldQuantity(1_500, 'ltr')).toEqual({ amount: '1.500', unit: 'L' });
    expect(handheldQuantity(12, 'EA')).toEqual({ amount: '12', unit: null });
    expect(handheldQuantity(7, 'box-of-6')).toEqual({ amount: '7', unit: null }); // unknown spelling: the count, never a guess
  });


  it('the session gives the name (Tamil where recorded), the code when it is not named, and its sent-work list reads the same way', () => {
    const s = new WarehouseSession(ASSIGNMENT, new SyncOutbox(), { now: () => NOW });
    expect(s.productName('prod-rice-loose')).toBe('Demo Ponni Rice (loose)');
    expect(s.productName('prod-rice-loose', 'ta')).toBe('டெமோ பொன்னி அரிசி');
    expect(s.productName('prod-unknown')).toBe('prod-unknown');
    expect(s.quantityText(2_500, 'kg')).toEqual({ amount: '2.500', unit: 'kg' });
    const put = s.putAway({ commandId: 'm-1', scannedProductId: 'prod-rice-loose', scannedBinId: 'BIN-A', quantityMinor: 2_500, uom: 'kg', at: NOW });
    expect(put.result.accepted).toBe(true);
    expect(s.sentWork()[0]).toMatchObject({ kind: 'put_away', what: 'Demo Ponni Rice (loose) · BIN-A', detail: '2.500 kg' });
  });
});

describe('a 403 from the store computer is "not allowed", not "could not be reached"', () => {
  // One put-away the warehouse handheld queued — a record the box relays for the `warehouse` surface.
  const queued = () => {
    const outbox = new SyncOutbox();
    const s = new WarehouseSession(ASSIGNMENT, outbox, { now: () => NOW });
    expect(s.putAway({ commandId: 'm-9', scannedProductId: 'prod-rice-loose', scannedBinId: 'BIN-A', quantityMinor: 1_000, uom: 'kg', at: NOW }).result.accepted).toBe(true);
    return outbox;
  };
  const answering = (status: number, body: unknown): FetchLike => () => Promise.resolve({ status, json: () => Promise.resolve(body) });

  it('says it is not allowed, in the box\'s own words, and keeps the work (never dead-lettered)', async () => {
    const outbox = queued();
    const r = await drainToBox({ outbox, boxBase: '', source: 'warehouse', fetch: answering(403, { acks: [], reason: 'u-cashier may not hand over warehouse work' }) });
    expect(r.offline).toBe(false);
    expect(r.notAllowed).toBe('u-cashier may not hand over warehouse work');
    expect(outbox.pending()).toHaveLength(1);
    expect(outbox.deadLetters()).toHaveLength(0);
  });

  it('reads the reason wherever the box wrote it, with a plain default when it gave none', async () => {
    expect((await drainToBox({ outbox: queued(), boxBase: '', source: 'warehouse', fetch: answering(403, { error: 'device_revoked', detail: 'this handheld was withdrawn' }) })).notAllowed).toBe('this handheld was withdrawn');
    expect((await drainToBox({ outbox: queued(), boxBase: '', source: 'warehouse', fetch: answering(403, 'not json') })).notAllowed).toBe('the store computer answered that this is not allowed');
  });

  it('a lost link, a 401 (nobody signed in yet) and a 500 are NOT "not allowed"', async () => {
    const down: FetchLike = () => Promise.reject(new Error('network down'));
    expect((await drainToBox({ outbox: queued(), boxBase: '', source: 'warehouse', fetch: down })).notAllowed).toBeUndefined();
    expect((await drainToBox({ outbox: queued(), boxBase: '', source: 'warehouse', fetch: answering(401, { acks: [], reason: 'nobody is signed in' }) })).notAllowed).toBeUndefined();
    expect((await drainToBox({ outbox: queued(), boxBase: '', source: 'warehouse', fetch: answering(500, { acks: [] }) })).notAllowed).toBeUndefined();
  });
});
