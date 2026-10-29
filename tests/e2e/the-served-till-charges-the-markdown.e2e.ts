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
import { approvedBody } from '../support/approval-request';
import { STORE_RULES } from '../support/store-rules';
import type { ApiHarness } from '../support/api-harness';
import { theEvening, pinTheEveningClock, pinThePageClock } from '../support/evening-clock';

/**
 * **D06-FR-05 (markdown ladder) evidence — an approved markdown is the price the SERVED till charges, in a real browser,
 * on the real head-office API over real PostgreSQL, through the real store computer.**
 *
 * The markdown route is ADVISORY (hard rule #5): it proposes a lower price for a near-expiry surplus and changes nothing.
 * A person turns the proposal into a governed price change; because the marked-down price is under the store's margin
 * floor, head office refuses it until a SECOND person who may approve prices approves exactly that change (ADR-0024).
 * Then the next catalogue pack carries it, the box pulls it, and the till — the shell the cashier uses, scanning the
 * barcode as a scanner does — charges it:
 *
 *   • before: the till charges the shelf price ₹50.00;
 *   • the proposal is ₹37.50 (25% off: 80 of 100 will not sell in the 2 days left) — and proposing changed no price;
 *   • the change without an approval is refused in head office's words; the pack still says ₹50.00;
 *   • the store manager asks, the owner approves, the manager sends the change naming the approval: saved;
 *   • the box pulls the new pack and the served till charges ₹37.50; after a box restart it still does (its own disk).
 *
 * Synthetic data, a fresh tenant. Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['served', 'till', 'markdown', 'signing', 'key'].join('-').padEnd(48, '0');
const STORE = 'S1';
const OWNER = 'u-owner';
const BOX = 'u-box';
const CASHIER = 'u-meena';
const MANAGER = 'u-manager';
const PRODUCT = 'p-bread';
const BARCODE = '8901234500019';
const SHELF = 5_000;
const MRP = 6_000;
const COST = 3_500;

interface PosWindow {
  readonly posCatalogue?: { readonly version: number; readonly source?: string };
  readonly posSession?: { hasCatalogue(): boolean };
}

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('an approved markdown is charged on the served till (D06-FR-05)', () => {
  let browser: Browser;
  let cloud: RealCloud;
  const dirs: string[] = [];
  const stops: (() => Promise<void>)[] = [];
  // The shop's own date, at an evening UTC moment (19:30 UTC — already tomorrow in the shop), pinned so the evening case
  // is proven whenever this runs: the shelf price and the pack are dated by the shop's day, never the UTC date.
  const EVENING = theEvening();
  const today = EVENING.shopDate;

  const call = (method: 'GET' | 'POST' | 'PUT', path: string, userId: string, body?: unknown) =>
    cloud.request({ method, path, userId, ...(body === undefined ? {} : { body }), ...(method === 'GET' ? {} : { idempotencyKey: randomUUID() }) });
  const ok = async (p: Promise<{ status: number; body: unknown }>, label: string): Promise<unknown> => {
    const r = await p;
    if (r.status >= 300) throw new Error(`${label}: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  };
  /** The approval helpers speak the in-process harness's shape; the real API takes the same calls over HTTP. */
  const asHarness = (): ApiHarness => ({
    request: (r: { method: 'GET' | 'POST' | 'PUT'; path: string; userId: string; body?: unknown; idempotencyKey?: string }) =>
      cloud.request({ method: r.method, path: r.path, userId: r.userId, ...(r.body === undefined ? {} : { body: r.body }), ...(r.idempotencyKey === undefined ? {} : { idempotencyKey: r.idempotencyKey }) }),
  } as unknown as ApiHarness);
  const packPrice = async (): Promise<{ version: number; price: number | undefined }> => {
    await ok(call('POST', '/v1/catalogue/pack', OWNER, { storeId: STORE, asOf: today }), 'pack');
    const pack = (await call('GET', '/v1/catalogue/pack', OWNER)).body as { snapshot: { version: number; products: { productId: string; unitPriceMinor: number }[] } };
    return { version: pack.snapshot.version, price: pack.snapshot.products.find((p) => p.productId === PRODUCT)?.unitPriceMinor };
  };

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
    // The owner's margin floor for the store: 20% — the marked-down price will sit under it.
    await ok(call('POST', `/v1/stores/${STORE}/rules`, OWNER, { ...STORE_RULES, marginFloorBps: 2_000 }), 'rules');
    await ok(call('POST', '/v1/catalogue/tax-classes/1905/rates/2017-07-01', OWNER, { rateBps: 500 }), 'tax');
    await ok(call('POST', `/v1/catalogue/products/${PRODUCT}/publish`, OWNER, {
      product: { sku: 'BREAD-400', name: 'Milk bread 400g', baseUom: 'ea', primaryCategoryId: 'bakery', taxClass: '1905', lifecycle: 'active' },
      categories: [{ categoryId: 'bakery', name: 'Bakery', parentId: null }],
    }), 'publish');
    await ok(call('POST', `/v1/prices/list/${PRODUCT}/entries/e1`, OWNER, {
      scope: 'store', scopeRef: STORE, priceMinor: SHELF, mrpMinor: MRP, costMinor: COST, marginFloorBps: 2_000, currency: 'INR', effectiveFrom: today,
    }), 'shelf price');
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
    const edge = (await startEdge({
      EDGE_DATA_DIR: dataDir, EDGE_TENANT_ID: cloud.tenantId, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
      EDGE_LANE_PORT: '0', EDGE_LANE_ID: 'lane-1', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_PACK_FILE: packFile,
      CLOUD_API_URL: cloud.baseUrl, CLOUD_API_TOKEN: cloud.token(BOX),
    }, () => {}))!;
    return edge;
  }

  /** Open the served till, sign the cashier in, scan the barcode as a scanner does; the total the till asks. */
  async function ringOne(edge: EdgeProcess, expectVersion: number): Promise<{ total: string; line: string; errors: string[] }> {
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
      // The line's own amount cell — it once read ₹NaN because the real till sent no line amount.
      return { total: (await page.textContent('#total')) ?? '', line: (await page.locator('#lines tr td').nth(2).textContent()) ?? '', errors };
    } finally {
      await context.close();
    }
  }

  it('markdown proposed → refused without a second person → approved → new pack → the served till charges ₹37.50, also after a box restart', async () => {
    expect(await packPrice()).toEqual({ version: 1, price: SHELF });
    const dir = await mkdtemp(join(tmpdir(), 'sre-served-till-markdown-'));
    dirs.push(dir);
    let edge = await startBox(dir);
    let running = true;
    stops.push(async () => { if (running) await edge.stop(); });
    expect(await edge.refreshPack!()).toMatchObject({ status: 'updated', heldVersion: 1 });
    const before = await ringOne(edge, 1);
    expect(before.total).toBe('₹50.00');
    expect(before.line).toBe('₹50.00');
    expect(before.errors).toEqual([]);

    // ── The advisory markdown: 100 on hand, 10 a day, 2 days left → 80 will not sell → 25% off → ₹37.50. It changes no price.
    const proposed = (await ok(call('POST', '/v1/pricing/markdown/propose', MANAGER, {
      items: [{ productId: PRODUCT, batchId: 'B-7', remainingShelfLifeDays: 2, onHandMinor: 100, currentPriceMinor: SHELF, avgDailyDemand: 10 }],
    }), 'markdown')) as { proposals: { productId: string; markdownBps: number; newPriceMinor: number; reason: string }[] };
    expect(proposed.proposals[0]).toMatchObject({ productId: PRODUCT, markdownBps: 2_500, newPriceMinor: 3_750, reason: 'marked_down' });
    expect(await packPrice()).toMatchObject({ price: SHELF });

    // ── The person turns the proposal into a price change. Under the 20% floor: refused until a second person approves.
    const change = { productId: PRODUCT, priceMinor: proposed.proposals[0]!.newPriceMinor, mrpMinor: MRP, costMinor: COST, currency: 'INR', marginFloorBps: 2_000, storeId: STORE };
    const refused = await call('POST', '/v1/prices/changes', MANAGER, change);
    expect(refused.status).toBe(422);
    expect((refused.body as { error: { whatHappened: string } }).error.whatHappened).toMatch(/below floor.*separate approver/);
    expect((await packPrice()).price).toBe(SHELF);
    // The manager asks; the owner (who may approve prices) approves in their own session; the change names the approval.
    const withApproval = await approvedBody(asHarness(), cloud.tenantId, MANAGER, OWNER, 'price_change', PRODUCT, change, {}, change.priceMinor);
    const saved = await call('POST', '/v1/prices/changes', MANAGER, withApproval);
    expect(saved.status, JSON.stringify(saved.body)).toBe(201);
    expect(saved.body).toMatchObject({ approvedBy: OWNER, operativeAt: [STORE] });
    // The next pack head office publishes carries it (each publish is a new version; the ones above still said ₹50.00).
    const next = await packPrice();
    expect(next).toEqual({ version: 4, price: 3_750 });

    // ── The box pulls the new pack; the served till charges the markdown.
    expect(await edge.refreshPack!()).toMatchObject({ status: 'updated', heldVersion: next.version });
    const after = await ringOne(edge, next.version);
    expect(after.total).toBe('₹37.50');
    expect(after.line).toBe('₹37.50');
    expect(after.errors).toEqual([]);

    // ── A restart of the box: the till still charges ₹37.50 from the pack on its own disk (no cloud round trip).
    running = false;
    await edge.stop();
    edge = await startBox(dir);
    running = true;
    const restarted = await ringOne(edge, next.version);
    expect(restarted.total).toBe('₹37.50');
    expect(restarted.line).toBe('₹37.50');
  }, 180_000);
});
