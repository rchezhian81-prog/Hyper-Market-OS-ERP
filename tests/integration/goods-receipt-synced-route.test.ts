import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { approvedSuppliers, deliveryPlaces } from '../support/approved-supplier';
import { STREAM } from '../../services/api/src/adapters';
import { makeEvent } from '../../packages/contracts/src/event';
import { RECEIPT_FLAGS, DEFAULT_RECEIPT_POLICY } from '../../services/inventory/src/goods-receipt-synced';

/**
 * **A delivery booked in on the manager's screen becomes a trusted cloud GRN — with the receiver re-verified and every
 * judgement head office's own (SP-2b · F11 · M07-FR-01/02 · §28 · hard rules #2/#4/#10, API-04).**
 *
 * The store box relays the receipt under its sync credential (`inventory.receipt.sync`). This drives the real surface:
 * the GRN and its `received` movements are committed as one append and read back; the RECEIVER is the person named
 * on the screen and the relay is recorded beside them; the batch rule comes from the published catalogue, the unit
 * cost from the cloud's valuation, the ordered quantity from the purchase order, the tolerance from the (absent)
 * tenant policy — each unknown SAID as a flag, never a silent zero; a tracked line with no batch is 422 and nothing
 * is saved; the same GRN again is 200 and stock does not double; a credential without the permission is refused.
 * Synthetic data throughout (hard rule #7).
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const AT = '2026-09-30T10:00:00.000Z';
const WH = 'wh-store';
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

interface GrnBody {
  grn: {
    grnId: string; poId: string | null; receivedBy: string; relayedBy?: string; source?: string; storeId?: string | null;
    availableMinor: number; governanceFlags?: string[];
    captured: { requiresApproval: boolean; discrepancies: { kind: string }[]; lines: { sellableMinor: number; disposition: string }[] };
  };
  flags: string[];
  alreadyReceived?: boolean;
}

const receipt = (over: Record<string, unknown> = {}) => ({
  grnId: 'g1', number: 'DN-1001', poId: 'po-1', lineCount: 1, warehouseId: WH, receivedBy: 'u-mgr', receivedAt: AT,
  lines: [{ productId: 'p1', quantityMinor: 100, uom: 'ea', batchId: null }],
  storeId: 'store-1', source: 'manager-screen', ...over,
});

const relay = (h: ApiHarness, body: Record<string, unknown>, key: string, opts: { user?: string; tenant?: string; id?: string } = {}) =>
  h.request({
    method: 'POST', path: `/v1/inventory/goods-receipt/${opts.id ?? String(body['grnId'])}/synced`,
    userId: opts.user ?? 'u-box', tenantId: opts.tenant ?? A, idempotencyKey: key, body,
  });
const readGrn = (h: ApiHarness, grnId: string) =>
  h.request({ method: 'GET', path: `/v1/inventory/goods-receipt/${grnId}`, userId: 'u-owner', tenantId: A });
const onHand = async (h: ApiHarness, productId: string, locationId = WH): Promise<number> => {
  const res = await h.request({ method: 'GET', path: '/v1/inventory/availability', userId: 'u-owner', tenantId: A, query: { productId } });
  return ((res.body as { rows: { locationId: string; onHandMinor: number }[] }).rows).filter((r) => r.locationId === locationId).reduce((s, r) => s + r.onHandMinor, 0);
};
const valuation = async (h: ApiHarness, productId: string) =>
  ((await h.request({ method: 'GET', path: '/v1/inventory/valuation', userId: 'u-owner', tenantId: A, query: { productId } })).body as { rows: { locationId: string; onHandMinor: number; value: { minor: number } }[] }).rows;

/** The cast, the product master (p1 untracked, p2 batch-tracked), a costed prior delivery of p1, and a purchase order. */
async function seeded(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await approvedSuppliers(h, A, 'sup-1'); // OB-32: an order needs an approved supplier
  await deliveryPlaces(h, A, 'wh-store'); // OB-37: an order names the store it is delivered to
  await h.provisionRole(A, 'u-mgr', 'store_manager'); // holds inventory.movement.append — may receive goods
  await h.provisionRole(A, 'u-box', 'store_computer');       // the store box's sync identity: inventory.receipt.sync
  await h.provisionRole(A, 'u-cust', 'customer');     // no inventory authority at all
  await h.store.append(A, STREAM.catalogue, makeEvent({
    id: `pack-${A}-1`, type: 'CataloguePublished', occurredAt: AT, idempotencyKey: `catalogue-${A}-v1`, source: 'test/catalogue',
    payload: {
      snapshot: {
        tenantId: A, version: 1, builtAt: AT, scope: { tenantId: A, storeId: 'store-1' },
        products: [
          { productId: 'p1', sku: 'p1', name: 'Toor dal 1kg', unitPriceMinor: 16_000, taxBps: 0, status: 'active', uom: 'ea', batchTracked: false, handling: 'ambient' },
          { productId: 'p2', sku: 'p2', name: 'Fresh paneer 200g', unitPriceMinor: 9_000, taxBps: 500, status: 'active', uom: 'ea', batchTracked: true },
        ],
        barcodes: [],
      },
    },
  }));
  // The cloud's own cost for p1: an earlier direct GRN at ₹50.00 a unit (the weighted average the route will read).
  const seed = await h.request({
    method: 'POST', path: '/v1/inventory/goods-receipt/grn-seed', userId: 'u-mgr', tenantId: A, idempotencyKey: 'k-seed',
    body: {
      warehouseId: WH, receivedOnDate: '2026-09-01', currency: 'INR',
      lines: [{ lineId: 'L1', productId: 'p1', orderedMinor: 40, countedMinor: 40, uom: 'ea', unitCost: { minor: 5000, currency: 'INR' }, condition: 'good' }],
    },
  });
  expect(seed.status).toBe(201);
  // What the buyer ORDERED — the figure the route compares the delivery against, never the body's — ISSUED by a second
  // person (the manager proposes, the owner approves), so the receipt folds into it (SP-6 · F01).
  const po = await h.request({
    method: 'POST', path: '/v1/purchase/orders/po-1', userId: 'u-mgr', tenantId: A, idempotencyKey: 'k-po-1',
    body: { supplierId: 'sup-1', deliverToLocationId: 'wh-store', lines: [{ productId: 'p1', orderedQty: 100, unitCost: { minor: 5000, currency: 'INR' } }] },
  });
  expect(po.status).toBe(201);
  expect((await h.request({ method: 'POST', path: '/v1/purchase/orders/po-1/approval', userId: 'u-owner', tenantId: A, idempotencyKey: 'k-po-1-ok', body: { reason: 'within budget' } })).status).toBe(200);
  return h;
}
const orderOf = async (h: ApiHarness, poId: string) =>
  (await h.request({ method: 'GET', path: `/v1/purchase/orders/${poId}`, userId: 'u-owner', tenantId: A })).body as { order: { receivedByProduct: Record<string, number> }; openCommitment: { totalOpenValue: { minor: number }; fullyReceived: boolean } | null };

describe('a receipt relayed from the store becomes a cloud GRN, with the receiver re-verified and the rules head office\'s own', () => {
  it('records a clean delivery against its order: GRN + received movements in one append, receiver and relay named, stock and value up, and it reads back', async () => {
    const h = await seeded();
    expect(await onHand(h, 'p1')).toBe(40);

    const res = await relay(h, receipt(), 'k-g1');
    expect(res.status).toBe(202);
    const body = res.body as GrnBody;
    // The one honest flag: no tenant receiving policy exists yet (F03 → SP-4), so the default applied and SAID so.
    expect(body.flags).toEqual(['default_policy']);
    expect(body.grn).toMatchObject({
      grnId: 'g1', poId: 'po-1', receivedBy: 'u-mgr', relayedBy: 'u-box', source: 'manager-screen', storeId: 'store-1', availableMinor: 100,
    });
    expect(body.grn.captured.discrepancies).toEqual([]);
    expect(body.grn.captured.lines[0]).toMatchObject({ sellableMinor: 100, disposition: 'sellable' });

    // Stock rose by exactly the delivery, at the store's warehouse, valued at the cloud's own cost (₹50.00 → ₹70.00 total).
    expect(await onHand(h, 'p1')).toBe(140);
    await expect(valuation(h, 'p1')).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ locationId: WH, onHandMinor: 140, value: { minor: 700_000, currency: 'INR' } })]));

    const read = await readGrn(h, 'g1');
    expect(read.status).toBe(200);
    expect((read.body as GrnBody).grn).toMatchObject({ grnId: 'g1', receivedBy: 'u-mgr', relayedBy: 'u-box', governanceFlags: ['default_policy'] });

    // SP-6 (F01): the relayed receipt folded into the order in the same append — 100 ordered, 100 received, nothing open.
    expect((res.body as { poReceipt: unknown }).poReceipt).toEqual({ receiptId: 'g1', receivedByProduct: { p1: 100 } });
    const po = await orderOf(h, 'po-1');
    expect(po.order.receivedByProduct).toEqual({ p1: 100 });
    expect(po.openCommitment).toMatchObject({ totalOpenValue: { minor: 0 }, fullyReceived: true });
  });

  it('measures the delivery against the ORDER head office holds — a short delivery is a valued discrepancy on the record, not a silent acceptance', async () => {
    const h = await seeded();
    const res = await relay(h, receipt({ lines: [{ productId: 'p1', quantityMinor: 90, uom: 'ea', batchId: null }] }), 'k-g1');
    expect(res.status).toBe(202);
    const body = res.body as GrnBody;
    expect(body.grn.availableMinor).toBe(90);
    expect(body.grn.captured.discrepancies.map((d) => d.kind)).toContain('short');
    expect(await onHand(h, 'p1')).toBe(130);
    // …and the order shows the 10 still outstanding (SP-6 · F01).
    const po = await orderOf(h, 'po-1');
    expect(po.order.receivedByProduct).toEqual({ p1: 90 });
    expect(po.openCommitment).toMatchObject({ totalOpenValue: { minor: 50_000 }, fullyReceived: false });
  });

  it('flags — never rejects — what it could not verify: no order, an unknown order, an unknown product, an unknown or unauthorised receiver', async () => {
    const h = await seeded();
    const noOrder = await relay(h, receipt({ grnId: 'g2', poId: null }), 'k-g2');
    expect(noOrder.status).toBe(202);
    expect((noOrder.body as GrnBody).flags).toEqual(['no_purchase_order', 'default_policy']);

    const badOrder = await relay(h, receipt({ grnId: 'g3', poId: 'po-nobody-raised' }), 'k-g3');
    expect(badOrder.status).toBe(202);
    expect((badOrder.body as GrnBody).flags).toEqual(['order_unknown', 'default_policy']);
    // Ordered is unknown, so the delivery is received as-is — no invented shortage against an order nobody holds.
    expect((badOrder.body as GrnBody).grn.captured.discrepancies).toEqual([]);
    expect((badOrder.body as { poReceipt: unknown }).poReceipt).toBeNull(); // and it folds into nothing (SP-6)
    // An order that is only PROPOSED is not a commitment yet: said, and folded into nothing.
    await h.request({ method: 'POST', path: '/v1/purchase/orders/po-draft', userId: 'u-mgr', tenantId: A, idempotencyKey: 'k-po-draft',
      body: { supplierId: 'sup-1', deliverToLocationId: 'wh-store', lines: [{ productId: 'p1', orderedQty: 100, unitCost: { minor: 5000, currency: 'INR' } }] } });
    const draft = await relay(h, receipt({ grnId: 'g3b', poId: 'po-draft' }), 'k-g3b');
    expect((draft.body as GrnBody).flags).toEqual(['order_not_issued', 'default_policy']);
    expect((await orderOf(h, 'po-draft')).order.receivedByProduct).toEqual({});

    // A product not on the published master: received untracked and UNVALUED (said), never refused at the back door.
    const unknownProduct = await relay(h, receipt({ grnId: 'g4', poId: null, lines: [{ productId: 'p-new', quantityMinor: 5, uom: 'ea', batchId: null }] }), 'k-g4');
    expect(unknownProduct.status).toBe(202);
    expect((unknownProduct.body as GrnBody).flags).toEqual(['no_purchase_order', 'product_rules_unverified', 'handling_unknown', 'cost_unknown', 'default_policy']);
    expect(await onHand(h, 'p-new')).toBe(5);
    const v = (await valuation(h, 'p-new')).find((r) => r.locationId === WH) as { unitCostMinor?: unknown } | undefined;
    expect(v?.unitCostMinor).toBe('not_known'); // not ₹0 — the valuation says it does not know

    const lacks = await relay(h, receipt({ grnId: 'g5', receivedBy: 'u-cust' }), 'k-g5');
    expect((lacks.body as GrnBody).flags).toContain('receiver_lacks_authority');
    expect((lacks.body as GrnBody).grn.receivedBy).toBe('u-cust'); // recorded as who the screen named — the flag is the control
    const unknown = await relay(h, receipt({ grnId: 'g6', receivedBy: 'u-nobody' }), 'k-g6');
    expect((unknown.body as GrnBody).flags).toContain('receiver_unknown');

    for (const f of [noOrder, badOrder, unknownProduct, lacks, unknown].flatMap((r) => (r.body as GrnBody).flags)) expect(RECEIPT_FLAGS).toContain(f);
    expect(DEFAULT_RECEIPT_POLICY).toEqual({ excessToleranceBp: 0, shortageToleranceBp: 0, nearExpiryDays: 30 });
  });

  it('refuses a batch-tracked line with no batch — 422, nothing saved, stock unchanged — the same rule the dock runs (M10)', async () => {
    const h = await seeded();
    const res = await relay(h, receipt({ grnId: 'g7', poId: null, lines: [{ productId: 'p2', quantityMinor: 20, uom: 'ea', batchId: null }] }), 'k-g7');
    expect(res.status).toBe(422);
    expect(codeOf(res)).toBe('receipt_line_incomplete');
    expect((res.body as { error: { wasItSaved: string } }).error.wasItSaved).toBe('not_saved');
    expect((await readGrn(h, 'g7')).status).toBe(404);
    expect(await onHand(h, 'p2')).toBe(0);
  });

  it('the same receipt again — same key or a re-minted key — is 200 alreadyReceived, and stock is counted ONCE (§31.1)', async () => {
    const h = await seeded();
    expect((await relay(h, receipt(), 'k-g1')).status).toBe(202);
    const replay = await relay(h, receipt(), 'k-g1');
    expect(replay.status).toBeGreaterThanOrEqual(200);
    expect(replay.status).toBeLessThan(300);
    const rekeyed = await relay(h, receipt(), 'k-g1-again');
    expect(rekeyed.status).toBe(200);
    expect((rekeyed.body as GrnBody).alreadyReceived).toBe(true);
    expect((rekeyed.body as GrnBody).flags).toEqual(['default_policy']);
    expect(await onHand(h, 'p1')).toBe(140);
  });

  it('refuses a payload it cannot read, a grnId that does not match the path, a caller without the sync permission, and a tenant it was not issued for', async () => {
    const h = await seeded();
    const malformed = await relay(h, { grnId: 'g8', lines: 'nope' }, 'k-g8');
    expect(malformed.status).toBe(400);
    expect(codeOf(malformed)).toBe('not_readable_as_a_relayed_receipt');
    const mismatch = await relay(h, receipt({ grnId: 'g9' }), 'k-g9', { id: 'g10' });
    expect(mismatch.status).toBe(400);
    const noPermission = await relay(h, receipt({ grnId: 'g11' }), 'k-g11', { user: 'u-cust' });
    expect(noPermission.status).toBe(403);
    const otherTenant = await relay(h, receipt({ grnId: 'g12' }), 'k-g12', { tenant: B });
    expect(otherTenant.status).toBe(403);
    expect((await readGrn(h, 'g11')).status).toBe(404);
    expect(await onHand(h, 'p1')).toBe(40);
  });
});
