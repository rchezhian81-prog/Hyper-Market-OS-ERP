import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Page } from 'playwright-core';
import { CONNECTED, OWNER, ok, startBoxPageOnCloud, type BoxCloudShop } from './lib/box-page-on-cloud';
import { setUpPracticeStores } from '../support/real-store';

/**
 * **W4 · M03-FR-03 (tax, MRP, ingredients, allergens, nutrition, origin and storage · §28 "tax change with Finance approval"
 * · OB-627 · hard rule #2) — ONE connected run: the GST and cess page and the Product details page in a real browser, served
 * by a REAL store computer, over the PRODUCTION API on real PostgreSQL.** (`r4a-the-product-and-price-pages-…e2e.ts` proves
 * the same pages over the in-memory route set.)
 *   • GST and cess: the owner records the first GST rate and the first cess of an HSN; a later change is "a tax change": he
 *     asks, the ACCOUNTANT approves it on her own Approvals page in her own browser, and the change is recorded naming her.
 *     PostgreSQL holds the whole effective-dated schedule (both periods — nothing overwritten). A manager reads only.
 *   • Product details: the owner records the safety, label and nutrition facts with a reason (a new version on PostgreSQL); a
 *     panel that does not add up is refused in head office's words; a second tab that opened the product before that save
 *     is refused by name and nothing of it is written; a published product's tax class changes only after the accountant
 *     approves it on her Approvals page.
 *   • OB-546: an age limit typed on Product details for a product already on sale is asked, approved by the accountant on her
 *     page and saved naming her; an unreadable age is refused by name.
 * Synthetic data only. Needs DATABASE_URL and Chromium; else it SKIPS.
 */

const ACCT = 'u-acct'; const MGR = 'u-mgr'; const STORE = 'br-1';
const HSN = '24039910';
type Doc = { document: { querySelector(s: string): { textContent: string | null } | null } };
const says = async (page: Page, selector: string, re: RegExp): Promise<void> => {
  try {
    await page.waitForFunction(([sel, src]) => new RegExp(src!).test((globalThis as unknown as Doc).document.querySelector(sel!)?.textContent ?? ''), [selector, re.source] as const, { timeout: 15_000 });
  } catch {
    throw new Error(`${selector} says ${JSON.stringify(await page.textContent(selector).catch(() => null))}, not ${String(re)}`);
  }
};

describe.skipIf(!CONNECTED)('M03-FR-03 connected: GST, cess and a product\'s safety facts on the store computer, over the real cloud on PostgreSQL', () => {
  let shop: BoxCloudShop;
  beforeAll(async () => {
    shop = await startBoxPageOnCloud({
      name: 'm03-tax', store: STORE,
      people: [{ userId: OWNER }, { userId: ACCT }, { userId: MGR, branchId: STORE }],
      seed: async (cloud) => {
        const as = (path: string, body: unknown, key: string) => cloud.request({ method: 'POST', path, userId: OWNER, idempotencyKey: key, body });
        await setUpPracticeStores(cloud, OWNER, [STORE]);
        await cloud.grant(ACCT, 'accountant');
        await cloud.grant(MGR, 'store_manager', undefined, [STORE]);
        await ok(as('/v1/catalogue/tax-classes/10063020/rates/2017-07-01', { rateBps: 500 }, 'tax-1'), 'tax 1');
        await ok(as('/v1/catalogue/tax-classes/19053100/rates/2017-07-01', { rateBps: 1_800 }, 'tax-2'), 'tax 2');
        await ok(as('/v1/catalogue/categories/grocery', { name: 'Grocery', parentId: null, regulated: ['food'] }, 'cat'), 'category');
        await ok(as('/v1/catalogue/products/DAL/publish', { product: {
          sku: 'SKU-DAL', name: 'Synthetic toor dal 1 kg', baseUom: 'ea', primaryCategoryId: 'grocery', taxClass: '10063020', lifecycle: 'active',
          mrpHistory: [{ value: { minor: 15_000, currency: 'INR' }, effectiveFrom: '2026-01-01' }], safety: { allergens: [], countryOfOrigin: 'India' },
        } }, 'pub-dal'), 'publish DAL');
      },
    });
  }, 300_000);
  afterAll(async () => { await shop?.stop(); });

  /** The accountant, on her own Approvals page in her own browser: the waiting request of this kind, approved with a reason. */
  const accountantApproves = async (kind: string, subjectRef: string): Promise<void> => {
    const inbox = (await shop.call('GET', '/v1/approvals/requests', ACCT)).body as { waitingForMe: { requestId: string; kind: string; subjectRef: string }[] };
    const waiting = inbox.waitingForMe.find((r) => r.kind === kind && r.subjectRef === subjectRef);
    expect(waiting, `${kind} ${subjectRef} waits for the accountant`).toBeDefined();
    const a = await shop.open(ACCT, '/approvals');
    expect(a.status).toBe(200);
    const row = a.page.locator(`#waiting li[data-request-id="${waiting!.requestId}"]`);
    await row.waitFor({ timeout: 15_000 });
    await row.locator('input.reason').fill('checked against the CA\'s note (synthetic)');
    await row.locator('button.approve').click();
    await row.waitFor({ state: 'detached', timeout: 15_000 });
    expect(a.writes).toEqual([`POST /v1/approvals/requests/${waiting!.requestId}/decide`]);
    expect(a.errors).toEqual([]);
    await a.close();
  };

  it('GST and cess: first rates recorded; a change waits for the accountant, who approves on her own page; PostgreSQL keeps both periods', async () => {
    const { page, errors, status, close } = await shop.open(OWNER, '/tax-rates/');
    expect(status).toBe(200);
    await page.locator('#rows tr[data-id="10063020"]').waitFor();
    await page.fill('#hsn', HSN); await page.click('#open');
    await says(page, '#record-h', /^HSN 24039910$/);
    await page.fill('#g-from', '2017-07-01'); await page.fill('#g-rate', '28');
    await page.click('#g-save');
    await says(page, '#record-status', /^Recorded\.$/);
    await page.fill('#c-from', '2017-07-01'); await page.fill('#c-adv', '61'); await page.fill('#c-spec', '0'); await page.fill('#c-per', '1');
    await page.click('#c-save');
    await says(page, '#record-status', /^Recorded\.$/);
    // A change of a rate already in force is a tax change: Finance approves it first.
    await page.fill('#g-from', '2026-12-01'); await page.fill('#g-rate', '40');
    await page.click('#g-save');
    await says(page, '#record-status', /^This is a tax change/);
    await page.fill('#why', 'GST 2.0 slab (synthetic)');
    await page.click('#ask');
    await says(page, '#record-status', /^Asked\./);
    await accountantApproves('tax_rate_change', HSN);
    await page.click('#g-save');
    await says(page, '#record-status', new RegExp(`^Recorded with the approval of ${ACCT}\\.$`));
    await page.locator('#gst-list li[data-from="2026-12-01"]').waitFor();
    await page.fill('#c-from', '2026-12-01'); await page.fill('#c-adv', '0');
    await page.click('#c-save');
    await says(page, '#record-status', /^This is a tax change/);
    await page.click('#ask');
    await says(page, '#record-status', /^Asked\./);
    await accountantApproves('cess_rate_change', HSN);
    await page.click('#c-save');
    await says(page, '#record-status', new RegExp(`^Recorded with the approval of ${ACCT}\\.$`));
    await page.click('#lang');
    await says(page, '#gst-h', /^GST விகிதம்$/);
    expect(errors).toEqual([]);
    await close();

    // PostgreSQL holds the whole effective-dated schedule: the first period is still there (append-only).
    const gst = (await shop.call('GET', `/v1/catalogue/tax-classes/${HSN}/rates`, OWNER)).body as { schedule: { effectiveFrom: string; rateBps: number }[] };
    expect(gst.schedule.map((p) => [p.effectiveFrom, p.rateBps])).toEqual([['2017-07-01', 2_800], ['2026-12-01', 4_000]]);
    const cess = (await shop.call('GET', `/v1/catalogue/tax-classes/${HSN}/cess`, OWNER)).body as { schedule: { effectiveFrom: string; advaloremBps: number }[] };
    expect(cess.schedule.map((p) => [p.effectiveFrom, p.advaloremBps])).toEqual([['2017-07-01', 6_100], ['2026-12-01', 0]]);

    // A manager reads it with every control off; head office refuses his rate all the same.
    const m = await shop.open(MGR, '/tax-rates/');
    await m.page.locator('#rows tr[data-id="10063020"]').click();
    await says(m.page, '#record-h', /^HSN 10063020$/);
    expect(await m.page.isDisabled('#g-save')).toBe(true);
    expect(m.writes).toEqual([]);
    await m.close();
    expect((await shop.call('POST', '/v1/catalogue/tax-classes/10063020/rates/2027-01-01', MGR, { rateBps: 1_200 })).status).toBe(403);
  }, 180_000);

  it('Product details: safety facts saved with a reason on PostgreSQL; a bad panel refused; a stale tab refused by name; a tax-class change only after the accountant approves', async () => {
    const a = await shop.open(OWNER, '/product-details/?product=DAL');
    const b = await shop.open(OWNER, '/product-details/?product=DAL');
    expect(a.status).toBe(200);
    for (const p of [a.page, b.page]) await says(p, '#v-state', /^On sale$/);
    const before = (await shop.call('GET', '/v1/catalogue/products/DAL', OWNER)).body as { version: number };

    await a.page.fill('#s-storage', 'Cool and dry');
    await a.page.fill('#s-ingredients', 'Split pigeon peas');
    for (const [k, v] of [['energyKcal', '343'], ['proteinG', '22'], ['carbohydrateG', '63'], ['totalSugarsG', '3'], ['addedSugarsG', '0'], ['totalFatG', '1.5'], ['saturatedFatG', '0.3'], ['transFatG', '0'], ['cholesterolMg', '0'], ['sodiumMg', '17']]) await a.page.fill(`#n-${k}`, v!);
    await a.page.click('#save-safety');
    await says(a.page, '#safety-status', /^Write the reason first\.$/);
    expect(a.writes).toEqual([]);
    await a.page.fill('#s-why', 'label read off the pack (synthetic)');
    await a.page.click('#save-safety');
    await says(a.page, '#safety-status', new RegExp(`^Saved — version ${before.version + 1}\\.$`));
    const held = (await shop.call('GET', '/v1/catalogue/products/DAL', OWNER)).body as { version: number; product: { safety: { storageConditions: string; ingredients: string; nutrition: { proteinG: number }; allergens: string[]; countryOfOrigin: string } } };
    expect(held.version).toBe(before.version + 1);
    expect(held.product.safety).toMatchObject({ storageConditions: 'Cool and dry', ingredients: 'Split pigeon peas', nutrition: { proteinG: 22 }, allergens: [], countryOfOrigin: 'India' });

    // A nutrition panel that does not add up is refused in head office's words; nothing written.
    await a.page.fill('#n-totalSugarsG', '99');
    await a.page.fill('#s-why', 'correcting the panel (synthetic)');
    await a.page.click('#save-safety');
    await says(a.page, '#safety-status', /Head office refused: .*the total sugars cannot be more than the carbohydrate/);
    await a.page.fill('#n-totalSugarsG', '3');
    expect(((await shop.call('GET', '/v1/catalogue/products/DAL', OWNER)).body as { version: number }).version).toBe(before.version + 1);

    // The second tab opened the product BEFORE that save: refused by name, nothing of it written (OB-627 · OB-634).
    await b.page.fill('#s-ingredients', 'Something else entirely');
    await b.page.fill('#s-why', 'my own edit (synthetic)');
    await b.page.click('#save-safety');
    await says(b.page, '#safety-status', /^Someone else saved this product after you opened it\. Nothing of yours was saved\./);
    const still = (await shop.call('GET', '/v1/catalogue/products/DAL', OWNER)).body as { version: number; product: { safety: { ingredients: string } } };
    expect(still.version).toBe(before.version + 1);
    expect(still.product.safety.ingredients).toBe('Split pigeon peas');
    expect(b.errors).toEqual([]);
    await b.close();

    // A published product's tax class changes only with Finance: asked here, approved on the accountant's own page, saved.
    await a.page.click('#tab-record');
    await a.page.fill('#r-taxClass', '19053100');
    await a.page.click('#save');
    await says(a.page, '#record-status', /^This needs a second person: .*Finance approver/);
    await a.page.fill('#r-why', 'reclassified by the CA (synthetic)');
    await a.page.click('#ask-approval');
    await says(a.page, '#record-status', /^Asked\./);
    await a.page.click('#save');
    await says(a.page, '#record-status', /^Still waiting for the second person/);
    expect(((await shop.call('GET', '/v1/catalogue/products/DAL', OWNER)).body as { product: { taxClass: string } }).product.taxClass).toBe('10063020');
    await accountantApproves('hsn_class_change', 'product:DAL');
    await a.page.click('#save');
    await says(a.page, '#record-status', new RegExp(`^Saved with the approval of ${ACCT}\\.$`));
    const after = (await shop.call('GET', '/v1/catalogue/products/DAL', OWNER)).body as { product: { taxClass: string; safety: { ingredients: string } } };
    expect(after.product.taxClass).toBe('19053100');
    expect(after.product.safety.ingredients).toBe('Split pigeon peas'); // the full save never re-sent safety (OB-627)
    expect(a.errors).toEqual([]);
    await a.close();
  }, 180_000);

  it('OB-546: an age limit newly on a product on sale is asked on the safety save, approved by the accountant on her page, then saved naming her', async () => {
    await ok(shop.call('POST', '/v1/catalogue/products/DRINK/publish', OWNER, { product: {
      sku: 'SKU-DRINK', name: 'Synthetic energy drink 250 ml', baseUom: 'ea', primaryCategoryId: 'grocery', taxClass: '10063020', lifecycle: 'active',
      mrpHistory: [{ value: { minor: 12_500, currency: 'INR' }, effectiveFrom: '2026-01-01' }], safety: { allergens: [], countryOfOrigin: 'India' },
    } }), 'drink on sale');
    const a = await shop.open(OWNER, '/product-details/?product=DRINK');
    await says(a.page, '#v-state', /^On sale$/);
    await a.page.fill('#s-minage', '18');
    await a.page.fill('#s-why', 'the shop sells it to adults only (synthetic)');
    await a.page.click('#save-safety');
    await says(a.page, '#safety-status', /^This needs a second person: .*minimum age.* press “Save safety and label” again\.$/);
    expect(((await shop.call('GET', '/v1/catalogue/products/DRINK', OWNER)).body as { product: { safety: { minimumAge?: number } } }).product.safety.minimumAge).toBeUndefined();
    await a.page.click('#ask-safety-approval');
    await says(a.page, '#safety-status', /^Asked\./);
    await a.page.click('#save-safety');
    await says(a.page, '#safety-status', /^Still waiting for the second person/);
    await accountantApproves('regulated_product_publish', 'product:DRINK');
    await a.page.click('#save-safety');
    await says(a.page, '#safety-status', new RegExp(`^Saved with the approval of ${ACCT}\\.$`));
    expect(((await shop.call('GET', '/v1/catalogue/products/DRINK', OWNER)).body as { product: { safety: { minimumAge?: number } } }).product.safety.minimumAge).toBe(18);
    // A minimum age the till cannot read is refused by head office, by name.
    await a.page.fill('#s-minage', 'eighteen');
    await a.page.fill('#s-why', 'typo test (synthetic)');
    await a.page.click('#save-safety');
    await says(a.page, '#safety-status', /^Head office refused: The minimum age to buy this product must be a whole number of years/);
    await a.page.click('#lang');
    await says(a.page, '#l-s-minage', /^வாங்கக் குறைந்தபட்ச வயது/);
    expect(a.errors).toEqual([]);
    await a.close();
  }, 180_000);
});
