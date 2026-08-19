import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// M07-FR-01/02/03 (D03-FR-02): goods receipt / GRN capture on the live API — the back door of the shop,
// where most money is lost. The cloud boundary re-runs the tested captureReceipt: a batch-tracked item with
// no batch or no expiry is REFUSED (M10); expired stock is rejected, never received as sellable; damaged /
// QC-failed stock goes to QUARANTINE (not available to sell, M07-FR-03); short/excess/MRP lines raise valued
// discrepancies and an over-tolerance excess needs a second person (§28). Only the SELLABLE quantity becomes
// availability, and the GRN + its movements are one atomic append. Idempotent on the GRN id (§31.1).
// Gated inventory.movement.append (Receiver/QC); reads inventory.availability.read.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const INR = 'INR';
const POLICY = { excessToleranceBp: 500, shortageToleranceBp: 200, nearExpiryDays: 7 };
const cost = (minor: number) => ({ minor, currency: INR });

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
const grnOf = (res: { body: unknown }): { availableMinor?: number; captured?: { requiresApproval?: boolean; discrepancies?: { kind: string }[]; lines?: { disposition: string; sellableMinor: number; quarantinedMinor: number }[] } } =>
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
const body = (lines: unknown[], rules: unknown[] = [{ productId: 'p1', batchTracked: false }]) =>
  ({ warehouseId: 'wh1', receivedOnDate: '2026-08-18', currency: INR, lines, rules, policy: POLICY });

async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-mgr', 'store_manager'); // has inventory.movement.append
  await h.provisionRole(A, 'u-cash', 'cashier');       // does not
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

  it('refuses a batch-tracked line with no batch or no expiry (you cannot recall what you cannot identify)', async () => {
    const h = await cast();
    const rules = [{ productId: 'p2', batchTracked: true }];
    const noBatch = await receive(h, 'u-mgr', 'grn-2', body([line({ productId: 'p2' })], rules), 'k1');
    expect(noBatch.status).toBe(422);
    expect(codeOf(noBatch)).toBe('receipt_line_incomplete');
    // Nothing was received.
    expect(await onHand(h, 'u-mgr', 'p2')).toBe(0);
    // With batch but no expiry → still refused.
    expect((await receive(h, 'u-mgr', 'grn-2', body([line({ productId: 'p2', batchId: 'B1' })], rules), 'k2')).status).toBe(422);
    // With both → received.
    expect((await receive(h, 'u-mgr', 'grn-2', body([line({ productId: 'p2', batchId: 'B1', expiry: '2027-01-01' })], rules), 'k3')).status).toBe(201);
  });

  it('quarantines damaged / QC-failed / expired stock — it never becomes available to sell', async () => {
    const h = await cast();
    // Damaged → quarantined, sellable 0.
    const dmg = await receive(h, 'u-mgr', 'grn-3', body([line({ condition: 'damaged' })]), 'k1');
    expect(grnOf(dmg).captured?.lines?.[0]).toMatchObject({ disposition: 'quarantine', sellableMinor: 0, quarantinedMinor: 100 });
    expect(await onHand(h, 'u-mgr', 'p1')).toBe(0); // quarantine is not availability

    // Expired at receipt → rejected, and it needs approval.
    const exp = await receive(h, 'u-mgr', 'grn-4', body([line({ productId: 'p3', expiry: '2026-08-01' })], [{ productId: 'p3', batchTracked: false }]), 'k2');
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

    // Excess beyond tolerance (10% over the 5% limit) → needs approval.
    const excess = await receive(h, 'u-mgr', 'grn-6', body([line({ productId: 'p4', countedMinor: 110 })], [{ productId: 'p4', batchTracked: false }]), 'k2');
    expect(grnOf(excess).captured?.requiresApproval).toBe(true);
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

  it('gates receiving on inventory.movement.append (a cashier cannot receive), and refuses a malformed body', async () => {
    const h = await cast();
    expect((await receive(h, 'u-cash', 'grn-8', body([line()]), 'k1')).status).toBe(403);
    // Empty lines / missing policy → 400.
    expect(codeOf(await receive(h, 'u-mgr', 'grn-9', { warehouseId: 'wh1', receivedOnDate: '2026-08-18', currency: INR, lines: [], rules: [], policy: POLICY }, 'k2'))).toBe('not_readable_as_a_goods_receipt');
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
