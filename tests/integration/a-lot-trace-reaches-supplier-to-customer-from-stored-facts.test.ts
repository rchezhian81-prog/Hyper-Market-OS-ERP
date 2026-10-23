import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { approvedSuppliers, deliveryPlaces } from '../support/approved-supplier';
import { STREAM } from '../../services/api/src/adapters';
import { lotTraceRequestsAdapter } from '../../services/api/src/r3-till-trace-adapters';
import { makeEvent } from '../../packages/contracts/src/event';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { traceDueAt } from '../../packages/quality/src/lot-trace-chain';

/**
 * **D-26 (roadmap v2.1 · FSMA 204 / GS1 "one-up, one-down" · M10-FR-03) through the real API — in memory and on real
 * PostgreSQL, with a cold restart.** Signed sentence: "for any batch, one call returns supplier → GRN → transfers →
 * production → sales, all from stored facts, as a sortable CSV. A trace request not answered within 24 h raises an
 * exception."
 *
 * The facts are put in the way the shop puts them in: a purchase order to an approved supplier, a goods receipt of batch
 * B-7 against it, a transfer from the back store to the floor dispatched and received by different people, a sale of the
 * batch, and a few units booked straight onto the ledger with no receipt note (a gap the trace must name).
 *
 * The production hop reads D-25 (Lane 4): a bakery run records the flour batch it used, so a trace of the flour batch
 * reaches the bun batch it went into and the bun's sales — and no longer says the hop is missing.
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
interface Chain {
  rows: { hop: string; reference: string; from: string; to: string; quantityMinor: number }[];
  gaps: string[]; complete: boolean; csv: string; sortedBy: string; receivedMinor: number; soldMinor: number; usedInProductionMinor: number | string;
}

describe.each(backings)('D-26: a lot trace reaches supplier to customer from stored facts — on $name', ({ harness, restart }) => {
  it('one call: supplier → GRN → transfer → sale, with the gaps named, as a CSV sorted by the column asked for; a request answered in 24 h, one not answered raises an exception', async () => {
    let h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await approvedSuppliers(h, T, 'sup-dairy');
    await deliveryPlaces(h, T, 'S1', 'WH');
    for (const u of ['u-mgr', 'u-boss', 'u-store', 'u-po-buyer']) await h.provisionRole(T, u, 'store_manager'); // OB-288 P3 (§28): the buyer who raises the order is never the one who books it in
    await h.provisionRole(T, 'u-cash', 'cashier');
    const req = (method: 'GET' | 'POST', path: string, body?: unknown, userId = 'u-owner', query?: Record<string, string>): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'POST' ? { idempotencyKey: `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });
    const ok = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
    await h.store.append(T, STREAM.catalogue, makeEvent({
      id: `pack-${T}-1`, type: 'CataloguePublished', occurredAt: AT, idempotencyKey: `catalogue-${T}-v1`, source: 'test/catalogue',
      payload: { snapshot: { tenantId: T, version: 1, builtAt: AT, scope: { tenantId: T, storeId: 'S1' }, barcodes: [],
        products: [{ productId: 'p-paneer', sku: 'PANEER', name: 'Ghee 500ml', baseUom: 'ea', unitPriceMinor: 9_000, taxBps: 500, status: 'active', batchTracked: true, handling: 'ambient' }] } },
    }));
    await ok(req('POST', '/v1/inventory/receipt-policy', { excessToleranceBp: 500, shortageToleranceBp: 200, nearExpiryDays: 2, coldChainMaxC: 8 }), 'policy');
    await ok(req('POST', '/v1/purchase/orders/po-1', { supplierId: 'sup-dairy', deliverToLocationId: 'WH', lines: [{ productId: 'p-paneer', orderedQty: 30, unitCost: cost(6_000) }] }, 'u-po-buyer'), 'order');
    await ok(req('POST', '/v1/purchase/orders/po-1/approval', { reason: 'weekly dairy' }), 'approve order');
    // The goods receipt of batch B-7 against the order.
    await ok(req('POST', '/v1/inventory/goods-receipt/grn-1', {
      warehouseId: 'WH', receivedOnDate: '2026-10-09', currency: 'INR', poId: 'po-1',
      lines: [{ lineId: 'L1', productId: 'p-paneer', orderedMinor: 30, countedMinor: 30, uom: 'ea', unitCost: cost(6_000), condition: 'good', batchId: 'B-7', expiry: '2030-12-31' }],
    }, 'u-mgr'), 'goods receipt');
    // Four more units of B-7 booked straight onto the floor's ledger, with no receipt note.
    await ok(req('POST', '/v1/inventory/movements', { movementId: 'mv-direct-B-7', productId: 'p-paneer', locationId: 'S1', kind: 'received', quantityMinor: 4, uom: 'EA', occurredAt: '2026-10-09T09:00:00.000Z', enteredBy: 'u-owner', batchId: 'B-7' }), 'direct receipt');
    // The back store sends 10 of B-7 to the floor: proposed by one person, dispatched by another, received by a third.
    await ok(req('POST', '/v1/warehouse/transfers/t-1', { fromLocationId: 'WH', toLocationId: 'S1', lines: [{ productId: 'p-paneer', batchId: 'B-7', quantityMinor: 10, uom: 'EA' }] }), 'propose transfer');
    await ok(req('POST', '/v1/warehouse/transfers/t-1/dispatch', {}, 'u-boss'), 'dispatch');
    await ok(req('POST', '/v1/warehouse/transfers/t-1/receive', { counted: [{ productId: 'p-paneer', batchId: 'B-7', quantityMinor: 10 }] }, 'u-store'), 'receive');
    // A sale of the batch at the till (the till captured it from the 2D code).
    await ok(req('POST', '/v1/sales', {
      saleId: 'S-77', receiptNumber: 'R-S-77', laneId: 'lane-1', locationId: 'S1', cashierId: 'u-owner', tradingDay: '2026-10-10', committedAt: '2026-10-10T10:00:00Z',
      totalMinor: 18_000, currency: 'INR', packVersion: 1,
      lines: [{ productId: 'p-paneer', quantityMinor: 2, uom: 'ea', unitPriceMinor: 9_000, lineTotalMinor: 18_000, batchId: 'B-7', batchExpiry: '2030-12-31' }],
      tenders: [{ kind: 'cash', amountMinor: 18_000 }],
    }), 'sale');

    h = restart(h);
    // Only someone who may read a lot trace sees it.
    expect((await req('GET', '/v1/quality/lot-trace/B-7/chain', undefined, 'u-cash')).status).toBe(403);
    const chain = (await ok(req('GET', '/v1/quality/lot-trace/B-7/chain'), 'chain')).body as Chain;
    // (Sorted by date by default; the receipt and transfer are dated by when they were booked, so the rows are compared
    // as a set here and the road order is checked with ?sort=hop — the test does not depend on the time of day.)
    expect(chain.rows.map((r) => [r.hop, r.from, r.to, r.quantityMinor])).toEqual(expect.arrayContaining([
      ['supplier_to_store', 'sup-dairy', 'WH', 30],
      ['supplier_to_store', 'not known', 'S1', 4],
      ['transfer', 'WH', 'S1', 10],
      ['sale', 'store', 'walk-in', 2],
    ]));
    expect(chain.rows).toHaveLength(4);
    expect(chain.rows.find((r) => r.from === 'sup-dairy')!.reference).toMatch(/^GRN .* \(PO po-1\)$/);
    const byHop = (await ok(req('GET', '/v1/quality/lot-trace/B-7/chain', undefined, 'u-owner', { sort: 'hop' }), 'by hop')).body as Chain;
    expect(byHop.csv.trim().split('\n').slice(1).map((l) => l.split(',')[1])).toEqual(['supplier_to_store', 'supplier_to_store', 'transfer', 'sale']);
    // No production run used B-7 (none is recorded at all): 0 used, said as a number — and the hop is no longer a gap.
    expect(chain).toMatchObject({ receivedMinor: 34, soldMinor: 2, usedInProductionMinor: 0, complete: false, sortedBy: 'date' });
    expect(chain.gaps.join(' | ')).toMatch(/4 received at S1 .* no goods-receipt note \(movement mv-direct-B-7\)/);
    expect(chain.gaps.join(' | ')).not.toMatch(/used in production is not known/);
    expect(chain.gaps).toHaveLength(1);
    // The CSV: one header, one row a hop, sortable by any column.
    const lines = chain.csv.trim().split('\n');
    expect(lines[0]).toBe('batch,hop,date,at,reference,from,to,product,quantity_minor,source');
    expect(lines).toHaveLength(5);
    const byQty = ((await ok(req('GET', '/v1/quality/lot-trace/B-7/chain', undefined, 'u-owner', { sort: 'quantity' }), 'sorted')).body as Chain).csv.trim().split('\n').slice(1).map((l) => l.split(',')[8]);
    expect(byQty).toEqual(['2', '4', '10', '30']);
    expect((await req('GET', '/v1/quality/lot-trace/B-7/chain', undefined, 'u-owner', { sort: 'colour' })).status).toBe(400);

    // A trace request: recorded with its 24-hour due time, answered in time with the CSV's fingerprint kept.
    expect((await req('POST', '/v1/quality/lot-trace/requests/TR-1', { batchId: 'B-7', askedBy: 'FSSAI food safety officer', reason: 'customer complaint' }, 'u-cash')).status).toBe(403);
    expect((await req('POST', '/v1/quality/lot-trace/requests/TR-1', { batchId: 'B-7' })).status).toBe(400);
    const asked = (await ok(req('POST', '/v1/quality/lot-trace/requests/TR-1', { batchId: 'B-7', askedBy: 'FSSAI food safety officer', reason: 'customer complaint' }), 'request')).body as { request: { requestedAt: string; dueAt: string } };
    expect(Date.parse(asked.request.dueAt) - Date.parse(asked.request.requestedAt)).toBe(24 * 3_600_000);
    const answered = (await ok(req('POST', '/v1/quality/lot-trace/requests/TR-1/answer', {}, 'u-mgr'), 'answer')).body as { state: string; answer: { csvSha256: string; rowCount: number }; csv: string };
    expect(answered).toMatchObject({ state: 'answered', answer: { rowCount: 4 } });
    expect(answered.answer.csvSha256).toMatch(/^[0-9a-f]{64}$/);
    // A request recorded two days ago and never answered — the 24 hours have passed.
    const old = '2026-10-01T09:00:00.000Z';
    await lotTraceRequestsAdapter({ store: h.store, now: () => old }).recordRequest(T, { requestId: 'TR-OLD', batchId: 'B-7', askedBy: 'supplier recall notice', reason: 'supplier recall', requestedAt: old, recordedBy: 'u-owner', dueAt: traceDueAt(old) });
    h = restart(h);
    const register = (await ok(req('GET', '/v1/quality/lot-trace/requests'), 'register')).body as { requests: { requestId: string; state: string }[]; exceptions: { requestId: string; kind: string; severity: string }[]; overdue: number };
    expect(register.requests.map((r) => [r.requestId, r.state])).toEqual([['TR-OLD', 'overdue'], ['TR-1', 'answered']]);
    expect(register.exceptions).toEqual([expect.objectContaining({ requestId: 'TR-OLD', kind: 'trace_request_not_answered_in_24h', severity: 'critical' })]);
    expect(register.overdue).toBe(1);
    // Answered late: answered, and the exception stays on the record.
    const late = (await ok(req('POST', '/v1/quality/lot-trace/requests/TR-OLD/answer', {}), 'late answer')).body as { state: string; exception?: { kind: string } };
    expect(late).toMatchObject({ state: 'answered_late', exception: { kind: 'trace_request_not_answered_in_24h' } });
    // Answered once, kept once.
    expect(((await ok(req('POST', '/v1/quality/lot-trace/requests/TR-1/answer', {}), 're-answer')).body as { alreadyAnswered: boolean }).alreadyAnswered).toBe(true);
  });
  it('the production hop (D-25): a flour batch → the bun batch a run made from it → the bun sales, with no gap for the hop', async () => {
    let h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-baker', 'store_manager');
    await h.provisionRole(T, 'u-qc', 'store_manager');
    await h.enableFeature(T, 'dept.bakery');
    const req = (method: 'GET' | 'POST', path: string, body?: unknown, userId = 'u-owner', query?: Record<string, string>): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'POST' ? { idempotencyKey: `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });
    const ok = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
    await ok(req('POST', '/v1/org/nodes/C1', { kind: 'company', name: 'SRE Retail' }), 'company');
    await ok(req('POST', '/v1/org/nodes/S1', { kind: 'branch', name: 'Store 1', parentId: 'C1', companyId: 'C1' }), 'store');
    await ok(req('POST', '/v1/production/departments/bakery', {}), 'bakery on');
    for (const [id, productId, qty, batchId, expiry] of [['rx-f1', 'FLOUR', 600, 'F-1', '2030-07-01'], ['rx-f2', 'FLOUR', 2_000, 'F-2', '2030-08-01'], ['rx-s1', 'SUGAR', 1_000, 'S-1', '2030-12-01']] as const) {
      await ok(req('POST', '/v1/inventory/movements', { movementId: id, productId, locationId: 'S1', kind: 'received', quantityMinor: qty, uom: 'kg', occurredAt: '2030-04-01T01:00:00.000Z', enteredBy: 'u-owner', unitCostMinor: 4_000, batchId, expiry }), id);
    }
    await ok(req('POST', '/v1/production/recipes/bun', { departmentId: 'bakery', outputProductId: 'BUN', outputQuantityMinor: 10, outputUom: 'ea', shelfLifeHours: 48, expectedYieldBp: 9_000, yieldToleranceBp: 2_000, inputs: [{ productId: 'FLOUR', quantityMinor: 500, uom: 'kg' }, { productId: 'SUGAR', quantityMinor: 100, uom: 'kg' }] }), 'bun recipe');
    // Two batches of buns: earliest expiry first, all of F-1 (600) and 400 of F-2 go in.
    await ok(req('POST', '/v1/production/runs/run-1', { recipeId: 'bun', batches: 2, actualOutputMinor: 18, outputBatchId: 'BUN-A', locationId: 'S1' }, 'u-baker'), 'run 1');
    await ok(req('POST', '/v1/production/runs/run-1/release', { qcPassed: true }, 'u-qc'), 'release');
    await ok(req('POST', '/v1/sales', {
      saleId: 'S-BUN-1', receiptNumber: 'R-BUN-1', laneId: 'lane-1', locationId: 'S1', cashierId: 'u-owner', tradingDay: '2030-06-10', committedAt: '2030-06-10T10:00:00Z',
      totalMinor: 1_500, currency: 'INR', packVersion: 1,
      lines: [{ productId: 'BUN', quantityMinor: 3, uom: 'ea', unitPriceMinor: 500, lineTotalMinor: 1_500, batchId: 'BUN-A' }], tenders: [{ kind: 'cash', amountMinor: 1_500 }],
    }), 'bun sale');

    h = restart(h); // ── COLD RESTART: the trace is folded from what is stored ──
    const chain = (await ok(req('GET', '/v1/quality/lot-trace/F-1/chain', undefined, 'u-owner', { sort: 'hop' }), 'chain')).body as Chain;
    // (The rows are compared as a set — the run is dated by when it was booked; the road order is checked on the CSV.)
    expect(chain.rows.map((r) => [r.hop, r.reference, r.from, r.to, r.quantityMinor])).toEqual(expect.arrayContaining([
      ['supplier_to_store', 'movement rx-f1', 'not known', 'S1', 600],
      ['production_used', 'production run run-1', 'F-1', 'BUN batch BUN-A', 600],
      ['sale', 'sale S-BUN-1', 'BUN batch BUN-A', 'walk-in', 3],
    ]));
    expect(chain.rows).toHaveLength(3);
    expect(chain.csv.trim().split('\n').slice(1).map((l) => l.split(',')[1])).toEqual(['supplier_to_store', 'production_used', 'sale']);
    expect(chain.usedInProductionMinor).toBe(600);
    // The output's sale is on the road but not counted as a sale of the flour itself.
    expect(chain.soldMinor).toBe(0);
    expect(chain.gaps.join(' | ')).not.toMatch(/used in production is not known|D-25/);
    expect(chain.csv).toMatch(/made from this batch in run run-1/);
    // F-2 went in too (400) — its trace reaches the same bun batch; sugar S-1 likewise.
    const f2 = (await ok(req('GET', '/v1/quality/lot-trace/F-2/chain'), 'F-2')).body as Chain;
    expect(f2.rows.filter((r) => r.hop === 'production_used').map((r) => [r.to, r.quantityMinor])).toEqual([['BUN batch BUN-A', 400]]);
    // The bun batch's own trace names the run that made it.
    const bun = (await ok(req('GET', '/v1/quality/lot-trace/BUN-A/chain'), 'BUN-A')).body as Chain;
    expect(bun.rows.map((r) => r.hop).sort()).toEqual(['production_made', 'sale']);
  }, 120_000);
});
