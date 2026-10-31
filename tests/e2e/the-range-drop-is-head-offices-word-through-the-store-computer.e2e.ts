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

/**
 * **"Take it out of the range" is head office's word, in a real browser, served by the store computer, over head office's
 * real routes (M04-FR-01 · re-audit 30 Oct 2026 · P-08).**
 *
 * The re-audit found the Range tab saying "Taken out of the range" when nothing had been sent anywhere: the drop was decided
 * in the browser on the box's copy of the stock and saved nowhere. Now the real store computer serves the Shelves and space
 * page; head office's API surface runs in memory with its real routes and permission checks, and every `/v1` call reaches it
 * as the signed-in person, on the box's own origin. Through Chromium:
 *   • a stocked item goes to CLEARANCE on head office's stock position (12 on hand there) even though the box's copy says
 *     none — the screen says "taken out" only on head office's answer, and head office's range no longer carries it;
 *   • an item head office holds none of is delisted;
 *   • a person head office does not let change the range is refused in head office's own words, and nothing changes;
 *   • with no answer from head office the screen says so and claims nothing;
 *   • the page speaks Tamil.
 * Synthetic data only. Without a browser binary it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['range', 'drop', 'box', 'signing', 'key'].join('-').padEnd(48, '0');
const TENANT = randomUUID();
const MANAGER = 'u-mgr';
const CASHIER = 'u-cash';

interface MerchWindow { readonly merchandisingSession?: { range(): string[] }; readonly merchandisingData?: { today: string } }

describe.skipIf(!HAVE_BROWSER)('the Range tab\'s drop reaches head office through the store computer (M04-FR-01 · P-08)', () => {
  let browser: Browser;
  let ho: ApiHarness;
  let edge: EdgeProcess;
  let dir: string;
  const stops: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
    ho = apiHarness();
    await ho.seedOwner(TENANT, 'u-owner');
    await ho.provisionRole(TENANT, MANAGER, 'store_manager');
    await ho.provisionRole(TENANT, CASHIER, 'cashier');
    for (const product of ['RICE', 'OIL', 'SOAP']) {
      const r = await ho.request({ method: 'POST', path: `/v1/merchandising/assortment/S1/${product}/list`, userId: MANAGER, tenantId: TENANT, idempotencyKey: `list-${product}`, body: { effectiveFrom: '2026-01-01' } });
      if (r.status !== 201) throw new Error(`list ${product}: ${JSON.stringify(r.body)}`);
    }
    // Head office's own stock position: 12 rice at the store. Oil and soap: none.
    const stock = await ho.request({ method: 'POST', path: '/v1/inventory/movements', userId: 'u-owner', tenantId: TENANT, idempotencyKey: 'stock-rice', body: {
      movementId: 'stock-rice', productId: 'RICE', locationId: 'S1', kind: 'received', quantityMinor: 12, uom: 'ea', occurredAt: '2026-01-01T00:00:00.000Z', enteredBy: 'u-owner', unitCostMinor: 100,
    } });
    if (stock.status >= 300) throw new Error(`stock: ${JSON.stringify(stock.body)}`);

    dir = await mkdtemp(join(tmpdir(), 'sre-range-drop-'));
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, JSON.stringify({
      version: 1, lossPreventionRules: [], policies: { tradingDayCutoff: '02:00', storeId: 'S1', branchId: 'S1', warehouseId: 'S1-BACK' },
      merchandisingPolicy: { refillAtBp: 5_000, countStaleAfterMinutes: 120, refillRole: 'shelf-filler', userId: MANAGER },
      // The box's copy of the range, and of the stock: it says NO rice is left — head office's position says 12.
      assortment: ['RICE', 'OIL', 'SOAP'].map((productId) => ({ storeId: 'S1', productId, status: 'listed', effectiveFrom: '2026-01-01' })),
      products: ['RICE', 'OIL', 'SOAP'].map((productId) => ({ productId, name: productId, categoryId: 'grocery', unitPriceMinor: 10_000, uom: 'EA', barcodes: [], availableMinor: 0, taxBps: 0, status: 'active' })),
      roles: [
        { id: 'manager', name: 'Store manager', permissions: ['identity.self.read', 'merchandising.range.read', 'merchandising.range.manage'] },
        { id: 'floor', name: 'Floor', permissions: ['identity.self.read', 'merchandising.range.read'] },
      ],
      roleAssignments: [{ userId: MANAGER, roleId: 'manager', branchScope: 'all' }, { userId: CASHIER, roleId: 'floor', branchScope: 'all' }],
    }), 'utf8');
    edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: TENANT, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0',
      EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_PACK_FILE: packFile, EDGE_SCREEN_TRUST_FORWARDED_USER: '1',
    }, () => {}))!;
  }, 240_000);
  afterAll(async () => { await browser?.close(); await edge?.stop(); if (dir !== undefined) await rm(dir, { recursive: true, force: true }); });
  afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop(); });

  /** The Range tab on the box's origin as `who`; head office's API carried on that origin as that person (or cut off). */
  const open = async (who: string, opts: { cutOff?: boolean } = {}): Promise<{ page: Page; errors: string[]; v1: string[] }> => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block', extraHTTPHeaders: { 'x-sre-user': who } });
    stops.push(() => context.close());
    const v1: string[] = [];
    await context.route('**/v1/**', async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      v1.push(`${req.method()} ${url.pathname}`);
      if (opts.cutOff === true) { await route.abort('connectionreset'); return; }
      const raw = req.postData();
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
    const res = await page.goto(`http://127.0.0.1:${edge.screens!.port}/merchandising/`, { waitUntil: 'load' });
    expect(res?.status(), 'the page is served by the store computer').toBe(200);
    await page.waitForFunction(() => (globalThis as unknown as MerchWindow).merchandisingSession !== undefined);
    await page.click('#tab-range');
    return { page, errors, v1 };
  };
  const drop = async (page: Page, productId: string, reason: string): Promise<{ title: string; text: string }> => {
    await page.fill('#drop-product', productId);
    await page.selectOption('#drop-reason', reason);
    await page.click('#drop-item');
    await page.waitForSelector('#banner:not([hidden])');
    const said = { title: ((await page.textContent('#banner-title')) ?? '').trim(), text: ((await page.textContent('#banner-text')) ?? '').trim() };
    await page.click('#banner-ok');
    return said;
  };
  const listedAtHeadOffice = async (onDate: string): Promise<string[]> =>
    ((await ho.request({ method: 'GET', path: '/v1/merchandising/assortment/S1', userId: 'u-owner', tenantId: TENANT, query: { onDate } })).body as { listed: string[] }).listed;

  it('with no answer from head office the screen says so, claims nothing, and the item stays carried', async () => {
    const { page, errors, v1 } = await open(MANAGER, { cutOff: true });
    const said = await drop(page, 'SOAP', 'poor_sales');
    expect(said.title).toBe('Please read this');
    expect(said.text).toBe('Head office cannot be reached, so nothing was taken out of the range. Try again when the line is back.');
    expect(v1).toEqual(['POST /v1/merchandising/assortment/S1/SOAP/drop']);
    expect(await page.textContent('#range-list')).toContain('SOAP');
    const today = await page.evaluate(() => (globalThis as unknown as MerchWindow).merchandisingData!.today);
    expect(await listedAtHeadOffice(today)).toEqual(['OIL', 'RICE', 'SOAP']);
    expect(errors).toEqual([]);
  });

  it('a person head office does not let change the range is refused in head office\'s own words, and nothing changes', async () => {
    const { page, errors } = await open(CASHIER);
    const said = await drop(page, 'SOAP', 'poor_sales');
    expect(said.title).toBe('Please read this');
    expect(said.text.startsWith('Head office refused: ')).toBe(true);
    expect(said.text.length).toBeGreaterThan('Head office refused: '.length + 10);
    expect(said.text).not.toContain('Taken out');
    const today = await page.evaluate(() => (globalThis as unknown as MerchWindow).merchandisingData!.today);
    expect(await listedAtHeadOffice(today)).toEqual(['OIL', 'RICE', 'SOAP']);
    expect(errors).toEqual([]);
  });

  it('a stocked item goes to clearance on HEAD OFFICE\'s stock, an empty one is delisted — "taken out" only on its word', async () => {
    const { page, errors, v1 } = await open(MANAGER);
    expect(await page.textContent('#range-list')).toContain('OIL · RICE · SOAP');

    // "Replaced" with nothing named: refused on the screen by the engine, and nothing is sent.
    const unnamed = await drop(page, 'RICE', 'replaced_by_alternative');
    expect(unnamed.text).toContain('what replaced it');
    expect(v1).toEqual([]);

    // The box's copy says no rice is left; head office holds 12 — clearance, never a deletion.
    const rice = await drop(page, 'RICE', 'poor_sales');
    expect(rice.title).toBe('Taken out of the range');
    expect(rice.text).toContain('RICE — Put on clearance (Head office recorded it).');
    expect(rice.text).toContain('12 still on hand');
    expect(v1).toEqual(['POST /v1/merchandising/assortment/S1/RICE/drop']);

    const oil = await drop(page, 'OIL', 'supplier_discontinued');
    expect(oil.text).toContain('OIL — Delisted (Head office recorded it).');
    expect(oil.text).toContain('no stock on hand');

    // The page's "carried today" follows head office's word, and head office's own range agrees.
    expect((await page.textContent('#range-list'))?.trim()).toBe('SOAP');
    const today = await page.evaluate(() => (globalThis as unknown as MerchWindow).merchandisingData!.today);
    expect(await listedAtHeadOffice(today)).toEqual(['SOAP']);
    expect(errors).toEqual([]);

    // Tamil.
    await page.click('#lang');
    await page.waitForFunction(() => (globalThis as unknown as { document: { documentElement: { lang: string } } }).document.documentElement.lang === 'ta');
    expect(await page.textContent('#drop-item')).toBe('வரிசையிலிருந்து நீக்கு');
  });
});
