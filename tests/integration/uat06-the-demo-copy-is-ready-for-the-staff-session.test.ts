// UAT-06 (the real-staff usability session, docs/design/usability-session-UAT-06.md, pages 3 and 4): the demo copy's
// practice data now holds what the manager's sheet B and the warehouse sheet C ask the staff to do — each laid down by the
// seed through head office's REAL routes under the named practice person's own sign-in, and each proven here through the
// same routes the screens call:
//   1. a practice login of the PLAIN warehouse role (`pilot-warehouse`, warehouse_user): it raises a stock adjustment from
//      the handheld (relayed by the store box), cannot approve it, and the store manager can (C7, SP-3b, §28);
//   2. a chilled practice product (Demo Curd 400g): active, its barcode, cold-chain 2–8 °C; a delivery carrying it needs the
//      receiving checklist (OB-164), and its opening stock was booked with the checklist and the arrival temperature (C3);
//   3. an ISSUED purchase order from Demo Foods Distributors, open for the warehouse to receive (B4 / C2);
//   4. exactly one approval waiting in the store manager's inbox that he did not raise (B2);
//   5. re-running all four seed steps lands nothing and refuses nothing.
// Synthetic data only, in the demo tenant (hard rule #7).

import { describe, it, expect, beforeAll } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { applyPilotFoundation, applyPilotCatalogue, applyPilotTradingPartners, applyPilotTransactions } from '../../db/seed/pilot/apply';
import {
  PILOT_FOUNDATION, PILOT_CATALOGUE, PILOT_TRADING_PARTNERS, PILOT_TRANSACTIONS, PILOT_DEMO_TENANT, PILOT_DEMO_BRANCH,
  PILOT_DEMO_WAREHOUSE, PILOT_DEMO_OPEN_PO, PILOT_DEMO_CHILLED_OPENING, PILOT_DEMO_RECEIVING_CHECK, PILOT_DEMO_PENDING_WRITE_OFF,
  PILOT_DEMO_TILL_PIN_HOLDERS,
} from '../../db/seed/pilot/dataset';
import { WAREHOUSE_USER_ROLE_ID, ROLE_CATALOGUE } from '../../services/api/src/roles';

const T = PILOT_DEMO_TENANT;
const OWNER = PILOT_FOUNDATION.genesisOwner.userId;
const WAREHOUSE = 'pilot-warehouse';
const MANAGER = 'pilot-manager';
const BOX = 'pilot-store-edge';
let h: ApiHarness;

const get = async (path: string, userId: string, query?: Record<string, string>) =>
  h.request({ method: 'GET', path, userId, tenantId: T, ...(query === undefined ? {} : { query }) });
const post = async (path: string, userId: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path, userId, tenantId: T, body, idempotencyKey: key });
const codeOf = (r: { body: unknown }): string | undefined => (r.body as { error?: { code?: string } }).error?.code;

beforeAll(async () => {
  h = apiHarness();
  for (const report of [
    await applyPilotFoundation(h, PILOT_FOUNDATION),
    await applyPilotCatalogue(h, PILOT_CATALOGUE, OWNER),
    await applyPilotTradingPartners(h, PILOT_TRADING_PARTNERS, OWNER),
    await applyPilotTransactions(h, PILOT_TRANSACTIONS, OWNER),
  ]) {
    expect(report.steps.filter((s) => !s.ok), JSON.stringify(report.steps.filter((s) => !s.ok))).toEqual([]);
  }
}, 120_000);

describe('UAT-06: the demo copy is ready for the real-staff session', () => {
  it('4. exactly one approval waits for the store manager — a material write-off he did not raise, worth ₹540 at head office\'s cost (B2)', async () => {
    // Run before any test here asks for approvals of its own, so the inbox is the seed's alone.
    const inbox = await get('/v1/approvals/requests', MANAGER);
    expect(inbox.status).toBe(200);
    const body = inbox.body as { waitingForMe: readonly { kind: string; subjectRef: string; requestedBy: string; status: string; summary: string; reason: string; valueMinor: number | null }[]; routedToOwnerAboveYourLimit: number };
    expect(body.waitingForMe).toHaveLength(1);
    const waiting = body.waitingForMe[0]!;
    expect(waiting).toMatchObject({ kind: 'stock_write_off', subjectRef: PILOT_DEMO_PENDING_WRITE_OFF, requestedBy: 'pilot-warehouse-supervisor', status: 'waiting', valueMinor: 54_000 });
    expect(waiting.requestedBy).not.toBe(MANAGER);
    expect(waiting.summary).toContain('(demo)');
    expect(waiting.reason).toContain('demo');
    expect(body.routedToOwnerAboveYourLimit).toBe(0);
    // The amount it carries is head office's own value of that loss — and it IS a material loss that needs a second person.
    const value = await get('/v1/inventory/write-off-value', 'pilot-warehouse-supervisor', { productId: 'prod-oil', locationId: PILOT_DEMO_WAREHOUSE, qty: '6', uom: 'ea' });
    expect(value.status, JSON.stringify(value.body)).toBe(200);
    expect(value.body).toMatchObject({ known: true, valueMinor: 54_000, material: true });
    // The person who asked cannot decide it (§28); it is left UNDECIDED by the seed.
    expect((await get('/v1/approvals/requests', 'pilot-warehouse-supervisor')).body).toMatchObject({ mine: [expect.objectContaining({ subjectRef: PILOT_DEMO_PENDING_WRITE_OFF, status: 'waiting' })] });
    // The plain warehouse login is not given it to decide: a write-off of money is above a limit its role never had.
    const warehouseInbox = (await get('/v1/approvals/requests', WAREHOUSE)).body as { waitingForMe: readonly unknown[]; routedToOwnerAboveYourLimit: number };
    expect(warehouseInbox.waitingForMe).toEqual([]);
  });

  it('1. pilot-warehouse is the plain warehouse role: it raises an adjustment from the handheld, cannot approve it, and the store manager can (C7)', async () => {
    expect(PILOT_FOUNDATION.users.find((u) => u.userId === WAREHOUSE)).toEqual({ userId: WAREHOUSE, displayName: 'Pilot Warehouse Staff (demo)', role: WAREHOUSE_USER_ROLE_ID });
    expect(PILOT_DEMO_TILL_PIN_HOLDERS).toContain(WAREHOUSE); // the handheld signs in with staff ID + till PIN
    const me = await get('/v1/identity/me', WAREHOUSE);
    expect(me.status, JSON.stringify(me.body)).toBe(200);
    // Head office holds exactly the warehouse role's words for this login — and never the approval.
    const role = ROLE_CATALOGUE.find((r) => r.id === WAREHOUSE_USER_ROLE_ID)!;
    expect([...(me.body as { permissions: readonly string[] }).permissions].sort()).toEqual([...new Set(role.permissions)].sort());
    expect((me.body as { permissions: readonly string[] }).permissions).not.toContain('inventory.adjustment.approve');

    // C7 on the handheld: the request is saved on the device and relayed by the store box — recorded PENDING, unflagged
    // (the raiser holds the movement permission), nothing moved.
    const id = 'ar-uat06-c7';
    const relayed = await post(`/v1/inventory/adjustment-requests/${id}/synced`, BOX, {
      requestId: id, productId: 'prod-biscuit', locationId: PILOT_DEMO_WAREHOUSE, binId: 'bin-demo-a1', deltaMinor: -1, uom: 'ea',
      reasonCode: 'damaged', note: 'torn packet (demo)', requestedBy: WAREHOUSE, at: new Date().toISOString(), storeId: PILOT_DEMO_BRANCH, source: 'warehouse-handheld',
    }, 'uat06-c7-relay');
    expect(relayed.status, JSON.stringify(relayed.body)).toBe(202);
    expect(relayed.body).toMatchObject({ status: 'pending', flags: [] });

    // The warehouse person cannot approve it — the role does not carry the approval at all.
    const self = await post(`/v1/inventory/adjustment-requests/${id}/decide`, WAREHOUSE, { decision: 'approved', reason: 'mine' }, 'uat06-c7-self');
    expect(self.status).toBe(403);
    // The store manager approves it on his own login; the correction posts once.
    const approved = await post(`/v1/inventory/adjustment-requests/${id}/decide`, MANAGER, { decision: 'approved', reason: 'seen the torn packet (demo)' }, 'uat06-c7-approve');
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body).toMatchObject({ status: 'posted', decidedBy: MANAGER, movementId: `adj-req:${id}` });

    // OB-623: a warehouse user asks from the HANDHELD (above); asking from the office page is not their kind of stock work,
    // so head office refuses it by name — the store manager raises an office correction.
    const office = await post('/v1/inventory/adjustment-requests/ar-uat06-office', WAREHOUSE, { productId: 'prod-soap', locationId: PILOT_DEMO_WAREHOUSE, uom: 'ea', deltaMinor: -1, reasonCode: 'damaged' }, 'uat06-office');
    expect(office.status).toBe(403);
    expect(codeOf(office)).toBe('not_your_kind_of_stock_movement');
  });

  it('2. Demo Curd 400g is active, scans by its barcode, is cold-chain 2–8 °C, and a delivery of it needs the receiving checklist (C3)', async () => {
    const curd = PILOT_CATALOGUE.products.find((p) => p.productId === 'prod-curd')!;
    expect(curd).toMatchObject({ sku: 'DEMO-CURD-400', name: 'Demo Curd 400g (demo)', baseUom: 'ea', primaryCategoryId: 'cat-food', handling: 'chilled', coldChain: { minTenthsC: 20, maxTenthsC: 80 } });
    const one = await get('/v1/catalogue/products/prod-curd', OWNER);
    expect(one.status).toBe(200);
    expect(JSON.stringify(one.body)).toContain('"lifecycle":"active"');
    expect(JSON.stringify(one.body)).toContain('"handling":"chilled"');
    expect(JSON.stringify(one.body)).toContain('"maxTenthsC":80');
    const scanned = await get('/v1/catalogue/barcodes/8900000000159', OWNER);
    expect(scanned.status, JSON.stringify(scanned.body)).toBe(200);
    expect(JSON.stringify(scanned.body)).toContain('prod-curd');

    // The store pack tells the warehouse handheld that curd is cold-chain and which checklist the dock asks for.
    const pack = await get(`/v1/store-packs/${PILOT_DEMO_BRANCH}`, BOX);
    expect(pack.status).toBe(200);
    const setup = (pack.body as { sections: { receivingChecklist?: { checks: readonly { checkId: string; minTenthsC?: number; maxTenthsC?: number }[]; coldChainProductIds: readonly string[] } } }).sections.receivingChecklist;
    expect(setup?.coldChainProductIds).toEqual(['prod-curd']);
    expect(setup?.checks.map((c) => [c.checkId, c.minTenthsC, c.maxTenthsC])).toEqual([[PILOT_DEMO_RECEIVING_CHECK, 20, 80]]);

    // A new delivery carrying curd, with no checklist on file, is refused by name — nothing booked.
    const refused = await post('/v1/inventory/goods-receipt/grn-uat06-no-checklist', OWNER, {
      warehouseId: PILOT_DEMO_WAREHOUSE, receivedOnDate: '2026-11-14', currency: 'INR',
      lines: [{ lineId: 'c1', productId: 'prod-curd', orderedMinor: 6, countedMinor: 6, uom: 'ea', unitCost: { minor: 3200, currency: 'INR' }, condition: 'good', batchId: 'B-UAT06', expiry: '2027-06-30', temperatureC: 4 }],
    }, 'uat06-grn-no-checklist');
    expect(refused.status).toBe(422);
    expect(codeOf(refused)).toBe('receiving_checklist_required');

    // The seeded chilled opening stock was booked WITH its checklist (by the supervisor) and its arrival temperature: 24 on hand.
    const opening = await get(`/v1/inventory/goods-receipt/${PILOT_DEMO_CHILLED_OPENING}`, OWNER);
    expect(opening.status).toBe(200);
    expect((opening.body as { grn: { receivingChecklist?: unknown } }).grn.receivingChecklist).toMatchObject({ recordId: `rc-${PILOT_DEMO_CHILLED_OPENING}`, outcome: 'pass', performedBy: 'pilot-warehouse-supervisor' });
    const avail = await get('/v1/inventory/availability', OWNER, { productId: 'prod-curd' });
    expect((avail.body as { rows: { onHandMinor: number }[] }).rows.reduce((s, r) => s + r.onHandMinor, 0)).toBe(24);
  });

  it('3. the purchase order from Demo Foods Distributors is ISSUED — proposed by the manager, issued by the owner — and open to receive (B4 / C2)', async () => {
    const one = await get(`/v1/purchase/orders/${PILOT_DEMO_OPEN_PO}`, OWNER);
    expect(one.status).toBe(200);
    const order = (one.body as { order: { status: string; supplierId: string; requisitionedBy: string; approvedBy: string; lines: readonly { productId: string; orderedQty: number }[] } }).order;
    expect(order).toMatchObject({ status: 'issued', supplierId: 'sup-demo-foods', requisitionedBy: MANAGER, approvedBy: OWNER });
    expect(order.lines.map((l) => [l.productId, l.orderedQty])).toEqual([['prod-rice', 10], ['prod-biscuit', 12], ['prod-oil', 6], ['prod-curd', 12]]);
    // What the warehouse phone and the store pack read: the delivery the store is waiting for, every line still open.
    const open = await get('/v1/purchase/deliveries/open', MANAGER, { storeId: PILOT_DEMO_BRANCH });
    expect(open.status, JSON.stringify(open.body)).toBe(200);
    const delivery = (open.body as { deliveries: readonly { poId: string; supplierId: string; lines: readonly { productId: string; openQty: number }[] }[] }).deliveries.find((d) => d.poId === PILOT_DEMO_OPEN_PO);
    expect(delivery?.supplierId).toBe('sup-demo-foods');
    expect(delivery?.lines.map((l) => [l.productId, l.openQty])).toEqual([['prod-rice', 10], ['prod-biscuit', 12], ['prod-oil', 6], ['prod-curd', 12]]);
    const pack = await get(`/v1/store-packs/${PILOT_DEMO_BRANCH}`, BOX);
    expect(JSON.stringify((pack.body as { sections: { purchaseOrders?: unknown } }).sections.purchaseOrders)).toContain(PILOT_DEMO_OPEN_PO);
  });

  it('5. re-running all four seed steps reports every step ok and lands nothing new', async () => {
    const before = (await h.store.exportTenant(T)).length;
    for (const report of [
      await applyPilotFoundation(h, PILOT_FOUNDATION),
      await applyPilotCatalogue(h, PILOT_CATALOGUE, OWNER),
      await applyPilotTradingPartners(h, PILOT_TRADING_PARTNERS, OWNER),
      await applyPilotTransactions(h, PILOT_TRANSACTIONS, OWNER),
    ]) expect(report.steps.filter((s) => !s.ok), JSON.stringify(report.steps.filter((s) => !s.ok))).toEqual([]);
    expect((await h.store.exportTenant(T)).length).toBe(before);
    const inbox = await get('/v1/approvals/requests', MANAGER);
    expect((inbox.body as { waitingForMe: readonly { subjectRef: string }[] }).waitingForMe.filter((r) => r.subjectRef === PILOT_DEMO_PENDING_WRITE_OFF)).toHaveLength(1);
    const orders = await get('/v1/purchase/orders', OWNER);
    expect((orders.body as { orders: readonly { poId?: string; id?: string }[] }).orders.filter((o) => (o.poId ?? o.id) === PILOT_DEMO_OPEN_PO)).toHaveLength(1);
  }, 120_000);
});
