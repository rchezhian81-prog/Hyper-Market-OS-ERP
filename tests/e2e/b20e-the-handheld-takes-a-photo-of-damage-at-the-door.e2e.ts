import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';
import { enrolmentCodeHash } from '../../packages/platform-admin/src/device-enrolment';
import { withTillPeople, issueTillPins } from '../support/till-operator';
import { signInOnPhonePage } from '../support/phone-sign-in-page';
import { deviceBase as boxDoor, sharedDeviceTls, trustingBrowserArgs } from '../support/box-tls';
import { tinyPng } from '../support/tiny-png';

let deviceTls: Awaited<ReturnType<typeof sharedDeviceTls>>;

/**
 * **Batch 20e · R6 (M07-FR-04 · WF-04) on the warehouse handheld, in a real browser against a REAL store computer with NO head
 * office:** after receiving the oil, the worker taps "Take a photo of the delivery note, challan or damage", taps "Damage photo
 * — Groundnut oil" and the phone's camera opens (the file input's `capture`); the photo (a large picture) is made smaller on the
 * phone and kept on its own queue in the worker's name, then handed to the store computer, which holds it for head office —
 * the scans never waited for it. Each photo says where it has got to. English and Tamil. Synthetic data only.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const SHOTS = process.env['SRE_SCREENSHOT_DIR'];
const KEY = ['b20e', 'handheld', 'photo', 'key'].join('-').padEnd(48, '0');
const CODE = 'ABCDE-FGHJK-LMNPQ-RSTUV';
const HANDHELD = { viewport: { width: 360, height: 640 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true };
const PACK = JSON.stringify(withTillPeople({
  version: 1,
  policies: { tradingDayCutoff: '02:00', storeId: 'store-1', branchId: 'store-1', branchName: 'Main', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, privacySlaDays: 15, warehouseId: 'wh-1' },
  managerPolicy: { userId: 'u-mgr', approvalLimitMinor: 500_000 },
  lossPreventionRules: [],
  warehouse: {
    assignmentId: 'A-1', workerId: 'u-worker', storeId: 'store-1', grnId: 'grn-oil', poId: 'po-1',
    bins: [{ binId: 'BIN-A', storeId: 'store-1', capacityMinor: 1000, pickable: true, zone: 'ambient' }],
    ordered: [{ productId: 'p-oil', quantityMinor: 20, unitCostMinor: 15_000, currency: 'INR' }],
    barcodes: [{ barcode: '890OIL', productId: 'p-oil', level: 'unit' }],
    productNames: { 'p-oil': 'Groundnut oil 1 L' },
  },
  devices: [{ deviceId: 'hh-01', kind: 'handheld', status: 'registered', label: 'Dock 1', enrolment: { codeHash: enrolmentCodeHash(CODE), expiresAt: '2099-01-01T00:00:00.000Z' } }],
}, [{ userId: 'u-worker', permissions: ['inventory.movement.append'] }, { userId: 'u-mgr', permissions: ['till.dayclose.read'] }]));

interface Win { readonly warehouseSession?: unknown; readonly warehouseRelay?: unknown; readonly receiptAttachments?: unknown }
type Logged = { type: string; payload: Record<string, unknown> };

describe.skipIf(!HAVE_BROWSER)('batch 20e — the warehouse handheld takes a photo at the door and keeps it with the delivery', () => {
  let browser: Browser;
  const dirs: string[] = [];
  const stops: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'warehouse-app'], { stdio: 'ignore' });
    deviceTls = await sharedDeviceTls();
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM, args: trustingBrowserArgs(deviceTls.keyPin) });
    if (SHOTS !== undefined) await mkdir(SHOTS, { recursive: true });
  }, 240_000);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => {
    for (const stop of stops.splice(0).reverse()) await stop();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });
  const says = (page: Page, selector: string, text: string) => page.waitForFunction(([sel, want]) => {
    const node = (globalThis as unknown as { document: { querySelector(s: string): { textContent: string | null } | null } }).document.querySelector(sel!);
    return (node?.textContent ?? '').includes(want!);
  }, [selector, text], { timeout: 15_000 });

  it('receive, then a damage photo of that item: made smaller, kept in the worker\'s name, with the store computer; Tamil', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-b20e-hh-'));
    dirs.push(dir);
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, PACK, 'utf8');
    await issueTillPins(dir, KEY, ['u-worker']);
    const edge: EdgeProcess = (await startEdge({
      EDGE_DEVICE_TLS_DIR: deviceTls.dir,
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
      EDGE_LANE_PORT: '0', EDGE_SCREEN_PORT: '0', EDGE_DEVICE_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_PACK_FILE: packFile,
      EDGE_LANE_ID: 'lane-1', EDGE_LANE_TRUST_FORWARDED_USER: '1', EDGE_SCREEN_TRUST_FORWARDED_USER: '1',
    }, () => {}))!;
    stops.push(() => edge.stop());
    const context = await browser.newContext(HANDHELD);
    stops.push(() => context.close());
    const page = await context.newPage();
    await page.goto(`${boxDoor(edge)}/warehouse/`, { waitUntil: 'load' });
    await page.fill('#deviceId', 'hh-01');
    await page.fill('#code', CODE);
    await page.click('button[type="submit"]');
    await signInOnPhonePage(page, 'warehouse', 'u-worker');
    await page.waitForFunction(() => (globalThis as unknown as Win).warehouseSession !== undefined && (globalThis as unknown as Win).receiptAttachments !== undefined, undefined, { timeout: 15_000 });
    await says(page, '#recv-photo', 'Take a photo of the delivery note, challan or damage');
    // The camera input asks for the phone's back camera.
    expect(await page.getAttribute('#recv-photo-file', 'capture')).toBe('environment');

    // Receive 6 bottles of oil.
    await page.click('#receive');
    await page.waitForSelector('#scan:not([hidden])');
    await page.keyboard.type('890OIL');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#qty:not([hidden])');
    await page.click('#qty-keypad button:text-is("C")');
    await page.click('#qty-keypad button:text-is("6")');
    await page.click('#qty-ok');
    await page.waitForSelector('#banner:not([hidden])');
    await page.click('#banner-ok');

    // The photo: what it is (the damage photo names the item just received), then the camera.
    await page.click('#recv-photo');
    await page.waitForSelector('#photo-kind:not([hidden])');
    await says(page, '#photo-kinds', 'Damage photo —');
    if (SHOTS !== undefined) await page.screenshot({ path: join(SHOTS, 'b20e-handheld-photo-kind-en-360.png') });
    const chooser = page.waitForEvent('filechooser');
    await page.click('#photo-kinds button[data-kind="damage_photo"]');
    await (await chooser).setFiles({ name: 'IMG_2041.png', mimeType: 'image/png', buffer: tinyPng(2400, 1800) });
    await page.waitForSelector('#banner:not([hidden])');
    await says(page, '#banner-title', 'Photo kept with the delivery');
    await page.click('#banner-ok');

    const logged = async (): Promise<Logged[]> => (await readLog(edge.deviceEventsLog.path)).filter((r) => r.ok).map((r) => JSON.parse(r.ok ? r.record : '{}') as Logged);
    const photos = async () => (await logged()).filter((e) => e.type === 'GoodsReceiptAttachmentCaptured').map((e) => e.payload);
    for (let i = 0; i < 80 && (await photos()).length < 1; i += 1) await page.waitForTimeout(100);
    const [photo] = await photos();
    expect(photo).toMatchObject({ grnId: 'grn-oil', kind: 'damage_photo', productId: 'p-oil', attachedBy: 'u-worker', mediaType: 'image/jpeg', source: 'warehouse-handheld', fileName: 'IMG_2041.jpg' });
    expect(Number(photo!['bytes'])).toBeLessThanOrEqual(153_600); // a 2400×1800 picture, made small on the phone
    expect((await logged()).some((e) => e.type === 'ReceivingScanned')).toBe(true); // the scan went on its own
    await page.waitForFunction(() => {
      const d = (globalThis as unknown as { document: { querySelector(q: string): { dataset: { state?: string } } | null } }).document;
      return d.querySelector('#photos-sent .photo')?.dataset.state === 'handed_to_box';
    }, undefined, { timeout: 15_000 });
    await says(page, '#photos-sent', 'Damage photo · for '); // the item by the name the phone holds for it
    await page.locator('#photos-heading').scrollIntoViewIfNeeded();
    if (SHOTS !== undefined) await page.screenshot({ path: join(SHOTS, 'b20e-handheld-photo-sent-en-360.png'), fullPage: true });

    await page.click('#lang');
    await says(page, '#recv-photo', 'புகைப்படம் எடு');
    await says(page, '#photos-sent', 'சேதப் புகைப்படம்');
    await page.locator('#photos-heading').scrollIntoViewIfNeeded();
    if (SHOTS !== undefined) await page.screenshot({ path: join(SHOTS, 'b20e-handheld-photo-ta-360.png'), fullPage: true });
  }, 120_000);
});
