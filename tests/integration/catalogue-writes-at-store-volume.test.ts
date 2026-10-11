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
import { makeEvent } from '../../packages/contracts/src/event';
import { PRODUCTS_STREAM, STREAM, streamName } from '../../services/api/src/adapters';

/**
 * **GT-05 store volume — publishing a product and assigning a barcode cost the same at 15 000 products as at 1 000.**
 *
 * Found at the 15 000-product rehearsal (round 6): the product publish re-read every product to look for a SKU clash, and the
 * barcode route re-read every barcode to rebuild the register — ~360 ms a call at 15 000 products, and quadratic over a load.
 * Opt-in like the store-volume load: set `GT05_STORE_VOLUME` (e.g. 15000) and `DATABASE_URL`. A synthetic catalogue of that
 * many products, each with a barcode, is written straight into the ledger in the shape the routes write it (the way a
 * catalogue built before this change sits in the database); then, at a small size and at the full size, 20 publishes and 20
 * barcode assignments go through the REAL routes and are timed. The per-call cost must not grow with the catalogue: the
 * full-size median within 3× of the small-size median (and the clash refusals still hold at full size). Nothing here is a real
 * shop's data.
 */

const N = Number(process.env['GT05_STORE_VOLUME'] ?? '0');
const DATABASE_URL = process.env['DATABASE_URL'];
const OWNER = 'u-owner';
const SMALL = Math.max(200, Math.min(1_000, Math.floor(N / 15)));
const CALLS = 20;
const BARCODES = streamName(STREAM.catalogue, 'barcodes');

let pool: Pool | undefined;
beforeAll(async () => {
  if (N <= 0 || DATABASE_URL === undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
  const dir = 'db/migrations';
  await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
});
afterAll(async () => { await pool?.end(); });

const id6 = (i: number): string => String(i).padStart(6, '0');
const GROCERY = { categoryId: 'grocery', name: 'Grocery', parentId: null };
const product = (i: number) => ({ sku: `SKU-${id6(i)}`, name: `Synthetic item ${id6(i)}`, baseUom: 'each', primaryCategoryId: 'grocery', taxClass: '1006', lifecycle: 'draft' });

const median = (xs: readonly number[]): number => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]!; };

describe.skipIf(N <= 0 || DATABASE_URL === undefined)(`GT-05 catalogue writes at store volume (${N} products) — on real PostgreSQL`, () => {
  it('a publish and a barcode assignment cost about the same at the full catalogue as at a small one', async () => {
    const sql = pgPoolClient(pool!);
    const store = new SqlEventStore(sql);
    const h: ApiHarness = apiHarness({ store, idempotency: new SqlIdempotencyStore(sql) });
    let t = '';
    let k = 0;
    const post = (path: string, body: unknown) => h.request({ method: 'POST', path, userId: OWNER, tenantId: t, idempotencyKey: `v-${k += 1}`, body });
    let shape: Record<string, unknown> = {};
    let seeded = 1;
    /** Write products [seeded, upTo) and one barcode each straight into the ledger, in the routes' own event shape. */
    const seedTo = async (upTo: number): Promise<void> => {
      const at = new Date().toISOString();
      for (let from = seeded; from < upTo; from += 500) {
        const entries = [];
        for (let i = from; i < Math.min(upTo, from + 500); i += 1) {
          const pid = `P-${id6(i)}`;
          entries.push({ stream: PRODUCTS_STREAM, event: makeEvent({ id: `product-${pid}-seed`, type: 'ProductPublished', occurredAt: at, idempotencyKey: `product-${t}-${pid}-seed`, source: 'api/catalogue', payload: { ...shape, productId: pid, sku: `SKU-${id6(i)}`, name: `Synthetic item ${id6(i)}` } }) });
          entries.push({ stream: BARCODES, event: makeEvent({ id: `barcode-INT-${id6(i)}-seed`, type: 'BarcodeAssigned', occurredAt: at, idempotencyKey: `barcode-${t}-INT-${id6(i)}-seed`, source: 'api/catalogue', payload: { code: `INT-${id6(i)}`, productId: pid, kind: 'internal' } }) });
        }
        await store.appendBatch(t, entries);
      }
      seeded = upTo;
    };

    /** A fresh shop whose catalogue of `size` products was written before the keyed indexes existed. */
    const shopOf = async (size: number): Promise<void> => {
      t = randomUUID();
      await h.seedOwner(t, OWNER);
      // The stored shape comes from one publish in a scratch shop; this shop's category is defined by its own route, and its
      // whole catalogue is written straight into the ledger BEFORE any keyed check runs (as a catalogue built earlier sits).
      if (Object.keys(shape).length === 0) {
        const scratch = randomUUID();
        await h.seedOwner(scratch, OWNER);
        const first = await h.request({ method: 'POST', path: `/v1/catalogue/products/P-${id6(0)}/publish`, userId: OWNER, tenantId: scratch, idempotencyKey: 'scratch', body: { product: product(0), categories: [GROCERY] } });
        expect(first.status, JSON.stringify(first.body)).toBe(201);
        shape = (first.body as { product: Record<string, unknown> }).product;
      }
      expect((await post('/v1/catalogue/categories/grocery', { name: 'Grocery', parentId: null })).status).toBe(201);
      seeded = 0;
      await seedTo(size);
    };

    let next = N + 10;
    const measure = async (): Promise<{ firstPublishMs: number; firstBarcodeMs: number; publishMs: number; barcodeMs: number }> => {
      // One call of each first: anything a first call does once (it is not the per-call cost) is reported apart.
      let s0 = performance.now();
      expect((await post(`/v1/catalogue/products/P-${id6(next)}/publish`, { product: product(next), categories: [GROCERY] })).status).toBe(201);
      const firstPublishMs = Math.round(performance.now() - s0);
      s0 = performance.now();
      expect((await post(`/v1/catalogue/products/P-${id6(next)}/barcodes/NEW-${id6(next)}`, { kind: 'ean' })).status).toBe(201);
      const firstBarcodeMs = Math.round(performance.now() - s0);
      next += 1;
      const pub: number[] = [];
      const bc: number[] = [];
      for (let c = 0; c < CALLS; c += 1, next += 1) {
        let s = performance.now();
        const p = await post(`/v1/catalogue/products/P-${id6(next)}/publish`, { product: product(next), categories: [GROCERY] });
        pub.push(performance.now() - s);
        expect(p.status, JSON.stringify(p.body)).toBe(201);
        s = performance.now();
        const b = await post(`/v1/catalogue/products/P-${id6(next)}/barcodes/NEW-${id6(next)}`, { kind: 'ean' });
        bc.push(performance.now() - s);
        expect(b.status, JSON.stringify(b.body)).toBe(201);
      }
      return { firstPublishMs, firstBarcodeMs, publishMs: Math.round(median(pub) * 10) / 10, barcodeMs: Math.round(median(bc) * 10) / 10 };
    };

    await shopOf(SMALL);
    const small = await measure();
    await shopOf(N);
    const full = await measure();
    // The clash refusals still hold at full size: a seeded product's SKU, a seeded product's barcode.
    const skuClash = await post(`/v1/catalogue/products/P-X/publish`, { product: { ...product(7), name: 'Another item' }, categories: [GROCERY] });
    expect(skuClash.status).toBe(409);
    expect((skuClash.body as { error: { code: string } }).error.code).toBe('sku_already_in_use');
    const codeClash = await post(`/v1/catalogue/products/P-X/barcodes/INT-${id6(N - 1)}`, { kind: 'internal' });
    expect(codeClash.status).toBe(409);
    expect((codeClash.body as { error: { code: string; whatHappened: string } }).error).toMatchObject({ code: 'barcode_already_assigned' });
    expect((codeClash.body as { error: { whatHappened: string } }).error.whatHappened).toContain(`P-${id6(N - 1)}`);
    // The measured numbers, for the record.
    console.log(JSON.stringify({ products: N, small: { products: SMALL, ...small }, full: { products: N, ...full } }));
    expect(full.publishMs).toBeLessThan(Math.max(3 * small.publishMs, small.publishMs + 15));
    expect(full.barcodeMs).toBeLessThan(Math.max(3 * small.barcodeMs, small.barcodeMs + 15));
  }, 60 * 60 * 1000);
});
