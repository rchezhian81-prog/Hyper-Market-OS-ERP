import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { STREAM } from '../../services/api/src/adapters';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';

/**
 * **M09-FR-03 · SF-05 · hard rule #10 (round 10, found while checking A03's transfer suggestions) — a stock transfer is valued
 * at HEAD OFFICE's own cost of the stock at the sending location, never at a cost the proposer types.**
 *
 * Before, `POST /v1/warehouse/transfers/:id` took each line's `unitCost` from the body, and that figure priced the shortfall
 * exception on arrival and (where the source held no cost at dispatch) the confirmed loss handed to finance — a proposer could
 * make missing stock look worthless. Now the proposer's figure is IGNORED (said in the reply as `ignoredFromCaller`): the line
 * is valued from head office's own average cost at the sending place when proposed, the stock that leaves carries the cost it
 * left with (set at dispatch), and both the shortfall exception and the confirmed loss are valued from those. Where head
 * office holds no cost, the line says so (`costUnknown`) rather than taking the proposer's word. On the real API, in memory
 * and — with DATABASE_URL — on real PostgreSQL.
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
const backings: { name: string; harness: () => ApiHarness }[] = [{ name: 'the in-memory event store', harness: () => apiHarness() }];
if (DATABASE_URL !== undefined) backings.push({ name: 'real PostgreSQL', harness: () => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); } });

type Res = { status: number; body: unknown };

describe.each(backings)('a transfer is valued at head office\'s own cost of the sending location — on $name', ({ harness }) => {
  it('the proposer\'s cost is ignored and said so; the shortfall exception and the confirmed loss carry head office\'s cost; an uncosted line is named', async () => {
    const h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    for (const u of ['u-boss', 'u-store', 'u-area']) await h.provisionRole(T, u, 'store_manager');
    let n = 0;
    const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(body === undefined ? {} : { body }), ...(method === 'GET' ? {} : { idempotencyKey: `k-${n += 1}` }) });
    const ok = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
    await ok(call('POST', '/v1/org/nodes/C1', 'u-owner', { kind: 'company', name: 'SRE Retail' }), 'company');
    await ok(call('POST', '/v1/org/nodes/WH', 'u-owner', { kind: 'warehouse', name: 'Central warehouse', parentId: 'C1', companyId: 'C1' }), 'warehouse');
    await ok(call('POST', '/v1/org/nodes/S1', 'u-owner', { kind: 'branch', name: 'Store 1', parentId: 'C1', companyId: 'C1' }), 'store');
    // P1 at the warehouse at ₹50.00 each (head office's cost); P2 there with no cost on record.
    await ok(call('POST', '/v1/inventory/movements', 'u-owner', { movementId: 'rx-p1', productId: 'P1', locationId: 'WH', kind: 'received', quantityMinor: 20, uom: 'EA', occurredAt: '2026-08-01T00:00:00.000Z', enteredBy: 'u-owner', unitCostMinor: 5_000 }), 'stock P1');
    await ok(call('POST', '/v1/inventory/movements', 'u-owner', { movementId: 'rx-p2', productId: 'P2', locationId: 'WH', kind: 'received', quantityMinor: 5, uom: 'EA', occurredAt: '2026-08-01T00:00:00.000Z', enteredBy: 'u-owner' }), 'stock P2 (uncosted)');

    // The proposer types ₹0.01 a unit: ignored, said so; the line carries head office's ₹50.00.
    const proposed = await ok(call('POST', '/v1/warehouse/transfers/t1', 'u-owner', { fromLocationId: 'WH', toLocationId: 'S1', lines: [{ productId: 'P1', batchId: null, quantityMinor: 10, uom: 'EA', unitCost: { minor: 1, currency: 'INR' } }] }), 'propose');
    expect(proposed.body).toMatchObject({ transferId: 't1', state: 'proposed', unitCostsMinor: [5_000], costUnknown: [], ignoredFromCaller: ['unitCost'] });
    expect(((await call('GET', '/v1/warehouse/transfers/t1', 'u-owner')).body as { lines: { unitCost: { minor: number } }[] }).lines[0]?.unitCost.minor).toBe(5_000);
    // A proposal with no cost at all is read (the cost is not the proposer's to send).
    expect((await ok(call('POST', '/v1/warehouse/transfers/t0', 'u-owner', { fromLocationId: 'WH', toLocationId: 'S1', lines: [{ productId: 'P1', batchId: null, quantityMinor: 1, uom: 'EA' }] }), 'propose without cost')).body).toMatchObject({ unitCostsMinor: [5_000], ignoredFromCaller: [] });

    // Dispatched by another person, counted in SHORT (8 of 10): the exception is valued at head office's cost — 2 × ₹50.00.
    await ok(call('POST', '/v1/warehouse/transfers/t1/dispatch', 'u-boss', {}), 'dispatch');
    const received = await ok(call('POST', '/v1/warehouse/transfers/t1/receive', 'u-store', { counted: [{ productId: 'P1', batchId: null, quantityMinor: 8 }] }), 'receive short');
    expect((received.body as { discrepancies: { differenceMinor: number; value: { minor: number } }[] }).discrepancies).toEqual([expect.objectContaining({ differenceMinor: -2, value: { minor: 10_000, currency: 'INR' } })]);
    const ex = (await call('GET', '/v1/inventory/exceptions', 'u-owner')).body as { transferShortfalls: { transferId: string; value: { minor: number } }[] };
    expect(ex.transferShortfalls.find((s) => s.transferId === 't1')?.value.minor).toBe(10_000);
    // The units that arrived are on the books at the value they left with.
    const val = (await call('GET', '/v1/inventory/valuation', 'u-owner')).body as { rows: { productId: string; locationId: string; value: { minor: number } }[] };
    expect(val.rows.find((r) => r.productId === 'P1' && r.locationId === 'S1')?.value.minor).toBe(40_000);
    // Confirmed lost: handed to finance at head office's cost.
    const resolved = await ok(call('POST', '/v1/warehouse/transfers/t1/shortfall/resolution', 'u-area', { lines: [], reasonCode: 'miscount', note: 'searched the van and the bay' }), 'resolve');
    expect((resolved.body as { resolution: { lines: { lostMinor: number; unitCostMinor: number; lostValueMinor: number }[] } }).resolution.lines).toEqual([expect.objectContaining({ lostMinor: 2, unitCostMinor: 5_000, lostValueMinor: 10_000 })]);
    const loss = (await h.store.readStream(T, [STREAM.warehouse, 'transfers'].join('\u001f'), { type: 'TransferShortfallResolved' })).at(-1)!.event.payload as { loss: { lostValueMinor: number } };
    expect(loss.loss.lostValueMinor).toBe(10_000);

    // Head office holds no cost for P2: the proposer's ₹999.99 is still not taken — the line says the cost is unknown.
    const uncosted = await ok(call('POST', '/v1/warehouse/transfers/t2', 'u-owner', { fromLocationId: 'WH', toLocationId: 'S1', lines: [{ productId: 'P2', batchId: null, quantityMinor: 5, uom: 'EA', unitCost: { minor: 99_999, currency: 'INR' } }] }), 'propose uncosted');
    expect(uncosted.body).toMatchObject({ unitCostsMinor: [null], costUnknown: ['P2'], ignoredFromCaller: ['unitCost'] });
    expect(((await call('GET', '/v1/warehouse/transfers/t2', 'u-owner')).body as { lines: { unitCost: { minor: number } }[] }).lines[0]?.unitCost.minor).toBe(0);
  });
});
