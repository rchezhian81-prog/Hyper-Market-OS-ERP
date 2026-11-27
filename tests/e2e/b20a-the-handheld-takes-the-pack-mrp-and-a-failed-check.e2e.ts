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

let deviceTls: Awaited<ReturnType<typeof sharedDeviceTls>>;

/**
 * **Batch 20a (M07-FR-02/03) on the warehouse handheld, in a real browser against a REAL store computer with NO head office —
 * the "MRP on the pack" box and the "Failed quality check / refused at the door" count Receive (office) got in batch 18a.**
 * The MRP is keyed on the handheld's own keypad (no text box) and goes with the NEXT scan only; one that is not an amount is
 * refused in words, nothing set. Failed goods are scanned with their own button: received against the same order but held
 * out of stock (quarantine) for a second person — the scan says so. Both reach the store computer's queue for head office.
 * English and Tamil. Synthetic data only.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const SHOTS = process.env['SRE_SCREENSHOT_DIR'];
const KEY = ['b20a', 'handheld', 'mrp', 'key'].join('-').padEnd(48, '0');
const TENANT = 't-sre';
const CODE = 'ABCDE-FGHJK-LMNPQ-RSTUV';
const HANDHELD = { viewport: { width: 360, height: 640 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true };
const PACK = (extra: Record<string, unknown>) => JSON.stringify(withTillPeople({
  version: 1,
  policies: { tradingDayCutoff: '02:00', storeId: 'store-1', branchId: 'store-1', branchName: 'Main', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, privacySlaDays: 15, warehouseId: 'wh-1' },
  managerPolicy: { userId: 'u-mgr', approvalLimitMinor: 500_000 },
  lossPreventionRules: [],
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

describe.skipIf(!HAVE_BROWSER)('batch 20a — the handheld\'s receive takes the pack MRP and a failed quality check, offline', () => {
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

  async function box(extra: Record<string, unknown> = {}): Promise<EdgeProcess> {
    const dir = await mkdtemp(join(tmpdir(), 'sre-b20a-hh-'));
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
  const says = (page: Page, selector: string, text: string) => page.waitForFunction(([sel, want]) => {
    const node = (globalThis as unknown as { document: { querySelector(s: string): { textContent: string | null } | null } }).document.querySelector(sel!);
    return (node?.textContent ?? '').includes(want!);
  }, [selector, text], { timeout: 15_000 });

  it('the pack MRP rides on the next scan only; a failed / refused carton is received but held out; both queued; Tamil', async () => {
    const edge = await box({
      warehouse: {
        assignmentId: 'A-1', workerId: 'u-worker', storeId: 'store-1', grnId: 'grn-oil', poId: 'po-1',
        bins: [{ binId: 'BIN-A', storeId: 'store-1', capacityMinor: 1000, pickable: true, zone: 'ambient' }],
        ordered: [{ productId: 'p-oil', quantityMinor: 20, unitCostMinor: 15_000, currency: 'INR' }],
        barcodes: [{ barcode: '890OIL', productId: 'p-oil', level: 'unit' }],
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
    await says(page, '#recv-mrp', 'MRP on the pack (next item): not entered');
    await says(page, '#receive-failed', 'Failed quality check / refused at the door');
    const key = async (digits: string) => { for (const d of digits) await page.click(`#temp-keypad button:text-is("${d}")`); };

    // An MRP that is not an amount (a lone point) is refused in words; nothing set.
    await page.click('#recv-mrp');
    await page.waitForSelector('#temp:not([hidden])');
    await says(page, '#temp-title', 'MRP printed on the pack');
    await key('.');
    await page.click('#temp-ok');
    await page.waitForSelector('#banner:not([hidden])');
    await says(page, '#banner-title', 'The MRP must be an amount in rupees');
    await page.click('#banner-ok');
    await says(page, '#recv-mrp', 'not entered');

    // ₹220.50 keyed, then 9 good bottles scanned: the scan carries it, and the box is empty again for the next item.
    await page.click('#recv-mrp');
    await page.waitForSelector('#temp:not([hidden])');
    await key('220.50');
    await page.click('#temp-ok');
    await says(page, '#recv-mrp', '₹220.50');
    await page.locator('#recv-mrp').scrollIntoViewIfNeeded();
    if (SHOTS !== undefined) await page.screenshot({ path: join(SHOTS, 'b20a-handheld-receive-mrp-en-360.png') });
    await page.click('#receive');
    await page.waitForSelector('#scan:not([hidden])');
    await page.keyboard.type('890OIL');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#qty:not([hidden])');
    await page.click('#qty-keypad button:text-is("C")');
    await page.click('#qty-keypad button:text-is("9")');
    await page.click('#qty-ok');
    await page.waitForSelector('#banner:not([hidden])');
    await says(page, '#banner-title', 'Received');
    await page.click('#banner-ok');
    await says(page, '#recv-mrp', 'not entered');

    // 3 bottles that failed the check at the door: their own button; received, held back.
    await page.click('#receive-failed');
    await page.waitForSelector('#scan:not([hidden])');
    await says(page, '#scan-title', 'Scan an item that failed the check or was refused');
    await page.keyboard.type('890OIL');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#qty:not([hidden])');
    await says(page, '#qty-title', 'How many failed the check or were refused?');
    await page.click('#qty-keypad button:text-is("C")');
    await page.click('#qty-keypad button:text-is("3")');
    await page.click('#qty-ok');
    await page.waitForSelector('#banner:not([hidden])');
    await says(page, '#banner-text', 'Received and held back — failed the check');
    if (SHOTS !== undefined) await page.screenshot({ path: join(SHOTS, 'b20a-handheld-failed-check-en-360.png') });
    await page.click('#banner-ok');

    // D-031: both scans wait on the phone ("Waiting to send", the failed one marked) and go inside the receipt when it is sent.
    await says(page, '#held-scans', 'failed the check — held back');
    await says(page, '#held-scans', 'MRP ₹220.50');
    expect(await logged(edge)).toEqual([]);
    await page.click('#done-receiving');
    await page.waitForSelector('#banner:not([hidden])');
    await page.click('#banner-ok');
    const receipts = async () => (await logged(edge)).filter((e) => e.type === 'ReceivingCompleted');
    for (let i = 0; i < 50 && (await receipts()).length < 1; i += 1) await page.waitForTimeout(100);
    const sent = ((await receipts())[0]!.payload['scans'] as Record<string, unknown>[]);
    expect(sent[0]).toMatchObject({ productId: 'p-oil', quantityMinor: 9, state: 'on_hand', mrpMinor: 22_050 });
    expect(sent[1]).toMatchObject({ productId: 'p-oil', quantityMinor: 3, state: 'quarantine', qcFailed: true });
    expect(sent[1]).not.toHaveProperty('mrpMinor');

    await page.click('#lang');
    await says(page, '#recv-mrp', 'பொதியில் உள்ள MRP (அடுத்த பொருள்)');
    await says(page, '#receive-failed', 'தரச் சோதனையில் தோல்வி / வாசலில் மறுக்கப்பட்டது');
    await page.locator('#recv-mrp').scrollIntoViewIfNeeded();
    if (SHOTS !== undefined) await page.screenshot({ path: join(SHOTS, 'b20a-handheld-receive-ta-360.png') });
  });
});
