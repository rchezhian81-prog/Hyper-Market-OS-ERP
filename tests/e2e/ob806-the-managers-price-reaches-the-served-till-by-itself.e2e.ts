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
 * **OB-806 A (owner, 16 Nov 2026, in writing: "a manager's price change is sent to the tills automatically once head office
 * accepts it") · daily-work defect D-021 — in a real browser, on the real head-office API over real PostgreSQL, through the
 * real store computer.**
 *
 * Before: the manager saw "Price saved ₹32" while the till kept charging ₹30 until the owner pressed "Send to the tills", and
 * the shelf label was already "due now". Now:
 *   • the owner's shelf price ₹50 is sent to the tills by itself; the box pulls it; the served till charges ₹50;
 *   • the MANAGER changes the price to ₹45 — head office accepts it and sends it to the tills at once. NOBODY calls
 *     "Send to the tills" anywhere in this test;
 *   • the label task for ₹45 WAITS for the tills; the box pulls the new pack and says what it holds → the label falls due;
 *   • the served till charges ₹45, and still does after the box restarts on its own disk (offline-first, P-01).
 *
 * Synthetic data, a fresh tenant. Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['ob806', 'price', 'reaches', 'till', 'key'].join('-').padEnd(48, '0');
const STORE = 'S1';
const OWNER = 'u-owner';
const BOX = 'u-box';
const CASHIER = 'u-meena';
const MANAGER = 'u-manager';
const PRODUCT = 'p-tea';
const BARCODE = '8901234500026';
const MRP = 6_000;
const COST = 3_000;

interface PosWindow {
  readonly posCatalogue?: { readonly version: number; readonly source?: string };
  readonly posSession?: { hasCatalogue(): boolean };
}

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('OB-806 A — the manager\'s accepted price reaches the served till by itself', () => {
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
  const packNow = async (): Promise<{ version: number; price: number | undefined }> => {
    const pack = (await call('GET', '/v1/catalogue/pack', OWNER)).body as { snapshot: { version: number; products: { productId: string; unitPriceMinor: number }[] } };
    return { version: pack.snapshot.version, price: pack.snapshot.products.find((p) => p.productId === PRODUCT)?.unitPriceMinor };
  };
  const labelTasks = async () => ((await call('GET', '/v1/pricing/relabel-tasks', MANAGER)).body as { tasks: { priceMinor: number; dueNow: boolean; waitingForTills: boolean }[] }).tasks;

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
    await ok(call('POST', '/v1/catalogue/tax-classes/0902/rates/2017-07-01', OWNER, { rateBps: 500 }), 'tax');
    await ok(call('POST', `/v1/catalogue/products/${PRODUCT}/publish`, OWNER, {
      product: { sku: 'TEA-250', name: 'Tea 250g', baseUom: 'ea', primaryCategoryId: 'beverages', taxClass: '0902', lifecycle: 'active', mrpHistory: [{ value: { minor: MRP, currency: 'INR' }, effectiveFrom: '2026-01-01' }] },
      categories: [{ categoryId: 'beverages', name: 'Beverages', parentId: null }],
    }), 'publish');
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

  it('shelf price sent by itself → till charges ₹50 → manager\'s ₹45 accepted and sent by itself → label waits for the till → till charges ₹45, also after a restart', async () => {
    // ── The owner's shelf price: accepted, so it goes to the tills by itself.
    const shelf = await ok(call('POST', `/v1/prices/list/${PRODUCT}/entries/e1`, OWNER, {
      scope: 'store', scopeRef: STORE, priceMinor: 5_000, mrpMinor: MRP, costMinor: COST, marginFloorBps: 0, currency: 'INR', effectiveFrom: today,
    }), 'shelf price') as { tills: { storeId: string; sent: boolean; version: number }[] };
    expect(shelf.tills).toMatchObject([{ storeId: STORE, sent: true }]);
    const first = await packNow();
    expect(first).toEqual({ version: shelf.tills[0]!.version, price: 5_000 });

    const dir = await mkdtemp(join(tmpdir(), 'sre-ob806-'));
    dirs.push(dir);
    let edge = await startBox(dir);
    let running = true;
    stops.push(async () => { if (running) await edge.stop(); });
    expect(await edge.refreshPack!()).toMatchObject({ status: 'updated', heldVersion: first.version });
    const before = await ringOne(edge, first.version);
    expect(before.total).toBe('₹50.00');
    expect(before.errors).toEqual([]);

    // ── The MANAGER changes the price to ₹45. Head office accepts it and sends it to the tills — nobody presses anything.
    const saved = await call('POST', '/v1/prices/changes', MANAGER, { productId: PRODUCT, priceMinor: 4_500, mrpMinor: MRP, costMinor: COST, currency: 'INR', marginFloorBps: 0, storeId: STORE });
    expect(saved.status, JSON.stringify(saved.body)).toBe(201);
    expect(saved.body).toMatchObject({ operativeAt: [STORE], tills: [{ storeId: STORE, sent: true, version: first.version + 1, withinMinutes: 5 }] });
    expect(await packNow()).toEqual({ version: first.version + 1, price: 4_500 });

    // ── The shelf label for ₹45 waits: the box has not taken the new pack yet.
    expect((await labelTasks()).filter((t) => t.priceMinor === 4_500).every((t) => t.waitingForTills && !t.dueNow)).toBe(true);

    // ── The box takes it on its pull and says what it holds → the label falls due; the served till charges ₹45.
    expect(await edge.refreshPack!()).toMatchObject({ status: 'updated', heldVersion: first.version + 1 });
    // The box's own word on what it holds, as its loop sends it (`reportHeldVersions`; this box takes its setup from a file,
    // so the test sends the same report in the box's name).
    await ok(cloud.request({ method: 'POST', path: `/v1/store-packs/${STORE}/held`, userId: BOX, idempotencyKey: randomUUID(), body: { catalogueVersion: edge.node.pack()!.snapshot.version, storePackVersion: null } }), 'held');
    const due = (await labelTasks()).filter((t) => t.priceMinor === 4_500);
    expect(due.length).toBeGreaterThan(0);
    expect(due.every((t) => t.dueNow && !t.waitingForTills)).toBe(true);
    const after = await ringOne(edge, first.version + 1);
    expect(after.total).toBe('₹45.00');
    expect(after.errors).toEqual([]);

    // ── Nobody ever called "Send to the tills".
    expect(sentPaths.filter((p) => p === '/v1/catalogue/pack')).toEqual([]);

    // ── A box restart: the till charges ₹45 from the pack on its own disk (no cloud round trip).
    running = false;
    await edge.stop();
    edge = await startBox(dir);
    running = true;
    expect((await ringOne(edge, first.version + 1)).total).toBe('₹45.00');
  }, 180_000);
});
