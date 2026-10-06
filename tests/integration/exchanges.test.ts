import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { giveRefundApproval, refundApprovalId } from '../support/refund-approval';
import { STREAM } from '../../services/api/src/adapters';
import { makeEvent } from '../../packages/contracts/src/event';

/**
 * **Exchanges through the real API (M13-FR-03, §28, M08-FR-01, GST credit-note + new supply) — CH-01 un-parked.**
 *
 * Through the real router, token auth, per-tenant RBAC and the append-only store: an even exchange needs no
 * approver and moves no money; the goods coming back re-enter on-hand where the bill drew them and the
 * replacement leaves from the same shelf; the replacement is a REAL banked sale (findable, returnable in its
 * own right); the original bill's refundable money falls by the value credited; a refund of the balance needs a
 * genuine approver at the default threshold; a top-up must add up; an exchange is idempotent on its id.
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AT = '2026-08-07T10:00:00.000Z';

// A bill rung at location L1: 3 × P1 at ₹50 and 1 × P2 at ₹80, paid ₹230.
const sale = () => ({
  saleId: 'S1', receiptNumber: 'R-1', laneId: 'lane-1', locationId: 'L1', cashierId: 'u-cash',
  tradingDay: '2026-08-07', committedAt: AT, totalMinor: 23000, currency: 'INR', packVersion: 1,
  lines: [
    { productId: 'P1', quantityMinor: 3, uom: 'each', unitPriceMinor: 5000, lineTotalMinor: 15000 },
    { productId: 'P2', quantityMinor: 1, uom: 'each', unitPriceMinor: 8000, lineTotalMinor: 8000 },
  ],
  tenders: [{ kind: 'cash', amountMinor: 23000 }],
});
const bank = (h: ApiHarness, u: string) =>
  h.request({ method: 'POST', path: '/v1/sales', userId: u, tenantId: A, idempotencyKey: 'bank-S1', body: sale() });
/** A published pack naming P1/P2/P3 so the replacement's intake raises no catalogue findings. */
const publishPack = (h: ApiHarness) =>
  h.store.append(A, STREAM.catalogue, makeEvent({
    id: `pack-${A}-1`, type: 'CataloguePublished', occurredAt: AT, idempotencyKey: `catalogue-${A}-v1`, source: 'test/catalogue',
    payload: {
      snapshot: {
        tenantId: A, version: 1, builtAt: AT, scope: { tenantId: A, storeId: 'L1' },
        products: [
          { productId: 'P1', sku: 'P1', name: 'P1', unitPriceMinor: 5000, taxBps: 500, status: 'active', uom: 'each' },
          { productId: 'P2', sku: 'P2', name: 'P2', unitPriceMinor: 8000, taxBps: 500, status: 'active', uom: 'each' },
          { productId: 'P3', sku: 'P3', name: 'P3', unitPriceMinor: 5000, taxBps: 500, status: 'active', uom: 'each' },
        ],
        barcodes: [],
      },
    },
  }));
const back = (productId: string, qty: number, disposition = 'resell') => ({ productId, uom: 'each', quantityMinor: qty, disposition });
const out = (productId: string, qty: number, unitPriceMinor: number) => ({ productId, uom: 'each', quantityMinor: qty, unitPriceMinor, lineTotalMinor: qty * unitPriceMinor });
const body = (over: Record<string, unknown> = {}) => ({
  exchangeId: 'X1', reasonCode: 'wrong_size', returnLines: [back('P1', 1)],
  replacement: { saleId: 'S1-X1', receiptNumber: 'R-1X', lines: [out('P3', 1, 5000)] },
  ...over,
});
const exchange = (h: ApiHarness, u: string, b: Record<string, unknown>, saleId = 'S1') =>
  h.request({ method: 'POST', path: `/v1/sales/${saleId}/exchanges`, userId: u, tenantId: A, idempotencyKey: `x-${b['exchangeId']}-${JSON.stringify(b).length}`, body: b });
const returnable = (h: ApiHarness, u: string, saleId = 'S1') =>
  h.request({ method: 'GET', path: `/v1/sales/${saleId}/returnable`, userId: u, tenantId: A });
const availability = async (h: ApiHarness, productId: string) =>
  ((await h.request({ method: 'GET', path: '/v1/inventory/availability', userId: 'u-owner', tenantId: A, query: { productId } })).body as
    { rows: { locationId: string; onHandMinor: number }[] }).rows;
const onHand = async (h: ApiHarness, productId: string, locationId = 'L1') => (await availability(h, productId)).find((r) => r.locationId === locationId)?.onHandMinor ?? 0;
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-mgr', 'store_manager'); // holds pos.return.approve
  await h.provisionRole(A, 'u-cash', 'cashier');      // pos.return.record, NOT approve
  await publishPack(h);
  expect((await bank(h, 'u-owner')).status).toBe(202);
  return h;
}

describe('exchanges through the real API (M13-FR-03) — a return and a replacement sale settled together', () => {
  it('an even exchange: no approver, no money; the shelf and the bill both move; the replacement is a real sale', async () => {
    const h = await cast();
    expect(await onHand(h, 'P1')).toBe(-3); // the bill drew 3 units the ledger never received (a visible negative, not a refusal)
    expect(await onHand(h, 'P3')).toBe(0);

    const res = await exchange(h, 'u-cash', body());
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      exchangeId: 'X1', replacementSaleId: 'S1-X1', returnedValueMinor: 5000, replacementTotalMinor: 5000,
      balance: { kind: 'even', amountMinor: 0 }, restockedLines: 1,
      replacementIntake: { exceptions: [] },
    });
    // Stock: the returned unit is back where the bill drew it; the replacement left the same shelf.
    expect(await onHand(h, 'P1')).toBe(-2);
    expect(await onHand(h, 'P3')).toBe(-1);
    // The bill's register saw the credit: ₹50 of ₹230 is gone, and only 2 × P1 may still come back.
    const r = (await returnable(h, 'u-owner')).body as { refundedMinor: number; refundableMinor: number; returnable: { productId: string; returnableMinor: number }[] };
    expect(r.refundedMinor).toBe(5000);
    expect(r.refundableMinor).toBe(18000);
    expect(r.returnable.find((l) => l.productId === 'P1')?.returnableMinor).toBe(2);
    // The replacement is banked as a sale in its own right — findable and returnable.
    expect((await h.request({ method: 'GET', path: '/v1/sales/S1-X1', userId: 'u-owner', tenantId: A })).body).toMatchObject({ saleId: 'S1-X1', banked: true });
    const rep = (await returnable(h, 'u-owner', 'S1-X1')).body as { totalMinor: number; refundableMinor: number };
    expect(rep.totalMinor).toBe(5000);
    expect(rep.refundableMinor).toBe(5000);
    // Idempotent on the exchange id: the same exchange resent lands once (the register does not double).
    expect((await exchange(h, 'u-cash', body())).status).toBe(201);
    expect(((await returnable(h, 'u-owner')).body as { refundedMinor: number }).refundedMinor).toBe(5000);
    expect(await onHand(h, 'P1')).toBe(-2);
  });

  it('a refund of the balance needs a genuine approver at the default threshold; a top-up must add up', async () => {
    const h = await cast();
    const cheaper = { saleId: 'S1-X2', receiptNumber: 'R-2X', lines: [out('P3', 1, 3000)] };
    expect(codeOf(await exchange(h, 'u-cash', body({ exchangeId: 'X2', replacement: cheaper })))).toBe('refund_tender_required');
    expect(codeOf(await exchange(h, 'u-cash', body({ exchangeId: 'X2', replacement: cheaper, settlement: { refundTender: 'cash' } })))).toBe('needs_a_second_person');
    // A genuine manager NAMED in the body who never approved (the audit's PF-02 reproduction) — refused; a cashier
    // cannot give an approval at all.
    expect(codeOf(await exchange(h, 'u-cash', body({ exchangeId: 'X2', replacement: cheaper, settlement: { refundTender: 'cash' }, approvedBy: 'u-mgr' })))).toBe('approver_named_without_approval');
    const ask = { kind: 'exchange_refund' as const, saleId: 'S1', valueMinor: 2000, requestedBy: 'u-cash' };
    expect((await giveRefundApproval(h, A, 'u-cash', ask)).status).toBe(403);
    // An approval is for one kind and one amount: a plain refund approval, or one for a different balance, does not pay it.
    const plain = await refundApprovalId(h, A, 'u-mgr', { ...ask, kind: 'refund' });
    expect(codeOf(await exchange(h, 'u-cash', body({ exchangeId: 'X2', replacement: cheaper, settlement: { refundTender: 'cash' }, approvalId: plain })))).toBe('approval_does_not_match');
    const other = await refundApprovalId(h, A, 'u-mgr', { ...ask, valueMinor: 2500 });
    expect(codeOf(await exchange(h, 'u-cash', body({ exchangeId: 'X2', replacement: cheaper, settlement: { refundTender: 'cash' }, approvalId: other })))).toBe('approval_does_not_match');
    // The manager approves THIS balance, in their own session — then it lands, naming who approved.
    const approvalId = await refundApprovalId(h, A, 'u-mgr', ask);
    const ok = await exchange(h, 'u-cash', body({ exchangeId: 'X2', replacement: cheaper, settlement: { refundTender: 'cash' }, approvalId }));
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ balance: { kind: 'refund', amountMinor: 2000, tender: 'cash', refundStatus: 'settled' } });

    const dearer = { saleId: 'S1-X3', receiptNumber: 'R-3X', lines: [out('P2', 1, 8000)] };
    expect(codeOf(await exchange(h, 'u-cash', body({ exchangeId: 'X3', replacement: dearer })))).toBe('top_up_does_not_match_balance');
    const top = await exchange(h, 'u-cash', body({ exchangeId: 'X3', replacement: dearer, settlement: { topUpTenders: [{ kind: 'upi', amountMinor: 3000 }] } }));
    expect(top.status).toBe(201);
    expect(top.body).toMatchObject({ balance: { kind: 'top_up', amountMinor: 3000 } });
    // Two exchanges credited 1 × P1 each: only one of the three sold may still come back — two may not.
    expect(codeOf(await exchange(h, 'u-cash', body({ exchangeId: 'X4', returnLines: [back('P1', 2)], replacement: { saleId: 'S1-X4', receiptNumber: 'R-4X', lines: [out('P3', 2, 5000)] } })))).toBe('more_than_was_sold');
  });

  it('is gated: a role without pos.return.record cannot exchange; a bill never banked is 404', async () => {
    const h = await cast();
    await h.provisionRole(A, 'u-acct', 'accountant');
    expect((await exchange(h, 'u-acct', body())).status).toBe(403);
    expect((await exchange(h, 'u-cash', body(), 'S-NOPE')).status).toBe(404);
  });
});
