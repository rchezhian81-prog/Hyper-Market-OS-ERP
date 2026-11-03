import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { CONNECTED, OWNER, ok, operatorGrant, startBoxPageOnCloud, type BoxCloudShop } from './lib/box-page-on-cloud';
import { setUpPracticeStores } from '../support/real-store';
import { shopDateIn } from '../../packages/calendar/src/shop-clock';

/**
 * **W4 · M36-FR-02 (OB-321 · P-06 · P-08 · hard rule #1): the shop's own name, logo and colours — ONE connected run: the
 * Shop name page in a real browser, served by a REAL store computer, over the PRODUCTION API on real PostgreSQL.**
 * (`w3-the-shops-brand-is-set-and-rides-the-signed-pack.e2e.ts` proves the same page over the in-memory route set.)
 *   • head office (the real cloud) keeps the brand "Synthetic Fresh Mart" and publishes the signed pack; the store computer
 *     holds THAT pack, verified with the cloud's own signing key — so the office menu shows the shop's name, the till page
 *     is handed the brand inside its signed catalogue, and the page says the tills print what head office says;
 *   • the IT administrator changes the name on the page: an unreadable colour pair is refused by head office in its own
 *     words (nothing saved on PostgreSQL), a readable one is saved there; the page then says it is not yet on the tills —
 *     it reaches them with the next pack (visible, P-08);
 *   • a cashier is not given the page (her words are head office's own), and head office refuses her write.
 * Synthetic data only. Needs DATABASE_URL and Chromium; else it SKIPS.
 */

const IT = 'u-it'; const CASH = 'u-cash'; const STORE = 'br-1';
type Doc = { document: { querySelector(s: string): { textContent: string | null } | null } };
const says = async (page: Page, selector: string, re: RegExp): Promise<void> => {
  try {
    await page.waitForFunction(([sel, src]) => new RegExp(src!).test((globalThis as unknown as Doc).document.querySelector(sel!)?.textContent ?? ''), [selector, re.source] as const, { timeout: 15_000 });
  } catch {
    throw new Error(`${selector} says ${JSON.stringify(await page.textContent(selector).catch(() => null))}, not ${String(re)}`);
  }
};
const BRAND = { productName: 'Synthetic Fresh Mart', legalName: 'Synthetic Fresh Mart Pvt Ltd', colours: { primary: '#1a4d2e', onPrimary: '#ffffff' } };

describe.skipIf(!CONNECTED)('M36-FR-02 connected: the shop\'s brand on the store computer, over the real cloud on PostgreSQL', () => {
  let shop: BoxCloudShop;
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'pos'], { stdio: 'ignore' });
    shop = await startBoxPageOnCloud({
      name: 'm36-brand', store: STORE,
      people: [{ userId: IT }, { userId: CASH, branchId: STORE }],
      seed: async (cloud) => {
        const as = (method: 'POST' | 'PUT', path: string, body: unknown, key: string) => cloud.request({ method, path, userId: OWNER, idempotencyKey: key, body });
        await setUpPracticeStores(cloud, OWNER, [STORE]);
        // The IT role, laid on the ledger by the operator (the owner may not hand out platform_admin's own permissions).
        await operatorGrant(cloud, IT, 'platform_admin');
        await cloud.grant(CASH, 'cashier', undefined, [STORE]);
        await ok(as('POST', '/v1/catalogue/tax-classes/1006/rates/2017-07-01', { rateBps: 500 }, 'tax'), 'tax');
        await ok(as('POST', '/v1/catalogue/products/p-rice/publish', { product: { sku: 'RICE-1', name: 'Ponni rice 1 kg', baseUom: 'ea', primaryCategoryId: 'grocery', taxClass: '1006', lifecycle: 'active' }, categories: [{ categoryId: 'grocery', name: 'Grocery', parentId: null }] }, 'pub'), 'publish');
        await ok(as('POST', '/v1/prices/list/p-rice/entries/e1', { scope: 'store', scopeRef: STORE, priceMinor: 6_200, mrpMinor: 7_000, costMinor: 4_800, marginFloorBps: 0, currency: 'INR', effectiveFrom: shopDateIn(new Date().toISOString()) }, 'price'), 'price');
        await ok(as('PUT', '/v1/platform/branding', BRAND, 'brand'), 'brand');
        await ok(as('POST', '/v1/catalogue/pack', { storeId: STORE, asOf: shopDateIn(new Date().toISOString()) }, 'pack'), 'pack');
      },
      // The store computer holds the pack the REAL cloud signed — where it keeps the pack it last accepted.
      beforeBoxStarts: async (cloud, dir) => {
        const pack = (await cloud.request({ method: 'GET', path: '/v1/catalogue/pack', userId: OWNER })).body as { snapshot: { branding?: unknown } };
        expect(pack.snapshot.branding).toEqual(BRAND);
        await writeFile(join(dir, 'signed-pack.json'), JSON.stringify(pack), 'utf8');
      },
    });
  }, 300_000);
  afterAll(async () => { await shop?.stop(); });

  it('the menu and the till read the brand from the signed pack; a change on the page is kept on PostgreSQL and said to wait for the next pack', async () => {
    const p = await shop.open(IT, '/branding');
    expect(p.status).toBe(200);
    await says(p.page, '#v-ho', /^Synthetic Fresh Mart$/);
    await says(p.page, '#v-box', /^Synthetic Fresh Mart$/);
    await says(p.page, '#v-box-more', /From catalogue pack v\d+, which this store computer holds\. The tills print what head office says\./);
    await says(p.page, '.sre-menu .brand[data-shop-brand] b', /^Synthetic Fresh Mart$/);
    // An unreadable pair is refused by head office, in its words; nothing saved.
    await p.page.fill('#b-name', 'Synthetic Fresh Market');
    await p.page.$eval('#b-primary', (e) => { (e as unknown as { value: string }).value = '#ffffff'; });
    await p.page.$eval('#b-on', (e) => { (e as unknown as { value: string }).value = '#fefefe'; });
    await p.page.click('#save');
    await says(p.page, '#edit-status', /^Head office refused: .*block this branding: colours/);
    expect(((await shop.call('GET', '/v1/platform/branding', IT)).body as { productName: string }).productName).toBe('Synthetic Fresh Mart');
    await p.page.$eval('#b-primary', (e) => { (e as unknown as { value: string }).value = '#14532d'; });
    await p.page.click('#save');
    await says(p.page, '#edit-status', /^Saved\. It reaches the tills with the next catalogue pack\.$/);
    await says(p.page, '#v-ho', /^Synthetic Fresh Market$/);
    await says(p.page, '#v-box', /^Synthetic Fresh Mart$/);
    await says(p.page, '#v-box-more', /not yet on the tills/);
    // Head office (PostgreSQL) holds the new name and the readable pair.
    expect((await shop.call('GET', '/v1/platform/branding', IT)).body).toMatchObject({ productName: 'Synthetic Fresh Market', colours: { primary: '#14532d' } });
    expect(p.writes).toEqual(['PUT /v1/platform/branding', 'PUT /v1/platform/branding']);
    await p.page.click('#lang');
    await says(p.page, '#page-h', /^கடைப் பெயரும் வண்ணங்களும்$/);
    expect(p.errors).toEqual([]);
    await p.close();

    // The till page is handed the brand INSIDE its signed catalogue — nothing to fetch at the sale.
    const till = await shop.open(IT, '/pos/');
    const handed = await till.page.evaluate(() => {
      const w = globalThis as unknown as { posCatalogue?: { branding?: { productName?: string } }; sreBrand?: { productName?: string } };
      return { catalogue: w.posCatalogue?.branding?.productName, brand: w.sreBrand?.productName };
    });
    expect(handed).toEqual({ catalogue: 'Synthetic Fresh Mart', brand: 'Synthetic Fresh Mart' });
    await till.close();
  }, 120_000);

  it('a cashier is not given the page by the store computer, and head office refuses her write in its words', async () => {
    // Her words in the box's pack are head office's own answer for her: no branding permission, so no page.
    const c = await shop.open(CASH, '/branding');
    expect(c.status).toBe(403);
    expect(c.writes).toEqual([]);
    await c.close();
    const refused = await shop.call('PUT', '/v1/platform/branding', CASH, { ...BRAND, productName: 'Not allowed' });
    expect(refused.status).toBe(403);
    expect(((await shop.call('GET', '/v1/platform/branding', IT)).body as { productName: string }).productName).toBe('Synthetic Fresh Market');
  }, 60_000);
});
