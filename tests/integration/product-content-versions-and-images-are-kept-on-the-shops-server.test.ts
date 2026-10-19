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
import { seedOnlineShop, callsFor, codeOf, saidOf, CASHIER, CUSTOMER, OWNER } from '../support/online-shop';

/**
 * **R4 · D01-FR-06 — the product content editor's versions and completeness, and product images on the shop's own server
 * (OB-215 · OB-60) — on the real API, in memory and on REAL PostgreSQL, across a cold restart.**
 *
 * A person with catalogue permission edits a product's app description and synonyms; each change is a new version with
 * its history visible; the completeness score names what is missing. An image is checked for type and size ("image type
 * not allowed", "image too large"), kept on the shop's own server (head office's own database — nothing bought), shown in
 * the app, and replaced as a new version. A product with no image works the same. (The content reaching the app on the
 * next publish is proven by `product-content-and-synonyms-reach-the-customer-app.test.ts`.)
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

/** A tiny synthetic PNG / JPEG — just the bytes that say what they are, and a little body. */
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('synthetic-png-body-1')]);
const PNG2 = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('synthetic-png-body-2')]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('synthetic-jpeg-body')]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

type Editor = { content: Record<string, unknown>; history: { version: number; content: Record<string, unknown>; by?: string }[]; image: { version: number; mediaType: string } | null; imageHistory: { version: number }[]; completeness: { app: { scorePercent: number; missing: string[] }; record: { scorePercent?: number } } };

describe.each(backings)('D01-FR-06 — content versions and images on the shop\'s server, on $name', ({ harness, restart }) => {
  it('edits are versions with history; images are checked, kept, shown and replaced; no image works the same', async () => {
    let h = harness();
    const T = randomUUID();
    const c = callsFor(() => h, T);
    const { req, ok } = c;
    await seedOnlineShop(h, T, c);
    const editor = async () => (await ok(req('GET', '/v1/catalogue/products/MILK/app-content', undefined, OWNER), 'editor')).body as Editor;

    const blank = await editor();
    expect(blank.history).toEqual([]);
    expect(blank.image).toBeNull();
    expect(blank.completeness.app).toEqual({ scorePercent: 0, missing: ['Tamil name', 'English description', 'Tamil description', 'synonyms', 'image'] });

    // Two edits — two versions, newest first, each naming who made it.
    await ok(req('POST', '/v1/catalogue/products/MILK/content', { descriptionEn: 'Toned milk, 1 litre (synthetic)', synonyms: ['paal', 'milk packet'], reason: 'first copy' }, OWNER), 'content 1');
    await ok(req('POST', '/v1/catalogue/products/MILK/content', { descriptionEn: 'Toned milk, one litre pouch (synthetic)', reason: 'clearer' }, OWNER), 'content 2');
    const edited = await editor();
    expect(edited.history.map((v) => [v.version, v.content['descriptionEn'], v.by])).toEqual([
      [2, 'Toned milk, one litre pouch (synthetic)', OWNER], [1, 'Toned milk, 1 litre (synthetic)', OWNER],
    ]);
    expect(edited.completeness.app).toEqual({ scorePercent: 40, missing: ['Tamil name', 'Tamil description', 'image'] });

    // Images: catalogue permission only; type from the file's own bytes; size limit.
    const send = (mediaType: string, bytes: Buffer, who = OWNER) => req('POST', '/v1/catalogue/products/MILK/images', { mediaType, contentBase64: bytes.toString('base64') }, who);
    expect((await send('image/png', PNG, CASHIER)).status).toBe(403);
    const svg = await send('image/svg+xml', SVG);
    expect([svg.status, codeOf(svg)]).toEqual([415, 'image_type_not_allowed']);
    expect(saidOf(svg)).toMatch(/^image type not allowed/);
    expect(codeOf(await send('image/png', JPEG))).toBe('image_type_not_allowed'); // says PNG, is a JPEG
    const big = await send('image/jpeg', Buffer.concat([JPEG, Buffer.alloc(800_000, 1)]));
    expect([big.status, codeOf(big)]).toEqual([413, 'image_too_large']);
    expect(saidOf(big)).toMatch(/^image too large/);
    expect((await send('image/png', PNG)).status).toBe(201);

    // ── A cold restart: the image is still on the shop's server ──
    h = restart(h);
    const shown = (await ok(req('GET', '/v1/storefront/products/MILK/image', undefined, CUSTOMER), 'app image')).body as { version: number; mediaType: string; contentBase64: string };
    expect(shown).toMatchObject({ version: 1, mediaType: 'image/png', contentBase64: PNG.toString('base64') });
    // Replaced as a NEW version; the first is kept in the history.
    expect((await send('image/png', PNG2)).status).toBe(201);
    expect(((await send('image/png', PNG2)).body as { unchanged?: boolean }).unchanged).toBe(true);
    const after = await editor();
    expect(after.image).toMatchObject({ version: 2, mediaType: 'image/png' });
    expect(after.imageHistory.map((v) => v.version)).toEqual([2, 1]);
    expect(after.completeness.app.missing).toEqual(['Tamil name', 'Tamil description']);
    expect(((await ok(req('GET', '/v1/storefront/products/MILK/image', undefined, CUSTOMER), 'app image 2')).body as { contentBase64: string }).contentBase64).toBe(PNG2.toString('base64'));

    // A product with no image: said, and the app's listing simply carries none.
    const none = await req('GET', '/v1/storefront/products/BROOM/image', undefined, CUSTOMER);
    expect([none.status, codeOf(none)]).toEqual([404, 'no_image']);
    const listing = (await ok(req('GET', '/v1/storefront/listing', undefined, CUSTOMER), 'listing')).body as { products: { productId: string; image?: unknown }[] };
    expect(listing.products.find((p) => p.productId === 'MILK')!.image).toEqual({ version: 2, mediaType: 'image/png' });
    expect(listing.products.find((p) => p.productId === 'BROOM')!.image).toBeUndefined();
  }, 120_000);
});
