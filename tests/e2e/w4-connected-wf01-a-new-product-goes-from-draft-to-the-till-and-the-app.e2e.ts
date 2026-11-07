import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { chromium, type Browser } from 'playwright-core';
import { CONNECTED, CHROMIUM, OWNER, ok, startBoxPageOnCloud, type BoxCloudShop } from './lib/box-page-on-cloud';
import { setUpPracticeStores } from '../support/real-store';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { prepareTillBox, signInThroughScreen } from '../support/till-operator';
import { STORE_RULES } from '../support/store-rules';
import { shopDateIn } from '../../packages/calendar/src/shop-clock';

/**
 * **W4 · WF-01 product onboarding (roadmap §26: "Draft → duplicate/GS1 check → tax/UOM/pack/content → approval → assortment
 * → price → shelf/POS/app publication" · M03-FR-01 "incomplete product saved as draft" · M03-FR-02/03 · M04-FR-01 · M05-FR-01
 * · D01-FR-06 · OB-503/OB-546 · ADR-0013) — ONE connected run: every step on its own office page in real Chromium, served by a
 * REAL store computer, over the PRODUCTION API on real PostgreSQL; then a REAL till box pulls head office's signed pack and
 * rings the new product (asking the age question), and a REAL customer box serves the app, which finds it by a customer's word.**
 *   1. DRAFT — the owner starts "Synthetic Energy Drink 250 ml" on Product details with its unit, category, tax (HSN) class and
 *      MRP but without its allergen declaration or country of origin: head office KEEPS it as a draft — not on sale, never in a
 *      pack — and the page says, in head office's words, what it still needs.
 *   2. DUPLICATE / GS1 — a barcode with a wrong GS1 check digit is refused; one already held by another product is refused
 *      naming that product; the right EAN is given; the look-alike is listed on Duplicates and merges, never merged by itself.
 *   3. TAX / UOM / PACK / CONTENT — a case of 24 is defined; the safety facts, including an age limit of 18, are saved with a
 *      reason; the App content page gives the Tamil name, descriptions and the customers' words ("power drink").
 *   4. APPROVAL (OB-546: an age limit needs a second person) — putting it on sale is asked on the page and approved by the
 *      ACCOUNTANT on her own Approvals page; it is then saved naming her, and is on sale.
 *   5. ASSORTMENT — the store manager carries it in the store group "coast" (br-1).
 *   6. PRICE — the store manager prices it ₹110 at br-1 from today, judged against head office's MRP, cost and floor.
 *   7. SHELF / POS / APP — the owner sends the pack on Price lists → "Send to the tills": the preview names what goes and what
 *      is left out (a draft jam: "a draft, not on sale"), then it is signed. The till box pulls it; the served till asks the
 *      age question and rings the EAN at ₹110.00; the customer box takes head office's setup and the app finds it by "power".
 * The first stock comes with WF-04 receiving; one receipt is laid through the API so the price has a buying cost.
 * Synthetic data only. Needs DATABASE_URL and Chromium; else it SKIPS.
 */

const MGR = 'u-mgr'; const ACCT = 'u-acct'; const BOX = 'u-box'; const CASHIER = 'u-meena'; const STORE = 'br-1';
const P = 'P-ENERGY'; const NAME = 'Synthetic Energy Drink 250 ml';
const EAN = '8901234500422';
const BAD_CHECK_DIGIT = '8901234500421';
const HELD_ELSEWHERE = '8901234500996';
const SETTINGS = { tradingDayCutoff: '02:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 5_000, cashVarianceToleranceMinor: 5_000, privacySlaDays: 15, warehouseId: STORE };
type Doc = { document: { querySelector(s: string): { textContent: string | null; hidden?: boolean } | null } };
const says = async (page: Page, selector: string, re: RegExp): Promise<void> => {
  try {
    await page.waitForFunction(([sel, src]) => new RegExp(src!).test((globalThis as unknown as Doc).document.querySelector(sel!)?.textContent ?? ''), [selector, re.source] as const, { timeout: 15_000 });
  } catch {
    throw new Error(`${selector} says ${JSON.stringify(await page.textContent(selector).catch(() => null))}, not ${String(re)}`);
  }
};
interface PosWindow { readonly posCatalogue?: { readonly version: number; readonly source?: string }; readonly posSession?: { hasCatalogue(): boolean; basket(): unknown[] } }

describe.skipIf(!CONNECTED)('WF-01 connected: a new product goes from a real draft to the till and the customer app, on the real cloud on PostgreSQL', () => {
  let shop: BoxCloudShop;
  let browser: Browser;
  const today = shopDateIn(new Date().toISOString());
  const stops: (() => Promise<void>)[] = [];
  const product = async () => (await shop.call('GET', `/v1/catalogue/products/${P}`, OWNER)).body as { version: number; product: Record<string, unknown> & { lifecycle: string; safety?: Record<string, unknown>; appContent?: { synonyms?: string[] } } };

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'pos'], { stdio: 'ignore' });
    execFileSync('node', ['scripts/build-app.mjs', 'customer-app'], { stdio: 'ignore' });
    shop = await startBoxPageOnCloud({
      name: 'wf01', store: STORE,
      people: [{ userId: OWNER }, { userId: ACCT }, { userId: MGR, branchId: STORE }],
      seed: async (cloud) => {
        const as = (path: string, body: unknown, key: string, who = OWNER) => cloud.request({ method: 'POST', path, userId: who, idempotencyKey: key, body });
        await setUpPracticeStores(cloud, OWNER, [STORE]);
        await cloud.grant(ACCT, 'accountant');
        await cloud.grant(MGR, 'store_manager', undefined, [STORE]);
        await cloud.grant(BOX, 'store_computer', undefined, [STORE]);
        await cloud.grant(CASHIER, 'cashier', undefined, [STORE]);
        await ok(as(`/v1/stores/${STORE}/rules`, { ...STORE_RULES, marginFloorBps: 1_000 }, 'rules'), 'store rules');
        await ok(as(`/v1/stores/${STORE}/settings`, SETTINGS, 'settings'), 'store settings');
        await ok(as('/v1/catalogue/tax-classes/22029920/rates/2017-07-01', { rateBps: 1_800 }, 'tax'), 'tax');
        await ok(as('/v1/catalogue/tax-classes/20079910/rates/2017-07-01', { rateBps: 1_200 }, 'tax-jam'), 'tax jam');
        await ok(as('/v1/catalogue/categories/drinks', { name: 'Drinks', parentId: null, regulated: ['food'] }, 'cat'), 'category');
        // The look-alike already on the master — the same name and brand under another id — and the barcode it holds.
        await ok(as('/v1/catalogue/products/P-ENERGY-OLD/publish', { product: {
          sku: 'ENERGY-OLD', name: NAME, brand: 'Synthetic', baseUom: 'ea', primaryCategoryId: 'drinks', taxClass: '22029920', lifecycle: 'active',
          mrpHistory: [{ value: { minor: 12_500, currency: 'INR' }, effectiveFrom: '2026-01-01' }], safety: { allergens: [], countryOfOrigin: 'India' },
        } }, 'pub-old'), 'look-alike');
        await ok(as(`/v1/catalogue/products/P-ENERGY-OLD/barcodes/${HELD_ELSEWHERE}`, { kind: 'ean' }, 'bc-old'), 'its barcode');
        await ok(as('/v1/prices/list/P-ENERGY-OLD/entries/e1', { scope: 'store', scopeRef: STORE, priceMinor: 11_500, mrpMinor: 12_500, costMinor: 7_000, marginFloorBps: 1_000, currency: 'INR', effectiveFrom: today }, 'price-old'), 'its price');
        // A draft jam someone started (incomplete — kept as a draft by head office), already given a price: never sent.
        await ok(as('/v1/catalogue/products/P-DRAFT-JAM/publish', { product: { sku: 'JAM-200', name: 'Synthetic mango jam 200 g', baseUom: 'ea', primaryCategoryId: 'drinks', taxClass: '20079910', lifecycle: 'draft' } }, 'pub-jam'), 'draft jam');
        await ok(as('/v1/prices/list/P-DRAFT-JAM/entries/e1', { scope: 'store', scopeRef: STORE, priceMinor: 9_000, mrpMinor: 10_000, costMinor: 6_000, marginFloorBps: 1_000, currency: 'INR', effectiveFrom: today }, 'price-jam'), 'jam price');
        await ok(as('/v1/prices/zones/coast/stores/br-1', {}, 'zone'), 'store group');
      },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 300_000);
  afterAll(async () => {
    for (const stop of stops.splice(0).reverse()) await stop().catch(() => {});
    await browser?.close(); await shop?.stop();
  });

  /** The accountant, on her own Approvals page in her own browser: the waiting request of this kind, approved with a reason. */
  const accountantApproves = async (kind: string, subjectRef: string): Promise<void> => {
    const inbox = (await shop.call('GET', '/v1/approvals/requests', ACCT)).body as { waitingForMe: { requestId: string; kind: string; subjectRef: string }[] };
    const waiting = inbox.waitingForMe.find((r) => r.kind === kind && r.subjectRef === subjectRef);
    expect(waiting, `${kind} ${subjectRef} waits for the accountant`).toBeDefined();
    const a = await shop.open(ACCT, '/approvals');
    const row = a.page.locator(`#waiting li[data-request-id="${waiting!.requestId}"]`);
    await row.waitFor({ timeout: 15_000 });
    await row.locator('input.reason').fill('age limit checked on the pack (synthetic)');
    await row.locator('button.approve').click();
    await row.waitFor({ state: 'detached', timeout: 15_000 });
    expect(a.errors).toEqual([]);
    await a.close();
  };

  it('a real draft → duplicate/GS1 check → tax/UOM/pack/content → the accountant approves the age limit → assortment → price → sent to the tills → the till rings it and the app finds it', async () => {
    // ── 1. DRAFT: incomplete, kept by head office as a draft, with what it still needs ─────────────────────────────────
    const o = await shop.open(OWNER, `/product-details/?product=${P}`);
    expect(o.status).toBe(200);
    await says(o.page, '#result', /^Head office has no product with this id yet\./);
    await o.page.fill('#r-name', NAME);
    await o.page.fill('#r-sku', 'ENERGY-250');
    await o.page.selectOption('#r-baseUom', 'ea');
    await o.page.selectOption('#r-category', 'drinks');
    await o.page.fill('#r-brand', 'Synthetic');
    await o.page.fill('#r-taxClass', '22029920');
    await o.page.selectOption('#r-lifecycle', 'draft');
    await o.page.fill('#m-from', today); await o.page.fill('#m-rupees', '125');
    await o.page.click('#save');
    await says(o.page, '#record-status', /^Kept as a draft — not on sale and not in any pack\. Before it can go on sale it still needs: .*allergen.*country of origin/);
    await says(o.page, '#v-state', /^Draft — not on sale$/);
    expect((await product()).product).toMatchObject({ name: NAME, baseUom: 'ea', primaryCategoryId: 'drinks', taxClass: '22029920', lifecycle: 'draft' });

    // ── 2. DUPLICATE / GS1 CHECK ─────────────────────────────────────────────────────────────────────────────────────
    await o.page.click('#tab-codes');
    await o.page.fill('#b-code', BAD_CHECK_DIGIT); await o.page.selectOption('#b-kind', 'ean');
    await o.page.click('#add-barcode');
    await says(o.page, '#codes-status', /^Head office refused: .*check digit/i);
    await o.page.fill('#b-code', HELD_ELSEWHERE);
    await o.page.click('#add-barcode');
    await says(o.page, '#codes-status', /^Head office refused: .*P-ENERGY-OLD/);
    await o.page.fill('#b-code', EAN);
    await o.page.click('#add-barcode');
    await o.page.locator(`#barcode-list li[data-code="${EAN}"]`).waitFor();
    expect((await shop.call('GET', `/v1/catalogue/barcodes/${EAN}`, OWNER)).body).toMatchObject({ barcode: { productId: P } });
    expect((await shop.call('GET', `/v1/catalogue/barcodes/${HELD_ELSEWHERE}`, OWNER)).body).toMatchObject({ barcode: { productId: 'P-ENERGY-OLD' } });

    // ── 3. TAX / UOM / PACK / CONTENT ────────────────────────────────────────────────────────────────────────────────
    await o.page.fill('#pk-level-0', 'ea'); await o.page.fill('#pk-count-0', '1');
    await o.page.fill('#pk-level-1', 'case'); await o.page.fill('#pk-count-1', '24');
    await o.page.click('#save-pack');
    await says(o.page, '#codes-status', /^Saved\.$/);
    await o.page.fill('#cv-qty', '2'); await o.page.selectOption('#cv-level', 'case');
    await o.page.click('#convert');
    await says(o.page, '#codes-status', /^2 case = 48 ea$/);
    await o.page.click('#tab-record');
    await o.page.fill('#s-ingredients', 'Carbonated water, sugar, caffeine');
    await o.page.check('#s-none');
    await o.page.fill('#s-origin', 'India');
    await o.page.fill('#s-storage', 'Store in a cool, dry place');
    await o.page.fill('#s-minage', '18');
    await o.page.fill('#s-why', 'label read off the can (synthetic)');
    await o.page.click('#save-safety');
    await says(o.page, '#safety-status', /^Saved — version \d+\.$/);
    expect((await product()).product).toMatchObject({ lifecycle: 'draft', safety: { allergens: [], countryOfOrigin: 'India', minimumAge: 18 } });

    const content = await shop.open(OWNER, `/product-content?product=${P}`);
    expect(content.status).toBe(200);
    await content.page.locator('#score').waitFor({ timeout: 15_000 });
    await content.page.fill('#c-nameTa', 'செயற்கை ஆற்றல் பானம் 250 மி.லி');
    await content.page.fill('#c-descriptionEn', 'A sparkling energy drink (synthetic). 18 and over only.');
    await content.page.fill('#c-descriptionTa', 'மின்னும் ஆற்றல் பானம் (மாதிரி). 18 வயது மற்றும் அதற்கு மேல் மட்டும்.');
    await content.page.fill('#c-synonyms', 'power drink, energy');
    await content.page.fill('#c-reason', 'app launch copy (synthetic)');
    await content.page.click('#save');
    await content.page.locator('#history .row[data-version="1"]').waitFor({ timeout: 15_000 });
    expect((await product()).product.appContent?.synonyms).toEqual(['power drink', 'energy']);
    expect(content.errors).toEqual([]);
    await content.close();

    const dupes = await shop.open(MGR, '/product-merges/');
    await dupes.page.locator('#pairs li', { hasText: NAME }).first().waitFor({ timeout: 15_000 });
    // Looking for look-alikes is a read (head office's duplicate check); nothing is proposed or merged.
    expect(dupes.writes.filter((w) => w !== 'POST /v1/catalogue/products/duplicates')).toEqual([]);
    await dupes.close();

    // ── 4. APPROVAL (OB-546): an age limit needs a second person before it reaches the tills ─────────────────────────────
    await o.page.reload({ waitUntil: 'load' });
    await says(o.page, '#v-state', /^Draft — not on sale$/);
    await o.page.selectOption('#r-lifecycle', 'active');
    await o.page.fill('#r-why', 'ready for the shelf (synthetic)');
    await o.page.click('#save');
    await says(o.page, '#record-status', /^This needs a second person: .*minimum age/);
    await o.page.click('#ask-approval');
    await says(o.page, '#record-status', /^Asked\./);
    await o.page.click('#save');
    await says(o.page, '#record-status', /^Still waiting for the second person/);
    expect((await product()).product.lifecycle).toBe('draft');
    await accountantApproves('regulated_product_publish', `product:${P}`);
    await o.page.click('#save');
    await says(o.page, '#record-status', new RegExp(`^Saved with the approval of ${ACCT}\\.$`));
    await says(o.page, '#v-state', /^On sale$/);
    expect((await product()).product.lifecycle).toBe('active');
    expect(o.errors).toEqual([]);
    await o.close();

    // The first stock arrives by WF-04 receiving (laid here through the API) — it gives the price a buying cost.
    await ok(shop.call('POST', '/v1/inventory/movements', OWNER, { movementId: 'rx-energy', productId: P, locationId: STORE, kind: 'received', quantityMinor: 48, uom: 'EA', occurredAt: new Date(Date.now() - 3_600_000).toISOString(), enteredBy: OWNER, unitCostMinor: 7_000 }), 'receive');

    // ── 5. ASSORTMENT ────────────────────────────────────────────────────────────────────────────────────────────────
    const range = await shop.open(MGR, '/range-clusters');
    expect(range.status).toBe(200);
    await range.page.locator('#r-zone option[value="coast"]').waitFor({ state: 'attached', timeout: 15_000 });
    await range.page.selectOption('#r-zone', 'coast'); await range.page.fill('#r-product', P); await range.page.fill('#r-from', today);
    await range.page.selectOption('#r-action', 'list');
    await range.page.click('#range-go');
    await says(range.page, '#range-status', new RegExp(`^Carried in 1 store\\(s\\) from ${today}`));
    expect(JSON.stringify((await shop.call('GET', `/v1/merchandising/assortment/${STORE}`, MGR)).body)).toContain(P);
    expect(range.errors).toEqual([]);
    await range.close();

    // ── 6. PRICE ─────────────────────────────────────────────────────────────────────────────────────────────────────
    const price = await shop.open(MGR, `/price-lists/?product=${P}`);
    expect(price.status).toBe(200);
    await price.page.fill('#p-ref', STORE);
    await price.page.fill('#p-from', `${today.slice(8, 10)}/${today.slice(5, 7)}/${today.slice(0, 4)}`); // U2: the shop's dd/mm/yyyy field; ISO sits behind it
    await price.page.click('#read-basis');
    await says(price.page, '#v-mrp', /^₹125\.00$/);
    await says(price.page, '#v-cost', /^₹70\.00$/);
    await says(price.page, '#v-floor', /^10\.00%$/);
    await says(price.page, '#v-now', /^none yet$/);
    await price.page.fill('#p-price', '110');
    await price.page.click('#save');
    await says(price.page, '#price-status', new RegExp(`^Saved\\. ₹110\\.00 from ${today}`));
    // The manager may look at the pack but not send it (its own permission).
    await price.page.click('#tab-pack');
    expect(await price.page.isDisabled('#pk-publish')).toBe(true);
    await says(price.page, '#pk-note', /^Only someone who keeps the catalogue may send a pack\./);
    expect(price.errors).toEqual([]);
    await price.close();

    // ── 7. SHELF / POS / APP: the owner sends the pack from the Price lists page ────────────────────────────────────────
    const send = await shop.open(OWNER, '/price-lists/');
    await send.page.click('#tab-pack');
    await send.page.fill('#pk-store', STORE);
    await send.page.fill('#pk-asof', today);
    await send.page.click('#pk-preview');
    await says(send.page, '#pk-status', new RegExp(`^2 product\\(s\\) would go to the tills of ${STORE} as of ${today}\\.$`));
    await says(send.page, '#pk-left', /P-DRAFT-JAM — a draft, not on sale/);
    expect(send.writes).toEqual([]);
    await send.page.click('#pk-publish');
    await says(send.page, '#pk-status', /^Sent\. Catalogue pack version \d+ is signed; each store computer takes it on its next pull\.$/);
    expect(send.writes).toEqual(['POST /v1/catalogue/pack']);
    await send.page.click('#lang');
    await says(send.page, '#pack-h', /^கவுண்டர்களுக்கு அனுப்பு$/);
    expect(send.errors).toEqual([]);
    await send.close();
    const pack = (await shop.call('GET', '/v1/catalogue/pack', OWNER)).body as { snapshot: { version: number; products: { productId: string; unitPriceMinor: number; regulatedFlags?: { minimumAge?: number } }[] } };
    expect(pack.snapshot.products.find((p) => p.productId === P)).toMatchObject({ unitPriceMinor: 11_000, regulatedFlags: { minimumAge: 18 } });
    expect(pack.snapshot.products.map((p) => p.productId)).not.toContain('P-DRAFT-JAM');

    // The till box pulls it; the served till asks the age question, then rings the EAN at ₹110.00 from the pack on its disk.
    const tillDir = await mkdtemp(join(tmpdir(), 'sre-w4-wf01-till-'));
    stops.push(() => rm(tillDir, { recursive: true, force: true }));
    const { EDGE_PACK_FILE: packFile } = await prepareTillBox({
      dir: tillDir, key: shop.cloud.packSigningKey, people: [{ userId: CASHIER, displayName: 'Meena' }],
      pack: { policies: { storeId: STORE, branchId: STORE, branchName: 'SRE Hyper Market', warehouseId: STORE, tradingDayCutoff: '00:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 0 }, lossPreventionRules: [] },
    });
    const till: EdgeProcess = (await startEdge({
      EDGE_DATA_DIR: tillDir, EDGE_TENANT_ID: shop.tenantId, PACK_SIGNING_KEY: shop.cloud.packSigningKey, EDGE_CAPACITY_BYTES: '10485760',
      EDGE_LANE_PORT: '0', EDGE_LANE_ID: 'lane-1', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_PACK_FILE: packFile!,
      CLOUD_API_URL: shop.cloud.baseUrl, CLOUD_API_TOKEN: shop.cloud.token(BOX),
    }, () => {}))!;
    stops.push(() => till.stop());
    expect(await till.refreshPack!()).toMatchObject({ status: 'updated', heldVersion: pack.snapshot.version });
    const tctx = await browser.newContext();
    stops.push(() => tctx.close());
    const tp = await tctx.newPage();
    const tillErrors: string[] = [];
    tp.on('pageerror', (e) => tillErrors.push(e.message));
    await tp.goto(`http://127.0.0.1:${till.screens!.port}/pos/`, { waitUntil: 'load' });
    await tp.waitForFunction(() => { const w = globalThis as unknown as PosWindow; return w.posSession !== undefined && w.posSession.hasCatalogue(); }, undefined, { timeout: 15_000 });
    expect(await tp.evaluate(() => { const c = (globalThis as unknown as PosWindow).posCatalogue!; return { version: c.version, source: c.source }; })).toEqual({ version: pack.snapshot.version, source: 'head_office' });
    await signInThroughScreen(tp, CASHIER);
    await tp.keyboard.type(EAN);
    await tp.keyboard.press('Enter');
    await tp.waitForFunction(() => !((globalThis as unknown as Doc).document.querySelector('#pay')?.hidden ?? true), undefined, { timeout: 15_000 });
    expect(await tp.textContent('#pay-title')).toBe(`${NAME} is age restricted. Check the customer's identification. Is the customer 18 or over?`);
    expect(await tp.evaluate(() => (globalThis as unknown as PosWindow).posSession!.basket().length), 'not on the bill while the question is open').toBe(0);
    await tp.click('#pay-kinds button:nth-child(1)'); // Yes — ID checked, 18 or over
    await tp.waitForSelector('#lines tr');
    await expect.poll(() => tp.textContent('#total'), { timeout: 10_000 }).toBe('₹110.00');
    expect(tillErrors).toEqual([]);

    // The customer box takes head office's store setup and serves the app, which finds the drink by a customer's word.
    const appDir = await mkdtemp(join(tmpdir(), 'sre-w4-wf01-app-'));
    stops.push(() => rm(appDir, { recursive: true, force: true }));
    const appBox: EdgeProcess = (await startEdge({
      EDGE_DATA_DIR: appDir, EDGE_TENANT_ID: shop.tenantId, PACK_SIGNING_KEY: shop.cloud.packSigningKey, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0',
      CLOUD_API_URL: shop.cloud.baseUrl, CLOUD_API_TOKEN: shop.cloud.token(BOX),
      EDGE_STORE_PACK_SOURCE: 'head-office', EDGE_STORE_ID: STORE, EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps',
    }, () => {}))!;
    stops.push(() => appBox.stop());
    expect((await appBox.refreshStorePack!()).status).toBe('updated');
    const actx = await browser.newContext();
    stops.push(() => actx.close());
    const ap = await actx.newPage();
    const appErrors: string[] = [];
    ap.on('pageerror', (e) => appErrors.push(e.message));
    await ap.goto(`http://127.0.0.1:${appBox.screens!.port}/customer`, { waitUntil: 'load' });
    await ap.waitForFunction(() => (globalThis as unknown as { document: { getElementById(id: string): { hidden: boolean } | null } }).document.getElementById('sample')?.hidden === true, undefined, { timeout: 15_000 });
    await ap.fill('#search', 'power');
    const row = ap.locator('#results .row', { hasText: NAME });
    await row.first().waitFor({ timeout: 10_000 });
    expect(await row.first().locator('.price').textContent()).toBe('₹110.00');
    expect(await ap.locator('#results .row', { hasText: 'mango jam' }).count(), 'the draft is never in the app').toBe(0);
    expect(appErrors).toEqual([]);
  }, 300_000);
});
