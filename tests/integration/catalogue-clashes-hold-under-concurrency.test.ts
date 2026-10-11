import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { MemoryIdempotencyStore, SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { InMemoryEventStore, SqlEventStore, type EventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { makeEvent } from '../../packages/contracts/src/event';
import { PRODUCTS_STREAM, STREAM, streamName } from '../../services/api/src/adapters';

/**
 * **GT-05 store volume — the keyed SKU and barcode checks refuse every clash the whole-catalogue scans refused, including
 * under two simultaneous writers, for a catalogue written before the keyed indexes existed, and across a restart.**
 *
 * The product publish and the barcode route now read only the SKU / code they need (a keyed index written in the same atomic
 * batch as the record, and a write guard per SKU / per code). Proved on the in-memory store and, with DATABASE_URL, on REAL
 * PostgreSQL:
 *   1. two writers giving ONE barcode to two products at the same instant — exactly one lands, the other is refused by name
 *      (`barcode_already_assigned`, the winner named); the register holds one owner; five codes, five races;
 *   2. the same for a SKU published for two products at once (`sku_already_in_use`);
 *   3. a catalogue written before the indexes (events straight in the ledger): its codes and SKUs are refused to another
 *      product; a product that moved to a new SKU frees its old one; the same product re-publishing / re-assigning its own is
 *      not a clash;
 *   4. a restart (a new process over the same store) refuses the same.
 */

let pool: Pool | undefined;
const DATABASE_URL = process.env['DATABASE_URL'];
beforeAll(async () => {
  if (DATABASE_URL === undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL, max: 8, options: '-c app.tenant_id=*' });
  const dir = 'db/migrations';
  await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
});
afterAll(async () => { await pool?.end(); });
interface Backing { readonly store: EventStore; readonly idempotency: MemoryIdempotencyStore | SqlIdempotencyStore }
const backings: { name: string; backing: () => Backing }[] = [
  { name: 'the in-memory event store', backing: () => ({ store: new InMemoryEventStore(), idempotency: new MemoryIdempotencyStore() }) },
];
if (DATABASE_URL !== undefined) backings.push({ name: 'real PostgreSQL', backing: () => { const sql = pgPoolClient(pool!); return { store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }; } });

const OWNER = 'u-owner';
const GROCERY = { categoryId: 'grocery', name: 'Grocery', parentId: null };
const item = (sku: string, name = `Item ${sku}`) => ({ sku, name, baseUom: 'each', primaryCategoryId: 'grocery', taxClass: '1006', lifecycle: 'draft' });
type Reply = { status: number; body: unknown };
const codeOf = (r: Reply): string | undefined => (r.body as { error?: { code?: string } }).error?.code;

const caller = (h: ApiHarness, t: string) => {
  const post = (path: string, body: unknown): Promise<Reply> => h.request({ method: 'POST', path, userId: OWNER, tenantId: t, idempotencyKey: randomUUID(), body });
  return {
    publish: (productId: string, product: unknown) => post(`/v1/catalogue/products/${productId}/publish`, { product, categories: [GROCERY] }),
    assign: (productId: string, code: string) => post(`/v1/catalogue/products/${productId}/barcodes/${code}`, { kind: 'ean' }),
    lookup: async (code: string) => (await h.request({ method: 'GET', path: `/v1/catalogue/barcodes/${code}`, userId: OWNER, tenantId: t })).body as { barcode?: { productId: string } },
    products: async () => ((await h.request({ method: 'GET', path: '/v1/catalogue/products', userId: OWNER, tenantId: t })).body as { products: { productId: string; sku: string }[] }).products,
  };
};

describe.each(backings)('GT-05 the keyed SKU / barcode checks hold — on $name', ({ backing }) => {
  it('two simultaneous writers: one barcode, one SKU, two products — exactly one lands each time, the other refused by name', async () => {
    const t = randomUUID();
    const h = apiHarness(backing());
    await h.seedOwner(t, OWNER);
    const c = caller(h, t);
    for (let i = 0; i < 5; i += 1) {
      expect((await c.publish(`A-${i}`, item(`SKU-A-${i}`))).status).toBe(201);
      expect((await c.publish(`B-${i}`, item(`SKU-B-${i}`))).status).toBe(201);
    }
    for (let i = 0; i < 5; i += 1) {
      const code = `890000000${i}`;
      const [a, b] = await Promise.all([c.assign(`A-${i}`, code), c.assign(`B-${i}`, code)]);
      expect([a.status, b.status].sort()).toEqual([201, 409]);
      const loser = a.status === 409 ? a : b;
      const winner = a.status === 201 ? `A-${i}` : `B-${i}`;
      expect(codeOf(loser)).toBe('barcode_already_assigned');
      expect((loser.body as { error: { whatHappened: string } }).error.whatHappened).toContain(winner);
      expect((await c.lookup(code)).barcode?.productId).toBe(winner);
    }
    const assigned = await h.store.readStream(t, streamName(STREAM.catalogue, 'barcodes'), { type: 'BarcodeAssigned' });
    expect(assigned).toHaveLength(5); // one owner per code — the losers wrote nothing
    for (let i = 0; i < 5; i += 1) {
      const [a, b] = await Promise.all([c.publish(`X-${i}`, item(`SKU-SAME-${i}`)), c.publish(`Y-${i}`, item(`SKU-SAME-${i}`))]);
      expect([a.status, b.status].sort()).toEqual([201, 409]);
      expect(codeOf(a.status === 409 ? a : b)).toBe('sku_already_in_use');
      expect((await c.products()).filter((p) => p.sku === `SKU-SAME-${i}`)).toHaveLength(1);
    }
  }, 120_000);

  it('a catalogue written before the indexes: its codes and SKUs are refused to another product; a moved SKU is freed; a restart refuses the same', async () => {
    const t = randomUUID();
    const b = backing();
    const h = apiHarness(b);
    await h.seedOwner(t, OWNER);
    const c = caller(h, t);
    // The stored shape from a scratch shop; this shop's category by its own route; then the old catalogue straight in.
    const scratch = randomUUID();
    await h.seedOwner(scratch, OWNER);
    const shape = ((await caller(h, scratch).publish('P-shape', item('SKU-SHAPE'))).body as { product: Record<string, unknown> }).product;
    expect((await h.request({ method: 'POST', path: '/v1/catalogue/categories/grocery', userId: OWNER, tenantId: t, idempotencyKey: 'cat', body: { name: 'Grocery', parentId: null } })).status).toBe(201);
    const at = new Date().toISOString();
    const old = (i: number, sku: string, key: string) => ({ stream: PRODUCTS_STREAM, event: makeEvent({ id: `product-OLD-${i}-${key}`, type: 'ProductPublished', occurredAt: at, idempotencyKey: `product-${t}-OLD-${i}-${key}`, source: 'api/catalogue', payload: { ...shape, productId: `OLD-${i}`, sku } }) });
    const oldCode = (i: number) => ({ stream: streamName(STREAM.catalogue, 'barcodes'), event: makeEvent({ id: `barcode-OLDC-${i}`, type: 'BarcodeAssigned', occurredAt: at, idempotencyKey: `barcode-${t}-OLDC-${i}-seed`, source: 'api/catalogue', payload: { code: `OLDC-${i}`, productId: `OLD-${i}`, kind: 'internal' } }) });
    await b.store.appendBatch(t, [old(1, 'SKU-OLD-1', 's'), old(2, 'SKU-OLD-2', 's'), old(2, 'SKU-OLD-2B', 'moved'), oldCode(1), oldCode(2)]);

    expect(codeOf(await c.publish('NEW-1', item('SKU-OLD-1')))).toBe('sku_already_in_use');
    expect(codeOf(await c.assign('NEW-1', 'OLDC-2'))).toBe('barcode_already_assigned');
    // OLD-2 moved from SKU-OLD-2 to SKU-OLD-2B before the indexes: SKU-OLD-2 is free, SKU-OLD-2B is not.
    expect((await c.publish('NEW-2', item('SKU-OLD-2'))).status).toBe(201);
    expect(codeOf(await c.publish('NEW-3', item('SKU-OLD-2B')))).toBe('sku_already_in_use');
    // The same product re-publishing its own SKU, re-assigning its own code: not a clash.
    expect((await c.publish('OLD-1', item('SKU-OLD-1', 'Renamed item'))).status).toBe(201);
    expect((await c.assign('OLD-1', 'OLDC-1')).status).toBe(201);
    // A product that moves to a new SKU through the route frees its old one.
    expect((await c.publish('OLD-1', item('SKU-OLD-1-NEW'))).status).toBe(201);
    expect((await c.publish('NEW-4', item('SKU-OLD-1'))).status).toBe(201);
    expect(codeOf(await c.publish('NEW-5', item('SKU-OLD-1-NEW')))).toBe('sku_already_in_use');

    // A new process over the same store refuses the same.
    const c2 = caller(apiHarness(b), t);
    expect(codeOf(await c2.publish('NEW-6', item('SKU-OLD-1')))).toBe('sku_already_in_use');   // NEW-4 holds it now
    expect(codeOf(await c2.publish('NEW-6', item('SKU-OLD-2B')))).toBe('sku_already_in_use');
    expect(codeOf(await c2.assign('NEW-6', 'OLDC-1'))).toBe('barcode_already_assigned');
    expect((await c2.assign('NEW-6', 'FRESH-1')).status).toBe(201);
    // The index was built once (one marker per index), and nothing was overwritten: every old record is still there.
    expect(await b.store.readStream(t, streamName(STREAM.catalogue, 'indexes'), { type: 'CatalogueIndexBuilt' })).toHaveLength(2);
    expect((await b.store.readStream(t, PRODUCTS_STREAM, { type: 'ProductPublished' })).length).toBe(3 + 4);
  }, 120_000);
});
