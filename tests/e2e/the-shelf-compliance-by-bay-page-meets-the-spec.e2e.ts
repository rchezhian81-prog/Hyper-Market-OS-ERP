import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser } from 'playwright-core';
import { startInboxShop, ok, OWNER, type InboxShop } from './lib/ai-inbox-shop';

/**
 * D-13 (R4, OB-219) — the Shelf compliance by bay page, in a real browser, on the PRODUCTION API over real PostgreSQL. A store
 * with a shelf map of two bays and a planogram in force; staff counted rice empty (stock in the back), soap empty (none in
 * the building) and dal full; salt was never counted. The page shows each bay's score over what was counted, every gap by
 * name, "Measured by: counted by staff" and that image recognition is switched off; a photo taken on the page is kept on
 * the shop's own server against its bay (the only write), and a GIF is refused before it is sent.
 *
 * Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */
const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['shelf', 'bays', 'e2e', 'key'].join('-').padEnd(48, '0');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const LOCS = [
  { locationId: 'L1', aisle: 1, rack: 1, bay: 1, shelf: 1, position: 1, zone: 'ambient' },
  { locationId: 'L2', aisle: 1, rack: 1, bay: 1, shelf: 1, position: 2, zone: 'ambient' },
  { locationId: 'L3', aisle: 1, rack: 1, bay: 2, shelf: 1, position: 1, zone: 'ambient' },
  { locationId: 'L4', aisle: 1, rack: 1, bay: 2, shelf: 1, position: 2, zone: 'ambient' },
];

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('the Shelf compliance by bay page (D-13) on the production API, in a real browser', () => {
  let browser: Browser;
  let shop: InboxShop;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/planogram-compliance', html: 'planogram-compliance.html', dataGlobal: 'planogramBaysData' },
      seed: async (cloud) => {
        const send = (method: 'POST' | 'PUT', path: string, body: unknown, key: string) => ok(cloud.request({ method, path, userId: OWNER, idempotencyKey: key, body }), key);
        await send('PUT', '/v1/merchandising/stores/br-1/shelf-map', { locations: LOCS }, 'map');
        await send('PUT', '/v1/merchandising/stores/br-1/planograms/PG-1', { effectiveFrom: '2026-01-01', assignments: [
          { productId: 'P-RICE', locationId: 'L1', capacityMinor: 40, primary: true }, { productId: 'P-SOAP', locationId: 'L2', capacityMinor: 60, primary: true },
          { productId: 'P-DAL', locationId: 'L3', capacityMinor: 20, primary: true }, { productId: 'P-SALT', locationId: 'L4', capacityMinor: 10, primary: true },
        ] }, 'plan');
        await send('POST', '/v1/inventory/movements', { movementId: 'rx-rice', productId: 'P-RICE', locationId: 'br-1', kind: 'received', quantityMinor: 100, uom: 'ea', occurredAt: new Date(Date.now() - 86_400_000).toISOString(), enteredBy: OWNER, unitCostMinor: 100 }, 'rx');
        for (const [id, p, l, n] of [['c1', 'P-RICE', 'L1', 0], ['c2', 'P-SOAP', 'L2', 0], ['c3', 'P-DAL', 'L3', 20]] as const) {
          await send('POST', `/v1/merchandising/shelf-counts/${id}`, { storeId: 'br-1', productId: p, locationId: l, countedMinor: n, knownLocationIds: LOCS.map((x) => x.locationId) }, id);
        }
      },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 300_000);

  afterAll(async () => {
    await browser?.close();
    await shop?.stop();
  });

  it('bays scored from staff counts with every gap named; recognition off; a photo kept here, sent nowhere', async () => {
    const context = await browser.newContext();
    const errors: string[] = [];
    const writes: string[] = [];
    try {
      await shop.signIn(context, OWNER);
      const page = await context.newPage();
      page.on('pageerror', (e) => { errors.push(String(e)); });
      page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/v1/') && r.method() !== 'GET') writes.push(`${r.method()} ${u.pathname.replace(/[^/]+$/, ':id')}`); });
      await page.goto(`${shop.base}/planogram-compliance`, { waitUntil: 'load' });
      await page.waitForFunction(() => (globalThis as unknown as { planogramBays?: unknown }).planogramBays !== undefined);
      expect(await page.isHidden('#bays-section')).toBe(true);

      await page.fill('#store', 'br-1');
      await page.click('#show');
      await page.locator('#bays-section:not([hidden])').waitFor({ timeout: 15_000 });
      expect(await page.textContent('#bays li[data-bay="A1-R1-B1"] .score')).toMatch(/^Score: 0% \(0\/2 counted, 2 facings planned\)/);
      expect(await page.textContent('#bays li[data-bay="A1-R1-B1"] .gaps')).toBe('P-RICE (L1): empty, stock in back · P-SOAP (L2): empty, none in building');
      expect(await page.textContent('#bays li[data-bay="A1-R1-B2"] .score')).toMatch(/^Score: 100% \(1\/1 counted/);
      expect(await page.textContent('#bays li[data-bay="A1-R1-B2"] .gaps')).toBe('P-SALT (L4): never counted');
      expect(await page.textContent('#measured')).toBe('Measured by: counted by staff');
      expect(await page.getAttribute('#recognition', 'data-state')).toBe('switched_off');
      expect(await page.textContent('#recognition')).toMatch(/no photo leaves the shop/);
      expect(writes).toEqual([]);

      // A GIF is refused before anything is sent.
      await page.selectOption('#photo-bay', 'A1-R1-B1');
      await page.setInputFiles('#photo-file', { name: 'shelf.gif', mimeType: 'image/gif', buffer: Buffer.from('GIF89a') });
      await page.click('#keep');
      await expect.poll(() => page.textContent('#photo-status')).toMatch(/image type not allowed/);
      expect(writes).toEqual([]);

      await page.setInputFiles('#photo-file', { name: 'shelf.png', mimeType: 'image/png', buffer: PNG });
      await page.click('#keep');
      await expect.poll(() => page.textContent('#photo-status')).toMatch(/Photo kept on the shop's own computer\. It was not sent anywhere\./);
      await expect.poll(() => page.textContent('#bays li[data-bay="A1-R1-B1"] .photos')).toBe('Photos: 1');
      expect(writes).toEqual(['POST /v1/merchandising/shelf-photos/:id']);
      const listed = (await shop.cloud().request({ method: 'GET', path: '/v1/merchandising/shelf-photos?storeId=br-1', userId: OWNER })).body as { photos: { bayKey: string; mediaType: string; bytes: number }[] };
      expect(listed.photos).toEqual([expect.objectContaining({ bayKey: 'A1-R1-B1', mediaType: 'image/png', bytes: PNG.length })]);

      await page.click('#lang');
      expect(await page.textContent('#page-h')).toBe('அலமாரி இணக்கம் — பகுதி வாரியாக');
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  }, 180_000);
});
