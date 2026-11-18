import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
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
import { rangeStandings, type DocumentNumberIssue } from '../../services/platform/src/document-number-issue';
import { apiHarness } from '../support/api-harness';

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
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
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

  /** The office pages served as files, with head office's answers for the paths each page reads (synthetic data). */
  const office = async (answers: Readonly<Record<string, unknown>>, inject: Readonly<Record<string, unknown>>): Promise<{ base: string; stop: () => Promise<void> }> => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      void (async () => {
        const path = (req.url ?? '/').split('?')[0] ?? '/';
        for await (const chunk of req) void chunk;
        const answer = Object.entries(answers).find(([k]) => path === k || path.startsWith(k));
        if (answer !== undefined) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(answer[1])); return; }
        const file = path.replace(/^\//, '');
        try {
          let body = (await readFile(join('apps/web-erp/web', file))).toString('utf8');
          if (file.endsWith('.html')) body = body.replace('<!--SCREEN-DATA-->', Object.entries(inject).map(([k, v]) => `<script>window.${k} = ${JSON.stringify(v).replace(/</g, '\\u003c')};</script>`).join(''));
          res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream', 'cache-control': 'no-store' });
          res.end(body);
        } catch { res.writeHead(404); res.end('not found'); }
      })();
    });
    await new Promise<void>((r) => { server.listen(0, '127.0.0.1', () => { r(); }); });
    const addr = server.address();
    return { base: `http://127.0.0.1:${typeof addr === 'object' && addr !== null ? addr.port : 0}`, stop: () => new Promise((d) => { server.close(() => { d(); }); server.closeAllConnections(); }) };
  };

  it('the office screens show the new numbers: a raised order says PO/YY-YY/…; Store setup lists every range and warns from 90,000', async () => {
    const yy = financialYearLabel(new Date().toISOString());
    // Head office's real setup status, from the real API (in memory).
    const h = apiHarness();
    const tenantId = randomUUID();
    await h.seedOwner(tenantId, 'u-owner');
    const status = (await h.request({ method: 'GET', path: '/v1/platform/setup', userId: 'u-owner', tenantId })).body;
    // The document-number ranges as head office answers them: a few documents saved, a till range near its end (synthetic).
    const at = new Date().toISOString();
    const issue = (kind: DocumentNumberIssue['kind'], prefix: string, count: number): DocumentNumberIssue => ({ number: `${prefix}/${yy}/${String(count).padStart(5, '0')}`, kind, prefix, yearLabel: yy, count, documentRef: `${prefix}-${count}`, issuedAt: at });
    const warning = `Till numbers 1L01/${yy} have reached 90,412; at 99,999 the till moves to its next range by itself. Tell the owner.`;
    const docnumbers = {
      ranges: rangeStandings([issue('purchase_order', 'PO', 1), issue('purchase_order', 'PO', 2), issue('goods_receipt', 'GRN1', 1), issue('supplier_payment', 'SPAY', 1), issue('customer_credit_note', 'CCN', 1)]),
      tills: [{ storeId: 'S1', storeNumber: 1, lanes: [{ laneId: 'lane-1', code: '1L01' }, { laneId: 'lane-2', code: '1L02' }, { laneId: 'device:hh-1', code: '1Q01' }],
        ranges: [{ head: `1L01/${yy}/`, lastNumber: `1L01/${yy}/90412`, remaining: 9_587, warn: true, says: warning }, { head: `1L02/${yy}/`, lastNumber: `1L02/${yy}/01234`, remaining: 98_765, warn: false }, { head: `1R01/${yy}/`, lastNumber: `1R01/${yy}/00017`, remaining: 99_982, warn: false }] }],
      warnings: [warning],
    };
    const srv = await office({
      '/v1/platform/setup': status, '/v1/receipt-prefixes': { tills: [], needsPrefix: [], storesInBusiness: 1, multiStore: false, needsYearPrefix: [], currentFinancialYear: '' }, '/v1/document-numbers': docnumbers,
      '/v1/purchase/orders/': { order: { status: 'proposed', requisitionedBy: 'u-buyer', totalMinor: 50_000, documentNumber: `PO/${yy}/00003` }, openCommitment: null },
    }, { setupData: { servedBy: 'store_computer', userId: 'u-manager', permissions: ['org.branch.read'] }, buyingData: { buyerId: 'u-buyer', productIds: ['p1'] } });
    stops.push(srv.stop);
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
    stops.push(() => context.close());
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    // ── Buying: the buyer raises an order; the banner says its number, made by head office.
    await page.goto(`${srv.base}/buying.html`, { waitUntil: 'load' });
    await page.waitForFunction(() => (globalThis as unknown as { buyingSession?: { canProposeToCloud: boolean } }).buyingSession?.canProposeToCloud === true, undefined, { timeout: 10_000 });
    await page.click('#tab-po');
    await page.fill('#po-supplier', 'sup-1');
    await page.fill('#po-store', 'store-1');
    await page.fill('#po-product', 'p1');
    await page.fill('#po-qty', '10');
    await page.fill('#po-cost', '50');
    await page.click('#add-po-line');
    await page.click('#raise-po');
    await page.waitForSelector('#banner:not([hidden])', { timeout: 10_000 });
    expect(await page.textContent('#banner')).toContain(`PO/${yy}/00003`);
    await shot(page, 'buying-order-raised.png');

    // ── Store setup: the document-number ranges, each till's code, and the warning from 90,000.
    await page.goto(`${srv.base}/setup.html`, { waitUntil: 'load' });
    await page.waitForSelector('#docnumbers:not([hidden])', { timeout: 10_000 });
    const panel = (await page.textContent('#docnumbers')) ?? '';
    expect(panel).toContain('Document numbers');
    expect(panel).toContain('1L01');
    expect(panel).toContain(`PO/${yy}/00002`);
    expect(panel).toContain(`GRN1/${yy}/00001`);
    expect(await page.textContent('#docnumbers-warnings')).toContain('have reached 90,412');
    if (SHOTS !== undefined) await page.locator('#docnumbers').screenshot({ path: join(SHOTS, 'setup-document-numbers.png') });
    expect(errors).toEqual([]);
  }, 120_000);
});
