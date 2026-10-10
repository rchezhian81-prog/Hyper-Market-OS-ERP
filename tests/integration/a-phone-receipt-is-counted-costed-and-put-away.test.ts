import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { approvedSuppliers } from '../support/approved-supplier';
import { STREAM } from '../../services/api/src/adapters';

/**
 * **Found by the final store acceptance (round 4) and fixed — the in-memory proof beside the connected journey
 * (`store-acceptance-journey.test.ts`, real PostgreSQL + the real store computer).**
 *
 *   1. OB-31 "A": a receiving scan from the warehouse phone for a KILOGRAM product is recorded in the product master's unit
 *      (grams), not the phone's default 'EA' — and the difference is said (`unit_from_master`), never silently corrected.
 *   2. M07-FR-02: a scan against an ISSUED order posts its stock at the cost that order agreed (head office's own record,
 *      never the body), so phone-received stock is valued; a scan with no order stays uncosted, as before.
 *   3. M09-FR-01: head office's warehouse section for the store's phone carries "goods in" — what is on hand at the back store
 *      and in no bin yet — so the person who puts away need not be the person who received.
 *   4. OB-36 "A": the owner's day-close list shows head office's re-check of the person the store named as the closer
 *      (`closeFlags`, `flaggedCloses`) — it was recorded but dropped from the list.
 *
 * Synthetic data only; a fresh random tenant per test (hard rule #7).
 */

const STORE = 'S1';
const BACK = 'S1-BACK';
type Reply = { status: number; body: unknown };

async function shop(): Promise<{ h: ApiHarness; t: string; call: (m: 'GET' | 'POST', path: string, u: string, body?: unknown, key?: string) => Promise<Reply> }> {
  const h = apiHarness();
  const t = randomUUID();
  const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, idempotencyKey?: string): Promise<Reply> => {
    const [pathname, search] = path.split('?');
    const query = search === undefined ? undefined : Object.fromEntries(new URLSearchParams(search));
    return h.request({ method, path: pathname!, userId, tenantId: t, ...(query === undefined ? {} : { query }), ...(body === undefined ? {} : { body }), ...(idempotencyKey === undefined ? {} : { idempotencyKey }) });
  };
  await h.seedOwner(t, 'u-owner');
  await h.provisionRole(t, 'u-buyer', 'store_manager');
  await h.provisionRole(t, 'u-recv', 'store_manager');
  await h.provisionRole(t, 'u-cash', 'cashier');
  await h.provisionRole(t, 'u-box', 'store_computer');
  for (const [id, body] of [
    ['C1', { kind: 'company', name: 'SRE Retail' }],
    [STORE, { kind: 'branch', name: 'SRE Hyper Market', parentId: 'C1', companyId: 'C1' }],
    [BACK, { kind: 'warehouse', name: 'Back store', parentId: STORE, companyId: 'C1' }],
  ] as const) expect((await call('POST', `/v1/org/nodes/${id}`, 'u-owner', body, `org-${id}`)).status).toBe(201);
  expect((await call('POST', `/v1/stores/${STORE}/settings`, 'u-owner', { tradingDayCutoff: '00:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 5_000, cashVarianceToleranceMinor: 5_000, privacySlaDays: 30, warehouseId: BACK }, 'settings')).status).toBe(201);
  expect((await call('POST', '/v1/catalogue/tax-classes/0702/rates/2017-07-01', 'u-owner', { rateBps: 0 }, 'tax')).status).toBe(201);
  expect((await call('POST', '/v1/catalogue/products/p-tom/publish', 'u-owner', {
    product: { sku: 'TOM', name: 'Tomato (loose)', baseUom: 'kg', primaryCategoryId: 'veg', taxClass: '0702', lifecycle: 'active' },
    categories: [{ categoryId: 'veg', name: 'Vegetables', parentId: null }],
  }, 'publish')).status).toBe(201);
  await approvedSuppliers(h, t, 'sup-1');
  expect((await call('POST', '/v1/purchase/orders/po-1', 'u-buyer', { supplierId: 'sup-1', deliverToLocationId: BACK, lines: [{ productId: 'p-tom', orderedQty: 10_000, unitCost: { minor: 2_500, currency: 'INR' } }] }, 'po')).status).toBe(201);
  expect((await call('POST', '/v1/purchase/orders/po-1/approval', 'u-owner', { reason: 'stock' }, 'po-ok')).status).toBe(200);
  return { h, t, call };
}

/** A receiving scan as the box relays it from the phone — the phone fills 'EA' because it does not know the unit. */
const scan = (commandId: string, over: Record<string, unknown> = {}) => ({
  commandId, grnId: 'grn-po-1-1', productId: 'p-tom', batchId: null, quantityMinor: 9_500, uom: 'EA', source: 'po', poId: 'po-1',
  state: 'on_hand', expiry: null, receivedBy: 'u-recv', storeId: BACK, at: new Date().toISOString(), ...over,
});

describe('a phone receipt is counted in the product\'s unit, costed at the order\'s price, and waits for put-away at head office', () => {
  it('records 9500 g of a kg product as kg (said: unit_from_master), valued 9500 × ₹25/kg ÷ 1000 = ₹237.50, and lists it as goods in', async () => {
    const { call } = await shop();
    const res = await call('POST', '/v1/inventory/receiving-scans/c-1/synced', 'u-box', scan('c-1'), 'scan-1');
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect((res.body as { flags: string[] }).flags).toContain('unit_from_master');
    const scans = ((await call('GET', '/v1/inventory/receiving-scans?grnId=grn-po-1-1', 'u-owner')).body as { scans: { uom: string }[] }).scans;
    expect(scans.map((s) => s.uom)).toEqual(['kg']);
    const value = ((await call('GET', '/v1/inventory/valuation?productId=p-tom', 'u-owner')).body as { rows: { locationId: string; value: { minor: number } }[] }).rows;
    expect(value.find((r) => r.locationId === BACK)?.value.minor).toBe(23_750);
    // The phone's put-away list comes from head office: on hand at the back store, in no bin.
    const pack = (await call('GET', `/v1/store-packs/${STORE}`, 'u-owner')).body as { sections: { warehouse: { goodsIn: unknown[] } } };
    expect(pack.sections.warehouse.goodsIn).toEqual([{ productId: 'p-tom', batchId: null, quantityMinor: 9_500, uom: 'kg', state: 'on_hand', expiry: null }]);
    // Once binned, it is no longer "goods in".
    expect((await call('POST', '/v1/warehouse/bins/B-1', 'u-owner', { storeId: BACK, capacityMinor: 100_000, pickable: true, locationId: BACK }, 'bin')).status).toBe(201);
    expect((await call('POST', '/v1/warehouse/movements/pa-1', 'u-recv', { kind: 'put_away', storeId: BACK, productId: 'p-tom', batchId: null, quantityMinor: 9_500, uom: 'kg', fromBinId: null, toBinId: 'B-1' }, 'pa')).status).toBe(201);
    const after = (await call('GET', `/v1/store-packs/${STORE}`, 'u-owner')).body as { sections: { warehouse: { goodsIn: unknown[] } } };
    expect(after.sections.warehouse.goodsIn).toEqual([]);
  });

  it('a scan that names the right unit is not flagged; a scan against no order stays uncosted (as before), and says nothing new', async () => {
    const { h, t, call } = await shop();
    const named = await call('POST', '/v1/inventory/receiving-scans/c-2/synced', 'u-box', scan('c-2', { uom: 'KG' }), 'scan-2');
    expect((named.body as { flags: string[] }).flags).not.toContain('unit_from_master');
    const loose = await call('POST', '/v1/inventory/receiving-scans/c-3/synced', 'u-box', scan('c-3', { grnId: 'grn-dsd', poId: null, uom: 'kg', quantityMinor: 1_000 }), 'scan-3');
    expect(loose.status).toBe(202);
    const moves = (await h.store.readStream(t, STREAM.inventory, { type: 'InventoryMoved' })).map((e) => e.event.payload as { movementId: string; uom: string; unitCostMinor?: number });
    expect(moves.find((m) => m.movementId === 'recv:grn-po-1-1:c-2')).toMatchObject({ uom: 'kg', unitCostMinor: 2_500 });
    const dsd = moves.find((m) => m.movementId === 'recv:grn-dsd:c-3');
    expect(dsd).toMatchObject({ uom: 'kg' });
    expect(dsd?.unitCostMinor).toBeUndefined();
  });

  it('the owner\'s day-close list shows a close named under someone without day-close authority (OB-36) — closeFlags and flaggedCloses', async () => {
    const { call } = await shop();
    const close = (id: string, closedBy: string, day: string) => call('POST', `/v1/pos/day-close/${id}/synced`, 'u-box', { storeId: STORE, tradingDay: day, closedBy, closedAt: new Date().toISOString() }, id);
    expect((await close('dc-1', 'u-owner', '2026-10-01')).status).toBe(202);
    expect((await close('dc-2', 'u-cash', '2026-10-02')).status).toBe(202);
    const list = (await call('GET', '/v1/pos/day-close', 'u-owner')).body as { dayCloses: { dayCloseId: string; closeFlags: string[] }[]; flaggedCloses: { dayCloseId: string; closedBy: string; closeFlags: string[] }[] };
    expect(list.dayCloses.map((d) => [d.dayCloseId, d.closeFlags])).toEqual([['dc-1', []], ['dc-2', ['closer_lacks_authority']]]);
    expect(list.flaggedCloses).toEqual([{ dayCloseId: 'dc-2', tradingDay: '2026-10-02', closedBy: 'u-cash', closeFlags: ['closer_lacks_authority'] }]);
  });
});
