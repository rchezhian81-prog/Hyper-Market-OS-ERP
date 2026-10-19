import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { approvedSuppliers, deliveryPlaces } from '../support/approved-supplier';
import { sentWithApproval } from '../support/approval-request';
import { seedSubstitutionTruth, recordOrderRules } from '../support/substitution-truth';
import { sellOnline } from '../support/sell-online';
import { recordingTransport } from '../../packages/notifications/src/transport';
import { signedReport, testProviderSecret, TEST_PROVIDER } from '../support/provider-report';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';

/**
 * **D13 round 8 — the buying, fulfilment, customer and assistant reports that had no head-office producer now reconcile to
 * the registers their domains write, through the REAL API surface (in memory and, with DATABASE_URL, real PostgreSQL).**
 *
 *   • supplier service = the order register's ordered and goods-receipt-posted units per supplier;
 *   • invoice differences = each captured bill's latest three-way-match verdict (= GET /v1/purchase/invoices/:id);
 *   • online orders and substitutions, deliveries on time (against the booked slot), and what a delivery earns (order value
 *     less goods at the OB-39 average buying cost less the delivery cost) — NOT AVAILABLE, naming the stop, when any is missing;
 *   • campaigns and complaints = the campaign's own status route and the service desk's cases;
 *   • what the assistant suggested = GET /v1/ai/proposals, beside the decisions people recorded on it;
 *   • company-wide registers are refused in words to a branch-limited reader — never shown in part.
 * Synthetic data only; no live provider (the recording transport and a test provider secret built at run time).
 */

interface Fig { name: string; valueMinor?: number; notAvailableBecause?: string; asAt: string | null }
interface Report { figures: Fig[]; rows: Record<string, string>[]; sources: { source: string; lastEventAt: string | null }[]; period?: { from: string; to: string } }

const DATABASE_URL = process.env['DATABASE_URL'];
let pool: Pool | undefined;
beforeAll(async () => {
  if (DATABASE_URL === undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
  const dir = 'db/migrations';
  await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
});
afterAll(async () => { await pool?.end(); });

const SECRET = testProviderSecret();
const SECRETS = new Map([[TEST_PROVIDER, SECRET]]);
const backings: { name: string; harness: () => ApiHarness }[] = [{ name: 'the in-memory event store', harness: () => apiHarness({ notificationTransport: recordingTransport(), deliveryReportSecrets: SECRETS }) }];
if (DATABASE_URL !== undefined) {
  backings.push({ name: 'real PostgreSQL', harness: () => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql), notificationTransport: recordingTransport(), deliveryReportSecrets: SECRETS }); } });
}

const STORE = { lat: 11.0168, lon: 76.9558 };
const NEAR = { lat: 11.0300, lon: 76.9700 };
const line = (productId: string, quantity: number, unitPriceMinor: number) => ({ productId, quantity, unitPriceMinor, lineTotalMinor: quantity * unitPriceMinor });

describe.each(backings)('D13 — the other buying, fulfilment, customer and assistant reports reconcile — on $name', ({ harness }) => {
  let h: ApiHarness;
  const T = randomUUID();
  const call = (method: 'GET' | 'POST' | 'PUT', path: string, userId: string, body?: unknown, query?: Record<string, string>, branchId?: string) =>
    h.request({ method, path, userId, tenantId: T, ...(method === 'GET' ? {} : { idempotencyKey: `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }), ...(branchId === undefined ? {} : { branchId }) });
  const ok = async (p: ReturnType<typeof call>, ...statuses: number[]) => {
    const r = await p;
    expect(statuses, JSON.stringify(r.body)).toContain(r.status);
    return r;
  };
  const report = async (name: string, userId = 'u-owner', branchId?: string): Promise<Report> =>
    (await ok(call('GET', `/v1/reports/${name}`, userId, undefined, undefined, branchId), 200)).body as Report;
  const val = (r: Report, name: string): number | undefined => r.figures.find((f) => f.name === name)?.valueMinor;
  const because = (r: Report, name: string): string | undefined => r.figures.find((f) => f.name === name)?.notAvailableBecause;

  beforeAll(async () => {
    h = harness();
    await h.seedOwner(T, 'u-owner');
    await h.provisionOwner(T, 'u-owner-2'); // the second person on a template
    await h.provisionRole(T, 'u-buyer', 'store_manager');
    await h.provisionRole(T, 'u-checker', 'store_manager');
    await h.provisionRole(T, 'u-driver', 'store_manager');
    await h.provisionRole(T, 'u-mgr-s9', 'store_manager', ['S9']); // a manager of another branch only
    await h.provisionRole(T, 'u-relay', 'message_provider_relay');
    for (const c of ['c-1', 'c-2', 'c-3']) await h.provisionRole(T, c, 'customer');
    await h.enableFeature(T, 'customer_app');
    await h.enableFeature(T, 'delivery');
    await approvedSuppliers(h, T, 's-1', 's-2');
    await deliveryPlaces(h, T, 'store-1');
    await seedSubstitutionTruth(h, T, [
      { productId: 'MILK', name: 'Milk 1L', priceMinor: 5_000, brand: 'aavin', categoryId: 'dairy' },
      { productId: 'MILK-ALT', name: 'Milk 1L alt', priceMinor: 4_000, brand: 'arokya', categoryId: 'dairy' },
    ]);
    // Milk received at the store at ₹30 — the average buying cost a delivery's goods are valued at (OB-39).
    await ok(call('POST', '/v1/inventory/movements', 'u-owner', { movementId: 'mv-milk', productId: 'MILK', locationId: 'store-1', kind: 'received', quantityMinor: 50, uom: 'ea', occurredAt: new Date().toISOString(), enteredBy: 'u-owner', unitCostMinor: 3_000 }), 202);
  }, 180_000);

  it('supplier service and invoice differences = the order register, the goods receipts and the latest match verdicts', async () => {
    const order = (poId: string, supplierId: string, lines: unknown[]) => ok(call('POST', `/v1/purchase/orders/${poId}`, 'u-buyer', { supplierId, deliverToLocationId: 'store-1', lines }), 201);
    await order('po-1', 's-1', [{ productId: 'p1', orderedQty: 10, unitCost: { minor: 500, currency: 'INR' } }, { productId: 'p2', orderedQty: 4, unitCost: { minor: 1000, currency: 'INR' } }]);
    await ok(call('POST', '/v1/purchase/orders/po-1/approval', 'u-owner', { reason: 'fixture' }), 200);
    await order('po-2', 's-2', [{ productId: 'p1', orderedQty: 5, unitCost: { minor: 500, currency: 'INR' } }]);
    await ok(call('POST', '/v1/purchase/orders/po-2/approval', 'u-owner', { reason: 'fixture' }), 200);
    // s-1 delivers all the p1 and only 2 of the 4 p2; s-2 delivers nothing yet.
    await ok(call('POST', '/v1/inventory/goods-receipt/grn-1', 'u-owner', {
      warehouseId: 'store-1', receivedOnDate: new Date().toISOString().slice(0, 10), currency: 'INR', poId: 'po-1',
      lines: [
        { lineId: 'L1', productId: 'p1', orderedMinor: 10, countedMinor: 10, uom: 'ea', unitCost: { minor: 500, currency: 'INR' }, condition: 'good' },
        { lineId: 'L2', productId: 'p2', orderedMinor: 4, countedMinor: 2, uom: 'ea', unitCost: { minor: 1000, currency: 'INR' }, condition: 'good' },
      ],
    }), 201);
    const service = await report('supplier_service');
    expect(val(service, 's-1 — units ordered')).toBe(14);
    expect(val(service, 's-1 — units received')).toBe(12);
    expect(val(service, 's-1 — delivered (basis points of ordered)')).toBe(Math.round((12 * 10_000) / 14));
    expect(val(service, 's-2 — units received')).toBe(0);
    expect(val(service, 's-2 — delivered (basis points of ordered)')).toBe(0);

    // The bill: s-1 billed ₹90 for all 14 units; the match pays ₹70 (what arrived) and holds ₹20 back.
    const paper = { supplierId: 's-1', poId: 'po-1', declaredTotalMinor: 9000, lines: [line('p1', 10, 500), line('p2', 4, 1000)] };
    const send = (b: Record<string, unknown>) => call('POST', '/v1/purchase/invoices/inv-1/capture', 'u-buyer', b);
    await ok(sentWithApproval(h, T, 'u-buyer', 'u-checker', { kind: 'supplier_invoice_check', subjectRef: 'inv-1', pathIds: { invoiceId: 'inv-1' }, valueMinor: 9000 }, paper, send), 201);
    await ok(call('POST', '/v1/purchase/invoices/inv-1/match', 'u-checker', {}), 200);
    // A second bill, captured and not yet matched — counted, never guessed.
    await ok(call('POST', '/v1/purchase/invoices/inv-2/capture', 'u-buyer', { supplierId: 's-2', poId: 'po-2', declaredTotalMinor: 2500, lines: [line('p1', 5, 500)] }), 201);
    const diff = await report('invoice_differences');
    const held = ((await ok(call('GET', '/v1/purchase/invoices/inv-1', 'u-owner'), 200)).body as { match: { invoicedMinor: number; payableMinor: number; withheldMinor: number } }).match;
    expect(val(diff, 'Bills captured')).toBe(2);
    expect(val(diff, 'Bills not yet matched')).toBe(1);
    expect(val(diff, 'Billed')).toBe(held.invoicedMinor);
    expect(val(diff, 'Payable')).toBe(held.payableMinor);
    expect(val(diff, 'Held back (billed less payable)')).toBe(held.invoicedMinor - held.payableMinor);
    expect(val(diff, 'Held back (billed less payable)')).toBe(2000);
    expect(diff.rows).toEqual([{ invoiceId: 'inv-1', supplierId: 's-1', invoicedMinor: '9000', payableMinor: '7000', differenceMinor: '2000' }]);
    const drill = (await ok(call('POST', '/v1/reporting/drill/governed', 'u-owner', { reportId: 'invoice_differences', figure: 'Held back (billed less payable)' }), 200)).body as { reconciles: boolean; transactions: { transactionId: string; amountMinor: number }[] };
    expect(drill.reconciles).toBe(true);
    expect(drill.transactions.map((t) => [t.transactionId, t.amountMinor])).toEqual([['inv-1', 2000]]);
    // Company-wide registers, refused in words to a branch-limited reader.
    for (const id of ['supplier_service', 'invoice_differences']) {
      const branch = await report(id, 'u-mgr-s9', 'S9');
      expect(branch.figures[0]?.valueMinor).toBeUndefined();
      expect(branch.figures[0]?.notAvailableBecause).toMatch(/company-wide/);
    }
  });

  it('online orders, substitutions, deliveries on time and what a delivery earns reconcile to the orders, slots, steps and routes', async () => {
    await ok(call('PUT', '/v1/serviceability/delivery-service', 'u-owner', { storeLocation: STORE, slotsPerDay: 8, windowOpen: '09:00', windowClose: '21:00', capacityPerSlot: 10, leadMinutes: 60 }), 200);
    await ok(call('POST', '/v1/serviceability/periods/2026-01-01', 'u-owner', { radiusMetres: 10_000, deliveryFeeMinor: 0 }), 201); // OB-234: a fee (0) is a listing duty
    await sellOnline((path, body) => call('POST', path, 'u-owner', body), ['MILK']); // OB-234: published online first
    const tomorrow = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
    const slots = ((await ok(call('GET', '/v1/serviceability/delivery-service', 'u-owner', undefined, { day: tomorrow }), 200)).body as { slots: { startsAt: string; endsAt: string }[] }).slots;
    const slot = slots[0]!;
    for (const [customer, orderId] of [['c-1', 'ORD-1'], ['c-2', 'ORD-2']] as const) {
      await ok(call('POST', `/v1/storefront/orders/${orderId}`, customer, { lines: [{ productId: 'MILK', quantityMinor: 1 }], locationId: 'store-1', fulfilment: 'delivery', deliverySlot: { startsAt: slot.startsAt }, deliveryLocation: NEAR }), 201);
    }
    // ORD-1 is delivered (before its slot ends); ORD-2 is not yet.
    await ok(call('POST', '/v1/delivery/orders/ORD-1/transition', 'u-owner', { event: 'depart' }), 200);
    await ok(call('POST', '/v1/delivery/orders/ORD-1/transition', 'u-owner', { event: 'deliver', proof: { kind: 'otp', ref: 'OTP-1' } }), 200);
    // A desk order with a cheaper substitute: a ₹20 refund is due (a fact; the refund surface issues it).
    await ok(call('POST', '/v1/orders/ORD-DESK/promise', 'u-owner', { lines: [{ productId: 'MILK', quantityMinor: 2 }], locationId: 'store-1' }), 200, 201);
    await recordOrderRules(h, T, 'u-owner', 'ORD-DESK', { preference: 'best_match' });
    await ok(call('POST', '/v1/orders/ORD-DESK/substitute', 'u-owner', { offer: {
      lineId: 'l1', orderedProductId: 'MILK', orderedName: 'Milk 1L', orderedUnitPriceMinor: 5_000, orderedQuantityMinor: 2,
      substituteProductId: 'MILK-ALT', substituteName: 'Milk 1L alt', substituteUnitPriceMinor: 4_000, substituteQuantityMinor: 2, offeredAt: new Date().toISOString(),
    }, decision: 'confirmed' }), 200, 201);

    const orders = await report('orders_and_substitutions');
    expect(val(orders, 'Orders placed')).toBe(3);
    expect(val(orders, 'Lines substituted')).toBe(1);
    expect(val(orders, 'Substitutions — substituted')).toBe(1);
    expect(val(orders, 'Refunds due from substitutions')).toBe(2_000);
    expect(orders.rows.find((r) => r['orderId'] === 'ORD-DESK')?.['substituted']).toBe('1');

    const sla = await report('delivery_sla');
    expect(val(sla, 'Delivered on time')).toBe(1);
    expect(val(sla, 'Delivered late')).toBe(0);
    expect(val(sla, 'Not delivered yet')).toBe(1);
    expect(val(sla, 'On time (basis points of delivered)')).toBe(10_000);
    expect(sla.rows.find((r) => r['orderId'] === 'ORD-1')).toMatchObject({ slotEndsAt: slot.endsAt, verdict: 'on time' });

    // Route R-1: ORD-1, ₹50 order value, ₹15 to drive → earns 50 − 30 (milk at its average cost) − 15 = ₹5.
    await ok(call('POST', '/v1/delivery/routes/R-1/assignment', 'u-owner', { storeId: 'store-1', driverId: 'u-driver', stops: [{ stopId: 'st-1', orderRef: 'ORD-1', area: 'north', codMinor: 0, costMinor: 1_500, orderValueMinor: 5_000 }] }), 201);
    const earns = await report('delivery_contribution');
    expect(val(earns, 'Deliveries handed to drivers')).toBe(1);
    expect(val(earns, 'Contribution after goods and delivery cost')).toBe(5_000 - 3_000 - 1_500);
    expect(earns.rows[0]).toMatchObject({ stopId: 'st-1', goodsCostMinor: '3000', contributionMinor: '500' });
    const drill = (await ok(call('POST', '/v1/reporting/drill/governed', 'u-owner', { reportId: 'delivery_contribution', figure: 'Contribution after goods and delivery cost' }), 200)).body as { reconciles: boolean };
    expect(drill.reconciles).toBe(true);
    // Route R-2 names no delivery cost: the total is NOT AVAILABLE, naming the stop — never a cost of zero.
    await ok(call('POST', '/v1/delivery/routes/R-2/assignment', 'u-owner', { storeId: 'store-1', driverId: 'u-driver', stops: [{ stopId: 'st-2', orderRef: 'ORD-2', area: 'south', codMinor: 5_000, orderValueMinor: 5_000 }] }), 201);
    const partial = await report('delivery_contribution');
    expect(val(partial, 'Contribution after goods and delivery cost')).toBeUndefined();
    expect(because(partial, 'Contribution after goods and delivery cost')).toMatch(/st-2 \(no delivery cost\)/);
    // A manager of another branch sees none of store-1's orders or routes.
    expect(val(await report('orders_and_substitutions', 'u-mgr-s9', 'S9'), 'Orders placed')).toBe(0);
    expect(val(await report('delivery_contribution', 'u-mgr-s9', 'S9'), 'Deliveries handed to drivers')).toBeUndefined();
  });

  it('campaigns and complaints = the campaign\'s own status and the service desk\'s cases', async () => {
    for (const c of ['c-1', 'c-2']) await ok(call('POST', '/v1/me/privacy/consent', c, { purpose: 'marketing', channel: 'sms', given: true }), 201);
    await call('POST', '/v1/notifications/templates/tpl-offer', 'u-owner', { purpose: 'marketing', channel: 'sms', body: 'SRE this week: {offer}' });
    await ok(call('POST', '/v1/notifications/budget', 'u-owner', { capMinor: 100_000, costMinorByChannel: { sms: 25 } }), 201);
    await ok(call('POST', '/v1/notifications/templates/tpl-offer/approval', 'u-owner-2', { version: 1 }), 200);
    await ok(call('PUT', '/v1/service/campaigns/frequency-policy', 'u-owner', { capPerWindow: 2, windowDays: 7 }), 200);
    const sent = await ok(call('POST', '/v1/service/campaigns/cmp-1/send', 'u-owner', { purpose: 'marketing', channel: 'sms', templateId: 'tpl-offer', containsPromotion: true, audience: ['c-1', 'c-2', 'c-3'], values: { offer: 'rice 10% off' } }), 201);
    expect(sent.body).toMatchObject({ queued: 2, excludedByReason: { no_consent: 1 } });
    await ok(call('POST', '/v1/notifications/queue/drain', 'u-owner', {}), 200);
    const path = '/v1/service/campaigns/cmp-1/messages/cmp-cmp-1-c-1/status';
    await ok(h.request({ method: 'POST', path, userId: 'u-relay', tenantId: T, idempotencyKey: 'r1', body: signedReport(path, { status: 'delivered', providerRef: 'rec-cmp-cmp-1-c-1', reportedAt: new Date().toISOString() }, SECRET, { reportId: `${T}-r1` }) }), 201);
    // A complaint opened and resolved, and an enquiry (not a complaint).
    await ok(call('POST', '/v1/service/cases/case-1', 'u-buyer', { kind: 'complaint', customerRef: 'c-1', priority: 'normal', summary: 'milk was sour', assignedTo: 'u-buyer' }), 201);
    await ok(call('POST', '/v1/service/cases/case-1/first-response', 'u-buyer', {}), 200);
    await ok(call('POST', '/v1/service/cases/case-1/resolution', 'u-buyer', { resolution: 'replaced' }), 200);
    await ok(call('POST', '/v1/service/cases/case-2', 'u-buyer', { kind: 'enquiry', customerRef: 'c-2', priority: 'low', summary: 'opening hours', assignedTo: 'u-buyer' }), 201);

    const mkt = await report('marketing');
    const status = (await ok(call('GET', '/v1/service/campaigns/cmp-1/status', 'u-owner'), 200)).body as { messages: { report?: { status: string } }[] };
    expect(val(mkt, 'Campaign sends')).toBe(1);
    expect(val(mkt, 'Messages sent')).toBe(status.messages.length);
    expect(val(mkt, 'Delivered (provider reported)')).toBe(status.messages.filter((m) => m.report?.status === 'delivered' || m.report?.status === 'read').length);
    expect(val(mkt, 'Delivered (provider reported)')).toBe(1);
    expect(val(mkt, 'No provider report yet')).toBe(1);
    expect(val(mkt, 'Excluded at send (no consent, cap, …)')).toBe(1);
    expect(val(mkt, 'Complaints opened')).toBe(1);
    expect(val(mkt, 'Complaints resolved')).toBe(1);
    const branch = await report('marketing', 'u-mgr-s9', 'S9');
    expect(branch.figures[0]?.notAvailableBecause).toMatch(/company-wide/);
  });

  it('what the assistant suggested = its proposal register; a person\'s dismissal is counted as a decision', async () => {
    await ok(call('PUT', '/v1/ai/kill-switch', 'u-owner', { on: false }), 200);
    await ok(call('PUT', '/v1/ai/budget', 'u-owner', { capMinor: 500_000, periodEnds: '2099-01-01T00:00:00Z' }), 200);
    await ok(call('PUT', '/v1/ai/agents/enabled', 'u-owner', { agents: ['A08'] }), 200);
    await ok(call('POST', '/v1/catalogue/products/p-noscan/publish', 'u-owner', { product: { sku: 'SKU-NOSCAN', name: 'Loose Poha', brand: 'Local', baseUom: 'each', primaryCategoryId: 'grocery', taxClass: '25010020', lifecycle: 'draft' }, categories: [{ categoryId: 'grocery', name: 'Grocery', parentId: null }] }), 200, 201);
    await ok(call('POST', '/v1/ai/agents/A08/runs', 'u-owner', { estimatedCostMinor: 1_000 }), 200, 201);
    const proposals = ((await ok(call('GET', '/v1/ai/proposals', 'u-owner'), 200)).body as { proposals: { agent: string }[] }).proposals;
    expect(proposals.length).toBeGreaterThan(0);
    const worklist = (await ok(call('GET', '/v1/ai/data-quality/worklist', 'u-owner'), 200)).body as { open: { finding: { findingId: string } }[] };
    await ok(call('POST', '/v1/ai/data-quality/dismissals', 'u-owner', { findingId: worklist.open[0]!.finding.findingId, reason: 'sold loose by weight' }), 200);

    const ai = await report('ai_outcomes');
    expect(val(ai, 'Proposals and drafts')).toBe(proposals.length);
    expect(val(ai, 'A08 — proposed')).toBe(proposals.filter((p) => p.agent === 'A08').length);
    expect(val(ai, 'Decided by a person')).toBe(1);
    expect(val(ai, 'A08 — decided by a person')).toBe(1);
    expect(ai.rows.find((r) => r['agent'] === 'A08')).toMatchObject({ decided: '1' });
    expect(ai.sources[0]?.lastEventAt).not.toBeNull();
  });
});
