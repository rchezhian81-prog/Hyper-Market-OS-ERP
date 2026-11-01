import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { HAVE_BROWSER, startBoxPageShop, says, type BoxPageShop } from './lib/r4c-box-page';
import { aBranch } from '../support/a-branch';

/**
 * **Wave 2 · OB-625 (owner, 1 Nov 2026): the three read-only product checks, on the store computer, over head office's
 * product master.** In a real browser:
 *   • the cards count, from head office: products checked (of those on the master), no tax mapping, allergen or ingredient
 *     details missing, no barcode;
 *   • each register names the product and what is missing, in words — an HSN with no GST rate today; a packed-food product
 *     with no allergen declaration or ingredient list; no barcode, with a product sold by weight marked;
 *   • a check that finds nothing says how many products it checked (never "all clear"); a row opens the product's own page;
 *   • nothing is written; a cashier the box lets open the page is refused by head office in its words; Tamil words.
 * Synthetic data only.
 */

const OWNER = 'u-owner'; const MGR = 'u-mgr'; const CASH = 'u-cash';

describe.skipIf(!HAVE_BROWSER)('Product checks (Wave 2 · OB-625)', () => {
  let shop: BoxPageShop;
  beforeAll(async () => {
    shop = await startBoxPageShop({
      name: 'checks',
      people: [{ userId: MGR, permissions: ['reporting.report.read', 'catalogue.pack.read'] }, { userId: CASH, permissions: ['reporting.report.read'] }],
      seed: async (ho, T, store) => {
        await ho.seedOwner(T, OWNER);
        await aBranch(ho, T, OWNER, store);
        await ho.provisionRole(T, MGR, 'store_manager', [store]);
        await ho.provisionRole(T, CASH, 'cashier', [store]);
      },
    });
    const ok = async (method: 'POST', path: string, body: unknown) => { const r = await shop.call(method, path, OWNER, body); if (r.status >= 300) throw new Error(`${path}: ${r.status} ${JSON.stringify(r.body)}`); };
    const product = (id: string, extra: Record<string, unknown> = {}) => ({
      sku: `SKU-${id}`, name: `Synthetic ${id}`, baseUom: 'ea', primaryCategoryId: 'grocery', taxClass: '10063020', lifecycle: 'active',
      safety: { allergens: [], countryOfOrigin: 'India', ingredients: 'Rice' }, ...extra,
    });
    await ok('POST', '/v1/catalogue/tax-classes/10063020/rates/2017-07-01', { rateBps: 500 });
    await ok('POST', '/v1/catalogue/categories/grocery', { name: 'Grocery', parentId: null });
    await ok('POST', '/v1/catalogue/products/RICE/publish', { product: product('RICE') });
    await ok('POST', '/v1/catalogue/products/RICE/barcodes/RICE-0001', { kind: 'internal' });
    await ok('POST', '/v1/catalogue/products/SOAP/publish', { product: product('SOAP', { taxClass: '34011190' }) });
    await ok('POST', '/v1/catalogue/products/SOAP/barcodes/SOAP-0001', { kind: 'internal' });
    await ok('POST', '/v1/catalogue/products/DAL/publish', { product: product('DAL', { baseUom: 'kg' }) });
    await ok('POST', '/v1/catalogue/products/BISCUIT/publish', { product: product('BISCUIT', { safety: { countryOfOrigin: 'India' } }) });
    await ok('POST', '/v1/catalogue/products/BISCUIT/barcodes/BIS-0001', { kind: 'internal' });
    await ok('POST', '/v1/catalogue/categories/grocery', { name: 'Grocery', parentId: null, regulated: ['food', 'packed'] });
  }, 240_000);
  afterAll(async () => { await shop?.stop(); });

  it('the manager reads each gap by name and opens a product from its row; nothing is written', async () => {
    const m = await shop.open(MGR, '/product-checks/');
    await says(m.page, '#cards', /Products checked\s*4/);
    await says(m.page, '#cards', /No tax mapping\s*1/);
    await says(m.page, '#cards', /Allergen or ingredient details missing\s*1/);
    await says(m.page, '#cards', /No barcode\s*1/);
    await says(m.page, '#tax-rows tr[data-product="SOAP"]', /34011190.*No GST rate for this HSN today/);
    await says(m.page, '#allergens-rows tr[data-product="BISCUIT"]', /No allergen declaration; No ingredient list/);
    await says(m.page, '#barcode-rows tr[data-product="DAL"]', /Yes — rung from a scale label/);
    await m.page.click('#allergens-rows tr[data-product="BISCUIT"] button');
    expect(await m.page.getAttribute('#sre-drawer a.sre-btn', 'href')).toBe('../product-details/?product=BISCUIT');
    await m.page.keyboard.press('Escape');
    await m.page.click('#lang');
    await says(m.page, '#page-h', /^பொருள் சரிபார்ப்புகள்$/);
    await says(m.page, '#tax-rows', /இந்த HSN க்கு இன்று GST விகிதம் இல்லை/);
    expect(m.writes).toEqual([]);
    expect(m.errors).toEqual([]);
    await m.close();
  });

  it('a check with nothing found says how many it checked', async () => {
    const r = await shop.call('POST', '/v1/catalogue/tax-classes/34011190/rates/2017-07-01', OWNER, { rateBps: 1_800 });
    expect(r.status).toBe(201);
    const m = await shop.open(MGR, '/product-checks/');
    await says(m.page, '#tax-register', /None found.*checked 4 product\(s\) that can be sold and found none/);
    await m.close();
  });

  it('a cashier is refused by head office, in its words', async () => {
    const c = await shop.open(CASH, '/product-checks/');
    await says(c.page, '#page-status', /^Head office refused:/);
    await says(c.page, '#cards', /Products checked\s*Not known/);
    await c.close();
  });
});
