import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser, type Page, type Request } from 'playwright-core';
import { ROLE_CATALOGUE, OWNER_ROLE_ID } from '../../services/api/src/roles';
import { shopDay } from '../../packages/calendar/src/shop-day';
import { instantOf } from '../../packages/calendar/src/trading-day';
import { theEvening } from '../support/evening-clock';

/**
 * **OB-608 (owner, 29 Oct 2026 · round 15, R15-A) — the five forms that take a date-time typed by hand read what is typed
 * as the SHOP's clock, on a device that is NOT set to India time.**
 *
 * Every browser here runs in New York (`timezoneId: 'America/New_York'`) with its clock pinned to the most recent 19:30 UTC
 * (tests/support/evening-clock.ts) — 01:00 the next morning in the shop. A person types the shop's "00:45" of that morning
 * into each form — dock booking (from/until), CCTV clip (from/to), competitor price "seen at", month-end payment time,
 * incident timeline "when it happened" — and the page must send the instant 00:45 means IN THE SHOP (19:15 UTC), never
 * 00:45 New York (04:45 UTC — what `new Date(typed)` sent before round 15). The zone comes from what the store computer
 * served the page (`window.shopTimeZone`, from its signed pack) — no network call. Records already stored are not touched.
 *
 * Each write is answered by a stand-in that records its body; every other `/v1/` read gets 503 (offline). Skips where no
 * browser binary is present.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const SHOP_ZONE = 'Asia/Kolkata';
const DEVICE_ZONE = 'America/New_York';
const OWNER = 'u-owner';
const OWNER_PERMISSIONS = ROLE_CATALOGUE.find((r) => r.id === OWNER_ROLE_ID)!.permissions;

const { at: AT } = theEvening();
const DAY = shopDay(SHOP_ZONE, () => AT);
/** What the person types: 00:45 and 00:50 on the shop's today (the pinned moment is the shop's 01:00). */
const TYPED_FROM = `${DAY.today()}T00:45`;
const TYPED_TO = `${DAY.today()}T00:50`;
const MEANT_FROM = instantOf(TYPED_FROM, SHOP_ZONE);
const MEANT_TO = instantOf(TYPED_TO, SHOP_ZONE);
/** What the device's own clock made of it before round 15 — must never be sent. */
const NY_FROM = instantOf(TYPED_FROM, DEVICE_ZONE);

let served: { readonly global: string; readonly data: unknown } | undefined;
let pageErrors: string[] = [];

function startServer(): Promise<{ base: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname.includes('/v1/')) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'offline', whatHappened: 'offline' } }));
        return;
      }
      const [, app = '', ...rest] = url.pathname.split('/');
      const file = rest.join('/') || 'index.html';
      try {
        let body = (await readFile(join('apps', app, 'web', file))).toString('utf8');
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.json') || file.endsWith('.webmanifest') ? 'application/json' : 'application/octet-stream';
        if (file.endsWith('.html')) {
          const json = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');
          const globals: Record<string, unknown> = { shopTimeZone: SHOP_ZONE, ...(served === undefined ? {} : { [served.global]: served.data }) };
          body = body.replace('<!--SCREEN-DATA-->', `<script>${Object.entries(globals).map(([k, v]) => `window.${k} = ${json(v)};`).join(' ')}</script>`);
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

const answer = (page: Page, glob: string, body: unknown) => page.route(glob, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }));

/** Record the body of every POST to `glob` (answered 200 `{}`); GETs to it go on to the next handler. */
async function recordPosts(page: Page, glob: string): Promise<Record<string, unknown>[]> {
  const bodies: Record<string, unknown>[] = [];
  await page.route(glob, async (route, request: Request) => {
    if (request.method() !== 'POST') { await route.fallback(); return; }
    bodies.push(JSON.parse(request.postData() ?? '{}') as Record<string, unknown>);
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  return bodies;
}

describe.skipIf(!HAVE_BROWSER)(`OB-608: a date-time typed on a device in New York at ${AT} is the shop's clock`, () => {
  let browser: Browser;
  let server: { base: string; stop: () => Promise<void> };

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    server = await startServer();
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 600_000);
  afterAll(async () => { await browser?.close(); await server?.stop(); });

  const open = async (path: string, global: string, data: unknown, before?: (page: Page) => Promise<unknown>) => {
    served = { global, data };
    const context = await browser.newContext({ timezoneId: DEVICE_ZONE, serviceWorkers: 'block' });
    await context.clock.install({ time: new Date(AT) });
    const page = await context.newPage();
    const errors: string[] = [];
    pageErrors = errors;
    page.on('pageerror', (e) => { errors.push(`${String(e)} ${e.stack ?? ''}`); });
    if (before !== undefined) await before(page);
    await page.goto(`${server.base}/${path}`, { waitUntil: 'load' });
    // The device really is in New York: its own reading of what is typed is New York's.
    expect(await page.evaluate(`new Date(${JSON.stringify(TYPED_FROM)}).toISOString()`)).toBe(NY_FROM);
    return { page, errors, close: () => context.close() };
  };
  const sent = async (bodies: readonly Record<string, unknown>[], n = 1): Promise<void> => {
    try {
      await expect.poll(() => bodies.length, { timeout: 10_000 }).toBeGreaterThanOrEqual(n);
    } catch {
      throw new Error(`nothing was sent; page errors: ${pageErrors.join(' | ')}`);
    }
  };
  const ownerSees = (rest: Record<string, unknown> = {}) => ({ userId: OWNER, permissions: OWNER_PERMISSIONS, ...rest });

  it('the typed values and what they mean (the shop\'s 00:45 is not New York\'s)', () => {
    expect(MEANT_FROM).not.toBe(NY_FROM);
    expect(Date.parse(MEANT_FROM)).toBeLessThan(Date.parse(AT)); // in the shop's past: 15 minutes before the pinned 01:00
  });

  it('dock diary: a booking\'s from and until', async () => {
    let bodies: Record<string, unknown>[] = [];
    const p = await open('web-erp/dock-diary.html', 'dockDiaryData', ownerSees(), async (page) => { bodies = await recordPosts(page, '**/v1/inventory/dock-diary/**'); });
    try {
      await p.page.fill('#b-store', 'store-1');
      await p.page.fill('#b-door', 'dock-1');
      await p.page.fill('#b-from', TYPED_FROM);
      await p.page.fill('#b-until', TYPED_TO);
      await p.page.fill('#b-supplier', 'SUP-1');
      await p.page.click('#b-book');
      await sent(bodies);
      expect(bodies[0]).toMatchObject({ storeId: 'store-1', dockId: 'dock-1', startsAt: MEANT_FROM, endsAt: MEANT_TO });
      expect(p.errors).toEqual([]);
    } finally { await p.close(); }
  }, 60_000);

  it('investigations: a CCTV clip\'s from and to', async () => {
    let bodies: Record<string, unknown>[] = [];
    const p = await open('web-erp/loss-prevention.html', 'lossPreventionInboxData', ownerSees(), async (page) => { bodies = await recordPosts(page, '**/v1/loss-prevention/cases/*/cctv/*'); });
    try {
      await p.page.waitForSelector('#cctv-form:not([hidden])', { timeout: 10_000 });
      await p.page.fill('#cctv-case', 'case-608');
      await p.page.fill('#cctv-camera', 'CAM-3');
      await p.page.fill('#cctv-from', TYPED_FROM);
      await p.page.fill('#cctv-to', TYPED_TO);
      await p.page.fill('#cctv-by', OWNER);
      await p.page.click('#cctv-add');
      await sent(bodies);
      expect(bodies[0]).toEqual({ cameraId: 'CAM-3', from: MEANT_FROM, to: MEANT_TO, collectedBy: OWNER });
      expect(p.errors).toEqual([]);
    } finally { await p.close(); }
  }, 60_000);

  it('products and prices: a competitor price\'s "seen at"', async () => {
    let bodies: Record<string, unknown>[] = [];
    const product = { productId: 'p-dal', sku: 'DAL', name: 'Toor dal 1kg', baseUom: 'ea', primaryCategoryId: null, taxClass: null, status: 'active' };
    const p = await open('web-erp/catalogue.html?tab=rivals', 'catalogueData', ownerSees({ storeId: 'store-1', today: DAY.today(), now: AT, products: [product] }), async (page) => {
      bodies = await recordPosts(page, '**/v1/prices/competitor/*');
    });
    try {
      await p.page.waitForSelector('#rivals-form:not([hidden])', { timeout: 10_000 });
      await p.page.fill('#rival-competitor', 'Reliance Smart');
      await p.page.fill('#rival-price', '110');
      await p.page.fill('#rival-seen', TYPED_FROM);
      await p.page.click('#rival-record');
      await sent(bodies);
      expect(bodies[0]).toMatchObject({ productId: 'p-dal', storeId: 'store-1', competitor: 'Reliance Smart', priceMinor: 11_000, observedAt: MEANT_FROM });
      expect(p.errors).toEqual([]);
    } finally { await p.close(); }
  }, 60_000);

  it('month-end: the payment time read from the provider\'s statement', async () => {
    let bodies: Record<string, unknown>[] = [];
    const exception = {
      attemptId: 'PAY-608', state: 'open', kind: 'card', amountMinor: 64_000, storeId: 'store-1', laneId: 'L1', billRef: 'B-608', tradingDay: DAY.today(),
      stage: 'raised', closedBy: null, approvedBy: null, reason: '', governanceFlags: [], resolution: null, conflicts: [], lateAnswer: null,
    };
    const p = await open('web-erp/finance-close.html', 'financeCloseData', ownerSees({ period: DAY.thisMonth() }), async (page) => {
      bodies = await recordPosts(page, '**/v1/finance/payment-exceptions/*/resolve');
      await answer(page, '**/v1/finance/payment-exceptions', { open: 1, openMinor: { card: 64_000, upi: 0 }, owedToCustomersMinor: 0, flagged: [], exceptions: [exception] });
    });
    try {
      const row = '#pay-list li[data-attempt="PAY-608"]';
      await p.page.waitForSelector(`${row} details.resolve`, { timeout: 10_000 });
      await p.page.click(`${row} details.resolve summary`);
      await p.page.fill(`${row} input.at`, TYPED_FROM);
      await p.page.check(`${row} input.complete`);
      await p.page.click(`${row} button.go`);
      await sent(bodies);
      expect(bodies[0]).toEqual({ authorisations: [{ ref: 'PAY-608', amountMinor: 64_000, status: 'captured', at: MEANT_FROM }], statementComplete: true });
      expect(p.errors).toEqual([]);
    } finally { await p.close(); }
  }, 60_000);

  it('incidents: a timeline entry\'s "when it happened"', async () => {
    let bodies: Record<string, unknown>[] = [];
    const row = { incidentId: 'I-608', title: 'Till printer down', severity: 'sev2', state: 'open', openedAt: AT, openedBy: OWNER, openActions: 0, hasPostmortem: false };
    const detail = { ...row, summary: 'synthetic', timeline: [], actions: [], postmortem: null };
    const p = await open('web-erp/incidents.html', 'incidentsData', ownerSees({ permissions: [...OWNER_PERMISSIONS, 'platform.health.read', 'platform.alert.manage'] }), async (page) => {
      await answer(page, '**/v1/platform/incidents', { incidents: [row] });
      await answer(page, '**/v1/platform/incidents/I-608', { incident: detail });
      bodies = await recordPosts(page, '**/v1/platform/incidents/I-608/timeline');
    });
    try {
      await p.page.click('#incident-rows tr[data-incident="I-608"]', { timeout: 10_000 });
      await p.page.waitForSelector('#sheet:not([hidden])', { timeout: 10_000 });
      await p.page.fill('#t-when', TYPED_FROM);
      await p.page.fill('#t-note', 'Printer jammed on till 2');
      await p.page.click('#t-add');
      await sent(bodies);
      expect(bodies[0]).toMatchObject({ happenedAt: MEANT_FROM, note: 'Printer jammed on till 2' });
      expect(p.errors).toEqual([]);
    } finally { await p.close(); }
  }, 60_000);

  it('OB-610 — basket affinity: a drafted promotion runs whole shop days (00:00:00 to 23:59:59 in the shop, not UTC)', async () => {
    let bodies: Record<string, unknown>[] = [];
    const today = DAY.today();
    const view = {
      from: today, to: today, department: null, basketCount: 10, minBaskets: 3, belowMinimum: 0, returnsTakenOut: 0, productsWithoutCategory: 0, emptiedByReturns: 0,
      pairs: [{ productA: 'p-biscuit', productB: 'p-tea', basketCount: 4, basketsWithA: 4, basketsWithB: 7, support: 0.4, confidenceAtoB: 1, confidenceBtoA: 0.571, lift: 1.4286, suggestions: [] }],
    };
    const p = await open('web-erp/basket-affinity.html', 'basketAffinityData', ownerSees(), async (page) => {
      await answer(page, '**/v1/reporting/basket-affinity*', view);
      bodies = await recordPosts(page, '**/v1/promotions/*/definition');
    });
    try {
      await p.page.fill('#from', today);
      await p.page.fill('#to', today);
      await p.page.fill('#min', '3');
      await p.page.click('#show');
      const row = '#pairs li[data-pair="p-biscuit+p-tea"]';
      await p.page.waitForSelector(`${row} input.percent`, { timeout: 10_000 });
      await p.page.fill(`${row} input.percent`, '5');
      await p.page.fill(`${row} input.starts`, today);
      await p.page.fill(`${row} input.ends`, today);
      await p.page.click(`${row} button.draft-promo`);
      await sent(bodies);
      const startsAt = instantOf(`${today}T00:00`, SHOP_ZONE);
      const endsAt = new Date(Date.parse(instantOf(`${today}T23:59`, SHOP_ZONE)) + 59_000).toISOString();
      expect(bodies[0]).toMatchObject({ kind: 'percent_off', percentBps: 500, productIds: ['p-biscuit', 'p-tea'], startsAt, endsAt });
      expect(bodies[0]!['startsAt']).not.toBe(`${today}T00:00:00.000Z`); // the UTC day edge it sent before OB-610
      expect(Date.parse(AT)).toBeGreaterThanOrEqual(Date.parse(startsAt)); // the pinned moment (the shop's 01:00) is inside the shop's day
      expect(p.errors).toEqual([]);
    } finally { await p.close(); }
  }, 60_000);

  it('store tasks (round 13, the rule the five now share): a task\'s deadline', async () => {
    let bodies: Record<string, unknown>[] = [];
    const p = await open('web-erp/store-tasks.html', 'storeOpsData', ownerSees(), async (page) => { bodies = await recordPosts(page, '**/v1/hr/workforce/assigned-tasks/**'); });
    try {
      await p.page.waitForSelector('#a-due', { timeout: 10_000 });
      expect(await p.page.inputValue('#a-due')).toBe(DAY.endOfTodayField());
      await p.page.fill('#a-due', TYPED_FROM);
      expect(await p.page.evaluate(`window.sreShopDay.instantOfField(${JSON.stringify(TYPED_FROM)})`)).toBe(MEANT_FROM);
      expect(p.errors).toEqual([]);
      expect(bodies).toEqual([]); // nothing is sent until a person saves
    } finally { await p.close(); }
  }, 60_000);
});
