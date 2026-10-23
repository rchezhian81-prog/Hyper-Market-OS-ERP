import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ApiHarness } from '../support/api-harness';
import { r3OpsBackings, tenantClient } from '../support/r3-ops-backings';
import { SUPPLIER_MAKER, SUPPLIER_CHECKER } from '../support/approved-supplier';
import { supplierReturnEwbMovementId } from '../../services/inventory/src/goods-receipt';

/**
 * **R3 · A23 · OB-194 "A" (owner, 18 Oct 2026, in writing, "Add a 'dispatch' step")** — on the real API, in memory and on
 * real PostgreSQL, with a cold restart. Signed sentence (A23): "a dispatch at or below the threshold proceeds. One above it
 * without a `generated` e-way bill is refused by name. With one, it proceeds and the movement links to the EWB number." For
 * a supplier return: the `…/returned` record of a return above the threshold follows a dispatch recorded under a generated
 * e-way bill for that return's own movement; at or below, the return is recorded exactly as before. Synthetic GSTINs with
 * valid check characters (the warehouse and the supplier both in Tamil Nadu: the ₹1,00,000 intra-State threshold).
 */
const backings = r3OpsBackings();
const TN_SHOP = '33AAACS1111A1ZH';
const TN_SUPPLIER = '33AAACS1111A2ZG';
const RICE = { minor: 10_000, currency: 'INR' }; // ₹100.00 a bag
const partA = (documentNumber: string, consignmentValueMinor: number) => ({
  request: { supplierGstin: TN_SHOP, recipientGstin: TN_SUPPLIER, documentType: 'CHL', documentNumber, documentDate: '2026-10-18', hsnCode: '1006', consignmentValueMinor, supplyRoute: 'intra_state', movementReason: 'supplier_return', fromPincode: '600001', toPincode: '641001' },
});

describe.each(backings)('a supplier return above the threshold is dispatched under an e-way bill — on $name (A23 · OB-194)', ({ harness, restart }) => {
  it('at the threshold: returned as before; above: refused until dispatched, dispatch refused until generated, then both link the EWB number', async () => {
    let h: ApiHarness = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-recv', 'store_manager');
    await h.provisionRole(T, 'u-po-buyer', 'store_manager'); // OB-288 P3 (§28): the buyer who raises the order is never the one who books it in
    await h.provisionRole(T, 'u-boss', 'store_manager');
    await h.provisionRole(T, 'u-till', 'cashier');
    await h.provisionRole(T, SUPPLIER_MAKER, 'store_manager');
    await h.provisionRole(T, SUPPLIER_CHECKER, 'accountant');
    const { req, ok, code } = tenantClient(() => h, T);
    // The organisation: the warehouse under the shop's Tamil Nadu registration; a Tamil Nadu supplier with its GSTIN.
    await ok(req('POST', '/v1/org/nodes/C1', { kind: 'company', name: 'Synthetic Retail' }), 'company');
    await ok(req('POST', `/v1/org/gst-registrations/${TN_SHOP}`, { companyId: 'C1', legalName: 'Synthetic Retail TN' }), 'registration');
    await ok(req('POST', '/v1/org/nodes/WH', { kind: 'warehouse', name: 'Back store', parentId: 'C1', companyId: 'C1', gstin: TN_SHOP }), 'warehouse');
    await ok(req('POST', '/v1/purchase/suppliers/sup-tn', { name: 'Synthetic Rice Mills', gstin: TN_SUPPLIER }, SUPPLIER_MAKER), 'propose supplier');
    await ok(req('POST', '/v1/purchase/suppliers/sup-tn/approval', { reason: 'synthetic, documents checked' }, SUPPLIER_CHECKER), 'approve supplier');
    await ok(req('POST', '/v1/inventory/receipt-policy', { excessToleranceBp: 0, shortageToleranceBp: 0, nearExpiryDays: 7 }), 'policy');
    await ok(req('POST', '/v1/purchase/orders/po-rice', { supplierId: 'sup-tn', deliverToLocationId: 'WH', lines: [{ productId: 'p-rice', orderedQty: 5_000, unitCost: RICE }] }, 'u-po-buyer'), 'po');
    await ok(req('POST', '/v1/purchase/orders/po-rice/approval', { reason: 'fixture' }), 'issue po');
    // Two deliveries, each with a damaged line a second person sends back: exactly ₹1,00,000, and ₹1,00,100.
    for (const [grnId, qty] of [['grn-small', 1_000], ['grn-big', 1_001]] as const) {
      await ok(req('POST', `/v1/inventory/goods-receipt/${grnId}`, { warehouseId: 'WH', receivedOnDate: '2026-10-18', currency: 'INR', poId: 'po-rice', lines: [{ lineId: 'L1', productId: 'p-rice', orderedMinor: qty, countedMinor: qty, uom: 'ea', unitCost: RICE, condition: 'damaged' }] }, 'u-recv'), grnId);
      await ok(req('POST', `/v1/inventory/goods-receipt/${grnId}/lines/L1/disposition`, { disposition: 'return', reason: 'bags torn' }, 'u-boss'), `${grnId} disposition`);
    }
    const returned = (grnId: string, userId = 'u-recv') => req('POST', `/v1/inventory/goods-receipt/${grnId}/lines/L1/returned`, { reason: 'collected by the supplier lorry TN-01-AB-1234' }, userId);
    const dispatch = (grnId: string, userId = 'u-recv', body: Record<string, unknown> = { reason: 'supplier lorry TN-01-AB-1234' }) => req('POST', `/v1/inventory/goods-receipt/${grnId}/lines/L1/dispatch`, body, userId);

    // ── AT THE THRESHOLD: the return is recorded exactly as before — no dispatch step ──
    const small = await returned('grn-small');
    expect(small.status, JSON.stringify(small.body)).toBe(201);
    expect(small.body).toMatchObject({ grnId: 'grn-small', lineId: 'L1', valueMinor: 10_000_000, debitNoteRef: 'DN-grn-small-L1' });

    // ── ABOVE IT: the returned record is refused by name until the dispatch is recorded ──
    const early = await returned('grn-big');
    expect([early.status, code(early)]).toEqual([409, 'supplier_return_not_dispatched']);
    expect((early.body as { error: { nextSafeAction: string } }).error.nextSafeAction).toContain('/v1/inventory/goods-receipt/grn-big/lines/L1/dispatch');
    // Who may dispatch: not a cashier; a reason is needed; an unknown line by name.
    expect((await dispatch('grn-big', 'u-till')).status).toBe(403);
    expect(code(await dispatch('grn-big', 'u-recv', {}))).toBe('not_readable_as_a_return_dispatch');
    expect(code(await req('POST', '/v1/inventory/goods-receipt/grn-big/lines/L9/dispatch', { reason: 'x' }, 'u-recv'))).toBe('line_unknown');
    // No e-way bill: refused by name, nothing recorded.
    const movement = supplierReturnEwbMovementId('grn-big', { kind: 'line', lineId: 'L1' });
    const none = await dispatch('grn-big');
    expect([none.status, code(none)]).toEqual([409, 'ewb_required']);
    expect((none.body as { error: { whatHappened: string } }).error.whatHappened).toBe(`This supplier return cannot leave without an e-way bill: movement ${movement} is worth ₹1,00,100.00, above the ₹1,00,000.00 threshold, and no e-way bill has been generated for it.`);
    // Submitted but not generated: still refused, naming its state.
    await ok(req('POST', `/v1/finance/e-way-bill/movements/${movement}/submit`, partA('SR-grn-big-L1', 10_010_000)), 'submit');
    const pending = await dispatch('grn-big');
    expect(code(pending)).toBe('ewb_required');
    expect((pending.body as { error: { whatHappened: string } }).error.whatHappened).toMatch(/its e-way bill is pending unknown, not generated/);

    h = restart(h); // ── COLD RESTART ──────────────────────────────────────────────────────────────────────────

    // Generated: the dispatch proceeds, linking the number; the returned record follows it and carries the number.
    await ok(req('POST', `/v1/finance/e-way-bill/movements/${movement}/record-response`, { result: { status: 'generated', ewbNo: '391000654321', ewbDate: '2026-10-18', validUpto: '2026-10-19' } }), 'generated');
    const sent = await dispatch('grn-big');
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    expect(sent.body).toMatchObject({ dispatch: { movementId: movement, outcome: 'covered', ewbNo: '391000654321', valueMinor: 10_010_000, dispatchedBy: 'u-recv' }, ewayBill: { outcome: 'covered', ewbNo: '391000654321' } });
    expect((await dispatch('grn-big')).body).toMatchObject({ alreadyDispatched: true, dispatch: { ewbNo: '391000654321' } });
    const big = await returned('grn-big');
    expect(big.status, JSON.stringify(big.body)).toBe(201);
    expect(big.body).toMatchObject({ grnId: 'grn-big', valueMinor: 10_010_000, dispatch: { movementId: movement, ewbNo: '391000654321' } });
    // The supplier's account sees the goods gone back, as before.
    const account = (await ok(req('GET', '/v1/purchase/suppliers/sup-tn/account'), 'account')).body as { pendingLineReturns: { grnId: string; returned: boolean }[] };
    expect(account.pendingLineReturns.map((p) => `${p.grnId}:${p.returned}`).sort()).toEqual(['grn-big:true', 'grn-small:true']);
    // A cancelled e-way bill no longer covers a NEW dispatch (the recorded one stands, append-only).
    await ok(req('POST', `/v1/finance/e-way-bill/movements/${movement}/cancel`, { reason: 'lorry changed (synthetic)' }), 'cancel');
    expect((await dispatch('grn-big')).body).toMatchObject({ alreadyDispatched: true });
  }, 120_000);
});
