// The store PC in the walkthrough ran on UTC under an Asia/Kolkata shop — the clock banner was up for the time zone and
// carried the "clock agrees" line with a computer timestamp (D-028). This file's boxes run the same way.
process.env['TZ'] = 'UTC';

import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { createServer, type Server } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { apiHarness, TEST_IDP, type ApiHarness } from '../support/api-harness';
import { prepareTillBox, pinOf, signInAtLane, operatorHeader } from '../support/till-operator';
import type { HttpRequest } from '../../services/kernel/src/index';

/**
 * BROWSER. **Daily-work defects (docs/registers/daily-work-defects.md, 15 Nov 2026): the office pages say it in the shop's
 * words** — each done as the person does it, on a REAL store computer (`startEdge`) in headless Chromium:
 *   • D-016 — the store manager opens Stock health (head office's real pipeline behind the store PC): biscuits sold before
 *     they were received read "Marie biscuits 200 g @ Main store · −4 pieces", loose rice "−1.25 kg" — not "−0.04" / "−12.5";
 *   • D-028 — on a UTC store PC whose clock head office has just measured as in step, the strip is up for the time zone
 *     only: no "clock agrees … checked 2026-…Z" line;
 *   • D-030 — the manager saves a delivery on Receive: "Saved. It goes to head office when the line is up." (Tamil too);
 *   • D-015 — Cash over/short says the cashier's reason as "Wrong change given", not "wrong_change" (Tamil too);
 *   • D-009 — once Cash over/short has signed the drawer off, Today no longer lists it as closed short;
 *   • D-037 — Goods receipt review: "Marie biscuits 200 g: 4 pieces short", what became sellable item by item, the place by
 *     its name.
 * Synthetic data only.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const T = randomUUID();
const KEY = ['daily', 'work', 'plain', 'words'].join('-').padEnd(48, '0');
const PRIVILEGE_SECRET = randomBytes(32).toString('base64url');
const AT = new Date().toISOString();
const PRODUCTS = [
  { productId: 'BISC', name: 'Marie biscuits 200 g', categoryId: 'grocery', unitPriceMinor: 3_000, taxBps: 1_800, uom: 'ea' },
  { productId: 'RICE', name: 'Loose ponni rice', categoryId: 'grocery', unitPriceMinor: 6_000, taxBps: 0, uom: 'kg' },
  { productId: 'OIL', name: 'Sunflower oil 1 L', categoryId: 'grocery', unitPriceMinor: 15_000, taxBps: 500, uom: 'ea' },
];
const MANAGER_READS = ['identity.self.read', 'inventory.availability.read', 'till.shift.read', 'till.overshort.review', 'till.dayclose.read'];
const PACK = {
  version: 1,
  policies: { storeId: 'S1', branchId: 'S1', branchName: 'Main store', tradingDayCutoff: '00:00', timeZone: 'Asia/Kolkata', warehouseId: 'S1' },
  lossPreventionRules: [], devices: [], products: PRODUCTS,
  managerPolicy: { userId: 'u-mgr', approvalLimitMinor: 500_000 },
  stockHealthPolicy: { userId: 'u-mgr', permissions: ['inventory.availability.read'] },
  goodsReceiptPolicy: { userId: 'u-mgr', permissions: ['inventory.availability.read'] },
  cashOfficePolicy: { userId: 'u-mgr', permissions: ['till.shift.read', 'till.overshort.review'] },
  roles: [
    { id: 'owner', name: 'Owner', permissions: ['identity.self.read', 'catalogue.pack.read', 'org.branch.read', ...MANAGER_READS] },
    { id: 'store_manager', name: 'Store manager', permissions: ['catalogue.pack.read', 'org.branch.read', ...MANAGER_READS] },
    { id: 'cashier', name: 'Cashier', permissions: ['identity.self.read', 'pos.sale.sync'] },
  ],
  roleAssignments: [
    { userId: 'u-owner', roleId: 'owner', branchScope: 'all' }, { userId: 'u-mgr', roleId: 'store_manager', branchScope: 'all' },
    { userId: 'u-ravi', roleId: 'cashier', branchScope: 'all' },
  ],
};
const PEOPLE = [{ userId: 'u-owner', displayName: 'The Owner' }, { userId: 'u-mgr', displayName: 'Manager' }, { userId: 'u-ravi', displayName: 'Ravi' }];
const product = (name: string, baseUom: string) => ({ sku: name.toUpperCase().replace(/\W+/g, '-'), name, baseUom, primaryCategoryId: 'grocery', taxClass: '19053100', lifecycle: 'active', mrpHistory: [{ value: { minor: 3_000, currency: 'INR' }, effectiveFrom: '2026-01-01' }] });

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });
type Doc = { document: { querySelector(s: string): { textContent: string | null } | null } };
async function says(page: Page, selector: string, re: RegExp): Promise<void> {
  try {
    await page.waitForFunction(([sel, src]) => new RegExp(src!).test((globalThis as unknown as Doc).document.querySelector(sel!)?.textContent ?? ''), [selector, re.source] as const);
  } catch { throw new Error(`${selector} says ${JSON.stringify(await page.textContent(selector))}, not ${String(re)}`); }
}

/** Head office's real pipeline over HTTP on the PC's loopback, with the walkthrough's two negative lines in its stock. */
async function officeApi(): Promise<{ h: ApiHarness; url: string }> {
  const h = apiHarness({ privilegeSealSecret: PRIVILEGE_SECRET });
  await h.seedOwner(T, 'u-owner');
  await h.provisionRole(T, 'u-mgr', 'store_manager');
  await h.provisionRole(T, 'u-box', 'store_computer', ['S1']);
  const owner = async (path: string, body: unknown) => {
    const r = await h.request({ method: 'POST', path, userId: 'u-owner', tenantId: T, idempotencyKey: `k-${randomUUID()}`, body });
    expect(r.status, `${path}: ${JSON.stringify(r.body)}`).toBeLessThan(300);
  };
  await owner('/v1/catalogue/categories/grocery', { name: 'Grocery', parentId: null });
  await owner('/v1/catalogue/tax-classes/19053100/rates/2017-07-01', { rateBps: 1800 });
  await owner('/v1/catalogue/products/BISC/publish', { product: product('Marie biscuits 200 g', 'ea') });
  await owner('/v1/catalogue/products/RICE/publish', { product: product('Loose ponni rice', 'kg') });
  await owner('/v1/inventory/movements', { movementId: 'sale-b', productId: 'BISC', locationId: 'S1', kind: 'sold', quantityMinor: 4, uom: 'ea', occurredAt: AT, enteredBy: 'u-till' });
  await owner('/v1/inventory/movements', { movementId: 'sale-r', productId: 'RICE', locationId: 'S1', kind: 'sold', quantityMinor: 1250, uom: 'kg', occurredAt: AT, enteredBy: 'u-till' });
  const server: Server = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => parts.push(c));
    req.on('end', () => {
      void (async () => {
        const url = new URL(req.url ?? '/', 'http://x');
        const raw = Buffer.concat(parts).toString('utf8');
        const out = await h.raw({
          method: (req.method ?? 'GET') as HttpRequest['method'], path: url.pathname, token: String(req.headers['authorization'] ?? '').replace(/^Bearer /, ''),
          ...(raw === '' ? {} : { body: JSON.parse(raw) as unknown }),
          ...(typeof req.headers['idempotency-key'] === 'string' ? { idempotencyKey: req.headers['idempotency-key'] } : {}),
          query: Object.fromEntries(url.searchParams),
        });
        // Node's server stamps its own Date header — head office's clock, which the store computer measures itself by.
        res.writeHead(out.status, { 'content-type': 'application/json' }).end(JSON.stringify(out.body));
      })().catch(() => { res.writeHead(500).end('{}'); });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(async () => { await new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }); });
  return { h, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}

/** The store PC as installed: office PIN sign-in on; with `api`, its link to head office (so its clock is measured). */
async function storePc(api?: string): Promise<{ edge: EdgeProcess; url: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'sre-daily-words-'));
  cleanups.push(async () => { await rm(dir, { recursive: true, force: true }); await rm(`${dir}-witness`, { recursive: true, force: true }); });
  const env = await prepareTillBox({ dir, key: KEY, pack: PACK, people: PEOPLE });
  const edge = (await startEdge({
    EDGE_DATA_DIR: dir, EDGE_TENANT_ID: T, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
    EDGE_LANE_PORT: '0', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_OFFICE_SIGN_IN: 'pin',
    ...(api === undefined ? {} : { CLOUD_API_URL: api, CLOUD_API_TOKEN: TEST_IDP.issue({ sub: 'u-box', tenantId: T, branchId: 'S1' }), BOX_PRIVILEGE_SEAL_KEY: PRIVILEGE_SECRET, EDGE_STORE_ID: 'S1' }),
    ...env,
  }, () => {}))!;
  cleanups.push(async () => { await edge.stop(); });
  return { edge, url: `http://127.0.0.1:${edge.screens!.port}` };
}

describe.skipIf(!HAVE_BROWSER)('daily-work defects: the office pages say it in the shop\'s words, on a real store PC', () => {
  let browser: Browser;
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 240_000);
  afterAll(async () => { await browser?.close(); });

  /** Open `path` and sign in with staff ID + PIN, as the person does at the store PC. */
  async function signedIn(url: string, path: string, who = 'u-mgr', route?: (page: Page) => Promise<void>): Promise<Page> {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
    cleanups.push(() => context.close());
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    if (route !== undefined) await route(page);
    await page.goto(`${url}${path}`, { waitUntil: 'load' });
    await page.fill('#office-staff', who);
    await page.fill('#office-pin', pinOf(who));
    await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.click('#office-submit')]);
    await page.waitForFunction('globalThis.sreChrome !== undefined');
    return page;
  }

  it('D-016: Stock health says "Marie biscuits 200 g @ Main store · −4 pieces" and "−1.25 kg", never ÷100 or a code', async () => {
    const api = await officeApi();
    const { url } = await storePc(api.url);
    const page = await signedIn(url, '/stock-health');
    await page.waitForSelector('#rows .row.tone-error .qty');
    const rows = await page.$$eval('#rows .row.tone-error .facts', (els) => els.map((e) => (e as unknown as { innerText: string }).innerText.replace(/\s+/g, ' ').trim()));
    expect(rows.join(' | ')).toContain('Loose ponni rice @ Main store');
    expect(rows.join(' | ')).toContain('−1.25 kg');
    expect(rows.join(' | ')).toContain('Marie biscuits 200 g @ Main store');
    expect(rows.join(' | ')).toContain('−4 pieces');
    expect(rows.join(' | ')).not.toMatch(/−?0\.04|−?12\.5\b|BISC @|RICE @/);
    await page.click('#lang');
    await says(page, '#rows', /−4 எண்ணிக்கை/);
  }, 120_000);

  it('D-028: a store PC whose clock agrees with head office shows no clock line — only the time-zone line, in shop words', async () => {
    const api = await officeApi();
    const { edge, url } = await storePc(api.url);
    await edge.syncOnce?.();
    await edge.reportBoxHealth?.(); // head office's answer carries its clock; the store computer measures itself by it
    expect(edge.clockCheck().verdict).toBe('in_step');
    const page = await signedIn(url, '/manager');
    await page.waitForSelector('#box-clock:not([hidden])');          // up for the time zone (UTC under an India shop)
    await page.waitForSelector('#box-zone-words:not([hidden])');
    expect(await page.isHidden('#box-clock-words'), 'no "clock agrees" line while the clock is in step').toBe(true);
    expect(await page.textContent('#box-clock')).not.toMatch(/agrees with head office|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  }, 120_000);

  it('D-030: saving a delivery on Receive says "Saved. It goes to head office when the line is up." — in Tamil too', async () => {
    const { url } = await storePc();
    const page = await signedIn(url, '/manager');
    await page.click('#tab-receive');
    await page.fill('#grn-number', 'DN-101');
    await page.fill('#grn-product', 'BISC');
    await page.fill('#grn-qty', '44');
    await page.click('#add-line');
    await page.click('#save-receipt');
    await page.waitForSelector('#banner:not([hidden])');
    await says(page, '#banner-text', /Saved\. It goes to head office when the line is up\.|With the store computer/);
    expect(await page.textContent('#banner-text')).not.toContain('not yet with the store computer');
    await page.click('#banner-ok');
    await page.click('#lang');
    await page.click('#tab-receive');
    await page.fill('#grn-number', 'DN-102');
    await page.fill('#grn-product', 'BISC');
    await page.fill('#grn-qty', '2');
    await page.click('#add-line');
    await page.click('#save-receipt');
    await page.waitForSelector('#banner:not([hidden])');
    await says(page, '#banner-text', /இணைப்பு வந்ததும் தலைமை அலுவலகத்திற்குச் செல்லும்|கடை கணினியிடம் உள்ளது/);
    expect(await page.textContent('#banner-text')).not.toContain('கடை கணினிக்கு இன்னும் செல்லவில்லை');
  }, 120_000);

  describe('a drawer that closed ₹500 short with the cashier\'s reason "wrong_change"', () => {
    /** The store PC with a till: Ravi takes a ₹2,000 float and closes counting ₹1,500, giving "wrong_change". */
    async function shortDrawer(): Promise<string> {
      const { edge, url } = await storePc();
      const lane = `http://127.0.0.1:${edge.lane!.port}`;
      const post = async (path: string, body: unknown, headers: Record<string, string>) =>
        (await (await fetch(`${lane}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })).json()) as Record<string, unknown>;
      const ravi = operatorHeader(await signInAtLane(edge.lane!.port, 'u-ravi'));
      const now = Date.now();
      expect(await post('/lane/cash-movements', { movementId: 'cm-float', movementKind: 'float_issue', amountMinor: 200_000, at: new Date(now - 3_600_000).toISOString(), custodianId: 'u-ravi' }, ravi)).toMatchObject({ committed: true });
      expect(await post('/lane/shift-close', { shiftId: 'sh-short', closedAt: new Date(now - 60_000).toISOString(), cashierId: 'u-ravi', countedMinor: 150_000, reasonCode: 'wrong_change' }, ravi)).toMatchObject({ closed: true });
      await (await fetch(`${url}/manager`)).text(); // the box re-reads its till-cash log on a screen request
      return url;
    }
    /** Head office's over/short list for that drawer — open, or already signed off on Cash over/short. */
    const headOffice = (reviewed: boolean) => async (page: Page): Promise<void> => {
      await page.route('**/v1/**', async (route) => {
        if (new URL(route.request().url()).pathname !== '/v1/shifts/over-short') { await route.abort('internetdisconnected'); return; }
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
          overShort: [{ shiftId: 'sh-short', tillId: 'lane-1', storeId: 'S1', cashierId: 'u-ravi', tradingDay: AT.slice(0, 10), varianceMinor: -50_000, reasonCode: 'wrong_change', reviewed, reviewedBy: reviewed ? 'u-mgr' : null, disposition: reviewed ? 'change_error' : null, reviewedAt: reviewed ? AT : null }],
          openCount: reviewed ? 0 : 1, totalVarianceMinor: -50_000,
        }) });
      });
    };

    it('D-015: Cash over/short says "Cashier’s reason: Wrong change given", never the code — in Tamil too', async () => {
      const url = await shortDrawer();
      const page = await signedIn(url, '/cash-office', 'u-mgr', headOffice(false));
      await says(page, '#rows', /Cashier’s reason: Wrong change given/);
      expect(await page.textContent('#rows')).not.toContain('wrong_change');
      await page.click('#lang');
      await says(page, '#rows', /தவறான சில்லறை கொடுக்கப்பட்டது/);
    }, 120_000);

    it('D-009: after the drawer is signed off on Cash over/short, Today no longer lists it as closed short', async () => {
      const url = await shortDrawer();
      const answered = { overShort: false };
      const page = await signedIn(url, '/manager', 'u-mgr', async (p) => {
        await headOffice(true)(p);
        p.on('response', (r) => { if (new URL(r.url()).pathname === '/v1/shifts/over-short') answered.overShort = true; });
      });
      // The store computer itself counts the drawer (it does not know about sign-offs) …
      expect(await page.evaluate('globalThis.managerData.today.drawersOverShortToday.value')).toBe(1);
      // … and once Today has read head office's over/short list, the signed-off drawer is no longer listed.
      await expect.poll(() => answered.overShort, { timeout: 15_000 }).toBe(true);
      try {
        await page.waitForFunction("!(document.getElementById('attention')?.textContent ?? '').includes('closed over or short today')", undefined, { timeout: 10_000 });
      } catch { throw new Error(`#attention still says ${JSON.stringify(await page.textContent('#attention'))}`); }
      expect(await page.textContent('#tiles')).not.toContain('drawer(s) closed over or short today');
    }, 120_000);
  });

  it('D-037: Goods receipt review — "4 pieces short", sellable item by item, the place by its name', async () => {
    const { url } = await storePc();
    const receipt = {
      grnId: 'g-1', number: 'GRN-0001', poId: 'po-1', warehouseId: 'S1', receivedBy: 'u-mgr', receivedAt: AT, availableMinor: 64,
      captured: {
        requiresApproval: false, discrepancyValue: { minor: 120_00, currency: 'INR' },
        discrepancies: [{ lineId: 'l1', productId: 'BISC', kind: 'short', quantityMinor: 4, value: { minor: 120_00, currency: 'INR' }, requiresApproval: false, detail: '4 ea short of the 48 ordered — claim or credit note due from the supplier' }],
        lines: [
          { lineId: 'l1', productId: 'BISC', sellableMinor: 44, quarantinedMinor: 0, rejectedMinor: 0, heldMinor: 0, disposition: 'sellable', uom: 'ea', batchId: null, expiry: null },
          { lineId: 'l2', productId: 'OIL', sellableMinor: 20, quarantinedMinor: 0, rejectedMinor: 0, heldMinor: 0, disposition: 'sellable', uom: 'ea', batchId: null, expiry: null },
        ],
      },
    };
    const page = await signedIn(url, '/goods-receipt', 'u-mgr', async (p) => {
      await p.route('**/v1/**', async (route) => {
        if (!new URL(route.request().url()).pathname.startsWith('/v1/inventory/goods-receipt')) { await route.abort('internetdisconnected'); return; }
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ receipts: [receipt], count: 1, needingApprovalCount: 0 }) });
      });
    });
    await says(page, '#rows', /Marie biscuits 200 g: 4 pieces short/);
    const text = (await page.textContent('#rows')) ?? '';
    expect(text).not.toMatch(/\bea short\b|64 units/);
    expect(text).toContain('Became sellable: Marie biscuits 200 g — 44 pieces · Sunflower oil 1 L — 20 pieces');
    expect(text).toContain('Store/warehouse: Main store');
    await page.click('#lang');
    await says(page, '#rows', /4 எண்ணிக்கை குறைவு/);
  }, 120_000);
});
