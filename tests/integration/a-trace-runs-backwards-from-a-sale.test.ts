import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { approvedSuppliers, deliveryPlaces } from '../support/approved-supplier';
import { STREAM } from '../../services/api/src/adapters';
import { makeEvent } from '../../packages/contracts/src/event';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';

/**
 * **M10-FR-03 "traceability works backwards and forwards … customer→supplier", and "trace queries logged" (Lane 2 · P1)
 * — through the real API, in memory and on real PostgreSQL, with a cold restart.**
 *
 * Every trace route used to start from a batch id. The service desk has a bill, or a customer: now
 *   • from a BILL: each line's batch (the till's record, or head office's FIFO estimate, labelled) → the goods-receipt
 *     note → the supplier; for a batch the kitchen made, → the run's ingredient batches → THEIR suppliers;
 *   • from a CUSTOMER: every bill that names them, the same way;
 *   • every hop the shop cannot name is a gap in words (P-08), and the reply says up to when head office has the bills;
 *   • the forward trace ("who bought this batch") now names the member the till keyed on the bill;
 *   • every one of these reads — and the forward ones — is sealed on the audit trail: who, when, what, how many
 *     customers it named. A refused read leaves no trace data and no domain record.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
let pool: Pool | undefined;
beforeAll(async () => {
  if (DATABASE_URL === undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
  const dir = 'db/migrations';
  await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
});
afterAll(async () => { await pool?.end(); });
const backings: { name: string; harness: () => ApiHarness; restart: (h: ApiHarness) => ApiHarness }[] = [
  { name: 'the in-memory event store', harness: () => apiHarness(), restart: (h) => apiHarness({ store: h.store }) },
];
if (DATABASE_URL !== undefined) {
  const pg = (): ApiHarness => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); };
  backings.push({ name: 'real PostgreSQL', harness: pg, restart: pg });
}

const AT = '2026-10-09T06:00:00.000Z';
const cost = (minor: number) => ({ minor, currency: 'INR' });
type Res = { status: number; body: unknown };
interface Backward {
  start: { saleId?: string; customerRef?: string };
  sales: { saleId: string; lines: { productId: string; batches: { batchId: string; knownBy: string }[] }[] }[];
  batches: { batchId: string; depth: number; reachedFrom: string[]; receipts: { reference: string; supplierId: string | null }[]; madeBy: { runId: string; inputBatchIds: string[] }[] }[];
  suppliers: { supplierId: string; batchIds: string[]; references: string[] }[];
  gaps: string[]; complete: boolean;
  freshness: { salesBankedUpTo: string | null; detail: string };
  detail?: string;
}
interface Trail { matches: { actorId: string; action: string; objectType: string; objectId: string; at: string; after: Record<string, string> | null }[] }

const sale = (saleId: string, productId: string, qty: number, extra: { batchId?: string; customerRef?: string; tradingDay?: string } = {}) => ({
  saleId, receiptNumber: `R-${saleId}`, laneId: 'lane-1', locationId: 'S1', cashierId: 'u-owner', tradingDay: extra.tradingDay ?? '2026-10-10', committedAt: `${extra.tradingDay ?? '2026-10-10'}T10:00:00Z`,
  totalMinor: qty * 9_000, currency: 'INR', packVersion: 1,
  ...(extra.customerRef === undefined ? {} : { customerRef: extra.customerRef }),
  lines: [{ productId, quantityMinor: qty, uom: 'ea', unitPriceMinor: 9_000, lineTotalMinor: qty * 9_000, ...(extra.batchId === undefined ? {} : { batchId: extra.batchId }) }],
  tenders: [{ kind: 'cash', amountMinor: qty * 9_000 }],
});

describe.each(backings)('M10-FR-03: the trace runs backwards from a sale or a customer, and every trace read is logged — on $name', ({ harness, restart }) => {
  it('bill → batch → goods receipt → supplier; customer → their bills → the same; FIFO estimates and walk-ins said; every read sealed', async () => {
    let h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await approvedSuppliers(h, T, 'sup-dairy');
    await deliveryPlaces(h, T, 'S1', 'WH');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    await h.provisionRole(T, 'u-cash', 'cashier');
    const req = (method: 'GET' | 'POST', path: string, body?: unknown, userId = 'u-owner'): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'POST' ? { idempotencyKey: `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }) });
    const ok = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
    // Paneer is batch-tracked on the pack, so a bill that recorded no batch gets head office's FIFO estimate.
    await h.store.append(T, STREAM.catalogue, makeEvent({
      id: `pack-${T}-1`, type: 'CataloguePublished', occurredAt: AT, idempotencyKey: `catalogue-${T}-v1`, source: 'test/catalogue',
      payload: { snapshot: { tenantId: T, version: 1, builtAt: AT, scope: { tenantId: T, storeId: 'S1' }, barcodes: [],
        products: [{ productId: 'p-paneer', sku: 'PANEER', name: 'Paneer 200g', baseUom: 'ea', unitPriceMinor: 9_000, taxBps: 500, status: 'active', batchTracked: true, handling: 'ambient' }] } },
    }));
    await ok(req('POST', '/v1/inventory/receipt-policy', { excessToleranceBp: 500, shortageToleranceBp: 200, nearExpiryDays: 2, coldChainMaxC: 8 }), 'policy');
    await ok(req('POST', '/v1/purchase/orders/po-1', { supplierId: 'sup-dairy', deliverToLocationId: 'WH', lines: [{ productId: 'p-paneer', orderedQty: 30, unitCost: cost(6_000) }] }, 'u-mgr'), 'order');
    await ok(req('POST', '/v1/purchase/orders/po-1/approval', { reason: 'weekly dairy' }), 'approve order');
    await ok(req('POST', '/v1/inventory/goods-receipt/grn-1', {
      warehouseId: 'WH', receivedOnDate: '2026-10-09', currency: 'INR', poId: 'po-1',
      lines: [{ lineId: 'L1', productId: 'p-paneer', orderedMinor: 30, countedMinor: 30, uom: 'ea', unitCost: cost(6_000), condition: 'good', batchId: 'B-7', expiry: '2030-12-31' }],
    }, 'u-mgr'), 'goods receipt');
    // Three bills: the member's with the batch on it, the member's with no batch recorded, and a walk-in's.
    await ok(req('POST', '/v1/sales', sale('S-77', 'p-paneer', 2, { batchId: 'B-7', customerRef: 'cust-7' })), 'S-77');
    await ok(req('POST', '/v1/sales', sale('S-78', 'p-paneer', 1, { customerRef: 'cust-7', tradingDay: '2026-10-11' })), 'S-78');
    await ok(req('POST', '/v1/sales', sale('S-79', 'p-paneer', 1, { batchId: 'B-7' })), 'S-79');

    h = restart(h); // ── COLD RESTART: the trace is folded from what is stored ──

    // Refused reads: a cashier, a bill head office does not hold, a reference that is not one.
    expect((await req('GET', '/v1/quality/lot-trace/backward/sales/S-77', undefined, 'u-cash')).status).toBe(403);
    expect((await req('GET', '/v1/quality/lot-trace/backward/customers/cust-7', undefined, 'u-cash')).status).toBe(403);
    expect((await req('GET', '/v1/quality/lot-trace/backward/sales/S-NOPE')).status).toBe(404);
    expect((await req('GET', `/v1/quality/lot-trace/backward/customers/${'x'.repeat(81)}`)).status).toBe(400);

    // From the BILL: the batch the till recorded, the goods receipt it came on, the supplier. Nothing missing.
    const bill = (await ok(req('GET', '/v1/quality/lot-trace/backward/sales/S-77', undefined, 'u-mgr'), 'by sale')).body as Backward;
    expect(bill.start).toEqual({ saleId: 'S-77' });
    expect(bill.sales[0]!.lines[0]!.batches).toEqual([{ batchId: 'B-7', knownBy: 'till_recorded' }]);
    expect(bill.batches).toHaveLength(1);
    expect(bill.batches[0]).toMatchObject({ batchId: 'B-7', depth: 0, reachedFrom: ['sale S-77'] });
    expect(bill.batches[0]!.receipts).toEqual([expect.objectContaining({ supplierId: 'sup-dairy' })]);
    expect(bill.batches[0]!.receipts[0]!.reference).toMatch(/^GRN .* \(PO po-1\)$/);
    expect(bill.suppliers).toEqual([expect.objectContaining({ supplierId: 'sup-dairy', batchIds: ['B-7'] })]);
    expect(bill.gaps).toEqual([]);
    expect(bill.complete).toBe(true);
    expect(bill.freshness.salesBankedUpTo).not.toBeNull();
    expect(bill.freshness.detail).toMatch(/not sent yet is not in this trace/);

    // From the CUSTOMER: both of their bills — the one with no batch recorded is a FIFO estimate, and says so.
    const cust = (await ok(req('GET', '/v1/quality/lot-trace/backward/customers/cust-7'), 'by customer')).body as Backward;
    expect(cust.start).toEqual({ customerRef: 'cust-7' });
    expect(cust.sales.map((s) => s.saleId)).toEqual(['S-77', 'S-78']); // the walk-in's bill is not theirs
    expect(cust.sales[1]!.lines[0]!.batches).toEqual([{ batchId: 'B-7', knownBy: 'fifo_estimate' }]);
    expect(cust.suppliers.map((s) => s.supplierId)).toEqual(['sup-dairy']);
    expect(cust.gaps.join(' | ')).toMatch(/sale S-78: the batch of p-paneer is a FIFO estimate, not a till record/);
    expect(cust.complete).toBe(false);
    expect(cust.detail).toMatch(/2 bill\(s\) name this customer; 1 supplier/);
    const stranger = (await ok(req('GET', '/v1/quality/lot-trace/backward/customers/cust-none'), 'nobody')).body as Backward;
    expect(stranger.sales).toEqual([]);
    expect(stranger.detail).toMatch(/No bill head office holds names this customer/);

    // The forward trace now names the member the till keyed (before, only a stored-value link could name a customer).
    const sold = (await ok(req('GET', '/v1/quality/lot-trace/B-7/sold'), 'sold')).body as { outbound: { saleId: string; customerId?: string }[] };
    expect(sold.outbound.find((r) => r.saleId === 'S-77')?.customerId).toBe('cust-7');
    expect(sold.outbound.find((r) => r.saleId === 'S-79')?.customerId).toBeUndefined(); // the walk-in stays a walk-in
    const chain = (await ok(req('GET', '/v1/quality/lot-trace/B-7/chain'), 'chain')).body as { rows: { hop: string; reference: string; to: string }[] };
    expect(chain.rows.find((r) => r.reference === 'sale S-77')?.to).toBe('cust-7');

    // Every trace read is on the audit trail: who, when, what, how many customers it named. The refused ones are not.
    h = restart(h);
    const trail = (await ok(h.request({ method: 'GET', path: '/v1/audit/trail', userId: 'u-owner', tenantId: T, query: { action: 'quality.lottrace.read' } }), 'trail')).body as Trail;
    const reads = trail.matches.map((m) => [m.actorId, m.objectId, m.after?.['query'], m.after?.['customersNamed']]);
    expect(reads).toEqual([
      ['u-mgr', 'sale:S-77', 'GET /v1/quality/lot-trace/backward/sales/S-77', '0'],
      ['u-owner', 'customer:cust-7', 'GET /v1/quality/lot-trace/backward/customers/cust-7', '1'],
      ['u-owner', 'customer:cust-none', 'GET /v1/quality/lot-trace/backward/customers/cust-none', '1'],
      ['u-owner', 'batch:B-7', 'GET /v1/quality/lot-trace/B-7/sold', '1'],
      ['u-owner', 'batch:B-7', 'GET /v1/quality/lot-trace/B-7/chain', '1'],
    ]);
    expect(trail.matches.every((m) => m.objectType === 'lot-trace' && typeof m.at === 'string' && m.at !== '')).toBe(true);
  }, 120_000);

  it('a bill for something the kitchen made reaches the ingredient batches and their suppliers; an ingredient with no receipt note is a gap', async () => {
    let h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await approvedSuppliers(h, T, 'sup-mill');
    await deliveryPlaces(h, T, 'S1');
    await h.provisionRole(T, 'u-baker', 'store_manager');
    await h.provisionRole(T, 'u-qc', 'store_manager');
    await h.enableFeature(T, 'dept.bakery');
    const req = (method: 'GET' | 'POST', path: string, body?: unknown, userId = 'u-owner'): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'POST' ? { idempotencyKey: `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }) });
    const ok = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
    await ok(req('POST', '/v1/production/departments/bakery', {}), 'bakery on');
    await ok(req('POST', '/v1/inventory/receipt-policy', { excessToleranceBp: 500, shortageToleranceBp: 200, nearExpiryDays: 2, coldChainMaxC: 8 }), 'policy');
    // Flour from the mill, on an order and a goods receipt; sugar booked straight onto the ledger with no receipt note.
    await ok(req('POST', '/v1/purchase/orders/po-flour', { supplierId: 'sup-mill', deliverToLocationId: 'S1', lines: [{ productId: 'FLOUR', orderedQty: 2_000, unitCost: cost(4_000) }] }, 'u-baker'), 'flour order');
    await ok(req('POST', '/v1/purchase/orders/po-flour/approval', { reason: 'bakery flour' }), 'approve flour');
    await ok(req('POST', '/v1/inventory/goods-receipt/grn-flour', {
      warehouseId: 'S1', receivedOnDate: '2030-04-01', currency: 'INR', poId: 'po-flour',
      lines: [{ lineId: 'L1', productId: 'FLOUR', orderedMinor: 2_000, countedMinor: 2_000, uom: 'kg', unitCost: cost(4_000), condition: 'good', batchId: 'F-1', expiry: '2030-07-01' }],
    }, 'u-baker'), 'flour receipt');
    await ok(req('POST', '/v1/inventory/movements', { movementId: 'rx-sugar', productId: 'SUGAR', locationId: 'S1', kind: 'received', quantityMinor: 1_000, uom: 'kg', occurredAt: '2030-04-01T01:00:00.000Z', enteredBy: 'u-owner', unitCostMinor: 4_000, batchId: 'SG-1', expiry: '2030-12-01' }), 'sugar');
    await ok(req('POST', '/v1/production/recipes/bun', { departmentId: 'bakery', outputProductId: 'BUN', outputQuantityMinor: 10, outputUom: 'ea', shelfLifeHours: 48, expectedYieldBp: 9_000, yieldToleranceBp: 2_000, inputs: [{ productId: 'FLOUR', quantityMinor: 500, uom: 'kg' }, { productId: 'SUGAR', quantityMinor: 100, uom: 'kg' }] }), 'bun recipe');
    await ok(req('POST', '/v1/production/runs/run-1', { recipeId: 'bun', batches: 2, actualOutputMinor: 18, outputBatchId: 'BUN-A', locationId: 'S1' }, 'u-baker'), 'run 1');
    await ok(req('POST', '/v1/production/runs/run-1/release', { qcPassed: true }, 'u-qc'), 'release');
    await ok(req('POST', '/v1/sales', { ...sale('S-BUN-1', 'BUN', 3, { batchId: 'BUN-A', customerRef: 'cust-9', tradingDay: '2030-06-10' }), totalMinor: 27_000 }), 'bun sale');

    h = restart(h);
    const bill = (await ok(req('GET', '/v1/quality/lot-trace/backward/sales/S-BUN-1'), 'by sale')).body as Backward;
    expect(bill.batches.map((b) => [b.batchId, b.depth])).toEqual([['BUN-A', 0], ['F-1', 1], ['SG-1', 1]]);
    expect(bill.batches[0]!.madeBy).toEqual([expect.objectContaining({ runId: 'run-1', inputBatchIds: ['F-1', 'SG-1'] })]);
    expect(bill.batches[1]!.reachedFrom).toEqual(['ingredient of batch BUN-A (run run-1)']);
    expect(bill.suppliers).toEqual([expect.objectContaining({ supplierId: 'sup-mill', batchIds: ['F-1'] })]);
    expect(bill.gaps.join(' | ')).toMatch(/batch SG-1: 1000 received at S1 on 2030-04-01 with no goods-receipt note — the supplier is not known/);
    expect(bill.complete).toBe(false);
    // The customer's road reaches the mill too.
    const cust = (await ok(req('GET', '/v1/quality/lot-trace/backward/customers/cust-9'), 'by customer')).body as Backward;
    expect(cust.suppliers.map((s) => s.supplierId)).toEqual(['sup-mill']);
  }, 120_000);
});
