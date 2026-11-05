import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { auditPage } from './lib/a11y-audit';
import { startOfficeShop, PEOPLE, S1, type OfficeShop } from './lib/office-shop';

/**
 * **U2b (UI/UX gap audit G5, G14) — the product and purchase pages pick a thing by NAME on the REAL store computer fed
 * by the REAL head office; the id the page sends is exactly what it was.**
 *
 *   • Product details: three letters find the milk; Show reads its record — the field held "Product id" before.
 *   • Requisitions: a line's product picked by name; the raised requisition carries that id; "Deliver to" is the
 *     person's own store before anything is typed; the quote's supplier picked by name.
 *   • Price lists: the product picked; a store price picks the STORE by name, a customer price a customer, a zone price
 *     has no list and keeps the typed field.
 *   • Supplier scorecard: the supplier picked by name; Show reads that supplier's scorecard.
 *   • Shelves & space: the shelf count's item picked by name (the label says "Item", not "Item code").
 *   • Store events (G14): the days are the shared dd/mm field — an impossible day is refused beside the field and the
 *     page reads ISO through it.
 * Audit clean with a picker open, in English and Tamil. Skips where no browser binary is present.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DESK = { viewport: { width: 1280, height: 860 } };

describe.skipIf(!existsSync(CHROMIUM))('U2b: the product and purchase pages pick things by name', () => {
  let browser: Browser;
  let shop: OfficeShop;
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
    shop = await startOfficeShop(browser, {
      seed: async (ok) => {
        // a second product and an approved supplier, through the real routes
        await ok('/v1/catalogue/products/p-dal/publish', PEOPLE.owner, {
          product: { sku: 'DAL-1KG', name: 'Toor dal 1kg', baseUom: 'ea', primaryCategoryId: 'grocery', taxClass: '0401', lifecycle: 'active' },
          categories: [{ categoryId: 'grocery', name: 'Grocery', parentId: null }],
        });
        await ok('/v1/purchase/suppliers/SUP-1', PEOPLE.owner, { name: 'Aavin Dairy' });
      },
    });
  }, 300_000);
  afterAll(async () => { await shop?.stop(); await browser?.close(); });

  const open = async (who: string, path: string) => {
    const s = await shop.asPerson(who, DESK);
    const calls: { method: string; path: string; body: unknown }[] = [];
    s.page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/v1/')) calls.push({ method: r.method(), path: u.pathname + u.search, body: r.method() === 'POST' ? JSON.parse(r.postData() ?? 'null') : null }); });
    await s.page.goto(`${shop.base}${path}`, { waitUntil: 'load' });
    await s.page.waitForFunction('globalThis.sreOffice !== undefined && typeof globalThis.sreOffice.pick === "function"');
    return { ...s, calls };
  };
  /** Open the picker behind a field, type a few letters, take the row that names the thing, and read the field. */
  const pick = async (page: Page, field: string, letters: string, id: string, name?: string): Promise<void> => {
    await page.waitForSelector(`#${field}-pick`);
    await page.click(`#${field}-pick`);
    await page.waitForSelector('#sre-picker');
    await page.fill('#sre-picker-q', letters);
    const row = page.locator(`#sre-picker .sre-picker-row[data-id="${id}"]`);
    await row.waitFor({ timeout: 15_000 });
    await row.click();
    await page.waitForSelector('#sre-picker', { state: 'detached' });
    expect(await page.inputValue(`#${field}`), `${field} holds the id`).toBe(id);
    if (name !== undefined) expect(await page.textContent(`#${field}-name`), 'the name shown beside the field').toBe(name);
  };

  it('Product details: the product is picked by name and Show reads its record; the audit is clean with the picker open, in English and Tamil', async () => {
    const s = await open(PEOPLE.manager, '/product-details');
    try {
      expect(await s.page.textContent('#l-product'), 'the label asks for a product, not an id').toBe('Product');
      await s.page.click('#product-pick');
      await s.page.waitForSelector('#sre-picker');
      expect(await auditPage(s.page), 'the picker over the page').toEqual([]);
      await s.page.keyboard.press('Escape');
      await s.page.waitForSelector('#sre-picker', { state: 'detached' });
      await s.page.click('#lang'); // the toggle sits under the picker's scrim, so the language is switched between two openings
      expect(await s.page.textContent('#product-pick')).toBe('தேர்ந்தெடு…');
      expect(await s.page.textContent('#l-product')).toBe('பொருள்');
      await s.page.click('#product-pick');
      await s.page.waitForSelector('#sre-picker');
      expect(await s.page.textContent('#sre-picker-title')).toBe('எந்தப் பொருள்?');
      expect(await auditPage(s.page, { expectLang: 'ta' })).toEqual([]);
      await s.page.keyboard.press('Escape');
      await s.page.waitForSelector('#sre-picker', { state: 'detached' });
      await s.page.click('#lang');
      await pick(s.page, 'product', 'ton', 'p-milk', 'Toned milk 500 ml');
      await s.page.click('#show');
      await s.page.waitForFunction("document.getElementById('r-name').value === 'Toned milk 500 ml'", undefined, { timeout: 15_000 });
      expect(s.calls.some((c) => c.method === 'GET' && c.path.startsWith('/v1/catalogue/products/p-milk'))).toBe(true);
      expect(s.errors).toEqual([]);
    } finally { await s.context.close(); }
  });

  it('Requisitions: a line\'s product is picked by name and the requisition carries that id; Deliver to is the person\'s store; the quote\'s supplier is picked', async () => {
    const s = await open(PEOPLE.manager, '/requisitions');
    try {
      await s.page.waitForSelector('#new-productId-0-pick');
      expect(await s.page.inputValue('#order-store'), 'the store from the sign-in, never typed first').toBe(S1);
      expect(await s.page.textContent('#l-quote-supplier')).toBe('Supplier');
      await pick(s.page, 'new-productId-0', 'dal', 'p-dal', 'Toor dal 1kg');
      await s.page.fill('#new-quantity-0', '2');
      await s.page.fill('#new-id', 'REQ-U2B-1');
      await s.page.click('#raise');
      await s.page.waitForFunction('/REQ-U2B-1/.test(document.body.innerText)', undefined, { timeout: 15_000 });
      const sent = s.calls.find((c) => c.method === 'POST' && /requisition/.test(c.path));
      expect(sent, 'the requisition reached head office').toBeDefined();
      expect(JSON.stringify(sent!.body)).toContain('"p-dal"');
      await pick(s.page, 'quote-supplier', 'aav', 'SUP-1', 'Aavin Dairy');
      expect(s.errors).toEqual([]);
    } finally { await s.context.close(); }
  });

  it('Price lists: the product is picked; a store price picks the store by name, a customer price a customer, a zone price keeps the typed field', async () => {
    const s = await open(PEOPLE.owner, '/price-lists');
    try {
      expect(await s.page.textContent('#l-p-product')).toBe('Product');
      expect(await s.page.textContent('#l-p-ref')).toBe('Store, zone, channel or customer');
      await pick(s.page, 'p-product', 'ton', 'p-milk', 'Toned milk 500 ml');
      await s.page.selectOption('#p-scope', 'store');
      await pick(s.page, 'p-ref', 'hyp', S1, 'SRE Hyper Market');
      await s.page.selectOption('#p-scope', 'zone');
      expect(await s.page.isHidden('#p-ref-pick'), 'a zone has no list — the field stays typed').toBe(true);
      await s.page.selectOption('#p-scope', 'customer');
      expect(await s.page.isVisible('#p-ref-pick')).toBe(true);
      await s.page.click('#p-ref-pick');
      await s.page.waitForSelector('#sre-picker');
      expect(await s.page.textContent('#sre-picker h2, #sre-picker [id$="-title"]')).toContain('Which customer?');
      await s.page.keyboard.press('Escape');
      expect(s.errors).toEqual([]);
    } finally { await s.context.close(); }
  });

  it('Supplier scorecard: the supplier is picked by name and Show reads that supplier\'s scorecard', async () => {
    const s = await open(PEOPLE.manager, '/supplier-scorecard');
    try {
      expect(await s.page.textContent('#l-supplier')).toBe('Supplier');
      await pick(s.page, 'supplier', 'aav', 'SUP-1', 'Aavin Dairy');
      await s.page.click('#show');
      await s.page.waitForFunction("performance.getEntriesByType('resource').some((e) => /\\/v1\\/purchase\\/suppliers\\/SUP-1\\/scorecard/.test(e.name))", undefined, { timeout: 15_000 });
      expect(s.errors).toEqual([]);
    } finally { await s.context.close(); }
  });

  it('Shelves & space: the shelf count\'s item is picked by name and the label says "Item"', async () => {
    const s = await open(PEOPLE.manager, '/merchandising/');
    try {
      expect(await s.page.textContent('#count-product-label')).toBe('Item');
      await pick(s.page, 'count-product', 'ton', 'p-milk', 'Toned milk 500 ml');
      expect(s.errors).toEqual([]);
    } finally { await s.context.close(); }
  });

  it('Store events (G14): the days are the shared dd/mm field — an impossible day is refused beside the field; a real one reads back as ISO', async () => {
    const s = await open(PEOPLE.manager, '/demand-events');
    try {
      await s.page.waitForSelector('#ev-from[placeholder="dd/mm/yyyy"]');
      await s.page.fill('#ev-from', '31/02/2026');
      await s.page.locator('#ev-from').blur();
      await s.page.locator('#ev-from-msg').waitFor({ state: 'visible', timeout: 10_000 });
      expect(await s.page.evaluate(() => (globalThis as unknown as { sreOffice: { dateValue(id: string): string | null } }).sreOffice.dateValue('ev-from'))).toBeNull();
      await s.page.fill('#ev-from', '20/11/2026');
      await s.page.locator('#ev-from').blur();
      expect(await s.page.evaluate(() => (globalThis as unknown as { sreOffice: { dateValue(id: string): string | null } }).sreOffice.dateValue('ev-from'))).toBe('2026-11-20');
      await s.page.click('#lang');
      expect(await s.page.inputValue('#ev-from'), 'the typed day is kept across the toggle').toBe('20/11/2026');
      expect(await auditPage(s.page, { expectLang: 'ta' })).toEqual([]);
      expect(s.errors).toEqual([]);
    } finally { await s.context.close(); }
  });
});
