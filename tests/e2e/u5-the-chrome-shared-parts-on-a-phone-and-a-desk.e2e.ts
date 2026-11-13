import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { auditPage } from './lib/a11y-audit';
import { startOfficeShop, PEOPLE, type OfficeShop } from './lib/office-shop';

/**
 * **U5 · the chrome's shared parts on a real office page, on the REAL store computer fed by the REAL head office
 * (UI/UX gap audit G11 · G13 · G17 · P-01 · P-07 · P-08 · NFR-08).**
 *
 *   • the register: 48 real-shaped rows → search narrows, a heading tapped sorts and SAYS its direction in words, paging
 *     shows "Showing 1–20 of 48", the count line; on a 360px phone the rows stack and nothing scrolls sideways;
 *   • the record chip: a lifecycle state becomes the tone and the words, in English and Tamil;
 *   • `pickable` on a page's own input: Choose → a few letters → the id lands in the input and the NAME beside it;
 *     `shopDate` on a page's own input: 31/10/2026 typed → `dateOf` answers ISO;
 *   • the tax-class kind lists the HSN codes head office's products carry, with how many products under each;
 *   • with head office CUT, a product is still picked from the store computer's own signed catalogue, said so on the sheet;
 *   • the phone chrome: the page's name once in the first screenful, the breadcrumb and the eyebrow gone, Pin and Find
 *     behind the menu, a subpage tile's purpose line whole; the audit clean at a desk and on a phone, in both languages.
 * Skips where no browser binary is present.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DESK = { viewport: { width: 1280, height: 860 } };
const PHONE = { viewport: { width: 360, height: 640 }, hasTouch: true, isMobile: true };

type Picked = { ok: boolean; id?: string; name?: string; code?: string };
const rows = (page: Page): Promise<string[]> => page.$$eval('#sre-picker-list .sre-picker-name', (els) => els.map((e) => (e.textContent ?? '').trim()));
const toggle = (page: Page): Promise<void> => page.evaluate(() => { (globalThis as unknown as { document: { getElementById(id: string): { click(): void } } }).document.getElementById('lang').click(); });
const widest = (page: Page): Promise<number> => page.evaluate(() => { const d = (globalThis as unknown as { document: { documentElement: { scrollWidth: number; clientWidth: number } } }).document.documentElement; return d.scrollWidth - d.clientWidth; });

/** A register of 48 real-shaped rows, mounted on the page from the chrome's own part. */
const mountRegister = (page: Page): Promise<void> => page.evaluate(() => {
  const g = globalThis as unknown as { document: { querySelector(s: string): { prepend(n: unknown): void }; createElement(t: string): { id: string } }; sreOffice: { table(host: unknown, opts: unknown): unknown } };
  const host = g.document.createElement('div');
  host.id = 'u5-host';
  g.document.querySelector('main').prepend(host);
  const kinds = ['short', 'damaged', 'late'];
  const data = Array.from({ length: 48 }, (_, i) => ({ ref: `F-${String(i + 1).padStart(3, '0')}`, kind: kinds[i % 3], valueMinor: (i + 1) * 1_250, when: `2026-10-${String((i % 28) + 1).padStart(2, '0')}` }));
  g.sreOffice.table(host, {
    id: 'u5', label: { en: 'Findings', ta: 'கண்டுபிடிப்புகள்' }, pageSize: 20, sortable: true, rowKey: (r: { ref: string }) => r.ref,
    columns: [
      { key: 'ref', label: { en: 'Reference', ta: 'குறிப்பு' } },
      { key: 'kind', label: { en: 'Kind', ta: 'வகை' }, filter: true },
      { key: 'valueMinor', label: { en: 'Value', ta: 'மதிப்பு' }, sort: 'number', align: 'end', value: (r: { valueMinor: number }) => r.valueMinor },
      { key: 'when', label: { en: 'Day', ta: 'நாள்' } },
    ],
    rows: data,
  });
});

describe.skipIf(!existsSync(CHROMIUM))('U5: the chrome\'s shared parts on a phone and a desk', () => {
  let browser: Browser;
  let shop: OfficeShop;
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
    shop = await startOfficeShop(browser, {
      seed: async (ok) => {
        await ok('/v1/catalogue/tax-classes/1006/rates/2017-07-01', PEOPLE.owner, { rateBps: 500 });
        await ok('/v1/catalogue/products/p-rice/publish', PEOPLE.owner, {
          product: { sku: 'RICE-5KG', name: 'Ponni rice 5kg', baseUom: 'ea', primaryCategoryId: 'grocery', taxClass: '1006', lifecycle: 'active' },
          categories: [{ categoryId: 'grocery', name: 'Grocery', parentId: null }],
        });
      },
    });
  }, 300_000);
  afterAll(async () => { await shop?.stop(); await browser?.close(); });

  const open = async (device: Record<string, unknown> = DESK, path = '/customers', who: string = PEOPLE.manager) => {
    const s = await shop.asPerson(who, device as never);
    await s.page.goto(`${shop.base}${path}`, { waitUntil: 'load' });
    await s.page.waitForFunction('globalThis.sreOffice !== undefined && typeof globalThis.sreOffice.pickable === "function"');
    return s;
  };

  it('the register searches, sorts with its direction in words, pages and counts; on a phone its rows stack and nothing scrolls sideways', async () => {
    const { context, page, errors } = await open();
    await mountRegister(page);
    expect(await page.locator('#u5-count').innerText()).toBe('Showing 1–20 of 48');
    expect(await page.locator('#u5-grid tbody tr').count()).toBe(20);
    await page.click('#u5-next');
    expect(await page.locator('#u5-count').innerText()).toBe('Showing 21–40 of 48');
    await page.fill('#u5-search', 'damaged');
    expect(await page.locator('#u5-count').innerText()).toBe('Showing 1–16 of 16');
    await page.fill('#u5-search', '');
    // the heading sorts, and SAYS which way (words beside it, not an arrow alone)
    await page.click('#u5-grid .sre-sort[data-col="valueMinor"]');
    expect(await page.locator('#u5-grid th[aria-sort="ascending"] .sre-sort-dir').innerText()).toBe('low to high');
    expect(await page.locator('#u5-grid tbody tr').first().innerText()).toContain('F-001');
    await page.click('#u5-grid .sre-sort[data-col="valueMinor"]');
    expect(await page.locator('#u5-grid th[aria-sort="descending"] .sre-sort-dir').innerText()).toBe('high to low');
    expect(await page.locator('#u5-grid tbody tr').first().innerText()).toContain('F-048');
    // every column is sortable when the page asks for it
    expect(await page.locator('#u5-grid .sre-sort[data-col="ref"]').count()).toBe(1);
    await toggle(page);
    expect(await page.locator('#u5-count').innerText()).toBe('48 இல் 1–20 காட்டப்படுகிறது');
    expect(await page.locator('#u5-grid th[aria-sort="descending"] .sre-sort-dir').innerText()).toBe('அதிகத்திலிருந்து குறைவு');
    expect(errors).toEqual([]);
    await context.close();

    const phone = await open(PHONE);
    await mountRegister(phone.page);
    expect(await widest(phone.page)).toBeLessThanOrEqual(0);
    const cell = phone.page.locator('#u5-grid tbody tr').first().locator('td').first();
    expect(await cell.getAttribute('data-label')).toBe('Reference');
    const stacked = await phone.page.evaluate(() => { const g = globalThis as unknown as { getComputedStyle(e: unknown): { display: string }; document: { querySelector(s: string): unknown } }; return g.getComputedStyle(g.document.querySelector('#u5-grid tbody tr')).display; });
    expect(stacked).toBe('grid');
    expect(await auditPage(phone.page, { expectLang: 'en' })).toEqual([]);
    await phone.context.close();
  });

  it('a record chip carries the tone and the words of both languages', async () => {
    const { context, page } = await open();
    const chip = await page.evaluate(() => {
      const g = globalThis as unknown as { document: { querySelector(s: string): { append(n: unknown): void } }; sreOffice: { recordChip(s: string, l?: unknown): { outerHTML: string; dataset: { tone: string }; textContent: string } } };
      const c = g.sreOffice.recordChip('approved');
      g.document.querySelector('main').append(c);
      const u = g.sreOffice.recordChip('no-such-state');
      return { tone: c.dataset.tone, words: c.textContent.trim(), unknownTone: u.dataset.tone, unknownWords: u.textContent.trim() };
    });
    expect(chip).toMatchObject({ tone: 'ok', words: 'Approved', unknownTone: 'unknown', unknownWords: 'no-such-state' });
    await toggle(page);
    expect((await page.locator('main .sre-chip').last().innerText()).trim()).toBe('அனுமதிக்கப்பட்டது');
    await context.close();
  });

  it('pickable on a page\'s own input and shopDate on a page\'s own date box; the tax-class kind lists HSN codes with their product counts', async () => {
    const { context, page } = await open();
    await page.evaluate(() => {
      const g = globalThis as unknown as { document: { querySelector(s: string): { prepend(n: unknown): void }; createElement(t: string): { id: string; type: string } }; sreOffice: { pickable(t: unknown, k: string, title: unknown): void; shopDate(id: string, label: unknown): void } };
      const main = g.document.querySelector('main');
      const d = g.document.createElement('input'); d.id = 'u5-day'; d.type = 'text'; main.prepend(d);
      const p = g.document.createElement('input'); p.id = 'u5-item'; p.type = 'text'; main.prepend(p);
      g.sreOffice.pickable('u5-item', 'product', { en: 'Which item?', ta: 'எந்தப் பொருள்?' });
      g.sreOffice.shopDate('u5-day', { en: 'From', ta: 'முதல்' });
    });
    expect(await page.locator('#u5-item-pick').innerText()).toBe('Choose…');
    await page.click('#u5-item-pick');
    await page.fill('#sre-picker-q', 'ponni');
    await page.waitForFunction(() => (globalThis as unknown as { document: { querySelectorAll(s: string): { length: number } } }).document.querySelectorAll('#sre-picker-list .sre-picker-row').length === 1);
    await page.click('#sre-picker-list .sre-picker-row');
    expect(await page.inputValue('#u5-item')).toBe('p-rice');
    expect(await page.locator('#u5-item-name').innerText()).toBe('Ponni rice 5kg');
    await page.fill('#u5-day', '31/10/2026');
    expect(await page.evaluate(() => (globalThis as unknown as { sreOffice: { dateOf(id: string): string | null } }).sreOffice.dateOf('u5-day'))).toBe('2026-10-31');
    expect(await page.locator('label[for="u5-day"]').innerText()).toBe('From');
    await toggle(page);
    expect(await page.locator('label[for="u5-day"]').innerText()).toBe('முதல்');
    // the field's own words follow the toggle too: the format hint and the placeholder (and "(required)" where asked)
    expect(await page.locator('#u5-day-hint').innerText()).toMatch(/^நாள் \/ மாதம் \/ ஆண்டு/);
    expect(await page.getAttribute('#u5-day', 'placeholder')).toBe('நா/மா/ஆண்டு');
    expect(await page.locator('#u5-item-pick').innerText()).toBe('தேர்ந்தெடு…');
    await toggle(page);
    expect(await page.locator('#u5-day-hint').innerText()).toMatch(/^Day \/ month \/ year/);
    expect(await page.getAttribute('#u5-day', 'placeholder')).toBe('dd/mm/yyyy');
    // the tax-class kind: every HSN head office's products carry, said with how many products stand under it
    await page.evaluate(() => { const w = globalThis as unknown as { sreOffice: { pick(spec: unknown): Promise<unknown> }; __picked?: unknown }; w.__picked = undefined; void w.sreOffice.pick({ kind: 'tax-class', title: { en: 'Which tax class?', ta: 'எந்த வரி வகுப்பு?' } }).then((a) => { w.__picked = a; }); });
    await page.waitForFunction(() => (globalThis as unknown as { document: { querySelectorAll(s: string): { length: number } } }).document.querySelectorAll('#sre-picker-list .sre-picker-row').length >= 2);
    expect((await rows(page)).sort()).toEqual(['HSN 0401 — 1 product', 'HSN 1006 — 1 product']);
    await page.fill('#sre-picker-q', '1006');
    await page.keyboard.press('Enter');
    const picked = await page.waitForFunction(() => (globalThis as unknown as { __picked?: unknown }).__picked !== undefined).then(() => page.evaluate(() => (globalThis as unknown as { __picked?: Picked }).__picked));
    expect(picked).toMatchObject({ ok: true, id: '1006', code: '1006' });
    await context.close();
  });

  it('with head office cut, a product is still picked from the store computer\'s own signed catalogue — said so on the sheet', async () => {
    const { context, page } = await open();
    await page.route('**/v1/**', (route) => route.abort());
    await page.evaluate(() => { const w = globalThis as unknown as { sreOffice: { pick(spec: unknown): Promise<unknown> }; __picked?: unknown }; w.__picked = undefined; void w.sreOffice.pick({ kind: 'product', title: { en: 'Which product?', ta: 'எந்தப் பொருள்?' } }).then((a) => { w.__picked = a; }); });
    await page.waitForFunction(() => (globalThis as unknown as { document: { querySelectorAll(s: string): { length: number } } }).document.querySelectorAll('#sre-picker-list .sre-picker-row').length >= 1);
    expect(await rows(page)).toContain('Toned milk 500 ml');
    expect(await page.locator('#sre-picker-source').innerText()).toMatch(/from this store computer's copy of the catalogue/);
    await page.fill('#sre-picker-q', 'milk');
    await page.keyboard.press('Enter');
    const picked = await page.waitForFunction(() => (globalThis as unknown as { __picked?: unknown }).__picked !== undefined).then(() => page.evaluate(() => (globalThis as unknown as { __picked?: Picked }).__picked));
    expect(picked).toMatchObject({ ok: true, id: 'p-milk', name: 'Toned milk 500 ml' });
    await context.close();
  });

  it('the phone chrome: the page\'s name once in the first screenful, Pin and Find behind the menu, a tile\'s purpose line whole; the audit clean in both languages', async () => {
    const { context, page } = await open(PHONE, '/catalogue/');
    const shape = await page.evaluate(() => {
      const g = globalThis as unknown as { document: { querySelector(s: string): { getBoundingClientRect(): { bottom: number }; textContent: string } | null; querySelectorAll(s: string): { textContent: string; closest(s: string): unknown; scrollWidth: number; clientWidth: number }[] }; getComputedStyle(e: unknown): { display: string } };
      const header = g.document.querySelector('header')!;
      const h1 = (g.document.querySelector('header h1')?.textContent ?? '').replace(/\s+/g, ' ').trim();
      const crumbs = g.document.querySelector('#sre-crumbs');
      const eyebrow = g.document.querySelector('[data-sre-head] > .sre-eyebrow');
      const inMenu = (id: string) => g.document.querySelector(`#sre-menu #${id}`) !== null;
      const tiles = [...g.document.querySelectorAll('.sre-tab .d')].filter((d) => d.textContent !== '').map((d) => d.scrollWidth <= d.clientWidth);
      return {
        headerBottom: header.getBoundingClientRect().bottom, h1,
        crumbsShown: crumbs !== null && g.getComputedStyle(crumbs).display !== 'none',
        eyebrowShown: eyebrow !== null && g.getComputedStyle(eyebrow).display !== 'none',
        pinInMenu: inMenu('sre-pin'), findInMenu: inMenu('sre-find-wrap'), tilesWhole: tiles,
      };
    });
    expect(shape.headerBottom).toBeLessThanOrEqual(140);
    expect(shape.h1.length).toBeGreaterThan(0);
    expect(shape.crumbsShown).toBe(false);
    expect(shape.eyebrowShown).toBe(false);
    expect(shape.pinInMenu).toBe(true);
    expect(shape.findInMenu).toBe(true);
    expect(shape.tilesWhole.length).toBeGreaterThan(0);
    expect(shape.tilesWhole.every(Boolean)).toBe(true);
    expect(await widest(page)).toBeLessThanOrEqual(0);
    expect(await auditPage(page, { expectLang: 'en' })).toEqual([]);
    await toggle(page);
    expect(await auditPage(page, { expectLang: 'ta' })).toEqual([]);
    // the menu opens with Find inside it, and Find still finds a screen
    await page.click('#sre-menu-button');
    await page.fill('#sre-find', 'cust');
    expect(await page.locator('#sre-find-count').innerText()).not.toBe('');
    await context.close();
  });
});
