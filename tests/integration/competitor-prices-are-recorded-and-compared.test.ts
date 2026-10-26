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
import { shopDateIn } from '../../packages/calendar/src/shop-clock';

/**
 * **D06-FR-05 (round 8) — competitor price capture.** A sighting of a competitor's price is recorded against the shop's
 * own product and store, append-only (a re-send is the same record; a different record under a used id is refused); the
 * comparison puts the shop's OWN effective price at that store now beside each competitor's latest sighting, with the gap
 * and its age — and the shop's price list is untouched (a change goes through the governed price route). A product the
 * shop does not have, a sighting dated in the future, and a person without pricing authority are refused. In memory and,
 * with DATABASE_URL, on real PostgreSQL.
 */

const OWNER = 'u-owner'; const MGR = 'u-mgr'; const CASH = 'u-cash';
const DATABASE_URL = process.env['DATABASE_URL'];
let pool: Pool | undefined;
beforeAll(async () => {
  if (DATABASE_URL === undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
  await runMigrations(pgPoolClient(pool), readdirSync('db/migrations').filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join('db/migrations', name), 'utf8') })));
});
afterAll(async () => { await pool?.end(); });
const backings: { name: string; harness: () => ApiHarness }[] = [{ name: 'the in-memory event store', harness: () => apiHarness() }];
if (DATABASE_URL !== undefined) backings.push({ name: 'real PostgreSQL', harness: () => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); } });

describe.each(backings)('competitor prices are recorded and compared, and change no price — on $name', ({ harness }) => {
  it('records sightings append-only and compares them with the shop\'s own price at the store', async () => {
    const h = harness();
    const T = randomUUID();
    const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, key?: string, query?: Record<string, string>) =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'GET' ? {} : { idempotencyKey: key ?? `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });
    const code = (r: { body: unknown }): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
    await h.seedOwner(T, OWNER);
    await h.provisionRole(T, MGR, 'store_manager');
    await h.provisionRole(T, CASH, 'cashier');
    const today = shopDateIn(new Date().toISOString());
    for (const [path, body] of [
      ['/v1/catalogue/tax-classes/0401/rates/2017-07-01', { rateBps: 0 }],
      ['/v1/catalogue/products/MILK/publish', { product: { sku: 'MILK-1L', name: 'Aavin Milk 1L', baseUom: 'each', primaryCategoryId: 'dairy', taxClass: '0401', lifecycle: 'active' }, categories: [{ categoryId: 'dairy', name: 'Dairy', parentId: null }] }],
      ['/v1/prices/list/MILK/entries/e1', { scope: 'store', scopeRef: 'S1', priceMinor: 60_00, mrpMinor: 70_00, costMinor: 40_00, marginFloorBps: 0, currency: 'INR', effectiveFrom: today }],
    ] as const) expect((await call('POST', path, OWNER, body)).status, path).toBeLessThan(300);

    const seen = (id: string, over: Record<string, unknown> = {}) => call('POST', `/v1/prices/competitor/${id}`, MGR, {
      productId: 'MILK', storeId: 'S1', competitor: 'Corner Mart', priceMinor: 58_00, observedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(), source: 'shelf_visit', ...over,
    }, `obs-${id}-${JSON.stringify(over)}`);
    const first = await seen('o1');
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ changesNoPrice: true, observation: { recordedBy: MGR } });
    // The same sighting again is the same record; different details under a used id are refused — never edited.
    const firstBody = (first.body as { observation: { observedAt: string } }).observation;
    expect((await call('POST', '/v1/prices/competitor/o1', MGR, { productId: 'MILK', storeId: 'S1', competitor: 'Corner Mart', priceMinor: 58_00, observedAt: firstBody.observedAt, source: 'shelf_visit' })).body).toMatchObject({ alreadyRecorded: true });
    expect(code(await seen('o1', { priceMinor: 1 }))).toBe('observation_id_used');
    // A newer sighting at the same competitor, and another competitor.
    expect((await seen('o2', { priceMinor: 57_00, observedAt: new Date(Date.now() - 86_400_000).toISOString() })).status).toBe(201);
    expect((await seen('o3', { competitor: 'Big Bazaar', priceMinor: 62_00, source: 'flyer', note: 'pack of 2 offer' })).status).toBe(201);
    // Refusals.
    expect(code(await seen('o4', { productId: 'NOT-OURS' }))).toBe('unknown_product');
    expect(code(await seen('o5', { observedAt: new Date(Date.now() + 86_400_000).toISOString() }))).toBe('observed_in_the_future');
    expect(code(await seen('o6', { priceMinor: 0 }))).toBe('not_readable_as_a_competitor_price');
    expect((await call('POST', '/v1/prices/competitor/o7', CASH, { productId: 'MILK', storeId: 'S1', competitor: 'X', priceMinor: 1, observedAt: new Date().toISOString(), source: 'phone' })).status).toBe(403);

    const cmp = (await call('GET', '/v1/prices/competitor', MGR, undefined, undefined, { storeId: 'S1' })).body as { products: { productId: string; ourPriceMinor: number | null; competitors: { competitor: string; priceMinor: number; gapMinor?: number; gapBps?: number; ageDays: number; observationId: string }[] }[] };
    expect(cmp.products).toHaveLength(1);
    expect(cmp.products[0]!.ourPriceMinor).toBe(60_00);
    expect(cmp.products[0]!.competitors.map((c) => [c.competitor, c.priceMinor, c.gapMinor, c.observationId, c.ageDays])).toEqual([
      ['Corner Mart', 57_00, 3_00, 'o2', 1],          // the LATEST sighting at Corner Mart, cheaper than us by ₹3
      ['Big Bazaar', 62_00, -2_00, 'o3', 3],
    ]);
    expect(cmp.products[0]!.competitors[0]!.gapBps).toBe(Math.round((3_00 * 10_000) / 57_00));
    // At a store where the shop has no price today, the gap is not known — never compared with a zero.
    expect((await seen('o8', { storeId: 'S2' })).status).toBe(201);
    const s2 = (await call('GET', '/v1/prices/competitor', MGR, undefined, undefined, { storeId: 'S2' })).body as { products: { ourPriceMinor: number | null; ourPriceNotKnown?: string; competitors: { gapMinor?: number }[] }[] };
    expect(s2.products[0]).toMatchObject({ ourPriceMinor: null, ourPriceNotKnown: expect.stringMatching(/no effective price/) });
    expect(s2.products[0]!.competitors[0]!.gapMinor).toBeUndefined();
    // The shop's own price list is untouched by any of it.
    const history = (await call('GET', '/v1/prices/list/MILK/history', MGR)).body as { entries: unknown[] };
    expect(history.entries).toHaveLength(1);
  });
});
