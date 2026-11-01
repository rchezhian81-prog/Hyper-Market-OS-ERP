import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { HAVE_BROWSER, startBoxPageShop, says, type BoxPageShop } from './lib/r4c-box-page';
import { aBranch } from '../support/a-branch';

/**
 * **Round 4d (M11-FR-01 · Screen D): the Recipes page, on the store computer, over head office's recipe register.**
 *   • the store manager adds the café's coffee-cake recipe — kilograms typed as kilograms, sent as grams — head office holds
 *     it as version 1; changing it makes version 2 and the register says so;
 *   • a cashier the box lets open the page is refused by head office, in its words, and offered no form.
 */

const OWNER = 'u-owner'; const MGR = 'u-mgr'; const CASH = 'u-cash';

describe.skipIf(!HAVE_BROWSER)('Recipes (Round 4d)', () => {
  let shop: BoxPageShop;
  beforeAll(async () => {
    shop = await startBoxPageShop({
      name: 'recipes',
      people: [{ userId: MGR, permissions: ['production.read', 'production.recipe.manage'] }, { userId: CASH, permissions: ['production.read'] }],
      seed: async (ho, T, store) => {
        await ho.seedOwner(T, OWNER);
        await aBranch(ho, T, OWNER, store);
        await ho.provisionRole(T, MGR, 'store_manager', [store]);
        await ho.provisionRole(T, CASH, 'cashier', [store]);
        const on = await ho.request({ method: 'POST', path: '/v1/production/departments/cafe', userId: OWNER, tenantId: T, idempotencyKey: 'cafe-on', body: {} });
        if (on.status >= 300) throw new Error(`cafe: ${JSON.stringify(on.body)}`);
      },
    });
  }, 240_000);
  afterAll(async () => { await shop?.stop(); });

  it('the manager adds a recipe, then changes it into version 2', async () => {
    const m = await shop.open(MGR, '/production-recipes');
    await says(m.page, '#recipes-register', /No recipe set up yet/);
    await says(m.page, '#cards', /Departments switched on\s*1/);
    await m.page.fill('#r-code', 'coffee-cake');
    await m.page.fill('#r-product', 'CAKE-COFFEE');
    await m.page.fill('#r-qty', '12');
    await m.page.fill('#r-hours', '48');
    await m.page.fill('#in-product-0', 'FLOUR');
    await m.page.fill('#in-qty-0', '1.2345');
    await m.page.click('#save-recipe');
    await says(m.page, '#recipe-status', /Type an amount the unit holds exactly/);
    await m.page.fill('#in-qty-0', '1.5');
    await m.page.click('#add-ingredient');
    await m.page.fill('#in-product-1', 'SUGAR');
    await m.page.fill('#in-qty-1', '0.75');
    expect(m.writes).toEqual([]);
    await m.page.click('#save-recipe');
    await says(m.page, '#recipe-status', /^Recipe saved as version 1\.$/);
    await says(m.page, '#recipe-rows tr[data-key="coffee-cake"]', /Café.*12 pieces CAKE-COFFEE.*48.*FLOUR, SUGAR.*1/);
    const held = (await shop.call('GET', '/v1/production/recipes', MGR)).body as { recipes: { recipeId: string; inputs: { productId: string; quantityMinor: number; uom: string }[] }[] };
    expect(held.recipes[0]!.inputs).toEqual([{ productId: 'FLOUR', quantityMinor: 1500, uom: 'kg' }, { productId: 'SUGAR', quantityMinor: 750, uom: 'kg' }]);
    // change it: the same code, the next version
    await m.page.click('#recipe-rows tr[data-key="coffee-cake"] .sre-row-open');
    await m.page.click('#edit-this');
    expect(await m.page.inputValue('#in-qty-1')).toBe('0.750');
    await m.page.fill('#r-hours', '36');
    await m.page.click('#save-recipe');
    await says(m.page, '#recipe-status', /^Recipe saved as version 2\.$/);
    await says(m.page, '#recipe-rows tr[data-key="coffee-cake"]', /36FLOUR, SUGAR2Open$/);
    await m.page.click('#lang');
    await says(m.page, '#register-h', /^சமையல் முறைகள்$/);
    expect(m.errors).toEqual([]);
    await m.close();
  });

  it('a cashier is refused by head office, in its words, and offered no form', async () => {
    const c = await shop.open(CASH, '/production-recipes');
    await says(c.page, '#page-status', /^Head office refused:/);
    expect(await c.page.isVisible('#editor')).toBe(false);
    expect(c.writes).toEqual([]);
    await c.close();
  });
});
