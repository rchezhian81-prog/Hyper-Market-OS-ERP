import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { useRestartableBackings } from '../support/p3-backings';
import { P3, p3Shop, caller, issuedOrder, received, payInCash } from '../support/p3-purchase';

// M06-FR-02 acceptance "SoD prevents one person completing requisition-to-pay"; §28 Purchase User "cannot receive, match
// and pay same transaction"; M07-FR-04 "receiver ≠ approver of payment" (OB-288 P3). For ONE purchase order the same person
// may never do two of: raise it, book its goods in, match its bill, pay it (record or approve the payment). Each is
// attempted through the real routes and refused by name; a different person goes through; a cold restart keeps the record
// of who did what. On the in-memory store and — with DATABASE_URL — on real PostgreSQL.

const backings = useRestartableBackings();
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
const RICE = [{ productId: 'rice', qty: 10, unitMinor: 5_000 }];

describe.each(backings)('separation of duties across one purchase (M06-FR-02 · §28) — on $name', ({ harness }) => {
  it('raise → receive → match → pay: each step refuses a person who did another, accepts a different one; a restart remembers', async () => {
    const h = harness();
    const T = randomUUID();
    await p3Shop(h, T);
    const call = caller(h, T);
    await issuedOrder(call, 'po-1', RICE);

    // RECEIVE: the buyer who raised it may not book it in.
    const own = await call('POST', '/v1/inventory/goods-receipt/grn-x', P3.BUYER, {
      warehouseId: P3.BACK, receivedOnDate: '2026-10-20', currency: 'INR', poId: 'po-1',
      lines: [{ lineId: 'L1', productId: 'rice', orderedMinor: 10, countedMinor: 10, uom: 'ea', unitCost: { minor: 5_000, currency: 'INR' }, condition: 'good' }],
    });
    expect([own.status, codeOf(own)]).toEqual([409, 'segregation_of_duties']);
    expect((own.body as { error: { whatHappened: string } }).error.whatHappened).toContain('already raised the order');
    // Nothing was booked: the order still waits for everything.
    expect(((await call('GET', '/v1/purchase/orders/po-1', P3.OWNER)).body as { order: { receivedByProduct: Record<string, number> } }).order.receivedByProduct).toEqual({});
    await received(call, 'grn-1', 'po-1', RICE);

    // MATCH: the receiver may not match the bill (a store manager holds the match right), nor may the buyer.
    await call('POST', '/v1/purchase/invoices/inv-1/capture', P3.BUYER, { supplierId: 'sup-1', poId: 'po-1', declaredTotalMinor: 50_000, lines: [{ productId: 'rice', quantity: 10, unitPriceMinor: 5_000, lineTotalMinor: 50_000 }] });
    const byReceiver = await call('POST', '/v1/purchase/invoices/inv-1/match', P3.RECEIVER, {});
    expect([byReceiver.status, codeOf(byReceiver)]).toEqual([409, 'segregation_of_duties']);
    const byBuyer = await call('POST', '/v1/purchase/invoices/inv-1/match', P3.BUYER, {});
    expect(codeOf(byBuyer)).toBe('segregation_of_duties');
    const matched = await call('POST', '/v1/purchase/invoices/inv-1/match', P3.MATCHER, {});
    expect(matched.status).toBe(200);
    expect(matched.body).toMatchObject({ blocked: false, payableMinor: 50_000 });

    // PAY: the matcher may not pay it, nor approve its payment; the receiver may not approve it either.
    expect(codeOf(await payInCash(h, T, 'sup-1', 'pay-a', 20_000, P3.MATCHER, P3.PAY_APPROVER))).toBe('segregation_of_duties');
    expect(codeOf(await payInCash(h, T, 'sup-1', 'pay-b', 20_000, P3.PAYER, P3.MATCHER))).toBe('segregation_of_duties');
    await h.provisionRole(T, P3.RECEIVER, 'accountant'); // even holding the authority to pay
    expect(codeOf(await payInCash(h, T, 'sup-1', 'pay-c', 20_000, P3.PAYER, P3.RECEIVER))).toBe('segregation_of_duties');
    const paid = await payInCash(h, T, 'sup-1', 'pay-d', 20_000);
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);

    // A cold restart: who did what is head office's record — the payer may not now book in more of the same order.
    const again = harness(h);
    const late = caller(again, T);
    await again.provisionRole(T, P3.PAYER, 'store_manager');
    const payerReceives = await late('POST', '/v1/inventory/goods-receipt/grn-2', P3.PAYER, {
      warehouseId: P3.BACK, receivedOnDate: '2026-10-21', currency: 'INR', poId: 'po-1',
      lines: [{ lineId: 'L1', productId: 'rice', orderedMinor: 0, countedMinor: 1, uom: 'ea', unitCost: { minor: 5_000, currency: 'INR' }, condition: 'good' }],
    });
    expect(codeOf(payerReceives)).toBe('segregation_of_duties');
    // The manual reconciliation route refuses a matcher or payer too.
    expect(codeOf(await late('POST', '/v1/purchase/orders/po-1/receipts', P3.PAYER, { receiptId: 'carried-1', receivedByProduct: { rice: 1 } }))).toBe('segregation_of_duties');
  }, 120_000);

  it('a receipt that already happened at the store (relayed) is booked and FLAGGED, never lost; a requisition\'s raiser counts as raising the order', async () => {
    const h = harness();
    const T = randomUUID();
    await p3Shop(h, T);
    const call = caller(h, T);
    // The requisition is raised by the receiver; the order is raised from it by the buyer.
    expect((await call('POST', '/v1/purchase/requisitions/rq-1', P3.RECEIVER, { currency: 'INR', lines: [{ productId: 'rice', quantity: 10 }] })).status).toBe(201);
    await issuedOrder(call, 'po-2', RICE, 'sup-1', { requisitionId: 'rq-1' });
    expect(codeOf(await call('POST', '/v1/purchase/orders/po-3', P3.BUYER, { supplierId: 'sup-1', deliverToLocationId: P3.STORE, requisitionId: 'rq-none', lines: [{ productId: 'rice', orderedQty: 1, unitCost: { minor: 1, currency: 'INR' } }] }))).toBe('requisition_unknown');
    // The requisition's raiser booking the goods in at head office: refused.
    expect(codeOf(await call('POST', '/v1/inventory/goods-receipt/grn-r', P3.RECEIVER, {
      warehouseId: P3.BACK, receivedOnDate: '2026-10-20', currency: 'INR', poId: 'po-2',
      lines: [{ lineId: 'L1', productId: 'rice', orderedMinor: 10, countedMinor: 10, uom: 'ea', unitCost: { minor: 5_000, currency: 'INR' }, condition: 'good' }],
    }))).toBe('segregation_of_duties');
    // The same delivery booked at the store and relayed by the box: it is in the building, so it is booked — and said.
    await h.provisionRole(T, 'u-box', 'store_computer', [P3.STORE]);
    const relayed = await call('POST', '/v1/inventory/goods-receipt/grn-r/synced', 'u-box', {
      grnId: 'grn-r', number: 'GRN-R', poId: 'po-2', lineCount: 1, warehouseId: P3.BACK, receivedBy: P3.RECEIVER, receivedAt: '2026-10-20T10:00:00.000Z',
      lines: [{ productId: 'rice', quantityMinor: 10, uom: 'ea', batchId: null }], storeId: P3.STORE, source: 'manager-screen',
    });
    expect(relayed.status, JSON.stringify(relayed.body)).toBe(202);
    expect((relayed.body as { grn: { governanceFlags: string[]; segregationConflict: string } }).grn.governanceFlags).toContain('segregation_of_duties');
    expect((relayed.body as { grn: { segregationConflict: string } }).grn.segregationConflict).toContain('already raised the order');
  }, 120_000);
});
