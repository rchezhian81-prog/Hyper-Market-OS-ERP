import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { prepareTillBox, signInThroughScreen } from '../support/till-operator';
import { startRealCloud, type RealCloud } from '../support/real-store';
import { STORE_RULES } from '../support/store-rules';
import { theEvening, pinTheEveningClock, pinThePageClock } from '../support/evening-clock';

/**
 * **OB-811 B (owner, 16 Nov 2026, in writing) — a PACKED household item loaded from the old ERP before its label facts are
 * read sells at the till, in a real browser, on the real head-office API over real PostgreSQL, through the real store
 * computer.** The facts are printed on the pack the customer holds; head office lists the item until staff type them in,
 * and it is never sold online or by scan-and-go meanwhile (`tests/unit/ob811-…`). A loose food is never let follow.
 *
 * Synthetic data, a fresh tenant. Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['ob811', 'packed', 'good', 'till', 'key'].join('-').padEnd(48, '0');
const STORE = 'S1';
const OWNER = 'u-owner';
const BOX = 'u-box';
const CASHIER = 'u-meena';
const MANAGER = 'u-manager';
const PRODUCT = 'p-detergent';
const BARCODE = '8901234500033';
const MRP = 12_000;
const COST = 8_000;

interface PosWindow {
  readonly posCatalogue?: { readonly version: number; readonly source?: string };
  readonly posSession?: { hasCatalogue(): boolean };
}

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('OB-811 B — a packed household item with its label facts still to read sells at the served till', () => {
  let browser: Browser;
  let cloud: RealCloud;
  const dirs: string[] = [];
  const stops: (() => Promise<void>)[] = [];
  const EVENING = theEvening();
  const today = EVENING.shopDate;
  /** Every path this test sends to head office — the proof that nobody pressed "Send to the tills". */
  const sentPaths: string[] = [];

  const call = (method: 'GET' | 'POST' | 'PUT', path: string, userId: string, body?: unknown) => {
    if (method !== 'GET') sentPaths.push(path);
    return cloud.request({ method, path, userId, ...(body === undefined ? {} : { body }), ...(method === 'GET' ? {} : { idempotencyKey: randomUUID() }) });
  };
  const ok = async (p: Promise<{ status: number; body: unknown }>, label: string): Promise<unknown> => {
    const r = await p;
    if (r.status >= 300) throw new Error(`${label}: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  };
  const outstanding = async () => ((await call('GET', '/v1/catalogue/label-facts-outstanding', OWNER)).body as { items: { productId: string; facts: string[] }[] }).items;

  beforeAll(async () => {
    pinTheEveningClock(EVENING);
    execFileSync('node', ['scripts/build-app.mjs', 'pos'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
    cloud = await startRealCloud({ databaseUrl: DATABASE_URL!, tenantId: randomUUID(), owner: OWNER, packSigningKey: KEY });
    await cloud.grant(BOX, 'store_computer', undefined, [STORE]);
    await cloud.grant(CASHIER, 'cashier');
    await cloud.grant(MANAGER, 'store_manager');
    await ok(call('POST', '/v1/org/nodes/C1', OWNER, { kind: 'company', name: 'SRE Retail' }), 'company');
    await ok(call('POST', `/v1/org/nodes/${STORE}`, OWNER, { kind: 'branch', name: 'Store 1', parentId: 'C1', companyId: 'C1' }), 'store');
    await ok(call('POST', `/v1/stores/${STORE}/rules`, OWNER, { ...STORE_RULES, marginFloorBps: 0 }), 'rules');
    await ok(call('POST', '/v1/catalogue/tax-classes/3402/rates/2017-07-01', OWNER, { rateBps: 1_800 }), 'tax');
    // As the old-system load publishes it (the owner runs the load): household goods, no label fact read yet (OB-811 B).
    const loaded = await ok(call('POST', `/v1/catalogue/products/${PRODUCT}/publish`, OWNER, {
      product: { sku: 'DET-1KG', name: 'Detergent 1 kg', baseUom: 'ea', primaryCategoryId: 'household-general', taxClass: '3402', lifecycle: 'active', mrpHistory: [{ value: { minor: MRP, currency: 'INR' }, effectiveFrom: '2026-01-01' }] },
      categories: [{ categoryId: 'household-general', name: 'Household and general goods', parentId: null, regulated: ['packed'] }],
      labelFactsFollow: { loadId: 'bpal-20261116-load-1' },
    }), 'publish') as { labelFactsOutstanding?: { facts: string[]; onSaleAtTheTill: boolean; soldOnline: boolean } };
    expect(loaded.labelFactsOutstanding).toEqual(expect.objectContaining({ facts: ['country_of_origin', 'net_quantity', 'packer', 'consumer_care'], onSaleAtTheTill: true, soldOnline: false }));
    await ok(call('POST', `/v1/catalogue/products/${PRODUCT}/barcodes/${BARCODE}`, OWNER, { kind: 'ean' }), 'barcode');
  }, 180_000);
  afterAll(async () => { await browser?.close(); await cloud?.stop(); vi.useRealTimers(); });
  afterEach(async () => {
    for (const stop of stops.splice(0).reverse()) await stop();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  async function startBox(dataDir: string): Promise<EdgeProcess> {
    const { EDGE_PACK_FILE: packFile } = await prepareTillBox({
      dir: dataDir, key: KEY, people: [{ userId: CASHIER, displayName: 'Meena' }],
      pack: { policies: { storeId: STORE, branchId: STORE, branchName: 'SRE Hyper Market', warehouseId: 'S1-BACK', tradingDayCutoff: '00:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 0 }, lossPreventionRules: [] },
    });
    return (await startEdge({
      EDGE_DATA_DIR: dataDir, EDGE_TENANT_ID: cloud.tenantId, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
      EDGE_LANE_PORT: '0', EDGE_LANE_ID: 'lane-1', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_PACK_FILE: packFile,
      CLOUD_API_URL: cloud.baseUrl, CLOUD_API_TOKEN: cloud.token(BOX),
    }, () => {}))!;
  }

  /** Open the served till, sign the cashier in, scan the barcode as a scanner does; the total the till asks. */
  async function ringOne(edge: EdgeProcess, expectVersion: number): Promise<{ total: string; errors: string[] }> {
    const context = await browser.newContext();
    await pinThePageClock(context);
    try {
      const page: Page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(`http://127.0.0.1:${edge.screens!.port}/pos/`, { waitUntil: 'load' });
      await page.waitForFunction(() => { const w = globalThis as unknown as PosWindow; return w.posSession !== undefined && w.posSession.hasCatalogue(); }, undefined, { timeout: 15_000 });
      expect(await page.evaluate(() => { const c = (globalThis as unknown as PosWindow).posCatalogue!; return { version: c.version, source: c.source }; }))
        .toEqual({ version: expectVersion, source: 'head_office' });
      await signInThroughScreen(page, CASHIER);
      await page.keyboard.type(BARCODE);
      await page.keyboard.press('Enter');
      await page.waitForSelector('#lines tr');
      return { total: (await page.textContent('#total')) ?? '', errors };
    } finally {
      await context.close();
    }
  }

  it('loaded with no label fact read → listed with the four a packed non-food carries → on the tills by itself → the served till charges it → filled, off the list', async () => {
    expect((await outstanding()).map((x) => [x.productId, x.facts])).toEqual([[PRODUCT, ['country_of_origin', 'net_quantity', 'packer', 'consumer_care']]]);
    const shelf = await ok(call('POST', `/v1/prices/list/${PRODUCT}/entries/e1`, OWNER, {
      scope: 'store', scopeRef: STORE, priceMinor: 11_000, mrpMinor: MRP, costMinor: COST, marginFloorBps: 0, currency: 'INR', effectiveFrom: today,
    }), 'shelf price') as { tills: { storeId: string; sent: boolean; version: number }[] };
    expect(shelf.tills).toMatchObject([{ storeId: STORE, sent: true }]);

    const dir = await mkdtemp(join(tmpdir(), 'sre-ob811-'));
    dirs.push(dir);
    const edge = await startBox(dir);
    stops.push(() => edge.stop());
    expect(await edge.refreshPack!()).toMatchObject({ status: 'updated', heldVersion: shelf.tills[0]!.version });
    const sold = await ringOne(edge, shelf.tills[0]!.version);
    expect(sold.total).toBe('₹110.00'); // on sale at the till — the customer holds the printed pack
    expect(sold.errors).toEqual([]);

    // The manager types the four facts read off the pack: the item leaves the list (the full rule from now on).
    const version = ((await call('GET', `/v1/catalogue/products/${PRODUCT}`, OWNER)).body as { version: number }).version;
    await ok(call('POST', `/v1/catalogue/products/${PRODUCT}/label-facts`, MANAGER, {
      expectedVersion: version, facts: { countryOfOrigin: 'India', netQuantity: '1 kg', packerDetails: 'Test Home Care, Chennai', consumerCareContact: 'care@testhome.example' }, reason: 'read off the pack',
    }), 'facts');
    expect(await outstanding()).toEqual([]);
  }, 180_000);
});
