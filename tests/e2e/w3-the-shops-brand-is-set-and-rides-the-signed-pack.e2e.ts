import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HAVE_BROWSER, startBoxPageShop, says, type BoxPageShop } from './lib/r4c-box-page';
import { aStoreWithRules } from '../support/store-rules';
import { shopDateIn } from '../../packages/calendar/src/shop-clock';

/**
 * **W3 · M36-FR-02 (OB-321 · P-06 · P-08 · hard rule #1): the shop's own name, logo and colours — set on the office page,
 * signed into the catalogue pack, and read by the store computer's screens and the till from the pack it holds.**
 *   • head office's brand is "Synthetic Fresh Mart" and it publishes the signed pack; the store computer holds that pack
 *     (verified with head office's key, as a pulled pack is) — so the office menu shows the shop's name and colour, the till
 *     page is handed the brand inside its signed catalogue, and the Shop name page says the tills print what head office
 *     says. No network call is involved at the till: the brand is in the catalogue it already holds.
 *   • the IT administrator changes the name on the page; head office refuses an unreadable colour pair in its own words
 *     (nothing saved), then accepts a readable one; the page now says the tills do not yet print it — it reaches them with
 *     the next pack (visible, never hidden, P-08);
 *   • a cashier whom the box lets open the page is refused by head office, in its words, and offered no form.
 * (M36 had no browser test before this wave.)
 */

const OWNER = 'u-owner'; const IT = 'u-it'; const CASH = 'u-cash';

describe.skipIf(!HAVE_BROWSER)('The shop\'s brand (W3 · M36-FR-02)', () => {
  let shop: BoxPageShop;
  beforeAll(async () => {
    shop = await startBoxPageShop({
      name: 'branding',
      people: [{ userId: IT, permissions: ['platform.branding.read', 'platform.branding.write'] }, { userId: CASH, permissions: ['platform.branding.read'] }],
      seed: async (ho, T, store) => {
        const ok = async (method: 'POST' | 'PUT', path: string, body: unknown) => {
          const r = await ho.request({ method, path, userId: OWNER, tenantId: T, idempotencyKey: `k-${randomUUID()}`, body });
          if (r.status >= 300) throw new Error(`${path}: ${r.status} ${JSON.stringify(r.body)}`);
        };
        await ho.seedOwner(T, OWNER);
        await ho.provisionRole(T, IT, 'platform_admin');
        await ho.provisionRole(T, CASH, 'cashier', [store]);
        await aStoreWithRules(ho, T, OWNER, store, 0);
        await ok('POST', '/v1/catalogue/tax-classes/1006/rates/2017-07-01', { rateBps: 500 });
        await ok('POST', '/v1/catalogue/products/p-rice/publish', { product: { sku: 'RICE-1', name: 'Ponni rice 1 kg', baseUom: 'ea', primaryCategoryId: 'grocery', taxClass: '1006', lifecycle: 'active' }, categories: [{ categoryId: 'grocery', name: 'Grocery', parentId: null }] });
        await ok('POST', '/v1/prices/list/p-rice/entries/e1', { scope: 'store', scopeRef: store, priceMinor: 6_200, mrpMinor: 7_000, costMinor: 4_800, marginFloorBps: 0, currency: 'INR', effectiveFrom: shopDateIn(new Date().toISOString()) });
        await ok('PUT', '/v1/platform/branding', { productName: 'Synthetic Fresh Mart', legalName: 'Synthetic Fresh Mart Pvt Ltd', colours: { primary: '#1a4d2e', onPrimary: '#ffffff' } });
        await ok('POST', '/v1/catalogue/pack', { storeId: store, asOf: shopDateIn(new Date().toISOString()) });
      },
      // The store computer holds the pack head office published — where it keeps the pack it last accepted.
      beforeBoxStarts: async (ho, T, dir) => {
        const pack = (await ho.request({ method: 'GET', path: '/v1/catalogue/pack', userId: OWNER, tenantId: T })).body as { snapshot: { branding?: unknown } };
        expect(pack.snapshot.branding).toEqual({ productName: 'Synthetic Fresh Mart', legalName: 'Synthetic Fresh Mart Pvt Ltd', colours: { primary: '#1a4d2e', onPrimary: '#ffffff' } });
        await writeFile(join(dir, 'signed-pack.json'), JSON.stringify(pack), 'utf8');
      },
    });
  }, 240_000);
  afterAll(async () => { await shop?.stop(); });

  it('the menu and the till read the brand from the signed pack; a change on the page is said to wait for the next pack', async () => {
    const p = await shop.open(IT, '/branding');
    await says(p.page, '#v-ho', /^Synthetic Fresh Mart$/);
    await says(p.page, '#v-box', /^Synthetic Fresh Mart$/);
    await says(p.page, '#v-box-more', /From catalogue pack v\d+, which this store computer holds\. The tills print what head office says\./);
    // The office menu's mark and name are the shop's own, from the pack this box holds.
    await says(p.page, '.sre-menu .brand[data-shop-brand] b', /^Synthetic Fresh Mart$/);
    expect(await p.page.$eval('.sre-menu .brand .mark', (e) => (e as unknown as { textContent: string }).textContent)).toBe('SFM');
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
    await p.page.click('#lang');
    await says(p.page, '#page-h', /^கடைப் பெயரும் வண்ணங்களும்$/);
    expect(p.errors).toEqual([]);
    await p.close();

    // The till page is handed the brand INSIDE its signed catalogue (and the shop's brand global) — nothing to fetch.
    const till = await shop.open(IT, '/pos/');
    const handed = await till.page.evaluate(() => {
      const w = globalThis as unknown as { posCatalogue?: { branding?: { productName?: string } }; sreBrand?: { productName?: string } };
      return { catalogue: w.posCatalogue?.branding?.productName, brand: w.sreBrand?.productName };
    });
    expect(handed).toEqual({ catalogue: 'Synthetic Fresh Mart', brand: 'Synthetic Fresh Mart' });
    await till.close();
  });

  it('a cashier is refused by head office, in its words, and offered no form', async () => {
    const c = await shop.open(CASH, '/branding');
    await says(c.page, '#page-status', /Head office refused:/);
    expect(await c.page.isVisible('#form')).toBe(false);
    expect(c.writes).toEqual([]);
    await c.close();
  });
});
