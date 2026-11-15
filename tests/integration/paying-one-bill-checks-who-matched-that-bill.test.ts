import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { useRestartableBackings } from '../support/p3-backings';
import { P3, p3Shop, caller, issuedOrder, received } from '../support/p3-purchase';
import { sentWithApproval } from '../support/approval-request';
import type { ApiHarness } from '../support/api-harness';

// OB-740 (pilot audit B-1, BLOCKS PILOT): the segregation-of-duties check on a supplier payment (M06-FR-02 · §28 "cannot
// receive, match and pay same transaction", OB-288 P3) looked at EVERY bill of the supplier still open, not the bills the
// payment settles. The accountant who matched the bill on order A could then never record (or approve) the payment of a
// DIFFERENT bill on order B — and as only the owner and the accountant pay, no supplier could ever be paid. The rule is
// "the person who records or approves a payment must not be one who raised, received or matched THE BILLS BEING PAID".
// A payment that names no bill (paid on account) is still checked against every open bill — the stricter reading.

const backings = useRestartableBackings();
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
const RICE = [{ productId: 'rice', qty: 10, unitMinor: 5_000 }];
const OTHER_MATCHER = 'u-match-2';

/** A cash payment of named bills (or on account, with no bills named), recorded by `payer` and approved by `approver`. */
function pay(h: ApiHarness, T: string, paymentId: string, amountMinor: number, payer: string, approver: string, settles?: readonly string[]) {
  const body = { amountMinor, paidOn: '2026-10-21', method: 'cash', reference: `CASH-${paymentId}`, ...(settles === undefined ? {} : { settles }) };
  return sentWithApproval(h, T, payer, approver, { kind: 'supplier_payment', subjectRef: `sup-1/${paymentId}`, pathIds: { supplierId: 'sup-1', paymentId }, valueMinor: amountMinor }, body,
    (b) => h.request({ method: 'POST', path: `/v1/purchase/suppliers/sup-1/payments/${paymentId}`, userId: payer, tenantId: T, idempotencyKey: `pay-${paymentId}`, body: b }));
}

describe.each(backings)('paying a bill checks who matched THAT bill, not every open bill (OB-740 · M06-FR-02 · §28) — on $name', ({ harness }) => {
  it('the matcher of order A may pay order B\'s bill; nobody may pay a bill they matched; an on-account payment still checks every open bill', async () => {
    const h = harness();
    const T = randomUUID();
    await p3Shop(h, T);
    await h.provisionRole(T, OTHER_MATCHER, 'store_manager');
    const call = caller(h, T);
    await issuedOrder(call, 'po-A', RICE);
    await issuedOrder(call, 'po-B', RICE);
    await received(call, 'grn-A', 'po-A', RICE);
    await received(call, 'grn-B', 'po-B', RICE);
    const bill = { supplierId: 'sup-1', declaredTotalMinor: 50_000, lines: [{ productId: 'rice', quantity: 10, unitPriceMinor: 5_000, lineTotalMinor: 50_000 }] };
    expect((await call('POST', '/v1/purchase/invoices/inv-A/capture', P3.BUYER, { ...bill, poId: 'po-A' })).status).toBeLessThan(300);
    expect((await call('POST', '/v1/purchase/invoices/inv-B/capture', P3.BUYER, { ...bill, poId: 'po-B' })).status).toBeLessThan(300);
    // The accountant matches order A's bill (the oldest open bill); a different person matches order B's.
    expect((await call('POST', '/v1/purchase/invoices/inv-A/match', P3.MATCHER, {})).status).toBe(200);
    expect((await call('POST', '/v1/purchase/invoices/inv-B/match', OTHER_MATCHER, {})).status).toBe(200);

    // The guard still holds: whoever matched a bill being paid may neither record nor approve its payment.
    const matcherPaysOwn = await pay(h, T, 'pay-1', 50_000, P3.MATCHER, P3.OWNER, ['inv-A']);
    expect([matcherPaysOwn.status, codeOf(matcherPaysOwn)]).toEqual([409, 'segregation_of_duties']);
    expect((matcherPaysOwn.body as { error: { whatHappened: string } }).error.whatHappened).toContain('already matched the bill on purchase order po-A');
    await h.provisionRole(T, OTHER_MATCHER, 'accountant'); // even holding the authority to approve a payment
    expect(codeOf(await pay(h, T, 'pay-2', 50_000, P3.OWNER, OTHER_MATCHER, ['inv-B']))).toBe('segregation_of_duties');
    // Paid on account (no bill named): cannot say which bill it pays, so every open bill counts — the matcher of A is refused.
    expect(codeOf(await pay(h, T, 'pay-3', 20_000, P3.MATCHER, P3.OWNER))).toBe('segregation_of_duties');
    // Naming B but paying more than B: the excess is on account, so order A's bill counts too — refused.
    expect(codeOf(await pay(h, T, 'pay-4', 60_000, P3.MATCHER, P3.OWNER, ['inv-B']))).toBe('segregation_of_duties');

    // THE BUG: the accountant records the payment of order B's bill, the owner approves it. Neither touched order B, so it
    // goes through (before OB-740 it was refused because the accountant matched order A's bill).
    const paidB = await pay(h, T, 'pay-5', 50_000, P3.MATCHER, P3.OWNER, ['inv-B']);
    expect(paidB.status, JSON.stringify(paidB.body)).toBe(201);

    // A cold restart: the record of who paid is by the bill paid — the accountant is on record as paying order B, not A,
    // so a re-match of order A's bill by the same accountant is still a re-match (same act), never "already paid".
    const again = harness(h);
    const late = caller(again, T);
    const rematch = await late('POST', '/v1/purchase/invoices/inv-A/match', P3.MATCHER, {});
    expect(codeOf(rematch)).not.toBe('segregation_of_duties');
    // And the payer of order B's bill is on record for order B: they may not now book more goods in on it.
    await again.provisionRole(T, P3.MATCHER, 'store_manager');
    const payerReceives = await late('POST', '/v1/inventory/goods-receipt/grn-B2', P3.MATCHER, {
      warehouseId: P3.BACK, receivedOnDate: '2026-10-22', currency: 'INR', poId: 'po-B',
      lines: [{ lineId: 'L1', productId: 'rice', orderedMinor: 0, countedMinor: 1, uom: 'ea', unitCost: { minor: 5_000, currency: 'INR' }, condition: 'good' }],
    });
    expect(codeOf(payerReceives)).toBe('segregation_of_duties');
  }, 120_000);
});
