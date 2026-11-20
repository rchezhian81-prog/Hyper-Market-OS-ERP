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
 * **Batch 18a in a real browser, against a REAL store computer with NO cloud:**
 *
 *   • R3 / R4 (M07-FR-02/03) — Receive (office) takes, per line, the MRP printed on the pack (₹) and how many FAILED THE QUALITY
 *     CHECK or were refused at the door. Both are on the line, travel on the receipt the box holds, and a wrong figure is
 *     refused in words with nothing saved.
 *   • B3 (roadmap §27.1) — Goods receipt review, Suppliers, Waste & write-off and Approvals each have a search box: every word
 *     typed must be in a row; a search that matches nothing says so with a way to clear it.
 * Screenshots (deviceScaleFactor 1) go to SRE_SCREENSHOT_DIR when it is set. Synthetic data only. Skips without a browser.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const SHOTS = process.env['SRE_SCREENSHOT_DIR'];
const KEY = ['b18a', 'receive', 'mrp', 'key'].join('-').padEnd(48, '0');
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
  warehouse: {
    assignmentId: 'A-1', workerId: 'u-mgr', storeId: 'store-1',
    bins: [{ binId: 'BIN-A', storeId: 'store-1', capacityMinor: 1000, pickable: true, zone: 'ambient' }],
    openDeliveries: [
      {
        poId: 'po-7', number: 'PO-0007', supplierId: 'sup-demo-foods', deliverToLocationId: 'wh-1', grnId: 'grn-po-7',
        ordered: [{ productId: 'p-rice', quantityMinor: 12, unitCostMinor: 50_000, currency: 'INR' }, { productId: 'p-oil', quantityMinor: 6, unitCostMinor: 18_000, currency: 'INR' }],
      },
    ],
  },
}, [{ userId: 'u-mgr', permissions: OWNER_PERMISSIONS }]));

interface Win { readonly managerSession?: { savedWork(): { kind: string; state: string }[] }; readonly laneWriteBase?: string }
type Logged = { type: string; payload: Record<string, unknown> };

describe.skipIf(!HAVE_BROWSER)('batch 18a — the pack MRP and a failed check on Receive; a search box on four lists', () => {
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
    const dir = await mkdtemp(join(tmpdir(), 'sre-b18a-recv-'));
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

  it('R3/R4: the MRP on the pack and "failed quality check / refused at the door" travel on the receipt; a wrong one is refused', async () => {
    const edge = await box();
    const page = await managerPage(edge);
    await page.waitForFunction('globalThis.managerSession !== undefined && typeof globalThis.laneWriteBase === "string"', undefined, { timeout: 15_000 });
    await page.click('#tab-receive');
    await page.fill('#grn-number', 'DN-601');
    await page.selectOption('#grn-order', 'po:po-7');
    await says(page, '#receive-lines', 'Ponni rice 5 kg');
    // Each line has the two new boxes, labelled in words.
    await says(page, '#receive-lines', 'Failed quality check / refused at the door');
    await says(page, '#receive-lines', 'MRP on the pack (₹)');

    // An MRP that is not an amount is refused in words, and nothing is kept on the line.
    await fillLine(page, 'p-oil', 'mrp', 'abc');
    await says(page, '#banner-text', 'MRP on the pack must be an amount in rupees above 0');
    await page.click('#banner-ok');

    await fillLine(page, 'p-rice', 'qcfail', '3');
    await fillLine(page, 'p-rice', 'mrp', '220.50');
    await says(page, '#receive-lines', '3 failed the check · MRP ₹220.50');
    await shot(page, 'b18a-receive-mrp-and-failed-check-1366.png');

    // More set aside (damaged + failed) than arrived: refused in words, nothing saved.
    await fillLine(page, 'p-oil', 'damaged', '4');
    await fillLine(page, 'p-oil', 'qcfail', '3');
    await page.click('#save-receipt');
    await says(page, '#banner-text', 'damaged and failed the check add up to more than arrived');
    await page.click('#banner-ok');
    expect(await logged(edge)).toEqual([]);

    await fillLine(page, 'p-oil', 'damaged', '');
    await page.click('#save-receipt');
    await says(page, '#banner-title', 'Delivery saved');
    await page.click('#banner-ok');
    await page.waitForFunction(() => (globalThis as unknown as Win).managerSession!.savedWork().find((w) => w.kind === 'receipt')?.state === 'handed_to_box', undefined, { timeout: 10_000 });
    const [receipt] = await logged(edge);
    expect(receipt?.payload).toMatchObject({
      number: 'DN-601', poId: 'po-7',
      lines: [
        { productId: 'p-rice', quantityMinor: 12, qcFailedMinor: 3, mrpMinor: 22_050 },
        { productId: 'p-oil', quantityMinor: 6, qcFailedMinor: 3 },
      ],
    });

    // Tamil words on the two boxes.
    await page.fill('#grn-number', 'DN-602');
    await page.selectOption('#grn-order', 'po:po-7');
    await page.click('#lang');
    await says(page, '#receive-lines', 'தரச் சோதனையில் தோல்வி / வாசலில் மறுக்கப்பட்டது');
    await says(page, '#receive-lines', 'பொதியில் உள்ள MRP (₹)');
    await shot(page, 'b18a-receive-mrp-and-failed-check-ta-1366.png');
  }, 120_000);

  // Batch 20a · R5: Goods receipt review's plain box became the real lookup (tests/e2e/b20a-*.e2e.ts).
  for (const [path, listIds] of [['/suppliers/', ['rows']], ['/waste/', ['rows']], ['/approvals/', ['waiting', 'mine']]] as const) {
    it(`B3: ${path} has a search box — every word must be in a row; nothing matching says so and clears`, async () => {
      const edge = await box();
      const page = await managerPage(edge, path);
      const key = path.split('/')[1]!;
      await page.waitForSelector(`#${key}-list-search`, { timeout: 15_000 });
      // The page's own rows (a sample on this store computer) are joined by three known ones, so the filter is checked exactly.
      await page.evaluate(`(() => {
        const list = document.getElementById(${JSON.stringify(listIds[0])});
        for (const t of ['GRN1/26-27/00012 · Sri Murugan Traders · PO1/26-27/00031', 'GRN1/26-27/00013 · Lakshmi Agencies · PO1/26-27/00032', 'Write-off WOF1/26-27/00004 · Lakshmi Agencies oil']) {
          const li = document.createElement('li'); li.className = 'b18a-row'; li.textContent = t; list.append(li);
        }
      })()`);
      const shown = (): Promise<string[]> => page.$$eval('.b18a-row', (rows) => rows.filter((r) => (r as unknown as { style: { display: string } }).style.display !== 'none').map((r) => (r as unknown as { textContent: string }).textContent));
      expect(await page.getAttribute(`#${key}-list-search`, 'placeholder')).toBe('Search this list');
      await page.fill(`#${key}-list-search`, 'lakshmi');
      expect(await shown()).toEqual(['GRN1/26-27/00013 · Lakshmi Agencies · PO1/26-27/00032', 'Write-off WOF1/26-27/00004 · Lakshmi Agencies oil']);
      await page.fill(`#${key}-list-search`, 'lakshmi PO1');
      expect(await shown()).toEqual(['GRN1/26-27/00013 · Lakshmi Agencies · PO1/26-27/00032']);
      await shot(page, `b18a-search-${key}-1366.png`);
      await page.fill(`#${key}-list-search`, 'nothing-like-this');
      expect(await shown()).toEqual([]);
      expect(await page.isVisible(`#${key}-list-search-none`)).toBe(true);
      expect(await page.textContent(`#${key}-list-search-none`)).toContain('No rows match');
      // (on this sample page every button is switched off, the clear button too — the box is cleared by hand)
      expect(await page.isVisible(`#${key}-list-search-none button`)).toBe(true);
      await page.fill(`#${key}-list-search`, '');
      expect((await shown()).length).toBe(3);
      expect(await page.inputValue(`#${key}-list-search`)).toBe('');
    }, 120_000);
  }
});
