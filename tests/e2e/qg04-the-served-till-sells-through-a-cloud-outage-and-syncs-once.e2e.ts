import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { prepareTillBox, signInThroughScreen } from '../support/till-operator';
import { startRealCloud, type RealCloud } from '../support/real-store';
import { theEvening, pinTheEveningClock, pinThePageClock } from '../support/evening-clock';

/**
 * **QG-04 (roadmap §22 "Core sale survives internet/cloud outage; sync retries produce one business effect"; §32 "Duplicate
 * business effect — zero after retries/replay"; hard rules #1 and #2) — in a REAL browser, through the REAL store computer,
 * against the REAL head office over REAL PostgreSQL.**
 *
 * Between the store computer and head office sits a line this test can cut — the shop's internet. Then:
 *
 *   1. the line is CUT: the served till signs the cashier in, scans the barcode and takes cash — the sale commits on the box
 *      (its outbox holds it) and the box's sync attempt fails; head office has never heard of the sale;
 *   2. the line comes back but DROPS THE ANSWER: head office receives the sale and records it, the box never hears back, so
 *      the sale stays queued — the case that makes a naive client post it twice;
 *   3. the line is whole: the box retries — and head office still holds exactly ONE sale, stock down by exactly one (10 → 9,
 *      never 8), with nothing dead-lettered; another pass sends nothing.
 *
 * Synthetic data, a fresh random tenant. Needs DATABASE_URL AND the pre-installed Chromium; without either it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['qg04', 'outage', 'signing', 'key'].join('-').padEnd(48, '0');
const STORE = 'S1';
const LANE = 'lane-1';
const OWNER = 'u-owner';
const BOX = 'u-box';
const CASHIER = 'u-meena';
const PRODUCT = 'p-dal';
const BARCODE = '8901234560013';
const PRICE = 12_000;

interface PosWindow {
  readonly posSession?: {
    hasCatalogue(): boolean;
    tenderCash(saleId: string, receiptNumber: string, atIsoUtc: string): Promise<string>;
    nextReceipt(): Promise<string>;
    newSale(): void;
  };
}

/** The shop's internet line: forwards to head office, or is cut, or delivers the request and drops the answer. */
type LineState = 'up' | 'cut' | 'drops_the_answer';
async function startLine(target: string): Promise<{ readonly url: string; set(s: LineState): void; readonly seen: string[]; stop(): Promise<void> }> {
  let state: LineState = 'up';
  const seen: string[] = [];
  const upstream = new URL(target);
  const server: Server = createServer((req, res) => {
    seen.push(`${state} ${req.method} ${req.url}`);
    if (state === 'cut') { req.socket.destroy(); return; }
    const out = httpRequest({ host: upstream.hostname, port: upstream.port, method: req.method, path: req.url, headers: req.headers }, (answer) => {
      if (state === 'drops_the_answer') { answer.resume(); answer.on('end', () => { res.socket?.destroy(); }); return; }
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
    });
    out.on('error', () => { res.socket?.destroy(); });
    req.pipe(out);
  });
  await new Promise<void>((r) => { server.listen(0, '127.0.0.1', () => { r(); }); });
  const addr = server.address();
  return {
    url: `http://127.0.0.1:${typeof addr === 'object' && addr !== null ? addr.port : 0}`,
    set: (s) => { state = s; }, seen,
    stop: () => new Promise<void>((r) => { server.close(() => { r(); }); server.closeAllConnections(); }),
  };
}

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('QG-04 — the served till sells through a cloud outage and the retries land once', () => {
  let browser: Browser;
  let cloud: RealCloud;
  const dirs: string[] = [];
  const stops: (() => Promise<void>)[] = [];
  const call = (method: 'GET' | 'POST', path: string, body?: unknown, idempotencyKey?: string) =>
    cloud.request({ method, path, userId: OWNER, ...(body === undefined ? {} : { body }), ...(idempotencyKey === undefined ? {} : { idempotencyKey }) });
  const onHand = async (): Promise<number | undefined> =>
    ((await call('GET', `/v1/inventory/availability?productId=${PRODUCT}`)).body as { rows: { locationId: string; onHandMinor: number }[] }).rows.find((r) => r.locationId === STORE)?.onHandMinor;

  beforeAll(async () => {
    const evening = pinTheEveningClock(theEvening());
    execFileSync('node', ['scripts/build-app.mjs', 'pos'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
    cloud = await startRealCloud({ databaseUrl: DATABASE_URL!, tenantId: randomUUID(), owner: OWNER, packSigningKey: KEY });
    await cloud.grant(BOX, 'store_computer', undefined, [STORE]);
    await cloud.grant(CASHIER, 'cashier');
    const today = evening.shopDate;
    for (const [path, body, key] of [
      ['/v1/catalogue/tax-classes/0713/rates/2017-07-01', { rateBps: 500 }, 'tax'],
      [`/v1/catalogue/products/${PRODUCT}/publish`, { product: { sku: 'DAL-1KG', name: 'Synthetic toor dal 1kg', baseUom: 'ea', primaryCategoryId: 'grocery', taxClass: '0713', lifecycle: 'active' }, categories: [{ categoryId: 'grocery', name: 'Grocery', parentId: null }] }, 'publish'],
      [`/v1/prices/list/${PRODUCT}/entries/e1`, { scope: 'store', scopeRef: STORE, priceMinor: PRICE, mrpMinor: 13_000, costMinor: 10_000, marginFloorBps: 0, currency: 'INR', effectiveFrom: today }, 'price'],
      [`/v1/catalogue/products/${PRODUCT}/barcodes/${BARCODE}`, { kind: 'ean' }, 'barcode'],
      ['/v1/catalogue/pack', { storeId: STORE, asOf: today }, 'pack'],
      ['/v1/inventory/movements', { movementId: 'mv-opening', productId: PRODUCT, locationId: STORE, kind: 'received', quantityMinor: 10, uom: 'ea', occurredAt: new Date(Date.now() - 2 * 3_600_000).toISOString(), enteredBy: OWNER, unitCostMinor: 10_000 }, 'opening'],
    ] as const) {
      const r = await call('POST', path, body, key);
      expect(r.status, `${path}: ${JSON.stringify(r.body)}`).toBeLessThan(300);
    }
  }, 180_000);
  afterAll(async () => { await browser?.close(); await cloud?.stop(); vi.useRealTimers(); });
  afterEach(async () => {
    for (const stop of stops.splice(0).reverse()) await stop();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  async function startBox(cloudUrl: string): Promise<EdgeProcess> {
    const dataDir = await mkdtemp(join(tmpdir(), 'sre-qg04-'));
    dirs.push(dataDir);
    const { EDGE_PACK_FILE: packFile } = await prepareTillBox({
      dir: dataDir, key: KEY, people: [{ userId: CASHIER, displayName: 'Meena' }],
      pack: {
        policies: { storeId: STORE, branchId: STORE, branchName: 'SRE Hyper Market', warehouseId: 'S1-BACK', tradingDayCutoff: '00:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 0 },
        lossPreventionRules: [],
      },
    });
    const edge = (await startEdge({
      EDGE_DATA_DIR: dataDir, EDGE_TENANT_ID: cloud.tenantId, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
      EDGE_LANE_PORT: '0', EDGE_LANE_ID: LANE, EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_PACK_FILE: packFile,
      CLOUD_API_URL: cloudUrl, CLOUD_API_TOKEN: cloud.token(BOX),
    }, () => {}))!;
    stops.push(() => edge.stop());
    return edge;
  }

  it('cut → the till sells and the box holds the sale → the answer is lost → retried: head office holds ONE sale and stock fell by exactly one', async () => {
    const line = await startLine(cloud.baseUrl);
    stops.push(() => line.stop());
    const edge = await startBox(line.url);
    expect(await edge.refreshPack!()).toMatchObject({ status: 'updated', heldVersion: 1 }); // pulled while the line was up
    expect(await onHand()).toBe(10);

    // ── 1 · The internet is CUT. The served till still signs in, scans and takes cash: the sale commits on the box.
    line.set('cut');
    const context = await browser.newContext();
    await pinThePageClock(context);
    stops.push(() => context.close());
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${edge.screens!.port}/pos/`, { waitUntil: 'load' });
    await page.waitForFunction(() => (globalThis as unknown as PosWindow).posSession?.hasCatalogue() === true, undefined, { timeout: 15_000 });
    await signInThroughScreen(page, CASHIER);
    const soldAt = await page.evaluate(() => new Date().toISOString());
    await page.keyboard.type(BARCODE);
    await page.keyboard.press('Enter');
    await page.waitForSelector('#lines tr');
    expect(await page.textContent('#total')).toBe('₹120.00');
    const receipt = await page.evaluate(async ([when]) => {
      const w = globalThis as unknown as PosWindow;
      const r = await w.posSession!.tenderCash('S-OUT-1', await w.posSession!.nextReceipt(), when!);
      w.posSession!.newSale();
      return r;
    }, [soldAt]);
    expect(receipt).toMatch(/-000001$/);
    expect(edge.outbox.unsentCount(), 'the sale is committed on the box, waiting for the line').toBe(1);
    const failed = await edge.syncOnce!();
    expect(failed).toMatchObject({ sent: 0, dead: 0, remaining: 1 });
    expect(line.seen.some((s) => s.startsWith('cut POST')), 'the box did try head office while the line was cut').toBe(true);
    expect((await call('GET', '/v1/sales/S-OUT-1')).status).toBe(404);

    // ── 2 · The line returns but drops the ANSWER: head office records the sale, the box never hears back.
    line.set('drops_the_answer');
    const lost = await edge.syncOnce!();
    expect(lost.remaining, 'unacknowledged, so still queued').toBe(1);
    expect(lost.dead).toBe(0);
    expect((await call('GET', '/v1/sales/S-OUT-1')).body).toMatchObject({ saleId: 'S-OUT-1' });
    expect(await onHand()).toBe(9);

    // ── 3 · The line is whole: the box retries the same sale — and head office has ONE business effect.
    line.set('up');
    expect(await edge.syncOnce!()).toMatchObject({ dead: 0, remaining: 0 });
    expect((await call('GET', '/v1/sales/S-OUT-1')).body).toMatchObject({ saleId: 'S-OUT-1', banked: true });
    expect(await onHand(), 'exactly one sale came off the shelf — never two').toBe(9);
    expect(await edge.syncOnce!()).toMatchObject({ sent: 0, dead: 0, remaining: 0 });
    expect(await onHand()).toBe(9);
    expect(errors).toEqual([]);
  }, 180_000);
});
