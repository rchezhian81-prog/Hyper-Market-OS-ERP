import { describe, it, expect } from 'vitest';
import { WarehouseSession, RECEIVING_COMPLETED, type WarehouseAssignment } from '../../apps/warehouse-app/src/warehouse-session';
import { withChosenDelivery } from '../../apps/warehouse-app/src/browser-entry';
import { SyncOutbox } from '../../packages/sync/src/outbox';

// M07-FR-01 (OB-288 P3): the supplier's advance ship notice comes to the phone with its open delivery and is CACHED there,
// so the receiver sees what differs from it with no signal at all (§31, P-01) — and "delivery complete" names the ASN, so
// head office compares its own copy with what was booked. Pure: no network anywhere in this test.

const AT = '2026-10-22T10:00:00.000Z';
const ASN = { asnId: 'ASN-7', expectedAt: AT, lines: [{ productId: 'p-oil', quantityMinor: 10, uom: 'ea' }] };
const BASE: WarehouseAssignment = {
  assignmentId: 'A-1', workerId: 'u-recv', storeId: 'store-1',
  bins: [{ binId: 'BIN-A', storeId: 'store-1', capacityMinor: 1000, pickable: true, zone: 'ambient' }],
  barcodes: [{ barcode: '890OIL', productId: 'p-oil', level: 'unit' }],
  packs: [{ productId: 'p-oil', baseUom: 'ea', levels: [{ level: 'unit', containsMinor: 1, barcode: '890OIL' }] }],
  openDeliveries: [
    { poId: 'po-1', number: 'PO-1', supplierId: 'sup-1', grnId: 'grn-po-1-1', ordered: [{ productId: 'p-oil', quantityMinor: 12, unitCost: { minor: 1_800, currency: 'INR' } }], asn: ASN },
    { poId: 'po-2', number: 'PO-2', supplierId: 'sup-1', grnId: 'grn-po-2-1', ordered: [{ productId: 'p-oil', quantityMinor: 5, unitCost: { minor: 1_800, currency: 'INR' } }] },
  ],
};

describe('receiving against the cached ASN, offline (M07-FR-01)', () => {
  it('the chosen delivery brings its ASN; the differences are worked out on the phone as each scan lands', () => {
    const chosen = withChosenDelivery(BASE, 'po-1')!;
    expect(chosen).toMatchObject({ grnId: 'grn-po-1-1', poId: 'po-1', asn: ASN });
    const outbox = new SyncOutbox();
    const s = new WarehouseSession(chosen, outbox, { now: () => AT });
    expect(s.asnDifferences()).toEqual([expect.objectContaining({ productId: 'p-oil', advisedMinor: 10, receivedMinor: 0, differenceMinor: -10 })]);
    for (let i = 0; i < 10; i++) s.receive({ commandId: `c${i}`, grnId: 'grn-po-1-1', barcode: '890OIL', scannedQuantity: 1, source: 'po' });
    expect(s.asnDifferences()).toEqual([]); // matches the notice
    s.receive({ commandId: 'c10', grnId: 'grn-po-1-1', barcode: '890OIL', scannedQuantity: 2, source: 'po' });
    expect(s.asnDifferences()).toEqual([expect.objectContaining({ productId: 'p-oil', differenceMinor: 2, detail: '2 more than advised' })]);

    // "Delivery complete" names the ASN it was received against, inside the one completion record.
    expect(s.completeReceiving({ grnId: 'grn-po-1-1' }).accepted).toBe(true);
    const done = outbox.all().find((x) => x.event.type === RECEIVING_COMPLETED)!;
    expect(done.event.payload).toMatchObject({ grnId: 'grn-po-1-1', poId: 'po-1', asnId: 'ASN-7' });
  });

  it('a delivery with no ASN says there is none — never an empty list that reads as "matches"', () => {
    const chosen = withChosenDelivery(BASE, 'po-2')!;
    expect(chosen.asn).toBeUndefined();
    const s = new WarehouseSession(chosen, new SyncOutbox(), { now: () => AT });
    expect(s.asnDifferences()).toBeUndefined();
    s.receive({ commandId: 'c1', grnId: 'grn-po-2-1', barcode: '890OIL', scannedQuantity: 5, source: 'po' });
    s.completeReceiving({ grnId: 'grn-po-2-1' });
    // Switching back to the delivery with an ASN brings it; switching away drops it.
    expect(withChosenDelivery({ ...BASE, asn: ASN }, 'po-2')!.asn).toBeUndefined();
  });
});
