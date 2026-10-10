import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { approvedSuppliers } from '../support/approved-supplier';
import { STREAM } from '../../services/api/src/adapters';
import { makeEvent } from '../../packages/contracts/src/event';

// M07-FR-01/02/03 (D03-FR-02): goods receipt / GRN capture on the live API — the back door of the shop,
// where most money is lost. The cloud boundary re-runs the tested captureReceipt: a batch-tracked item with
// no batch or no expiry is REFUSED (M10); expired stock is rejected, never received as sellable; damaged /
// QC-failed stock goes to QUARANTINE (not available to sell, M07-FR-03); short/excess/MRP lines raise valued
// discrepancies and an over-tolerance excess is HELD for a second person (§28, F03). Only the SELLABLE quantity
// becomes availability, and the GRN + its movements are one atomic append. Idempotent on the GRN id (§31.1).
// Since SP-4 (ii) the product's tracking rule comes from the PUBLISHED CATALOGUE and the tolerances from the
// tenant's receipt policy — a body naming either is refused (F03). Gated inventory.movement.append (Receiver/QC);
// reads inventory.availability.read.
// Since SP-6 (audit finding F01) a receipt against an ISSUED purchase order FOLDS INTO THE ORDER in the same atomic append
// as the GRN and its stock: the received quantity per product posts to the PO, so the open commitment falls with the
// goods; the ordered quantity is the order's, never the body's; a receipt with no / an unknown / an unissued order is
// received and flagged, and folds into nothing.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const INR = 'INR';
const AT = '2026-08-18T06:00:00.000Z';
const POLICY = { excessToleranceBp: 500, shortageToleranceBp: 200, nearExpiryDays: 7 };
const cost = (minor: number) => ({ minor, currency: INR });

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
const grnOf = (res: { body: unknown }): { availableMinor?: number; heldMinor?: number; governanceFlags?: string[]; captured?: { requiresApproval?: boolean; discrepancies?: { kind: string }[]; lines?: { disposition: string; sellableMinor: number; quarantinedMinor: number; heldMinor: number }[] } } =>
  (res.body as { grn?: Record<string, unknown> }).grn ?? {};

const receive = (h: ApiHarness, u: string, grnId: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: `/v1/inventory/goods-receipt/${grnId}`, userId: u, tenantId: A, idempotencyKey: key, body });
const readGrn = (h: ApiHarness, u: string, grnId: string) =>
  h.request({ method: 'GET', path: `/v1/inventory/goods-receipt/${grnId}`, userId: u, tenantId: A });
const listGrns = (h: ApiHarness, u: string) =>
  h.request({ method: 'GET', path: '/v1/inventory/goods-receipt', userId: u, tenantId: A });
const onHand = async (h: ApiHarness, u: string, productId: string): Promise<number> => {
  const res = await h.request({ method: 'GET', path: '/v1/inventory/availability', userId: u, tenantId: A, query: { productId } });
  const rows = (res.body as { rows: { onHandMinor: number }[] }).rows;
  return rows.reduce((s, r) => s + r.onHandMinor, 0);
};

const line = (extra: Record<string, unknown> = {}) =>
  ({ lineId: 'L1', productId: 'p1', orderedMinor: 100, countedMinor: 100, uom: 'each', unitCost: cost(5000), condition: 'good', ...extra });
// The counted lines ONLY — the rules and the tolerances are head office's (F03).
const body = (lines: unknown[]) => ({ warehouseId: 'wh1', receivedOnDate: '2026-08-18', currency: INR, lines });

/** The cast, the PRODUCT MASTER (p1 and p3 untracked, p2 batch-tracked) and the tenant's receiving tolerances. */
async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await approvedSuppliers(h, A, 'sup-1'); // OB-32: an order needs an approved supplier
  await h.provisionRole(A, 'u-mgr', 'store_manager'); // has inventory.movement.append
  await h.provisionRole(A, 'u-cash', 'cashier');       // does not
  await h.store.append(A, STREAM.catalogue, makeEvent({
    id: `pack-${A}-1`, type: 'CataloguePublished', occurredAt: AT, idempotencyKey: `catalogue-${A}-v1`, source: 'test/catalogue',
    payload: {
      snapshot: {
        tenantId: A, version: 1, builtAt: AT, scope: { tenantId: A, storeId: 'store-1' },
        products: [
          { productId: 'p1', sku: 'p1', name: 'Toor dal 1kg', unitPriceMinor: 16_000, taxBps: 0, status: 'active', uom: 'each', batchTracked: false, handling: 'ambient' },
          { productId: 'p2', sku: 'p2', name: 'Fresh paneer 200g', unitPriceMinor: 9_000, taxBps: 500, status: 'active', uom: 'each', batchTracked: true },
          { productId: 'p3', sku: 'p3', name: 'Biscuits 100g', unitPriceMinor: 2_000, taxBps: 1800, status: 'active', uom: 'each', batchTracked: false, handling: 'ambient' },
        ],
        barcodes: [],
      },
    },
  }));
  expect((await h.request({ method: 'POST', path: '/v1/inventory/receipt-policy', userId: 'u-owner', tenantId: A, idempotencyKey: 'k-policy', body: POLICY })).status).toBe(201);
  return h;
}

describe('goods receipt / GRN capture (M07-FR-01/02/03)', () => {
  it('receives a clean delivery: the counted stock becomes available and the GRN reads back', async () => {
    const h = await cast();
    const res = await receive(h, 'u-mgr', 'grn-1', body([line()]), 'k1');
    expect(res.status).toBe(201);
    expect(grnOf(res).availableMinor).toBe(100);
    expect(await onHand(h, 'u-mgr', 'p1')).toBe(100); // the receipt became availability
    expect((await readGrn(h, 'u-owner', 'grn-1')).status).toBe(200);
  });

  it('refuses a batch-tracked line with no batch or no expiry (you cannot recall what you cannot identify) — the rule is the PRODUCT MASTER\'s', async () => {
    const h = await cast();
    // p2 is batch-tracked on the published catalogue; the body says nothing about it (and may not, F03).
    const noBatch = await receive(h, 'u-mgr', 'grn-2', body([line({ productId: 'p2' })]), 'k1');
    expect(noBatch.status).toBe(422);
    expect(codeOf(noBatch)).toBe('receipt_line_incomplete');
    // Nothing was received.
    expect(await onHand(h, 'u-mgr', 'p2')).toBe(0);
    // With batch but no expiry → still refused.
    expect((await receive(h, 'u-mgr', 'grn-2', body([line({ productId: 'p2', batchId: 'B1' })]), 'k2')).status).toBe(422);
    // With both → received, and nothing was left unverified.
    const ok = await receive(h, 'u-mgr', 'grn-2', body([line({ productId: 'p2', batchId: 'B1', expiry: '2027-01-01' })]), 'k3');
    expect(ok.status).toBe(201);
    // nothing unverified about the batch; no order is behind them (SP-6); and the master names no handling class for paneer (SF-07, said)
    expect(grnOf(ok).governanceFlags).toEqual(['no_purchase_order', 'handling_unknown']);
  });

  it('a product the master does not know is received — goods in the building are never refused for paperwork — and the record SAYS the rule was unverified', async () => {
    const h = await cast();
    const res = await receive(h, 'u-mgr', 'grn-unknown', body([line({ productId: 'p-not-on-master' })]), 'k1');
    expect(res.status).toBe(201);
    expect(grnOf(res).governanceFlags).toEqual(['no_purchase_order', 'product_rules_unverified', 'handling_unknown']);
    expect(await onHand(h, 'u-mgr', 'p-not-on-master')).toBe(100);
  });

  it('quarantines damaged / QC-failed / expired stock — it never becomes available to sell', async () => {
    const h = await cast();
    // Damaged → quarantined, sellable 0.
    const dmg = await receive(h, 'u-mgr', 'grn-3', body([line({ condition: 'damaged' })]), 'k1');
    expect(grnOf(dmg).captured?.lines?.[0]).toMatchObject({ disposition: 'quarantine', sellableMinor: 0, quarantinedMinor: 100 });
    expect(await onHand(h, 'u-mgr', 'p1')).toBe(0); // quarantine is not availability

    // Expired at receipt → rejected, and it needs approval.
    const exp = await receive(h, 'u-mgr', 'grn-4', body([line({ productId: 'p3', expiry: '2026-08-01' })]), 'k2');
    expect(grnOf(exp).captured?.lines?.[0]).toMatchObject({ disposition: 'rejected', sellableMinor: 0 });
    expect(grnOf(exp).captured?.discrepancies?.some((d) => d.kind === 'expired')).toBe(true);
    expect(grnOf(exp).captured?.requiresApproval).toBe(true);
  });

  it('raises a valued discrepancy for short and over-tolerance excess; the list puts approval-needed first', async () => {
    const h = await cast();
    // Short delivery (10% short, over the 2% tolerance).
    const short = await receive(h, 'u-mgr', 'grn-5', body([line({ countedMinor: 90 })]), 'k1');
    expect(grnOf(short).captured?.discrepancies?.some((d) => d.kind === 'short')).toBe(true);
    expect(await onHand(h, 'u-mgr', 'p1')).toBe(90); // the 90 that arrived is sellable

    // Excess beyond tolerance (10% over the 5% limit) → needs approval, and the excess is HELD off the on-hand figure (F03).
    const excess = await receive(h, 'u-mgr', 'grn-6', body([line({ productId: 'p3', countedMinor: 110 })]), 'k2');
    expect(grnOf(excess).captured?.requiresApproval).toBe(true);
    expect(grnOf(excess)).toMatchObject({ availableMinor: 100, heldMinor: 10 });
    expect(await onHand(h, 'u-mgr', 'p3')).toBe(100);
    // The review list surfaces the approval-needed GRNs first (control by exception).
    const l = await listGrns(h, 'u-owner');
    const receipts = (l.body as { receipts: { captured: { requiresApproval: boolean } }[]; needingApprovalCount: number }).receipts;
    expect(receipts[0]?.captured.requiresApproval).toBe(true);
    expect((l.body as { needingApprovalCount: number }).needingApprovalCount).toBeGreaterThanOrEqual(1);
  });

  it('never double-counts: re-receiving the same GRN id is one effect (a re-scan / re-sync)', async () => {
    const h = await cast();
    expect((await receive(h, 'u-mgr', 'grn-7', body([line()]), 'k1')).status).toBe(201);
    const again = await receive(h, 'u-mgr', 'grn-7', body([line()]), 'k2');
    expect(again.status).toBe(200);
    expect((again.body as { alreadyReceived?: boolean }).alreadyReceived).toBe(true);
    expect(await onHand(h, 'u-mgr', 'p1')).toBe(100); // NOT 200 — the delivery was counted once
  });

  it('gates receiving on inventory.movement.append (a cashier cannot receive), refuses a malformed body, and refuses a body that names its own rules or tolerances (F03)', async () => {
    const h = await cast();
    expect((await receive(h, 'u-cash', 'grn-8', body([line()]), 'k1')).status).toBe(403);
    // Empty lines → 400.
    expect(codeOf(await receive(h, 'u-mgr', 'grn-9', { warehouseId: 'wh1', receivedOnDate: '2026-08-18', currency: INR, lines: [] }, 'k2'))).toBe('not_readable_as_a_goods_receipt');
    // The old body — caller-supplied product rules and/or a tolerance policy — is refused by name, and nothing is saved.
    const rules = await receive(h, 'u-mgr', 'grn-9', { ...body([line()]), rules: [{ productId: 'p1', batchTracked: false }] }, 'k3');
    expect(rules.status).toBe(400);
    expect(codeOf(rules)).toBe('receipt_carries_caller_claims');
    const policy = await receive(h, 'u-mgr', 'grn-9', { ...body([line()]), policy: { excessToleranceBp: 100_000, shortageToleranceBp: 0, nearExpiryDays: 30 } }, 'k4');
    expect(codeOf(policy)).toBe('receipt_carries_caller_claims');
    expect((await readGrn(h, 'u-mgr', 'grn-9')).status).toBe(404);
    expect(await onHand(h, 'u-mgr', 'p1')).toBe(0);
    // A cashier can still not read (needs inventory.availability.read) — but a manager can.
    expect((await listGrns(h, 'u-mgr')).status).toBe(200);
  });

  it('survives a restart: the GRN and its availability are rebuilt from the event store', async () => {
    const h = await cast();
    await receive(h, 'u-mgr', 'grn-10', body([line()]), 'k1');
    const restarted = apiHarness({ store: h.store });
    expect((await readGrn(restarted, 'u-owner', 'grn-10')).status).toBe(200);
    expect(await onHand(restarted, 'u-owner', 'p1')).toBe(100);
  });

  // ── SP-6 · F01: the receipt folds into the order ──────────────────────────────────────────────────────────────────────

  /** An ISSUED order: the manager proposes, the owner (a second person) approves. */
  const issuedOrder = async (h: ApiHarness, poId: string, lines: { productId: string; orderedQty: number; unitCostMinor: number }[]): Promise<void> => {
    expect((await h.request({ method: 'POST', path: `/v1/purchase/orders/${poId}`, userId: 'u-mgr', tenantId: A, idempotencyKey: `po-${poId}`,
      body: { supplierId: 'sup-1', lines: lines.map((l) => ({ productId: l.productId, orderedQty: l.orderedQty, unitCost: cost(l.unitCostMinor) })) } })).status).toBe(201);
    expect((await h.request({ method: 'POST', path: `/v1/purchase/orders/${poId}/approval`, userId: 'u-owner', tenantId: A, idempotencyKey: `po-${poId}-ok`, body: { reason: 'within budget' } })).status).toBe(200);
  };
  const orderOf = async (h: ApiHarness, poId: string) =>
    (await h.request({ method: 'GET', path: `/v1/purchase/orders/${poId}`, userId: 'u-owner', tenantId: A })).body as { order: { receivedByProduct: Record<string, number> }; openCommitment: { totalOpenValue: { minor: number }; fullyReceived: boolean; lines: { productId: string; openQty: number }[] } | null };

  it('folds into its ISSUED order in the same append as the stock: the remainder falls with the goods, once, and the second delivery closes it (F01)', async () => {
    const h = await cast();
    await issuedOrder(h, 'po-f1', [{ productId: 'p1', orderedQty: 100, unitCostMinor: 5000 }, { productId: 'p3', orderedQty: 20, unitCostMinor: 200 }]);
    expect((await orderOf(h, 'po-f1')).openCommitment).toMatchObject({ totalOpenValue: { minor: 504_000 }, fullyReceived: false });

    const first = await receive(h, 'u-mgr', 'grn-f1', { ...body([line({ countedMinor: 60 })]), poId: 'po-f1' }, 'k1');
    expect(first.status).toBe(201);
    expect((first.body as { poReceipt: unknown }).poReceipt).toEqual({ receiptId: 'grn-f1', receivedByProduct: { p1: 60 } });
    expect(grnOf(first).governanceFlags).toEqual([]); // an issued order, a known product, the tenant's policy: nothing to say
    expect(await onHand(h, 'u-mgr', 'p1')).toBe(60);
    // The order fell by exactly the delivery — 40 of p1 and all 20 of p3 still open — with no separate call.
    let po = await orderOf(h, 'po-f1');
    expect(po.order.receivedByProduct).toEqual({ p1: 60 });
    expect(po.openCommitment).toMatchObject({ totalOpenValue: { minor: 40 * 5000 + 20 * 200 }, fullyReceived: false });
    expect(po.openCommitment?.lines).toEqual([expect.objectContaining({ productId: 'p1', openQty: 40 }), expect.objectContaining({ productId: 'p3', openQty: 20 })]);

    // A re-receipt of the same GRN — same key or a new one — folds nothing twice.
    await receive(h, 'u-mgr', 'grn-f1', { ...body([line({ countedMinor: 60 })]), poId: 'po-f1' }, 'k1');
    expect((await receive(h, 'u-mgr', 'grn-f1', { ...body([line({ countedMinor: 60 })]), poId: 'po-f1' }, 'k1-again')).body).toMatchObject({ alreadyReceived: true });
    expect((await orderOf(h, 'po-f1')).order.receivedByProduct).toEqual({ p1: 60 });

    // The rest arrives: the order is fully received.
    await receive(h, 'u-mgr', 'grn-f2', { ...body([line({ lineId: 'L1', countedMinor: 40 }), line({ lineId: 'L2', productId: 'p3', orderedMinor: 20, countedMinor: 20, unitCost: cost(200) })]), poId: 'po-f1' }, 'k2');
    po = await orderOf(h, 'po-f1');
    expect(po.order.receivedByProduct).toEqual({ p1: 100, p3: 20 });
    expect(po.openCommitment).toMatchObject({ totalOpenValue: { minor: 0 }, fullyReceived: true });
    // …and both GRNs and the folded order rebuild the same way after a restart.
    const restarted = apiHarness({ store: h.store });
    expect((await orderOf(restarted, 'po-f1')).openCommitment).toMatchObject({ totalOpenValue: { minor: 0 }, fullyReceived: true });
    expect(await onHand(restarted, 'u-owner', 'p1')).toBe(100);
  });

  it('the ORDERED quantity is the order\'s, never the sender\'s: a body claiming 60 ordered when the order says 100 is measured against 100 and flagged (F07)', async () => {
    const h = await cast();
    await issuedOrder(h, 'po-f2', [{ productId: 'p1', orderedQty: 100, unitCostMinor: 5000 }]);
    // The sender says "60 ordered, 60 counted" — a clean delivery by its own account. The order says 100.
    const res = await receive(h, 'u-mgr', 'grn-f3', { ...body([line({ orderedMinor: 60, countedMinor: 60 })]), poId: 'po-f2' }, 'k1');
    expect(res.status).toBe(201);
    expect(grnOf(res).governanceFlags).toEqual(['ordered_quantity_disagrees']);
    expect(grnOf(res).captured?.discrepancies?.map((d) => d.kind)).toEqual(['short']); // 60 against the order's 100
    expect((await orderOf(h, 'po-f2')).openCommitment).toMatchObject({ totalOpenValue: { minor: 40 * 5000 } });
    // A product the order never named is received as-is and said.
    const extra = await receive(h, 'u-mgr', 'grn-f4', { ...body([line({ productId: 'p3', unitCost: cost(200) })]), poId: 'po-f2' }, 'k2');
    expect(grnOf(extra).governanceFlags).toEqual(['product_not_on_order']);
    expect(grnOf(extra).captured?.discrepancies).toEqual([]);
    expect((await orderOf(h, 'po-f2')).order.receivedByProduct).toEqual({ p1: 60, p3: 100 }); // visible over-receipt of what nobody ordered
  });

  it('what counts as RECEIVED against the order: quarantined stock yes (it is in the building), a held excess only when a second person accepts it, refused stock never', async () => {
    const h = await cast();
    await issuedOrder(h, 'po-f3', [{ productId: 'p1', orderedQty: 100, unitCostMinor: 5000 }, { productId: 'p3', orderedQty: 100, unitCostMinor: 200 }]);
    // Damaged p1: quarantined, not on hand — but the supplier delivered it, so the order shows it received.
    await receive(h, 'u-mgr', 'grn-q', { ...body([line({ condition: 'damaged' })]), poId: 'po-f3' }, 'k1');
    expect(await onHand(h, 'u-mgr', 'p1')).toBe(0);
    expect((await orderOf(h, 'po-f3')).order.receivedByProduct).toEqual({ p1: 100 });
    // p3: 110 against 100 at 5% → 100 received, 10 HELD. The held 10 are not received against the order yet.
    await receive(h, 'u-mgr', 'grn-x', { ...body([line({ productId: 'p3', countedMinor: 110, unitCost: cost(200) })]), poId: 'po-f3' }, 'k2');
    expect((await orderOf(h, 'po-f3')).order.receivedByProduct).toEqual({ p1: 100, p3: 100 });
    expect((await orderOf(h, 'po-f3')).openCommitment).toMatchObject({ totalOpenValue: { minor: 0 }, fullyReceived: true });
    // A second person accepts the excess: the 10 reach stock AND the order, which now shows the over-receipt as a signal.
    expect((await h.request({ method: 'POST', path: '/v1/inventory/goods-receipt/grn-x/excess/decide', userId: 'u-owner', tenantId: A, idempotencyKey: 'k3', body: { decision: 'approved', reason: 'supplier confirmed the extra 10 are free' } })).status).toBe(200);
    const po = await orderOf(h, 'po-f3');
    expect(po.order.receivedByProduct).toEqual({ p1: 100, p3: 110 });
    expect(po.openCommitment?.lines.find((l) => l.productId === 'p3')?.openQty).toBe(-10);
    expect(await onHand(h, 'u-mgr', 'p3')).toBe(110);
    // Expired p3 on a further GRN is refused at the dock: never on hand, never received against the order.
    await receive(h, 'u-mgr', 'grn-e', { ...body([line({ productId: 'p3', expiry: '2026-08-01', unitCost: cost(200) })]), poId: 'po-f3' }, 'k4');
    expect((await orderOf(h, 'po-f3')).order.receivedByProduct).toEqual({ p1: 100, p3: 110 });
    expect(await onHand(h, 'u-mgr', 'p3')).toBe(110);
  });

  it('a receipt against a PROPOSED order, an UNKNOWN order, or no order at all is received and SAID — and folds into nothing', async () => {
    const h = await cast();
    expect((await h.request({ method: 'POST', path: '/v1/purchase/orders/po-draft', userId: 'u-mgr', tenantId: A, idempotencyKey: 'po-draft',
      body: { supplierId: 'sup-1', lines: [{ productId: 'p1', orderedQty: 100, unitCost: cost(5000) }] } })).status).toBe(201);
    const draft = await receive(h, 'u-mgr', 'grn-d', { ...body([line()]), poId: 'po-draft' }, 'k1');
    expect(draft.status).toBe(201);
    expect(grnOf(draft).governanceFlags).toEqual(['order_not_issued']);
    expect((draft.body as { poReceipt: unknown }).poReceipt).toBeNull();
    expect((await orderOf(h, 'po-draft')).order.receivedByProduct).toEqual({});
    expect(await onHand(h, 'u-mgr', 'p1')).toBe(100); // the goods are in the building either way
    const ghost = await receive(h, 'u-mgr', 'grn-g', { ...body([line()]), poId: 'po-nobody-raised' }, 'k2');
    expect(grnOf(ghost).governanceFlags).toEqual(['order_unknown']);
    const none = await receive(h, 'u-mgr', 'grn-n', body([line()]), 'k3');
    expect(grnOf(none).governanceFlags).toEqual(['no_purchase_order']);
    expect((none.body as { poReceipt: unknown }).poReceipt).toBeNull();
  });
});
