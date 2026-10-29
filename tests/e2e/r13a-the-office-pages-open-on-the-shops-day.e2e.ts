import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { chromium, type Browser, type Page } from 'playwright-core';
import { apiHarness, TEST_IDP, type ApiHarness } from '../support/api-harness';
import { SqlIdempotencyStore, type HttpRequest } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';
import { shopDay } from '../../packages/calendar/src/shop-day';
import { theEvening } from '../support/evening-clock';

/**
 * **OB-606 (owner, 29 Oct 2026) — the office pages and the till's tag panel open on the SHOP's day, on a device that is
 * NOT set to India time (M01-FR-02 · P-08 · round 13, R13-A).**
 *
 * Every browser here runs in New York (`timezoneId: 'America/New_York'`, UTC−4) with its clock pinned to an evening
 * 19:30 UTC — 01:00 the next morning in the shop, 15:30 the same afternoon in New York. Two evenings: the most recent
 * 19:30 UTC already passed (tests/support/evening-clock.ts), and 19:30 UTC on 30 Sep 2026 — already 1 October in the
 * shop — so the month defaults are proven across a month end too. Before round 13 each page below opened on New York's
 * date (the shop's yesterday) or New York's month.
 *
 * Each office page is served the way the store computer serves it — with who is looking (head office's own
 * `/v1/identity/me`) and the shop's zone from its signed pack (`window.shopTimeZone`) — in front of the production API
 * surface (in memory, and over real PostgreSQL when DATABASE_URL is set). The till's concession-tag panel is served by a
 * real store computer with no cloud configured (offline). Skips where no browser binary is present.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const DATABASE_URL = process.env['DATABASE_URL'];
const WEB_DIR = 'apps/web-erp/web';
const OWNER = 'u-owner';
const SHOP_ZONE = 'Asia/Kolkata';
const DEVICE_ZONE = 'America/New_York';
const KEY = ['r13a', 'shop', 'day', 'key'].join('-').padEnd(48, '0');

/** The two evenings, and what the shop's day is at each (worked out by the shop's clock, not by this test's machine). */
const EVENINGS = [theEvening().at, '2026-09-30T19:30:00.000Z'].map((at) => ({ at, day: shopDay(SHOP_ZONE, () => at) }));

/** Which window global each page reads its screen data from (as the store computer injects it). */
const GLOBAL: Record<string, string> = {
  'day-book.html': 'dayBookData', 'gst-returns.html': 'gstReturnsData', 'buying.html': 'buyingData', 'migration.html': 'migrationData',
  'food-safety.html': 'storeOpsData', 'store-tasks.html': 'storeOpsData', 'facilities.html': 'facilitiesData', 'company-report.html': 'companyReportData',
  'index.html': 'managerData', 'posh-report.html': 'poshReportData',
  'customers.html': 'customersData', 'loyalty.html': 'loyaltyDeskData', 'owner-alerts.html': 'ownerAlertsData',
  'supplier-submissions.html': 'supplierSubmissionsData', 'production.html': 'productionData', 'ai.html': 'aiData', 'rollout.html': 'rolloutData',
};

async function startShell(h: ApiHarness, tenantId: string, extra: (file: string) => Record<string, unknown>): Promise<{ base: string; stop: () => Promise<void> }> {
  const token = TEST_IDP.issue({ sub: OWNER, tenantId });
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname.startsWith('/v1/')) {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const reply = await h.raw({
          method: (req.method ?? 'GET') as HttpRequest['method'], path: url.pathname, query: Object.fromEntries(url.searchParams), token,
          ...(req.headers['idempotency-key'] === undefined ? {} : { idempotencyKey: String(req.headers['idempotency-key']) }),
          ...(chunks.length === 0 ? {} : { body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }),
        });
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply.body));
        return;
      }
      const file = url.pathname.replace(/^\//, '') || 'index.html';
      try {
        let body = (await readFile(join(WEB_DIR, file))).toString('utf8');
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream';
        if (file.endsWith('.html')) {
          const me = (await h.raw({ method: 'GET', path: '/v1/identity/me', token })).body as { userId: string; permissions: string[] };
          const data = { userId: me.userId, permissions: me.permissions, ...extra(file) };
          const json = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');
          body = body.replace('<!--SCREEN-DATA-->', `<script>window.${GLOBAL[file] ?? 'screenData'} = ${json(data)};</script><script>window.shopTimeZone = ${json(SHOP_ZONE)};</script>`);
        }
        res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
        res.end(body);
      } catch {
        res.writeHead(404);
        res.end('not found');
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

/** Wait until a field holds exactly the value (never read in the same tick as the change). */
const holds = (page: Page, id: string, value: string) => page.waitForFunction(`document.getElementById(${JSON.stringify(id)})?.value === ${JSON.stringify(value)}`, undefined, { timeout: 10_000 });
/** Wait until an element's text (or a data attribute) is exactly the value. */
const reads = (page: Page, js: string, value: string) => page.waitForFunction(`${js} === ${JSON.stringify(value)}`, undefined, { timeout: 10_000 });

describe.skipIf(!HAVE_BROWSER)('OB-606: the office pages open on the shop\'s day on a device in New York, at 19:30 UTC', () => {
  let browser: Browser;
  let pool: Pool | undefined;
  let h: ApiHarness;
  let shell: { base: string; stop: () => Promise<void> };
  const T = randomUUID();
  const pageErrors: string[] = [];
  /** The manager's screen is told the trading day the box is running; each test sets it. */
  let managerTradingDay = '';

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    if (DATABASE_URL !== undefined) {
      pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
      await runMigrations(pgPoolClient(pool), readdirSync('db/migrations').filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join('db/migrations', name), 'utf8') })));
      const sql = pgPoolClient(pool);
      h = apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) });
    } else {
      h = apiHarness();
    }
    await h.seedOwner(T, OWNER);
    await h.provisionRole(T, 'u-ravi', 'cashier');
    // One company for the company report (head office's own structure, as the page reads it).
    expect((await h.request({ method: 'POST', path: '/v1/org/nodes/co-606', userId: OWNER, tenantId: T, idempotencyKey: 'org-co-606', body: { kind: 'company', name: 'Synthetic Company 606' } })).status).toBeLessThan(300);
    shell = await startShell(h, T, (file) => (file === 'index.html' ? { tradingDay: managerTradingDay, tradingDayCutoff: '00:00' } : {}));
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 180_000);
  afterAll(async () => { await browser?.close(); await shell?.stop(); await pool?.end(); expect(pageErrors).toEqual([]); });

  /** Open a page in New York at the pinned evening; every request the page makes is kept, to read what it asked for. */
  const open = async (file: string, at: string, before?: (page: Page) => Promise<unknown>): Promise<{ page: Page; asked: string[]; close: () => Promise<void> }> => {
    const context = await browser.newContext({ timezoneId: DEVICE_ZONE, serviceWorkers: 'block', acceptDownloads: true });
    await context.clock.install({ time: new Date(at) });
    const page = await context.newPage();
    if (before !== undefined) await before(page);
    const asked: string[] = [];
    page.on('request', (r) => { asked.push(r.url()); });
    page.on('pageerror', (e) => { pageErrors.push(`${file}: ${String(e)}`); });
    await page.goto(`${shell.base}/${file}`, { waitUntil: 'load' });
    // The device really is in New York, on the shop's yesterday (the case these pages got wrong).
    expect(await page.evaluate('new Date().getDate()')).toBe(Number(new Date(Date.parse(at) - 4 * 3_600_000).toISOString().slice(8, 10)));
    return { page, asked, close: () => context.close() };
  };

  for (const { at, day } of EVENINGS) {
    describe(`at ${at} (the shop's ${day.today()} 01:00)`, () => {
      it('day book opens on the shop\'s yesterday; GST returns on the shop\'s last month; buying\'s budget on the shop\'s month', async () => {
        const book = await open('day-book.html', at);
        try { await holds(book.page, 'day', day.daysAgo(1)); } finally { await book.close(); }
        const gst = await open('gst-returns.html', at);
        try {
          const mmyyyy = `${day.lastMonth().slice(5, 7)}${day.lastMonth().slice(0, 4)}`;
          await holds(gst.page, 'period', mmyyyy);
          // And head office is asked for that month, not New York's last month.
          await gst.page.waitForFunction(() => true);
          expect(gst.asked.some((u) => u.includes(`/v1/finance/gstr3b/${mmyyyy}`))).toBe(true);
        } finally { await gst.close(); }
        const buying = await open('buying.html', at);
        try { await holds(buying.page, 'budget-period', day.thisMonth()); } finally { await buying.close(); }
      }, 90_000);

      it('the company report asks head office for the shop\'s month', async () => {
        const c = await open('company-report.html', at);
        try {
          await expect.poll(() => c.asked.filter((u) => u.includes('/v1/consolidation?')).length, { timeout: 10_000 }).toBeGreaterThan(0);
          expect(c.asked.filter((u) => u.includes('/v1/consolidation?')).every((u) => new URL(u).searchParams.get('period') === day.thisMonth())).toBe(true);
        } finally { await c.close(); }
      }, 60_000);

      it('migration\'s parallel day opens on the shop\'s today', async () => {
        const m = await open('migration.html', at);
        try { await holds(m.page, 'day-date', day.today()); } finally { await m.close(); }
      }, 60_000);

      it('the food-safety board is the shop\'s today — its heading and head office asked from the shop\'s midnight', async () => {
        const f = await open('food-safety.html', at);
        try {
          await reads(f.page, "document.getElementById('today-h')?.dataset.day", day.today());
          // The date in words, worked out by the page's own shop's day (this browser's own words for a date are its own).
          await reads(f.page, "document.getElementById('today-h')?.textContent", await f.page.evaluate(`window.sreShopDay.dayWords(${JSON.stringify(day.today())}, 'en')`) as string);
          expect(await f.page.textContent('#today-h')).toMatch(new RegExp(`${Number(day.today().slice(8, 10))}.*${day.today().slice(0, 4)}`));
          await expect.poll(() => f.asked.some((u) => u.includes(`/v1/facilities/food-safety/status?from=${encodeURIComponent(day.startOfToday())}`)), { timeout: 10_000 }).toBe(true);
          await f.page.click('#lang');
          await reads(f.page, "document.getElementById('today-h')?.textContent", await f.page.evaluate(`window.sreShopDay.dayWords(${JSON.stringify(day.today())}, 'ta')`) as string);
        } finally { await f.close(); }
      }, 60_000);

      it('a new store task is due by the end of the SHOP\'s today, and head office holds that instant', async () => {
        const s = await open('store-tasks.html', at);
        try {
          await s.page.waitForFunction("document.body.dataset.taskDefaults === 'ready'", undefined, { timeout: 15_000 });
          expect(await s.page.inputValue('#a-due')).toBe(day.endOfTodayField());
          const title = `Face up aisle 4 (${at})`;
          await s.page.fill('#a-title', title);
          await s.page.fill('#a-person', 'u-ravi');
          await s.page.fill('#a-branch', 'br-1');
          await s.page.click('#a-save');
          await reads(s.page, "document.getElementById('assign-status')?.textContent", 'Assigned in your name.');
          // 23:59 in the SHOP — 18:29 UTC — never 23:59 in New York (03:59 UTC the next day, 09:29 in the shop).
          const tasks = (await h.request({ method: 'GET', path: '/v1/hr/workforce/assigned-tasks', userId: OWNER, tenantId: T })).body as { tasks: { title: string; dueAt: string }[] };
          expect(tasks.tasks.find((x) => x.title === title)?.dueAt).toBe(day.instantOfField(day.endOfTodayField()));
        } finally { await s.close(); }
      }, 60_000);

      it('the facilities board asks head office for what is overdue as at the shop\'s today', async () => {
        const f = await open('facilities.html', at);
        try {
          await expect.poll(() => f.asked.filter((u) => u.includes('/v1/facilities/overdue?asOf=')).length, { timeout: 10_000 }).toBeGreaterThan(0);
          expect(f.asked.filter((u) => u.includes('/v1/facilities/overdue?asOf=')).every((u) => u.endsWith(`asOf=${day.today()}`))).toBe(true);
        } finally { await f.close(); }
      }, 60_000);

      it('the manager\'s day close reads the shop\'s clock: the shop\'s yesterday HAS ended (New York says it has not)', async () => {
        managerTradingDay = day.daysAgo(1);
        const m = await open('index.html', at);
        try {
          await m.page.click('#tab-close');
          await m.page.click('#check-close');
          // Something is still open (nothing has been sent yet) — but never "the day has not ended".
          await m.page.locator('#blockers .blocker').first().waitFor({ timeout: 10_000 });
          expect(await m.page.textContent('#blockers')).not.toContain('The trading day has not ended yet');
        } finally { await m.close(); }
        // The check is live: the shop's TODAY has not ended, and the page says so.
        managerTradingDay = day.today();
        const live = await open('index.html', at);
        try {
          await live.page.click('#tab-close');
          await live.page.click('#check-close');
          await live.page.locator('#blockers .blocker', { hasText: 'The trading day has not ended yet' }).waitFor({ timeout: 10_000 });
          expect(await live.page.locator('#blockers .blocker[data-kind="day_not_ended"]').count()).toBe(1);
        } finally { await live.close(); }
      }, 60_000);
    });
  }

  /**
   * The dates SHOWN in the office lists. Each page is handed (by a stand-in for one head-office read, the shape the page
   * reads) a moment at the pinned 19:30 UTC — 01:00 the next morning in the shop — and must show the SHOP's date of it.
   * Before round 13 each showed New York's date (`toLocaleDateString()`), the shop's yesterday.
   */
  describe('the dates shown in the lists are the shop\'s dates of each moment', () => {
    const { at, day } = EVENINGS[0]!;
    const NY = day.daysAgo(1);
    const later = (days: number) => new Date(Date.parse(at) + days * 86_400_000).toISOString();
    const answer = (page: Page, glob: string, body: unknown) => page.route(glob, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }));
    /** The element's text, once the page has painted the shop's date into it. */
    const shows = async (page: Page, selector: string, date: string): Promise<string> => {
      await page.waitForFunction(`(document.querySelector(${JSON.stringify(selector)})?.textContent ?? '').includes(${JSON.stringify(date)})`, undefined, { timeout: 10_000 });
      return (await page.textContent(selector)) ?? '';
    };

    it('customers: a customer\'s last bill', async () => {
      const p = await open('customers.html', at, (page) => answer(page, '**/v1/customer/overview', {
        counts: { regular: 1 }, customers: [{ customerRef: 'CUST-606', segment: 'regular', orders: 2, lastOrderAt: at, profiled: true }],
        merges: { waitingForSecondPerson: [], inForce: [], reversed: [] },
      }));
      try { expect(await shows(p.page, '#customer-rows tr[data-customer="CUST-606"]', day.today())).not.toContain(NY); } finally { await p.close(); }
    }, 60_000);

    it('loyalty: when the referral rewards were last set', async () => {
      const p = await open('loyalty.html', at, (page) => answer(page, '**/v1/loyalty/referral-rewards', {
        referrer: { state: 'set', amountMinor: 5_000 }, referred: { state: 'set', amountMinor: 2_500 }, lastSetBy: OWNER, lastSetAt: at, lastReason: 'synthetic',
      }));
      try { expect(await shows(p.page, '#referral-say', day.today())).not.toContain(NY); } finally { await p.close(); }
    }, 60_000);

    it('owner alerts: when the kiosk hours were set', async () => {
      const p = await open('owner-alerts.html', at, (page) => answer(page, '**/v1/devices/floor-settings', {
        settings: [{ setting: 'kiosk_stale_after', value: 120, source: 'entry', setBy: OWNER, setAt: at }],
      }));
      try { expect(await shows(p.page, '#kiosk-from', day.today())).not.toContain(NY); } finally { await p.close(); }
    }, 60_000);

    it('supplier submissions: when a delivery update was received', async () => {
      const p = await open('supplier-submissions.html', at, (page) => answer(page, '**/v1/supplier-portal/orders/*/delivery-status', {
        latest: null, updates: [{ poId: 'PO-606', partnerId: 'p-606', status: 'dispatched', expectedOn: later(2).slice(0, 10), receivedAt: at }],
      }));
      try {
        await p.page.locator('#po-look').waitFor({ state: 'visible', timeout: 10_000 });
        await p.page.fill('#po-id', 'PO-606');
        await p.page.click('#po-look');
        // "… · received <the shop's date>" — New York's date of that moment is the shop's yesterday.
        expect(await shows(p.page, '#po-rows', day.today())).toMatch(new RegExp(`${day.today()}$`));
      } finally { await p.close(); }
    }, 60_000);

    it('facilities: an overdue check\'s due day (a plain date stays that date)', async () => {
      const p = await open('facilities.html', at, (page) => answer(page, '**/v1/facilities/overdue*', {
        overdue: [{ taskId: 't-606', scheduleId: 's-606', title: 'Fire extinguisher check', category: 'fire_safety', dueOn: day.today(), daysOverdue: 0, level: 'due', complianceLinked: true, detail: 'synthetic' }],
      }));
      try { expect(await shows(p.page, '#rows', day.today())).not.toContain(NY); } finally { await p.close(); }
    }, 60_000);

    it('production: a batch\'s expiry', async () => {
      const expires = later(2);
      const p = await open('production.html', at, (page) => answer(page, '**/v1/production/runs', {
        runs: [{
          runId: 'run-606', departmentId: 'bakery', outputProductId: 'BREAD-606', outputBatchId: 'B-606', outputQuantityMinor: 10, outputUom: 'each',
          expiresAt: expires, outputUnitCostMinor: 1_000, currency: 'INR', costKnown: true, uncostedProducts: [], yieldVerdict: 'as_expected', exceptions: [],
        }],
      }));
      try { expect(await shows(p.page, '#rows', day.dateOf(expires))).not.toContain(shopDay(DEVICE_ZONE, () => expires).today()); } finally { await p.close(); }
    }, 60_000);

    it('AI control: the day a model was approved', async () => {
      const p = await open('ai.html', at, (page) => page.route('**/v1/ai/control', async (route) => {
        const real = await route.fetch();
        const body = await real.json() as Record<string, unknown>;
        body['models'] = [{ modelId: 'model-606', adapterId: 'adapter-606', tier: 'standard', dataResidency: 'india', approvedBy: OWNER, approvedAt: at, state: 'approved', evaluationRunId: 'run-606' }];
        await route.fulfill({ response: real, json: body });
      }));
      try { expect(await shows(p.page, '#model-list', day.today())).not.toContain(NY); } finally { await p.close(); }
    }, 60_000);

    it('rollout: the consent record\'s file is named with the shop\'s date', async () => {
      const p = await open('rollout.html', at, (page) => answer(page, '**/v1/privacy/consent-manager/export', { counts: { records: 0, dataPrincipals: 0 } }));
      try {
        await p.page.locator('#cs-download').waitFor({ state: 'visible', timeout: 10_000 });
        const [file] = await Promise.all([p.page.waitForEvent('download', { timeout: 10_000 }), p.page.click('#cs-download')]);
        expect(file.suggestedFilename()).toBe(`consent-record-${day.today()}.json`);
      } finally { await p.close(); }
    }, 60_000);
  });
});

describe.skipIf(!HAVE_BROWSER)('OB-606: the till\'s concession-tag panel dates by the shop, offline, on a device in New York', () => {
  let browser: Browser;
  let dir = '';
  let edge: EdgeProcess | undefined;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
    dir = await mkdtemp(join(tmpdir(), 'sre-r13a-tags-'));
    // The store computer exactly as a one-PC install runs it, with NO cloud configured — the offline case.
    edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY,
      EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps',
    }, () => {}))!;
  }, 60_000);
  afterAll(async () => { await browser?.close(); await edge?.stop(); if (dir !== '') await rm(dir, { recursive: true, force: true }); });

  it('a docket line with no shift typed is filed under the SHOP\'s day, from the zone the box served — not New York\'s', async () => {
    const { at, day } = EVENINGS[0]!;
    const context = await browser.newContext({ timezoneId: DEVICE_ZONE });
    await context.clock.install({ time: new Date(at) });
    try {
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${edge!.screens!.port}/pos/concession-tag.html?lane=${edge!.lane!.port}`, { waitUntil: 'load' });
      // The box told the panel the shop's zone from its pack (no pack yet: the shop default) — no network call.
      expect(await page.evaluate('window.shopTimeZone')).toBe(SHOP_ZONE);
      const values: Record<string, string> = {
        capturedBy: 'cashier-anita', tillId: 'till-1', saleId: 'S-606', concessionaireId: 'jeweller-1', counterId: 'counter-gold',
        productId: 'ring-22k', qty: '1', grossMinor: '100000', discountMinor: '0', taxMinor: '3000', source: 'docket-606',
      };
      for (const [id, v] of Object.entries(values)) await page.fill(`#${id}`, v);
      await page.click('#record');
      await page.waitForFunction("document.getElementById('status')?.textContent?.includes('Saved') === true", undefined, { timeout: 10_000 });
      const records = await readLog(edge!.concessionTagsLog.path);
      const saved = records.map((r) => (r.ok ? JSON.parse(r.record) as { saleId: string; shiftId: string } : null)).find((r) => r?.saleId === 'S-606');
      expect(saved?.shiftId).toBe(`shift-${day.today()}`);
    } finally { await context.close(); }
  }, 60_000);
});
