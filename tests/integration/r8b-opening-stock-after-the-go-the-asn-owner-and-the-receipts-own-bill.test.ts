import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { useRestartableBackings } from '../support/p3-backings';
import { P3, p3Shop, caller, issuedOrder, capturedAndMatched, type Call } from '../support/p3-purchase';
import { prepareCutoverEvidence, askTheGate } from '../support/cutover-go';
import type { ApiHarness } from '../support/api-harness';

/**
 * **Round 8 · R8-B — receiving, by the owner's decisions of 28 Oct 2026.**
 *
 *   OB-529  the opening-stock exemption (no cost and no manufacture-date check for an `opening-` receipt with no order) holds
 *           ONLY before the cutover GO the gate recorded; after the GO such a receipt follows the full rules — a packed line
 *           without its month of manufacture is refused, and the cost is NOT KNOWN until a bill is matched (never the typed
 *           figure);
 *   OB-528  a difference from the supplier's advance ship notice (ASN) is owned by the buyer who raised the order;
 *   OB-530  the price-difference report uses only the bill matched to THAT receipt — a bill matched to the order, or to the
 *           order's other receipt, is never borrowed; "not yet billed" otherwise.
 * On the in-memory store and — with DATABASE_URL — on real PostgreSQL, with a cold restart. Synthetic data only.
 */

const backings = useRestartableBackings();
const AT = '2026-10-20T06:00:00.000Z';
const inr = (minor: number) => ({ minor, currency: 'INR' });
const code = (r: { body: unknown }): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
const PACKED = { categoryId: 'packed', name: 'Packed household', parentId: null, regulated: ['packed'] };
const LOOSE = { categoryId: 'loose', name: 'Loose household', parentId: null };
const DETERGENT = {
  sku: 'SKU-DET', name: 'Synthetic detergent 1kg', baseUom: 'each', primaryCategoryId: 'packed', taxClass: '34022010', lifecycle: 'active',
  safety: { netQuantity: '1 kg', packerDetails: 'Synthetic Packers, Chennai', countryOfOrigin: 'India', consumerCareContact: 'Synthetic Care, 1800-000-0000' },
  mrpHistory: [{ value: inr(150_00), effectiveFrom: '2026-01-01' }],
};
const BROOM = { sku: 'SKU-BRM', name: 'Synthetic broom', baseUom: 'each', primaryCategoryId: 'loose', taxClass: '96031000', lifecycle: 'active', mrpHistory: [{ value: inr(90_00), effectiveFrom: '2026-01-01' }] };

interface Grn {
  grnId: string; governanceFlags: string[];
  costNotKnown?: { lineId: string; because: string }[];
  billCosts?: { lineId: string; invoiceId: string; quantityMinor: number; valueMinor: number; costWasKnown?: boolean }[];
  discrepancyOwners?: { lineId: string; kind: string; role: string | null; owners: string[]; missing?: string }[];
  asnCheck?: { differences: { productId: string; differenceMinor: number }[] };
}
const grnOf = (r: { body: unknown }): Grn => (r.body as { grn: Grn }).grn;
const line = (lineId: string, productId: string, extra: Record<string, unknown> = {}) =>
  ({ lineId, productId, orderedMinor: 10, countedMinor: 10, uom: 'each', unitCost: inr(5_000), condition: 'good', ...extra });
const direct = (call: Call, grnId: string, lines: unknown[], poId?: string) =>
  call('POST', `/v1/inventory/goods-receipt/${grnId}`, P3.RECEIVER, { warehouseId: P3.BACK, receivedOnDate: '2026-10-20', currency: 'INR', ...(poId === undefined ? {} : { poId }), lines });

async function shop(h: ApiHarness, T: string): Promise<Call> {
  await p3Shop(h, T);
  const call = caller(h, T);
  for (const [productId, product, category] of [['p-det', DETERGENT, PACKED], ['p-brm', BROOM, LOOSE]] as const) {
    const r = await call('POST', `/v1/catalogue/products/${productId}/publish`, P3.OWNER, { product, categories: [category] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  }
  expect((await call('POST', '/v1/inventory/receipt-policy', P3.OWNER, { excessToleranceBp: 0, shortageToleranceBp: 0, nearExpiryDays: 7 })).status).toBe(201);
  return call;
}

describe.each(backings)('R8-B receiving — on $name', ({ harness }) => {
  it('OB-529: an opening-stock receipt is exempt only BEFORE the cutover GO; after it, the full rules', async () => {
    let h = harness();
    const T = randomUUID();
    const call = await shop(h, T);
    // Before the GO: the migration's opening load is taken as it is (the legacy cost, no date) — and said.
    const before = await direct(call, 'opening-load-1', [line('L1', 'p-det'), line('L2', 'p-brm')]);
    expect(before.status, JSON.stringify(before.body)).toBe(201);
    expect(grnOf(before).governanceFlags).toEqual(expect.arrayContaining(['opening_stock_cost_from_extract', 'manufacture_date_not_captured']));
    expect(grnOf(before).costNotKnown ?? []).toEqual([]);

    // The owner gives the cutover GO through the real gate.
    await h.provisionRole(T, 'u-owner2', 'owner');
    await prepareCutoverEvidence(h, { tenantId: T, ownerId: P3.OWNER, signerId: 'u-owner2', reconcilerId: P3.BUYER, deltaLocationId: 'S1-DELTA', storeIds: [P3.STORE] });
    const gate = await askTheGate(h, T, P3.OWNER, 'C-1', P3.OWNER);
    expect(gate.decision.go, JSON.stringify(gate.decision.failed)).toBe(true);

    // After the GO: a packed line without its month of manufacture is refused, by name, and the reason says why.
    const packed = await direct(call, 'opening-load-2', [line('L1', 'p-det')]);
    expect(packed.status).toBe(422);
    expect(code(packed)).toBe('manufacture_date_required');
    expect(JSON.stringify(packed.body)).toContain('OB-529');
    // …and the cost typed for a line with no order is NOT booked: cost not known until a bill is matched.
    const loose = await direct(call, 'opening-load-3', [line('L1', 'p-brm', { unitCost: inr(4_000) })]);
    expect(loose.status, JSON.stringify(loose.body)).toBe(201);
    expect(grnOf(loose).governanceFlags).toContain('cost_unknown');
    expect(grnOf(loose).governanceFlags).not.toContain('opening_stock_cost_from_extract');
    expect(grnOf(loose).costNotKnown).toEqual([expect.objectContaining({ lineId: 'L1', because: 'no_issued_order' })]);

    // A cold restart reads the same GO: still the full rules.
    h = harness(h);
    const after = caller(h, T);
    expect(code(await direct(after, 'opening-load-4', [line('L1', 'p-det')]))).toBe('manufacture_date_required');
  }, 240_000);

  it('OB-528 · OB-530: an ASN difference names the buyer; the report reads only the bill matched to THAT receipt', async () => {
    let h = harness();
    const T = randomUUID();
    const call = await shop(h, T);
    await issuedOrder(call, 'po-1', [{ productId: 'p-brm', qty: 22, unitMinor: 4_000 }]);
    // The supplier's ASN for po-1 advises 12 brooms; 10 arrive on the first delivery.
    await h.provisionRole(T, 'u-sup', 'supplier');
    expect((await call('POST', '/v1/supplier-portal/partners/sup-1', P3.BUYER, { grants: ['view_orders', 'submit_asn'], documents: [], requiredDocuments: [], logins: ['u-sup'] })).status).toBe(201);
    expect((await call('POST', '/v1/supplier-portal/me/submissions', 'u-sup', { submissionId: 'sub-ASN-1', kind: 'asn', document: { asnId: 'ASN-1', poId: 'po-1', expectedAt: AT, lines: [{ lineId: 'A1', productId: 'p-brm', quantityMinor: 12, uom: 'each' }] } })).status).toBe(201);
    expect((await call('POST', '/v1/supplier-portal/partners/sup-1/submissions/sub-ASN-1/review', P3.OWNER, { decision: 'accept', reason: 'booked for dock 2' })).status).toBe(201);
    const first = await direct(call, 'grn-1', [line('L1', 'p-brm', { orderedMinor: 22, unitCost: inr(4_000) })], 'po-1');
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const read = async (hh: ApiHarness, grnId: string) => grnOf(await hh.request({ method: 'GET', path: `/v1/inventory/goods-receipt/${grnId}`, userId: P3.OWNER, tenantId: T }));
    const g1 = await read(h, 'grn-1');
    expect(g1.asnCheck?.differences).toEqual([expect.objectContaining({ productId: 'p-brm', differenceMinor: -2 })]);
    expect(g1.discrepancyOwners?.find((o) => o.kind === 'asn_difference')).toMatchObject({ lineId: 'asn:p-brm', role: 'buyer', owners: [P3.BUYER] });

    // The second delivery on the same order; the bill for the order is matched (three-way) — but to NEITHER receipt yet.
    expect((await direct(call, 'grn-2', [line('L1', 'p-brm', { orderedMinor: 22, countedMinor: 12, unitCost: inr(4_000) })], 'po-1')).status).toBe(201);
    await capturedAndMatched(call, 'INV-1', 'po-1', [{ productId: 'p-brm', qty: 22, unitMinor: 4_200 }]);
    const ppv = async (hh: ApiHarness) => (await hh.request({ method: 'GET', path: '/v1/purchase/price-variance', userId: P3.OWNER, tenantId: T, query: { from: '2026-01-01', to: '2030-12-31' } })).body as { lines: { grnId: string; notCompared?: string; receivedUnitCost: { minor: number } | null; invoiceId: string | null; order?: { varianceMinor: number } }[] };
    expect((await ppv(h)).lines.map((l) => [l.grnId, l.notCompared ?? null, l.invoiceId])).toEqual([['grn-1', 'not_yet_billed', null], ['grn-2', 'not_yet_billed', null]]);

    // The accountant matches the bill to grn-1 (its cost was the order's — compared, not revalued). The receiver may not.
    expect(code(await call('POST', '/v1/inventory/goods-receipt/grn-1/bill-match', P3.RECEIVER, { invoiceId: 'INV-1' }))).toBe('self_match');
    const m = await call('POST', '/v1/inventory/goods-receipt/grn-1/bill-match', P3.MATCHER, { invoiceId: 'INV-1' });
    expect(m.status, JSON.stringify(m.body)).toBe(201);
    expect(m.body).toMatchObject({ matched: [{ lineId: 'L1', invoiceId: 'INV-1', quantityMinor: 0, valueMinor: 0, costWasKnown: true }] });
    const report = await ppv(h);
    expect(report.lines.find((l) => l.grnId === 'grn-1')).toMatchObject({ receivedUnitCost: { minor: 4_200 }, invoiceId: 'INV-1', order: { varianceMinor: 10 * 200 } });
    // grn-2's bill is NOT borrowed from grn-1 or from the order.
    expect(report.lines.find((l) => l.grnId === 'grn-2')).toMatchObject({ notCompared: 'not_yet_billed', receivedUnitCost: null, invoiceId: null });
    // The stock value is unchanged by a bill matched to known-cost goods (22 at the order's ₹40.00).
    const value = (await h.request({ method: 'GET', path: '/v1/inventory/valuation', userId: P3.OWNER, tenantId: T, query: { productId: 'p-brm' } })).body as { rows: { locationId: string; value: { minor: number } }[] };
    expect(value.rows.find((r) => r.locationId === P3.BACK)?.value.minor).toBe(22 * 4_000);

    // A cold restart reads the same.
    h = harness(h);
    expect((await read(h, 'grn-1')).billCosts).toEqual([expect.objectContaining({ lineId: 'L1', invoiceId: 'INV-1', costWasKnown: true })]);
    expect((await ppv(h)).lines.map((l) => [l.grnId, l.invoiceId])).toEqual([['grn-1', 'INV-1'], ['grn-2', null]]);
    expect((await read(h, 'grn-1')).discrepancyOwners?.find((o) => o.kind === 'asn_difference')?.owners).toEqual([P3.BUYER]);
  }, 120_000);
});
