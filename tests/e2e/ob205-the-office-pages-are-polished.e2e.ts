import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { auditPage } from './lib/a11y-audit';

/**
 * **OB-205 (19 Oct 2026), the office lane: the store manager's most-used back-office pages, polished page by page
 * inside the look the owner approved.**
 *
 * The Today page with its Approvals tab and the day close (index.html), goods receipt, stock counts, GST returns and
 * suppliers — opened in real Chromium at 1440 and 1280 (a desk, with the rail drawn) and 360 (a phone), in English
 * and in Tamil, each fed synthetic data the way the store computer feeds it, and held to what the polish promised:
 *
 *   - nothing overflows its container, and the page never scrolls sideways;
 *   - no console error, and the accessibility audit is clean in both languages;
 *   - a register's captions stay on screen (sticky) at a desk, its columns line up, money is right-aligned in tabular
 *     figures, and every status is a chip that wears its shape from the one icon set beside its word;
 *   - nothing a person must read is under 14px; the page's own heading speaks Tamil when the page does;
 *   - a hidden subpage is hidden (the Today band once sat above Approvals and the day close); "not known" is said
 *     with its shape and its reason; the drawer's close says so and Escape closes it; the day close's fields carry
 *     help and an inline error that says what to do.
 *
 * The data is synthetic and served by a stand-in for the store computer; each page's own e2e proves its payloads.
 * `OB205_WEB_DIR` points the suite at another copy of the pages (how it was shown to fail before the change).
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const WEB_DIR = process.env['OB205_WEB_DIR'] ?? 'apps/web-erp/web';
const AT = '2026-10-18T08:30:00.000Z';

const menu = (current: string): Record<string, unknown> => ({
  userId: 'u-mgr', branchId: 'b1', person: { name: 'Synthetic Manager', role: 'Store manager' }, branch: { name: 'Main store' }, why: null,
  groups: [
    { group: { en: 'Today', ta: 'இன்று' }, items: [{ id: 'dashboard', label: { en: 'Today', ta: 'இன்று' }, path: '/manager/', current: current === 'dashboard' }] },
    { group: { en: 'Buying & suppliers', ta: 'கொள்முதலும் விநியோகஸ்தர்களும்' }, items: [{ id: 'suppliers', label: { en: 'Suppliers', ta: 'விநியோகஸ்தர்கள்' }, path: '/suppliers/', current: current === 'suppliers' }] },
    { group: { en: 'Inventory & backstore', ta: 'சரக்கும் பின்கடையும்' }, items: [
      { id: 'goods-receipt', label: { en: 'Goods receipt review', ta: 'சரக்கு பெறுதல் மதிப்பாய்வு' }, path: '/goods-receipt/', current: current === 'goods-receipt' },
      { id: 'counts', label: { en: 'Stock counts', ta: 'சரக்கு எண்ணிக்கை' }, path: '/counts/', current: current === 'counts' },
    ] },
    { group: { en: 'Finance & GST', ta: 'நிதியும் GST-யும்' }, items: [{ id: 'gst-returns', label: { en: 'GST returns', ta: 'GST வருமானங்கள்' }, path: '/gst-returns/', current: current === 'gst-returns' }] },
  ],
});
const fig = (value: number, note: string): Record<string, unknown> => ({ known: true, value, note });
const MANAGER = {
  userId: 'u-mgr', approvalLimitMinor: 5_000_000, storeId: 'store-1', branchId: 'b1', tradingDay: '2026-10-18', tradingDayCutoff: '02:00', warehouseId: 'wh-1',
  approvals: [
    { id: 'a1', subjectType: 'price_change', subjectRef: 'Toor dal 1kg', requestedBy: 'u-buyer', branchId: 'b1', value: { minor: 45_000, currency: 'INR' }, status: 'pending' },
    { id: 'a2', subjectType: 'stock_adjustment', subjectRef: 'Rice 5kg', requestedBy: 'u-recv', branchId: 'b1', value: { minor: 9_000_000, currency: 'INR' }, status: 'pending' },
  ],
  openExceptions: [{ id: 'e1', what: 'Drawer lane-2 short by ₹120.00' }], unsentItems: [], tasks: [{ id: 't1', what: 'Open the safe' }],
  today: { salesToday: { known: true, value: 1_234_500, unit: 'inr', note: '41 sales' }, purchaseOrdersOpen: fig(2, 'awaiting goods'), receiptsRecorded: fig(1, 'today'),
    indentsOpen: { known: false, why: 'the store computer has not been given the floor indents' }, countsAwaitingApproval: fig(1, 'of 3'), expiringSoon: fig(4, 'within 7 days'),
    recallsOpen: fig(0, 'none'), checklistOpen: fig(2, 'open'), deliveriesToday: fig(3, 'today') },
};
const half = (t: number): Record<string, number> => ({ taxableMinor: t, cgstMinor: t / 40, sgstMinor: t / 40, igstMinor: 0 });
const totals = (owedMinor: number): Record<string, number> => ({ invoicedMinor: owedMinor, accruedMinor: owedMinor, withheldMinor: 0, debitNotesMinor: 0, paidMinor: 0, owedMinor, unmatchedInvoices: 0, blockedInvoices: 0, pendingReturns: 0 });
const ROUTES: Record<string, unknown> = {
  '/v1/inventory/goods-receipt': { count: 2, needingApprovalCount: 1, receipts: [
    { grnId: 'g2', number: 'GRN-2', poId: 'po-2', warehouseId: 'W1', receivedBy: 'u-recv', receivedAt: AT, availableMinor: 8000,
      captured: { requiresApproval: true, discrepancyValue: { minor: 15_000, currency: 'INR' }, discrepancies: [{ lineId: 'l1', productId: 'p-oil', kind: 'excess', quantityMinor: 2000, value: { minor: 15_000, currency: 'INR' }, requiresApproval: true, detail: '20 more than ordered' }],
        lines: [{ lineId: 'l1', productId: 'p-oil', sellableMinor: 8000, quarantinedMinor: 0, rejectedMinor: 0, disposition: 'sellable', uom: 'ea', batchId: null, expiry: null }] } },
    { grnId: 'g1', number: 'GRN-1', poId: 'po-1', warehouseId: 'W1', receivedBy: 'u-recv', receivedAt: AT, availableMinor: 10_000,
      captured: { requiresApproval: false, discrepancyValue: { minor: 0, currency: 'INR' }, discrepancies: [], lines: [{ lineId: 'l1', productId: 'p-rice', sellableMinor: 10_000, quarantinedMinor: 0, rejectedMinor: 0, disposition: 'sellable', uom: 'ea', batchId: null, expiry: null }] } },
  ] },
  '/v1/purchase/suppliers': { count: 2, needingAttentionCount: 1, owedMinor: 400_000, asAt: AT, suppliers: [
    { supplierId: 's-2', name: 'Kaveri Foods', status: 'proposed', blocked: false, proposedBy: 'u-buyer', bank: null, totals: totals(0), needsAttention: true, attention: ['awaiting_approval'] },
    { supplierId: 's-1', name: 'Amma Traders', status: 'active', blocked: false, proposedBy: 'u-buyer', bank: { accountRef: '****1234' }, totals: totals(400_000), needsAttention: false, attention: [] },
  ] },
  '/v1/finance/gst/controls': { controls: { reverseCharge: { value: false }, einvoice30DayGuard: { value: false }, timeBarWarningDays: { value: 180, decision: 'OB-191' } }, said: { reverseCharge: 'off', einvoice30DayGuard: 'off', timeBarWarningDays: '180' } },
  '/v1/finance/e-invoice/reporting-guard': { switchedOn: false, said: 'off' },
  '/v1/finance/filing-calendar': { nearBarNotJudged: false, entries: [{ type: 'GSTR3B', period: '082026', dueDate: '2026-09-20', timeBarDate: '2029-11-30', warning: 'overdue', daysOverdue: 28 }] },
  gstr3b: { basis: 'gstr1_filed_not_yet_locked', table31: { a: half(3_000_000), c: half(0), d: half(0) }, table4: { a3ReverseCharge: half(0), a5AllOther: { status: 'not_reconciled' } },
    reconciliation: { salesLedger: { netGrossMinor: 3_280_000 }, differences: [{ code: 'changed_after_gstr1_filed', explained: false, grossMinor: 10_500, detail: 'sale S-3 reached head office late' }] }, exceptions: [] },
  gstr9: { complete: false, dueDate: '2027-12-31', missing: [{ period: '082026', reason: 'not_filed' }] },
  gstr9c: { open: 0, dueDate: '2027-12-31' },
};
const GLOBALS: Record<string, Record<string, unknown>> = {
  'index.html': { sreNavigation: menu('dashboard'), managerData: MANAGER },
  'goods-receipt.html': { sreNavigation: menu('goods-receipt'), goodsReceiptData: { userId: 'u-mgr', permissions: ['inventory.availability.read'] } },
  'counts.html': { sreNavigation: menu('counts'), countsData: { userId: 'u-mgr', permissions: ['count.view'], rows: [
    { id: 'c1', productId: 'Rice 5kg', expectedMinor: 20, countedMinor: 16, varianceMinor: -4, valueMinor: 240_000, currency: 'INR', uom: 'ea', requiredApproval: true, adjusted: true, counterId: 'u-recv', approvedBy: 'u-boss' },
    { id: 'c2', productId: 'Milk 500ml', expectedMinor: 12, countedMinor: 14, varianceMinor: 2, currency: 'INR', uom: 'ea', requiredApproval: false, adjusted: true, counterId: 'u-recv' },
  ] } },
  'gst-returns.html': { sreNavigation: menu('gst-returns'), gstReturnsData: { userId: 'u-acct', permissions: ['finance.gstr.read', 'finance.gstr.approve', 'finance.gstr.submit'], rows: [
    { period: '082026', state: 'failed', detail: 'The portal rejected invoice B-2210.' }, { period: '062026', state: 'filed', arn: 'AA3306260012345' },
  ] } },
  'suppliers.html': { sreNavigation: menu('suppliers'), suppliersData: { userId: 'u-acct', permissions: ['supplier.view', 'purchase.supplier.approve'] } },
};

async function serve(): Promise<{ base: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    void (async () => {
      const [path = '/', query = ''] = (req.url ?? '/').split('?');
      const bare = /(^|&)bare(&|=|$)/.test(query); // a page the store computer fed nothing
      const json = (body: unknown): void => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (path.startsWith('/v1/inventory/goods-receipt')) { json(ROUTES['/v1/inventory/goods-receipt']); return; }
      if (ROUTES[path] !== undefined) { json(ROUTES[path]); return; }
      if (path.startsWith('/v1/finance/gstr3b/')) { json(ROUTES['gstr3b']); return; }
      if (path.startsWith('/v1/finance/gstr9c/')) { json(ROUTES['gstr9c']); return; }
      if (path.startsWith('/v1/finance/gstr9/')) { json(ROUTES['gstr9']); return; }
      const file = path === '/' ? 'index.html' : path.replace(/^\//, '');
      try {
        let text = (await readFile(join(WEB_DIR, file))).toString('utf8');
        if (file.endsWith('.html') && !bare) {
          const tags = Object.entries(GLOBALS[file] ?? {}).map(([name, value]) => `<script>window.${name} = ${JSON.stringify(value).replace(/</g, '\\u003c')};</script>`).join('');
          text = text.replace('<!--SCREEN-DATA-->', tags);
        }
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream';
        res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
        res.end(text);
      } catch {
        res.writeHead(404); res.end('not found');
      }
    })();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      resolve({ base: `http://127.0.0.1:${port}`, stop: () => new Promise((done) => { server.close(() => { done(); }); server.closeAllConnections(); }) });
    });
  });
}

/** What the polish promised, measured on the rendered page (plain JavaScript source: the tests have no DOM library). */
const MEASURE = String.raw`(() => {
  const d = document;
  const main = d.querySelector('main');
  const shown = (el) => { const r = el.getBoundingClientRect(); if (r.width === 0 || r.height === 0) return false; for (let n = el; n; n = n.parentElement) { const s = getComputedStyle(n); if (s.display === 'none' || s.visibility === 'hidden') return false; } return true; };
  const name = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/).join('.') : '');
  const out = { overflow: [], small: [], chips: [], money: [], sticky: [], columns: [], pageScroll: d.documentElement.scrollWidth > d.documentElement.clientWidth + 1 };
  const mr = main.getBoundingClientRect();
  // 1. nothing runs past main's edge or is cut off by its own box (an ellipsis cut is the tab tiles' own design, outside main)
  for (const el of main.querySelectorAll('*')) {
    if (!shown(el) || el.closest('.sr-only, .sr-cap')) continue;
    const r = el.getBoundingClientRect();
    if (r.right > mr.right + 1 || r.left < mr.left - 1) out.overflow.push(name(el) + ' @' + Math.round(r.left) + '–' + Math.round(r.right) + ' in ' + Math.round(mr.left) + '–' + Math.round(mr.right));
    const s = getComputedStyle(el);
    if ((s.overflowX === 'hidden' || s.overflowX === 'clip') && el.scrollWidth > el.clientWidth + 1 && !el.classList.contains('stats')) out.overflow.push(name(el) + ' clips its content');
  }
  // 2. nothing a person must read under 14px (uppercase letter-spaced labels may be 12.5px)
  const walker = d.createTreeWalker(main, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement; if (!el || !(n.textContent || '').trim() || !shown(el) || el.closest('.sr-only, .sr-cap')) continue;
    const s = getComputedStyle(el); const px = parseFloat(s.fontSize);
    if (px < 14 && !(s.textTransform === 'uppercase' && px >= 12.5)) out.small.push(name(el) + ' ' + px + 'px "' + n.textContent.trim().slice(0, 30) + '"');
  }
  // 3. every status in a list wears a shape from the one set beside a word
  for (const st of main.querySelectorAll('.rows .status, .rows .state, .rows .pill, #approval-rows .blocked')) {
    if (!shown(st)) continue;
    const word = (st.textContent || '').replace(/[✓✕⚠◑◔▲▼⛔❗]/g, '').trim();
    if (st.querySelector('svg.sre-icon') === null || word === '') out.chips.push(name(st) + ' "' + (st.textContent || '').trim().slice(0, 30) + '"');
  }
  // 3b. an icon is never alone: it sits in a holder that has words (the same hosts the one set's own e2e allows)
  const hosts = 'a, button, [role="button"], .sre-badge, .sre-chip, .sre-with-icon, p, li, label, .tile, .branch, .sre-find-wrap, .sre-update';
  for (const svg of main.querySelectorAll('svg')) {
    if (!shown(svg)) continue;
    const host = svg.closest(hosts);
    if (!svg.classList.contains('sre-icon') || host === null || (host.textContent || '').trim() === '') out.chips.push('icon without its words: ' + svg.getAttribute('data-icon') + ' in ' + name(svg.parentElement));
  }
  // 4. money in a register is right-aligned in tabular figures
  for (const el of main.querySelectorAll('.rows li, .rows .row')) {
    if (!shown(el)) continue;
    for (const cell of el.querySelectorAll('*')) {
      if (cell.children.length > 0 || !/^[−-]?₹[\d,]+\.\d\d$/.test((cell.textContent || '').trim()) || !shown(cell)) continue;
      const s = getComputedStyle(cell); const p = getComputedStyle(cell.parentElement);
      const right = s.textAlign === 'right' || s.textAlign === 'end' || p.textAlign === 'right' || p.justifyItems === 'end' || s.justifySelf === 'end';
      if (!right || !/tabular-nums/.test(s.fontVariantNumeric)) out.money.push(name(cell) + ' "' + cell.textContent.trim() + '" align=' + s.textAlign + ' nums=' + s.fontVariantNumeric);
    }
  }
  // 5. a register with rows has a caption row that stays on screen (sticky), and its second column starts at one x for every row
  for (const list of main.querySelectorAll('#rows, #approval-rows')) {
    const rows = [...list.children].filter(shown);
    if (rows.length === 0) continue;
    const head = list.parentElement && list.parentElement.querySelector(':scope > .reg-head');
    if (window.innerWidth >= 1000) {
      if (!head || !shown(head) || getComputedStyle(head).position !== 'sticky') out.sticky.push(name(list) + ' has no sticky caption row');
      const xs = new Set(rows.map((r) => { const c = r.children[1]; return c ? Math.round(c.getBoundingClientRect().left) : -1; }));
      if (xs.size > 1) out.columns.push(name(list) + ' second column starts at ' + [...xs].join(', '));
    }
  }
  return out;
})()`;

interface Measure { overflow: string[]; small: string[]; chips: string[]; money: string[]; sticky: string[]; columns: string[]; pageScroll: boolean }

const PAGES: readonly { readonly key: string; readonly file: string; readonly ready: string; readonly tab?: string }[] = [
  { key: 'today', file: 'index.html', ready: '#tiles .tile' },
  { key: 'approvals', file: 'index.html', ready: '#tiles .tile', tab: '#tab-approvals' },
  { key: 'day close', file: 'index.html', ready: '#tiles .tile', tab: '#tab-close' },
  { key: 'goods receipt', file: 'goods-receipt.html', ready: '#rows li.row' },
  { key: 'counts', file: 'counts.html', ready: '#rows li.row' },
  { key: 'gst returns', file: 'gst-returns.html', ready: '#differences li' },
  { key: 'suppliers', file: 'suppliers.html', ready: '#rows li.row' },
];
const WIDTHS = [1440, 1280, 360] as const;

describe.skipIf(!HAVE_BROWSER)('OB-205 · the office pages, polished inside the approved look', () => {
  let browser: Browser;
  let srv: { base: string; stop: () => Promise<void> };

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    if (WEB_DIR !== 'apps/web-erp/web') execFileSync('cp', ['apps/web-erp/web/web-erp.bundle.js', join(WEB_DIR, 'web-erp.bundle.js')]);
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
    srv = await serve();
  }, 180_000);
  afterAll(async () => { await browser?.close(); await srv?.stop(); });

  async function open(file: string, width: number, errors: string[]): Promise<Page> {
    const phone = width === 360;
    const context = await browser.newContext({ viewport: { width, height: phone ? 740 : 900 }, ...(phone ? { hasTouch: true, isMobile: true } : {}) });
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !/favicon\.ico/.test(m.location().url)) errors.push(m.text()); });
    await page.goto(`${srv.base}/${file}`, { waitUntil: 'load' });
    await page.waitForFunction('globalThis.sreChrome !== undefined', undefined, { timeout: 15_000 });
    return page;
  }
  const settle = (page: Page): Promise<unknown> => page.waitForFunction('document.getAnimations().every((a) => a.playState !== "running")', undefined, { timeout: 5_000 });

  it('every page, at 1440 · 1280 · 360 in English and at 1280 in Tamil: nothing overflows, no console error, audit clean; registers with sticky captions, aligned columns, right-aligned tabular money, chips that wear their shape, nothing under 14px', async () => {
    const found: Record<string, unknown> = {};
    for (const p of PAGES) {
      for (const [width, lang] of [...WIDTHS.map((w) => [w, 'en'] as const), [1280, 'ta'] as const]) {
        const where = `${p.key}@${width}/${lang}`;
        const errors: string[] = [];
        const page = await open(p.file, width, errors);
        try {
          await page.waitForSelector(p.ready, { timeout: 10_000 });
          if (lang === 'ta') { await page.click('#lang'); await page.waitForFunction('document.documentElement.lang === "ta"'); }
          if (p.tab !== undefined) await page.evaluate(`document.querySelector(${JSON.stringify(p.tab)}).click()`);
          if (p.key === 'day close') {
            await page.evaluate('document.getElementById("check-close").click()');
            await page.click('#banner-ok');
          }
          await settle(page);
          const m = await page.evaluate(MEASURE) as Measure;
          const problems = Object.fromEntries(Object.entries(m).filter(([k, v]) => (k === 'pageScroll' ? v === true : (v as string[]).length > 0)));
          const audit = await auditPage(page, { expectLang: lang });
          if (audit.length > 0) problems['audit'] = audit;
          if (errors.length > 0) problems['errors'] = errors;
          // The page's own heading is in the reader's language.
          if (lang === 'ta' && !/[\u0B80-\u0BFF]/.test((await page.textContent('#who')) ?? '')) problems['heading'] = `the heading is not in Tamil: ${(await page.textContent('#who')) ?? ''}`;
          if (Object.keys(problems).length > 0) found[where] = problems;
        } finally {
          await page.context().close();
        }
      }
    }
    expect(found).toEqual({});
  }, 300_000);

  it('a hidden subpage is hidden: the Today band is drawn on Today only — never above Approvals or the day close', async () => {
    for (const width of WIDTHS) {
      const page = await open('index.html', width, []);
      try {
        await page.waitForSelector('#tiles .tile');
        const bandShown = (): Promise<boolean> => page.evaluate('getComputedStyle(document.getElementById("view-home")).display !== "none"') as Promise<boolean>;
        expect(await bandShown(), `Today@${width}`).toBe(true);
        // the band's figures line up: tiles on one row have their figures at one height (a tile that needs you once
        // lost its padding to the list's `.attention` rule and sat higher than its neighbours)
        const misaligned = await page.evaluate(`(() => { const rows = new Map(); for (const t of document.querySelectorAll('#tiles .tile')) {
          const top = Math.round(t.getBoundingClientRect().top); const n = Math.round(t.querySelector('.n').getBoundingClientRect().top);
          rows.set(top, [...(rows.get(top) ?? []), n]); } return [...rows.values()].filter((ns) => new Set(ns).size > 1); })()`);
        expect(misaligned, `Today figures@${width}`).toEqual([]);
        await page.evaluate('document.getElementById("tab-approvals").click()');
        expect(await bandShown(), `Approvals@${width}`).toBe(false);
        await page.evaluate('document.getElementById("tab-close").click()');
        expect(await bandShown(), `Close the day@${width}`).toBe(false);
      } finally {
        await page.context().close();
      }
    }
  }, 60_000);

  it('"not known" is said with its shape and its reason — never a zero, never a blank box', async () => {
    // the approvals inbox a screen the box never fed: "Not known", why, and the shape — not the "nothing waiting" look
    const inbox = await open('index.html?bare&tab=approvals', 1280, []);
    try {
      await inbox.waitForSelector('#approvals-empty:not([hidden])');
      expect(await inbox.textContent('#approvals-empty')).toMatch(/^Not known — ./);
      expect(await inbox.getAttribute('#approvals-empty', 'class')).toBe('state-block unknown');
      expect(await inbox.getAttribute('#approvals-empty svg', 'data-icon')).toBe('circle-help');
    } finally {
      await inbox.context().close();
    }

    const counts = await open('counts.html', 1280, []);
    try {
      await counts.waitForSelector('#rows li.row');
      // a count the box holds without a money value
      expect(await counts.textContent('#rows li.row:nth-child(2) .val')).toBe('Value not known');
      expect(await counts.getAttribute('#rows li.row:nth-child(2) .val svg', 'data-icon')).toBe('circle-help');
      // no bare copy key ever reaches the screen
      expect(await counts.textContent('main')).not.toMatch(/neededApproval|approvedByLabel|counterLabel/);
    } finally {
      await counts.context().close();
    }
    const gst = await open('gst-returns.html', 1280, []);
    try {
      await gst.waitForSelector('[data-figure="4a5"]');
      expect(await gst.textContent('[data-figure="4a5"]')).toBe('NOT KNOWN — not yet reconciled');
      expect(await gst.getAttribute('[data-figure="4a5"] svg', 'data-icon')).toBe('circle-help');
    } finally {
      await gst.context().close();
    }
  }, 60_000);

  it('forms say what to do: help under the field, and an inline error that names the fix — the GST month and the day close', async () => {
    const gst = await open('gst-returns.html', 1280, []);
    try {
      await gst.waitForSelector('#period-help');
      expect(await gst.textContent('#period-help')).toBe('Six digits: the month, then the year — for example 052026.');
      expect(await gst.getAttribute('#period', 'aria-describedby')).toBe('period-help');
      await gst.fill('#period', '13-26');
      await gst.click('#show');
      expect(await gst.getAttribute('#period', 'aria-invalid')).toBe('true');
      expect(await gst.textContent('#period-help')).toBe('Write the month as MMYYYY, e.g. 052026.');
      await gst.click('#lang');
      expect(await gst.textContent('#period-help')).toBe('மாதத்தை MMYYYY ஆக எழுதுங்கள், எ.கா. 052026.');
    } finally {
      await gst.context().close();
    }
    const close = await open('index.html', 1280, []);
    try {
      await close.waitForSelector('#tiles .tile');
      expect(await close.getAttribute('#close-pin', 'aria-describedby')).toBe('close-pin-hint');
      expect(await close.textContent('#close-pin-hint')).toMatch(/^Up to six digits\./);
      expect(await close.getAttribute('#check-close svg', 'data-icon')).toBe('list-checks');
    } finally {
      await close.context().close();
    }
  }, 60_000);

  it('the drawer: its close says so and wears the cross, it takes the focus as it opens, and Escape closes it with the answer Cancel gives', async () => {
    const page = await open('index.html', 1280, []);
    try {
      await page.evaluate('document.getElementById("tab-approvals").click()');
      await page.waitForSelector('#approval-rows .row-actions button');
      await page.click('#approval-rows .row-actions button.primary');
      await page.waitForSelector('#sheet:not([hidden])');
      expect((await page.textContent('#sheet-cancel'))?.trim()).toBe('Cancel');
      expect(await page.getAttribute('#sheet-cancel svg', 'data-icon')).toBe('x');
      expect(await page.evaluate('document.getElementById("sheet").contains(document.activeElement)')).toBe(true);
      await page.keyboard.press('Escape');
      expect(await page.evaluate('document.getElementById("sheet").hidden')).toBe(true);
      // Cancel's answer: nothing decided, the request still waiting
      expect(await page.locator('#approval-rows .row-actions button.primary').count()).toBeGreaterThan(0);
    } finally {
      await page.context().close();
    }
  }, 60_000);
});
