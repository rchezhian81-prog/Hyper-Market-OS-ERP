import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { apiHarness } from '../support/api-harness';
import { startCustomerShop } from './lib/customer-shop';
import { writeSignedPack } from '../../edge/store-edge/src/signed-pack-file';
import { hmacSigner, publishPack } from '../../services/catalogue/src/index';
import type { CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';
import { enrolmentCodeHash } from '../../packages/platform-admin/src/device-enrolment';
import { prepareTillBox, pinOf } from '../support/till-operator';
import { deviceBase as boxDoor, sharedDeviceTls, trustingBrowserArgs } from '../support/box-tls';

/**
 * **OB-521 (R8-A) — on a withdrawn or too-old build, the handhelds and the phone apps finish the work in hand and refuse
 * to START new work, in plain English and Tamil, on the real screens.**
 *
 *   • the OWNER app, served by a real store computer whose signed pack carries the withdrawn build: a new decision is
 *     refused in the gate's own words (English, then Tamil), and nothing is queued;
 *   • the PICKER: the first pick of a wave not yet started is refused ("Update this handheld"), nothing queued; with no
 *     policy the same pick goes through;
 *   • the DRIVER: the first step of a route (a failed delivery auto-departs first) is refused, nothing queued;
 *   • the WAREHOUSE door: a new direct-delivery check-in is refused, its Tamil words shown in Tamil;
 *   • the CUSTOMER app: the first scan of a new scan-and-go basket is refused.
 * The policy is served the way the store computer serves it (`appVersionPolicy` beside the work). Skips with no browser.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['r8a', 'version', 'signing', 'key'].join('-').padEnd(48, '0');
// This build is 0.0.0 (APP_BUILD_VERSION): head office now needs 98.0.0 at least.
const WITHDRAWN = { currentVersion: '99.0.0', previousVersion: '98.0.0', minimumSupportedVersion: '98.0.0' };

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

/** A barcode scanner is a keyboard: the same window keydown events the screen's scan listener reads. */
const scan = async (page: Page, code: string): Promise<void> => {
  await page.waitForSelector('#scan:not([hidden])', { timeout: 10_000 });
  await page.evaluate((c: string) => {
    const w = globalThis as unknown as { dispatchEvent(e: unknown): boolean; KeyboardEvent: new (type: string, init: { key: string; bubbles: boolean }) => unknown };
    for (const ch of c) w.dispatchEvent(new w.KeyboardEvent('keydown', { key: ch, bubbles: true }));
    w.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  }, code);
};
const bannerSays = async (page: Page, title: string | RegExp, text: RegExp): Promise<void> => {
  await page.locator('#banner:not([hidden]) #banner-title', { hasText: title }).waitFor({ timeout: 10_000 });
  await expect.poll(() => page.textContent('#banner-text')).toMatch(text);
};
const unsent = (page: Page, outbox: string): Promise<number> =>
  page.evaluate((o: string) => ((globalThis as unknown as Record<string, { unsentCount(): number } | undefined>)[o]?.unsentCount() ?? -1), outbox);

describe.skipIf(!HAVE_BROWSER)('OB-521 — the handhelds and phone apps start no new work on a withdrawn or too-old build', () => {
  let browser: Browser;
  let edge: EdgeProcess;
  let dir: string;
  beforeAll(async () => {
    for (const app of ['owner-app', 'picker-app', 'delivery-app', 'warehouse-app', 'customer-app']) execFileSync('node', ['scripts/build-app.mjs', app], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
    dir = await mkdtemp(join(tmpdir(), 'sre-r8a-e2e-'));
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, JSON.stringify({
      version: 1, lossPreventionRules: [], versionPolicy: WITHDRAWN,
      policies: { tradingDayCutoff: '02:00', storeId: 'store-1', branchId: 'store-1', branchName: 'Main', staleAfterSeconds: 900 },
      approvals: [{ id: 'a1', subjectType: 'price_change', subjectRef: 'Toor dal 1kg', requestedBy: 'u-buyer', branchId: 'store-1', valueMinor: 45_000 }],
    }), 'utf8');
    edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0',
      EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_PACK_FILE: packFile,
    }, () => {}))!;
  }, 240_000);
  afterAll(async () => { await browser?.close(); await edge?.stop(); if (dir !== undefined) await rm(dir, { recursive: true, force: true }); });

  it('the owner app the store computer serves refuses a new decision — English, then Tamil — and queues nothing', async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    try {
      await page.goto(`http://127.0.0.1:${edge.screens!.port}/owner/`, { waitUntil: 'load' });
      expect(await page.evaluate(() => (globalThis as unknown as { ownerData?: { appVersionPolicy?: unknown } }).ownerData?.appVersionPolicy)).toMatchObject({ minimumSupportedVersion: '98.0.0' });
      await page.locator('#approvals button.primary').first().click();
      await page.waitForSelector('#decide:not([hidden])');
      await page.locator('#decide-reasons button').first().click();
      await bannerSays(page, /.+/, /owner app \(version 0\.0\.0\) is too old.*98\.0\.0.*a new decision cannot be made here/);
      expect(await page.isHidden('#queued-section')).toBe(true);
      await page.click('#banner-ok');
      await page.click('#lang');
      await page.locator('#approvals button.primary').first().click();
      await page.waitForSelector('#decide:not([hidden])');
      await page.locator('#decide-reasons button').first().click();
      await bannerSays(page, /.+/, /இங்கே புதிய முடிவு எடுக்க முடியாது/);
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  });

  it('the picker: a wave not started is refused at its first pick, nothing queued; with no policy the pick goes through', async () => {
    const wave = (policy: unknown) => ({
      waveId: 'W-1', pickerId: 'u-picker', appVersionPolicy: policy,
      lines: [{ lineId: 'l1', orderRef: 'ORD-1', productId: 'MILK', description: 'Milk 1L', bin: 'A-01', requiredQty: 1, uom: 'ea', unitPrice: { minor: 5000, currency: 'INR' } }],
    });
    for (const [policy, refused] of [[WITHDRAWN, true], [null, false]] as const) {
      const srv = await startShell('apps/picker-app/web', 'pickerData', wave(policy));
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
        if (refused) {
          await bannerSays(page, 'Update this handheld', /picking handheld's app \(version 0\.0\.0\) is too old.*a new wave cannot be started/);
          expect(await unsent(page, 'pickerOutbox')).toBe(0);
        } else {
          await page.waitForSelector('.line.picked', { timeout: 10_000 });
          expect(await unsent(page, 'pickerOutbox')).toBe(1);
        }
      } finally { await context.close(); await srv.stop(); }
    }
  });

  it('the driver: the first step of a route is refused and nothing is queued', async () => {
    const srv = await startShell('apps/delivery-app/web', 'driverData', { routeId: 'R-1', driverId: 'u-driver', appVersionPolicy: WITHDRAWN, stops: [{ stopId: 's1', orderRef: 'ORD-1', area: 'Anna Nagar', codMinor: 0 }] });
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    try {
      await page.goto(`${srv.base}/`, { waitUntil: 'load' });
      await page.waitForFunction(() => (globalThis as unknown as { routeSession?: unknown }).routeSession != null, undefined, { timeout: 10_000 });
      await page.locator('.stop').first().click();
      await page.click('#failed');
      await page.waitForSelector('#sheet:not([hidden])', { timeout: 10_000 });
      await page.locator('#choices button').first().click();
      await bannerSays(page, 'Update this app', /delivery phone's app \(version 0\.0\.0\) is too old.*a new route cannot be started/);
      expect(await unsent(page, 'driverOutbox')).toBe(0);
      expect(await page.locator('.stop.failed').count()).toBe(0);
    } finally { await context.close(); await srv.stop(); }
  });

  it('the warehouse door: a new direct-delivery check-in is refused, in Tamil when the screen is in Tamil', async () => {
    const srv = await startShell('apps/warehouse-app/web', 'warehouseData', {
      assignmentId: 'A-DSD', workerId: 'u-recv', storeId: 'S-A', appVersionPolicy: WITHDRAWN,
      bins: [{ binId: 'BIN-A', storeId: 'S-A', capacityMinor: 1000, pickable: true }],
      barcodes: [{ barcode: '890MILK', productId: 'p-milk', level: 'unit' }],
      packs: [{ productId: 'p-milk', baseUom: 'ea', levels: [{ level: 'unit', containsMinor: 1, barcode: '890MILK' }] }],
      openDeliveries: [{ poId: 'po-dairy', number: 'PO-0007', supplierId: 'sup-dairy', grnId: 'grn-dairy', ordered: [{ productId: 'p-milk', quantityMinor: 2, unitCost: { minor: 2500, currency: 'INR' } }] }],
      goodsIn: [],
    });
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    try {
      await page.goto(`${srv.base}/`, { waitUntil: 'load' });
      await page.waitForFunction(() => (globalThis as unknown as { dsdSession?: unknown }).dsdSession != null, undefined, { timeout: 10_000 });
      await page.click('#lang');
      await page.click('#dsd-open');
      await expect.poll(() => page.locator('#dsd').isVisible()).toBe(true);
      await page.click('#dsd-choices button[data-choice="po:po-dairy"]');
      for (const d of '9876543210') await page.click(`#dsd-driver-keypad button:text-is("${d}")`);
      await page.click('#dsd-driver');
      await page.click('#dsd-start');
      await bannerSays(page, 'இந்தக் கருவியைப் புதுப்பிக்கவும்', /கிடங்குக் கருவியின் செயலி.*புதிய வேலை தொடங்க முடியாது/);
      expect(await page.locator('#dsd-work-panel').isVisible()).toBe(false);
      expect(await unsent(page, 'warehouseOutbox')).toBe(0);
    } finally { await context.close(); await srv.stop(); }
  });

  it('the customer app: the first scan of a new scan-and-go basket is refused', async () => {
    const h = apiHarness();
    const T = randomUUID();
    const store = await startCustomerShop({
      h, tenantId: T, subject: 'cust-r8a',
      shopData: async () => ({
        tenantId: T, customerRef: 'guest', packVersion: 1, locationId: 'store-01', appVersionPolicy: WITHDRAWN,
        products: [{ productId: 'BROOM', name: 'Synthetic Broom', categoryId: 'x', unitPriceMinor: 120_00, uom: 'ea', barcodes: ['8900000000029'], status: 'active', availableMinor: 5, availabilityAgeMinutes: 1 }],
        slots: [], deliveryFeeMinor: 0,
      }),
    });
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    try {
      await page.goto(`${store.base}/`, { waitUntil: 'load' });
      await page.waitForFunction(() => (globalThis as unknown as { shopScanAndGo?: unknown }).shopScanAndGo != null, undefined, { timeout: 10_000 });
      await page.click('#tab-scan');
      await page.fill('#sg-typed', '8900000000029');
      await page.click('#sg-add');
      await page.locator('#sg-say[data-state="app_version_too_old"]').waitFor({ timeout: 10_000 });
      expect(await page.textContent('#sg-say')).toMatch(/shopping app \(version 0\.0\.0\) is too old.*a new order cannot be started/);
      expect(store.writes).toEqual([]);
    } finally { await context.close(); await store.stop(); }
  });
});

describe.skipIf(!HAVE_BROWSER)('OB-521 — the queue till, served by the store computer over its device socket', () => {
  const TENANT = 't-sre';
  const QKEY = ['r8a', 'queue', 'till', 'key'].join('-').padEnd(48, '0');
  const DAL = '8901234567890';
  const ENROL = 'R8A-QUEUE-TILL1-ENROL1';
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

  it('a new basket is refused in the queue till\'s own words, English and Tamil; nothing is on the basket', async () => {
    dir = await mkdtemp(join(tmpdir(), 'sre-r8a-queue-'));
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
          version: 1, policies: { tradingDayCutoff: '02:00', storeId: 'store-1', branchId: 'store-1' }, lossPreventionRules: [], versionPolicy: WITHDRAWN,
          devices: [{ deviceId: 'hh-q1', kind: 'handheld', status: 'registered', label: 'Queue till 1', enrolment: { codeHash: enrolmentCodeHash(ENROL), expiresAt: '2099-01-01T00:00:00.000Z' } }],
          rollout: { format: 'sre-rollout/1', branchId: 'store-1', switches: [{ key: 'pos.queue_busting', branch: null, lanes: [{ laneId: 'lane-1', enabled: true, version: 1 }] }] },
        },
      }),
    }, () => {}))!;
    const phone = await browser.newContext({ viewport: { width: 360, height: 640 }, hasTouch: true, isMobile: true });
    const page = await phone.newPage();
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
      await bannerSays(page, /.+/, /queue till's app \(version 0\.0\.0\) is too old.*98\.0\.0.*a new basket cannot be started/);
      expect(await page.locator('#lines .line').count()).toBe(0);
      await page.click('#banner-ok');
      await page.click('#lang');
      await page.keyboard.type(DAL); await page.keyboard.press('Enter');
      await bannerSays(page, /.+/, /புதிய கூடை தொடங்க முடியாது/);
    } finally { await phone.close(); }
  }, 120_000);
});
