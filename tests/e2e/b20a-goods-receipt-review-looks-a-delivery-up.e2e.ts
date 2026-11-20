import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { withTillPeople } from '../support/till-operator';
import { sharedDeviceTls, trustingBrowserArgs } from '../support/box-tls';
import { ROLE_CATALOGUE } from '../../services/api/src/roles';

const OWNER_PERMISSIONS = [...(ROLE_CATALOGUE.find((r) => r.id === 'owner') as unknown as { permissions: readonly string[] }).permissions];
let deviceTls: Awaited<ReturnType<typeof sharedDeviceTls>>;

/**
 * **Batch 20a · R5 (M07-FR-01 "receiving and dock reports" · roadmap §27.1) in a real browser on a real store computer:**
 * Goods receipt review looks a delivery up — by its GRN number, its order number or its supplier, and/or the days it was
 * received; "Last month" fills last month's first and last day, so a delivery from last month is found in one tap. Dates that
 * make no sense are said. The list is head office's (answered here by a stand-in for head office's receipts list, as it
 * answers with the order number and supplier — proven in tests/integration/b20a-receiving-…). English and Tamil.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const SHOTS = process.env['SRE_SCREENSHOT_DIR'];
const KEY = ['b20a', 'grn', 'lookup', 'key'].join('-').padEnd(48, '0');
const PACK = JSON.stringify(withTillPeople({
  version: 1,
  policies: { tradingDayCutoff: '02:00', storeId: 'store-1', branchId: 'store-1', branchName: 'Main', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, privacySlaDays: 15, warehouseId: 'wh-1' },
  managerPolicy: { userId: 'u-mgr', approvalLimitMinor: 500_000 },
  // Who is at Goods receipt review and what they may read (head office's word, carried in the store setup).
  goodsReceiptPolicy: { userId: 'u-mgr', permissions: ['inventory.availability.read'] },
  lossPreventionRules: [],
}, [{ userId: 'u-mgr', permissions: OWNER_PERMISSIONS }]));

/** The shop's (IST) month before this one, and a moment in the middle of it. */
function lastMonth(): { month: string; firstDay: string; lastDay: string; midMonth: string } {
  const ist = new Date(Date.now() + 330 * 60_000);
  const first = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth() - 1, 1));
  const month = first.toISOString().slice(0, 7);
  const end = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return { month, firstDay: `${month}-01`, lastDay: `${month}-${String(end).padStart(2, '0')}`, midMonth: `${month}-14T05:00:00.000Z` };
}

const receipt = (grnId: string, number: string, receivedAt: string, order?: Record<string, string>) => ({
  grnId, number: `DN-${grnId}`, documentNumber: number, poId: order === undefined ? null : `po-${grnId}`, warehouseId: 'wh-1', receivedBy: 'u-recv', receivedAt,
  captured: { lines: [], discrepancies: [], discrepancyValue: { minor: 0, currency: 'INR' }, requiresApproval: false },
  availableMinor: 10, heldMinor: 0, ...(order === undefined ? {} : { order }),
});

describe.skipIf(!HAVE_BROWSER)('batch 20a — Goods receipt review: look a delivery up', () => {
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
  const shot = async (page: Page, name: string): Promise<void> => { if (SHOTS !== undefined) await page.screenshot({ path: join(SHOTS, name), fullPage: true }); };

  it('by GRN number, order number or supplier, and by the days received; last month in one tap; bad dates said; Tamil', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-b20a-grn-'));
    dirs.push(dir);
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, PACK, 'utf8');
    const edge: EdgeProcess = (await startEdge({
      EDGE_DEVICE_TLS_DIR: deviceTls.dir,
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
      EDGE_LANE_PORT: '0', EDGE_SCREEN_PORT: '0', EDGE_DEVICE_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_PACK_FILE: packFile,
      EDGE_LANE_ID: 'lane-1', EDGE_LANE_TRUST_FORWARDED_USER: '1', EDGE_SCREEN_TRUST_FORWARDED_USER: '1',
    }, () => {}))!;
    stops.push(() => edge.stop());
    const lm = lastMonth();
    const now = new Date().toISOString();
    const LIST = {
      receipts: [
        receipt('g1', 'GRN1/26-27/00012', lm.midMonth, { orderNumber: 'PO/26-27/00031', supplierId: 'sup-murugan', supplierName: 'Sri Murugan Traders' }),
        receipt('g2', 'GRN1/26-27/00013', now, { orderNumber: 'PO/26-27/00032', supplierId: 'sup-lakshmi', supplierName: 'Lakshmi Agencies' }),
        receipt('g3', 'GRN1/26-27/00020', now),
      ],
      count: 3, needingApprovalCount: 0,
    };
    const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, deviceScaleFactor: 1, serviceWorkers: 'block' });
    stops.push(() => context.close());
    const page = await context.newPage();
    await page.route(`http://127.0.0.1:${edge.screens!.port}/**`, (route) => {
      // Head office's receipts list, as it answers (the store computer's own pages are served as they are).
      if (new URL(route.request().url()).pathname.startsWith('/v1/inventory/goods-receipt')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(LIST) });
      return route.continue({ headers: { ...route.request().headers(), 'x-sre-user': 'u-mgr' } });
    });
    await page.goto(`http://127.0.0.1:${edge.screens!.port}/goods-receipt/`, { waitUntil: 'load' });
    await page.waitForFunction(() => (globalThis as unknown as { document: { querySelectorAll(q: string): { length: number } } }).document.querySelectorAll('#rows > li').length === 3, undefined, { timeout: 15_000 });
    const rows = (): Promise<string[]> => page.$$eval('#rows > li .headline', (h) => h.map((x) => x.textContent ?? ''));
    // Each row says the order by its number and the supplier by name.
    expect(await page.textContent('#rows')).toContain('Supplier: Sri Murugan Traders');
    expect(await page.textContent('#rows')).toContain('Order: PO/26-27/00031');
    expect(await page.isVisible('#goods-receipt-list-search')).toBe(false); // the plain box became this lookup

    await page.fill('#lookup-text', 'lakshmi');
    await page.click('#lookup-show');
    expect(await rows()).toEqual(['GRN1/26-27/00013']);
    expect(await page.textContent('#lookup-status')).toBe('Showing 1 of 3 deliveries that match.');
    await page.fill('#lookup-text', 'PO/26-27/00031');
    await page.press('#lookup-text', 'Enter');
    expect(await rows()).toEqual(['GRN1/26-27/00012']);
    await page.fill('#lookup-text', '00020');
    await page.click('#lookup-show');
    expect(await rows()).toEqual(['GRN1/26-27/00020']);

    // Last month in one tap: last month's first and last day, and last month's delivery.
    await page.fill('#lookup-text', '');
    await page.click('#lookup-last-month');
    expect([await page.inputValue('#lookup-from'), await page.inputValue('#lookup-to')]).toEqual([lm.firstDay, lm.lastDay]);
    expect(await rows()).toEqual(['GRN1/26-27/00012']);
    await shot(page, 'b20a-goods-receipt-lookup-last-month-en-1366.png');

    // Nothing matches: said. Dates the wrong way round: said, and the list is shown whole.
    await page.fill('#lookup-text', 'nobody-like-this');
    await page.click('#lookup-show');
    expect(await rows()).toEqual([]);
    expect(await page.textContent('#lookup-status')).toContain('No delivery matches');
    await page.fill('#lookup-text', '');
    await page.fill('#lookup-from', lm.lastDay);
    await page.fill('#lookup-to', lm.firstDay);
    await page.click('#lookup-show');
    expect(await page.textContent('#lookup-status')).toBe('"Received from" is after "Received to". Swap the dates.');
    await page.click('#lookup-clear');
    expect((await rows()).length).toBe(3);

    // Tamil.
    await page.click('#lang');
    await page.waitForFunction(() => ((globalThis as unknown as { document: { getElementById(id: string): { textContent: string | null } | null } }).document.getElementById('lookup-heading')?.textContent ?? '') === 'ஒரு டெலிவரியைத் தேடு');
    await page.fill('#lookup-text', 'murugan');
    await page.click('#lookup-show');
    expect(await rows()).toEqual(['GRN1/26-27/00012']);
    expect(await page.textContent('#lookup-status')).toContain('பொருந்தும் 1 காட்டப்படுகின்றன');
    await shot(page, 'b20a-goods-receipt-lookup-ta-1366.png');
  }, 120_000);
});
