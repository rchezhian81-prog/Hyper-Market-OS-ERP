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
 * batch, and a few units booked straight onto the ledger with no receipt note (a gap the trace must name). The production
 * hop is D-25's (Lane 4): until it records which batches a run used, the trace says so.
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
    for (const u of ['u-mgr', 'u-boss', 'u-store']) await h.provisionRole(T, u, 'store_manager');
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
    await ok(req('POST', '/v1/purchase/orders/po-1', { supplierId: 'sup-dairy', deliverToLocationId: 'WH', lines: [{ productId: 'p-paneer', orderedQty: 30, unitCost: cost(6_000) }] }, 'u-mgr'), 'order');
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
    expect(chain).toMatchObject({ receivedMinor: 34, soldMinor: 2, usedInProductionMinor: 'not_known', complete: false, sortedBy: 'date' });
    expect(chain.gaps.join(' | ')).toMatch(/4 received at S1 .* no goods-receipt note \(movement mv-direct-B-7\)/);
    expect(chain.gaps.join(' | ')).toMatch(/used in production is not known: .*D-25/);
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
});
