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
 * **D-031 (pending list 27 Nov, item 3) on the warehouse handheld, in a real browser against a REAL store computer: the scans
 * wait on the phone until "Delivery complete — send the receipt".**
 *
 *   • a scan is received and HELD: the "Waiting to send — not in stock yet" list shows it, the store computer has nothing;
 *   • the page reloaded: the held scans are still there (the phone's own storage);
 *   • a wrong scan is removed before sending: gone from the list, "1 removed before sending — kept in the record in your name";
 *   • "send" with the store computer out of reach says so plainly; everything stays on the phone; the button says
 *     "Not sent yet — send again";
 *   • back in reach, "send again" hands ONE receipt to the store computer: the kept scan inside it, the removed one listed
 *     as removed (who, when). English and Tamil. Synthetic data only.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const SHOTS = process.env['SRE_SCREENSHOT_DIR'];
const KEY = ['d031', 'handheld', 'held', 'key'].join('-').padEnd(48, '0');
const TENANT = 't-sre';
const CODE = 'ABCDE-FGHJK-LMNPQ-RSTUV';
const HANDHELD = { viewport: { width: 360, height: 640 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true };
const PACK = JSON.stringify(withTillPeople({
  version: 1,
  policies: { tradingDayCutoff: '02:00', storeId: 'store-1', branchId: 'store-1', branchName: 'Main', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, privacySlaDays: 15, warehouseId: 'wh-1' },
  lossPreventionRules: [],
  warehouse: {
    assignmentId: 'A-1', workerId: 'u-worker', storeId: 'store-1', grnId: 'grn-1', poId: 'po-1',
    bins: [{ binId: 'BIN-A', storeId: 'store-1', capacityMinor: 1000, pickable: true, zone: 'ambient' }],
    ordered: [{ productId: 'p-rice', quantityMinor: 100, unitCostMinor: 4000, currency: 'INR' }],
    barcodes: [{ barcode: '890RICE', productId: 'p-rice', level: 'unit' }],
  },
  devices: [{ deviceId: 'hh-01', kind: 'handheld', status: 'registered', label: 'Dock 1', enrolment: { codeHash: enrolmentCodeHash(CODE), expiresAt: '2099-01-01T00:00:00.000Z' } }],
}, [{ userId: 'u-worker', permissions: ['inventory.movement.append'] }]));

interface Win {
  readonly warehouseSession?: unknown;
  readonly warehouseRelay?: unknown;
  readonly warehouseOutbox?: { unsentCount(): number };
}
type Logged = { type: string; payload: Record<string, unknown> };

describe.skipIf(!HAVE_BROWSER)('D-031 — the handheld holds its receiving scans until "Delivery complete — send the receipt"', () => {
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

  async function box(): Promise<EdgeProcess> {
    const dir = await mkdtemp(join(tmpdir(), 'sre-d031-hh-'));
    dirs.push(dir);
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, PACK, 'utf8');
    await issueTillPins(dir, KEY, ['u-worker']);
    const edge = (await startEdge({
      EDGE_DEVICE_TLS_DIR: deviceTls.dir,
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: TENANT, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
      EDGE_LANE_PORT: '0', EDGE_DEVICE_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_PACK_FILE: packFile,
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
  /** A picture of the whole screen (a tall phone, so the list is not under the footer), then back to the handheld's size. */
  const shot = async (page: Page, name: string) => {
    await page.setViewportSize({ width: 360, height: 1700 });
    await page.screenshot({ path: join(SHOTS!, name) });
    await page.setViewportSize(HANDHELD.viewport);
  };
  const ready = (page: Page) => page.waitForFunction(() => (globalThis as unknown as Win).warehouseSession !== undefined && (globalThis as unknown as Win).warehouseRelay !== undefined, undefined, { timeout: 15_000 });
  const scanIn = async (page: Page, code: string, qty: string) => {
    await page.click('#receive');
    await page.waitForSelector('#scan:not([hidden])', { timeout: 10_000 });
    await page.keyboard.type(code);
    await page.keyboard.press('Enter');
    await page.waitForSelector('#qty:not([hidden])');
    await page.click('#qty-keypad button:has-text("C")');
    for (const d of qty) await page.click(`#qty-keypad button:has-text("${d}")`);
    await page.click('#qty-ok');
    await page.waitForSelector('#banner:not([hidden])');
  };

  it('scan → held (nothing at the store computer) → reload keeps it → remove a wrong scan → send offline is refused in words → send again goes, ONE receipt; Tamil', async () => {
    const edge = await box();
    const context = await browser.newContext(HANDHELD);
    stops.push(() => context.close());
    const page = await context.newPage();
    await page.goto(`${boxDoor(edge)}/warehouse/`, { waitUntil: 'load' });
    await page.fill('#deviceId', 'hh-01');
    await page.fill('#code', CODE);
    await page.click('button[type="submit"]');
    await signInOnPhonePage(page, 'warehouse', 'u-worker');
    await ready(page);

    // Two scans: 12 good, then 5 that were scanned by mistake. Both held; the store computer has nothing.
    await scanIn(page, '890RICE', '12');
    expect(await page.textContent('#banner-title')).toBe('Received');
    await says(page, '#banner-text', 'kept on this phone until you send the receipt');
    await page.click('#banner-ok');
    await scanIn(page, '890RICE', '5');
    await page.click('#banner-ok');
    await says(page, '#held-heading', 'Waiting to send — not in stock yet');
    expect(await page.getAttribute('#held-heading', 'data-count')).toBe('2');
    expect(await page.locator('#held-scans .item.held').count()).toBe(2);
    await says(page, '#held-hint', 'Nothing reaches stock before that');
    expect(await page.isVisible('#done-receiving')).toBe(true);
    await page.waitForTimeout(500); // the page's own hand-over pass has had its chance
    expect(await logged(edge)).toEqual([]);
    expect(await page.evaluate(() => (globalThis as unknown as Win).warehouseOutbox!.unsentCount())).toBe(0);
    if (SHOTS !== undefined) await shot(page, 'd031-handheld-held-scans-en-360.png');

    // The browser reloaded (or closed and opened again): the same two scans are held.
    await page.reload({ waitUntil: 'load' });
    await ready(page);
    expect(await page.locator('#held-scans .item.held').count()).toBe(2);

    // The wrong scan (5) is removed before sending — gone from the list, the removal kept and said.
    const wrong = page.locator('#held-scans .item.held', { hasText: '5' }).last();
    await wrong.locator('button.remove').click();
    await page.waitForSelector('#banner:not([hidden])');
    expect(await page.textContent('#banner-title')).toBe('Scan removed — it will not be sent');
    await page.click('#banner-ok');
    expect(await page.locator('#held-scans .item.held').count()).toBe(1);
    await says(page, '#held-removed', '1 removed before sending — kept in the record in your name');

    // "Send" with the store computer out of reach: said plainly, nothing handed over, everything kept on the phone.
    await page.route('**/lane/outbox', (route) => route.abort('internetdisconnected'));
    await page.click('#done-receiving');
    await page.waitForSelector('#banner:not([hidden])');
    expect(await page.textContent('#banner-title')).toBe('Receipt not sent yet — the store computer cannot be reached');
    await says(page, '#banner-text', 'Everything is kept on this phone');
    await page.click('#banner-ok');
    await says(page, '#done-receiving', 'Not sent yet — send again');
    expect(await logged(edge)).toEqual([]);
    expect(await page.evaluate(() => (globalThis as unknown as Win).warehouseOutbox!.unsentCount())).toBe(1);
    if (SHOTS !== undefined) await shot(page, 'd031-handheld-send-offline-en-360.png');

    // Back in reach: "send again" hands over ONE receipt — the kept scan inside it, the removed one listed as removed.
    await page.unroute('**/lane/outbox');
    await page.click('#done-receiving');
    await page.waitForSelector('#banner:not([hidden])');
    expect(await page.textContent('#banner-title')).toBe('Receipt sent — head office will match the delivery to the order');
    await page.click('#banner-ok');
    const records = await logged(edge);
    expect(records.map((r) => r.type)).toEqual(['ReceivingCompleted']);
    expect(records[0]!.payload).toMatchObject({ grnId: 'grn-1', poId: 'po-1', completedBy: 'u-worker', scanCount: 1 });
    expect(records[0]!.payload['scans']).toEqual([expect.objectContaining({ productId: 'p-rice', quantityMinor: 12, receivedBy: 'u-worker' })]);
    expect(records[0]!.payload['removed']).toEqual([expect.objectContaining({ productId: 'p-rice', quantityMinor: 5, removedBy: 'u-worker' })]);
    expect(await page.evaluate(() => (globalThis as unknown as Win).warehouseOutbox!.unsentCount())).toBe(0);
    await page.waitForFunction(() => (globalThis as unknown as { document: { querySelector(s: string): { hidden: boolean } | null } }).document.querySelector('#done-receiving')?.hidden === true, undefined, { timeout: 10_000 });
    expect(await page.locator('#held-scans .item.held').count()).toBe(0);
    // The goods are now on the put-away list.
    await says(page, '#goods-in', 'p-rice');
    // A late scan of the sent delivery is refused — nothing received twice.
    await page.click('#receive');
    await page.waitForSelector('#scan:not([hidden])', { timeout: 10_000 });
    await page.keyboard.type('890RICE');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#qty:not([hidden])');
    await page.click('#qty-ok');
    await page.waitForSelector('#banner:not([hidden])');
    expect(await page.textContent('#banner-title')).toBe('This delivery was already sent — nothing was received');
    await page.click('#banner-ok');
    expect((await logged(edge)).length).toBe(1);
  }, 90_000);

  it('Tamil: the held list, its words and "Remove" in Tamil', async () => {
    const edge = await box();
    const context = await browser.newContext(HANDHELD);
    stops.push(() => context.close());
    const page = await context.newPage();
    await page.goto(`${boxDoor(edge)}/warehouse/`, { waitUntil: 'load' });
    await page.fill('#deviceId', 'hh-01');
    await page.fill('#code', CODE);
    await page.click('button[type="submit"]');
    await signInOnPhonePage(page, 'warehouse', 'u-worker');
    await ready(page);
    await scanIn(page, '890RICE', '3');
    await page.click('#banner-ok');
    await page.click('#lang');
    await says(page, '#held-heading', 'அனுப்பக் காத்திருக்கிறது — இன்னும் இருப்பில் இல்லை');
    await says(page, '#held-scans', 'நீக்கு');
    await says(page, '#done-receiving', 'வரவு முடிந்தது — ரசீதை அனுப்பு');
    if (SHOTS !== undefined) await shot(page, 'd031-handheld-held-scans-ta-360.png');
    expect(await logged(edge)).toEqual([]);
  }, 90_000);
});
