import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { ROLE_CATALOGUE, OWNER_ROLE_ID } from '../../services/api/src/roles';
import { shopDay } from '../../packages/calendar/src/shop-day';
import { theEvening } from '../support/evening-clock';

/**
 * **OB-607 (owner, 29 Oct 2026) — every time of day and date-time a screen shows is the SHOP's clock, on a device that is
 * NOT set to India time (round 14, R14-A).**
 *
 * Every browser here runs in New York (`timezoneId: 'America/New_York'`) with its clock pinned to the most recent 19:30 UTC
 * (tests/support/evening-clock.ts) — 01:00 the next morning in the shop, 15:30 the same afternoon in New York. Each screen is
 * handed a moment at that 19:30 UTC — in the data the store computer injects, or by a stand-in for the one read the page
 * makes — and must show 01:00 (the shop's), never 15:30 (New York's) or 19:30 (UTC). Before round 14 each showed 15:30
 * (`toLocaleString()`, `toLocaleTimeString()`, `getHours()`) or 19:30 (the ISO text sliced).
 *
 * The pages are served the way the store computer serves them, with the shop's zone from its signed pack
 * (`window.shopTimeZone`), and with NO cloud: every `/v1/` read the page makes unanswered by a stand-in gets 503 — offline,
 * the shop's clock still holds (no network call is needed for it). Skips where no browser binary is present.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const SHOP_ZONE = 'Asia/Kolkata';
const DEVICE_ZONE = 'America/New_York';
const OWNER = 'u-owner';
const OWNER_PERMISSIONS = ROLE_CATALOGUE.find((r) => r.id === OWNER_ROLE_ID)!.permissions;

const { at: AT } = theEvening();
const DAY = shopDay(SHOP_ZONE, () => AT);
/** The shop's clock of the pinned moment: 01:00 the next morning. */
const SHOP_TIME = DAY.timeOf(AT);
const SHOP_WHEN = DAY.dateTimeOf(AT);
/** What the device's own clock (New York) and the UTC clock say of it — neither may appear. */
const NY_TIME = shopDay(DEVICE_ZONE, () => AT).timeOf(AT);
const UTC_TIME = AT.slice(11, 16);
const later = (minutes: number): string => new Date(Date.parse(AT) + minutes * 60_000).toISOString();

const APPS = ['web-erp', 'pos', 'delivery-app', 'picker-app', 'warehouse-app', 'owner-app', 'customer-app', 'b2b-app', 'supplier-app', 'self-checkout', 'price-kiosk'] as const;

interface Served { readonly global?: string; readonly data?: unknown; readonly extra?: Record<string, unknown> }
let served: Served = {};
/** The script errors of the page open now (named when a check fails). */
let pageErrors: string[] = [];

function startServer(): Promise<{ base: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname === '/lane-stub/lane/sync-status') {
        res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
        res.end(JSON.stringify({ cloud: 'online', lastContactAt: AT, unsent: 0 }));
        return;
      }
      if (url.pathname.includes('/v1/') || url.pathname.startsWith('/lane-stub/')) {
        // No cloud and no lane: the offline case. A screen keeps what the box told it, and still shows the shop's clock.
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'offline' }));
        return;
      }
      const [, app = '', ...rest] = url.pathname.split('/');
      const file = rest.join('/') || 'index.html';
      try {
        let body = (await readFile(join('apps', app, 'web', file))).toString('utf8');
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.json') || file.endsWith('.webmanifest') ? 'application/json' : 'application/octet-stream';
        if (file.endsWith('.html')) {
          const json = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');
          const globals: Record<string, unknown> = { shopTimeZone: SHOP_ZONE, shellCachedAt: AT, ...(served.extra ?? {}) };
          if (served.global !== undefined) globals[served.global] = served.data;
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

describe.skipIf(!HAVE_BROWSER)(`OB-607: screens show the shop's clock on a device in New York at ${AT} (the shop's ${SHOP_WHEN})`, () => {
  let browser: Browser;
  let server: { base: string; stop: () => Promise<void> };

  beforeAll(async () => {
    for (const app of APPS) execFileSync('node', ['scripts/build-app.mjs', app], { stdio: 'ignore' });
    server = await startServer();
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 600_000);
  afterAll(async () => { await browser?.close(); await server?.stop(); });

  /** Open one page in New York at the pinned evening, served `serve`; `before` adds stand-ins for its reads. */
  const open = async (path: string, serve: Served, before?: (page: Page) => Promise<unknown>) => {
    served = serve;
    const context = await browser.newContext({ timezoneId: DEVICE_ZONE, serviceWorkers: 'block' });
    await context.clock.install({ time: new Date(AT) });
    const page = await context.newPage();
    const errors: string[] = [];
    pageErrors = errors;
    page.on('pageerror', (e) => { errors.push(String(e)); });
    if (before !== undefined) await before(page);
    await page.goto(`${server.base}/${path}`, { waitUntil: 'load' });
    // The device really is in New York: its own clock says 15:30.
    expect(await page.evaluate('String(new Date().getHours()).padStart(2, "0") + ":" + String(new Date().getMinutes()).padStart(2, "0")')).toBe(NY_TIME);
    return { page, errors, close: () => context.close() };
  };

  /** The element's text once it holds `want`; it must hold neither the device's nor the UTC clock of the moment. */
  const shows = async (page: Page, selector: string, want: string): Promise<string> => {
    try {
      await page.waitForFunction(`(document.querySelector(${JSON.stringify(selector)})?.textContent ?? '').includes(${JSON.stringify(want)})`, undefined, { timeout: 10_000 });
    } catch {
      throw new Error(`${selector} never showed "${want}"; it shows: "${(await page.textContent(selector, { timeout: 1_000 }).catch(() => null)) ?? '(missing)'}"; page errors: ${pageErrors.join(' | ')}`);
    }
    const text = (await page.textContent(selector)) ?? '';
    expect(text, selector).not.toContain(NY_TIME);
    expect(text, selector).not.toContain(UTC_TIME);
    return text;
  };

  const ownerSees = (rest: Record<string, unknown> = {}) => ({ userId: OWNER, permissions: OWNER_PERMISSIONS, ...rest });

  describe('the "this is an old copy" strip on every app — the time the copy was taken, at the shop\'s clock', () => {
    for (const app of APPS) {
      it(app, async () => {
        const p = await open(`${app}/index.html`, {});
        try { await shows(p.page, '#stale', SHOP_WHEN); } finally { await p.close(); }
      }, 60_000);
    }
  });

  describe('the till and the handhelds: "last contact" with head office, as the store computer said it', () => {
    for (const [app, selector] of [['pos', '#conn-detail'], ['delivery-app', '#box-text'], ['picker-app', '#box-text'], ['warehouse-app', '#box-text']] as const) {
      it(app, async () => {
        const p = await open(`${app}/index.html`, { extra: { laneWriteBase: `${server.base}/lane-stub` } });
        try { await shows(p.page, selector, SHOP_TIME); } finally { await p.close(); }
      }, 60_000);
    }
  });

  describe('the office pages', () => {
    it('the chrome\'s connection badge: "last contact" at the shop\'s clock', async () => {
      const p = await open('web-erp/production.html', { global: 'productionData', data: ownerSees(), extra: { laneWriteBase: `${server.base}/lane-stub` } });
      try { await shows(p.page, '.sre-badge', SHOP_TIME); expect(p.errors).toEqual([]); } finally { await p.close(); }
    }, 60_000);

    it('production: the board "as of"', async () => {
      const p = await open('web-erp/production.html', { global: 'productionData', data: ownerSees({ board: { asAt: AT, ageMinutes: 0, runs: [], recipes: [], enabledDepartments: [] } }) });
      try { await shows(p.page, '#board-asof', SHOP_WHEN); expect(p.errors).toEqual([]); } finally { await p.close(); }
    }, 60_000);

    const SNAPSHOTS = [
      ['suppliers.html', 'suppliersData', { asAt: AT, suppliers: [] }],
      ['goods-receipt.html', 'goodsReceiptData', { asAt: AT, receipts: [] }],
      ['indents.html', 'indentsData', { asAt: AT, indents: [] }],
      ['stock-health.html', 'stockHealthData', { availability: [], asAt: { availability: AT } }],
    ] as const;
    for (const [file, global, snapshot] of SNAPSHOTS) {
      it(`${file.replace('.html', '')}: the list's "as of"`, async () => {
        const p = await open(`web-erp/${file}`, { global, data: ownerSees({ snapshot }) });
        try { await shows(p.page, '#asof', SHOP_WHEN); expect(p.errors).toEqual([]); } finally { await p.close(); }
      }, 60_000);
    }

    it('unsellable: the catalogue\'s "as of"', async () => {
      const p = await open('web-erp/unsellable.html', { global: 'unsellableData', data: { storeId: 'S1', asAt: AT, rows: [], sellableCount: 3 } });
      try { await shows(p.page, '#asof', SHOP_WHEN); expect(p.errors).toEqual([]); } finally { await p.close(); }
    }, 60_000);

    it('the manager\'s Today: a card payment\'s time of day (round 13 left it on the device\'s clock)', async () => {
      const p = await open('web-erp/index.html', {
        global: 'managerData',
        data: ownerSees({
          tradingDay: DAY.today(), tradingDayCutoff: '00:00',
          cardPayments: { tradingDay: DAY.today(), paid: [{ at: AT, laneId: 'L1', kind: 'card', amountMinor: 12_300, machineRef: null, saleId: 'S-607' }], unresolved: [], refundsOnMachine: [], paidTotalMinor: 12_300, refundedTotalMinor: 0 },
        }),
      });
      try {
        await p.page.click('#tab-close');
        await shows(p.page, '#card-day-paid', SHOP_TIME);
        expect(p.errors).toEqual([]);
      } finally { await p.close(); }
    }, 60_000);

    it('store tasks: a task\'s deadline', async () => {
      const p = await open('web-erp/store-tasks.html', { global: 'storeOpsData', data: ownerSees() }, (page) => answer(page, '**/v1/hr/workforce/assigned-tasks', {
        tasks: [{ taskId: 'T-607', title: 'Face up aisle 4', assignedTo: 'u-ravi', branchId: 'br-1', status: 'pending', dueAt: AT, detail: 'synthetic' }],
      }));
      try { await shows(p.page, '#rows li[data-task="T-607"]', SHOP_WHEN); } finally { await p.close(); }
    }, 60_000);

    it('store tasks: a relabel task — from when it is due, and when it was done', async () => {
      const done = later(10);
      const p = await open('web-erp/store-tasks.html', { global: 'storeOpsData', data: ownerSees() }, (page) => answer(page, '**/v1/pricing/relabel-tasks*', {
        open: 0, tasks: [{ taskId: 'RL-607', productId: 'P-607', priceMinor: 4_500, branchId: 'br-1', locationId: null, dueAt: AT, because: 'price_change', dueNow: false, done: { doneBy: 'u-ravi', doneAt: done, shelfPriceMinor: 4_500 } }],
      }));
      try {
        const text = await shows(p.page, '#relabel-rows li[data-task="RL-607"]', SHOP_WHEN);
        expect(text).toContain(DAY.dateTimeOf(done));
      } finally { await p.close(); }
    }, 60_000);

    it('my tasks: my task\'s deadline', async () => {
      const p = await open('web-erp/my-tasks.html', { global: 'storeOpsData', data: ownerSees() }, (page) => answer(page, '**/v1/hr/workforce/my-tasks', {
        tasks: [{ taskId: 'T-608', title: 'Check the chiller', assignedTo: OWNER, branchId: 'br-1', status: 'pending', dueAt: AT, detail: 'synthetic', evidenceRequired: false, completion: { at: AT } }],
      }));
      try { await shows(p.page, 'li[data-task="T-608"]', SHOP_WHEN); } finally { await p.close(); }
    }, 60_000);

    it('food safety: a check\'s time slot and a delivery checklist\'s time', async () => {
      const p = await open('web-erp/food-safety.html', { global: 'storeOpsData', data: ownerSees() }, (page) => answer(page, '**/v1/facilities/food-safety/status*', {
        checks: [], slots: [{ checkId: 'chk-607', title: 'Chiller temperature', slotDueAt: AT, state: 'due' }],
        receiving: [{ recordId: 'rec-607', subjectRef: 'GRN-607', outcome: 'pass', performedBy: 'u-ravi', performedAt: later(5) }],
      }));
      try {
        await shows(p.page, '#rows li[data-check="chk-607"]', SHOP_TIME);
        await shows(p.page, '#receiving-rows', DAY.timeOf(later(5)));
      } finally { await p.close(); }
    }, 60_000);

    it('recall trace: when a recall was started', async () => {
      const p = await open('web-erp/recall-trace.html', { global: 'recallTraceData', data: ownerSees() }, (page) => answer(page, '**/v1/quality/recalls', {
        recalls: [{ batchId: 'B-607', status: 'open', reason: 'synthetic recall', initiatedBy: OWNER, initiatedAt: AT }],
      }));
      try { await shows(p.page, '#r-rows li[data-batch="B-607"]', SHOP_WHEN); } finally { await p.close(); }
    }, 60_000);

    it('held returns: since when a returned unit has been held', async () => {
      const p = await open('web-erp/held-returns.html', { global: 'heldReturnsData', data: ownerSees() }, (page) => answer(page, '**/v1/returns/held-stock/worklist', {
        items: [{ heldId: 'H-607', productId: 'MILK-1', quantityMinor: 1, uom: 'each', state: 'held', returnId: 'R-607', batchId: null, locationId: null, heldAt: AT, decisions: [] }],
      }));
      try { await shows(p.page, 'li[data-held-id="H-607"]', SHOP_WHEN); } finally { await p.close(); }
    }, 60_000);

    it('AI drafts: when an anomaly summary was asked for', async () => {
      const p = await open('web-erp/ai-drafts.html', { global: 'aiDraftsData', data: ownerSees() }, async (page) => {
        await answer(page, '**/v1/notifications/templates', { templates: [] });
        await answer(page, '**/v1/ai/security/anomaly-summaries', { summaries: [{ summaryId: 's-607', at: AT, requestedBy: OWNER, citedEvidenceIds: ['e-1'], text: 'synthetic summary', suggestedOrder: [] }] });
      });
      try { await shows(p.page, '#anom-list', SHOP_WHEN); } finally { await p.close(); }
    }, 60_000);

    it('approvals: when a request was asked (DD-MM-YYYY HH:MM, was a fixed +05:30)', async () => {
      const p = await open('web-erp/approvals.html', { global: 'approvalsData', data: ownerSees() }, (page) => answer(page, '**/v1/approvals/requests', {
        waitingForMe: [], asAt: AT,
        mine: [{ requestId: 'AR-607', kind: 'price_change', label: 'Price change', subjectRef: 'P-607', valueMinor: null, details: {}, summary: 'synthetic', reason: 'synthetic', requestedBy: OWNER, requestedAt: AT, status: 'waiting' }],
      }));
      try { await shows(p.page, '#mine', `${SHOP_WHEN.slice(8, 10)}-${SHOP_WHEN.slice(5, 7)}-${SHOP_WHEN.slice(0, 4)} ${SHOP_TIME}`); } finally { await p.close(); }
    }, 60_000);

    it('AI control: when the AI was stopped, and the screen\'s "as at"', async () => {
      const control = {
        agents: [], proposals: { list: [] }, budget: { capMinor: 0, spentMinor: 0, platformCeilingMinor: 0 }, forbidden: [],
        killSwitch: { masterOn: false, active: [{ scope: 'all_ai', activatedBy: OWNER, activatedAt: AT, reason: 'synthetic' }], history: [] },
        provider: { known: false }, models: [], freeText: { enabled: false }, incidents: [], modelCalls: [], decisions: [], asAt: AT,
      };
      const p = await open('web-erp/ai.html', { global: 'aiData', data: ownerSees() }, (page) => answer(page, '**/v1/ai/control', control));
      try {
        await shows(p.page, '#kill-state', SHOP_WHEN);
        await shows(p.page, '#kill-list', SHOP_WHEN);
      } finally { await p.close(); }
    }, 60_000);

    it('incidents: when an incident was opened', async () => {
      const p = await open('web-erp/incidents.html', { global: 'incidentsData', data: ownerSees({ permissions: [...OWNER_PERMISSIONS, 'platform.health.read'] }) }, async (page) => {
        await answer(page, '**/v1/platform/incidents', { incidents: [{ incidentId: 'I-607', title: 'Till printer down', severity: 'sev2', state: 'open', openedAt: AT, openedBy: OWNER, openActions: 0, hasPostmortem: false }] });
      });
      try { await shows(p.page, '#incident-rows tr[data-incident="I-607"]', SHOP_WHEN); } finally { await p.close(); }
    }, 60_000);

    it('store computers: since when a store computer has held its bill prefix', async () => {
      const p = await open('web-erp/store-computers.html', { global: 'storeComputersData', data: ownerSees() }, (page) => answer(page, '**/v1/store-computers/prefix-bindings', {
        bindings: [{ storeId: 'S-607', prefix: 'A7', computer: 'u-box', via: 'first_binding', since: AT }],
      }));
      try { await shows(p.page, '#binding-rows tr[data-store="S-607"]', SHOP_WHEN); } finally { await p.close(); }
    }, 60_000);

    it('supplier submissions: when a supplier\'s document was received', async () => {
      const p = await open('web-erp/supplier-submissions.html', { global: 'supplierSubmissionsData', data: ownerSees() }, async (page) => {
        await answer(page, '**/v1/supplier-portal/review-queue', { waiting: [{ submissionId: 'SUB-607', partnerId: 'p-607', kind: 'invoice', receivedAt: AT, submittedBy: 'supplier-user', document: { supplierInvoiceNumber: 'INV-1' } }] });
        await answer(page, '**/v1/purchase/vmi-proposals', { proposals: [] });
      });
      try { await shows(p.page, '#q-rows li[data-submission="SUB-607"]', SHOP_WHEN); } finally { await p.close(); }
    }, 60_000);
  });

  /**
   * Every page whose script changed for OB-607 opens in New York with no script error, and its shop's day reads the shop's
   * clock from the zone the store computer served — the check a broken script (round 14 found one) cannot pass.
   */
  describe('every changed page opens without a script error, on the shop\'s clock', () => {
    const PAGES: readonly (readonly [string, string])[] = [
      ['dispatch', 'dispatchData'], ['dock-diary', 'dockDiaryData'], ['recall-trace', 'recallTraceData'], ['production', 'productionData'], ['ai-drafts', 'aiDraftsData'],
      ['food-safety', 'storeOpsData'], ['suppliers', 'suppliersData'], ['goods-receipt', 'goodsReceiptData'], ['facilities', 'facilitiesData'], ['supplier-bills', 'supplierBillsData'],
      ['setup', 'setupData'], ['unsellable', 'unsellableData'], ['held-returns', 'heldReturnsData'], ['indents', 'indentsData'], ['return-governance', 'returnGovernanceData'],
      ['stock-health', 'stockHealthData'], ['ai', 'aiData'], ['index', 'managerData'], ['count-plans', 'countPlansData'], ['incidents', 'incidentsData'],
      ['store-tasks', 'storeOpsData'], ['store-computers', 'storeComputersData'], ['my-tasks', 'storeOpsData'], ['ess', 'essData'], ['supplier-submissions', 'supplierSubmissionsData'],
      ['company-report', 'companyReportData'], ['approvals', 'approvalsData'],
    ];
    for (const [page, global] of PAGES) {
      it(page, async () => {
        const p = await open(`web-erp/${page}.html`, { global, data: ownerSees() });
        try {
          await shows(p.page, '#stale', SHOP_WHEN);
          expect(await p.page.evaluate(`window.sreShopDay.timeOf(${JSON.stringify(AT)})`)).toBe(SHOP_TIME);
          expect(p.errors).toEqual([]);
        } finally { await p.close(); }
      }, 60_000);
    }
  });
});
