import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';
import { withTillPeople } from '../support/till-operator';
import { sharedDeviceTls, trustingBrowserArgs } from '../support/box-tls';
import { ROLE_CATALOGUE } from '../../services/api/src/roles';

const OWNER_PERMISSIONS = [...(ROLE_CATALOGUE.find((r) => r.id === 'owner') as unknown as { permissions: readonly string[] }).permissions];

let deviceTls: Awaited<ReturnType<typeof sharedDeviceTls>>;

/**
 * **Batch 20a · R7 (M07-FR-01 · M03-FR-02) in a real browser on a real store computer with NO head office:** on Receive
 * (office), an item head office gave case sizes is counted as "cases × pack size" plus loose units — 4 cases of 12 and 3 loose
 * is 51 units, shown as a sum before saving — and the receipt still records UNITS (nothing about cases travels). Typing
 * Arrived in units clears the cases; an item with no case sizes takes single units only, as before. English and Tamil.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const SHOTS = process.env['SRE_SCREENSHOT_DIR'];
const KEY = ['b20a', 'receive', 'cases', 'key'].join('-').padEnd(48, '0');
const TENANT = 't-sre';
const product = (productId: string, name: string, nameTa: string) => ({
  productId, name, nameTa, categoryId: 'grocery', unitPriceMinor: 6_000, unitCostMinor: 5_000, uom: 'ea', barcodes: [], availableMinor: 0, taxBps: 500,
});
const PACK = JSON.stringify(withTillPeople({
  version: 1,
  policies: { tradingDayCutoff: '02:00', storeId: 'store-1', branchId: 'store-1', branchName: 'Main', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, privacySlaDays: 15, warehouseId: 'wh-1' },
  managerPolicy: { userId: 'u-mgr', approvalLimitMinor: 500_000 },
  lossPreventionRules: [],
  products: [product('p-rice', 'Ponni rice 5 kg', 'பொன்னி அரிசி 5 கிலோ'), product('p-oil', 'Groundnut oil 1 L', 'கடலை எண்ணெய் 1 லி')],
  // Batch 20a · R7: head office's case sizes for counted products (the store-pack section casePacks).
  casePacks: { 'p-oil': [{ level: 'case', units: 12 }, { level: 'inner', units: 6 }] },
  warehouse: {
    assignmentId: 'A-1', workerId: 'u-mgr', storeId: 'store-1',
    bins: [{ binId: 'BIN-A', storeId: 'store-1', capacityMinor: 1000, pickable: true, zone: 'ambient' }],
    openDeliveries: [
      {
        poId: 'po-7', number: 'PO-0007', supplierId: 'sup-demo-foods', deliverToLocationId: 'wh-1', grnId: 'grn-po-7',
        ordered: [{ productId: 'p-rice', quantityMinor: 12, unitCostMinor: 50_000, currency: 'INR' }, { productId: 'p-oil', quantityMinor: 51, unitCostMinor: 18_000, currency: 'INR' }],
      },
    ],
  },
}, [{ userId: 'u-mgr', permissions: OWNER_PERMISSIONS }]));

interface Win { readonly managerSession?: { savedWork(): { kind: string; state: string }[] }; readonly laneWriteBase?: string }
type Logged = { type: string; payload: Record<string, unknown> };

describe.skipIf(!HAVE_BROWSER)('batch 20a — Receive (office) takes cases × pack size', () => {
  let browser: Browser;
  const dirs: string[] = [];
  const stops: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    deviceTls = await sharedDeviceTls();
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM, args: trustingBrowserArgs(deviceTls.keyPin) });
    if (SHOTS !== undefined) await mkdir(SHOTS, { recursive: true });
  }, 240_000);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => {
    for (const stop of stops.splice(0).reverse()) await stop();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });
  const shot = async (page: Page, name: string): Promise<void> => { if (SHOTS !== undefined) await page.screenshot({ path: join(SHOTS, name) }); };

  async function box(): Promise<EdgeProcess> {
    const dir = await mkdtemp(join(tmpdir(), 'sre-b20a-cases-'));
    dirs.push(dir);
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, PACK, 'utf8');
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
  const fillLine = async (page: Page, productId: string, cls: string, value: string) => {
    const input = page.locator(`#receive-lines .line-row[data-product-id="${productId}"] input.${cls}`);
    await input.fill(value);
    await input.dispatchEvent('change');
  };
  async function managerPage(edge: EdgeProcess, path = '/manager', width = 1366): Promise<Page> {
    const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1, serviceWorkers: 'block' });
    stops.push(() => context.close());
    const page = await context.newPage();
    await page.route(`http://127.0.0.1:${edge.screens!.port}/**`, (route) => route.continue({ headers: { ...route.request().headers(), 'x-sre-user': 'u-mgr' } }));
    await page.route(`http://127.0.0.1:${edge.lane!.port}/lane/**`, (route) => route.continue({ headers: { ...route.request().headers(), 'x-sre-user': 'u-mgr' } }));
    await page.goto(`http://127.0.0.1:${edge.screens!.port}${path}`, { waitUntil: 'load' });
    return page;
  }

  it('4 cases of 12 + 3 loose = 51 units on the line; the receipt records units; a choice of pack size; single units still allowed', async () => {
    const edge = await box();
    const page = await managerPage(edge);
    await page.waitForFunction('globalThis.managerSession !== undefined && typeof globalThis.laneWriteBase === "string"', undefined, { timeout: 15_000 });
    await page.click('#tab-receive');
    await page.fill('#grn-number', 'DN-701');
    await page.selectOption('#grn-order', 'po:po-7');
    await says(page, '#receive-lines', 'Groundnut oil 1 L');
    // Rice has no case sizes: no cases box, single units as before. Oil has: a pack-size choice, cases and loose units.
    expect(await page.locator('#receive-lines .line-row[data-product-id="p-rice"] input.cases').count()).toBe(0);
    expect(await page.locator('#receive-lines .line-row[data-product-id="p-oil"] select.case-size option').allTextContents()).toEqual(['case of 12', 'inner of 6']);
    await says(page, '#receive-lines', 'Cases of 12');
    await fillLine(page, 'p-oil', 'cases', '4');
    await fillLine(page, 'p-oil', 'loose', '3');
    await says(page, '#receive-lines', '4 × 12 + 3 loose = 51 units');
    expect(await page.inputValue('#receive-lines .line-row[data-product-id="p-oil"] input.arrived')).toBe('51');
    await page.locator('#receive-lines .line-row[data-product-id="p-oil"] .cases-math').scrollIntoViewIfNeeded();
    await shot(page, 'b20a-receive-cases-en-1366.png');
    // A part of a case is refused in words; nothing changes on the line.
    await fillLine(page, 'p-oil', 'cases', '1.5');
    await says(page, '#banner-text', 'Cases and loose units must be whole numbers');
    await page.click('#banner-ok');
    expect(await page.inputValue('#receive-lines .line-row[data-product-id="p-oil"] input.arrived')).toBe('51');
    // The inner of 6: 8 inners + 3 = 51 too.
    await page.selectOption('#receive-lines .line-row[data-product-id="p-oil"] select.case-size', 'inner');
    await fillLine(page, 'p-oil', 'cases', '8');
    await says(page, '#receive-lines', '8 × 6 + 3 loose = 51 units');
    // Rice in single units, as before.
    await fillLine(page, 'p-rice', 'arrived', '10');
    await page.click('#save-receipt');
    await says(page, '#banner-title', 'Delivery saved');
    await page.click('#banner-ok');
    await page.waitForFunction(() => (globalThis as unknown as Win).managerSession!.savedWork().find((w) => w.kind === 'receipt')?.state === 'handed_to_box', undefined, { timeout: 10_000 });
    const [receipt] = await logged(edge);
    expect(receipt?.payload).toMatchObject({ number: 'DN-701', lines: [{ productId: 'p-rice', quantityMinor: 10 }, { productId: 'p-oil', quantityMinor: 51 }] });
    expect(JSON.stringify(receipt?.payload)).not.toMatch(/cases|loose|inner/);

    // Typing Arrived in units clears the cases; Tamil words on the boxes.
    await page.fill('#grn-number', 'DN-702');
    await page.selectOption('#grn-order', 'po:po-7');
    await fillLine(page, 'p-oil', 'cases', '2');
    await says(page, '#receive-lines', '2 × 12 + 0 loose = 24 units');
    await fillLine(page, 'p-oil', 'arrived', '25');
    expect(await page.textContent('#receive-lines')).not.toContain('loose =');
    await page.click('#lang');
    await says(page, '#receive-lines', '12 கொண்ட பெட்டிகள்');
    await says(page, '#receive-lines', 'தனி அலகுகள்');
    await fillLine(page, 'p-oil', 'cases', '4');
    await says(page, '#receive-lines', '4 × 12 + 0 தனி = 48 அலகுகள்');
    await page.locator('#receive-lines .line-row[data-product-id="p-oil"] .cases-math').scrollIntoViewIfNeeded();
    await shot(page, 'b20a-receive-cases-ta-1366.png');
  }, 120_000);
});
