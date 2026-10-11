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

/**
 * **D05-FR-03 — the online safety-stock buffer (round 8 · M18-FR-02 · P-02 · P-08 · hard rule #1).** On the real API, in
 * memory and — with DATABASE_URL — on real PostgreSQL: the store keeps a number of units back from what the APP may promise
 * (per product, or one figure for the whole store), set by the store with a reason; a promise is made against on hand −
 * already promised − the buffer and says why it is short; the till is not limited at all; with no figure set nothing is kept
 * back and the read says so.
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
const codeOf = (r: Res): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
interface Row { productId: string; onHandMinor: number; promisedMinor: number; bufferMinor: number; appMayPromiseMinor: number; flags?: string[] }

describe.each(backings)('the app keeps an online buffer for shoppers in the store — on $name (D05-FR-03)', ({ harness }) => {
  it('no figure: nothing kept back, said; a product figure and a store-wide figure limit the APP\'s promise only; the till sells on', async () => {
    const h = harness();
    const T = randomUUID();
    const today = new Date().toISOString().slice(0, 10);
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    await h.provisionRole(T, 'u-till', 'cashier');
    const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, key?: string, query?: Record<string, string>): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }), ...(method === 'GET' ? {} : { idempotencyKey: key ?? `${path}-${JSON.stringify(body)}` }) });
    for (const [p, q] of [['MILK', 10], ['BREAD', 5]] as const) {
      expect((await call('POST', '/v1/inventory/movements', 'u-owner', { movementId: `rx-${p}`, productId: p, locationId: 'S1', kind: 'received', quantityMinor: q, uom: 'ea', occurredAt: '2026-10-01T06:00:00.000Z', enteredBy: 'u-owner', unitCostMinor: 2_000 }, `rx-${p}`)).status).toBe(202);
    }
    const view = async () => ((await call('GET', '/v1/inventory/online-availability', 'u-mgr', undefined, undefined, { locationId: 'S1' })).body as { rows: Row[] }).rows;

    // No figure set: nothing is kept back — and the read says so.
    expect((await view()).find((r) => r.productId === 'MILK')).toMatchObject({ bufferMinor: 0, appMayPromiseMinor: 10, flags: ['buffer_not_set'] });

    // Who may set it, and what a figure must be.
    expect((await call('POST', '/v1/inventory/online-buffer', 'u-till', { locationId: 'S1', productId: 'MILK', bufferMinor: 3, reason: 'x' })).status).toBe(403);
    expect(codeOf(await call('POST', '/v1/inventory/online-buffer', 'u-mgr', { locationId: 'S1', productId: 'MILK', bufferMinor: -1, reason: 'x' }))).toBe('not_readable_as_an_online_buffer');
    expect((await call('POST', '/v1/inventory/online-buffer', 'u-mgr', { locationId: 'S1', productId: 'MILK', bufferMinor: 3, reason: 'morning walk-in rush' }, 'buf-milk')).status).toBe(201);
    expect((await call('POST', '/v1/inventory/online-buffer', 'u-mgr', { locationId: 'S1', productId: null, bufferMinor: 1, reason: 'one of everything for the shelf' }, 'buf-all')).status).toBe(201);

    // An online order for 8 milk and 5 bread: 7 milk (10 − 3 kept back), 4 bread (5 − the store-wide 1). Said why.
    const promised = await call('POST', '/v1/orders/o-1/promise', 'u-owner', { locationId: 'S1', lines: [{ productId: 'MILK', quantityMinor: 8 }, { productId: 'BREAD', quantityMinor: 5 }] }, 'o-1');
    expect(promised.status).toBeLessThan(300);
    const lines = (promised.body as { lines: { productId: string; promisedMinor: number; outcome: string; detail: string }[] }).lines;
    expect(lines.map((l) => [l.productId, l.promisedMinor, l.outcome])).toEqual([['MILK', 7, 'partially_promised'], ['BREAD', 4, 'partially_promised']]);
    expect(lines[0]?.detail).toMatch(/kept back for shoppers in the store \(online buffer 3\)/);
    expect(await view()).toEqual([
      { productId: 'BREAD', onHandMinor: 5, promisedMinor: 4, bufferMinor: 1, appMayPromiseMinor: 0 },
      { productId: 'MILK', onHandMinor: 10, promisedMinor: 7, bufferMinor: 3, appMayPromiseMinor: 0 },
    ]);
    // A second order gets nothing more: the buffer is for the shelf.
    const second = await call('POST', '/v1/orders/o-2/promise', 'u-owner', { locationId: 'S1', lines: [{ productId: 'MILK', quantityMinor: 1 }] }, 'o-2');
    expect((second.body as { outcome: string }).outcome).toBe('cannot_promise');

    // The till is not limited by the buffer (hard rule #1): a walk-in buys the 3 kept back.
    expect((await call('POST', '/v1/sales', 'u-till', {
      saleId: 'S-1', receiptNumber: 'R-1', laneId: 'lane-1', locationId: 'S1', cashierId: 'u-till', tradingDay: today, committedAt: new Date().toISOString(),
      totalMinor: 9_000, currency: 'INR', packVersion: 1, lines: [{ productId: 'MILK', quantityMinor: 3, uom: 'ea', unitPriceMinor: 3_000, lineTotalMinor: 9_000 }], tenders: [{ kind: 'cash', amountMinor: 9_000 }],
    }, 'sale-1')).status).toBe(202);
    expect((await view()).find((r) => r.productId === 'MILK')).toMatchObject({ onHandMinor: 7, promisedMinor: 7, appMayPromiseMinor: 0 });

    // A new figure supersedes (the old stays on record): buffer 0 for milk → nothing kept back for it.
    const changed = await call('POST', '/v1/inventory/online-buffer', 'u-mgr', { locationId: 'S1', productId: 'MILK', bufferMinor: 0, reason: 'evening: online first' }, 'buf-milk-0');
    expect(changed.body).toMatchObject({ buffer: { bufferMinor: 0 }, supersedes: { bufferMinor: 3 } });
  });
});
