import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';
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
  await h.provisionRole(A, 'u-mgr', 'store_manager'); // has inventory.movement.append
  await h.provisionRole(A, 'u-cash', 'cashier');       // does not
  await h.store.append(A, STREAM.catalogue, makeEvent({
    id: `pack-${A}-1`, type: 'CataloguePublished', occurredAt: AT, idempotencyKey: `catalogue-${A}-v1`, source: 'test/catalogue',
    payload: {
      snapshot: {
        tenantId: A, version: 1, builtAt: AT, scope: { tenantId: A, storeId: 'store-1' },
        products: [
          { productId: 'p1', sku: 'p1', name: 'Toor dal 1kg', unitPriceMinor: 16_000, taxBps: 0, status: 'active', uom: 'each', batchTracked: false },
          { productId: 'p2', sku: 'p2', name: 'Fresh paneer 200g', unitPriceMinor: 9_000, taxBps: 500, status: 'active', uom: 'each', batchTracked: true },
          { productId: 'p3', sku: 'p3', name: 'Biscuits 100g', unitPriceMinor: 2_000, taxBps: 1800, status: 'active', uom: 'each', batchTracked: false },
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
    expect(grnOf(ok).governanceFlags).toEqual([]);
  });

  it('a product the master does not know is received — goods in the building are never refused for paperwork — and the record SAYS the rule was unverified', async () => {
    const h = await cast();
    const res = await receive(h, 'u-mgr', 'grn-unknown', body([line({ productId: 'p-not-on-master' })]), 'k1');
    expect(res.status).toBe(201);
    expect(grnOf(res).governanceFlags).toEqual(['product_rules_unverified']);
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
});
