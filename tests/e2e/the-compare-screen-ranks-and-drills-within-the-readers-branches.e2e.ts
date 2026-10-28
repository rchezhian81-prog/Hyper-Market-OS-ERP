import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { ERP_NAVIGATION } from '../../apps/web-erp/src/navigation';
import { shopDateIn } from '../../packages/calendar/src/shop-clock';

/**
 * **The Compare side by side page (M29-FR-02 · §27 Owner "branch comparison" · NFR-15 · §28) in a real browser, served by
 * the store computer, over head office's real governed drill and compare.**
 *
 * Head office holds today's bills at two branches — store-1 (₹300 of rice by cashier c1) and store-2 (₹500: milk ₹400 and
 * rice ₹100, by cashier c2). Through Chromium:
 *   • the owner ranks the BRANCHES: store-2 ₹500.00 first, store-1 ₹300.00, the rows add up to ₹800.00, "all branches";
 *     opening store-1 shows exactly its bill; ranking DEPARTMENTS shows dairy and grocery from the bill lines; ranking STAFF
 *     shows each cashier;
 *   • a store manager limited to store-1 asks for the same ranking and is shown ONLY store-1 (₹300.00, "Branches you can
 *     see: store-1") — the server decided, not the page; store-2's bill is nowhere on her screen;
 *   • a cashier is not offered the page's form at all; every drill is on head office's drill audit; the page speaks Tamil.
 * Synthetic data only. Without a browser binary it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['compare', 'screen', 'box', 'signing', 'key'].join('-').padEnd(48, '0');
const TENANT = randomUUID();
const OWNER = 'u-owner'; const MANAGER = 'u-mgr'; const CASH1 = 'u-c1'; const CASH2 = 'u-c2';
const TODAY = shopDateIn(new Date().toISOString());

describe.skipIf(!HAVE_BROWSER)('the Compare side by side page through the store computer (M29-FR-02)', () => {
  let browser: Browser;
  let ho: ApiHarness;
  let edge: EdgeProcess;
  let dir: string;
  const stops: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
    ho = apiHarness();
    await ho.seedOwner(TENANT, OWNER);
    await ho.provisionRole(TENANT, MANAGER, 'store_manager', ['store-1']);
    await ho.provisionRole(TENANT, CASH1, 'cashier');
    await ho.provisionRole(TENANT, CASH2, 'cashier');
    const ok = async (r: Promise<{ status: number; body: unknown }>, what: string): Promise<void> => { const x = await r; if (x.status >= 300) throw new Error(`${what}: ${JSON.stringify(x.body)}`); };
    for (const [id, cat] of [['P-MILK', 'dairy'], ['P-RICE', 'grocery']] as const) {
      await ok(ho.request({ method: 'POST', path: `/v1/catalogue/products/${id}/publish`, userId: OWNER, tenantId: TENANT, idempotencyKey: `pub-${id}`, body: { product: { sku: `SKU-${id}`, name: id, baseUom: 'ea', primaryCategoryId: cat, taxClass: '1006', lifecycle: 'active', handling: 'ambient' }, categories: [{ categoryId: cat, name: cat, parentId: null }] } }), `publish ${id}`);
    }
    const sale = (saleId: string, branch: string, cashier: string, lines: { productId: string; qty: number; unit: number }[]) => {
      const total = lines.reduce((t, l) => t + l.qty * l.unit, 0);
      return ok(ho.request({ method: 'POST', path: '/v1/sales', userId: cashier, tenantId: TENANT, idempotencyKey: `sale-${saleId}`, body: {
        saleId, receiptNumber: `R-${saleId}`, laneId: `lane-${branch}`, locationId: branch, cashierId: cashier, tradingDay: TODAY, committedAt: new Date(Date.now() - 5_000).toISOString(),
        totalMinor: total, currency: 'INR', packVersion: 1,
        lines: lines.map((l) => ({ productId: l.productId, quantityMinor: l.qty, uom: 'ea', unitPriceMinor: l.unit, lineTotalMinor: l.qty * l.unit })), tenders: [{ kind: 'cash', amountMinor: total }],
      } }), `sale ${saleId}`);
    };
    await sale('A-1', 'store-1', CASH1, [{ productId: 'P-RICE', qty: 6, unit: 5_000 }]);
    await sale('B-1', 'store-2', CASH2, [{ productId: 'P-MILK', qty: 4, unit: 10_000 }, { productId: 'P-RICE', qty: 2, unit: 5_000 }]);

    dir = await mkdtemp(join(tmpdir(), 'sre-compare-screen-'));
    const packFile = join(dir, 'store-pack.json');
    const everything = [...new Set(['identity.self.read', 'reporting.report.read', ...ERP_NAVIGATION.map((i) => i.requires)])];
    await writeFile(packFile, JSON.stringify({
      version: 1, lossPreventionRules: [], policies: { tradingDayCutoff: '02:00', storeId: 'store-1', branchId: 'store-1' },
      roles: [
        { id: 'owner', name: 'Owner', permissions: everything },
        { id: 'manager', name: 'Store manager', permissions: ['identity.self.read', 'owner.kpi.read', 'reporting.report.read'] },
        { id: 'cashier', name: 'Cashier', permissions: ['identity.self.read', 'pos.sale.read'] },
      ],
      roleAssignments: [{ userId: OWNER, roleId: 'owner', branchScope: 'all' }, { userId: MANAGER, roleId: 'manager', branchScope: ['store-1'] }, { userId: CASH1, roleId: 'cashier', branchScope: ['store-1'] }],
    }), 'utf8');
    edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: TENANT, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0',
      EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_PACK_FILE: packFile, EDGE_SCREEN_TRUST_FORWARDED_USER: '1',
    }, () => {}))!;
  }, 240_000);
  afterAll(async () => { await browser?.close(); await edge?.stop(); if (dir !== undefined) await rm(dir, { recursive: true, force: true }); });
  afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop(); });

  const open = async (who: string, path: string): Promise<{ page: Page; errors: string[] }> => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block', extraHTTPHeaders: { 'x-sre-user': who } });
    stops.push(() => context.close());
    await context.route('**/v1/**', async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const raw = req.postData();
      const answer = await ho.request({
        method: req.method() as 'GET', path: url.pathname, userId: who, tenantId: TENANT,
        // A branch-limited person's own sign-in names their branch (as head office's identity server issues it).
        ...(who === MANAGER ? { branchId: 'store-1' } : {}),
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
    expect(res?.status(), `${path} is served by the store computer`).toBe(200);
    return { page, errors };
  };
  const says = (page: Page, selector: string, pattern: RegExp): Promise<unknown> => page.waitForFunction(
    ([sel, src]) => new RegExp(src!).test((globalThis as unknown as { document: { querySelector(s: string): { textContent: string | null } | null } }).document.querySelector(sel!)?.textContent ?? ''),
    [selector, pattern.source], { timeout: 15_000 },
  ).catch(async (e: unknown) => {
    const seen = await page.evaluate((sel) => (globalThis as unknown as { document: { querySelector(s: string): { textContent: string | null } | null } }).document.querySelector(sel)?.textContent ?? '(none)', selector);
    throw new Error(`${selector} never said ${pattern.source}; it says: ${JSON.stringify(seen)} (${String(e)})`);
  });
  const rows = (p: Page): Promise<string[]> => p.$$eval('#r-rows tr', (trs) => trs.map((tr) => (tr as unknown as { dataset: { key: string }; textContent: string }).dataset.key));
  const compare = async (p: Page, by: string): Promise<void> => {
    await p.selectOption('#c-by', by);
    await p.evaluate(() => { (globalThis as unknown as { document: { getElementById(id: string): { textContent: string } } }).document.getElementById('r-total').textContent = ''; });
    await p.click('#c-go');
    await says(p, '#r-total', /^Total ₹/);
  };

  it('the owner ranks branches, departments and staff on head office\'s figures and opens a row to its exact bills', async () => {
    const { page: p, errors } = await open(OWNER, '/branch-compare/');
    await p.waitForSelector('#form:not([hidden])');
    expect(await p.inputValue('#c-from')).toBe(TODAY);
    await compare(p, 'branch');
    expect(await rows(p)).toEqual(['store-2', 'store-1']);
    expect(await p.textContent('#r-rows tr[data-key="store-2"]')).toContain('₹500.00');
    expect(await p.textContent('#r-rows tr[data-key="store-1"]')).toContain('₹300.00');
    expect(await p.textContent('#r-total')).toBe('Total ₹800.00');
    expect(await p.textContent('#r-check')).toBe('✓ The rows add up to the total.');
    expect(await p.textContent('#r-scope')).toBe('Branches you can see: all branches');

    await p.click('#r-rows tr[data-key="store-1"] button[data-act="open"]');
    await p.waitForSelector('#txns:not([hidden])');
    expect(await p.$$eval('#tx-rows tr', (trs) => trs.map((tr) => (tr as unknown as { dataset: { txn: string } }).dataset.txn))).toEqual(['A-1']);
    expect(await p.textContent('#tx-rows')).toContain('bill R-A-1');

    await compare(p, 'category');
    expect(await rows(p)).toEqual(['dairy', 'grocery']);
    expect(await p.textContent('#r-rows tr[data-key="grocery"]')).toContain('₹400.00');
    await compare(p, 'staff');
    expect(await rows(p)).toEqual([CASH2, CASH1]);
    await p.click('#lang');
    await says(p, '#form-h', /^எதை ஒப்பிட வேண்டும்$/);
    expect(errors).toEqual([]);

    // Every drill the page made is on head office's drill audit, by the owner.
    const audits = (await ho.request({ method: 'GET', path: '/v1/reporting/drill-audits', userId: OWNER, tenantId: TENANT })).body as { audits: { userId: string; metric: string }[] };
    expect(audits.audits.filter((a) => a.userId === OWNER).map((a) => a.metric)).toEqual(expect.arrayContaining(['sales_by_day:Taken', 'units_by_category:dairy — taken', 'units_by_category:grocery — taken']));
  });

  it('a manager limited to store-1 sees only store-1 — head office decided — and a cashier is not offered the form', async () => {
    const { page: p, errors } = await open(MANAGER, '/branch-compare/');
    await p.waitForSelector('#form:not([hidden])');
    await compare(p, 'branch');
    expect(await rows(p)).toEqual(['store-1']);
    expect(await p.textContent('#r-total')).toBe('Total ₹300.00');
    expect(await p.textContent('#r-scope')).toBe('Branches you can see: store-1');
    await compare(p, 'staff');
    expect(await rows(p)).toEqual([CASH1]);
    expect(await p.content()).not.toContain('R-B-1'); // store-2's bill is nowhere on her screen
    await compare(p, 'category');
    expect(await rows(p)).toEqual(['grocery']);
    expect(errors).toEqual([]);

    // A cashier (no owner.kpi.read): the store computer either refuses the page or serves it with nothing to ask.
    const context = await browser.newContext({ serviceWorkers: 'block', extraHTTPHeaders: { 'x-sre-user': CASH1 } });
    stops.push(() => context.close());
    const cp = await context.newPage();
    const res = await cp.goto(`http://127.0.0.1:${edge.screens!.port}/branch-compare/`, { waitUntil: 'load' });
    if (res?.status() === 200) {
      await says(cp, '#page-status', /cannot read the owner's figures/);
      expect(await cp.isHidden('#form')).toBe(true);
    } else expect(res?.status()).toBe(403);
  });
});
