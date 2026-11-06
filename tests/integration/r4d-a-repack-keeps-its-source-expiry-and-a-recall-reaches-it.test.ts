import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { certifyFoodHandler } from '../support/food-handler';

/**
 * **Round 4d · M11-FR-03 "repacking — a repack is traceable to its source batch".** Through the real API, in memory and on
 * real PostgreSQL (with a cold restart):
 *   • a batch on hand is repacked under a NEW batch id: the new batch carries the SOURCE's expiry, the source leaves stock
 *     in the same write, and the new batch waits for its quality release like any other production output;
 *   • refused by name: more than the batch holds, an expired source, a new batch with the source's own id, a repack id
 *     used twice, a cashier;
 *   • the lot trace of the source shows the repack; the repacked batch's trace shows where it came from; and a RECALL on
 *     the source reaches the customer who bought the repacked packs (the call list says it was made from the source).
 */

const DATABASE_URL = process.env['DATABASE_URL'];
let pool: Pool | undefined;
beforeAll(async () => {
  if (DATABASE_URL === undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL, max: 4, options: '-c app.tenant_id=*' });
  const dir = 'db/migrations';
  await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
});
afterAll(async () => { await pool?.end(); });
const backings: { name: string; harness: () => ApiHarness; restart: (h: ApiHarness) => ApiHarness }[] = [
  { name: 'the in-memory event store', harness: () => apiHarness(), restart: (h) => apiHarness({ store: h.store }) },
];
if (DATABASE_URL !== undefined) {
  const pg = (): ApiHarness => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); };
  backings.push({ name: 'real PostgreSQL', harness: pg, restart: () => pg() });
}

type Res = { status: number; body: unknown };
const sale = (saleId: string, productId: string, batchId: string, customerRef: string) => ({
  saleId, receiptNumber: `R-${saleId}`, laneId: 'lane-1', locationId: 'S1', cashierId: 'u-owner', tradingDay: '2030-06-10', committedAt: '2030-06-10T10:00:00Z',
  totalMinor: 9_000, currency: 'INR', packVersion: 1, customerRef,
  lines: [{ productId, quantityMinor: 1, uom: 'ea', unitPriceMinor: 9_000, lineTotalMinor: 9_000, batchId }],
  tenders: [{ kind: 'cash', amountMinor: 9_000 }],
});

describe.each(backings)('M11-FR-03 — a repack keeps its source\'s expiry, and a recall on the source reaches it — on $name', ({ harness, restart }) => {
  it('repacks, refuses what cannot stand, and the trace and the recall reach the repacked packs', async () => {
    let h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await certifyFoodHandler(h.store, T, 'u-owner'); // OB-502: food-handling work needs a valid certificate
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    await h.provisionRole(T, 'u-cash', 'cashier');
    await h.enableFeature(T, 'dept.bakery');
    const req = (method: 'GET' | 'POST', path: string, body?: unknown, userId = 'u-owner'): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'POST' ? { idempotencyKey: `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }) });
    const ok = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
    const codeOf = (r: Res) => (r.body as { error?: { code?: string } }).error?.code;

    await ok(req('POST', '/v1/org/nodes/C1', { kind: 'company', name: 'SRE Retail' }), 'company');
    await ok(req('POST', '/v1/org/nodes/S1', { kind: 'branch', name: 'Store 1', parentId: 'C1', companyId: 'C1' }), 'store');
    await ok(req('POST', '/v1/production/departments/bakery', {}), 'bakery on');
    await ok(req('POST', '/v1/inventory/movements', { movementId: 'rx-CK-1', productId: 'COOKIES', locationId: 'S1', kind: 'received', quantityMinor: 20, uom: 'ea', occurredAt: '2030-04-01T01:00:00.000Z', enteredBy: 'u-owner', unitCostMinor: 4_000, batchId: 'CK-1', expiry: '2030-12-01' }), 'receive CK-1');
    await ok(req('POST', '/v1/inventory/movements', { movementId: 'rx-CK-OLD', productId: 'COOKIES', locationId: 'S1', kind: 'received', quantityMinor: 5, uom: 'ea', occurredAt: '2020-01-01T01:00:00.000Z', enteredBy: 'u-owner', unitCostMinor: 4_000, batchId: 'CK-OLD', expiry: '2020-02-01' }), 'receive CK-OLD');
    const repack = (repackId: string, over: Record<string, unknown> = {}, who = 'u-owner') =>
      req('POST', `/v1/production/repacks/${repackId}`, { departmentId: 'bakery', productId: 'COOKIES', locationId: 'S1', sourceBatchId: 'CK-1', newBatchId: 'CK-1-R1', quantityMinor: 6, uom: 'ea', ...over }, who);

    // refused by name, nothing recorded
    const tooMany = await repack('rp-x', { quantityMinor: 30 });
    expect([tooMany.status, codeOf(tooMany)]).toEqual([409, 'repack_source_not_on_hand']);
    const expired = await repack('rp-old', { sourceBatchId: 'CK-OLD', newBatchId: 'CK-OLD-R', quantityMinor: 2 });
    expect([expired.status, codeOf(expired)]).toEqual([422, 'repack_refused']);
    const same = await repack('rp-same', { newBatchId: 'CK-1' });
    expect([same.status, codeOf(same)]).toEqual([422, 'repack_refused']);
    expect((await repack('rp-cash', {}, 'u-cash')).status).toBe(403);

    // the repack: the new batch keeps the source's expiry and waits for release
    const done = (await ok(repack('rp-1'), 'repack')).body as { runId: string; expiresAt: string; awaitingRelease: boolean; valued: boolean };
    expect(done).toMatchObject({ runId: 'repack-rp-1', expiresAt: '2030-12-01', awaitingRelease: true, valued: true });
    const again = await repack('rp-1');
    expect([again.status, codeOf(again)]).toEqual([409, 'repack_already_recorded']);
    await ok(req('POST', '/v1/production/runs/repack-rp-1/release', { qcPassed: true }, 'u-mgr'), 'release the repack');

    h = restart(h); // ── COLD RESTART ──
    // the source's trace shows what was made from it; the repacked batch's trace shows it was produced by the repack
    const chain = (await ok(req('GET', '/v1/quality/lot-trace/CK-1/chain'), 'source chain')).body as { rows: { hop: string; reference: string; to: string; quantityMinor: number }[] };
    expect(chain.rows.some((r) => r.hop === 'production_used' && JSON.stringify(r).includes('CK-1-R1') && r.quantityMinor === 6)).toBe(true);
    const made = (await ok(req('GET', '/v1/quality/lot-trace/CK-1-R1/chain'), 'repack chain')).body as { rows: { hop: string; reference: string }[] };
    expect(made.rows.some((r) => r.hop === 'production_made' && r.reference.includes('repack-rp-1'))).toBe(true);
    const inputs = (await ok(req('GET', '/v1/production/batches/CK-1-R1/inputs'), 'backward')).body as { runs: { runId: string; inputBatches: { batchId: string }[] }[] };
    expect(inputs.runs).toEqual([expect.objectContaining({ runId: 'repack-rp-1', inputBatches: [expect.objectContaining({ batchId: 'CK-1' })] })]);

    // a customer buys a repacked pack; a recall on the SOURCE reaches them
    await ok(req('POST', '/v1/sales', sale('S-D', 'COOKIES', 'CK-1-R1', 'cust-D')), 'sale of the repack');
    await ok(req('POST', '/v1/quality/recalls/CK-1', { reason: 'supplier notice: cookies recalled' }, 'u-mgr'), 'recall the source');
    const list = (await ok(req('GET', '/v1/quality/recalls/CK-1/notice-list', undefined, 'u-mgr'), 'call list')).body as { callList: { customerRef: string; bought: { lot: string; madeFromLot?: string }[] }[] };
    expect(list.callList.find((c) => c.customerRef === 'cust-D')?.bought).toEqual([expect.objectContaining({ lot: 'CK-1-R1', madeFromLot: 'CK-1' })]);
  });
});
