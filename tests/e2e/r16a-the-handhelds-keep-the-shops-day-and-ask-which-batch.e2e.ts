import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { enrolmentCodeHash } from '../../packages/platform-admin/src/device-enrolment';
import { shopDateIn } from '../../packages/calendar/src/shop-clock';
import { prepareTillBox, pinOf } from '../support/till-operator';
import { TEST_PACK_KEY } from '../support/api-harness';
import { deviceBase as boxDoor, sharedDeviceTls, trustingBrowserArgs } from '../support/box-tls';
import { signInOnPhonePage } from '../support/phone-sign-in-page';
import { auditPage } from './lib/a11y-audit';

/**
 * **Round 16 (R16-A) in a real Chromium on a phone's screen (360 × 640, touch).**
 *
 * P1 (OB-606/607): the store computer gives EVERY page it serves the shop's zone from its signed pack — the warehouse handheld
 * on the shop wifi and the queue till as well as the till. The pack names Asia/Tokyo (NOT India); every phone here is set to
 * New York (`timezoneId: 'America/New_York'`) with its clock pinned to 15:30 UTC — 00:30 the NEXT day in Tokyo, 21:00 the same
 * day in India (the shop default), 11:30 the same day in New York. Each page's shop day must be Tokyo's: before round 16 the
 * handheld and queue-till pages were served no zone and fell back to India's day.
 *
 * OB-611: at the van-delivery door a product that came off the van in two batches is handed back from the batch the person
 * picks — the handheld ASKS (offline, English and Tamil, every choice 56 px), and the record it queues carries the batch. A
 * product in one batch asks nothing. Skips where no browser binary is present.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const HANDHELD = { viewport: { width: 360, height: 640 }, hasTouch: true, isMobile: true };
const PACK_ZONE = 'Asia/Tokyo';
const DEVICE_ZONE = 'America/New_York';
const UTC_DAY = new Date().toISOString().slice(0, 10); // the UTC date on purpose: the pinned moment is a UTC time of day
const PINNED = `${UTC_DAY}T15:30:00.000Z`;
const SHOP_DAY = shopDateIn(PINNED, PACK_ZONE); // the next day in Tokyo
const CODE = 'ZONEA-ZONEB-ZONEC-ZONED';

interface ShopDayWindow { readonly shopTimeZone?: string; readonly sreShopDay?: { zone: string; today(): string; timeOf(v: unknown): string } }
const shopDayOn = (page: Page) => page.evaluate((at) => {
  const w = globalThis as unknown as ShopDayWindow;
  return { served: w.shopTimeZone ?? null, zone: w.sreShopDay?.zone ?? null, today: w.sreShopDay?.today() ?? null, time: w.sreShopDay?.timeOf(at) ?? null };
}, PINNED);

describe.skipIf(!HAVE_BROWSER)('the handhelds keep the shop\'s day from the pack, and the door asks which batch (R16-A)', () => {
  let browser: Browser;
  let deviceTls: Awaited<ReturnType<typeof sharedDeviceTls>>;
  const stops: (() => Promise<void>)[] = [];
  beforeAll(async () => {
    for (const app of ['warehouse-app', 'queue-pos', 'pos']) execFileSync('node', ['scripts/build-app.mjs', app], { stdio: 'ignore' });
    deviceTls = await sharedDeviceTls();
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM, args: trustingBrowserArgs(deviceTls.keyPin) });
  }, 180_000);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => { for (const s of stops.splice(0).reverse()) await s(); });

  const phone = async (): Promise<BrowserContext> => {
    const context = await browser.newContext({ ...HANDHELD, timezoneId: DEVICE_ZONE, serviceWorkers: 'block' });
    await context.clock.install({ time: new Date(PINNED) });
    stops.push(() => context.close());
    return context;
  };

  it('P1: the warehouse handheld, the queue till and the till each take the pack\'s zone (Asia/Tokyo) on a New York phone', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-r16a-e2e-zone-'));
    stops.push(() => rm(dir, { recursive: true, force: true }));
    const ready = await prepareTillBox({
      dir, key: TEST_PACK_KEY,
      people: [{ userId: 'u-worker', displayName: 'Worker One', permissions: ['inventory.movement.append'] }, { userId: 'u-ravi', displayName: 'Ravi' }],
      pack: {
        version: 1, lossPreventionRules: [],
        policies: { tradingDayCutoff: '00:00', storeId: 'store-1', branchId: 'store-1', branchName: 'Main', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, privacySlaDays: 15, warehouseId: 'wh-1', timeZone: PACK_ZONE },
        warehouse: { assignmentId: 'A-1', workerId: 'u-worker', storeId: 'store-1', bins: [] },
        devices: [{ deviceId: 'hh-z1', kind: 'handheld', status: 'registered', label: 'Dock 1', enrolment: { codeHash: enrolmentCodeHash(CODE), expiresAt: '2099-01-01T00:00:00.000Z' } }],
        rollout: { format: 'sre-rollout/1', branchId: 'store-1', switches: [{ key: 'pos.queue_busting', branch: null, lanes: [{ laneId: 'lane-1', enabled: true, version: 1 }] }] },
      },
    });
    const edge: EdgeProcess = (await startEdge({
      EDGE_DEVICE_TLS_DIR: deviceTls.dir, EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: TEST_PACK_KEY, EDGE_CAPACITY_BYTES: '10485760',
      EDGE_LANE_PORT: '0', EDGE_SCREEN_PORT: '0', EDGE_DEVICE_PORT: '0', EDGE_APPS_DIR: 'apps', ...ready,
    }, () => {}))!;
    stops.push(() => edge.stop());
    const door = boxDoor(edge);
    const expected = { served: PACK_ZONE, zone: PACK_ZONE, today: SHOP_DAY, time: '00:30' };

    // ── the warehouse handheld, enrolled and signed in on the shop wifi door ──
    const context = await phone();
    const page = await context.newPage();
    await page.goto(`${door}/warehouse/`, { waitUntil: 'load' });
    await page.fill('#deviceId', 'hh-z1');
    await page.fill('#code', CODE);
    await page.click('button[type="submit"]');
    await signInOnPhonePage(page, 'warehouse', 'u-worker');
    await page.waitForFunction(() => (globalThis as unknown as ShopDayWindow).sreShopDay !== undefined, undefined, { timeout: 15_000 });
    expect(await shopDayOn(page)).toEqual(expected);
    expect(await page.evaluate(() => new Date().getDate())).not.toBe(Number(SHOP_DAY.slice(8))); // the phone's own day is not the shop's

    // ── the queue till on the same phone ──
    await page.goto(`${door}/queue-pos/`, { waitUntil: 'load' });
    await page.waitForURL(/\/queue-pos\/sign-in$/);
    await page.fill('input[name=staffId]', 'u-ravi');
    await page.fill('input[name=pin]', pinOf('u-ravi'));
    await page.click('button[type=submit]');
    await page.waitForURL(/\/queue-pos\/$/);
    await page.waitForFunction(() => (globalThis as unknown as ShopDayWindow).sreShopDay !== undefined, undefined, { timeout: 15_000 });
    expect(await shopDayOn(page)).toEqual(expected);

    // ── and the till page from the screens server (as before round 16) ──
    const till = await (await phone()).newPage();
    await till.goto(`http://127.0.0.1:${edge.screens!.port}/pos/`, { waitUntil: 'load' });
    await till.waitForFunction(() => (globalThis as unknown as ShopDayWindow).sreShopDay !== undefined, undefined, { timeout: 15_000 });
    expect(await shopDayOn(till)).toEqual(expected);
  }, 120_000);

  // ── OB-611: the door's batch question, on the warehouse shell served offline (no cloud, no store computer call) ──
  async function startShell(data: Record<string, unknown>): Promise<string> {
    const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
      void (async () => {
        const [path = '/'] = (req.url ?? '/').split('?');
        const file = path === '/' ? 'index.html' : path.replace(/^\//, '');
        try {
          let body = (await readFile(join('apps/warehouse-app/web', file))).toString('utf8');
          const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream';
          if (file.endsWith('.html')) body = body.replace('<!--SCREEN-DATA-->', `<script>window.warehouseData = ${JSON.stringify(data).replace(/</g, '\\u003c')};</script>`);
          res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
          res.end(body);
        } catch { res.writeHead(404); res.end('not found'); }
      })();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    stops.push(() => new Promise((done) => { server.close(() => done()); server.closeAllConnections(); }));
    return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  }
  interface DoorWindow { dsdSession?: unknown; warehouseOutbox?: { all(): { event: { type: string; payload: unknown } }[] } }

  it('OB-611: two batches of oil → the phone asks which (56 px, Tamil); the hand-back carries it; one batch of curd asks nothing', async () => {
    const base = await startShell({
      assignmentId: 'A-DSD', workerId: 'u-recv', storeId: 'S-A', bins: [], goodsIn: [],
      barcodes: [{ barcode: '890OIL', productId: 'p-oil', level: 'unit' }, { barcode: '890CURD', productId: 'p-curd', level: 'unit' }],
      packs: [{ productId: 'p-oil', baseUom: 'ea', levels: [{ level: 'unit', containsMinor: 1, barcode: '890OIL' }] }, { productId: 'p-curd', baseUom: 'ea', levels: [{ level: 'unit', containsMinor: 1, barcode: '890CURD' }] }],
      openDeliveries: [{ poId: 'po-oil', number: 'PO-0009', supplierId: 'sup-oil', grnId: 'grn-oil', ordered: [{ productId: 'p-oil', quantityMinor: 4, unitCost: { minor: 1000, currency: 'INR' } }, { productId: 'p-curd', quantityMinor: 2, unitCost: { minor: 3000, currency: 'INR' } }] }],
    });
    const context = await browser.newContext(HANDHELD);
    stops.push(() => context.close());
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}/`, { waitUntil: 'load' });
    await page.waitForFunction(() => (globalThis as unknown as DoorWindow).dsdSession != null, undefined, { timeout: 10_000 });
    const scanCode = async (code: string) => { await page.waitForSelector('#scan:not([hidden])'); await page.keyboard.type(code); await page.keyboard.press('Enter'); };
    const ok = async () => { await page.click('#banner-ok'); };
    await page.click('#lang'); // the whole door in Tamil (the sheet covers the language button once it is open)
    await page.click('#dsd-open');
    await page.click('#dsd-choices button[data-choice="po:po-oil"]');
    for (const d of '9876543210') await page.click(`#dsd-driver-keypad button:text-is("${d}")`);
    await page.click('#dsd-driver');
    await page.click('#dsd-start');
    await ok();
    // One curd with no batch first; then two batches of oil, the batch label scanned before each pair (it rides on every scan).
    await page.click('#dsd-scan'); await scanCode('890CURD'); await ok();
    for (const [batch, items] of [['OIL-1', ['890OIL', '890OIL']], ['OIL-2', ['890OIL', '890OIL']]] as const) {
      await page.click('#dsd-batch');
      await scanCode(batch);
      for (const item of items) { await page.click('#dsd-scan'); await scanCode(item); await ok(); }
    }

    // ── in Tamil: the hand-back of oil asks which batch ──
    await page.click('#dsd-hand-back');
    await page.click('#dsd-back-products button[data-product="p-oil"]');
    await page.waitForSelector('#dsd-back-batches:not([hidden]) button');
    await expect.poll(() => page.textContent('#dsd-back-hint')).toMatch(/^எந்தத் தொகுதி திருப்பிக் கொடுக்கப்படுகிறது\? — p-oil$/);
    const choices = page.locator('#dsd-back-batches button');
    expect(await choices.count()).toBe(2);
    for (let i = 0; i < 2; i += 1) expect(((await choices.nth(i).boundingBox())?.height ?? 0) >= 56).toBe(true);
    expect(await choices.allTextContents()).toEqual(['தொகுதி எண் OIL-1 — மீதம் 2', 'தொகுதி எண் OIL-2 — மீதம் 2']);
    expect(await auditPage(page, { minTarget: 56, expectLang: 'ta' }), 'the batch question').toEqual([]);
    await page.click('#dsd-back-batches button[data-batch="OIL-1"]');
    await page.waitForSelector('#qty:not([hidden])');
    await page.click('#qty-ok'); // 1, the default
    await page.click('#dsd-back-reasons button[data-reason="damaged"]');
    await expect.poll(() => page.textContent('#banner-title')).toBe('ஓட்டுநரிடம் திருப்பி கொடுக்கப்பட்டது');
    await ok();

    // ── curd came in one batch: no question, straight to how many ──
    await page.click('#dsd-hand-back');
    await page.click('#dsd-back-products button[data-product="p-curd"]');
    await page.waitForSelector('#qty:not([hidden])');
    expect(await page.isVisible('#dsd-back-batches')).toBe(false);
    await page.click('#qty-ok');
    await page.click('#dsd-back-reasons button[data-reason="other"]');
    await expect.poll(() => page.textContent('#banner-title')).toBe('ஓட்டுநரிடம் திருப்பி கொடுக்கப்பட்டது');
    await ok();

    await page.click('#dsd-note');
    await scanCode('NOTE-OIL-9');
    await page.click('#dsd-close');
    await expect.poll(() => page.textContent('#banner-title')).toBe('டெலிவரி முடிந்தது — குறிப்பு கையெழுத்திடப்பட்டது');
    const queued = await page.evaluate(() => (globalThis as unknown as DoorWindow).warehouseOutbox!.all().map((i) => ({ type: i.event.type, payload: i.event.payload as { handBacks: unknown[] } })));
    expect(queued).toHaveLength(1);
    expect(queued[0]!.payload.handBacks).toEqual([
      expect.objectContaining({ productId: 'p-oil', quantityMinor: 1, reason: 'damaged', batch: { batchId: 'OIL-1', expiry: null, manufacturedOn: null } }),
      expect.not.objectContaining({ batch: expect.anything() }),
    ]);
    expect(errors).toEqual([]);
  }, 120_000);
});
