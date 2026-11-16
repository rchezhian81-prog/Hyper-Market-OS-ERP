import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { HAVE_BROWSER, startBoxPageShop, says, type BoxPageShop } from './lib/r4c-box-page';
import { aBranch } from '../support/a-branch';

/**
 * **OB-800 THE PLAN fix batch 5 — the owner's pages (daily-work walkthrough), in a real browser served by the store
 * computer, over head office's real routes.**
 *   • D-053 Users & roles: a person is listed by NAME ("Meena (u-cash)"), never only by a login id; the roles a person can
 *     be given leave out every machine role (the store computer, "… (machine)"); the stores box starts on this store and
 *     has a "Choose…" list; giving a role still goes to the owner for approval (nothing new is granted here).
 *   • D-058 Product details: MRP and the price at the tills are at the TOP of the record; a household item shows no
 *     nutrition, ingredients or allergen boxes and no tobacco section; a food item shows its nutrition boxes.
 */

const OWNER = 'u-owner'; const MGR = 'u-mgr'; const CASH = 'u-cash';
const ROLE_WORDS = ['identity.role.read', 'identity.role.request', 'identity.role.grant'];
const PRODUCT_WORDS = ['catalogue.pack.read', 'catalogue.pack.publish', 'catalogue.category.propose', 'catalogue.category.approve', 'catalogue.tax.approve', 'price.change.propose', 'org.branch.read'];
const MACHINE_ROLES = ['store_computer', 'backup_job', 'message_provider_relay', 'findings_push', 'qg10_release_evidence'];

const product = (id: string, categoryId: string, extra: Record<string, unknown> = {}) => ({
  sku: `SKU-${id}`, name: `Synthetic ${id}`, baseUom: 'ea', primaryCategoryId: categoryId, taxClass: '34011110', lifecycle: 'active',
  mrpHistory: [{ value: { minor: 4_000, currency: 'INR' }, effectiveFrom: '2026-01-01' }], safety: { allergens: [], countryOfOrigin: 'India' }, ...extra,
});

describe.skipIf(!HAVE_BROWSER)('fix batch 5: the owner\'s people and product pages', () => {
  let shop: BoxPageShop;
  beforeAll(async () => {
    shop = await startBoxPageShop({
      name: 'batch5',
      people: [{ userId: OWNER, permissions: [...ROLE_WORDS, ...PRODUCT_WORDS] }, { userId: MGR, permissions: ['identity.role.request'] }, { userId: CASH, permissions: [] }],
      pack: {
        policies: { tradingDayCutoff: '02:00', storeId: 'store-1', branchId: 'store-1', branchName: 'Test Store' },
        people: [{ userId: CASH, displayName: 'Meena' }, { userId: MGR, displayName: 'Ravi' }],
      },
      seed: async (ho, T, store) => {
        await ho.seedOwner(T, OWNER);
        await aBranch(ho, T, OWNER, store);
        await ho.provisionRole(T, MGR, 'store_manager', [store]);
        await ho.provisionRole(T, CASH, 'cashier', [store]);
        const post = async (path: string, body: unknown) => {
          const r = await ho.request({ method: 'POST', path, userId: OWNER, tenantId: T, idempotencyKey: `k-${path}`, body });
          if (r.status >= 300) throw new Error(`${path}: ${r.status} ${JSON.stringify(r.body)}`);
        };
        await post('/v1/catalogue/tax-classes/34011110/rates/2017-07-01', { rateBps: 1_800 });
        await post('/v1/catalogue/categories/household', { name: 'Household', parentId: null, regulated: [] });
        await post('/v1/catalogue/categories/grocery', { name: 'Grocery', parentId: null, regulated: ['food'] });
        await post('/v1/catalogue/products/SOAP/publish', { product: product('SOAP', 'household', { safety: { countryOfOrigin: 'India' } }) });
        await post('/v1/catalogue/products/DAL/publish', { product: product('DAL', 'grocery') });
      },
    });
  }, 240_000);
  afterAll(async () => { await shop?.stop(); });

  it('D-053: people by name, no machine roles to give, the store box starts on this store with a "Choose…" list', async () => {
    const m = await shop.open(MGR, '/users/');
    await m.page.waitForSelector(`#holder-rows li[data-person="${CASH}"]`);
    expect((await m.page.textContent(`#holder-rows li[data-person="${CASH}"] h4`))?.trim()).toBe(`Meena (${CASH})`);
    await m.page.waitForSelector('#g-role option[value="cashier"]', { state: 'attached' });
    const offered = await m.page.$$eval('#g-role option', (os) => os.map((o) => (o as unknown as { value: string }).value));
    for (const id of MACHINE_ROLES) expect(offered, id).not.toContain(id);
    expect(await m.page.$$eval('#g-role option', (os) => os.map((o) => o.textContent ?? '').filter((t) => /\(machine\)/i.test(t)))).toEqual([]);
    expect(offered).toContain('store_manager');
    // The stores box starts on this store, and a "Choose…" list sits beside it (a typed "all" still works).
    expect(await m.page.inputValue('#g-stores')).toBe('store-1');
    expect(await m.page.isVisible('#g-stores-pick')).toBe(true);
    // Giving a role still waits for the owner — nothing is granted from this page by one person.
    await m.page.fill('#g-person', 'u-new');
    await m.page.selectOption('#g-role', 'cashier');
    await m.page.fill('#g-reason', 'new cashier from Monday');
    await m.page.click('#g-ask');
    await says(m.page, '#give-status', /once the owner approves it/);
    const grants = (await shop.call('GET', '/v1/identity/grants', OWNER)).body as { grants: { userId: string }[] };
    expect(grants.grants.some((g) => g.userId === 'u-new')).toBe(false);
    expect(m.errors).toEqual([]);
  });

  it('D-058: MRP and the till price lead the record; a household item shows no food boxes and no tobacco section', async () => {
    const o = await shop.open(OWNER, '/product-details/?product=SOAP');
    await o.page.waitForSelector('#view-record:not([hidden])');
    // MRP (and the price at the tills) come before the record's other boxes.
    const mrpFirst = await o.page.evaluate(() => {
      const d = (globalThis as unknown as { document: { getElementById(i: string): { compareDocumentPosition(n: unknown): number } } }).document;
      return (d.getElementById('mrp-box').compareDocumentPosition(d.getElementById('record-form')) & 4) !== 0; // DOCUMENT_POSITION_FOLLOWING
    });
    expect(mrpFirst).toBe(true);
    await says(o.page, '#mrp-list', /₹40\.00/);
    await says(o.page, '#price-now', /No price at this store's tills today\.|Price at this store's tills today: ₹/);
    // A household item: no nutrition, ingredients or allergen boxes; no tobacco section.
    expect(await o.page.isVisible('#nutrition-box')).toBe(false);
    expect(await o.page.isVisible('#s-ingredients')).toBe(false);
    expect(await o.page.isVisible('#s-allergens')).toBe(false);
    expect(await o.page.isVisible('#tobacco')).toBe(false);
    // What every item needs is still there.
    expect(await o.page.isVisible('#s-origin')).toBe(true);
    expect(o.errors).toEqual([]);

    const f = await shop.open(OWNER, '/product-details/?product=DAL');
    await f.page.waitForSelector('#view-record:not([hidden])');
    await f.page.waitForSelector('#nutrition-box:not([hidden])');
    expect(await f.page.isVisible('#s-ingredients')).toBe(true);
    expect(await f.page.isVisible('#tobacco')).toBe(false);
    expect(f.errors).toEqual([]);
  });
});
