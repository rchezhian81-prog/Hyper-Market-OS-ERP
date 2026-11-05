import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { auditPage } from './lib/a11y-audit';
import { startOfficeShop, PEOPLE, S1, type OfficeShop } from './lib/office-shop';
import { confirmIt, sheetOpens } from './lib/confirm-sheet';
import { approveSupplierWith, SUPPLIER_MAKER, SUPPLIER_CHECKER } from '../support/approved-supplier';

/**
 * **U2 · G5 of the UI/UX gap audit (2 Nov 2026): on the five HARD buying and stock pages a thing is PICKED by name, never
 * typed as a code — on the REAL store computer fed by the REAL head office (P-07 · NFR-13 · P-01 · P-08).**
 *
 *   • Buying: the supplier and the item are found by three letters of their NAME in the chrome's picker; the pick fills
 *     the page's own field with the id and names it beside; "Deliver to store" is already the person's store; the order
 *     head office receives carries exactly those ids. With head office down the picker says so and "type the code
 *     instead" fills the same field — never a dead end.
 *   • Count plans: the place comes from the store computer's own directory (the signed pack — it works with head office
 *     down); products are added one at a time by name, each with Remove; the plan sent carries the ids.
 *   • Store events: the store is filled in; the typed effect is said in words ("50% higher than usual"); the products
 *     chosen by name ride in the event.
 *   • Scrap: the branch is filled in; the two days are shop dates (dd/mm/yyyy): 31/02 is refused beside the field,
 *     31/10/2026 is sent as 2026-10-31.
 *   • Packaging: the branch is filled in and can be picked by the store's name.
 *   • The audit (contrast, 44px targets, names, labels, one h1, no sideways scroll) stays clean on each page with the
 *     picker open, in English and after the Tamil toggle.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DESK = { viewport: { width: 1280, height: 860 } };

const rowsShown = (page: Page): Promise<string[]> => page.$$eval('#sre-picker-list .sre-picker-name', (els) => els.map((e) => (e.textContent ?? '').trim()));
async function pickByName(page: Page, pickButton: string, letters: string, expectName: RegExp): Promise<void> {
  await page.click(pickButton);
  await page.waitForSelector('#sre-picker');
  await page.fill('#sre-picker-q', letters);
  await page.waitForFunction(() => (globalThis as unknown as { document: { querySelectorAll(s: string): { length: number } } }).document.querySelectorAll('#sre-picker-list .sre-picker-row').length >= 1);
  const names = await rowsShown(page);
  expect(names.some((n) => expectName.test(n)), `no row for ${expectName} among ${JSON.stringify(names)}`).toBe(true);
  const row = page.locator('#sre-picker-list .sre-picker-row', { hasText: expectName }).first();
  await row.click();
  await page.waitForSelector('#sre-picker', { state: 'detached' });
}
/** Every call the page made to head office (method, path, query, body), through the harness's route. */
function writes(page: Page): { readonly all: () => { method: string; path: string; search: string; body: unknown }[] } {
  const all: { method: string; path: string; search: string; body: unknown }[] = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (!u.pathname.startsWith('/v1/')) return;
    all.push({ method: r.method(), path: u.pathname, search: u.search, body: r.postData() === null ? null : JSON.parse(r.postData()!) as unknown });
  });
  return { all: () => all };
}

describe.skipIf(!existsSync(CHROMIUM))('U2: the buying and stock pages pick by name', () => {
  let browser: Browser;
  let shop: OfficeShop;
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
    shop = await startOfficeShop(browser, {
      seed: async (ok, h, T) => {
        // A second product and an APPROVED supplier (two different people, the real routes), so an order can be raised.
        await ok('/v1/catalogue/products/p-dal/publish', PEOPLE.owner, {
          product: { sku: 'DAL-1KG', name: 'Toor dal 1kg', baseUom: 'ea', primaryCategoryId: 'grocery', taxClass: '0401', lifecycle: 'active' },
          categories: [{ categoryId: 'grocery', name: 'Grocery', parentId: null }],
        });
        await h.provisionRole(T, SUPPLIER_MAKER, 'store_manager');
        await h.provisionRole(T, SUPPLIER_CHECKER, 'accountant');
        await approveSupplierWith((method, path, userId, body, idempotencyKey) => h.request({ method, path, userId, tenantId: T, body, idempotencyKey }), 'SUP-1', 'Aavin Dairy');
      },
    });
  }, 300_000);
  afterAll(async () => { await shop?.stop(); await browser?.close(); });

  const open = async (who: string, path: string) => {
    const s = await shop.asPerson(who, DESK as never);
    const sent = writes(s.page);
    await s.page.goto(`${shop.base}${path}`, { waitUntil: 'load' });
    await s.page.waitForFunction('globalThis.sreOffice !== undefined && typeof globalThis.sreOffice.pick === "function"');
    return { ...s, sent };
  };

  it('Buying: the supplier and the item by name, the store already filled in, the order carries the ids; with head office down the code is typed instead', async () => {
    const { page, errors, sent, context } = await open(PEOPLE.manager, '/buying/?tab=po');
    await page.waitForSelector('#view-po:not([hidden])');
    // the person's own store, from the store computer's directory, before anything is typed
    expect(await page.inputValue('#po-store')).toBe(S1);
    expect(await page.textContent('#po-supplier-pick')).toBe('Choose…');
    await pickByName(page, '#po-supplier-pick', 'aav', /Aavin Dairy/);
    expect(await page.inputValue('#po-supplier')).toBe('SUP-1');
    expect(await page.textContent('#po-supplier-name')).toBe('Aavin Dairy (SUP-1)');
    await pickByName(page, '#po-product-pick', 'dal', /Toor dal/);
    expect(await page.inputValue('#po-product')).toBe('p-dal');
    expect(await page.textContent('#po-product-name')).toBe('Toor dal 1kg (p-dal)');
    expect(await page.textContent('#po-product-label')).toBe('Item');
    await page.fill('#po-qty', '4');
    await page.fill('#po-cost', '150');
    await page.click('#add-po-line');
    await page.click('#raise-po');
    await page.waitForFunction(() => /PO-/.test((globalThis as unknown as { document: { body: { innerText: string } } }).document.body.innerText));
    const order = sent.all().find((w) => w.method === 'POST' && w.path.startsWith('/v1/purchase/orders/'));
    expect(order, 'the order reached head office').toBeDefined();
    const body = order!.body as { supplierId: string; deliverToLocationId: string; lines: { productId: string }[] };
    expect(body.supplierId).toBe('SUP-1');
    expect(body.deliverToLocationId).toBe(S1);
    expect(body.lines.map((l) => l.productId)).toEqual(['p-dal']);
    await page.click('#banner-ok'); // the "order proposed" banner is acknowledged before anything else is tapped
    // the audit stays clean with the picker open, in English and in Tamil
    await page.click('#po-product-pick');
    await page.waitForSelector('#sre-picker');
    expect(await auditPage(page)).toEqual([]);
    await page.click('#sre-picker-back');
    await page.click('#lang');
    expect(await page.textContent('#po-product-pick')).toBe('தேர்ந்தெடு…');
    expect(await page.textContent('#po-product-label')).toBe('பொருள்');
    await page.click('#po-product-pick');
    await page.waitForSelector('#sre-picker');
    expect(await auditPage(page, { expectLang: 'ta' })).toEqual([]);
    await page.click('#sre-picker-back');
    await page.click('#lang');
    expect(errors).toEqual([]);
    await context.close();
    // head office down (a fresh page, so no list is cached): the sheet says the list cannot be read, and the code typed
    // fills the same field — never a dead end
    const down = await shop.asPerson(PEOPLE.manager, DESK as never);
    await down.context.route('**/v1/catalogue/**', (route) => route.abort());
    await down.page.goto(`${shop.base}/buying/?tab=po`, { waitUntil: 'load' });
    await down.page.waitForFunction('globalThis.sreOffice !== undefined && typeof globalThis.sreOffice.pick === "function"');
    await down.page.waitForSelector('#view-po:not([hidden])');
    await down.page.click('#po-product-pick');
    await down.page.waitForSelector('#sre-picker');
    await down.page.waitForSelector('#sre-picker-typed', { state: 'visible' });
    await down.page.fill('#sre-picker-typed', 'p-milk');
    await down.page.click('#sre-picker-use-code');
    await down.page.waitForSelector('#sre-picker', { state: 'detached' });
    expect(await down.page.inputValue('#po-product')).toBe('p-milk');
    expect(down.errors).toEqual([]);
    await down.context.close();
  }, 120_000);

  it('Count plans: the place from the store computer\'s directory, products one by one with Remove, the plan carries the ids', async () => {
    const { page, errors, sent, context } = await open(PEOPLE.manager, '/count-plans');
    await page.waitForSelector('#new-section:not([hidden])');
    expect(await page.textContent('#l-place')).toBe('Place');
    await pickByName(page, '#place-pick', 'back', /S1-BACK/);
    expect(await page.inputValue('#place')).toBe('S1-BACK');
    await page.click('#add-product');
    await page.waitForSelector('#sre-picker');
    await page.fill('#sre-picker-q', 'dal');
    await page.locator('#sre-picker-list .sre-picker-row', { hasText: /Toor dal/ }).first().click();
    await page.waitForSelector('#sre-picker', { state: 'detached' });
    await page.click('#add-product');
    await page.waitForSelector('#sre-picker');
    await page.fill('#sre-picker-q', 'milk');
    await page.locator('#sre-picker-list .sre-picker-row', { hasText: /Toned milk/ }).first().click();
    await page.waitForSelector('#sre-picker', { state: 'detached' });
    expect(await page.$$eval('#product-list li[data-product]', (els) => els.map((e) => (e as { dataset: { product: string } }).dataset.product))).toEqual(['p-dal', 'p-milk']);
    expect(await page.textContent('#product-list li[data-product="p-dal"] span')).toBe('Toor dal 1kg (p-dal)');
    await page.click('#product-list li[data-product="p-dal"] button');
    expect(await page.$$eval('#product-list li[data-product]', (els) => els.length)).toBe(1);
    await page.fill('#threshold', '20');
    await page.click('#create');
    await page.waitForFunction(() => (globalThis as unknown as { document: { querySelector(s: string): { textContent: string } } }).document.querySelector('#create-status').textContent.trim() !== '');
    const plan = sent.all().find((w) => w.method === 'POST' && /^\/v1\/inventory\/count-plans\/[^/]+$/.test(w.path));
    expect(plan, `the plan reached head office; status: ${await page.textContent('#create-status')}`).toBeDefined();
    const body = plan!.body as { locationId: string; productIds: string[] };
    expect(body.locationId).toBe('S1-BACK');
    expect(body.productIds).toEqual(['p-milk']);
    expect(errors).toEqual([]);
    await context.close();
  }, 120_000);

  it('Store events: the store filled in, the effect said in words, the products chosen by name ride in the event', async () => {
    const { page, errors, sent, context } = await open(PEOPLE.manager, '/demand-events');
    expect(await page.inputValue('#store')).toBe(S1);
    await page.fill('#effect', '1.5');
    expect(await page.textContent('#effect-words')).toBe('That means orders 50% higher than usual.');
    await page.fill('#effect', '0.8');
    expect(await page.textContent('#effect-words')).toBe('That means orders 20% lower than usual.');
    await page.fill('#effect', '1.5');
    await page.click('#add-product');
    await page.waitForSelector('#sre-picker');
    await page.fill('#sre-picker-q', 'dal');
    await page.locator('#sre-picker-list .sre-picker-row', { hasText: /Toor dal/ }).first().click();
    await page.waitForSelector('#sre-picker', { state: 'detached' });
    expect(await page.textContent('#product-list li[data-product="p-dal"] span')).toBe('Toor dal 1kg (p-dal)');
    await page.fill('#label', 'Pongal');
    await page.fill('#ev-from', '20/11/2026'); // the shared date field (U2b): dd/mm/yyyy in, ISO sent
    await page.fill('#ev-to', '22/11/2026');
    await page.click('#save');
    // OB-626: the sheet names the product by its NAME, then Confirm sends once
    expect(await sheetOpens(page)).toMatch(/Toor dal 1kg/);
    await confirmIt(page);
    await page.waitForFunction(() => (globalThis as unknown as { document: { querySelector(s: string): { textContent: string } } }).document.querySelector('#record-status').textContent.trim() !== '');
    const event = sent.all().find((w) => w.method === 'POST' && /^\/v1\/inventory\/demand-events\/[^/]+$/.test(w.path));
    expect(event, `the event reached head office; status: ${await page.textContent('#record-status')}`).toBeDefined();
    expect(JSON.stringify(event!.body)).toContain('p-dal');
    expect((event!.body as { storeId: string }).storeId).toBe(S1);
    expect(errors).toEqual([]);
    await context.close();
  }, 120_000);

  it('Scrap and Packaging: the branch filled in and picked by the store\'s name; a shop date refused at 31/02 and sent as ISO', async () => {
    const scrap = await open(PEOPLE.accountant, '/scrap');
    await scrap.page.waitForSelector('#record:not([hidden])');
    expect(await scrap.page.inputValue('#s-branch')).toBe(S1);
    expect(await scrap.page.inputValue('#v-branch')).toBe(S1);
    expect(await scrap.page.textContent('#s-branch-l')).toBe('Branch');
    await pickByName(scrap.page, '#v-branch-pick', 'hyper', /SRE Hyper Market/);
    expect(await scrap.page.inputValue('#v-branch')).toBe(S1);
    // the review's days are shop dates
    expect(await scrap.page.getAttribute('#v-from', 'placeholder')).toBe('dd/mm/yyyy');
    await scrap.page.fill('#v-from', '31/02/2026');
    await scrap.page.dispatchEvent('#v-from', 'blur');
    expect(await scrap.page.getAttribute('#v-from', 'aria-invalid')).toBe('true');
    await scrap.page.fill('#v-from', '31/10/2026');
    await scrap.page.fill('#v-to', '31/10/2026');
    await scrap.page.click('#v-show');
    await scrap.page.waitForFunction(() => /2026|முடிய|Nothing|இல்லை|Not known|தெரியவில்லை|Head office|தலைமை/.test((globalThis as unknown as { document: { body: { innerText: string } } }).document.body.innerText));
    const review = scrap.sent.all().find((w) => w.method === 'GET' && w.path.startsWith('/v1/scrap'));
    expect(review, 'the review was asked of head office').toBeDefined();
    expect(`${review!.path}${review!.search}`).toContain('2026-10-31');
    expect(`${review!.path}${review!.search}`).toContain(S1);
    expect(scrap.errors).toEqual([]);
    await scrap.context.close();

    const pack = await open(PEOPLE.manager, '/packaging');
    await pack.page.waitForSelector('#move:not([hidden])');
    expect(await pack.page.inputValue('#m-branch')).toBe(S1);
    expect(await pack.page.inputValue('#q-branch')).toBe(S1);
    await pack.page.fill('#q-branch', '');
    await pickByName(pack.page, '#q-branch-pick', 'hyper', /SRE Hyper Market/);
    expect(await pack.page.inputValue('#q-branch')).toBe(S1);
    expect(await pack.page.textContent('#q-branch-name')).toBe(`SRE Hyper Market (${S1})`);
    expect(await auditPage(pack.page)).toEqual([]);
    expect(pack.errors).toEqual([]);
    await pack.context.close();
  }, 120_000);
});
