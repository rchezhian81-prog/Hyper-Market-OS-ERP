import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { useRestartableBackings } from '../support/p3-backings';
import { P3, p3Shop, caller, issuedOrder, capturedAndMatched, type Call } from '../support/p3-purchase';
import type { ApiHarness } from '../support/api-harness';
import { packedProductIdsFor } from '../../services/api/src/r7b-receiving-adapters';

/**
 * **Round 7 · R7-B — goods receiving, by the owner's decisions of 28 Oct 2026.**
 *
 *   OB-504 (B4)  a PACKED product's batch is not received without its month and year of manufacture — refused by name
 *                (`manufacture_date_required`) on the direct receipt, on the manager screen's relayed receipt, on the
 *                handheld's scans, and when a buyer accepts the supplier's ASN; an opening-stock load is taken as it is and SAID;
 *   OB-509       a line with no issued order, or not on the order, is booked with its cost NOT KNOWN (never the typed
 *                figure) until the supplier's bill is matched to the receipt; the relayed receipt takes the ORDER's cost;
 *   OB-508       every discrepancy carries a named owner: short / excess / cost difference → the buyer who raised the
 *                order; damaged / QC-failed / expired / temperature → the receiving store's managers; nobody → said;
 *   OB-517       the purchase-price variance's received cost is the matched bill's; unbilled lines are "not yet billed".
 * On the in-memory store and — with DATABASE_URL — on real PostgreSQL, with a cold restart. Synthetic data only.
 */

const backings = useRestartableBackings();
const AT = '2026-10-20T06:00:00.000Z';
const inr = (minor: number) => ({ minor, currency: 'INR' });
const PACKED = { categoryId: 'packed', name: 'Packed household', parentId: null, regulated: ['packed'] };
const LOOSE = { categoryId: 'loose', name: 'Loose household', parentId: null };
const DETERGENT = {
  sku: 'SKU-DET', name: 'Synthetic detergent 1kg', baseUom: 'each', primaryCategoryId: 'packed', taxClass: '34022010', lifecycle: 'active',
  safety: { netQuantity: '1 kg', packerDetails: 'Synthetic Packers, Chennai', countryOfOrigin: 'India', consumerCareContact: 'Synthetic Care, 1800-000-0000' },
  mrpHistory: [{ value: inr(150_00), effectiveFrom: '2026-01-01' }],
};
const BROOM = { sku: 'SKU-BRM', name: 'Synthetic broom', baseUom: 'each', primaryCategoryId: 'loose', taxClass: '96031000', lifecycle: 'active', mrpHistory: [{ value: inr(90_00), effectiveFrom: '2026-01-01' }] };
const code = (r: { body: unknown }): string | undefined => (r.body as { error?: { code?: string } }).error?.code;

interface Grn {
  grnId: string; governanceFlags: string[]; poId: string | null;
  captured: { lines: { lineId: string; productId: string; manufacturedOn?: string; costNotKnown?: boolean; unitCost: { minor: number } }[]; discrepancies: { lineId: string; kind: string; valueNotKnown?: boolean }[] };
  costNotKnown?: { lineId: string; productId: string; because: string; typedUnitCost?: { minor: number } }[];
  billCosts?: { lineId: string; invoiceId: string; unitCost: { minor: number }; valueMinor: number }[];
  discrepancyOwners?: { lineId: string; kind: string; role: string | null; owners: string[]; missing?: string }[];
}
const grnOf = (r: { body: unknown }): Grn => (r.body as { grn: Grn }).grn;

async function shop(h: ApiHarness, T: string): Promise<Call> {
  await p3Shop(h, T);
  await h.provisionRole(T, 'u-box', 'store_computer', [P3.STORE]);
  await h.provisionRole(T, 'u-sm-other', 'store_manager', ['store-2']); // a manager of ANOTHER store — never named here
  const call = caller(h, T);
  const publish = async (productId: string, product: unknown, category: unknown) => {
    const r = await call('POST', `/v1/catalogue/products/${productId}/publish`, P3.OWNER, { product, categories: [category] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  };
  await publish('p-det', DETERGENT, PACKED);
  await publish('p-brm', BROOM, LOOSE);
  expect((await call('POST', '/v1/inventory/receipt-policy', P3.OWNER, { excessToleranceBp: 0, shortageToleranceBp: 0, nearExpiryDays: 7 })).status).toBe(201);
  return call;
}

const line = (lineId: string, productId: string, extra: Record<string, unknown> = {}) =>
  ({ lineId, productId, orderedMinor: 10, countedMinor: 10, uom: 'each', unitCost: inr(5_000), condition: 'good', ...extra });
const direct = (call: Call, grnId: string, lines: unknown[], poId?: string, by: string = P3.RECEIVER) =>
  call('POST', `/v1/inventory/goods-receipt/${grnId}`, by, { warehouseId: P3.BACK, receivedOnDate: '2026-10-20', currency: 'INR', ...(poId === undefined ? {} : { poId }), lines });

describe.each(backings)('R7-B goods receiving — on $name', ({ harness }) => {
  it('OB-504: a packed batch is refused by name without its month and year of manufacture, on every receiving path', async () => {
    let h = harness();
    const T = randomUUID();
    const call = await shop(h, T);
    const onHand = async (hh: ApiHarness, productId: string) => ((await hh.request({ method: 'GET', path: '/v1/inventory/availability', userId: P3.OWNER, tenantId: T, query: { productId } })).body as { rows: { onHandMinor: number }[] }).rows.reduce((s, r) => s + r.onHandMinor, 0);

    // Direct: refused without it, and with one it cannot read; nothing reaches stock.
    const none = await direct(call, 'g-none', [line('L1', 'p-det')]);
    expect(none.status).toBe(422);
    expect(code(none)).toBe('manufacture_date_required');
    expect(JSON.stringify(none.body)).toContain('manufacture date');
    expect(code(await direct(call, 'g-bad', [line('L1', 'p-det', { manufacturedOn: '09/2026' })]))).toBe('manufacture_date_required');
    expect(await onHand(h, 'p-det')).toBe(0);
    // With it: received, and the date is on the line. A product that is not packed needs none.
    const ok = await direct(call, 'g-ok', [line('L1', 'p-det', { manufacturedOn: '2026-09' }), line('L2', 'p-brm')]);
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(grnOf(ok).captured.lines.find((l) => l.productId === 'p-det')?.manufacturedOn).toBe('2026-09');
    expect(await onHand(h, 'p-det')).toBe(10);

    // The manager screen's receipt relayed by the store computer: refused (the box keeps it as a dead letter), then booked.
    const relay = (grnId: string, mfg?: string) => call('POST', `/v1/inventory/goods-receipt/${grnId}/synced`, 'u-box', {
      grnId, number: grnId, poId: null, warehouseId: P3.BACK, receivedBy: P3.RECEIVER, receivedAt: AT, storeId: P3.STORE, source: 'manager-screen',
      lines: [{ productId: 'p-det', quantityMinor: 4, uom: 'each', batchId: null, ...(mfg === undefined ? {} : { manufacturedOn: mfg }) }],
    });
    const relayedNone = await relay('g-rel-1');
    expect(relayedNone.status).toBe(422);
    expect(code(relayedNone)).toBe('manufacture_date_required');
    expect((await relay('g-rel-2', '2026-08-15')).status).toBe(202);

    // The handheld's scans: a packed scan without the month is refused (nothing posted); with it, it posts and is kept.
    const scan = (commandId: string, mfg?: string) => call('POST', `/v1/inventory/receiving-scans/${commandId}/synced`, 'u-box', {
      commandId, grnId: 'g-hh', productId: 'p-det', batchId: 'B-9', quantityMinor: 3, uom: 'each', source: 'po', poId: null, state: 'on_hand', expiry: null,
      receivedBy: P3.RECEIVER, storeId: P3.STORE, at: AT, ...(mfg === undefined ? {} : { manufacturedOn: mfg }),
    });
    const scanNone = await scan('c-0');
    expect(scanNone.status).toBe(422);
    expect(code(scanNone)).toBe('manufacture_date_required');
    expect((await scan('c-1', '2026-07')).status).toBe(202);
    const scans = (await call('GET', '/v1/inventory/receiving-scans?grnId=g-hh', P3.OWNER)).body as unknown;
    void scans;
    const done = await call('POST', '/v1/inventory/goods-receipt/g-hh/assembled', 'u-box', { grnId: 'g-hh', completedBy: P3.RECEIVER, storeId: P3.STORE, at: AT, source: 'warehouse-handheld' });
    expect(done.status, JSON.stringify(done.body)).toBe(202);
    expect(grnOf(done).captured.lines[0]?.manufacturedOn).toBe('2026-07');

    // An OPENING-stock load (the migration's receipts) is not goods received: taken as it is, and SAID.
    const opening = await direct(call, 'opening-load-1', [line('L1', 'p-det')]);
    expect(opening.status).toBe(201);
    expect(grnOf(opening).governanceFlags).toEqual(expect.arrayContaining(['opening_stock_cost_from_extract', 'manufacture_date_not_captured']));

    // The store pack carries which products are packed — the screens refuse offline from it.
    expect(await packedProductIdsFor({ store: h.store, now: () => AT }, T)).toEqual(['p-det']);

    // The supplier's ASN: a packed line with no month of manufacture is refused when the buyer accepts it; with it, accepted.
    await h.provisionRole(T, 'u-sup', 'supplier');
    expect((await call('POST', '/v1/supplier-portal/partners/sup-1', P3.BUYER, { grants: ['view_orders', 'submit_asn'], documents: [], requiredDocuments: [], logins: ['u-sup'] })).status).toBe(201);
    const submitAndReview = async (asnId: string, lines: unknown[]) => {
      expect((await call('POST', '/v1/supplier-portal/me/submissions', 'u-sup', { submissionId: `sub-${asnId}`, kind: 'asn', document: { asnId, expectedAt: AT, lines } })).status).toBe(201);
      return call('POST', `/v1/supplier-portal/partners/sup-1/submissions/sub-${asnId}/review`, P3.OWNER, { decision: 'accept', reason: 'booked for dock 2' });
    };
    const asnNone = await submitAndReview('ASN-1', [{ lineId: 'A1', productId: 'p-det', quantityMinor: 10, uom: 'each', batchId: 'B-1' }, { lineId: 'A2', productId: 'p-brm', quantityMinor: 5, uom: 'each' }]);
    expect(asnNone.status).toBe(422);
    expect(code(asnNone)).toBe('manufacture_date_required');
    expect(JSON.stringify(asnNone.body)).toContain('A1 (p-det)');
    const asnOk = await submitAndReview('ASN-2', [{ lineId: 'A1', productId: 'p-det', quantityMinor: 10, uom: 'each', batchId: 'B-1', manufacturedOn: '2026-09' }]);
    expect(asnOk.status, JSON.stringify(asnOk.body)).toBe(201);

    // A cold restart reads the same receipt, its date on the line.
    h = harness(h);
    const read = await h.request({ method: 'GET', path: '/v1/inventory/goods-receipt/g-ok', userId: P3.OWNER, tenantId: T });
    expect(grnOf(read).captured.lines.find((l) => l.productId === 'p-det')?.manufacturedOn).toBe('2026-09');
  }, 120_000);

  it('OB-509 · OB-517 · R7 task 3: no order (or not on it) → cost NOT KNOWN until the bill is matched; the relayed receipt takes the order\'s cost; the PPV reads the bill', async () => {
    let h = harness();
    const T = randomUUID();
    const call = await shop(h, T);
    const value = async (hh: ApiHarness, productId: string) => ((await hh.request({ method: 'GET', path: '/v1/inventory/valuation', userId: P3.OWNER, tenantId: T, query: { productId } })).body as { rows: { locationId: string; onHandMinor: number; value: { minor: number }; unvaluedMinor: number }[] }).rows.filter((r) => r.locationId === P3.BACK);

    // No order: the ₹50.00 typed at the door is kept beside the line, NOT booked; the stock is unvalued (not ₹0).
    const noOrder = await direct(call, 'g-dsd', [line('L1', 'p-brm', { countedMinor: 10, orderedMinor: 10, unitCost: inr(5_000) })]);
    expect(noOrder.status).toBe(201);
    const g1 = grnOf(noOrder);
    expect(g1.governanceFlags).toEqual(expect.arrayContaining(['no_purchase_order', 'cost_unknown']));
    expect(g1.costNotKnown).toEqual([expect.objectContaining({ lineId: 'L1', productId: 'p-brm', because: 'no_issued_order', typedUnitCost: inr(5_000) })]);
    expect(g1.captured.lines[0]).toMatchObject({ costNotKnown: true });
    expect(await value(h, 'p-brm')).toEqual([expect.objectContaining({ onHandMinor: 10, value: inr(0), unvaluedMinor: 10 })]);

    // Against an issued order, a product the order does not name is also NOT KNOWN; the ordered one takes the order's cost.
    await issuedOrder(call, 'po-1', [{ productId: 'p-det', qty: 10, unitMinor: 6_000 }]);
    const offOrder = await direct(call, 'g-po', [line('L1', 'p-det', { manufacturedOn: '2026-09', unitCost: inr(6_000) }), line('L2', 'p-brm', { unitCost: inr(4_000) })], 'po-1');
    expect(offOrder.status, JSON.stringify(offOrder.body)).toBe(201);
    const g2 = grnOf(offOrder);
    expect(g2.costNotKnown).toEqual([expect.objectContaining({ lineId: 'L2', because: 'not_on_order', typedUnitCost: inr(4_000) })]);
    expect(g2.captured.lines.find((l) => l.lineId === 'L1')?.unitCost.minor).toBe(6_000);

    // R7 task 3 — the manager screen's relayed receipt against an issued order is booked at the ORDER's cost (₹60.00).
    await issuedOrder(call, 'po-2', [{ productId: 'p-det', qty: 5, unitMinor: 6_000 }]);
    const relayed = await call('POST', '/v1/inventory/goods-receipt/g-rel/synced', 'u-box', {
      grnId: 'g-rel', number: 'g-rel', poId: 'po-2', warehouseId: P3.BACK, receivedBy: P3.RECEIVER, receivedAt: AT, storeId: P3.STORE, source: 'manager-screen',
      lines: [{ productId: 'p-det', quantityMinor: 5, uom: 'each', batchId: null, manufacturedOn: '2026-09' }],
    });
    expect(relayed.status, JSON.stringify(relayed.body)).toBe(202);
    expect(grnOf(relayed).captured.lines[0]?.unitCost.minor).toBe(6_000);
    expect(grnOf(relayed).governanceFlags).not.toContain('cost_unknown');
    expect((await value(h, 'p-det'))[0]).toMatchObject({ onHandMinor: 15, value: inr(15 * 6_000), unvaluedMinor: 0 });

    // The receipts list counts the ones still waiting for a bill.
    const list = (await call('GET', '/v1/inventory/goods-receipt', P3.OWNER)).body as { costNotKnownCount: number };
    expect(list.costNotKnownCount).toBe(2);

    // OB-509: the supplier's bill for the no-order delivery (₹42.00 a broom), captured by the buyer, matched by the accountant
    // to the receipt: the line's cost becomes the bill's and its 10 unvalued brooms are valued at it.
    expect((await call('POST', '/v1/purchase/invoices/INV-DSD/capture', P3.BUYER, { supplierId: 'sup-1', poId: null, declaredTotalMinor: 42_000, lines: [{ productId: 'p-brm', quantity: 10, unitPriceMinor: 4_200, lineTotalMinor: 42_000 }] })).status).toBe(201);
    // Refusals: the receiver may not match their own delivery (§28); a cashier may not match at all; a bill for another order; an unknown bill; a typed cost.
    expect(code(await call('POST', '/v1/inventory/goods-receipt/g-dsd/bill-match', P3.RECEIVER, { invoiceId: 'INV-DSD' }))).toBe('self_match');
    expect((await call('POST', '/v1/inventory/goods-receipt/g-dsd/bill-match', P3.CASHIER, { invoiceId: 'INV-DSD' })).status).toBe(403);
    expect(code(await call('POST', '/v1/inventory/goods-receipt/g-po/bill-match', P3.MATCHER, { invoiceId: 'INV-DSD' }))).toBe('bill_for_another_order');
    expect(code(await call('POST', '/v1/inventory/goods-receipt/g-dsd/bill-match', P3.MATCHER, { invoiceId: 'INV-NOBODY' }))).toBe('bill_unknown');
    expect(code(await call('POST', '/v1/inventory/goods-receipt/g-dsd/bill-match', P3.MATCHER, { invoiceId: 'INV-DSD', unitCost: inr(1) }))).toBe('not_readable_as_a_bill_match');
    expect((await value(h, 'p-brm')).find((r) => r.onHandMinor > 0)?.unvaluedMinor).toBeGreaterThan(0);
    const matched = await call('POST', '/v1/inventory/goods-receipt/g-dsd/bill-match', P3.MATCHER, { invoiceId: 'INV-DSD' });
    expect(matched.status, JSON.stringify(matched.body)).toBe(201);
    expect(matched.body).toMatchObject({ matched: [{ lineId: 'L1', invoiceId: 'INV-DSD', unitCost: inr(4_200), quantityMinor: 10, valueMinor: 42_000 }], stillNotKnown: [] });
    // Once only: the same bill again is "already matched"; the stock is valued once.
    expect((await call('POST', '/v1/inventory/goods-receipt/g-dsd/bill-match', P3.MATCHER, { invoiceId: 'INV-DSD' })).body).toMatchObject({ alreadyMatched: true });

    // OB-517 — the PPV: po-1's dal line is "not yet billed" until its bill is matched; the no-order broom shows the bill.
    const ppv = async (hh: ApiHarness) => (await hh.request({ method: 'GET', path: '/v1/purchase/price-variance', userId: P3.OWNER, tenantId: T, query: { from: '2026-01-01', to: '2027-12-31' } })).body as { lines: { grnId: string; productId: string; notCompared?: string; receivedUnitCost: { minor: number } | null; invoiceId: string | null; order?: { varianceMinor: number } }[] };
    let report = await ppv(h);
    expect(report.lines.find((l) => l.grnId === 'g-po' && l.productId === 'p-det')).toMatchObject({ notCompared: 'not_yet_billed', receivedUnitCost: null, invoiceId: null });
    expect(report.lines.find((l) => l.grnId === 'g-dsd')).toMatchObject({ receivedUnitCost: { minor: 4_200 }, invoiceId: 'INV-DSD' });
    await capturedAndMatched(call, 'INV-PO1', 'po-1', [{ productId: 'p-det', qty: 10, unitMinor: 6_300 }]);
    // OB-530 (round 8): only the bill matched to THAT receipt counts — matched to the order alone, the line is still unbilled.
    expect((await ppv(h)).lines.find((l) => l.grnId === 'g-po' && l.productId === 'p-det')).toMatchObject({ notCompared: 'not_yet_billed', invoiceId: null });
    expect((await call('POST', '/v1/inventory/goods-receipt/g-po/bill-match', P3.MATCHER, { invoiceId: 'INV-PO1' })).status).toBe(201);
    report = await ppv(h);
    expect(report.lines.find((l) => l.grnId === 'g-po' && l.productId === 'p-det')).toMatchObject({ receivedUnitCost: { minor: 6_300 }, invoiceId: 'INV-PO1', order: { varianceMinor: 10 * 300 } });

    // A cold restart reads the same: the broom's cost known from its bill, valued once, the variance from the bill.
    h = harness(h);
    // 20 brooms on hand: the 10 from the no-order delivery now valued at their bill; the 10 not on po-1 still wait for theirs.
    expect((await value(h, 'p-brm'))[0]).toMatchObject({ onHandMinor: 20, value: inr(42_000), unvaluedMinor: 10 });
    const reread = grnOf(await h.request({ method: 'GET', path: '/v1/inventory/goods-receipt/g-dsd', userId: P3.OWNER, tenantId: T }));
    expect(reread.billCosts).toEqual([expect.objectContaining({ lineId: 'L1', invoiceId: 'INV-DSD', valueMinor: 42_000 })]);
    expect((await ppv(h)).lines.find((l) => l.grnId === 'g-po' && l.productId === 'p-det')?.invoiceId).toBe('INV-PO1');
  }, 120_000);

  it('OB-508: every discrepancy names its owner — the buyer who raised the order, or the receiving store\'s managers — and says when nobody is named', async () => {
    let h = harness();
    const T = randomUUID();
    const call = await shop(h, T);
    await issuedOrder(call, 'po-1', [{ productId: 'p-det', qty: 10, unitMinor: 6_000 }, { productId: 'p-brm', qty: 10, unitMinor: 4_000 }]);
    // 8 detergent (2 short), typed at ₹59.00 (a cost difference), 10 brooms damaged.
    const res = await direct(call, 'g-1', [line('L1', 'p-det', { countedMinor: 8, manufacturedOn: '2026-09', unitCost: inr(5_900) }), line('L2', 'p-brm', { condition: 'damaged', unitCost: inr(4_000) })], 'po-1');
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const read = async (hh: ApiHarness) => grnOf(await hh.request({ method: 'GET', path: '/v1/inventory/goods-receipt/g-1', userId: P3.OWNER, tenantId: T }));
    const owners = (await read(h)).discrepancyOwners!;
    expect(owners.find((o) => o.kind === 'short')).toMatchObject({ lineId: 'L1', role: 'buyer', owners: [P3.BUYER] });
    expect(owners.find((o) => o.kind === 'cost_difference')).toMatchObject({ lineId: 'L1', role: 'buyer', owners: [P3.BUYER] });
    const damaged = owners.find((o) => o.kind === 'damaged')!;
    expect(damaged.role).toBe('store_manager');
    expect(damaged.owners).toContain(P3.RECEIVER); // a store manager of store-1 (by the role grants for that branch)
    expect(damaged.owners).not.toContain('u-sm-other'); // the manager of another store is never named
    // The list carries them too.
    const list = (await call('GET', '/v1/inventory/goods-receipt', P3.OWNER)).body as { receipts: Grn[] };
    expect(list.receipts.find((g) => g.grnId === 'g-1')?.discrepancyOwners).toEqual(owners);

    // A shop with NO store manager granted for the store: said, never invented. A no-order shortage names no buyer.
    const T2 = randomUUID();
    await h.seedOwner(T2, P3.OWNER);
    const call2 = caller(h, T2);
    const r2 = await call2('POST', '/v1/inventory/goods-receipt/g-x', P3.OWNER, { warehouseId: 'wh-x', receivedOnDate: '2026-10-20', currency: 'INR', lines: [
      { lineId: 'L1', productId: 'p-x', orderedMinor: 10, countedMinor: 10, uom: 'each', unitCost: inr(100), condition: 'damaged' },
    ] });
    expect(r2.status, JSON.stringify(r2.body)).toBe(201);
    const o2 = grnOf(await h.request({ method: 'GET', path: '/v1/inventory/goods-receipt/g-x', userId: P3.OWNER, tenantId: T2 })).discrepancyOwners!;
    expect(o2).toEqual([expect.objectContaining({ kind: 'damaged', role: 'store_manager', owners: [], missing: 'no_store_manager_named' })]);

    // A cold restart reads the same owners.
    h = harness(h);
    expect((await read(h)).discrepancyOwners).toEqual(owners);
  }, 120_000);
});
