import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';
import { withTillPeople } from '../support/till-operator';
import { sharedDeviceTls, trustingBrowserArgs } from '../support/box-tls';

let deviceTls: Awaited<ReturnType<typeof sharedDeviceTls>>;

/**
 * **Fix batch 5 in a real browser, against a REAL store computer with NO cloud** (M07 · M09 · WF-06 · P-02 · P-07 · P-08):
 *  • D-017 — an order that says "deliver to the store" is booked at the STORE (the place the tills sell from), not always at the
 *    back store; the manager can pick the place on Receive.
 *  • D-033 — the warehouse handheld shows the order number and the supplier's NAME, no "Job …" id, how old its put-away list
 *    is, and a button to read it again.
 *  • D-035 — the Indents page names each item (never "prod-biscuit × 24") and fills the item's unit itself.
 * Synthetic data only. Skips where no browser binary is present.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['batch5', 'warehouse', 'names', 'key'].join('-').padEnd(48, '0');
const TENANT = 't-sre';
const product = (productId: string, name: string, nameTa: string, uom = 'ea') => ({
  productId, name, nameTa, categoryId: 'grocery', unitPriceMinor: 3_500, unitCostMinor: 2_500, uom, barcodes: [], availableMinor: 0, taxBps: 500,
});
const PACK = JSON.stringify(withTillPeople({
  version: 1,
  policies: { tradingDayCutoff: '02:00', storeId: 'store-1', branchId: 'store-1', branchName: 'Main', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, privacySlaDays: 15, warehouseId: 'wh-1' },
  managerPolicy: { userId: 'u-mgr', approvalLimitMinor: 500_000 },
  indentsPolicy: { userId: 'u-mgr', permissions: ['inventory.indent.read', 'inventory.indent.request', 'inventory.indent.approve', 'inventory.movement.append'] },
  lossPreventionRules: [],
  products: [product('p-biscuit', 'Marie biscuits 200 g', 'மேரி பிஸ்கட் 200 கி', 'EA'), product('p-rice', 'Ponni rice 5 kg', 'பொன்னி அரிசி 5 கிலோ', 'BAG')],
  floorIndents: {
    asAt: '2026-11-16T09:00:00.000Z',
    indents: [{
      indentId: 'ind-9', state: 'requested', requestedBy: 'u-floor', requestedAt: '2026-11-16T08:00:00.000Z', approvedBy: null, fromLocationId: 'wh-1', toLocationId: 'store-1', reason: 'shelf empty',
      flags: [], attention: ['awaiting_approval'], needsAttention: true,
      totals: { lines: [{ productId: 'p-biscuit', uom: 'EA', requestedMinor: 24, allocatedMinor: 0, issuedMinor: 0, receivedMinor: 0, inTransitMinor: 0, shortfallMinor: 0, outstandingMinor: 0 }] }, issues: [],
    }],
  },
  warehouse: {
    assignmentId: 'warehouse-store-1', workerId: 'u-mgr', storeId: 'wh-1',
    bins: [{ binId: 'BIN-A', storeId: 'wh-1', capacityMinor: 1000, pickable: true, zone: 'ambient' }],
    goodsIn: [{ productId: 'p-biscuit', batchId: null, quantityMinor: 125, uom: 'EA', state: 'on_hand', expiry: null, recalled: false }],
    productNames: { 'p-biscuit': 'Marie biscuits 200 g', 'p-rice': 'Ponni rice 5 kg' },
    openDeliveries: [
      { poId: 'po-uat06', number: 'PO-0006', supplierId: 'sup-demo-foods', supplierName: 'Demo Foods Pvt Ltd', deliverToLocationId: 'store-1', grnId: 'grn-po-uat06-1',
        ordered: [{ productId: 'p-biscuit', quantityMinor: 40, unitCostMinor: 2_500, currency: 'INR' }] },
      { poId: 'po-back', number: 'PO-0007', supplierId: 'sup-rice', deliverToLocationId: 'wh-1', grnId: 'grn-po-back-1',
        ordered: [{ productId: 'p-rice', quantityMinor: 10, unitCostMinor: 40_000, currency: 'INR' }] },
    ],
  },
}, [{ userId: 'u-mgr', permissions: ['till.dayclose.read', 'inventory.indent.read', 'inventory.indent.request', 'inventory.indent.approve', 'inventory.movement.append'] }]));

interface Win {
  readonly managerSession?: { savedWork(): { kind: string; state: string }[] };
  readonly indentsSession?: unknown;
  readonly warehouseSession?: unknown;
  readonly laneWriteBase?: string;
  readonly document: { querySelector(s: string): { hidden: boolean; textContent: string | null } | null };
}
type Logged = { type: string; payload: Record<string, unknown> };

describe.skipIf(!HAVE_BROWSER)('Fix batch 5: receiving and the back store work by name, in the right place', () => {
  let browser: Browser;
  const dirs: string[] = [];
  const stops: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    for (const app of ['web-erp', 'warehouse-app']) execFileSync('node', ['scripts/build-app.mjs', app], { stdio: 'ignore' });
    deviceTls = await sharedDeviceTls();
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM, args: trustingBrowserArgs(deviceTls.keyPin) });
  }, 240_000);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => {
    for (const stop of stops.splice(0).reverse()) await stop();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  async function box(): Promise<EdgeProcess> {
    const dir = await mkdtemp(join(tmpdir(), 'sre-batch5-e2e-'));
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
    const node = (globalThis as unknown as Win).document.querySelector(sel!);
    return (node?.textContent ?? '').includes(want!);
  }, [selector, text], { timeout: 15_000 });
  const bannerUp = (page: Page) => page.waitForFunction(() => !((globalThis as unknown as Win).document.querySelector('#banner')!).hidden);

  async function openAs(edge: EdgeProcess, path: string, ready: keyof Win): Promise<{ page: Page; errors: string[] }> {
    const context = await browser.newContext();
    stops.push(() => context.close());
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route(`http://127.0.0.1:${edge.screens!.port}/**`, (route) => route.continue({ headers: { ...route.request().headers(), 'x-sre-user': 'u-mgr' } }));
    await page.route(`http://127.0.0.1:${edge.lane!.port}/lane/**`, (route) => route.continue({ headers: { ...route.request().headers(), 'x-sre-user': 'u-mgr' } }));
    await page.goto(`http://127.0.0.1:${edge.screens!.port}${path}`, { waitUntil: 'load' });
    await page.waitForFunction((g) => (globalThis as unknown as Record<string, unknown>)[g as string] !== undefined, ready, { timeout: 15_000 });
    return { page, errors };
  }

  it('D-017: an order to the store is booked at the store; the manager may pick the back store instead', async () => {
    const edge = await box();
    const { page, errors } = await openAs(edge, '/manager', 'managerSession');
    await page.waitForFunction(() => typeof (globalThis as unknown as Win).laneWriteBase === 'string', undefined, { timeout: 15_000 });
    await page.click('#tab-receive');
    // The order names its supplier by name (D-033 on Receive too).
    await says(page, '#grn-order', 'PO-0006 · Demo Foods Pvt Ltd');
    await page.fill('#grn-number', 'DN-601');
    await page.selectOption('#grn-order', 'po:po-uat06');
    await says(page, '#receive-lines', 'Marie biscuits 200 g');
    // The place is the one the order names: this store, said in words.
    expect(await page.$eval('#grn-place', (s) => (s as unknown as { value: string }).value)).toBe('store-1');
    await says(page, '#grn-place-hint', 'The order says deliver to: This store');
    await page.click('#save-receipt');
    await bannerUp(page);
    await says(page, '#banner-title', 'Delivery saved');
    await page.click('#banner-ok');
    await page.waitForFunction(() => (globalThis as unknown as Win).managerSession!.savedWork().some((w) => w.kind === 'receipt' && w.state === 'handed_to_box'), undefined, { timeout: 10_000 });
    expect((await logged(edge)).map((r) => r.payload['warehouseId'])).toEqual(['store-1']);

    // The rice order goes to the back store; the manager picks the store instead (the shelf is empty) — it is booked there.
    await page.fill('#grn-number', 'DN-602');
    await page.selectOption('#grn-order', 'po:po-back');
    await says(page, '#receive-lines', 'Ponni rice 5 kg');
    expect(await page.$eval('#grn-place', (s) => (s as unknown as { value: string }).value)).toBe('wh-1');
    await page.selectOption('#grn-place', 'store-1');
    await says(page, '#grn-place-hint', 'you chose another place');
    await page.click('#save-receipt');
    await bannerUp(page);
    await says(page, '#banner-title', 'Delivery saved');
    await page.click('#banner-ok');
    await page.waitForFunction(() => (globalThis as unknown as Win).managerSession!.savedWork().filter((w) => w.kind === 'receipt' && w.state === 'handed_to_box').length === 2, undefined, { timeout: 10_000 });
    expect((await logged(edge)).map((r) => r.payload['warehouseId'])).toEqual(['store-1', 'store-1']);

    // Tamil words for the place.
    await page.click('#lang');
    await says(page, '#grn-place-label', 'பொருட்களை எங்கே பதிவு செய்வது');
    expect(errors).toEqual([]);
  });

  it('D-033: the handheld names the supplier, drops "Job …", says how old the put-away list is and reads it again', async () => {
    const edge = await box();
    const { page, errors } = await openAs(edge, '/warehouse', 'warehouseSession');
    await says(page, '#deliveries', 'PO-0006 · Demo Foods Pvt Ltd');
    const deliveries = await page.textContent('#deliveries');
    expect(deliveries).not.toContain('sup-demo-foods');
    expect(deliveries).not.toMatch(/\d+ × \d+/);
    expect(deliveries).toContain('PO-0007 · sup-rice'); // no name on record: the code, never a blank
    expect(await page.textContent('#assignment')).not.toContain('Job');
    expect(await page.textContent('#assignment')).not.toContain('warehouse-store-1');
    await says(page, '#goods-in-asat', 'This list is as the store computer last heard from head office');
    await says(page, '#goods-in-refresh', 'Refresh the list');
    // The button reads the list again from the store computer (a reload: the work done here is on the device's queue).
    await page.evaluate(() => { (globalThis as unknown as Record<string, unknown>)['beforeRefresh'] = true; });
    // Wait for the reload itself, then for the fresh page, rather than polling across the navigation under load.
    await Promise.all([page.waitForEvent('load', { timeout: 30_000 }), page.click('#goods-in-refresh')]);
    await page.waitForFunction(() => (globalThis as unknown as Record<string, unknown>)['beforeRefresh'] === undefined && (globalThis as unknown as Record<string, unknown>)['warehouseSession'] !== undefined, undefined, { timeout: 15_000 });
    await page.waitForSelector('#goods-in-asat:not([hidden])', { timeout: 15_000 });
    await says(page, '#goods-in-heading', 'Waiting to be put away');
    expect(errors).toEqual([]);
  });

  it('D-035: the Indents page names each item and fills its unit itself', async () => {
    const edge = await box();
    const { page, errors } = await openAs(edge, '/indents', 'indentsSession');
    // The ask waiting for approval reads by name, in its unit — never "p-biscuit × 24".
    await page.waitForSelector('#approver:not([hidden])');
    const options = await page.$$eval('#approve-indent option', (os) => os.map((o) => (o as unknown as { textContent: string }).textContent));
    expect(options[0]).toMatch(/^ind-9 · Marie biscuits 200 g × 24/);
    expect(options[0]).not.toContain('p-biscuit');
    // Raising one: choosing the item fills its unit; the line reads by name.
    await page.waitForSelector('#raiser:not([hidden])');
    await page.fill('#raise-product', 'p-rice');
    await page.dispatchEvent('#raise-product', 'change');
    expect(await page.$eval('#raise-uom', (i) => (i as unknown as { value: string }).value)).toBe('BAG');
    await page.fill('#raise-qty', '3');
    await page.click('#raise-add');
    await says(page, '#raise-lines', 'Ponni rice 5 kg × 3 BAG');
    expect(await page.textContent('#raise-lines')).not.toContain('p-rice');
    // A unit the person typed is kept (the pre-fill never overwrites their own).
    await page.fill('#raise-product', 'p-biscuit');
    await page.fill('#raise-uom', 'CASE');
    await page.dispatchEvent('#raise-product', 'change');
    expect(await page.$eval('#raise-uom', (i) => (i as unknown as { value: string }).value)).toBe('CASE');
    expect(errors).toEqual([]);
  });
});
