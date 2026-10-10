import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { aStoreWithRules } from '../support/store-rules';
import { MemoryIdempotencyStore, SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { InMemoryEventStore, SqlEventStore, type EventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { legacyHistoryRoutes } from '../../services/migration/src/legacy-history';
import {
  planLoad, executeLoad, readBackOpening,
  planOpenOrders, executeOpenOrders, readBackOpenOrders,
  type ExtractBundle, type LoadRequest, type LoadPlanOk, type LoadClient, type ExtractOpenOrder, type OpenOrderRequest,
} from '../../packages/migration/src/index';
import {
  planHistoryLoad, executeHistoryLoad, readBackHistory,
  type ExtractHistory, type ExtractHistoryDocument, type ExtractAttachment, type HistoryRequest,
} from '../../packages/migration/src/history-load';

/**
 * **GT-05 — history keeps its identity and never trades again; open orders arrive issued with what already came carried
 * (MG-07 · MG-08 "open orders" · MG-05 · QG-07 · OB-32 · OB-37 · §28 · §34 · ADR 0010 · hard rules #2 #6 #7 #10 · P-08).**
 *
 * After the master-data and opening load (opening-state-loads.test.ts), on the in-memory store and — with DATABASE_URL —
 * on REAL PostgreSQL:
 *
 *   1. HISTORY: the old system's sales invoices, returns, goods receipts, supplier bills and payments load into the history
 *      register under their OLD ids, read back by id and by the customer / supplier they were booked to, flagged read-only,
 *      and reconcile per kind (count, gross, tax) to the old system's report. Their document files are stored as bytes
 *      whose SHA-256 matches the manifest, re-hashed on read. Nothing in trading moves: every opening figure still agrees.
 *   2. A shortfall against the old system's report is a difference until the OWNER approves the exclusion that explains it.
 *   3. OPEN ORDERS: an order still open on the old system arrives ISSUED (raised by the operator, issued by a second person),
 *      to its approved supplier, for its store, with what already came carried as received — so the next delivery is judged
 *      against what is left, and the store's open-deliveries list shows exactly the remainder. No stock moves for it.
 *   4. An INTERRUPTED load resumed after a restart and run a third time doubles nothing; a SECOND process reads the same figures.
 *   5. Bad rows are refused BY NAME before anything is sent; at the routes a bad hash, a conflicting re-send, a link to a file
 *      never stored, a cashier and a production target are refused by name, and there is no edit or delete route.
 *
 * Synthetic data only (hard rule #7): a fresh random tenant per run.
 */

const OPERATOR = 'u-loader';
const ACCOUNTANT = 'u-acct';
const APPROVER = 'u-owner2';
const MANAGER = 'u-mgr';
const STORE = 'S1';
const LOAD = 'load-2026-10-10';
const COUNT_DATE = '2026-10-10';

const pdf = (text: string): string => Buffer.from(`%PDF-1.4\n% synthetic legacy scan\n${text}\n%%EOF\n`, 'utf8').toString('base64');
const sha = (b64: string): string => createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex');

function masterExtract(): ExtractBundle {
  const products = Array.from({ length: 6 }, (_, i) => {
    const n = String(i + 1).padStart(4, '0');
    return {
      productId: `P-${n}`, sku: `SKU-${n}`, name: `Synthetic item ${n}`, baseUom: 'each', primaryCategoryId: 'home', taxClass: '3402',
      lifecycle: 'active' as const, barcodes: [{ code: `INT-${n}`, kind: 'internal' as const }],
      priceMinor: 2_000 + i * 100, mrpMinor: 2_500 + i * 100, costMinor: 1_500 + i * 100, marginFloorBps: 0,
    };
  });
  return {
    categories: [{ categoryId: 'home', name: 'Home care', parentId: null }],
    taxRates: [{ hsnCode: '3402', effectiveFrom: '2017-07-01', rateBps: 1800 }],
    products,
    suppliers: [{ partnerId: 'SUP-1', name: 'Synthetic Traders 1' }, { partnerId: 'SUP-2', name: 'Synthetic Traders 2' }],
    customers: [{ customerId: 'C-0001', loyaltyPoints: 120 }, { customerId: 'C-0002' }],
    openingStock: products.map((p, i) => ({ productId: p.productId, quantityMinor: 20 + i, uom: 'each', unitCostMinor: p.costMinor })),
  };
}

function historyExtract(): ExtractHistory {
  const attachments: ExtractAttachment[] = Array.from({ length: 4 }, (_, i) => {
    const content = pdf(`legacy document ${i + 1}`);
    return { legacyId: `DOC-${i + 1}`, fileName: `scan-${i + 1}.pdf`, contentType: 'application/pdf', contentBase64: content, sha256: sha(content) };
  });
  const documents: ExtractHistoryDocument[] = [];
  for (let i = 0; i < 6; i += 1) {
    const net = 10_000 + i * 1_000;
    const tax = net * 18 / 100;
    documents.push({
      kind: 'sales_invoice', legacyId: `SI-${1000 + i}`, number: `SRE/24-25/${1000 + i}`, date: `2025-0${1 + (i % 9)}-15`,
      partyRef: i % 2 === 0 ? 'C-0001' : 'C-0002',
      lines: [{ productId: 'P-0001', quantityMinor: 2, netMinor: net / 2, taxMinor: tax / 2 }, { productId: 'P-0002', quantityMinor: 1, netMinor: net / 2, taxMinor: tax / 2 }],
      netMinor: net, taxMinor: tax, grossMinor: net + tax, tenders: [{ method: 'cash', amountMinor: net + tax }],
      ...(i === 0 ? { attachmentIds: ['DOC-1'] } : {}),
    });
  }
  documents.push({ kind: 'sales_return', legacyId: 'SR-1', number: 'SRE/RET/1', date: '2025-02-20', partyRef: 'C-0001', netMinor: 5_000, taxMinor: 900, grossMinor: 5_900 });
  documents.push({ kind: 'goods_receipt', legacyId: 'GRN-77', number: 'GRN/77', date: '2025-03-01', partyRef: 'SUP-1', lines: [{ productId: 'P-0003', quantityMinor: 40, netMinor: 64_000, taxMinor: 0 }], netMinor: 64_000, taxMinor: 0, grossMinor: 64_000, attachmentIds: ['DOC-2'] });
  documents.push({ kind: 'purchase_invoice', legacyId: 'PI-77', number: 'BILL-77', date: '2025-03-02', partyRef: 'SUP-1', netMinor: 64_000, taxMinor: 11_520, grossMinor: 75_520, attachmentIds: ['DOC-3', 'DOC-4'] });
  documents.push({ kind: 'supplier_payment', legacyId: 'PAY-77', number: 'CHQ-0077', date: '2025-04-01', partyRef: 'SUP-1', netMinor: 75_520, taxMinor: 0, grossMinor: 75_520 });
  const kinds = [...new Set(documents.map((d) => d.kind))];
  return {
    documents, attachments, attachmentManifestCount: attachments.length,
    // The old system's own report — here it agrees with the extract (scenario 2 makes it disagree).
    controlTotals: kinds.map((kind) => {
      const ds = documents.filter((d) => d.kind === kind);
      return { kind, count: ds.length, grossMinor: ds.reduce((s, d) => s + d.grossMinor, 0), taxMinor: ds.reduce((s, d) => s + d.taxMinor, 0) };
    }),
  };
}

const OPEN_ORDERS: readonly ExtractOpenOrder[] = [
  // part-delivered: 30 of 100 already came on the old system
  { poId: 'LPO-501', number: 'PO/24-25/501', supplierId: 'SUP-1', deliverToLocationId: STORE, lines: [
    { productId: 'P-0001', orderedQty: 100, receivedQty: 30, unitCostMinor: 1_500 },
    { productId: 'P-0002', orderedQty: 50, receivedQty: 0, unitCostMinor: 1_600 },
  ] },
  // nothing came yet
  { poId: 'LPO-502', number: 'PO/24-25/502', supplierId: 'SUP-2', deliverToLocationId: STORE, lines: [{ productId: 'P-0003', orderedQty: 24, receivedQty: 0, unitCostMinor: 1_700 }] },
];

const requestFor = (tenantId: string): LoadRequest => ({
  target: { targetId: 'rehearsal-gt05', tenantId, kind: 'rehearsal', label: 'GT-05 rehearsal tenant' },
  tenantId, demoTenantIds: [], operator: OPERATOR, targetProductCount: 0, extractSealed: true, blockingExceptionsOpen: 0,
  loadId: LOAD, stockLocationId: STORE, receivedOnDate: COUNT_DATE, currency: 'INR',
});
const historyReq = (t: string): HistoryRequest => requestFor(t);
const ordersReq = (t: string): OpenOrderRequest => ({ ...requestFor(t), approver: APPROVER });

const planOf = (bundle: ExtractBundle, req: LoadRequest): LoadPlanOk => {
  const p = planLoad(bundle, req);
  if (!p.ok) throw new Error(`${p.refusedBecause}: ${p.problems.join('; ')}`);
  return p;
};
const historyPlan = (t: string, history = historyExtract()) => {
  const p = planHistoryLoad(history, historyReq(t));
  if (!p.ok) throw new Error(`${p.refusedBecause}: ${p.problems.join('; ')}`);
  return p;
};
const ordersPlan = (t: string) => {
  const p = planOpenOrders(OPEN_ORDERS, masterExtract(), ordersReq(t));
  if (!p.ok) throw new Error(`${p.refusedBecause}: ${p.problems.join('; ')}`);
  return p;
};

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

/** The shop, the master-data + opening load, and finance approving the migrated suppliers (OB-32). */
async function loadedShop(h: ApiHarness, t: string, approveSuppliers = true): Promise<void> {
  await h.seedOwner(t, OPERATOR);
  await aStoreWithRules(h, t, OPERATOR, STORE, 0);
  await h.provisionRole(t, ACCOUNTANT, 'accountant');
  await h.provisionRole(t, APPROVER, 'owner');
  await h.provisionRole(t, MANAGER, 'store_manager');
  const report = await executeLoad(h, planOf(masterExtract(), requestFor(t)));
  if (!report.ok) throw new Error(JSON.stringify(report.steps.filter((s) => !s.ok)));
  if (approveSuppliers) for (const s of masterExtract().suppliers) await approveSupplier(h, t, s.partnerId);
}
async function approveSupplier(h: ApiHarness, t: string, supplierId: string): Promise<void> {
  const res = await h.request({ method: 'POST', path: `/v1/purchase/suppliers/${supplierId}/approval`, userId: ACCOUNTANT, tenantId: t, idempotencyKey: `approve-${supplierId}`, body: { reason: 'migrated supplier, documents checked' } });
  expect(res.status).toBeLessThan(300);
}

/** A read's figures without its clock — two reads of the same facts compare equal. */
const figures = (v: unknown): string => JSON.stringify(v, (k, x: unknown) => (k === 'asAt' ? undefined : x));

/** Everything trading reads — a history load must leave every figure here exactly as it was. */
async function tradingSnapshot(h: ApiHarness, t: string): Promise<string> {
  const get = async (path: string, query?: Record<string, string>) => (await h.request({ method: 'GET', path, userId: OPERATOR, tenantId: t, ...(query === undefined ? {} : { query }) })).body;
  return figures([
    await get('/v1/inventory/availability'), await get('/v1/inventory/valuation'), await get('/v1/customers/C-0001/points'),
    ((await get('/v1/purchase/orders')) as { count: number }).count,
    ((await get('/v1/purchase/suppliers/SUP-1')) as { account: { totals: unknown } }).account.totals,
    ((await get('/v1/purchase/opening-balances')) as { count: number }).count,
  ]);
}

function dyingClient(h: ApiHarness, after: number): LoadClient {
  let calls = 0;
  return { request: async (input) => { calls += 1; if (calls > after) throw new Error('power cut'); return h.request(input); } };
}

let pool: Pool | undefined;
const DATABASE_URL = process.env['DATABASE_URL'];
beforeAll(async () => {
  if (DATABASE_URL === undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
  const dir = 'db/migrations';
  await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
});
afterAll(async () => { await pool?.end(); });

interface Backing { readonly store: EventStore; readonly idempotency: MemoryIdempotencyStore | SqlIdempotencyStore }
const backings: { name: string; backing: () => Backing }[] = [
  { name: 'the in-memory event store', backing: () => ({ store: new InMemoryEventStore(), idempotency: new MemoryIdempotencyStore() }) },
];
if (DATABASE_URL !== undefined) {
  backings.push({ name: 'real PostgreSQL', backing: () => { const sql = pgPoolClient(pool!); return { store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }; } });
}

describe.each(backings)('GT-05 history and open orders — on $name', ({ backing }) => {
  it('history lands under its OLD ids, read-only, reconciled per kind and hash-checked — and nothing in trading moves', async () => {
    const t = randomUUID();
    const h = apiHarness(backing());
    await loadedShop(h, t);
    const before = await tradingSnapshot(h, t);
    const history = historyExtract();

    const report = await executeHistoryLoad(h, historyPlan(t, history));
    expect(report.steps.filter((s) => !s.ok)).toEqual([]);
    const rb = await readBackHistory(h, history, historyReq(t));
    expect(rb.differences).toEqual([]);
    expect(rb.agrees).toBe(true);
    expect(rb.lines.filter((l) => l.check === 'document')).toHaveLength(history.documents.length);
    expect(rb.lines.filter((l) => l.check === 'attachment')).toHaveLength(history.attachments.length);
    expect(new Set(rb.lines.filter((l) => l.check === 'kind_count').map((l) => l.key))).toEqual(new Set(['sales_invoice', 'sales_return', 'goods_receipt', 'purchase_invoice', 'supplier_payment']));

    // Identity: one document by the OLD id, with its lines, tenders and the file behind it.
    const one = await h.request({ method: 'GET', path: '/v1/migration/history/documents/sales_invoice/SI-1000', userId: OPERATOR, tenantId: t });
    expect(one.status).toBe(200);
    const doc = (one.body as { document: Record<string, unknown>; attachments: { legacyId: string; sha256: string }[] });
    expect(doc.document).toMatchObject({ legacyId: 'SI-1000', number: 'SRE/24-25/1000', partyRef: 'C-0001', readOnly: true, source: 'legacy', recordedBy: OPERATOR });
    expect(doc.attachments).toEqual([expect.objectContaining({ legacyId: 'DOC-1', sha256: history.attachments[0]!.sha256 })]);
    // A customer's and a supplier's history, by the party code the old system booked it to.
    const c1 = (await h.request({ method: 'GET', path: '/v1/migration/history/documents', userId: OPERATOR, tenantId: t, query: { partyRef: 'C-0001' } })).body as { documents: { legacyId: string }[] };
    expect(c1.documents.map((d) => d.legacyId).sort()).toEqual(['SI-1000', 'SI-1002', 'SI-1004', 'SR-1']);
    const s1 = (await h.request({ method: 'GET', path: '/v1/migration/history/documents', userId: ACCOUNTANT, tenantId: t, query: { partyRef: 'SUP-1' } })).body as { documents: { kind: string }[]; totals: Record<string, { grossMinor: number }> };
    expect(s1.documents.map((d) => d.kind).sort()).toEqual(['goods_receipt', 'purchase_invoice', 'supplier_payment']);
    expect(s1.totals['purchase_invoice']?.grossMinor).toBe(75_520);
    // The file comes back as its bytes, re-hashed by the server now.
    const file = (await h.request({ method: 'GET', path: '/v1/migration/history/attachments/DOC-3', userId: OPERATOR, tenantId: t })).body as { contentBase64: string; sha256: string; sha256Now: string; intact: boolean };
    expect(file).toMatchObject({ contentBase64: history.attachments[2]!.contentBase64, sha256: history.attachments[2]!.sha256, sha256Now: history.attachments[2]!.sha256, intact: true });

    // READ-ONLY: a migrated sale is not a sale — stock, value, points, orders, supplier account and openings are untouched…
    expect(await tradingSnapshot(h, t)).toBe(before);
    const opening = await readBackOpening(h, masterExtract(), requestFor(t));
    expect(opening.differences).toEqual([]);
    // …and there is no route that edits or deletes history (hard rules #2 #6).
    const routes = legacyHistoryRoutes({ target: () => requestFor(t).target, documents: () => [], recordDocument: (_t, d) => Promise.resolve({ standing: d, existed: false }), attachments: () => [], attachment: () => undefined, recordAttachment: (_t, a) => Promise.resolve({ standing: a, existed: false }), now: () => COUNT_DATE });
    expect(routes.every((r) => r.method === 'GET' || r.method === 'POST')).toBe(true);
    for (const method of ['PUT', 'DELETE', 'PATCH'] as const) {
      const res = await h.request({ method, path: '/v1/migration/history/documents/sales_invoice/SI-1000', userId: OPERATOR, tenantId: t, idempotencyKey: `x-${method}`, body: { grossMinor: 1 } } as never);
      expect(res.status).toBeGreaterThanOrEqual(400);
    }
    expect(((await h.request({ method: 'GET', path: '/v1/migration/history/documents/sales_invoice/SI-1000', userId: OPERATOR, tenantId: t })).body as { document: { grossMinor: number } }).document.grossMinor).toBe(history.documents[0]!.grossMinor);
  }, 180_000);

  it('a shortfall against the old system\'s report is a DIFFERENCE until the owner approves the exclusion that explains it', async () => {
    const t = randomUUID();
    const h = apiHarness(backing());
    await loadedShop(h, t);
    const history = historyExtract();
    // The old report holds two more sales invoices (worth 40 000 paise, 6 100 tax) than the extract carries.
    const reported: ExtractHistory = { ...history, controlTotals: history.controlTotals.map((c) => c.kind === 'sales_invoice' ? { ...c, count: c.count + 2, grossMinor: c.grossMinor + 40_000, taxMinor: c.taxMinor + 6_100 } : c) };
    expect((await executeHistoryLoad(h, historyPlan(t, reported))).ok).toBe(true);
    const open = await readBackHistory(h, reported, historyReq(t));
    expect(open.agrees).toBe(false);
    expect(open.differences.map((d) => `${d.check}:${d.key}`).sort()).toEqual(['exclusions:approved exclusions', 'kind_count:sales_invoice', 'kind_gross:sales_invoice', 'kind_tax:sales_invoice']);

    const post = (path: string, userId: string, body: unknown, key: string) => h.request({ method: 'POST', path, userId, tenantId: t, idempotencyKey: key, body });
    expect((await post('/v1/migration/history/exclusions', MANAGER, { exclusionId: 'EX-1', scope: 'named_records', description: 'SI-0007 and SI-0008: lines orphaned in the old database', recordCount: 2, valueMinor: 40_000, reason: 'line items lost in the 2019 database crash; totals cannot be rebuilt' }, 'ex-1')).status).toBe(201);
    // Proposed is not approved: still a difference.
    expect((await readBackHistory(h, reported, historyReq(t))).agrees).toBe(false);
    expect((await post('/v1/migration/history/exclusions/EX-1/decision', OPERATOR, { approve: true, ownerStatement: 'I approve leaving these two behind; the paper copies are filed.' }, 'ex-1-ok')).status).toBe(200);
    const explained = await readBackHistory(h, reported, historyReq(t));
    expect(explained.differences).toEqual([]);
    expect(explained.lines.find((l) => l.check === 'exclusions')).toMatchObject({ agrees: true });
  }, 180_000);

  it('an open order arrives ISSUED to its approved supplier and store, with what already came carried — the next delivery meets what is left', async () => {
    const t = randomUUID();
    const h = apiHarness(backing());
    await loadedShop(h, t);
    const stockBefore = figures((await h.request({ method: 'GET', path: '/v1/inventory/availability', userId: OPERATOR, tenantId: t })).body);

    const report = await executeOpenOrders(h, ordersPlan(t));
    expect(report.steps.filter((s) => !s.ok)).toEqual([]);
    const rb = await readBackOpenOrders(h, OPEN_ORDERS, requestFor(t));
    expect(rb.differences).toEqual([]);
    expect(rb.lines.find((l) => l.check === 'open' && l.key === 'LPO-501/P-0001')).toMatchObject({ expected: 70, actual: 70 });
    const po = (await h.request({ method: 'GET', path: '/v1/purchase/orders/LPO-501', userId: OPERATOR, tenantId: t })).body as { order: { status: string; requisitionedBy: string; approvedBy: string; receivedByProduct: Record<string, number> } };
    expect(po.order).toMatchObject({ status: 'issued', requisitionedBy: OPERATOR, approvedBy: APPROVER, receivedByProduct: { 'P-0001': 30 } });
    // Carrying what came on the old system moved NO stock — it is already in the opening count.
    expect(figures((await h.request({ method: 'GET', path: '/v1/inventory/availability', userId: OPERATOR, tenantId: t })).body)).toBe(stockBefore);

    // The supplier delivers the rest after cutover: the receipt is judged against the 70 that remained, not the 100.
    const grn = await h.request({ method: 'POST', path: '/v1/inventory/goods-receipt/grn-after-1', userId: MANAGER, tenantId: t, idempotencyKey: 'grn-after-1', body: {
      warehouseId: STORE, receivedOnDate: '2026-10-12', currency: 'INR', poId: 'LPO-501',
      lines: [{ lineId: 'L1', productId: 'P-0001', orderedMinor: 70, countedMinor: 70, uom: 'each', unitCost: { minor: 1_500, currency: 'INR' }, condition: 'good' }],
    } });
    expect(grn.status).toBe(201);
    expect((grn.body as { grn: { orderPosition: Record<string, unknown>; heldMinor: number } }).grn).toMatchObject({ heldMinor: 0, orderPosition: { 'P-0001': { ordered: 100, receivedBefore: 30, cancelled: 0, remaining: 70 } } });
    const after = (await h.request({ method: 'GET', path: '/v1/purchase/orders/LPO-501', userId: OPERATOR, tenantId: t })).body as { order: { receivedByProduct: Record<string, number> } };
    expect(after.order.receivedByProduct['P-0001']).toBe(100);
    const deliveries = (await h.request({ method: 'GET', path: '/v1/purchase/deliveries/open', userId: OPERATOR, tenantId: t, query: { storeId: STORE } })).body as { deliveries: { poId: string; lines: { productId: string; openQty: number }[] }[] };
    expect(deliveries.deliveries.find((d) => d.poId === 'LPO-501')?.lines).toEqual([expect.objectContaining({ productId: 'P-0001', openQty: 0 }), expect.objectContaining({ productId: 'P-0002', openQty: 50 })]);
  }, 180_000);

  it('an order to a supplier finance has not yet approved is a VISIBLE refused step; resumed after approval it lands once', async () => {
    const t = randomUUID();
    const h = apiHarness(backing());
    await loadedShop(h, t, false);
    await approveSupplier(h, t, 'SUP-1'); // SUP-2 still waiting for finance
    const first = await executeOpenOrders(h, ordersPlan(t));
    expect(first.ok).toBe(false);
    expect(first.steps.filter((s) => !s.ok).map((s) => [s.poId, s.stage, s.detail?.split(':')[0]])).toEqual([['LPO-502', 'propose', 'supplier_not_approved'], ['LPO-502', 'issue', 'not attempted']]);
    expect((await readBackOpenOrders(h, OPEN_ORDERS, requestFor(t))).differences.map((d) => d.key)).toContain('LPO-502');
    await approveSupplier(h, t, 'SUP-2');
    expect((await executeOpenOrders(h, ordersPlan(t))).ok).toBe(true);
    expect((await readBackOpenOrders(h, OPEN_ORDERS, requestFor(t))).differences).toEqual([]);
  }, 180_000);

  it('an INTERRUPTED history and open-order load, resumed after a restart and run a third time, doubles nothing; a second process reads the same figures', async () => {
    const t = randomUUID();
    const b = backing();
    const first = apiHarness(b);
    await loadedShop(first, t);
    const history = historyExtract();
    const hp = historyPlan(t, history);
    await expect(executeHistoryLoad(dyingClient(first, Math.floor(hp.steps.length / 2)), hp)).rejects.toThrow('power cut');
    const op = ordersPlan(t);
    await expect(executeOpenOrders(dyingClient(first, 4), op)).rejects.toThrow('power cut'); // LPO-501 raised, issued, carried; LPO-502 raised only
    expect((await readBackHistory(first, history, historyReq(t))).agrees).toBe(false); // half a load is visibly half a load
    const partial = await readBackOpenOrders(first, OPEN_ORDERS, requestFor(t));
    expect(partial.differences.find((d) => d.key === 'LPO-502')).toMatchObject({ check: 'issued', actual: 'proposed' });

    // Restart: a NEW process over the same database resumes; then once more.
    const restarted = apiHarness(b);
    expect((await executeHistoryLoad(restarted, historyPlan(t, history))).ok).toBe(true);
    expect((await executeOpenOrders(restarted, ordersPlan(t))).ok).toBe(true);
    const third = apiHarness(b);
    expect((await executeHistoryLoad(third, historyPlan(t, history))).ok).toBe(true);
    expect((await executeOpenOrders(third, ordersPlan(t))).ok).toBe(true);

    const rb = await readBackHistory(restarted, history, historyReq(t));
    expect(rb.differences).toEqual([]);
    const list = (await restarted.request({ method: 'GET', path: '/v1/migration/history/documents', userId: OPERATOR, tenantId: t })).body as { count: number };
    expect(list.count).toBe(history.documents.length);
    const files = (await restarted.request({ method: 'GET', path: '/v1/migration/history/attachments', userId: OPERATOR, tenantId: t })).body as { count: number };
    expect(files.count).toBe(history.attachments.length);
    const orb = await readBackOpenOrders(restarted, OPEN_ORDERS, requestFor(t));
    expect(orb.differences).toEqual([]);
    expect(orb.lines.find((l) => l.check === 'received' && l.key === 'LPO-501/P-0001')).toMatchObject({ expected: 30, actual: 30 }); // carried once, never 60 or 90

    // A second process, reading on its own, sees exactly the same figures.
    const reader = apiHarness(b);
    expect(JSON.stringify((await readBackHistory(reader, history, historyReq(t))).lines)).toBe(JSON.stringify(rb.lines));
    expect(JSON.stringify((await readBackOpenOrders(reader, OPEN_ORDERS, requestFor(t))).lines)).toBe(JSON.stringify(orb.lines));
  }, 240_000);

  it('bad rows are refused BY NAME before anything is sent; at the routes a bad hash, a conflict, a dangling link, a cashier and production are refused by name', async () => {
    const t = randomUUID();
    const h = apiHarness(backing());
    await loadedShop(h, t);
    const good = historyExtract();
    const tampered = { ...good.attachments[1]!, contentBase64: pdf('a different scan') };
    const bad: ExtractHistory = {
      ...good,
      attachments: [...good.attachments.slice(0, 1), tampered, ...good.attachments.slice(2)],
      documents: [
        ...good.documents,
        { kind: 'sales_invoice', legacyId: 'SI-LATE', number: 'X1', date: '2026-10-11', netMinor: 100, taxMinor: 18, grossMinor: 118 },
        { kind: 'sales_invoice', legacyId: 'SI-SUM', number: 'X2', date: '2025-01-01', netMinor: 100, taxMinor: 18, grossMinor: 120 },
        { kind: 'sales_invoice', legacyId: 'SI-TND', number: 'X3', date: '2025-01-01', netMinor: 100, taxMinor: 18, grossMinor: 118, tenders: [{ method: 'cash', amountMinor: 100 }] },
        { kind: 'purchase_invoice', legacyId: 'PI-DOC', number: 'X4', date: '2025-01-01', netMinor: 100, taxMinor: 0, grossMinor: 100, attachmentIds: ['DOC-NONE'] },
        { ...good.documents[0]! },
      ],
    };
    const refused = planHistoryLoad(bad, historyReq(t));
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    const text = refused.problems.join('\n');
    expect(text).toMatch(/attachment row 2 \(DOC-2\): its bytes hash to [0-9a-f]{64}, not the manifest's/);
    expect(text).toMatch(/\(sales_invoice SI-LATE\): dated 2026-10-11, on or after the opening date 2026-10-10/);
    expect(text).toMatch(/\(sales_invoice SI-SUM\): net 100 \+ tax 18 is not the gross 120/);
    expect(text).toMatch(/\(sales_invoice SI-TND\): its tenders add up to 100, not the gross 118/);
    expect(text).toMatch(/\(purchase_invoice PI-DOC\): attachment "DOC-NONE" is not in the extract/);
    expect(text).toMatch(/\(sales_invoice SI-1000\): listed twice/);
    expect(refused.problems).toHaveLength(6);
    expect(planHistoryLoad(good, { ...historyReq(t), target: { ...requestFor(t).target, kind: 'production' } })).toMatchObject({ ok: false, refusedBecause: 'production_target' });

    const badOrders: ExtractOpenOrder[] = [
      { poId: 'LPO-X1', number: 'X1', supplierId: 'SUP-1', deliverToLocationId: STORE, lines: [{ productId: 'P-0001', orderedQty: 10, receivedQty: 12, unitCostMinor: 100 }] },
      { poId: 'LPO-X2', number: 'X2', supplierId: 'SUP-1', deliverToLocationId: STORE, lines: [{ productId: 'P-0001', orderedQty: 10, receivedQty: 10, unitCostMinor: 100 }] },
      { poId: 'LPO-X3', number: 'X3', supplierId: 'SUP-GHOST', deliverToLocationId: STORE, lines: [{ productId: 'P-0001', orderedQty: 10, receivedQty: 0, unitCostMinor: 100 }] },
      { poId: 'LPO-X4', number: 'X4', supplierId: 'SUP-1', deliverToLocationId: '', lines: [{ productId: 'P-NONE', orderedQty: 10, receivedQty: 0, unitCostMinor: 100 }] },
    ];
    const ro = planOpenOrders(badOrders, masterExtract(), ordersReq(t));
    expect(ro.ok).toBe(false);
    if (ro.ok) return;
    const otext = ro.problems.join('\n');
    expect(otext).toMatch(/open order row 1 \(LPO-X1\): P-0001 received 12, more than the 10 ordered/);
    expect(otext).toMatch(/open order row 2 \(LPO-X2\): everything ordered was already received — it is history/);
    expect(otext).toMatch(/open order row 3 \(LPO-X3\): supplier "SUP-GHOST" is not in the extract/);
    expect(otext).toMatch(/open order row 4 \(LPO-X4\): the store it is delivered to is required/);
    expect(otext).toMatch(/open order row 4 \(LPO-X4\) line 1 \(P-NONE\): product is not in the extract/);
    expect(planOpenOrders(OPEN_ORDERS, masterExtract(), { ...ordersReq(t), approver: OPERATOR })).toMatchObject({ ok: false, refusedBecause: 'approver_is_operator' });
    // Nothing was sent by any refused plan.
    expect(((await h.request({ method: 'GET', path: '/v1/migration/history/documents', userId: OPERATOR, tenantId: t })).body as { count: number }).count).toBe(0);
    expect(((await h.request({ method: 'GET', path: '/v1/purchase/orders', userId: OPERATOR, tenantId: t })).body as { count: number }).count).toBe(0);

    // At the routes.
    const post = (path: string, userId: string, body: unknown, key: string) => h.request({ method: 'POST', path, userId, tenantId: t, idempotencyKey: key, body });
    const a = good.attachments[0]!;
    const mismatch = await post(`/v1/migration/history/attachments/${a.legacyId}`, OPERATOR, { loadId: LOAD, fileName: a.fileName, contentType: a.contentType, contentBase64: tampered.contentBase64, sha256: a.sha256 }, 'bad-hash');
    expect(mismatch.status).toBe(422);
    expect(codeOf(mismatch)).toBe('attachment_checksum_mismatch');
    expect(((await h.request({ method: 'GET', path: '/v1/migration/history/attachments', userId: OPERATOR, tenantId: t })).body as { count: number }).count).toBe(0);
    const dangling = await post('/v1/migration/history/documents/purchase_invoice/PI-1', OPERATOR, { loadId: LOAD, openingDate: COUNT_DATE, number: 'B1', date: '2025-01-01', netMinor: 100, taxMinor: 0, grossMinor: 100, attachmentIds: ['DOC-1'] }, 'dangling');
    expect(dangling.status).toBe(422);
    expect(codeOf(dangling)).toBe('attachment_not_stored');
    const docBody = { loadId: LOAD, openingDate: COUNT_DATE, number: 'B1', date: '2025-01-01', partyRef: 'SUP-1', netMinor: 100, taxMinor: 0, grossMinor: 100 };
    expect((await post('/v1/migration/history/documents/purchase_invoice/PI-1', OPERATOR, docBody, 'pi-1')).status).toBe(201);
    expect((await post('/v1/migration/history/documents/purchase_invoice/PI-1', OPERATOR, docBody, 'pi-1-again')).status).toBe(200);
    const conflict = await post('/v1/migration/history/documents/purchase_invoice/PI-1', OPERATOR, { ...docBody, netMinor: 150, grossMinor: 150 }, 'pi-1-changed');
    expect(conflict.status).toBe(409);
    expect(codeOf(conflict)).toBe('legacy_history_conflict');
    expect(((await h.request({ method: 'GET', path: '/v1/migration/history/documents/purchase_invoice/PI-1', userId: OPERATOR, tenantId: t })).body as { document: { grossMinor: number } }).document.grossMinor).toBe(100);
    expect(codeOf(await post('/v1/migration/history/documents/sales_invoice/SI-L', OPERATOR, { ...docBody, date: '2026-10-10' }, 'late'))).toBe('history_document_not_usable');
    await h.provisionRole(t, 'u-cash', 'cashier');
    expect((await post('/v1/migration/history/documents/purchase_invoice/PI-2', 'u-cash', docBody, 'cash')).status).toBe(403);
    expect((await h.request({ method: 'GET', path: '/v1/migration/history/documents', userId: 'u-cash', tenantId: t })).status).toBe(403);

    // A box configured with a production migration target refuses the whole surface (hard rule #7).
    const prod = apiHarness({ ...backing(), migrationTargetKind: 'production' });
    const tp = randomUUID();
    await prod.seedOwner(tp, OPERATOR);
    const refusedProd = await prod.request({ method: 'POST', path: '/v1/migration/history/documents/purchase_invoice/PI-1', userId: OPERATOR, tenantId: tp, idempotencyKey: 'prod', body: docBody });
    expect(refusedProd.status).toBe(403);
    expect(codeOf(refusedProd)).toBe('target_is_production');
  }, 180_000);
});
