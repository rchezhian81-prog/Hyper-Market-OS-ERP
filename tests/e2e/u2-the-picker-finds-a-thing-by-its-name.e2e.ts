import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { auditPage } from './lib/a11y-audit';
import { startOfficeShop, PEOPLE, type OfficeShop } from './lib/office-shop';

/**
 * **The picker, the date field, a name for an id and who is looking (U2 · UI/UX gap audit G5 · G14 · G16 · P-07 ·
 * P-01 · P-08), on a real office page on the REAL store computer fed by the REAL head office.**
 *
 *   • a product is found by three letters of its NAME and by its BARCODE; a supplier by its name;
 *   • a colleague is found from the signed pack with head office DOWN (every `/v1` read cut), by name;
 *   • a place (the store) is listed from the pack; the person's store and name are known to the page (`me`, `nameOf`);
 *   • a list the person may not read is said as "cannot open" and, where the page allows, "type the code instead" works —
 *     never a dead end; Escape answers `{ ok: false }`; the last pick is offered first next time;
 *   • the date field refuses 31/02 beside the field and sends ISO for 31/10/2026; `dateWords` reads in both languages;
 *   • `refusalWords` gives the three parts in the reader's language from the one source;
 *   • the audit (contrast, 44px targets, names, labels, one h1, no sideways scroll) is clean with the picker open at a desk
 *     and on a phone, in English and Tamil.
 * Skips where no browser binary is present.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DESK = { viewport: { width: 1280, height: 860 } };
const PHONE = { viewport: { width: 360, height: 640 }, hasTouch: true, isMobile: true };
const BARCODE = '8901234567890';
const KAVITHA = 'u-kavitha';
const RAVI = 'u-ravi';

type Picked = { ok: boolean; id?: string; name?: string; code?: string; typed?: boolean };

async function pick(page: Page, spec: unknown): Promise<void> {
  await page.evaluate((s) => {
    const w = globalThis as unknown as { sreOffice: { pick(spec: unknown): Promise<unknown> }; __picked?: unknown };
    w.__picked = undefined;
    void w.sreOffice.pick(s).then((a) => { w.__picked = a; });
  }, spec);
  await page.waitForSelector('#sre-picker');
}
const picked = (page: Page): Promise<Picked> => page.waitForFunction(() => (globalThis as unknown as { __picked?: unknown }).__picked !== undefined).then(() => page.evaluate(() => (globalThis as unknown as { __picked?: unknown }).__picked as Picked));
const rows = (page: Page): Promise<string[]> => page.$$eval('#sre-picker-list .sre-picker-name', (els) => els.map((e) => (e.textContent ?? '').trim()));
const toggle = (page: Page): Promise<void> => page.evaluate(() => { (globalThis as unknown as { document: { getElementById(id: string): { click(): void } } }).document.getElementById('lang').click(); });
const focused = (page: Page): Promise<string> => page.evaluate(() => (globalThis as unknown as { document: { activeElement: { id: string } | null } }).document.activeElement?.id ?? '');

describe.skipIf(!existsSync(CHROMIUM))('U2: the picker finds a thing by its name', () => {
  let browser: Browser;
  let shop: OfficeShop;
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
    shop = await startOfficeShop(browser, {
      // the identity server stands in: a sign-in is "issued" at once, so head office's ledger carries the person's name
      identityDirectory: { issue: async () => ({ result: 'issued', resumed: false }), end: async () => 'ended' },
      seed: async (ok, h, T) => {
        // A second product, a barcode on the milk, a supplier, and NAMES for the people (the platform administrator gives
        // sign-ins; the pack then carries the names) — all through the real routes.
        await ok('/v1/catalogue/products/p-dal/publish', PEOPLE.owner, {
          product: { sku: 'DAL-1KG', name: 'Toor dal 1kg', baseUom: 'ea', primaryCategoryId: 'grocery', taxClass: '0401', lifecycle: 'active' },
          categories: [{ categoryId: 'grocery', name: 'Grocery', parentId: null }],
        });
        await ok(`/v1/catalogue/products/p-milk/barcodes/${BARCODE}`, PEOPLE.owner, { kind: 'ean' });
        await ok('/v1/purchase/suppliers/SUP-1', PEOPLE.owner, { name: 'Aavin Dairy' });
        // A sign-in is given to a NEW person with no authority yet (then the role): two named colleagues for this store.
        await h.provisionRole(T, 'u-admin', 'platform_admin', 'all');
        await ok('/v1/identity/people', 'u-admin', { userId: KAVITHA, signInName: 'kavitha.r', displayName: 'Kavitha Rajan' });
        await ok('/v1/identity/people', 'u-admin', { userId: RAVI, signInName: 'ravi.k', displayName: 'Ravi Kumar' });
        await h.provisionRole(T, KAVITHA, 'cashier', ['S1']);
        await h.provisionRole(T, RAVI, 'store_manager', ['S1']);
      },
    });
  }, 300_000);
  afterAll(async () => { await shop?.stop(); await browser?.close(); });

  const open = async (who: string = PEOPLE.manager, device: Record<string, unknown> = DESK, path = '/customers') => {
    const s = await shop.asPerson(who, device as never);
    await s.page.goto(`${shop.base}${path}`, { waitUntil: 'load' });
    await s.page.waitForFunction('globalThis.sreOffice !== undefined && typeof globalThis.sreOffice.pick === "function"');
    return s;
  };

  it('a product by three letters of its name, then by its barcode; the focus starts in the search box; the last pick is offered first', async () => {
    const { context, page, errors } = await open();
    await pick(page, { kind: 'product', title: { en: 'Which product?', ta: 'எந்தப் பொருள்?' } });
    expect(await focused(page)).toBe('sre-picker-q');
    expect(await page.getAttribute('#sre-picker', 'role')).toBe('dialog');
    await page.waitForFunction(() => (globalThis as unknown as { document: { querySelectorAll(s: string): { length: number } } }).document.querySelectorAll('#sre-picker-list .sre-picker-row').length >= 2);
    expect((await rows(page)).sort()).toEqual(['Toned milk 500 ml', 'Toor dal 1kg']);
    await page.fill('#sre-picker-q', 'too');
    expect(await rows(page)).toEqual(['Toor dal 1kg']);
    expect(await page.locator('#sre-picker-count').innerText()).toBe('1 found');
    await page.click('#sre-picker-list .sre-picker-row');
    expect(await picked(page)).toMatchObject({ ok: true, id: 'p-dal', name: 'Toor dal 1kg', code: 'DAL-1KG' });
    expect(await page.locator('#sre-picker').count()).toBe(0);
    // by barcode: digits that match no name find the product through head office's own lookup
    await pick(page, { kind: 'product', title: { en: 'Which product?', ta: 'எந்தப் பொருள்?' } });
    // the empty search box shows the last pick first
    await page.waitForFunction(() => (globalThis as unknown as { document: { querySelector(s: string): { textContent: string } | null } }).document.querySelector('#sre-picker-count')?.textContent === 'Chosen recently on this computer');
    expect(await rows(page)).toEqual(['Toor dal 1kg']);
    await page.fill('#sre-picker-q', BARCODE);
    await page.waitForFunction(() => (globalThis as unknown as { document: { querySelectorAll(s: string): { length: number } } }).document.querySelectorAll('#sre-picker-list .sre-picker-row').length === 1);
    expect(await rows(page)).toEqual(['Toned milk 500 ml']);
    await page.keyboard.press('Enter');
    expect(await picked(page)).toMatchObject({ ok: true, id: 'p-milk', name: 'Toned milk 500 ml' });
    expect(errors).toEqual([]);
    await context.close();
  });

  it('a supplier by its name; Escape answers go back and the focus returns to where it was', async () => {
    const { context, page } = await open();
    await page.focus('#lang');
    await pick(page, { kind: 'supplier', title: { en: 'Which supplier?', ta: 'எந்த விநியோகஸ்தர்?' } });
    await page.fill('#sre-picker-q', 'aav');
    await page.waitForFunction(() => (globalThis as unknown as { document: { querySelectorAll(s: string): { length: number } } }).document.querySelectorAll('#sre-picker-list .sre-picker-row').length === 1);
    expect(await rows(page)).toEqual(['Aavin Dairy']);
    await page.keyboard.press('Escape');
    expect(await picked(page)).toEqual({ ok: false });
    expect(await page.locator('#sre-picker').count()).toBe(0);
    expect(await focused(page)).toBe('lang');
    await context.close();
  });

  it('a colleague and a place from the signed pack with head office DOWN; the page knows who is looking and their store', async () => {
    const { context, page } = await open(RAVI);
    await page.route('**/v1/**', (route) => route.abort()); // head office cut: nothing below may read it
    await pick(page, { kind: 'person', title: { en: 'Which person?', ta: 'யார்?' } });
    await page.fill('#sre-picker-q', 'kav');
    await page.waitForFunction(() => (globalThis as unknown as { document: { querySelectorAll(s: string): { length: number } } }).document.querySelectorAll('#sre-picker-list .sre-picker-row').length === 1);
    expect(await rows(page)).toEqual(['Kavitha Rajan']);
    await page.click('#sre-picker-list .sre-picker-row');
    expect(await picked(page)).toMatchObject({ ok: true, id: KAVITHA, name: 'Kavitha Rajan', code: 'cashier' });
    await pick(page, { kind: 'place', title: { en: 'Which place?', ta: 'எந்த இடம்?' } });
    await page.waitForFunction(() => (globalThis as unknown as { document: { querySelectorAll(s: string): { length: number } } }).document.querySelectorAll('#sre-picker-list .sre-picker-row').length >= 1);
    expect(await rows(page)).toContain('SRE Hyper Market');
    await page.keyboard.press('Escape');
    const who = await page.evaluate(() => {
      const o = (globalThis as unknown as { sreOffice: { me(): unknown; nameOf(k: string, id: string): string; dateWords(iso: string): string; refusalWords(out: unknown): string } }).sreOffice;
      return { me: o.me(), cashier: o.nameOf('person', 'u-kavitha'), unknown: o.nameOf('person', 'u-nobody'), store: o.nameOf('store', 'S1'), zone: o.nameOf('zone', 'Asia/Kolkata'), words: o.dateWords('2026-10-31'), refusal: o.refusalWords({ status: 404 }) };
    });
    expect(who.me).toMatchObject({ userId: RAVI, name: 'Ravi Kumar', storeId: 'S1', storeName: 'SRE Hyper Market', roleIds: ['store_manager'] });
    expect(who.cashier).toBe('Kavitha Rajan');
    expect(who.unknown).toBe('u-nobody'); // never blank, never invented
    expect(who.store).toBe('SRE Hyper Market');
    expect(who.zone).toBe('India time (Kolkata)');
    expect(who.words).toBe('31 Oct 2026');
    expect(who.refusal).toBe('Head office refused: head office does not know this record. Nothing was changed. Refresh the page and check the number.');
    await toggle(page);
    const ta = await page.evaluate(() => { const o = (globalThis as unknown as { sreOffice: { dateWords(iso: string): string; refusalWords(out: unknown): string } }).sreOffice; return { words: o.dateWords('2026-10-31'), refusal: o.refusalWords({ status: 403 }) }; });
    expect(ta.words).toBe('31 அக் 2026');
    expect(ta.refusal).toMatch(/^தலைமை அலுவலகம் மறுத்தது: /);
    expect(ta.refusal).not.toMatch(/[A-Za-z]{3,}/);
    await context.close();
  });

  it('a list the person may not read is said, and "type the code instead" is never a dead end', async () => {
    const { context, page } = await open(PEOPLE.cashier, DESK, '/approvals'); // a cashier may not read the supplier list (supplier.view)
    await pick(page, { kind: 'supplier', title: { en: 'Which supplier?', ta: 'எந்த விநியோகஸ்தர்?' }, allowCode: true });
    await page.waitForSelector('#sre-picker .sre-state[data-state="denied"]');
    expect(await page.locator('#sre-picker .sre-state strong').innerText()).toBe('Your role cannot open this');
    expect(await page.locator('#sre-picker-typed').isVisible()).toBe(true);
    await page.click('#sre-picker-use-code');
    expect(await page.locator('#sre-picker-typed-msg').innerText()).toBe('Fill in "Type the code instead".');
    await page.fill('#sre-picker-typed', 'SUP-9');
    await page.click('#sre-picker-use-code');
    expect(await picked(page)).toEqual({ ok: true, id: 'SUP-9', name: 'SUP-9', code: 'SUP-9', item: null, typed: true });
    // without allowCode the same refusal is a plain state and Go back is the only way on
    await pick(page, { kind: 'supplier', title: { en: 'Which supplier?', ta: 'எந்த விநியோகஸ்தர்?' } });
    await page.waitForSelector('#sre-picker .sre-state[data-state="denied"]');
    expect(await page.locator('#sre-picker-typed').isVisible()).toBe(false);
    await page.click('#sre-picker-back');
    expect(await picked(page)).toEqual({ ok: false });
    await context.close();
  });

  it('the pick field and the date field: "(required)" in words, a picked thing shown by name and sent by id, 31/02 refused beside the field, 31/10/2026 sent as ISO', async () => {
    const { context, page } = await open();
    await page.evaluate(() => {
      type El = { id: string; append(...nodes: unknown[]): void };
      const d = (globalThis as unknown as { document: { createElement(t: string): El; querySelector(s: string): El } }).document;
      const o = (globalThis as unknown as { sreOffice: { pickField(spec: unknown): unknown; dateField(spec: unknown): unknown } }).sreOffice;
      const form = d.createElement('form');
      form.id = 'u2-form';
      form.append(o.pickField({ id: 'u2-product', label: { en: 'Product', ta: 'பொருள்' }, kind: 'product', required: true }), o.dateField({ id: 'u2-when', label: { en: 'When', ta: 'எப்போது' }, required: true, min: '2026-01-01' }));
      d.querySelector('main').append(form);
    });
    expect((await page.locator('label[for="u2-product-shown"]').innerText()).replace(/\s+/g, ' ')).toBe('Product (required)');
    expect(await page.locator('#u2-when-hint').innerText()).toBe('Day / month / year, for example 31/10/2026');
    // an unfilled required pick field is caught by the shared check, with the message beside it
    expect(await page.evaluate(() => (globalThis as unknown as { sreOffice: { check(f: unknown): boolean }; document: { getElementById(id: string): unknown } }).sreOffice.check((globalThis as unknown as { document: { getElementById(id: string): unknown } }).document.getElementById('u2-form')))).toBe(false);
    expect(await page.locator('#u2-product-msg').innerText()).toBe('Fill in "Product".');
    await page.click('#u2-product-choose');
    await page.fill('#sre-picker-q', 'dal');
    await page.waitForFunction(() => (globalThis as unknown as { document: { querySelectorAll(s: string): { length: number } } }).document.querySelectorAll('#sre-picker-list .sre-picker-row').length === 1);
    await page.click('#sre-picker-list .sre-picker-row');
    expect(await page.inputValue('#u2-product-shown')).toBe('Toor dal 1kg (DAL-1KG)');
    expect(await page.evaluate(() => (globalThis as unknown as { sreOffice: { pickedValue(id: string): string | null } }).sreOffice.pickedValue('u2-product'))).toBe('p-dal');
    expect(await focused(page)).toBe('u2-product-choose');
    await page.fill('#u2-when', '31/02/2026');
    await page.dispatchEvent('#u2-when', 'blur');
    expect(await page.locator('#u2-when-msg').innerText()).toBe('That is not a real date. Write it as day/month/year, for example 31/10/2026.');
    expect(await page.evaluate(() => (globalThis as unknown as { sreOffice: { dateValue(id: string): string | null } }).sreOffice.dateValue('u2-when'))).toBeNull();
    await page.fill('#u2-when', '31/10/2026');
    expect(await page.evaluate(() => (globalThis as unknown as { sreOffice: { dateValue(id: string): string | null } }).sreOffice.dateValue('u2-when'))).toBe('2026-10-31');
    expect(await page.locator('#u2-when-msg').isVisible()).toBe(false);
    await page.fill('#u2-when', '31/12/2025');
    expect(await page.locator('#u2-when-msg').innerText()).toBe('That is before 1 Jan 2026.');
    await page.click('#u2-product-clear');
    expect(await page.evaluate(() => (globalThis as unknown as { sreOffice: { pickedValue(id: string): string | null } }).sreOffice.pickedValue('u2-product'))).toBeNull();
    await context.close();
  });

  it('the audit is clean with the picker open, at a desk and on a phone, in English and Tamil', async () => {
    for (const device of [DESK, PHONE]) {
      const { context, page, errors } = await open(PEOPLE.manager, device);
      await pick(page, { kind: 'product', title: { en: 'Which product?', ta: 'எந்தப் பொருள்?' }, allowCode: true });
      await page.waitForFunction(() => (globalThis as unknown as { document: { querySelectorAll(s: string): { length: number } } }).document.querySelectorAll('#sre-picker-list .sre-picker-row').length >= 1);
      expect(await auditPage(page, { expectLang: 'en' }), `desk ${device.viewport.width}px EN`).toEqual([]);
      await toggle(page);
      expect(await page.locator('#sre-picker-title').innerText()).toBe('எந்தப் பொருள்?');
      expect(await page.locator('#sre-picker-back').innerText()).toBe('பின் செல்');
      expect(await auditPage(page, { expectLang: 'ta' }), `${device.viewport.width}px TA`).toEqual([]);
      expect(errors).toEqual([]);
      await context.close();
    }
  });
});
