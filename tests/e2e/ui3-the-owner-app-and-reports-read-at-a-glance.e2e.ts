import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { prepareTillBox, signInTill } from '../support/till-operator';
import { bootPos } from '../../apps/pos/src/browser-entry';
import { ERP_NAVIGATION } from '../../apps/web-erp/src/navigation';
import { shopDateIn, DEFAULT_SHOP_CALENDAR } from '../../packages/calendar/src/shop-clock';

/**
 * **UI-3: the owner app reads at a glance on a phone, and the report pages say what they cover and draw honest charts —
 * in a real browser, served by the real store computer, over head office's real routes (M29-FR-01/02 · D13 · P-01 · P-03 ·
 * P-08 · NFR-07/08 · design system §4.3).**
 *
 * A real till rings three bills on the store computer (no product has a cost, so the margin is not known) and the pack
 * holds two approvals; head office holds bills at two branches and a month's company roll-up. Through Chromium:
 *   • the owner's phone at 360px: the takings lead in big type; the margin says "Not known"; the average basket is the
 *     takings ÷ every bill and the "Taken today" drill lists every bill (OB-640);
 *     the decision counts; the three trend charts (by shop hour, the last days, how today was paid) each say what they
 *     cover, carry the same figures in a table a button shows, and the hour is the SHOP's; the "no signal" strip shows
 *     when the phone goes offline; Tamil throughout; no sideways scroll and every control ≥ 44px — light and dark;
 *   • a cashier is refused the owner's screen and the reports (403, none of the figures);
 *   • the office report pages at 1280px and 360px: Reports draws "What is selling, by department" and "Sales by hour" (on
 *     the shop's clock, OB-639), Compare side by side draws head office's ranking, the Company report
 *     draws its branches, Waste analytics and the Morning brief say what they cover and when head office answered.
 * Synthetic data only. Without a browser binary it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['ui3', 'glance', 'box', 'signing', 'key'].join('-').padEnd(48, '0');
const TENANT = randomUUID();
const OWNER = 'u-owner'; const CASHIER = 'u-cash';
const TODAY = shopDateIn(new Date().toISOString());

type Doc = { documentElement: { scrollWidth: number; clientWidth: number; dataset: Record<string, string> }; querySelectorAll(s: string): ArrayLike<{ getBoundingClientRect(): { width: number; height: number }; textContent: string | null; offsetParent: unknown }> };

describe.skipIf(!HAVE_BROWSER)('UI-3: the owner app and the reports read at a glance', () => {
  let browser: Browser; let ho: ApiHarness; let edge: EdgeProcess; let dir: string;
  const stops: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    execFileSync('node', ['scripts/build-app.mjs', 'owner-app'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
    ho = apiHarness();
    await ho.seedOwner(TENANT, OWNER);
    await ho.provisionRole(TENANT, CASHIER, 'cashier');
    const ok = async (r: Promise<{ status: number; body: unknown }>, what: string): Promise<void> => { const x = await r; if (x.status >= 300) throw new Error(`${what}: ${JSON.stringify(x.body)}`); };
    await ok(ho.request({ method: 'POST', path: '/v1/catalogue/products/P-RICE/publish', userId: OWNER, tenantId: TENANT, idempotencyKey: 'pub-rice', body: { product: { sku: 'SKU-RICE', name: 'Rice', baseUom: 'ea', primaryCategoryId: 'grocery', taxClass: '1006', lifecycle: 'active', handling: 'ambient' }, categories: [{ categoryId: 'grocery', name: 'grocery', parentId: null }] } }), 'publish');
    for (const [n, branch, unit] of [[1, 'store-1', 30_000], [2, 'store-2', 50_000]] as const) {
      await ok(ho.request({ method: 'POST', path: '/v1/sales', userId: OWNER, tenantId: TENANT, idempotencyKey: `sale-${n}`, body: {
        saleId: `H-${n}`, receiptNumber: `R-H-${n}`, laneId: `lane-${branch}`, locationId: branch, cashierId: 'u-c1', tradingDay: TODAY, committedAt: new Date(Date.now() - 5_000).toISOString(),
        totalMinor: unit, currency: 'INR', packVersion: 1,
        lines: [{ productId: 'P-RICE', quantityMinor: 1, uom: 'ea', unitPriceMinor: unit, lineTotalMinor: unit }], tenders: [{ kind: 'cash', amountMinor: unit }],
      } }), `sale ${n}`);
    }
    await ok(ho.request({ method: 'POST', path: '/v1/org/nodes/co-1', userId: OWNER, tenantId: TENANT, idempotencyKey: 'org-co', body: { kind: 'company', name: 'Test Company' } }), 'co');
    for (const [b, name, gross] of [['store-1', 'Test North', 1_250_000], ['store-2', 'Test South', 830_000]] as const) {
      await ok(ho.request({ method: 'POST', path: `/v1/org/nodes/${b}`, userId: OWNER, tenantId: TENANT, idempotencyKey: `org-${b}`, body: { kind: 'branch', name, parentId: 'co-1', companyId: 'co-1' } }), b);
      await ok(ho.request({ method: 'POST', path: '/v1/consolidation/memberships', userId: OWNER, tenantId: TENANT, idempotencyKey: `mem-${b}`, body: { branchId: b, parentId: 'co-1', from: '2026-01-01' } }), `mem ${b}`);
      await ok(ho.request({ method: 'POST', path: '/v1/consolidation/contributions', userId: OWNER, tenantId: TENANT, idempotencyKey: `con-${b}`, body: { branchId: b, period: TODAY.slice(0, 7), family: 'sales', measures: { grossMinor: gross, netMinor: gross - 1_000 }, lastRefreshAt: new Date(Date.now() - 60_000).toISOString(), revision: 1 } }), `con ${b}`);
    }

    // OB-641: a waste record now, so the waste trend has a real day to draw.
    await ok(ho.request({ method: 'POST', path: '/v1/waste/records/wr-1', userId: OWNER, tenantId: TENANT, idempotencyKey: 'wr-1', body: { branchId: 'store-1', departmentId: 'bakery', productId: 'BREAD', at: new Date(Date.now() - 60_000).toISOString(), valueMinor: 2_500, disposal: 'composted', source: 'expiry' } }), 'waste record');
    dir = await mkdtemp(join(tmpdir(), 'sre-ui3-glance-'));
    const everything = [...new Set(['identity.self.read', 'reporting.report.read', ...ERP_NAVIGATION.map((i) => i.requires)])];
    const ready = await prepareTillBox({
      dir, key: KEY, people: [{ userId: 'u-meena', displayName: 'Meena' }],
      pack: {
        lossPreventionRules: [],
        // The shop's own setting: the day ends at midnight, so the box's trading day and the shop's date agree at every hour (W3).
        policies: { storeId: 'store-1', branchId: 'store-1', branchName: 'Test Store', warehouseId: 'S1-BACK', tradingDayCutoff: '00:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 0 },
        receiptSeries: [{ laneId: 'lane-1', prefix: 'MS-', padTo: 6, rangeStart: 1, rangeEnd: 999, bankedThrough: 0 }],
        approvals: [
          { id: 'a1', subjectType: 'purchase_order', subjectRef: 'PO-1 · Rice, 200 bags', requestedBy: 'u-buyer', branchId: 'store-1', valueMinor: 8_120_000 },
          { id: 'a2', subjectType: 'price_change', subjectRef: 'Toor dal 1kg', requestedBy: 'u-buyer', branchId: 'store-1', valueMinor: 45_000 },
        ],
        reportingRecords: ['sales_rung_at_the_till', 'departments_on_the_catalogue', 'the_boxs_own_outbox'],
        reportingPolicy: { laggingAfterMinutes: 5, staleAfterMinutes: 60, userId: OWNER },
        roles: [{ id: 'owner', name: 'Owner', permissions: everything }, { id: 'cashier-only', name: 'Cashier', permissions: ['identity.self.read', 'pos.sale.read'] }],
        roleAssignments: [{ userId: OWNER, roleId: 'owner', branchScope: 'all' }, { userId: CASHIER, roleId: 'cashier-only', branchScope: ['store-1'] }],
      },
    });
    edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: TENANT, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0',
      EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_SCREEN_TRUST_FORWARDED_USER: '1', ...ready,
    }, () => {}))!;
    // The shop's zone, as the box serves it to every till page: the till dates each bill on the shop's day, as the box dates
    // "today" — never on this machine's UTC date (18:30–24:00 UTC the UTC date is the shop's yesterday).
    const till = bootPos({ laneId: 'lane-1', taxPercent: 0, lanePort: edge.lane!.port, timeZone: DEFAULT_SHOP_CALENDAR.timeZone });
    await signInTill(till, 'u-meena');
    for (const [i, [desc, price, qty]] of ([['Toor dal 1kg', 14_800, 2], ['Rice 5kg', 42_000, 1], ['Milk 1L', 6_000, 3]] as const).entries()) {
      till.scan({ productId: `P${i}`, description: desc, unitPriceMinor: price, qty });
      await till.tenderCash(`S-${i}`, await till.nextReceipt(), new Date().toISOString());
      till.newSale();
    }
    // The box re-reads its log on a request; the first read starts it.
    await (await fetch(`http://127.0.0.1:${edge.screens!.port}/owner/`, { headers: { 'x-sre-user': OWNER } })).text();
    await new Promise((r) => setTimeout(r, 400));
  }, 300_000);
  afterAll(async () => { await browser?.close(); await edge?.stop(); if (dir !== undefined) await rm(dir, { recursive: true, force: true }); });
  afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop(); });

  const open = async (who: string, path: string, width: number, height = 860): Promise<{ page: Page; errors: string[]; setOffline: (o: boolean) => Promise<void> }> => {
    const context = await browser.newContext({ viewport: { width, height }, serviceWorkers: 'block', extraHTTPHeaders: { 'x-sre-user': who } });
    stops.push(() => context.close());
    await context.route('**/v1/**', async (route) => {
      const req = route.request(); const url = new URL(req.url()); const raw = req.postData();
      const answer = await ho.request({
        method: req.method() as 'GET', path: url.pathname, userId: who, tenantId: TENANT,
        ...(raw === null ? {} : { body: JSON.parse(raw) as unknown }),
        ...(req.headers()['idempotency-key'] === undefined ? {} : { idempotencyKey: req.headers()['idempotency-key'] }),
        ...(url.search === '' ? {} : { query: Object.fromEntries(url.searchParams) }),
      });
      await route.fulfill({ status: answer.status, contentType: 'application/json', body: JSON.stringify(answer.body ?? {}) });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const res = await page.goto(`http://127.0.0.1:${edge.screens!.port}${path}`, { waitUntil: 'load' });
    expect(res?.status(), `${path} is served to ${who}`).toBe(200);
    return { page, errors, setOffline: (o) => context.setOffline(o) };
  };

  /** No sideways scroll, and every visible control in `scope` at least 44px each way (a tick box is measured by the label that wraps it, §5.1). */
  const fits = async (page: Page, scope: string, what: string): Promise<void> => {
    const { sideways, small, wide } = await page.evaluate((sel) => {
      const d = (globalThis as unknown as { document: Doc }).document;
      const small: string[] = [];
      for (const n of Array.from(d.querySelectorAll(`${sel} button, ${sel} a[href], ${sel} select, ${sel} input:not([type="checkbox"]):not([type="radio"]), ${sel} label:has(> input[type="checkbox"])`))) {
        if (n.offsetParent === null) continue;
        const r = n.getBoundingClientRect();
        if (r.width < 44 || r.height < 44) small.push(`${(n.textContent ?? '').trim().slice(0, 40)} ${Math.round(r.width)}x${Math.round(r.height)}`);
      }
      // what sticks out, so a failure names it
      const wide: string[] = [];
      for (const n of Array.from(d.querySelectorAll('body *:not(.sr-only):not(.sr-only *)')) as unknown as { getBoundingClientRect(): { right: number }; tagName: string; id: string; className: string }[]) {
        if (n.getBoundingClientRect().right > d.documentElement.clientWidth + 1) wide.push(`${n.tagName}#${n.id}.${String(n.className).slice(0, 30)}`);
      }
      return { sideways: d.documentElement.scrollWidth - d.documentElement.clientWidth, small, wide: wide.slice(0, 6) };
    }, scope);
    expect(sideways, `${what} scrolls sideways: ${JSON.stringify(wide)}`).toBeLessThanOrEqual(0);
    expect(small, `${what} has controls under 44px`).toEqual([]);
  };
  const text = async (page: Page, sel: string): Promise<string> => (await page.textContent(sel)) ?? '';

  it('the owner\'s phone at 360px: takings first, every bill counted, "Not known" never ₹0.00, decisions counted, honest trend charts, offline said', async () => {
    const { page: p, errors, setOffline } = await open(OWNER, '/owner/', 360, 780);
    await p.waitForSelector('#kpis button.kpi.lead');
    // the takings lead, in big type
    expect(await text(p, '#kpis .kpi.lead .label')).toBe('Taken today');
    expect(await text(p, '#kpis .kpi.lead .value')).toBe('₹896.00');
    expect(await p.$eval('#kpis .kpi.lead .value', (n) => parseFloat((globalThis as unknown as { getComputedStyle(e: unknown): { fontSize: string } }).getComputedStyle(n).fontSize))).toBeGreaterThanOrEqual(32);
    // no bill has a cost: the margin is "Not known" with the reason; the average basket is the takings ÷ EVERY bill (OB-640)
    // — ₹896.00 ÷ 3 — where it used to say ₹0.00
    expect(await text(p, '#kpis [data-kpi="margin"] .value')).toBe('Not known');
    expect(await text(p, '#kpis [data-kpi="averageBasket"] .value')).toBe('₹298.67');
    // OB-640: the "Taken today" drill lists every bill, and its total is the tile's
    await p.click('#kpis .kpi.lead');
    await p.waitForSelector('#drill:not([hidden])');
    expect(await p.$$eval('#drill-lines .drill-line', (n) => n.length)).toBe(3);
    expect(await text(p, '#drill-total')).toBe('₹896.00');
    await p.click('#drill-close');
    expect(await text(p, '#kpis [data-kpi="baskets"] .value')).toBe('3');
    // the sentence is kept (OB-618), and the decisions are counted
    expect(await text(p, '#headline')).toContain('3 bills today, ₹896.00 taken');
    expect(await text(p, '#approvals-count')).toBe('(2)');
    expect(await text(p, '#alerts-count')).toBe('(0)');
    // the freshness line carries the time, at the shop's clock
    expect(await text(p, '#asof')).toMatch(/^· as at \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
    // the one branch is not offered as a choice
    expect(await p.isHidden('#branches')).toBe(true);

    // the trend: three charts, each saying what it covers, the hour the SHOP's
    for (const id of ['hour', 'days', 'tender']) expect(await p.isVisible(`figure[data-chart="${id}"]`), id).toBe(true);
    const shopHour = await p.evaluate(() => (globalThis as unknown as { sreShopDay: { dateTimeOf(v: string): string } }).sreShopDay.dateTimeOf(new Date().toISOString()).slice(11, 13));
    expect(await p.$$eval('figure[data-chart="hour"] tbody tr', (trs) => trs.map((tr) => (tr as unknown as { dataset: { key: string } }).dataset.key))).toEqual([shopHour]);
    expect(await text(p, 'figure[data-chart="hour"] tbody')).toContain('₹896.00 · 3 bills');
    expect(await text(p, 'figure[data-chart="hour"] .sre-chart-covers')).toMatch(/^Today at Test Store, by the shop clock · money on the bills, before refunds · read at \d{4}-/);
    expect(await text(p, 'figure[data-chart="days"] .sre-chart-col')).toContain('today');
    expect(await text(p, 'figure[data-chart="tender"] .sre-chart-row')).toMatch(/^Cash.*₹896\.00$/);
    // the picture is hidden from screen readers; the table behind it is shown by one button and back
    expect(await p.getAttribute('figure[data-chart="tender"] .sre-chart-drawing', 'aria-hidden')).toBe('true');
    const tableHidden = (): Promise<boolean> => p.$eval('figure[data-chart="tender"] .sre-chart-table-wrap', (n) => (n as unknown as { classList: { contains(c: string): boolean } }).classList.contains('sr-only'));
    expect(await tableHidden()).toBe(true);
    await p.click('figure[data-chart="tender"] .sre-chart-toggle');
    expect(await tableHidden()).toBe(false);
    expect(await p.isVisible('figure[data-chart="tender"] .sre-chart-drawing')).toBe(false);
    expect(await text(p, 'figure[data-chart="tender"] .sre-chart-toggle')).toBe('Show the chart');
    await p.click('figure[data-chart="tender"] .sre-chart-toggle');

    await fits(p, 'body', 'the owner app at 360px');
    // dark
    await p.evaluate(() => { (globalThis as unknown as { document: Doc }).document.documentElement.dataset['theme'] = 'dark'; });
    await fits(p, 'body', 'the owner app at 360px, dark');

    // no signal on the phone: said in words
    expect(await p.isHidden('#offline')).toBe(true);
    await setOffline(true);
    await p.waitForSelector('#offline:not([hidden])');
    expect(await text(p, '#offline')).toMatch(/^No signal on this phone/);
    await setOffline(false);
    await p.waitForSelector('#offline[hidden]', { state: 'attached' });

    // Tamil, every word
    await p.click('#lang');
    expect(await text(p, '#kpis .kpi.lead .label')).toBe('இன்று வசூல்');
    expect(await text(p, '#kpis [data-kpi="margin"] .value')).toBe('தெரியவில்லை');
    expect(await text(p, 'figure[data-chart="tender"] .sre-chart-title')).toBe('இன்று எப்படிப் பணம் வந்தது');
    expect(await text(p, 'figure[data-chart="tender"] .sre-chart-row')).toContain('ரொக்கம்');
    await fits(p, 'body', 'the owner app at 360px in Tamil');
    expect(errors).toEqual([]);
  });

  it('a cashier is refused the owner\'s screen and the reports — none of the figures', async () => {
    for (const path of ['/owner/', '/reporting/', '/branch-compare/', '/company-report/']) {
      const context = await browser.newContext({ serviceWorkers: 'block', extraHTTPHeaders: { 'x-sre-user': CASHIER } });
      stops.push(() => context.close());
      const page = await context.newPage();
      const res = await page.goto(`http://127.0.0.1:${edge.screens!.port}${path}`, { waitUntil: 'load' });
      const body = await page.content();
      expect(body, `${path} shows the cashier a figure`).not.toContain('₹896.00');
      if (res?.status() === 200) {
        // served with nothing to ask: no figure, no chart
        expect(await page.$$('figure.sre-chart'), path).toHaveLength(0);
      } else expect(res?.status(), path).toBe(403);
    }
  });

  it('Reports at 1280px and 360px: what each report covers, the department and hour charts from the report\'s own rows', async () => {
    for (const width of [1280, 360]) {
      const { page: p, errors } = await open(OWNER, '/reporting/', width);
      await p.locator('#reports-list .row', { hasText: 'What is selling, by department' }).locator('button').click();
      await p.waitForSelector('figure[data-chart="units_by_category"]');
      expect(await text(p, '#report-covers')).toMatch(new RegExp(`^Store store-1 · trading day ${TODAY} · read from the store computer at \\d{4}-`));
      expect(await text(p, 'figure[data-chart="units_by_category"] tbody')).toContain('in no department6');
      // a figure's "as at" is the shop's clock, never the raw universal-time stamp
      expect(await text(p, '#report-figures')).not.toMatch(/\dT\d{2}:\d{2}.*Z/);
      await fits(p, 'main', `Reports at ${width}px`);
      await p.click('#back');
      await p.locator('#reports-list .row', { hasText: 'Sales by hour' }).locator('button').click();
      await p.waitForSelector('figure[data-chart="sales_by_hour"]');
      // OB-639: the hours are the SHOP's clock (they were the till's UTC) — the same hour the owner's phone shows
      const shopHour = await p.evaluate(() => (globalThis as unknown as { sreShopDay: { dateTimeOf(v: string): string } }).sreShopDay.dateTimeOf(new Date().toISOString()).slice(11, 13));
      expect(await p.$$eval('figure[data-chart="sales_by_hour"] tbody tr', (trs) => trs.map((tr) => (tr as unknown as { dataset: { key: string } }).dataset.key))).toEqual([`${shopHour}:00`]);
      expect(await text(p, 'figure[data-chart="sales_by_hour"]')).not.toContain('UTC');
      expect(await text(p, 'figure[data-chart="sales_by_hour"] tbody')).toContain('₹896.00');
      await fits(p, 'main', `Sales by hour at ${width}px`);
      expect(errors).toEqual([]);
    }
  });

  it('Compare side by side, the Company report, Waste analytics and the Morning brief say what they cover; the first two draw it', async () => {
    for (const width of [1280, 360]) {
      const c = await open(OWNER, '/branch-compare/', width);
      await c.page.waitForSelector('#form:not([hidden])');
      await c.page.click('#c-go');
      await c.page.waitForSelector('figure[data-chart="compare"]');
      expect(await c.page.$$eval('figure[data-chart="compare"] tbody tr', (trs) => trs.map((tr) => (tr as unknown as { dataset: { key: string } }).dataset.key))).toEqual(['store-2', 'store-1']);
      expect(await text(c.page, 'figure[data-chart="compare"] tbody')).toContain('₹500.00');
      expect(await text(c.page, 'figure[data-chart="compare"] .sre-chart-covers')).toMatch(new RegExp(`^Branches — takings · ${TODAY} to ${TODAY} · .*head office answered at \\d{4}-`));
      // the table the existing page keeps still holds every figure — now the shared register, with the shared cards
      expect(await text(c.page, '#r-total')).toBe('Total ₹800.00');
      expect(await c.page.$$eval('#r-register table.sre-register #r-rows tr', (trs) => trs.map((tr) => (tr as unknown as { dataset: { key: string } }).dataset.key))).toEqual(['store-2', 'store-1']);
      expect(await text(c.page, '#r-cards')).toContain('₹800.00');
      await c.page.click('#r-rows tr[data-key="store-1"] button[data-act="open"]');
      await c.page.waitForSelector('#tx-register table.sre-register #tx-rows tr[data-txn="H-1"]');
      await fits(c.page, 'main', `Compare at ${width}px`);
      expect(c.errors).toEqual([]);

      const r = await open(OWNER, '/company-report/', width);
      await r.page.waitForSelector('figure[data-chart="branches"]');
      expect(await text(r.page, '#covers')).toMatch(new RegExp(`^Test Company · month ${TODAY.slice(0, 7)} · Whole company · head office answered at \\d{4}-`));
      expect(await text(r.page, 'figure[data-chart="branches"] tbody')).toContain('Test North₹12,500.00');
      // the shared cards (keeping the tiles' names) and the shared register (keeping the rows' names)
      expect(await text(r.page, '#kpis .sre-summary-card.kpi .v[data-measure="grossMinor"]')).toBe('₹20,800.00');
      expect(await r.page.$$eval('#rows-register table.sre-register #rows tr', (trs) => trs.map((tr) => (tr as unknown as { dataset: { branch: string } }).dataset.branch)).then((b) => b.sort())).toEqual(['store-1', 'store-2']);
      await fits(r.page, 'main', `Company report at ${width}px`);
      expect(r.errors).toEqual([]);

      const w = await open(OWNER, '/waste-analytics/', width);
      await w.page.waitForFunction(() => ((globalThis as unknown as { document: Doc }).document.querySelectorAll('#wa-covers')[0]?.textContent ?? '') !== '' || ((globalThis as unknown as { document: Doc }).document.querySelectorAll('#page-status')[0]?.textContent ?? '') !== '');
      const covers = await text(w.page, '#wa-covers');
      expect(covers).toMatch(new RegExp(`^This store · from ${TODAY.slice(0, 7)}-01 to ${TODAY} · head office answered at \\d{4}-`));
      // OB-641: the trend by the shop's day, from head office's by-day read — today's ₹25.00, every other day "nothing recorded"
      await w.page.waitForSelector('figure[data-chart="wr-trend"]');
      expect(await text(w.page, `figure[data-chart="wr-trend"] tbody tr[data-key="${TODAY}"]`)).toContain('₹25.00 · 1 recorded');
      expect(await text(w.page, 'figure[data-chart="wr-trend"] .sre-chart-covers')).toContain('A day with no bar is a day with nothing recorded');
      expect(await text(w.page, '#wr-cards')).toContain('₹25.00');
      await w.page.waitForSelector('[data-breakdown="wr-reason"] table.sre-register tr[data-key="expiry"]');
      await fits(w.page, 'main', `Waste analytics at ${width}px`);
      expect(w.errors).toEqual([]);

      // Bill findings, Owner alerts, Bought together: the shared cards or states, each with its source line
      const f = await open(OWNER, '/findings/', width);
      await f.page.waitForFunction(() => (((globalThis as unknown as { document: Doc }).document.querySelectorAll('#s-covers')[0]?.textContent ?? '') !== '') || (((globalThis as unknown as { document: Doc }).document.querySelectorAll('#s-status')[0]?.textContent ?? '').length > 12));
      if ((await text(f.page, '#s-covers')) !== '') {
        expect(await text(f.page, '#s-covers')).toMatch(/^This store · the findings head office holds on its bills · read at \d{4}-/);
        expect(await f.page.$$('#s-cards .sre-summary-card')).toHaveLength(3);
      }
      await fits(f.page, 'main', `Bill findings at ${width}px`);
      expect(f.errors).toEqual([]);
      const a = await open(OWNER, '/owner-alerts/', width);
      await a.page.waitForFunction(() => ((globalThis as unknown as { document: Doc }).document.querySelectorAll('#d-covers')[0]?.textContent ?? '') !== '' || ((globalThis as unknown as { document: Doc }).document.querySelectorAll('#d-status')[0]?.textContent ?? '') !== '');
      if ((await text(a.page, '#d-covers')) !== '') {
        expect(await text(a.page, '#d-covers')).toMatch(new RegExp(`^This store · trading day ${TODAY} · read at \\d{4}-`));
        expect(await a.page.$$('#d-cards .sre-summary-card')).toHaveLength(3);
      }
      await fits(a.page, 'main', `Owner alerts at ${width}px`);
      expect(a.errors).toEqual([]);
      const ba = await open(OWNER, '/basket-affinity/', width);
      await fits(ba.page, 'main', `Bought together at ${width}px`);
      expect(ba.errors).toEqual([]);

      const b = await open(OWNER, '/morning-brief/', width);
      await b.page.waitForFunction(() => ((globalThis as unknown as { document: Doc }).document.querySelectorAll('#brief-covers')[0]?.textContent ?? '') !== '' || ((globalThis as unknown as { document: Doc }).document.querySelectorAll('#page-status')[0]?.textContent ?? '') !== '');
      const briefCovers = await text(b.page, '#brief-covers');
      if (briefCovers !== '') expect(briefCovers).toMatch(/^Trading day .* · head office answered at \d{4}-/);
      await fits(b.page, 'main', `Morning brief at ${width}px`);
      expect(b.errors).toEqual([]);
    }
  });
});
