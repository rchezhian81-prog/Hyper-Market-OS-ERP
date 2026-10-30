import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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

let deviceTls: Awaited<ReturnType<typeof sharedDeviceTls>>;

/**
 * **B4 · OB-504 (owner, 28 Oct 2026) in a real browser, against a REAL store computer with NO cloud.** The box holds head
 * office's store pack with its list of PACKED products. The manager's Receive form asks for the month and year of
 * manufacture (English and Tamil) and refuses a packed line without it — nothing saved; with it the receipt on the box
 * carries the date. The warehouse handheld refuses a packed scan without the month, offline, and with the month keyed on
 * its number pad the scan travels with it. Skips where no browser binary is present. Synthetic data only.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['r7b', 'mfg', 'date', 'key'].join('-').padEnd(48, '0');
const TENANT = 't-sre';
const CODE = 'ABCDE-FGHJK-LMNPQ-RSTUV';
const HANDHELD = { viewport: { width: 360, height: 640 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const PACK = (extra: Record<string, unknown>) => JSON.stringify(withTillPeople({
  version: 1,
  policies: { tradingDayCutoff: '02:00', storeId: 'store-1', branchId: 'store-1', branchName: 'Main', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, privacySlaDays: 15, warehouseId: 'wh-1' },
  managerPolicy: { userId: 'u-mgr', approvalLimitMinor: 500_000 },
  lossPreventionRules: [],
  packedProductIds: ['p-det'],
  ...extra,
}, [{ userId: 'u-worker', permissions: ['inventory.movement.append'] }, { userId: 'u-mgr', permissions: ['till.dayclose.read'] }])); // SEC-1: the manager holds the Today screen's word

interface Win {
  readonly managerSession?: { savedWork(): { kind: string; state: string }[] };
  readonly warehouseSession?: { sentWork(): { kind: string; state: string }[] };
  readonly laneWriteBase?: string;
  readonly warehouseRelay?: unknown;
  readonly document: { querySelector(s: string): { hidden: boolean } | null };
}
type Logged = { type: string; payload: Record<string, unknown> };

describe.skipIf(!HAVE_BROWSER)('OB-504: the receiving screens ask for the month of manufacture of a packed product, offline', () => {
  let browser: Browser;
  const dirs: string[] = [];
  const stops: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    execFileSync('node', ['scripts/build-app.mjs', 'warehouse-app'], { stdio: 'ignore' });
    deviceTls = await sharedDeviceTls();
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM, args: trustingBrowserArgs(deviceTls.keyPin) });
  }, 240_000);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => {
    for (const stop of stops.splice(0).reverse()) await stop();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  async function box(extra: Record<string, unknown> = {}): Promise<EdgeProcess> {
    const dir = await mkdtemp(join(tmpdir(), 'sre-r7b-e2e-'));
    dirs.push(dir);
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, PACK(extra), 'utf8');
    await issueTillPins(dir, KEY, ['u-worker']);
    const edge = (await startEdge({
      EDGE_DEVICE_TLS_DIR: deviceTls.dir,
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: TENANT, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
      EDGE_LANE_PORT: '0', EDGE_SCREEN_PORT: '0', EDGE_DEVICE_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_PACK_FILE: packFile,
      EDGE_LANE_ID: 'lane-1', EDGE_LANE_TRUST_FORWARDED_USER: '1', EDGE_SCREEN_TRUST_FORWARDED_USER: '1',
    }, () => {}))!;
    stops.push(() => edge.stop());
    return edge;
  }
  const logged = async (edge: EdgeProcess): Promise<Logged[]> =>
    (await readLog(edge.deviceEventsLog.path)).filter((r) => r.ok).map((r) => JSON.parse(r.ok ? r.record : '{}') as Logged);
  const bannerUp = (page: Page) => page.waitForFunction(() => !((globalThis as unknown as Win).document.querySelector('#banner') as { hidden: boolean }).hidden);
  const says = (page: Page, selector: string, text: string) => page.waitForFunction(([sel, want]) => {
    const node = (globalThis as unknown as { document: { querySelector(s: string): { textContent: string | null } | null } }).document.querySelector(sel!);
    return (node?.textContent ?? '').includes(want!);
  }, [selector, text], { timeout: 15_000 });

  it('the manager\'s Receive form: refused without the month (in words, nothing saved); with it, the receipt on the box carries it; Tamil words', async () => {
    const edge = await box();
    const context = await browser.newContext();
    stops.push(() => context.close());
    const page = await context.newPage();
    await page.route(`http://127.0.0.1:${edge.screens!.port}/**`, (route) => route.continue({ headers: { ...route.request().headers(), 'x-sre-user': 'u-mgr' } }));
    await page.route(`http://127.0.0.1:${edge.lane!.port}/lane/**`, (route) => route.continue({ headers: { ...route.request().headers(), 'x-sre-user': 'u-mgr' } }));
    await page.goto(`http://127.0.0.1:${edge.screens!.port}/manager`, { waitUntil: 'load' });
    await page.waitForFunction(() => (globalThis as unknown as Win).managerSession !== undefined && typeof (globalThis as unknown as Win).laneWriteBase === 'string', undefined, { timeout: 15_000 });
    await page.click('#tab-receive');
    await says(page, '#grn-mfg-label', 'Month and year of manufacture (packed goods)');

    await page.fill('#grn-number', 'DN-PACKED');
    await page.fill('#grn-product', 'p-det');
    await page.fill('#grn-qty', '6');
    await page.click('#add-line');
    await bannerUp(page);
    await says(page, '#banner-text', 'This is a packed product: type the month and year of manufacture');
    await page.click('#banner-ok');
    expect(await page.isHidden('#receive-empty')).toBe(false); // nothing was added
    // A month it cannot read is refused too.
    await page.fill('#grn-mfg', '09/2026');
    await page.click('#add-line');
    await bannerUp(page);
    await says(page, '#banner-text', 'year-month, for example 2026-09');
    await page.click('#banner-ok');

    await page.fill('#grn-mfg', '2026-09');
    await page.click('#add-line');
    await says(page, '#receive-lines', 'made 2026-09');
    await page.click('#save-receipt');
    await bannerUp(page);
    await says(page, '#banner-title', 'Delivery saved');
    await page.click('#banner-ok');
    await page.waitForFunction(() => (globalThis as unknown as Win).managerSession!.savedWork().find((w) => w.kind === 'receipt')?.state === 'handed_to_box', undefined, { timeout: 10_000 });
    const [receipt] = await logged(edge);
    expect(receipt?.payload).toMatchObject({ number: 'DN-PACKED', lines: [{ productId: 'p-det', quantityMinor: 6, manufacturedOn: '2026-09' }] });

    await page.click('#lang');
    await says(page, '#grn-mfg-label', 'தயாரிப்பு மாதமும் ஆண்டும் (பொதி செய்த பொருட்கள்)');
  });

  it('the handheld: a packed scan with no month is refused offline; keyed as YYYYMM, the next scan carries it', async () => {
    const edge = await box({
      warehouse: {
        assignmentId: 'A-1', workerId: 'u-worker', storeId: 'store-1', grnId: 'grn-det', poId: 'po-1',
        bins: [{ binId: 'BIN-A', storeId: 'store-1', capacityMinor: 1000, pickable: true, zone: 'ambient' }],
        ordered: [{ productId: 'p-det', quantityMinor: 20, unitCostMinor: 6_000, currency: 'INR' }],
        barcodes: [{ barcode: '890DET', productId: 'p-det', level: 'unit' }],
      },
      devices: [{ deviceId: 'hh-01', kind: 'handheld', status: 'registered', label: 'Dock 1', enrolment: { codeHash: enrolmentCodeHash(CODE), expiresAt: '2099-01-01T00:00:00.000Z' } }],
    });
    const context = await browser.newContext(HANDHELD);
    stops.push(() => context.close());
    const page = await context.newPage();
    await page.goto(`${boxDoor(edge)}/warehouse/`, { waitUntil: 'load' });
    await page.fill('#deviceId', 'hh-01');
    await page.fill('#code', CODE);
    await page.click('button[type="submit"]');
    await signInOnPhonePage(page, 'warehouse', 'u-worker');
    await page.waitForFunction(() => (globalThis as unknown as Win).warehouseSession !== undefined && (globalThis as unknown as Win).warehouseRelay !== undefined, undefined, { timeout: 15_000 });
    await says(page, '#recv-mfg', 'Month of manufacture (packed goods): not entered');

    // No month: refused on the phone, nothing queued.
    await page.click('#receive');
    await page.waitForSelector('#scan:not([hidden])');
    await page.keyboard.type('890DET');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#banner:not([hidden])');
    await says(page, '#banner-title', 'Packed goods — enter the month of manufacture first');
    await page.click('#banner-ok');
    expect((await logged(edge)).map((e) => e.type)).not.toContain('ReceivingScanned');

    // Key the month on the number pad (YYYYMM), then scan again.
    await page.click('#recv-mfg');
    await page.waitForSelector('#qty:not([hidden])');
    for (const d of '202609') await page.click(`#qty-keypad button:text-is("${d}")`);
    await page.click('#qty-ok');
    await says(page, '#recv-mfg', '2026-09');
    await page.click('#receive');
    await page.waitForSelector('#scan:not([hidden])');
    await page.keyboard.type('890DET');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#banner:not([hidden])');
    await says(page, '#banner-title', 'Received');
    await page.click('#banner-ok');
    const scans = async () => (await logged(edge)).filter((e) => e.type === 'ReceivingScanned');
    for (let i = 0; i < 50 && (await scans()).length === 0; i += 1) await page.waitForTimeout(100);
    expect((await scans())[0]?.payload).toMatchObject({ productId: 'p-det', manufacturedOn: '2026-09' });

    await page.click('#lang');
    await says(page, '#recv-mfg', 'தயாரிப்பு மாதம்');
  });
});
