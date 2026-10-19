import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser } from 'playwright-core';
import { startInboxShop, OWNER, MGR, type InboxShop } from './lib/ai-inbox-shop';
import { seedOnlineCatalogue, type ShopCalls, type Res } from '../support/online-shop';
import type { RealCloud } from '../support/real-store';

/**
 * **R4 Lane 2 — the "Online store" and "App content" pages, in a real browser, on the PRODUCTION API over real
 * PostgreSQL (B23 · A26 · WF-16 · D01-FR-06).**
 *
 * Through Chromium the owner: sees every shop detail "not set"; saves the details he has — the grievance officer left
 * out (OB-223) — and is refused publishing the store by name; sees each product's listing with what is missing, MILK
 * refused for the grievance officer, the concession saree refused as another seller's goods (A26), and the TCS line;
 * reads the return windows "not set". On the App content page he edits MILK's description and synonyms (a version with
 * his name), sees the completeness score name what is missing, uploads a photo that is kept and shown, and is refused
 * an SVG by name. A store manager may read the online store but not edit app content.
 *
 * Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['online', 'store', 'e2e', 'key'].join('-').padEnd(48, '0');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('synthetic-png-e2e')]);

const callsOn = (cloud: () => RealCloud): ShopCalls => {
  const req = (method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown, userId = OWNER, query?: Record<string, string>): Promise<Res> =>
    cloud().request({ method, path: query === undefined ? path : `${path}?${new URLSearchParams(query).toString()}`, userId, ...(method === 'GET' ? {} : { idempotencyKey: `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }) });
  const ok = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; if (r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body)}`); return r; };
  return { req, ok };
};

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('Online store and App content pages (B23 · A26 · WF-16 · D01-FR-06) on the production API, in a real browser', () => {
  let browser: Browser;
  let shop: InboxShop;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/online-store', html: 'online-store.html', dataGlobal: 'onlineStoreData' },
      alsoPages: [{ path: '/product-content', html: 'product-content.html', dataGlobal: 'productContentData' }],
      seed: async (cloud) => { await seedOnlineCatalogue(callsOn(() => cloud), 'br-1'); },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 240_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  it('the owner sees "not set", is refused publishing for the grievance officer, sees each listing\'s gaps and the concession refusal', async () => {
    const context = await browser.newContext();
    await shop.signIn(context, OWNER);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    try {
      await page.goto(`${shop.base}/online-store`, { waitUntil: 'load' });
      await page.locator('#details dd[data-field="grievanceOfficerName"]').waitFor({ timeout: 15_000 });
      expect(await page.textContent('#details dd[data-field="legalName"]')).toBe('not set');
      expect(await page.textContent('#tcs')).toBe('TCS (section 52): not applicable: own goods only');
      expect(await page.textContent('#policy-say')).toMatch(/^Return windows: not set\. Non-returnable list: not set\./);

      // A reason is needed; then the details he has are saved — the grievance officer left out (OB-223).
      await page.fill('#d-legalName', 'Synthetic Hyper Market Private Limited');
      await page.click('#save-details');
      expect(await page.textContent('#result')).toBe('Write the reason first.');
      await page.fill('#d-legalName', 'Synthetic Hyper Market Private Limited');
      await page.fill('#d-address', '1 Test Road, Tamil Nadu');
      await page.fill('#d-gstin', '33ABCDE1234F1Z5');
      await page.fill('#d-returnTerms', 'Returns by department, within the window shown.');
      await page.fill('#d-reason', 'e2e (synthetic)');
      await page.click('#save-details');
      await page.locator('#details dd[data-field="legalName"]', { hasText: 'Synthetic Hyper Market Private Limited' }).waitFor({ timeout: 15_000 });
      expect(await page.textContent('#details dd[data-field="grievanceOfficerName"]')).toBe('not set');
      expect(await page.getAttribute('#details dd[data-field="grievanceOfficerName"]', 'class')).toBe('unset');

      // Publishing the store is refused by name.
      await page.click('#publish-store');
      await page.locator('#result', { hasText: 'online listing incomplete: grievance officer name' }).waitFor({ timeout: 15_000 });
      expect(await page.textContent('#store-state')).toBe('The online store cannot be published yet: online listing incomplete: grievance officer name');

      // Each listing names what is missing; publishing MILK is refused for the officer; the saree is another seller's.
      const milk = page.locator('#listings .row[data-product="MILK"]');
      expect(await milk.locator('.facts').textContent()).toContain('Missing: grievance officer name, grievance officer contact');
      await milk.locator('button.publish').click();
      await page.locator('#result', { hasText: 'online listing incomplete: grievance officer name' }).waitFor({ timeout: 15_000 });
      await page.locator('#listings .row[data-product="SAREE"] button.publish').click();
      await page.locator('#result', { hasText: "other seller's goods: not sold online" }).waitFor({ timeout: 15_000 });
      expect(await page.locator('#listings .row[data-product="MILK"] .state').textContent()).toBe('Not online');

      // Tamil words.
      await page.click('#lang');
      expect(await page.textContent('#title')).toBe('ஆன்லைன் கடை');
      expect(await page.textContent('#details dd[data-field="grievanceOfficerName"]')).toBe('அமைக்கப்படவில்லை');
      expect(errors).toEqual([]);
    } finally { await context.close(); }
    const tcs = (await shop.cloud().request({ method: 'GET', path: '/v1/online-store/tcs', userId: OWNER })).body as { refusedOtherSellerListings: { productId: string }[] };
    expect(tcs.refusedOtherSellerListings.map((r) => r.productId)).toEqual(['SAREE']);
  }, 180_000);

  it('the App content page: a version with the editor\'s name, the completeness score, an image kept and shown, an SVG refused', async () => {
    const context = await browser.newContext();
    await shop.signIn(context, OWNER);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    try {
      await page.goto(`${shop.base}/product-content?product=MILK`, { waitUntil: 'load' });
      await page.locator('#score').waitFor({ timeout: 15_000 });
      expect(await page.textContent('#score')).toBe('App content complete: 0%');
      expect(await page.textContent('#missing')).toMatch(/^Missing: Tamil name, English description, Tamil description, synonyms, image/);
      await page.fill('#c-descriptionEn', 'Toned milk, one litre pouch (synthetic)');
      await page.fill('#c-synonyms', 'paal, milk packet');
      await page.fill('#c-reason', 'first copy');
      await page.click('#save');
      await page.locator('#history .row[data-version="1"]').waitFor({ timeout: 15_000 });
      expect(await page.textContent('#history .row[data-version="1"] .headline')).toContain(`by ${OWNER}`);
      expect(await page.textContent('#score')).toBe('App content complete: 40%');

      // An SVG is refused by name; a PNG is kept on the shop's server and shown.
      await page.setInputFiles('#image-file', { name: 'x.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>') });
      await page.click('#upload');
      await page.locator('#result', { hasText: 'image type not allowed' }).waitFor({ timeout: 15_000 });
      await page.setInputFiles('#image-file', { name: 'milk.png', mimeType: 'image/png', buffer: PNG });
      await page.click('#upload');
      await page.locator('#image-box img.pic').waitFor({ timeout: 15_000 });
      expect(await page.textContent('#image-say')).toBe(`Image version 1 · image/png · ${PNG.length} B`);
      expect(await page.textContent('#score')).toBe('App content complete: 60%');
      expect(errors).toEqual([]);
    } finally { await context.close(); }

    // A store manager may read the online store, but not edit the app content.
    const asManager = await shop.cloud().request({ method: 'POST', path: '/v1/catalogue/products/MILK/content', userId: MGR, idempotencyKey: `k-${randomUUID()}`, body: { descriptionEn: 'x', reason: 'x' } });
    expect(asManager.status).toBe(403);
    expect((await shop.cloud().request({ method: 'GET', path: '/v1/online-store/details', userId: MGR, branchId: 'br-1' })).status).toBe(200);
  }, 180_000);
});
