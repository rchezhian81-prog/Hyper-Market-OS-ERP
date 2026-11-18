import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';
import { writeSignedPack } from '../../edge/store-edge/src/signed-pack-file';
import { hmacSigner, publishPack } from '../../services/catalogue/src/index';
import type { CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';
import { financialYearLabel } from '../../packages/numbering/src/document-numbers';
import { prepareTillBox, signInThroughScreen, takeFloatOnPage } from '../support/till-operator';

/**
 * **OB-847 (owner, 18 Nov 2026: "Document numbers, format A") · OB-846 A — in a real Chromium, on a real store computer:
 * the bill's number is made on the store computer in the new form `1L01/<YY-YY>/00001`, is SHOWN on the till's screen and
 * PRINTED on the tax invoice; the return at the till takes its own range, `1R01/<YY-YY>/00001`.**
 *
 * The store setup carries head office's format-A section (store 1, this till's lane code L01), exactly as head office's
 * store pack sends it. Screenshots (deviceScaleFactor 1) go to SRE_SCREENSHOT_DIR when it is set. Skips without a browser.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const SHOTS = process.env['SRE_SCREENSHOT_DIR'];
const KEY = ['ob847', 'format', 'a', 'till', 'key'].join('-').padEnd(48, '0');
const SHOP = { legalName: 'SRE Hyper Market Private Limited', gstin: '33ABCDE1234F1Z5', placeOfBusiness: ['12 Main Road', 'Tiruppur 641601, Tamil Nadu'] };
const DAL = '8901234567890';
const pack = {
  version: 1,
  policies: {
    storeId: 'store-1', branchId: 'store-1', branchName: 'Main', tradingDayCutoff: '00:00', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000,
    handoverToleranceMinor: 10_000, cashVarianceToleranceMinor: 10_000, privacySlaDays: 15, warehouseId: 'wh-1', taxInvoice: SHOP,
  },
  servicePolicy: { returnWindowDays: 30, approvalThresholdMinor: 1_000_000, noReceiptCapMinor: 0, agentAuthorityMinor: 0, compensationCapMinor: 0 },
  lossPreventionRules: [],
  // OB-847: head office's format-A section — store 1, this till is L01 (given automatically on head office's register).
  receiptNumbering: { storesInBusiness: 1, formatA: { storeNumber: 1, laneCodes: { 'lane-1': 'L01' }, banked: {} } },
};
function signedCatalogue() {
  const snapshot: CatalogueSnapshot = {
    tenantId: 't-sre', version: 3, builtAt: new Date().toISOString(),
    products: [{ productId: 'P1', sku: 'DAL', name: 'Toor dal 1kg', baseUom: 'ea', unitPriceMinor: 10_500, taxBps: 500, hsnCode: '071360', status: 'active' }],
    barcodes: [{ code: DAL, productId: 'P1', kind: 'standard' }],
  };
  const result = publishPack({ snapshot, approvals: [], signer: hmacSigner(KEY), publishedBy: 'u-manager', publishedAt: snapshot.builtAt });
  if (!result.ok || result.pack === undefined) throw new Error(result.detail);
  return result.pack;
}
const PEOPLE = [{ userId: 'u-lanecash', displayName: 'Lane Cashier' }, { userId: 'u-mgr', displayName: 'Manager', manager: true }];
const PRINT_RECORDER = `
  window.prints = [];
  window.print = () => {
    const area = document.getElementById('print-area');
    const fields = {};
    for (const node of Array.from(area.querySelectorAll('[data-field]'))) {
      for (const f of (node.getAttribute('data-field') || '').split(' ')) (fields[f] = fields[f] || []).push((node.textContent || '').trim());
    }
    window.prints.push({ number: area.dataset.number, fields });
  };`;

interface PosWindow {
  readonly posSession?: { hasCatalogue(): boolean; basket(): unknown[] };
  readonly prints?: { number: string; fields: Record<string, string[]> }[];
}

describe.skipIf(!HAVE_BROWSER)('OB-847 — the till\'s bill and return carry format-A numbers, on the screen and on paper', () => {
  let browser: Browser;
  const dirs: string[] = [];
  const stops: (() => Promise<void>)[] = [];
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'pos'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
    if (SHOTS !== undefined) await mkdir(SHOTS, { recursive: true });
  }, 90_000);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => {
    for (const stop of stops.splice(0).reverse()) await stop();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  const shows = (page: Page, panelId: string, titleId: string, startsWith: string): Promise<unknown> => page.waitForFunction(
    `(() => { const p = document.getElementById(${JSON.stringify(panelId)}); const t = document.getElementById(${JSON.stringify(titleId)});`
    + ` return p !== null && !p.hidden && t !== null && (t.textContent || '').includes(${JSON.stringify(startsWith)}); })()`,
    undefined, { timeout: 15_000 },
  );
  const shot = async (page: Page, name: string): Promise<void> => { if (SHOTS !== undefined) await page.screenshot({ path: join(SHOTS, name), fullPage: true }); };

  it('sale 1L01/YY-YY/00001 on the screen and the printed bill; the return 1R01/YY-YY/00001', async () => {
    const yy = financialYearLabel(new Date().toISOString());
    const dir = await mkdtemp(join(tmpdir(), 'sre-ob847-till-'));
    dirs.push(dir);
    await writeSignedPack(dir, signedCatalogue());
    const edge: EdgeProcess = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY,
      EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '8090', EDGE_LANE_ID: 'lane-1', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps',
      EDGE_REAL_TRADING: '1',
      ...await prepareTillBox({ dir, key: KEY, pack, people: PEOPLE }),
    }, () => {}))!;
    stops.push(() => edge.stop());
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
    stops.push(() => context.close());
    const page = await context.newPage();
    page.setDefaultTimeout(8_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript(PRINT_RECORDER);
    await page.goto(`http://127.0.0.1:${edge.screens!.port}/pos/`, { waitUntil: 'load' });
    await page.waitForFunction(() => (globalThis as unknown as PosWindow).posSession?.hasCatalogue() === true, undefined, { timeout: 15_000 });
    await signInThroughScreen(page);
    await takeFloatOnPage(page);

    // ── A cash sale: the store computer numbers it in the new form, before the till hears the number.
    await page.keyboard.type(DAL);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => (globalThis as unknown as PosWindow).posSession!.basket().length === 1);
    await page.click('#tender');
    await shows(page, 'pay', 'pay-title', 'How is the customer paying?');
    await page.click('#pay-kinds button:first-child');
    await shows(page, 'sheet', 'sheet-title', 'Cash received');
    await page.click('#quick button:first-child');
    await page.waitForSelector('#refusal:not([hidden])', { timeout: 15_000 });
    const billNumber = `1L01/${yy}/00001`;
    expect(billNumber.length).toBe(16);
    await expect.poll(async () => (await readLog(edge.log.path)).length, { timeout: 10_000 }).toBe(1);
    const sale = (await readLog(edge.log.path)).map((r) => (r.ok ? JSON.parse(r.record) as { number: string; receiptNumber?: string } : null))[0]!;
    expect(sale.number ?? sale.receiptNumber).toBe(billNumber);
    // ON THE SCREEN: the bill the cashier sees carries it.
    expect(await page.textContent('#refusal-receipt')).toContain(billNumber);
    await shot(page, 'till-bill-on-screen.png');
    // ON PAPER: the printed tax invoice's number is the new number.
    await page.click('#print-bill');
    const printed = await page.evaluate(() => (globalThis as unknown as PosWindow).prints ?? []);
    expect(printed[0]!.number).toBe(billNumber);
    expect(printed[0]!.fields['invoice_number']![0]).toContain(billNumber);
    await page.emulateMedia({ media: 'print' });
    if (SHOTS !== undefined) await page.locator('#print-area').screenshot({ path: join(SHOTS, 'printed-bill.png') });
    await page.emulateMedia({ media: 'screen' });
    await page.click('#refusal-ok');

    // ── A cash return of that bill at the till: its own range, 1R01.
    await page.click('#more');
    await shows(page, 'pay', 'pay-title', 'More');
    await page.click('#pay-kinds button:text-is("Refund")');
    await shows(page, 'sheet', 'sheet-title', 'Scan the receipt, or key the bill number');
    await page.keyboard.type(billNumber);
    await page.keyboard.press('Enter');
    await shows(page, 'pay', 'pay-title', 'Which item is coming back?');
    await page.click('#pay-kinds button:first-child');
    await shows(page, 'sheet', 'sheet-title', 'Why is it coming back?');
    await page.click('#reasons button:text-is("Damaged / faulty")');
    await shows(page, 'pay', 'pay-title', 'What condition is the item in?');
    await page.click('#pay-kinds button:text-is("Good — back on the shelf")');
    await shows(page, 'pay', 'pay-title', 'How is the refund given?');
    await page.click('#pay-kinds button:text-is("Cash")');
    await page.waitForSelector('#refusal:not([hidden])', { timeout: 15_000 });
    const returnNumber = `1R01/${yy}/00001`;
    expect(await page.textContent('#refusal')).toContain(returnNumber);
    await shot(page, 'till-return-on-screen.png');
    expect(errors).toEqual([]);
  }, 120_000);
});
