import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';
import { writeSignedPack } from '../../edge/store-edge/src/signed-pack-file';
import { hmacSigner, publishPack } from '../../services/catalogue/src/index';
import type { CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';
import { enrolmentCodeHash } from '../../packages/platform-admin/src/device-enrolment';
import { APP_BUILD_VERSION } from '../../packages/platform-admin/src/client-version';
import { prepareTillBox, pinOf } from '../support/till-operator';
import { deviceBase as boxDoor, sharedDeviceTls, trustingBrowserArgs } from '../support/box-tls';

/**
 * **Round 9 · OB-537 — on the real screens, every handheld record carries the app build that made it.**
 *
 *   • the PICKER and the DRIVER: a pick and a failed stop queue on the device's outbox naming this build (`appVersion`);
 *   • the WAREHOUSE handheld: its page's own outbox names this build on what it queues;
 *   • the QUEUE TILL, served by a real store computer over its device socket: a basket scanned and handed over is kept on the
 *     box's disk with the build it was made on (`handheldBuild`), and the box's build report for head office is queued.
 * Skips where no browser binary is present.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);

async function startShell(webDir: string, global: string, data: Record<string, unknown>): Promise<{ base: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const [path = '/'] = (req.url ?? '/').split('?');
      const file = path === '/' ? 'index.html' : path.replace(/^\//, '');
      try {
        let body = (await readFile(join(webDir, file))).toString('utf8');
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream';
        if (file.endsWith('.html')) body = body.replace('<!--SCREEN-DATA-->', `<script>window.${global} = ${JSON.stringify(data).replace(/</g, '\\u003c')};</script>`);
        res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
        res.end(body);
      } catch { res.writeHead(404); res.end('not found'); }
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

const scan = async (page: Page, code: string): Promise<void> => {
  await page.waitForSelector('#scan:not([hidden])', { timeout: 10_000 });
  await page.evaluate((c: string) => {
    const w = globalThis as unknown as { dispatchEvent(e: unknown): boolean; KeyboardEvent: new (type: string, init: { key: string; bubbles: boolean }) => unknown };
    for (const ch of c) w.dispatchEvent(new w.KeyboardEvent('keydown', { key: ch, bubbles: true }));
    w.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  }, code);
};
/** What the page's own device outbox holds: each record's key and the build it was queued on. */
const queued = (page: Page, outbox: string): Promise<[string, string | undefined][]> =>
  page.evaluate((o: string) => ((globalThis as unknown as Record<string, { pending(): { key: string; appVersion?: string }[] } | undefined>)[o]?.pending() ?? [])
    .map((i) => [i.key, i.appVersion] as [string, string | undefined]), outbox);

describe.skipIf(!HAVE_BROWSER)('OB-537 — the handhelds\' records name the build that made them', () => {
  let browser: Browser;
  beforeAll(async () => {
    for (const app of ['picker-app', 'delivery-app', 'warehouse-app']) execFileSync('node', ['scripts/build-app.mjs', app], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 240_000);
  afterAll(async () => { await browser?.close(); });

  it('the picker\'s pick is queued with this build', async () => {
    const srv = await startShell('apps/picker-app/web', 'pickerData', {
      waveId: 'W-1', pickerId: 'u-picker', appVersionPolicy: null,
      lines: [{ lineId: 'l1', orderRef: 'ORD-1', productId: 'MILK', description: 'Milk 1L', bin: 'A-01', requiredQty: 1, uom: 'ea', unitPrice: { minor: 5000, currency: 'INR' } }],
    });
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    try {
      await page.goto(`${srv.base}/`, { waitUntil: 'load' });
      await page.waitForFunction(() => (globalThis as unknown as { pickSession?: unknown }).pickSession != null, undefined, { timeout: 10_000 });
      await page.locator('.line').first().click();
      await scan(page, 'A-01');
      await scan(page, 'MILK');
      await page.waitForSelector('#sheet:not([hidden])', { timeout: 10_000 });
      await page.click('#sheet-ok');
      await page.waitForSelector('.line.picked', { timeout: 10_000 });
      await expect.poll(() => queued(page, 'pickerOutbox')).toEqual([[expect.stringContaining('W-1'), APP_BUILD_VERSION]]);
    } finally { await context.close(); await srv.stop(); }
  });

  it('the driver\'s failed stop is queued with this build', async () => {
    const srv = await startShell('apps/delivery-app/web', 'driverData', { routeId: 'R-1', driverId: 'u-driver', appVersionPolicy: null, stops: [{ stopId: 's1', orderRef: 'ORD-1', area: 'Anna Nagar', codMinor: 0 }] });
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    try {
      await page.goto(`${srv.base}/`, { waitUntil: 'load' });
      await page.waitForFunction(() => (globalThis as unknown as { routeSession?: unknown }).routeSession != null, undefined, { timeout: 10_000 });
      await page.locator('.stop').first().click();
      await page.click('#failed');
      await page.waitForSelector('#sheet:not([hidden])', { timeout: 10_000 });
      await page.locator('#choices button').first().click();
      // The departure and the failed attempt are queued as soon as the reason is chosen (the page then asks what next).
      await expect.poll(async () => (await queued(page, 'driverOutbox')).length, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
      const items = await queued(page, 'driverOutbox');
      expect(items.map(([, v]) => v)).toEqual(items.map(() => APP_BUILD_VERSION));
    } finally { await context.close(); await srv.stop(); }
  });

  it('the warehouse handheld\'s outbox names this build on what it queues', async () => {
    const srv = await startShell('apps/warehouse-app/web', 'warehouseData', {
      assignmentId: 'A-1', workerId: 'u-recv', storeId: 'S-A', appVersionPolicy: null,
      bins: [{ binId: 'BIN-A', storeId: 'S-A', capacityMinor: 1000, pickable: true }], barcodes: [], packs: [], openDeliveries: [], goodsIn: [],
    });
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    try {
      await page.goto(`${srv.base}/`, { waitUntil: 'load' });
      await page.waitForFunction(() => (globalThis as unknown as { warehouseOutbox?: unknown }).warehouseOutbox != null, undefined, { timeout: 10_000 });
      await page.evaluate(() => {
        const o = (globalThis as unknown as { warehouseOutbox: { enqueue(e: unknown): unknown } }).warehouseOutbox;
        o.enqueue({ id: 'c-1', type: 'StockCounted', occurredAt: '2026-10-28T05:00:00.000Z', idempotencyKey: 'count:c-1', source: 'warehouse', version: 1, payload: { countId: 'c-1' } });
      });
      expect(await queued(page, 'warehouseOutbox')).toEqual([['count:c-1', APP_BUILD_VERSION]]);
    } finally { await context.close(); await srv.stop(); }
  });
});

describe.skipIf(!HAVE_BROWSER)('OB-537 — the queue till\'s basket is kept with its build on the store computer', () => {
  const TENANT = 't-sre';
  const QKEY = ['r9b', 'queue', 'till', 'key'].join('-').padEnd(48, '0');
  const DAL = '8901234567890';
  const ENROL = 'R9B-QUEUE-TILL1-ENROL1';
  let browser: Browser;
  let deviceTls: Awaited<ReturnType<typeof sharedDeviceTls>>;
  let edge: EdgeProcess | undefined;
  let dir: string | undefined;
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'pos'], { stdio: 'ignore' });
    execFileSync('node', ['scripts/build-app.mjs', 'queue-pos'], { stdio: 'ignore' });
    deviceTls = await sharedDeviceTls();
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM, args: trustingBrowserArgs(deviceTls.keyPin) });
  }, 180_000);
  afterAll(async () => { await browser?.close(); await edge?.stop(); if (dir !== undefined) await rm(dir, { recursive: true, force: true }); });

  it('scanned and handed over on the queue till: on the box\'s disk with the build it was made on; its report queued for head office', async () => {
    dir = await mkdtemp(join(tmpdir(), 'sre-r9b-queue-'));
    const snapshot: CatalogueSnapshot = {
      tenantId: TENANT, version: 3, builtAt: new Date().toISOString(),
      products: [{ productId: 'P-DAL', sku: 'DAL-1', name: 'Toor dal 1kg', baseUom: 'ea', unitPriceMinor: 120_00, taxBps: 500, status: 'active' }],
      barcodes: [{ code: DAL, productId: 'P-DAL', kind: 'standard' }],
    };
    const published = publishPack({ snapshot, approvals: [], signer: hmacSigner(QKEY), publishedBy: 'u-manager', publishedAt: snapshot.builtAt });
    if (!published.ok || published.pack === undefined) throw new Error(published.detail);
    await writeSignedPack(dir, published.pack);
    edge = (await startEdge({
      EDGE_DEVICE_TLS_DIR: deviceTls.dir,
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: TENANT, PACK_SIGNING_KEY: QKEY, EDGE_CAPACITY_BYTES: '10485760',
      EDGE_LANE_PORT: '0', EDGE_SCREEN_PORT: '0', EDGE_DEVICE_PORT: '0', EDGE_APPS_DIR: 'apps',
      ...await prepareTillBox({
        dir, key: QKEY,
        people: [{ userId: 'u-ravi', displayName: 'Ravi' }],
        pack: {
          version: 1, policies: { tradingDayCutoff: '02:00', storeId: 'store-1', branchId: 'store-1' }, lossPreventionRules: [],
          devices: [{ deviceId: 'hh-q1', kind: 'handheld', status: 'registered', label: 'Queue till 1', enrolment: { codeHash: enrolmentCodeHash(ENROL), expiresAt: '2099-01-01T00:00:00.000Z' } }],
          rollout: { format: 'sre-rollout/1', branchId: 'store-1', switches: [{ key: 'pos.queue_busting', branch: null, lanes: [{ laneId: 'lane-1', enabled: true, version: 1 }] }] },
        },
      }),
    }, () => {}))!;
    const phone = await browser.newContext({ viewport: { width: 360, height: 640 }, hasTouch: true, isMobile: true });
    const page = await phone.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    try {
      await page.goto(`${boxDoor(edge)}/queue-pos/`, { waitUntil: 'load' });
      await page.fill('#deviceId', 'hh-q1');
      await page.fill('#code', ENROL);
      await page.click('button[type=submit]');
      await page.waitForURL(/\/queue-pos\/sign-in$/);
      await page.fill('input[name=staffId]', 'u-ravi');
      await page.fill('input[name=pin]', pinOf('u-ravi'));
      await page.click('button[type=submit]');
      await page.waitForURL(/\/queue-pos\/$/);
      await page.waitForFunction(async () => (await (globalThis as unknown as { queueSession?: { ready: Promise<boolean> } }).queueSession?.ready) === true, undefined, { timeout: 15_000 });
      await page.keyboard.type(DAL); await page.keyboard.press('Enter');
      await page.locator('#lines .line').first().waitFor({ timeout: 10_000 });
      await page.click('#handover');
      await page.locator('#handed:not([hidden])').waitFor({ timeout: 10_000 });
      expect(await page.textContent('#handed-code')).toMatch(/^\d{4}$/);
      const baskets = (await readLog(join(dir, 'queue-baskets.log'))).flatMap((r) => (r.ok ? [JSON.parse(r.record) as Record<string, unknown>] : []));
      expect(baskets.map((b) => b['handheldBuild'])).toEqual([{ client: 'queue_till', appVersion: APP_BUILD_VERSION }]);
      expect(edge.deviceEventsOutbox.pending().map((i) => [i.event.type, (i.event.payload as { reportedBuild?: unknown }).reportedBuild]))
        .toEqual([['QueueBasketBuildReported', { client: 'queue_till', appVersion: APP_BUILD_VERSION }]]);
      expect(errors).toEqual([]);
    } finally { await phone.close(); }
  }, 120_000);
});
