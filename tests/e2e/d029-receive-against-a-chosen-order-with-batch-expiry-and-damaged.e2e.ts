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
 * **Fix batch 4b · D-029 in a real browser, against a REAL store computer with NO cloud.** The walkthrough found the manager's
 * Receive form took the order number typed by hand, filled in none of its lines, and had no batch number, no expiry date and
 * no short / damaged entry — so received food never reached the expiry list. Now the store computer serves the orders this
 * store is waiting for (the same list the handheld chooses from); the manager CHOOSES the order, its lines fill in by name with
 * what is still due, and each line takes what arrived, how many were damaged, the batch and the expiry date. Short is shown
 * against what was due. The receipt the box holds carries all of it. A wrong line (more damaged than arrived) is refused in
 * words with nothing saved. Synthetic data only. Skips where no browser binary is present.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['d029', 'receive', 'order', 'key'].join('-').padEnd(48, '0');
const TENANT = 't-sre';
const product = (productId: string, name: string, nameTa: string) => ({
  productId, name, nameTa, categoryId: 'grocery', unitPriceMinor: 6_000, unitCostMinor: 5_000, uom: 'ea', barcodes: [], availableMinor: 0, taxBps: 500,
});
const PACK = JSON.stringify(withTillPeople({
  version: 1,
  policies: { tradingDayCutoff: '02:00', storeId: 'store-1', branchId: 'store-1', branchName: 'Main', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, privacySlaDays: 15, warehouseId: 'wh-1' },
  managerPolicy: { userId: 'u-mgr', approvalLimitMinor: 500_000 },
  lossPreventionRules: [],
  products: [product('p-rice', 'Ponni rice 5 kg', 'பொன்னி அரிசி 5 கிலோ'), product('p-dal', 'Toor dal 1 kg', 'துவரம் பருப்பு 1 கிலோ'), product('p-oil', 'Groundnut oil 1 L', 'கடலை எண்ணெய் 1 லி')],
  warehouse: {
    assignmentId: 'A-1', workerId: 'u-mgr', storeId: 'store-1',
    bins: [{ binId: 'BIN-A', storeId: 'store-1', capacityMinor: 1000, pickable: true, zone: 'ambient' }],
    openDeliveries: [
      {
        poId: 'po-7', number: 'PO-0007', supplierId: 'sup-demo-foods', deliverToLocationId: 'wh-1', grnId: 'grn-po-7',
        ordered: [
          { productId: 'p-rice', quantityMinor: 12, unitCostMinor: 50_000, currency: 'INR' },
          { productId: 'p-dal', quantityMinor: 10, unitCostMinor: 12_000, currency: 'INR' },
          { productId: 'p-oil', quantityMinor: 0, unitCostMinor: 18_000, currency: 'INR' }, // already received in full
        ],
      },
      { poId: 'po-8', number: 'PO-0008', supplierId: 'sup-other', deliverToLocationId: 'wh-1', grnId: 'grn-po-8', ordered: [{ productId: 'p-oil', quantityMinor: 6, unitCostMinor: 18_000, currency: 'INR' }] },
    ],
  },
}, [{ userId: 'u-mgr', permissions: ['till.dayclose.read'] }]));

interface Win {
  readonly managerSession?: { savedWork(): { kind: string; state: string }[] };
  readonly laneWriteBase?: string;
  readonly document: { querySelector(s: string): { hidden: boolean } | null };
}
type Logged = { type: string; payload: Record<string, unknown> };

describe.skipIf(!HAVE_BROWSER)('D-029: the manager receives against a chosen order — lines filled in, batch, expiry, short and damaged', () => {
  let browser: Browser;
  const dirs: string[] = [];
  const stops: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    deviceTls = await sharedDeviceTls();
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM, args: trustingBrowserArgs(deviceTls.keyPin) });
  }, 240_000);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => {
    for (const stop of stops.splice(0).reverse()) await stop();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  async function box(): Promise<EdgeProcess> {
    const dir = await mkdtemp(join(tmpdir(), 'sre-d029-e2e-'));
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
  const bannerUp = (page: Page) => page.waitForFunction(() => !((globalThis as unknown as Win).document.querySelector('#banner') as { hidden: boolean }).hidden);
  const says = (page: Page, selector: string, text: string) => page.waitForFunction(([sel, want]) => {
    const node = (globalThis as unknown as { document: { querySelector(s: string): { textContent: string | null } | null } }).document.querySelector(sel!);
    return (node?.textContent ?? '').includes(want!);
  }, [selector, text], { timeout: 15_000 });
  const fillLine = async (page: Page, productId: string, cls: string, value: string) => {
    const box = page.locator(`#receive-lines .line-row[data-product-id="${productId}"] input.${cls}`);
    await box.fill(value);
    await box.dispatchEvent('change');
  };

  async function managerPage(edge: EdgeProcess): Promise<Page> {
    const context = await browser.newContext();
    stops.push(() => context.close());
    const page = await context.newPage();
    await page.route(`http://127.0.0.1:${edge.screens!.port}/**`, (route) => route.continue({ headers: { ...route.request().headers(), 'x-sre-user': 'u-mgr' } }));
    await page.route(`http://127.0.0.1:${edge.lane!.port}/lane/**`, (route) => route.continue({ headers: { ...route.request().headers(), 'x-sre-user': 'u-mgr' } }));
    await page.goto(`http://127.0.0.1:${edge.screens!.port}/manager`, { waitUntil: 'load' });
    await page.waitForFunction(() => (globalThis as unknown as Win).managerSession !== undefined && typeof (globalThis as unknown as Win).laneWriteBase === 'string', undefined, { timeout: 15_000 });
    await page.click('#tab-receive');
    return page;
  }

  it('the order is chosen from a list; its lines fill in by name with what is due; batch, expiry, short and damaged travel on the receipt', async () => {
    const edge = await box();
    const page = await managerPage(edge);

    // The order is CHOSEN — no number typed. The list names each order and how many items are still due.
    await says(page, '#grn-order-label', 'Which order is this delivery?');
    expect(await page.isHidden('#grn-po-field')).toBe(true);
    const options = await page.$$eval('#grn-order option', (os) => os.map((o) => (o as unknown as { textContent: string }).textContent));
    expect(options).toEqual(expect.arrayContaining(['PO-0007 · sup-demo-foods · 2 item(s) due', 'PO-0008 · sup-other · 1 item(s) due', 'No order — delivered without one', 'An order not listed — type its number']));

    // Nothing chosen and nothing typed: the delivery is not saved, the words say what to do.
    await page.fill('#grn-number', 'DN-501');
    await page.click('#save-receipt');
    await bannerUp(page);
    await says(page, '#banner-text', 'Choose the order this delivery is against first');
    await page.click('#banner-ok');

    // Choosing PO-0007 fills in its two due lines by NAME (the oil, already received in full, is not offered).
    await page.selectOption('#grn-order', 'po:po-7');
    await says(page, '#receive-lines', 'Ponni rice 5 kg');
    await says(page, '#receive-lines', 'Toor dal 1 kg');
    expect(await page.textContent('#receive-lines')).not.toContain('Groundnut oil');
    await says(page, '#receive-lines', '12 / 12 due');

    // Rice: 11 came (one short), 2 of them damaged, batch and expiry off the pack. Dal: expiry only (no batch printed).
    await fillLine(page, 'p-rice', 'arrived', '11');
    await says(page, '#receive-lines', 'Short by 1');
    await fillLine(page, 'p-rice', 'damaged', '2');
    await fillLine(page, 'p-rice', 'batch', 'RB-2611');
    await fillLine(page, 'p-rice', 'expiry', '2027-05-31');
    await fillLine(page, 'p-dal', 'expiry', '2027-02-28');
    await says(page, '#receive-lines', '11 / 12 due · 2 damaged · batch RB-2611 · expires 2027-05-31');

    await page.click('#save-receipt');
    await bannerUp(page);
    await says(page, '#banner-title', 'Delivery saved');
    await page.click('#banner-ok');
    await page.waitForFunction(() => (globalThis as unknown as Win).managerSession!.savedWork().find((w) => w.kind === 'receipt')?.state === 'handed_to_box', undefined, { timeout: 10_000 });
    const [receipt] = await logged(edge);
    expect(receipt?.payload).toMatchObject({
      number: 'DN-501', poId: 'po-7',
      lines: [
        { productId: 'p-rice', quantityMinor: 11, damagedMinor: 2, batchId: 'RB-2611', expiry: '2027-05-31' },
        // No batch printed: kept as its own batch named by its date, so two dates never fold into one batch.
        { productId: 'p-dal', quantityMinor: 10, batchId: 'EXP-2027-02-28', expiry: '2027-02-28' },
      ],
    });
    // The form is clear for the next delivery and the order list is back to "choose".
    expect(await page.$eval('#grn-order', (s) => (s as unknown as { value: string }).value)).toBe('');
    expect(await page.isHidden('#receive-empty')).toBe(false);

    // Tamil words on the form.
    await page.click('#lang');
    await says(page, '#grn-order-label', 'இந்த டெலிவரி எந்த ஆர்டருக்கு?');
  });

  it('a wrong line is refused in words with nothing saved; an order not listed can still be typed', async () => {
    const edge = await box();
    const page = await managerPage(edge);

    await page.fill('#grn-number', 'DN-502');
    await page.selectOption('#grn-order', 'po:po-8');
    await says(page, '#receive-lines', 'Groundnut oil 1 L');
    await fillLine(page, 'p-oil', 'damaged', '9'); // more damaged than the 6 that arrived
    await page.click('#save-receipt');
    await bannerUp(page);
    await says(page, '#banner-text', 'Nothing was saved. Check these lines: Groundnut oil 1 L: more damaged than arrived');
    await page.click('#banner-ok');
    expect(await logged(edge)).toEqual([]);

    // "An order not listed": the typed number is used (an order issued after the store computer's list never blocks receiving).
    await page.selectOption('#grn-order', 'other');
    expect(await page.isHidden('#grn-po-field')).toBe(false);
    await page.fill('#grn-po', 'po-new');
    await page.fill('#grn-product', 'p-dal');
    await page.fill('#grn-qty', '3');
    await page.click('#add-line');
    await says(page, '#receive-lines', 'Toor dal 1 kg');
    expect(await page.textContent('#receive-lines')).not.toContain('Groundnut oil'); // the chosen order's lines went with it
    await page.click('#save-receipt');
    await bannerUp(page);
    await says(page, '#banner-title', 'Delivery saved');
    await page.click('#banner-ok');
    await page.waitForFunction(() => (globalThis as unknown as Win).managerSession!.savedWork().some((w) => w.kind === 'receipt' && w.state === 'handed_to_box'), undefined, { timeout: 10_000 });
    const [receipt] = await logged(edge);
    expect(receipt?.payload).toMatchObject({ number: 'DN-502', poId: 'po-new', lines: [{ productId: 'p-dal', quantityMinor: 3 }] });
  });
});
