import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { HAVE_BROWSER, startBoxPageShop, says, type BoxPageShop } from './lib/r4c-box-page';
import { aBranch } from '../support/a-branch';

/**
 * **Wave 2 (D02-FR-02 "seasonal assortment and store clustering" · OB-318 · M04-FR-01): Store groups and seasons, on the
 * store computer, over head office's groups (price zones), group range decisions and season plans.** In a real browser:
 *   • the group "coast" and its two stores are listed; the manager carries RICE in both;
 *   • she takes DAL out of the range with a reason: the store with DAL on hand sends it to clearance, the one without takes it
 *     out — head office read the stock, the page sent none;
 *   • the page says no owner-approval size is set yet (OB-644) and each group change is audited;
 *   • she makes a Diwali season plan for the group; it is listed with where it stands;
 *   • a cashier the box lets open the page is refused by head office, in its words, and offered no form; Tamil words.
 * Synthetic data only.
 */

const OWNER = 'u-owner'; const MGR = 'u-mgr'; const CASH = 'u-cash';

describe.skipIf(!HAVE_BROWSER)('Store groups and seasons (Wave 2)', () => {
  let shop: BoxPageShop;
  beforeAll(async () => {
    shop = await startBoxPageShop({
      name: 'range',
      people: [{ userId: MGR, permissions: ['merchandising.range.read', 'merchandising.range.manage'] }, { userId: CASH, permissions: ['merchandising.range.read'] }],
      seed: async (ho, T, store) => {
        await ho.seedOwner(T, OWNER);
        await aBranch(ho, T, OWNER, store);
        await aBranch(ho, T, OWNER, 'store-2');
        await ho.provisionRole(T, MGR, 'store_manager', [store, 'store-2']);
        await ho.provisionRole(T, CASH, 'cashier', [store]);
      },
    });
    const ok = async (path: string, body: unknown) => { const r = await shop.call('POST', path, OWNER, body); if (r.status >= 300) throw new Error(`${path}: ${r.status} ${JSON.stringify(r.body)}`); };
    const product = (id: string) => ({ sku: `SKU-${id}`, name: `Synthetic ${id}`, baseUom: 'ea', primaryCategoryId: 'grocery', taxClass: '10063020', lifecycle: 'active', safety: { allergens: [], countryOfOrigin: 'India' } });
    await ok('/v1/catalogue/categories/grocery', { name: 'Grocery', parentId: null });
    for (const id of ['RICE', 'DAL']) await ok(`/v1/catalogue/products/${id}/publish`, { product: product(id) });
    await ok(`/v1/prices/zones/coast/stores/${shop.store}`, {});
    await ok('/v1/prices/zones/coast/stores/store-2', {});
    await ok('/v1/inventory/movements', { movementId: 'rx-dal', productId: 'DAL', locationId: shop.store, kind: 'received', quantityMinor: 10, uom: 'EA', occurredAt: new Date(Date.now() - 86_400_000).toISOString(), enteredBy: OWNER, unitCostMinor: 7_000 });
  }, 240_000);
  afterAll(async () => { await shop?.stop(); });

  it('the manager carries a product in a group, takes another out (stock goes to clearance) and makes a season plan', async () => {
    const m = await shop.open(MGR, '/range-clusters/');
    await says(m.page, '#group-rows tr[data-group="coast"]', /coast\s*2/);
    await says(m.page, '#cards', /Store groups\s*1/);
    await says(m.page, '#seasons-register', /No season plans yet/);
    // OB-644: the page says plainly that no owner-approval size is set yet, and that each change is audited.
    await says(m.page, '#range-note', /No size has been set yet for a range change big enough to need the owner's approval.*audit trail/);

    await m.page.selectOption('#r-zone', 'coast'); await m.page.fill('#r-product', 'RICE'); await m.page.fill('#r-from', '2026-11-01');
    await m.page.click('#range-go');
    await says(m.page, '#range-status', /^Carried in 2 store\(s\) from 2026-11-01/);

    await m.page.fill('#r-product', 'DAL'); await m.page.selectOption('#r-action', 'drop'); await m.page.selectOption('#r-reason', 'poor_sales');
    await m.page.click('#range-go');
    await says(m.page, '#range-status', /^Taken out of the range from 2026-11-01:$/);
    await says(m.page, `#range-result li[data-store="${shop.store}"]`, /10 still on hand — goes to clearance until sold/);
    await says(m.page, '#range-result li[data-store="store-2"]', /none on hand — taken out of the range/);
    expect(m.writes.filter((w) => w.includes('/drop'))).toEqual(['POST /v1/merchandising/clusters/coast/DAL/drop']);

    await m.page.fill('#s-id', 'diwali'); await m.page.selectOption('#s-zone', 'coast'); await m.page.fill('#s-products', 'RICE');
    await m.page.fill('#s-from', '2026-11-01'); await m.page.fill('#s-to', '2026-11-20'); await m.page.fill('#s-reason', 'Diwali sweets and gifts');
    await m.page.click('#season-go');
    await says(m.page, '#season-status', /^Season diwali made for 2 store\(s\), 2026-11-01 to 2026-11-20\.$/);
    await says(m.page, '#season-rows tr[data-season="diwali"]', /coast.*RICE.*2026-11-01.*2026-11-20/);
    const held = (await shop.call('GET', '/v1/merchandising/season-plans', OWNER)).body as { plans: { planId: string; setBy: string }[] };
    expect(held.plans).toEqual([expect.objectContaining({ planId: 'diwali', setBy: MGR })]);

    await m.page.click('#lang');
    await says(m.page, '#page-h', /^கடைக் குழுக்களும் பருவங்களும்$/);
    expect(m.errors).toEqual([]);
    await m.close();
  });

  it('a cashier is refused by head office, in its words, and offered no form', async () => {
    const c = await shop.open(CASH, '/range-clusters/');
    await says(c.page, '#page-status', /^Head office refused:/);
    expect(await c.page.isVisible('#range-form')).toBe(false);
    expect(c.writes).toEqual([]);
    await c.close();
  });
});
