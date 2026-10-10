import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { withApprovals } from '../support/refund-approval';
import { STREAM } from '../../services/api/src/adapters';
import { makeEvent } from '../../packages/contracts/src/event';

/**
 * **OB-35 "A" — the lot at the till (owner decision, 10 Oct 2026).** The till does not scan a batch. When its sale reaches
 * head office, each line of a batch-tracked product that came without a batch is ASSIGNED the earliest-expiry batch on
 * hand at that store (FEFO), from Batch 2's batch-aware read. The assignment is recorded on the sale for recall tracing
 * and marked as an assignment, not a scan; the batch's stock goes down; a return keeps that lot; and the
 * `batch_tracked_sold_without_batch` finding stops firing when an assignment is made — and still fires for units no
 * batch on hand could cover. In memory and, with DATABASE_URL, on real PostgreSQL. Synthetic data only.
 */

let A = '';
let makeHarness: () => ApiHarness = () => apiHarness();

const DATABASE_URL = process.env['DATABASE_URL'];
let pool: Pool | undefined;
beforeAll(async () => {
  if (DATABASE_URL === undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
  const dir = 'db/migrations';
  await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
});
afterAll(async () => { await pool?.end(); });
const backings: { name: string; harness: () => ApiHarness }[] = [{ name: 'the in-memory event store', harness: () => apiHarness() }];
if (DATABASE_URL !== undefined) backings.push({ name: 'real PostgreSQL', harness: () => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); } });
const AT = new Date().toISOString();
const DAY = AT.slice(0, 10);

async function seeded(): Promise<ApiHarness> {
  const h = makeHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-box', 'store_computer');
  await h.provisionRole(A, 'u-mgr', 'store_manager');
  await h.store.append(A, STREAM.catalogue, makeEvent({
    id: `pack-${A}-1`, type: 'CataloguePublished', occurredAt: AT, idempotencyKey: `catalogue-${A}-v1`, source: 'test/catalogue',
    payload: { snapshot: { tenantId: A, version: 1, builtAt: AT, scope: { tenantId: A, storeId: 'store-1' }, barcodes: [], products: [
      { productId: 'MILK', sku: 'MILK-1L', name: 'Milk 1L', unitPriceMinor: 6_000, taxBps: 0, status: 'active', uom: 'each', batchTracked: true },
      { productId: 'DAL', sku: 'DAL-1KG', name: 'Toor dal 1kg', unitPriceMinor: 16_000, taxBps: 0, status: 'active', uom: 'each', batchTracked: false },
    ] } },
  }));
  const receive = async (id: string, batchId: string, expiry: string, qty: number) => expect((await h.request({
    method: 'POST', path: '/v1/inventory/movements', userId: 'u-owner', tenantId: A, idempotencyKey: id,
    body: { movementId: id, productId: 'MILK', locationId: 'store-1', kind: 'received', quantityMinor: qty, uom: 'each', occurredAt: AT, enteredBy: 'u-owner', batchId, expiry, unitCostMinor: 4_000 },
  })).status).toBeLessThan(300);
  await receive('r-late', 'M-LATE', '2099-12-31', 10);
  await receive('r-early', 'M-EARLY', '2099-06-30', 2);
  return h;
}

const sale = (saleId: string, milkQty: number, extra: Record<string, unknown> = {}) => ({
  saleId, receiptNumber: `R-${saleId}`, laneId: 'lane-1', cashierId: 'u-owner', tradingDay: DAY, committedAt: AT,
  totalMinor: milkQty * 6_000 + 16_000, currency: 'INR', packVersion: 1,
  lines: [
    { productId: 'MILK', quantityMinor: milkQty, uom: 'each', unitPriceMinor: 6_000, lineTotalMinor: milkQty * 6_000, ...extra },
    { productId: 'DAL', quantityMinor: 1, uom: 'each', unitPriceMinor: 16_000, lineTotalMinor: 16_000 },
  ],
  tenders: [{ kind: 'cash', amountMinor: milkQty * 6_000 + 16_000 }],
});
const bank = (h: ApiHarness, body: unknown, key: string) => h.request({ method: 'POST', path: '/v1/sales', userId: 'u-box', tenantId: A, idempotencyKey: key, body });
const banked = async (h: ApiHarness, saleId: string) =>
  (await h.store.readStream(A, STREAM.sales, { type: 'SaleCommitted' })).map((e) => e.event.payload as { saleId: string; lines: Record<string, unknown>[] }).find((s) => s.saleId === saleId);
const findings = async (h: ApiHarness, saleId: string) =>
  (await h.store.readStream(A, STREAM.saleExceptions, { type: 'SaleExceptionRaised' })).map((e) => e.event.payload as { saleId: string; kind: string }).filter((x) => x.saleId === saleId).map((x) => x.kind);
const onHand = async (h: ApiHarness) => ((await h.request({ method: 'GET', path: '/v1/inventory/batches', userId: 'u-owner', tenantId: A, query: { locationId: 'store-1', productId: 'MILK' } })).body as { batches: { batchId: string | null; onHandMinor: number }[] }).batches
  .map((b) => [b.batchId, b.onHandMinor]);

describe.each(backings)('OB-35 — head office assigns each sold line the earliest-expiry batch on hand — on $name', ({ harness }) => {
  beforeEach(() => { A = randomUUID(); makeHarness = harness; });

  it('splits a line across batches earliest expiry first, marks it an assignment, takes the stock off those batches, and raises no finding', async () => {
    const h = await seeded();
    expect((await bank(h, sale('S1', 3), 's1')).status).toBe(202);
    const s1 = await banked(h, 'S1');
    expect(s1?.lines).toEqual([
      expect.objectContaining({ productId: 'MILK', quantityMinor: 2, lineTotalMinor: 12_000, batchId: 'M-EARLY', batchExpiry: '2099-06-30', batchAssigned: 'fefo' }),
      expect.objectContaining({ productId: 'MILK', quantityMinor: 1, lineTotalMinor: 6_000, batchId: 'M-LATE', batchExpiry: '2099-12-31', batchAssigned: 'fefo' }),
      expect.not.objectContaining({ batchId: expect.anything() }),
    ]);
    expect(await findings(h, 'S1')).not.toContain('batch_tracked_sold_without_batch');
    expect(await onHand(h)).toEqual([['M-LATE', 9]]);
    // The same sale resent: nothing assigned or taken twice.
    expect((await bank(h, sale('S1', 3), 's1-again')).status).toBe(202);
    expect(await onHand(h)).toEqual([['M-LATE', 9]]);
  });

  it('a batch the till DID send is kept as a scan; a till cannot claim an assignment', async () => {
    const h = await seeded();
    expect((await bank(h, sale('S2', 1, { batchId: 'M-LATE', batchExpiry: '2099-12-31', batchAssigned: 'fefo' }), 's2')).status).toBe(202);
    const line = (await banked(h, 'S2'))!.lines[0]!;
    expect(line).toMatchObject({ batchId: 'M-LATE' });
    expect(line['batchAssigned']).toBeUndefined();
    expect(await onHand(h)).toEqual([['M-EARLY', 2], ['M-LATE', 9]]);
  });

  it('units no batch on hand covers stay unbatched and the finding still fires for them', async () => {
    const h = await seeded();
    expect((await bank(h, sale('S3', 14), 's3')).status).toBe(202);
    const lines = (await banked(h, 'S3'))!.lines.filter((l) => l['productId'] === 'MILK');
    expect(lines.map((l) => [l['batchId'] ?? null, l['quantityMinor'], l['lineTotalMinor']])).toEqual([['M-EARLY', 2, 12_000], ['M-LATE', 10, 60_000], [null, 2, 12_000]]);
    expect(await findings(h, 'S3')).toContain('batch_tracked_sold_without_batch');
  });

  it('with no batch on hand at all, nothing is assigned and the finding fires', async () => {
    const h = makeHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-box', 'store_computer');
    await h.store.append(A, STREAM.catalogue, makeEvent({
      id: `pack-${A}-1`, type: 'CataloguePublished', occurredAt: AT, idempotencyKey: `catalogue-${A}-v1`, source: 'test/catalogue',
      payload: { snapshot: { tenantId: A, version: 1, builtAt: AT, scope: { tenantId: A, storeId: 'store-1' }, barcodes: [], products: [
        { productId: 'MILK', sku: 'MILK-1L', name: 'Milk 1L', unitPriceMinor: 6_000, taxBps: 0, status: 'active', uom: 'each', batchTracked: true },
      ] } },
    }));
    expect((await bank(h, sale('S4', 1), 's4')).status).toBe(202);
    expect((await banked(h, 'S4'))!.lines[0]).not.toHaveProperty('batchId');
    expect(await findings(h, 'S4')).toContain('batch_tracked_sold_without_batch');
  });

  it('a return keeps the assigned lot', async () => {
    const h = await seeded();
    expect((await bank(h, sale('S5', 1), 's5')).status).toBe(202);
    const res = await h.request({ method: 'POST', path: '/v1/sales/S5/returns', userId: 'u-owner', tenantId: A, idempotencyKey: 'ret-S5',
      body: await withApprovals(h, A, 'u-owner', 'S5', { returnId: 'RT-S5', reasonCode: 'customer_changed_mind', lines: [{ productId: 'MILK', uom: 'each', quantityMinor: 1, disposition: 'resell' }], refundMinor: 6_000, refundTender: 'cash', approvedBy: 'u-mgr' }) });
    expect(res.status).toBe(201);
    const recorded = (await h.store.readStream(A, STREAM.returns, { type: 'ReturnRecorded' })).map((e) => e.event.payload as { returnId: string; lines: Record<string, unknown>[] }).find((r) => r.returnId === 'RT-S5');
    expect(recorded?.lines).toEqual([expect.objectContaining({ batchId: 'M-EARLY', batchExpiry: '2099-06-30' })]);
    expect(await onHand(h)).toEqual([['M-EARLY', 2], ['M-LATE', 10]]);
  });
});
