import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { STREAM } from '../../services/api/src/adapters';
import { makeEvent } from '../../packages/contracts/src/event';
import { casePacksFor } from '../../services/api/src/r7b-receiving-adapters';
import { approveSupplierWith, SUPPLIER_MAKER, SUPPLIER_CHECKER } from '../support/approved-supplier';
import { backingsFor, headOffice, type HeadOffice } from '../support/till-bill-world';

/**
 * **Batch 20a — receiving, at head office, on the in-memory store AND real PostgreSQL (cold restart):**
 *
 *   • R5 (M07-FR-01 "receiving and dock reports" · §27.1): the receipts list carries each receipt's ORDER NUMBER and its
 *     SUPPLIER (code and name), so Goods receipt review can look a delivery up by them.
 *   • R7 (M03-FR-02): head office's pack ladders become the store pack's `casePacks` — a counted product's case sizes, exact
 *     (an inner of 6 inside a case of 4 inners is 24); a weighed product is left out.
 *   • The handheld (M07-FR-02/03, as Receive (office) since batch 18a): a scan carries the MRP printed on the pack and can be
 *     "failed the quality check / refused at the door". A failed scan posts NO stock (held out); the assembled receipt books
 *     it as a line with the check failed, quarantined for a second person; a different MRP is flagged `mrp_mismatch` for the
 *     buyer. An MRP that is not an amount is unreadable — nothing recorded.
 * Synthetic data only.
 */

const { backings, open, close } = backingsFor(process.env['DATABASE_URL']);
beforeAll(open);
afterAll(close);

const AT = '2026-10-14T05:00:00.000Z';

async function seeded(ho: HeadOffice): Promise<void> {
  await ho.h.provisionRole(ho.tenantId, SUPPLIER_MAKER, 'store_manager');
  await ho.h.provisionRole(ho.tenantId, SUPPLIER_CHECKER, 'accountant');
  await approveSupplierWith((method, path, userId, body) => ho.call(method, path, userId, body), 'sup-lakshmi', 'Lakshmi Agencies');
  const node = async (id: string, body: Record<string, unknown>): Promise<void> => { await ho.ok('POST', `/v1/org/nodes/${id}`, 'u-owner', body); };
  await node('C-1', { kind: 'company', name: 'Synthetic Retail' });
  await node('store-1', { kind: 'branch', name: 'Store store-1', parentId: 'C-1', companyId: 'C-1' });
  await ho.h.store.append(ho.tenantId, STREAM.catalogue, makeEvent({
    id: `pack-${ho.tenantId}-1`, type: 'CataloguePublished', occurredAt: AT, idempotencyKey: `catalogue-${ho.tenantId}-v1`, source: 'test/catalogue',
    payload: {
      snapshot: {
        tenantId: ho.tenantId, version: 1, builtAt: AT, scope: { tenantId: ho.tenantId, storeId: 'store-1' },
        products: [
          { productId: 'p-oil', sku: 'p-oil', name: 'Groundnut oil 1 L', unitPriceMinor: 19_000, mrpMinor: 21_000, taxBps: 500, status: 'active', uom: 'ea', batchTracked: false, handling: 'ambient' },
          { productId: 'p-soap', sku: 'p-soap', name: 'Soap', unitPriceMinor: 3_000, taxBps: 1_800, status: 'active', uom: 'ea', batchTracked: false, handling: 'ambient' },
        ],
        barcodes: [],
      },
    },
  }));
  await ho.ok('POST', '/v1/inventory/receipt-policy', 'u-owner', { excessToleranceBp: 0, shortageToleranceBp: 0, nearExpiryDays: 7 });
  await ho.ok('POST', '/v1/purchase/orders/po-32', 'u-buyer', { supplierId: 'sup-lakshmi', deliverToLocationId: 'store-1', lines: [{ productId: 'p-oil', orderedQty: 12, unitCost: { minor: 15_000, currency: 'INR' } }] });
  await ho.ok('POST', '/v1/purchase/orders/po-32/approval', 'u-owner', { reason: 'fixture' });
}

const scan = (ho: HeadOffice, commandId: string, quantityMinor: number, over: Record<string, unknown> = {}) =>
  ho.call('POST', `/v1/inventory/receiving-scans/${commandId}/synced`, 'u-box', {
    commandId, grnId: 'grn-hh', productId: 'p-oil', batchId: null, quantityMinor, uom: 'EA', source: 'po', poId: 'po-32', state: 'on_hand', expiry: null,
    receivedBy: 'u-recv', storeId: 'store-1', at: AT, ...over,
  });
const onHand = async (ho: HeadOffice): Promise<number> => {
  const res = await ho.call('GET', '/v1/inventory/availability', 'u-owner', undefined, { productId: 'p-oil' });
  return ((res.body as { rows: { locationId: string; onHandMinor: number }[] }).rows).filter((r) => r.locationId === 'store-1').reduce((s, r) => s + r.onHandMinor, 0);
};

describe.each(backings)('Batch 20a — receiving at head office — on $name', (backing) => {
  it('the handheld: a different MRP is flagged, failed units are held out and booked quarantined; the list says the order number and supplier', async () => {
    const ho = await headOffice(backing, [{ userId: 'u-buyer', role: 'store_manager' }, { userId: 'u-recv', role: 'store_manager' }, { userId: 'u-box', role: 'store_computer', stores: ['store-1'] }]);
    await seeded(ho);
    // An MRP that is not an amount is unreadable: nothing recorded, nothing on hand.
    expect((await scan(ho, 'c-bad', 1, { mrpMinor: 0 })).status).toBe(400);
    expect((await scan(ho, 'c-bad2', 1, { qcFailed: 'yes' })).status).toBe(400);
    // 9 good with the pack's MRP ₹220 (master ₹210), 3 that failed the check at the door.
    expect((await scan(ho, 'c1', 9, { mrpMinor: 22_000 })).body).toMatchObject({ recorded: true, onHand: true });
    const failed = await scan(ho, 'c2', 3, { qcFailed: true });
    expect(failed.body).toMatchObject({ recorded: true, onHand: false });
    expect(await onHand(ho)).toBe(9); // the failed units never reached the sellable stock

    ho.restartCold();
    const done = await ho.call('POST', '/v1/inventory/goods-receipt/grn-hh/assembled', 'u-box', { grnId: 'grn-hh', poId: 'po-32', completedBy: 'u-recv', storeId: 'store-1', at: AT, scanCount: 2, commandIds: ['c1', 'c2'], source: 'warehouse-handheld' }, undefined, 'store-1'); // the box's own store, as its credential says
    expect(done.status, JSON.stringify(done.body)).toBe(202);
    const grn = (done.body as { grn: { captured: { lines: { productId: string; sellableMinor: number; quarantinedMinor: number; disposition: string }[]; discrepancies: { kind: string }[] } } }).grn;
    expect(grn.captured.lines.map((l) => [l.sellableMinor, l.quarantinedMinor, l.disposition])).toEqual([[9, 0, 'sellable'], [0, 3, 'quarantine']]);
    const kinds = grn.captured.discrepancies.map((d) => d.kind);
    expect(kinds).toContain('mrp_mismatch');
    expect(kinds).toContain('qc_failed');
    expect(await onHand(ho)).toBe(9);

    // R5: the receipts list names the order by its number and the supplier by name.
    ho.restartCold();
    const list = await ho.ok('GET', '/v1/inventory/goods-receipt', 'u-owner');
    const row = (list['receipts'] as Record<string, unknown>[]).find((r) => r['grnId'] === 'grn-hh');
    expect(row?.['order']).toMatchObject({ supplierId: 'sup-lakshmi', supplierName: 'Lakshmi Agencies' });
    expect(String((row?.['order'] as Record<string, unknown>)['orderNumber'])).toMatch(/^PO/);
  }, 60_000);

  it('R7: the store pack\'s case sizes come from head office\'s pack ladders — exact, counted products only', async () => {
    const ho = await headOffice(backing, [{ userId: 'u-buyer', role: 'store_manager' }]);
    await ho.ok('POST', '/v1/catalogue/products/p-oil/pack', 'u-owner', { baseUom: 'each', levels: [{ level: 'each', containsMinor: 1 }, { level: 'case', containsMinor: 12 }] });
    await ho.ok('POST', '/v1/catalogue/products/p-soap/pack', 'u-owner', { baseUom: 'each', levels: [{ level: 'each', containsMinor: 1 }, { level: 'inner', containsMinor: 6 }, { level: 'case', containsMinor: 4 }] });
    await ho.ok('POST', '/v1/catalogue/products/p-rice/pack', 'u-owner', { baseUom: 'kg', levels: [{ level: 'kg', containsMinor: 1 }, { level: 'bag', containsMinor: 25 }] });
    ho.restartCold();
    expect(await casePacksFor({ store: ho.h.store, now: () => AT }, ho.tenantId)).toEqual({
      'p-oil': [{ level: 'case', units: 12 }],
      'p-soap': [{ level: 'inner', units: 6 }, { level: 'case', units: 24 }],
    });
  });
});
