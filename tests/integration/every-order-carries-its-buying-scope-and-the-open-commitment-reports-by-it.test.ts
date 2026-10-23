import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { useRestartableBackings } from '../support/p3-backings';
import { P3, p3Shop, caller, received } from '../support/p3-purchase';

// M06-FR-04 "Central/local procurement … open-commitment tracking" (OB-288 P3). OB-289 (owner, 23 Oct 2026, D-6 "Both, per
// order"): every purchase order carries central-via-warehouse, central-direct-to-store or local; a central order is head
// office's, a local one a store's. OB-290 (D-3): a local order is capped by the raiser's role limit — store manager ₹25,000,
// owner unlimited (the config default behind package P1's seam). The open-commitment report groups by scope, supplier and
// store, and reconciles to the receipts. In memory and — with DATABASE_URL — on real PostgreSQL, with a cold restart.

const backings = useRestartableBackings();
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
const LOCAL = 'u-local'; // a store manager whose authority is store-1 only
const line = (qty: number, unitMinor: number) => [{ productId: 'rice', orderedQty: qty, unitCost: { minor: unitMinor, currency: 'INR' } }];
type Order = { buyingScope: string; buyingScopeSource: string; status: string };
interface Report { byScope: { key: string; orders: number; openValueMinor: number }[]; byStore: { key: string; openValueMinor: number }[]; totalOpenMinor: number; lines: { poId: string; buyingScope: string; openQty: number; receivedQty: number; cancelledQty: number; agrees: boolean; receipts: { receiptId: string; quantity: number }[] }[]; receiptsDisagree: unknown[]; issuedOrders: number }

describe.each(backings)('buying scope per order and the open-commitment report (M06-FR-04 · OB-289/OB-290) — on $name', ({ harness }) => {
  it('derives or checks the scope, caps local buying by the raiser\'s limit, and reports open commitments by scope; a restart reads the same', async () => {
    const h = harness();
    const T = randomUUID();
    await p3Shop(h, T);
    const call = caller(h, T);
    expect((await call('POST', '/v1/org/nodes/wh-central', 'u-org-setup', { kind: 'warehouse', name: 'Head office warehouse', parentId: 'C-FIXTURE', companyId: 'C-FIXTURE' })).status).toBeLessThan(300);
    await h.provisionRole(T, LOCAL, 'store_manager', [P3.STORE]);
    // A store-scoped person works inside their store (the request names it, as their screen does).
    const propose = (poId: string, userId: string, body: Record<string, unknown>) => h.request({
      method: 'POST', path: `/v1/purchase/orders/${poId}`, userId, tenantId: T, idempotencyKey: `p-${poId}-${JSON.stringify(body).length}`,
      ...(userId === LOCAL ? { branchId: P3.STORE } : {}), body: { supplierId: 'sup-1', ...body },
    });
    const order = async (poId: string): Promise<Order> => ((await call('GET', `/v1/purchase/orders/${poId}`, P3.OWNER)).body as { order: Order }).order;

    // Head office (company-wide) — derived from where the goods go.
    expect((await propose('po-direct', P3.OWNER, { deliverToLocationId: P3.STORE, lines: line(10, 10_000) })).status).toBe(201);
    expect(await order('po-direct')).toMatchObject({ buyingScope: 'central_direct_to_store', buyingScopeSource: 'derived' });
    expect((await propose('po-wh', P3.BUYER, { deliverToLocationId: 'wh-central', lines: line(100, 10_000) })).status).toBe(201);
    expect(await order('po-wh')).toMatchObject({ buyingScope: 'central_via_warehouse' });
    // Named — and checked against who buys and where it goes.
    expect(codeOf(await propose('po-bad1', P3.OWNER, { buyingScope: 'central_via_warehouse', deliverToLocationId: P3.STORE, lines: line(1, 1) }))).toBe('central_via_warehouse_needs_a_warehouse');
    expect(codeOf(await propose('po-bad2', P3.OWNER, { buyingScope: 'local', deliverToLocationId: 'wh-central', lines: line(1, 1) }))).toBe('scope_delivers_to_a_store');
    expect(codeOf(await propose('po-bad3', P3.OWNER, { buyingScope: 'regional', deliverToLocationId: P3.STORE, lines: line(1, 1) }))).toBe('unknown_buying_scope');
    expect((await propose('po-own-local', P3.OWNER, { buyingScope: 'local', deliverToLocationId: P3.STORE, lines: line(1_000, 10_000) })).status).toBe(201); // the owner: unlimited

    // A store-scoped manager buys LOCALLY only, within ₹25,000 an order.
    expect(codeOf(await propose('po-l0', LOCAL, { buyingScope: 'central_direct_to_store', deliverToLocationId: P3.STORE, lines: line(1, 1) }))).toBe('central_buying_is_head_offices');
    expect(codeOf(await propose('po-l1', LOCAL, { deliverToLocationId: P3.STORE, lines: line(1, 2_500_001) }))).toBe('local_limit_exceeded');
    expect((await propose('po-l2', LOCAL, { deliverToLocationId: P3.STORE, lines: line(250, 10_000) })).status).toBe(201); // exactly ₹25,000
    expect(await order('po-l2')).toMatchObject({ buyingScope: 'local', buyingScopeSource: 'derived' });

    await h.provisionRole(T, 'u-owner2', 'owner'); // the second person for the owner's own orders (§28)
    for (const poId of ['po-direct', 'po-wh', 'po-own-local', 'po-l2']) expect((await call('POST', `/v1/purchase/orders/${poId}/approval`, 'u-owner2', { reason: 'synthetic' })).status).toBe(200);
    // Raising a local order past its raiser's limit by amendment is refused.
    expect(codeOf(await call('POST', '/v1/purchase/orders/po-l2/amendments', P3.OWNER, { amendmentId: 'a1', reason: 'more', lines: line(251, 10_000) }))).toBe('local_limit_exceeded');

    // Movement on the commitments: 60 of the 100 for the warehouse arrive (booked there by head office's receiver); 50 of the
    // local 250 are cancelled.
    await h.provisionRole(T, 'u-wh-recv', 'store_manager');
    expect((await call('POST', '/v1/inventory/goods-receipt/grn-wh', 'u-wh-recv', { warehouseId: 'wh-central', receivedOnDate: '2026-10-20', currency: 'INR', poId: 'po-wh', lines: [{ lineId: 'L1', productId: 'rice', orderedMinor: 100, countedMinor: 60, uom: 'ea', unitCost: { minor: 10_000, currency: 'INR' }, condition: 'good' }] })).status).toBe(201);
    expect((await call('POST', '/v1/purchase/orders/po-l2/cancellations', P3.OWNER, { cancellationId: 'c1', reason: 'shelf full', cancelledByProduct: { rice: 50 } })).status).toBe(200);
    await received(call, 'grn-direct', 'po-direct', [{ productId: 'rice', qty: 10, unitMinor: 10_000 }]);

    const report = (await call('GET', '/v1/purchase/commitments/report', P3.OWNER)).body as Report;
    expect(report.issuedOrders).toBe(4);
    expect(report.byScope).toEqual([
      { key: 'central_direct_to_store', orders: 1, lines: 1, openValueMinor: 0 },
      { key: 'central_via_warehouse', orders: 1, lines: 1, openValueMinor: 40 * 10_000 },
      { key: 'local', orders: 2, lines: 2, openValueMinor: 1_000 * 10_000 + 200 * 10_000 },
    ]);
    expect(report.totalOpenMinor).toBe(400_000 + 10_000_000 + 2_000_000);
    expect(report.lines.find((l) => l.poId === 'po-wh')).toMatchObject({ receivedQty: 60, openQty: 40, agrees: true, receipts: [{ receiptId: 'grn-wh', quantity: 60 }] });
    expect(report.lines.find((l) => l.poId === 'po-l2')).toMatchObject({ cancelledQty: 50, openQty: 200 });
    expect(report.receiptsDisagree).toEqual([]);
    // Narrowed by scope; and a store-scoped reader sees only the orders delivered to their store.
    expect(((await h.request({ method: 'GET', path: '/v1/purchase/commitments/report', userId: P3.OWNER, tenantId: T, query: { buyingScope: 'local' } })).body as Report).byScope.map((g) => g.key)).toEqual(['local']);
    const mine = (await h.request({ method: 'GET', path: '/v1/purchase/commitments/report', userId: LOCAL, tenantId: T, branchId: P3.STORE })).body as Report;
    expect(mine.lines.map((l) => l.poId).sort()).toEqual(['po-direct', 'po-l2', 'po-own-local']);
    expect(codeOf(await h.request({ method: 'GET', path: '/v1/purchase/commitments/report', userId: P3.OWNER, tenantId: T, query: { buyingScope: 'nope' } }))).toBe('unknown_buying_scope');
    expect((await h.request({ method: 'GET', path: '/v1/purchase/commitments/report', userId: P3.CASHIER, tenantId: T })).status).toBe(403);

    // A cold restart: the same report.
    const again = (await harness(h).request({ method: 'GET', path: '/v1/purchase/commitments/report', userId: P3.OWNER, tenantId: T })).body as Report;
    expect(again.byScope).toEqual(report.byScope);
  }, 120_000);
});
