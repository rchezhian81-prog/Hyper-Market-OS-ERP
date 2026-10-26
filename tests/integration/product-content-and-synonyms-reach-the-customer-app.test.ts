import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, TEST_IDP, TEST_PACK_KEY, type ApiHarness } from '../support/api-harness';
import { aStoreWithRules } from '../support/store-rules';
import { SqlIdempotencyStore, type HttpRequest } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { GLOBAL_FOR } from '../../edge/store-edge/src/screen-data';
import { searchCatalogue, type StorefrontProduct } from '../../packages/storefront/src/browse';
import { shopDateIn } from '../../packages/calendar/src/shop-clock';

/**
 * **D01-FR-06 · WF-01 "→ app publication" (round 8) — a product's app content and synonyms flow from the product master
 * to the customer app.** On the real API (in memory and, with DATABASE_URL, on real PostgreSQL) and a REAL store computer:
 * the owner authors a product's Tamil name, descriptions and the words customers use for it (a new version of the product,
 * the record itself untouched, a re-publish of the record keeping it); head office's store pack carries them; the box's
 * customer page hands them to the app; and the app's own search finds the product by a customer's word ("atta") and shows
 * the description in the customer's language. A cashier cannot author it; a bad list is refused. Images are NOT carried —
 * where product images live is an open owner decision (no object store; ADR-0010 / OB-45).
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
const backings: { name: string; harness: () => ApiHarness }[] = [{ name: 'the in-memory event store', harness: () => apiHarness() }];
if (DATABASE_URL !== undefined) backings.push({ name: 'real PostgreSQL', harness: () => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); } });

const savedFetch = globalThis.fetch;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { globalThis.fetch = savedFetch; for (const c of cleanups.splice(0).reverse()) await c(); });
const SETTINGS = { tradingDayCutoff: '02:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 5_000, cashVarianceToleranceMinor: 5_000, privacySlaDays: 15, warehouseId: 'S1' };

describe.each(backings)('product content and synonyms reach the customer app — on $name (D01-FR-06)', ({ harness }) => {
  it('authored on the product master → head office\'s store pack → the box\'s customer page → the app finds it by a customer\'s word', async () => {
    const h = harness();
    const T = randomUUID();
    const TODAY = shopDateIn(new Date().toISOString());
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-box', 'store_computer', ['S1']);
    await h.provisionRole(T, 'u-till', 'cashier');
    const req = (method: 'GET' | 'POST', path: string, body?: unknown, userId = 'u-owner') =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'POST' ? { idempotencyKey: `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }) });
    await aStoreWithRules(h, T, 'u-owner', 'S1', 0);
    expect((await req('POST', '/v1/stores/S1/settings', SETTINGS)).status).toBe(201);
    const GROCERY = { categoryId: 'grocery', name: 'Grocery', parentId: null };
    const RECORD = { sku: 'ATTA5', name: 'Wheat flour 5kg', brand: 'Aashirvaad', baseUom: 'each', primaryCategoryId: 'grocery', taxClass: '1101', lifecycle: 'draft' };
    expect((await req('POST', '/v1/catalogue/products/p-atta/publish', { product: RECORD, categories: [GROCERY] })).status).toBe(201);
    expect((await req('POST', '/v1/catalogue/tax-classes/1101/rates/2017-07-01', { rateBps: 500 })).status).toBeLessThan(300);
    expect((await req('POST', '/v1/prices/list/p-atta/entries/e1', { scope: 'store', scopeRef: 'S1', priceMinor: 30_000, mrpMinor: 32_000, costMinor: 25_000, marginFloorBps: 0, currency: 'INR', effectiveFrom: TODAY })).status).toBe(201);
    expect((await req('POST', '/v1/inventory/movements', { movementId: 'rx', productId: 'p-atta', locationId: 'S1', kind: 'received', quantityMinor: 12, uom: 'each', occurredAt: `${TODAY}T00:00:00.000Z`, enteredBy: 'u-owner', unitCostMinor: 25_000 })).status).toBe(202);

    // ── THE CONTENT: authored by someone who may publish; refused by name when it is not readable ───────────────────────
    const CONTENT = { nameTa: 'கோதுமை மாவு 5 கிலோ', descriptionEn: 'Whole wheat chakki atta for soft rotis.', descriptionTa: 'மென்மையான சப்பாத்திக்கான முழு கோதுமை மாவு.', synonyms: ['Atta', 'gehun', 'chapati flour'], reason: 'app launch content' };
    expect((await req('POST', '/v1/catalogue/products/p-atta/content', CONTENT, 'u-till')).status).toBe(403);
    expect((await req('POST', '/v1/catalogue/products/p-atta/content', { ...CONTENT, synonyms: Array.from({ length: 21 }, (_, i) => `w${i}`) })).body).toMatchObject({ error: { code: 'not_readable_as_app_content' } });
    expect((await req('POST', '/v1/catalogue/products/p-atta/content', { ...CONTENT, reason: '' })).status).toBe(400);
    expect((await req('POST', '/v1/catalogue/products/p-nope/content', CONTENT)).status).toBe(404);
    const authored = await req('POST', '/v1/catalogue/products/p-atta/content', CONTENT);
    expect(authored.status).toBe(201);
    expect((authored.body as { product: Record<string, unknown> }).product).toMatchObject({ sku: 'ATTA5', name: 'Wheat flour 5kg', appContent: { nameTa: CONTENT.nameTa, synonyms: ['atta', 'gehun', 'chapati flour'], setBy: 'u-owner' } });
    // A later publish of the record keeps the content (it is authored on its own route).
    expect((await req('POST', '/v1/catalogue/products/p-atta/publish', { product: { ...RECORD, name: 'Wheat flour (atta) 5kg' }, categories: [GROCERY] })).status).toBe(201);
    expect(((await req('GET', '/v1/catalogue/products/p-atta')).body as { product: { name: string; appContent?: { synonyms?: string[] } } }).product).toMatchObject({ name: 'Wheat flour (atta) 5kg', appContent: { synonyms: ['atta', 'gehun', 'chapati flour'] } });
    expect((await req('POST', '/v1/catalogue/pack', { storeId: 'S1', asOf: TODAY })).status).toBe(201);

    // ── THE STORE COMPUTER takes head office's setup and serves the customer page ───────────────────────────────────────
    globalThis.fetch = (async (url: string, init: RequestInit): Promise<Response> => {
      if (String(url).startsWith('http://127.0.0.1:')) return savedFetch(url, init);
      const hdr = (init.headers ?? {}) as Record<string, string>;
      const res = await h.raw({
        method: (init.method ?? 'GET') as HttpRequest['method'], path: new URL(url).pathname + new URL(url).search,
        token: hdr['authorization']?.replace(/^Bearer /, ''), idempotencyKey: hdr['idempotency-key'],
        body: init.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown,
      });
      return new Response(JSON.stringify(res.body), { status: res.status });
    }) as unknown as typeof globalThis.fetch;
    const dir = await mkdtemp(join(tmpdir(), 'sre-app-content-'));
    cleanups.push(async () => { await rm(dir, { recursive: true, force: true }); });
    const edge: EdgeProcess = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: T, PACK_SIGNING_KEY: TEST_PACK_KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0',
      CLOUD_API_URL: 'https://cloud.example.test', CLOUD_API_TOKEN: TEST_IDP.issue({ sub: 'u-box', tenantId: T, branchId: 'S1' }),
      EDGE_STORE_PACK_SOURCE: 'head-office', EDGE_STORE_ID: 'S1', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps',
    }, () => {}))!;
    cleanups.push(async () => { await edge.stop(); });
    expect((await edge.refreshStorePack!()).status).toBe('updated');
    const html = await (await savedFetch(`http://127.0.0.1:${edge.screens!.port}/customer`)).text();
    const m = new RegExp(`<script>window\\.${GLOBAL_FOR['customer']} = ([\\s\\S]*?);</script>`).exec(html);
    expect(m, html.slice(0, 300)).not.toBeNull();
    const shopData = JSON.parse(m![1]!) as { products: StorefrontProduct[] };
    const atta = shopData.products.find((p) => p.productId === 'p-atta')!;
    expect(atta).toMatchObject({ name: 'Wheat flour (atta) 5kg', nameTa: CONTENT.nameTa, brand: 'Aashirvaad', descriptionEn: CONTENT.descriptionEn, descriptionTa: CONTENT.descriptionTa, synonyms: ['atta', 'gehun', 'chapati flour'] });
    expect(JSON.stringify(atta)).not.toMatch(/image/i);

    // ── THE APP'S OWN SEARCH, over what the box handed it: a customer's word finds it; a typo of it too ────────────────
    expect(searchCatalogue({ query: 'gehun', products: shopData.products }).map((x) => x.product.productId)).toEqual(['p-atta']);
    expect(searchCatalogue({ query: 'chapati', products: shopData.products }).map((x) => x.product.productId)).toEqual(['p-atta']);
    expect(searchCatalogue({ query: 'gehuun', products: shopData.products })[0]).toMatchObject({ match: 'fuzzy', product: { productId: 'p-atta' } });
    const inTamil = searchCatalogue({ query: 'atta', products: shopData.products, language: 'ta' })[0]!;
    expect(inTamil.product).toMatchObject({ name: CONTENT.nameTa, description: CONTENT.descriptionTa });
    expect(searchCatalogue({ query: 'atta', products: shopData.products })[0]!.product.description).toBe(CONTENT.descriptionEn);

    // Clearing a field is a new version too; the app stops searching by a removed word on the next setup.
    expect((await req('POST', '/v1/catalogue/products/p-atta/content', { synonyms: null, reason: 'synonyms under review' })).status).toBe(201);
    expect((await req('POST', '/v1/catalogue/pack', { storeId: 'S1', asOf: TODAY })).status).toBe(201);
    expect((await edge.refreshStorePack!()).status).toBe('updated');
    const html2 = await (await savedFetch(`http://127.0.0.1:${edge.screens!.port}/customer`)).text();
    const again = JSON.parse(new RegExp(`<script>window\\.${GLOBAL_FOR['customer']} = ([\\s\\S]*?);</script>`).exec(html2)![1]!) as { products: StorefrontProduct[] };
    expect(searchCatalogue({ query: 'gehun', products: again.products })).toEqual([]);
    expect(again.products.find((p) => p.productId === 'p-atta')?.descriptionEn).toBe(CONTENT.descriptionEn);
  }, 60_000);
});
