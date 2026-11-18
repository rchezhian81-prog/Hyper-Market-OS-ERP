import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';

/**
 * **OB-800 THE PLAN fix batch 4b — names not codes, this store by default, dates with a calendar, on-hand on Products.**
 *
 * - D-018: every Products row shows the price the tills charge (from the store computer's till catalogue) and how many we
 *   have (ONE read of head office's on-hand for the person's stores) — no opening each item, no trip to the Stock ledger.
 * - D-026: a label task says the item's NAME; one a newer price replaced says so and offers nothing to close; "Assign a
 *   task" starts on this store computer's own store, shown by name.
 * - D-054: "Send to the tills" starts on this store, names a left-out item, and says how soon a store computer that is
 *   online takes the pack (the store computer's own loop ceiling — 5 minutes), never "on its next pull".
 * - D-024: the shared dd/mm/yyyy date box has a calendar beside it (the browser's own date picker); a day picked there
 *   lands in the box as dd/mm/yyyy. The day book opens on TODAY; the stock ledger's "To" and an advance's "Paid on" start
 *   on today.
 *
 * Each page is served the way the store computer serves it (its screen data and the store directory injected), with a
 * stand-in head office answering the `/v1` reads the page makes. Headless Chromium; without one the suite SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const WEB = 'apps/web-erp/web';
const STORE = { id: 'pilot-demo-branch', name: 'SRE Hyper Market' };
const shopToday = (): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const ddmm = (iso: string): string => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

type Answer = { readonly status: number; readonly body: unknown };
interface Served { readonly base: string; readonly asked: string[]; stop(): Promise<void> }

/** One office page as the store computer serves it, and a stand-in head office for its `/v1` reads. */
async function serve(html: string, dataGlobal: string, data: Record<string, unknown>, answers: (method: string, path: string) => Answer | undefined): Promise<Served> {
  const asked: string[] = [];
  const directory = { store: STORE, timeZone: 'Asia/Kolkata', me: { userId: data['userId'], name: 'Manager', roleIds: ['store_manager'], permissions: data['permissions'] }, people: [], places: [{ id: STORE.id, name: STORE.name, kind: 'store' }], roles: [], known: { people: true, places: true, store: true, roles: false } };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname.startsWith('/v1/') || url.pathname.startsWith('/directory/')) {
        asked.push(`${req.method} ${url.pathname}`);
        const a = answers(req.method ?? 'GET', url.pathname) ?? { status: 404, body: { error: { code: 'not_found', whatHappened: 'Not here.' } } };
        res.writeHead(a.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(a.body));
        return;
      }
      const file = url.pathname === '/' ? html : url.pathname.replace(/^\//, '');
      try {
        let body = (await readFile(join(WEB, file))).toString('utf8');
        if (file === html) {
          const inject = { [dataGlobal]: data, sreDirectory: directory, shopTimeZone: 'Asia/Kolkata' };
          body = body.replace('<!--SCREEN-DATA-->', `<script>${Object.entries(inject).map(([k, v]) => `window.${k} = ${JSON.stringify(v).replace(/</g, '\\u003c')};`).join('')}</script>`);
        }
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.json') ? 'application/json' : 'application/octet-stream';
        res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
        res.end(body);
      } catch {
        res.writeHead(404); res.end('not found');
      }
    })();
  });
  const base = await new Promise<string>((resolve) => server.listen(0, '127.0.0.1', () => { const a = server.address(); resolve(`http://127.0.0.1:${typeof a === 'object' && a !== null ? a.port : 0}`); }));
  return { base, asked, stop: () => new Promise((r) => server.close(() => r())) };
}

describe.skipIf(!HAVE_BROWSER)('fix batch 4b: names not codes, this store by default, dates with a calendar, on-hand on Products', () => {
  let browser: Browser;
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 120_000);
  afterAll(async () => { await browser?.close(); });

  const open = async (srv: Served): Promise<{ page: Page; errors: string[]; close: () => Promise<void> }> => {
    const ctx = await browser.newContext();
    await ctx.addInitScript(() => { try { (globalThis as unknown as { navigator: { serviceWorker?: unknown } }).navigator.serviceWorker = undefined; } catch { /* the page still opens */ } });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${srv.base}/`, { waitUntil: 'load' });
    return { page, errors, close: async () => { await ctx.close(); await srv.stop(); } };
  };

  it('D-018: each Products row shows the price on the tills and how many we have, from ONE read of head office', async () => {
    const product = (productId: string, name: string, baseUom: string) => ({ productId, tenantId: 't1', sku: productId.toUpperCase(), name, primaryCategoryId: 'grocery', baseUom, taxClass: '1905', attributes: {}, mrpHistory: [], lifecycle: 'active' });
    const data = {
      userId: 'u-mgr', storeId: STORE.id, today: shopToday(), marginFloorBps: 1000,
      categories: [{ categoryId: 'grocery', name: 'Grocery', parentId: null }],
      products: [product('prod-biscuit', 'Marie biscuits', 'ea'), product('prod-rice', 'Ponni rice', 'kg'), product('prod-new', 'New soap', 'ea')],
      costsMinor: { 'prod-biscuit': 25_00, 'prod-rice': 40_00 },
      tillPrices: { asAt: new Date().toISOString(), byProduct: { 'prod-biscuit': 35_00, 'prod-rice': 62_00 } },
    };
    const srv = await serve('catalogue.html', 'catalogueData', data, (method, path) => {
      if (method === 'GET' && path === '/v1/inventory/availability') return { status: 200, body: { rows: [{ productId: 'prod-biscuit', locationId: STORE.id, onHandMinor: 40 }, { productId: 'prod-biscuit', locationId: 'back-store', onHandMinor: 8 }, { productId: 'prod-rice', locationId: STORE.id, onHandMinor: 12_500 }], asAt: new Date().toISOString() } };
      return undefined;
    });
    const { page, errors, close } = await open(srv);
    try {
      await page.waitForFunction(() => (globalThis as unknown as { document: { querySelectorAll(s: string): { length: number; [i: number]: { textContent: string | null } } } }).document.querySelectorAll('#item-list small.on-hand').length === 3
        && !/reading/.test((globalThis as unknown as { document: { querySelector(s: string): { textContent: string | null } | null } }).document.querySelector('#item-list small.on-hand')?.textContent ?? 'reading'), undefined, { timeout: 15_000 });
      const rows = await page.$$eval('#item-list .row', (els) => els.map((e) => e.textContent ?? ''));
      const rowOf = (name: string) => rows.find((r) => r.includes(name)) ?? '';
      expect(rowOf('Marie biscuits')).toMatch(/₹35\.00 on the tills/);
      expect(rowOf('Marie biscuits')).toMatch(/in stock: 48 ea/);
      expect(rowOf('Ponni rice')).toMatch(/₹62\.00 on the tills/);
      expect(rowOf('Ponni rice')).toMatch(/in stock: 12\.500 kg/);
      expect(rowOf('New soap')).toMatch(/in stock: none recorded/);
      // An item the tills were given a price for never says "open the item to read it"; one with none still says how to see it.
      expect(`${rowOf('Marie biscuits')} ${rowOf('Ponni rice')}`).not.toMatch(/open the item to read it/);
      expect(srv.asked.filter((a) => a === 'GET /v1/inventory/availability')).toHaveLength(1);
      expect(errors).toEqual([]);
    } finally { await close(); }
  }, 60_000);

  it('D-018: a refused stock read says so once, and no figure is guessed', async () => {
    const data = { userId: 'u-mgr', storeId: STORE.id, today: shopToday(), marginFloorBps: 1000, categories: [], products: [{ productId: 'prod-biscuit', tenantId: 't1', sku: 'BISC', name: 'Marie biscuits', primaryCategoryId: null, baseUom: 'ea', taxClass: '1905', attributes: {}, mrpHistory: [], lifecycle: 'active' }] };
    const srv = await serve('catalogue.html', 'catalogueData', data, (method, path) => (method === 'GET' && path === '/v1/inventory/availability' ? { status: 403, body: { error: { code: 'forbidden', whatHappened: 'Your role may not read how many we have.' } } } : undefined));
    const { page, close } = await open(srv);
    try {
      await page.waitForSelector('#stock-note:not([hidden])', { timeout: 15_000 });
      expect(await page.textContent('#stock-note')).toBe('Your role may not read how many we have.');
      expect(await page.textContent('#item-list small.on-hand')).toBe('in stock: not shown');
    } finally { await close(); }
  }, 60_000);

  it('D-026: label tasks by item name; a replaced one says so and offers no close; Assign a task starts on this store', async () => {
    const now = new Date().toISOString();
    const base = { branchId: STORE.id, productId: 'prod-biscuit', productName: 'Marie biscuits', locationId: 'A1', because: 'price_change', sourceRef: 'r', raisedAt: now, dueAt: now, dueNow: true, done: null, assignee: { to: 'store_manager', departmentId: null, because: 'no_department_owns_it' }, assignedToMe: true, storeManagers: ['u-mgr'] };
    const tasks = [
      { ...base, taskId: 'rl-32', priceMinor: 32_00, mayClose: true, replacedBy: null },
      { ...base, taskId: 'rl-30', priceMinor: 30_00, mayClose: false, replacedBy: { taskId: 'rl-32', priceMinor: 32_00, dueAt: now } },
    ];
    const data = { userId: 'u-mgr', permissions: ['workforce.task.read', 'workforce.roster.manage', 'workforce.task.complete.own'] };
    const srv = await serve('store-tasks.html', 'storeOpsData', data, (method, path) => {
      if (method === 'GET' && path === '/v1/pricing/relabel-tasks') return { status: 200, body: { tasks, open: 1, asAt: now } };
      if (method === 'GET' && path === '/v1/identity/me') return { status: 200, body: { userId: 'u-mgr', branchId: null, permissions: data.permissions } };
      if (method === 'GET' && path === '/v1/hr/workforce/assigned-tasks') return { status: 200, body: { tasks: [] } };
      return undefined;
    });
    const { page, errors, close } = await open(srv);
    try {
      await page.waitForSelector('#relabel-rows li[data-task="rl-30"]', { timeout: 15_000 });
      const live = (await page.textContent('#relabel-rows li[data-task="rl-32"]')) ?? '';
      const replaced = (await page.textContent('#relabel-rows li[data-task="rl-30"]')) ?? '';
      expect(live).toMatch(/^Marie biscuits · New price ₹32\.00/);
      expect(live).not.toMatch(/prod-biscuit/);
      expect(replaced).toMatch(/Replaced — a newer price is in force: ₹32\.00/);
      expect(replaced).toMatch(/No label to print at this price/);
      expect(await page.$$('#relabel-rows li[data-task="rl-30"] form')).toHaveLength(0);
      expect(await page.$$('#relabel-rows li[data-task="rl-32"] form')).toHaveLength(1);
      await page.waitForFunction(() => (globalThis as unknown as { document: { body: { dataset: Record<string, string> } } }).document.body.dataset['taskDefaults'] === 'ready', undefined, { timeout: 15_000 });
      expect(await page.inputValue('#a-branch')).toBe(STORE.id);
      expect(await page.textContent('#a-branch-name')).toBe(STORE.name);
      expect(errors).toEqual([]);
    } finally { await close(); }
  }, 60_000);

  it('D-026 (batch 14): the first price load is ONE grouped item with its count, not a flood of "due now"; a real change stays due', async () => {
    const now = new Date().toISOString();
    const base = { branchId: STORE.id, locationId: 'A1', sourceRef: 'r', raisedAt: now, dueAt: now, done: null, assignee: { to: 'store_manager', departmentId: null, because: 'no_department_owns_it' }, assignedToMe: true, storeManagers: ['u-mgr'], mayClose: true, replacedBy: null };
    const first = ['Aavin milk 500 ml', 'Ponni rice 5 kg', 'Marie biscuits', 'Lifebuoy soap', 'Tata salt 1 kg'].map((name, i) => ({ ...base, taskId: `rl-f${i}`, productId: `p-${i}`, productName: name, priceMinor: 30_00 + i * 100, because: 'price_list_entry', firstLabel: true, dueNow: false }));
    const change = { ...base, taskId: 'rl-c', productId: 'p-dal', productName: 'Toor dal 1 kg', priceMinor: 148_00, because: 'price_change', firstLabel: false, dueNow: true };
    const tasks = [change, ...first];
    const data = { userId: 'u-mgr', permissions: ['workforce.task.read', 'workforce.roster.manage', 'workforce.task.complete.own'] };
    const srv = await serve('store-tasks.html', 'storeOpsData', data, (method, path) => {
      if (method === 'GET' && path === '/v1/pricing/relabel-tasks') return { status: 200, body: { tasks, open: 6, firstLoad: { open: 5 }, dueNow: 1, asAt: now } };
      if (method === 'GET' && path === '/v1/identity/me') return { status: 200, body: { userId: 'u-mgr', branchId: null, permissions: data.permissions } };
      if (method === 'GET' && path === '/v1/hr/workforce/assigned-tasks') return { status: 200, body: { tasks: [] } };
      return undefined;
    });
    const { page, errors, close } = await open(srv);
    try {
      await page.waitForSelector('#relabel-rows li.first-load', { timeout: 15_000 });
      // The real change is its own row, due now; the five first labels are one item, with their count, not due now.
      expect(await page.textContent('#relabel-rows > li[data-task="rl-c"] .head')).toBe('Toor dal 1 kg · New price ₹148.00⚠ due now');
      expect(await page.$$('#relabel-rows > li[data-task^="rl-f"]')).toHaveLength(0);
      expect(await page.getAttribute('#relabel-rows li.first-load', 'data-first-load')).toBe('5');
      expect(await page.textContent('#relabel-rows li.first-load > .head')).toBe('First price load5 labels to check — not due now');
      expect(await page.$$eval('#relabel-rows li.first-load li[data-task]', (els) => els.length)).toBe(5);
      expect(await page.textContent('#relabel-rows li.first-load li[data-task="rl-f0"] .state')).toBe('first label — check it');
      expect(((await page.textContent('#relabel-rows')) ?? '').split('⚠ due now').length - 1).toBe(1); // only the one real change
      // Nothing is lost: open the group and each first label can still be closed with its photo.
      await page.click('#relabel-rows li.first-load summary');
      expect(await page.$$('#relabel-rows li.first-load li[data-task] form')).toHaveLength(5);
      const dir = process.env['B14_SHOTS'];
      if (dir !== undefined && dir !== '') await page.screenshot({ path: `${dir}/d026-store-tasks-first-price-load.png`, fullPage: true });
      // Tamil: the group speaks Tamil too.
      await page.click('#lang');
      expect(await page.textContent('#relabel-rows li.first-load > .head')).toMatch(/^முதல் விலை ஏற்றம்5 சரிபார்க்க வேண்டிய லேபிள்கள்/);
      expect(errors).toEqual([]);
    } finally { await close(); }
  }, 60_000);

  it('D-054: Send to the tills starts on this store, names a left-out item, and says the tills have it within 5 minutes', async () => {
    const data = { userId: 'u-owner', permissions: ['catalogue.pack.read', 'catalogue.pack.publish', 'price.change.propose'] };
    const srv = await serve('price-lists.html', 'priceListsData', data, (method, path) => {
      if (method === 'GET' && path === '/v1/catalogue/products') return { status: 200, body: { products: [{ productId: 'prod-milk', name: 'Aavin milk 500 ml' }, { productId: 'prod-biscuit', name: 'Marie biscuits' }] } };
      if (method === 'GET' && path === '/v1/org/nodes') return { status: 200, body: { nodes: [{ nodeId: STORE.id, kind: 'branch', name: STORE.name, status: 'open' }] } };
      if (method === 'GET' && path === '/v1/catalogue/pack/preview') return { status: 200, body: { includedCount: 1, excluded: [{ productId: 'prod-milk', reason: 'no_price' }], notSold: [] } };
      if (method === 'POST' && path === '/v1/catalogue/pack') return { status: 201, body: { version: 2 } };
      return { status: 200, body: {} };
    });
    const { page, close } = await open(srv);
    try {
      await page.waitForFunction((id) => (globalThis as unknown as { document: { getElementById(i: string): { value: string } | null } }).document.getElementById('pk-store')?.value === id, STORE.id, { timeout: 15_000 });
      await page.click('#tab-pack');
      await page.click('#pk-preview');
      await page.waitForSelector('#pk-left li', { timeout: 10_000 });
      expect(await page.textContent('#pk-left')).toMatch(/Left out: Aavin milk 500 ml — /);
      expect(await page.textContent('#pk-status')).toMatch(new RegExp(`tills of ${STORE.name} \\(${STORE.id}\\)`));
      await page.click('#pk-publish');
      await page.waitForFunction(() => /Sent\./.test((globalThis as unknown as { document: { getElementById(i: string): { textContent: string | null } | null } }).document.getElementById('pk-status')?.textContent ?? ''), undefined, { timeout: 10_000 });
      const sent = (await page.textContent('#pk-status')) ?? '';
      expect(sent).toMatch(/version 2 is signed\. A store computer that is online takes it within 5 minutes/);
      expect(sent).not.toMatch(/next pull/);
    } finally { await close(); }
  }, 60_000);

  it('D-024: the day book opens on today, and its date box has a calendar that writes dd/mm/yyyy', async () => {
    const data = { userId: 'u-acct', permissions: ['finance.period.read'] };
    const srv = await serve('day-book.html', 'dayBookData', data, () => undefined);
    const { page, close } = await open(srv);
    try {
      await page.waitForSelector('#day-calendar-open', { timeout: 15_000 });
      expect(await page.inputValue('#day')).toBe(ddmm(shopToday()));
      expect((await page.textContent('#day-calendar-open')) ?? '').toMatch(/Calendar/);
      // The browser's own picker: what is chosen there lands in the box as dd/mm/yyyy, and the page reads it as ISO.
      expect(await page.$$('#day-calendar')).toHaveLength(0); // no hidden box on the page until the calendar is opened
      await page.click('#day-calendar-open');
      await page.fill('#day-calendar', '2026-10-31');
      expect(await page.$$('#day-calendar')).toHaveLength(0); // gone again once a day is chosen
      expect(await page.inputValue('#day')).toBe('31/10/2026');
      expect(await page.evaluate(() => (globalThis as unknown as { sreOffice: { dateValue(id: string): string | null } }).sreOffice.dateValue('day'))).toBe('2026-10-31');
      // Typing still works.
      await page.fill('#day', '01/11/2026');
      expect(await page.evaluate(() => (globalThis as unknown as { sreOffice: { dateValue(id: string): string | null } }).sreOffice.dateValue('day'))).toBe('2026-11-01');
    } finally { await close(); }
  }, 60_000);

  it('D-024: the stock ledger\'s "To" and an advance\'s "Paid on" start on today, each with a calendar', async () => {
    const today = ddmm(shopToday());
    const ledger = await serve('stock-ledger.html', 'stockLedgerData', { userId: 'u-mgr', permissions: ['inventory.availability.read'] }, () => undefined);
    const a = await open(ledger);
    try {
      await a.page.waitForSelector('#to-calendar-open', { timeout: 15_000 });
      expect(await a.page.inputValue('#to')).toBe(today);
      expect(await a.page.inputValue('#from')).toBe('');
    } finally { await a.close(); }
    const bills = await serve('supplier-bills.html', 'supplierBillsData', { userId: 'u-acct', permissions: ['purchase.supplier.pay', 'purchase.invoice.match', 'purchase.commitment.read'] }, () => ({ status: 200, body: {} }));
    const b = await open(bills);
    try {
      await b.page.waitForSelector('#adv-on-calendar-open', { state: 'attached', timeout: 15_000 });
      expect(await b.page.inputValue('#adv-on')).toBe(today);
    } finally { await b.close(); }
  }, 60_000);
});
