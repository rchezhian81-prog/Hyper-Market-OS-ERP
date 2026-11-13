import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startOfficeShop, PEOPLE, type OfficeShop } from './lib/office-shop';

/**
 * **U7 · a register fed a page at a time by head office (server paging) — the long lists (UI/UX gap audit G17 · P-08).**
 *
 * A list that can grow past a few hundred rows (the audit log, the import history, price history, requisitions, the
 * shelf-label pushes) must not be read whole into the browser. The chrome's register takes a LOADER instead of rows:
 *   • it asks for page 0 on open and shows "Showing 1–20 of 3,412" from head office's total — never the rows it holds;
 *   • Next asks for page 1; a heading tapped asks for that column's order; the search box asks with the words typed;
 *   • an older answer arriving after a newer one is dropped (no flash of the wrong page);
 *   • nothing matched with no search → the register's empty state; with a search → "No match" and "Clear the search";
 *   • head office down → the offline state, never an empty list read as "all clear".
 * Real store computer, real head office page shell; the loader is the page's own function.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DESK = { viewport: { width: 1280, height: 860 } };

type Ask = { page: number; size: number; search: string; sort: string | null; dir: string };
const asks = (page: Page): Promise<Ask[]> => page.evaluate(() => (globalThis as unknown as { u7asks: Ask[] }).u7asks);

/** Mount a loader-fed register; the "server" is 3,412 rows in the page, answering after `delayMs`, or as `mode` says. */
const mount = (page: Page, mode: 'ok' | 'empty' | 'offline' = 'ok'): Promise<void> => page.evaluate((m) => {
  const g = globalThis as unknown as {
    document: { querySelector(s: string): { prepend(n: unknown): void }; createElement(t: string): { id: string } };
    sreOffice: { table(host: unknown, opts: unknown): unknown };
    u7asks: unknown[]; u7delay: (a: { page: number }) => number;
  };
  const host = g.document.createElement('div');
  host.id = 'u7-host';
  g.document.querySelector('main').prepend(host);
  const all = Array.from({ length: 3412 }, (_, i) => ({ ref: `A-${String(i + 1).padStart(4, '0')}`, who: i % 2 === 0 ? 'Meena' : 'Ravi', n: i + 1 }));
  g.u7asks = [];
  g.u7delay = () => 0;
  g.sreOffice.table(host, {
    id: 'u7', label: { en: 'Audit trail', ta: 'தணிக்கைப் பதிவு' }, pageSize: 20, sortable: true,
    rowKey: (r: { ref: string }) => r.ref,
    columns: [
      { key: 'ref', label: { en: 'Reference', ta: 'குறிப்பு' } },
      { key: 'who', label: { en: 'Who', ta: 'யார்' } },
      { key: 'n', label: { en: 'Number', ta: 'எண்' }, sort: 'number', align: 'end' },
    ],
    empty: { title: { en: 'Nothing recorded yet', ta: 'இதுவரை எதுவும் பதிவாகவில்லை' } },
    loader: async (a: { page: number; size: number; search: string; sort: string | null; dir: string }) => {
      g.u7asks.push(a);
      await new Promise((r) => setTimeout(r, g.u7delay(a)));
      if (m === 'offline') return { state: 'offline' };
      let rows = m === 'empty' ? [] : all;
      if (a.search !== '') rows = rows.filter((r) => `${r.ref} ${r.who}`.toLowerCase().includes(a.search.toLowerCase()));
      if (a.sort === 'n') rows = [...rows].sort((x, y) => (x.n - y.n) * (a.dir === 'asc' ? 1 : -1));
      return { rows: rows.slice(a.page * a.size, a.page * a.size + a.size), total: rows.length };
    },
  });
}, mode);

describe.skipIf(!existsSync(CHROMIUM))('U7: the register pages from head office', () => {
  let browser: Browser;
  let shop: OfficeShop;
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
    shop = await startOfficeShop(browser, {});
  }, 300_000);
  afterAll(async () => { await shop?.stop(); await browser?.close(); });

  const open = async () => {
    const s = await shop.asPerson(PEOPLE.manager, DESK as never);
    await s.page.goto(`${shop.base}/customers`, { waitUntil: 'load' });
    await s.page.waitForFunction('globalThis.sreOffice !== undefined && typeof globalThis.sreOffice.table === "function"');
    return s;
  };
  const count = (page: Page) => page.locator('#u7-count');

  it('opens on page 0 with head office\'s total, turns pages, sorts and searches by asking head office', async () => {
    const { context, page, errors } = await open();
    await mount(page);
    await expect.poll(() => count(page).innerText()).toBe('Showing 1–20 of 3,412');
    expect(await page.locator('#u7-grid tbody tr').count()).toBe(20);
    expect((await asks(page))[0]).toEqual({ page: 0, size: 20, search: '', sort: null, dir: 'asc' });
    await page.click('#u7-next');
    await expect.poll(() => count(page).innerText()).toBe('Showing 21–40 of 3,412');
    expect((await asks(page)).at(-1)?.page).toBe(1);
    await page.click('#u7-grid .sre-sort[data-col="n"]');
    await page.click('#u7-grid .sre-sort[data-col="n"]');
    await expect.poll(async () => (await asks(page)).at(-1)).toEqual({ page: 0, size: 20, search: '', sort: 'n', dir: 'desc' });
    await expect.poll(() => page.locator('#u7-grid tbody tr').first().innerText()).toContain('A-3412');
    await page.fill('#u7-search', 'meena');
    await expect.poll(async () => (await asks(page)).at(-1)?.search).toBe('meena');
    await expect.poll(() => count(page).innerText()).toBe('Showing 1–20 of 1,706');
    expect(errors).toEqual([]);
    await context.close();
  });

  it('drops an older answer that arrives after a newer one', async () => {
    const { context, page } = await open();
    await mount(page);
    await expect.poll(() => count(page).innerText()).toBe('Showing 1–20 of 3,412');
    // page 1 answers slowly, page 2 at once: the slow answer must not paint over page 2
    await page.evaluate(() => { (globalThis as unknown as { u7delay: (a: { page: number }) => number }).u7delay = (a) => (a.page === 1 ? 600 : 0); });
    await page.click('#u7-next');
    await page.evaluate(() => (globalThis as unknown as { document: { getElementById(i: string): { click(): void } } }).document.getElementById('u7-next').click()).catch(() => undefined);
    await page.waitForTimeout(900);
    const shown = await count(page).innerText();
    expect(shown === 'Showing 21–40 of 3,412' || shown === 'Showing 41–60 of 3,412').toBe(true);
    const last = (await asks(page)).at(-1)?.page ?? 0;
    expect(shown).toBe(last === 2 ? 'Showing 41–60 of 3,412' : 'Showing 21–40 of 3,412');
    await context.close();
  });

  it('an empty choice in a list reads a word, never a dash, and follows the language toggle', async () => {
    const { context, page, errors } = await open();
    await page.evaluate(() => {
      const d = (globalThis as unknown as { document: { createElement(t: string): { value: string; textContent: string; id: string; append(...n: unknown[]): void }; querySelector(s: string): { prepend(n: unknown): void } } }).document;
      const sel = d.createElement('select'); sel.id = 'u7-sel';
      const blank = d.createElement('option'); blank.value = ''; blank.textContent = '—';
      const named = d.createElement('option'); named.value = ''; named.textContent = 'All stores';
      const real = d.createElement('option'); real.value = 'x'; real.textContent = 'Expired';
      sel.append(blank, real);
      const sel2 = d.createElement('select'); sel2.id = 'u7-sel2'; sel2.append(named);
      d.querySelector('main').prepend(sel); d.querySelector('main').prepend(sel2);
    });
    await expect.poll(() => page.locator('#u7-sel option').first().innerText()).toBe('Choose…');
    expect(await page.locator('#u7-sel2 option').first().innerText()).toBe('All stores');
    await page.evaluate(() => { (globalThis as unknown as { document: { getElementById(id: string): { click(): void } } }).document.getElementById('lang').click(); });
    await expect.poll(() => page.locator('#u7-sel option').first().innerText()).toBe('தேர்வு செய்க');
    expect(errors).toEqual([]);
    await context.close();
  });

  it('the role kind picks several roles at once; the batch kind asks for the product first, then lists its batches with their use-by day', async () => {
    const { context, page, errors } = await open();
    type Picked = { ok: boolean; ids?: string[]; names?: string[]; id?: string };
    const roles = page.evaluate(() => (globalThis as unknown as { sreOffice: { pick(o: unknown): Promise<unknown> } }).sreOffice.pick({ kind: 'role', multi: true, title: { en: 'Who is it for?', ta: 'யாருக்கு?' } })) as Promise<Picked>;
    await page.waitForSelector('#sre-picker-list .sre-picker-row');
    expect(await page.locator('#sre-picker-use-these').isDisabled()).toBe(true);
    const ids = await page.$$eval('#sre-picker-list .sre-picker-row', (els) => els.map((e) => (e as unknown as { dataset: { id: string } }).dataset.id));
    expect(ids).toEqual(expect.arrayContaining(['cashier', 'store_manager']));
    await page.click('#sre-picker-list .sre-picker-row[data-id="cashier"]');
    await page.click('#sre-picker-list .sre-picker-row[data-id="store_manager"]');
    expect(await page.locator('#sre-picker-list .sre-picker-row[data-id="cashier"]').getAttribute('aria-pressed')).toBe('true');
    expect(await page.locator('#sre-picker-use-these').innerText()).toBe('Use these (2)');
    await page.click('#sre-picker-use-these');
    const r = await roles;
    expect(r.ok).toBe(true);
    expect(r.ids).toEqual(['cashier', 'store_manager']);
    expect(r.id).toBe('cashier,store_manager');

    // no product chosen: the sheet says to choose it first, and offers the typed code
    const first = page.evaluate(() => (globalThis as unknown as { sreOffice: { pick(o: unknown): Promise<unknown> } }).sreOffice.pick({ kind: 'batch', allowCode: true, scope: {} }));
    await page.waitForSelector('#sre-picker .sre-state[data-state="empty"]');
    expect(await page.locator('#sre-picker').innerText()).toContain('Choose the product first');
    await page.click('#sre-picker-back');
    expect(await first).toEqual({ ok: false });

    // with a product: head office's batch directory, each batch with its use-by day in words
    await page.route('**/v1/inventory/batches?**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ batches: [{ batchId: 'B-7', expiry: '2026-12-01', onHandMinor: 4 }] }) }));
    const second = page.evaluate(() => (globalThis as unknown as { sreOffice: { pick(o: unknown): Promise<unknown> } }).sreOffice.pick({ kind: 'batch', scope: { productId: 'p-curd', locationId: 'br-1' } })) as Promise<Picked>;
    await page.waitForSelector('#sre-picker-list .sre-picker-row[data-id="B-7"]');
    expect(await page.locator('#sre-picker-list .sre-picker-row[data-id="B-7"] .sre-picker-name').innerText()).toBe('Batch B-7 — use by 1 Dec 2026');
    await page.click('#sre-picker-list .sre-picker-row[data-id="B-7"]');
    expect((await second).id).toBe('B-7');
    expect(errors).toEqual([]);
    await context.close();
  });

  it('nothing at all → the empty state; nothing matching → "No match" with Clear; head office down → offline', async () => {
    const a = await open();
    await mount(a.page, 'empty');
    await expect.poll(() => a.page.locator('#u7-host .sre-state').getAttribute('data-state')).toBe('empty');
    expect(await a.page.locator('#u7-host').innerText()).toContain('Nothing recorded yet');
    await a.context.close();
    const b = await open();
    await mount(b.page);
    await expect.poll(() => count(b.page).innerText()).toBe('Showing 1–20 of 3,412');
    await b.page.fill('#u7-search', 'nobody-here');
    await expect.poll(() => b.page.locator('#u7-host .sre-state').getAttribute('data-state')).toBe('noMatch');
    await b.context.close();
    const c = await open();
    await mount(c.page, 'offline');
    await expect.poll(() => c.page.locator('#u7-host .sre-state').getAttribute('data-state')).toBe('offline');
    await c.context.close();
  });
});
