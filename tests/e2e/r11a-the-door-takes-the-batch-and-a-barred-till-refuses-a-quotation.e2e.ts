import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { prepareTillBox, signInThroughScreen } from '../support/till-operator';
import { TEST_IDP } from '../support/api-harness';

/**
 * **Round 11 · R11-A — in a real Chromium.**
 *   • OB-504 — the warehouse handheld at the DSD door, offline: a PACKED product scanned with no month of manufacture is
 *     refused in plain words (English and Tamil) and kept off the delivery; the worker scans the batch label and keys the
 *     expiry and the month on the number pad (no text box); the scan is then taken, and the ONE record queued at close
 *     carries the batch, the expiry and the month.
 *   • OB-605 — a BATCH-TRACKED item scanned with no batch, then with no expiry, is refused in plain words (English and Tamil).
 *   • OB-604 — the same product in two batches: the line shows each batch's share and what is held; the record keeps each scan's batch.
 *   • OB-501 — a served till on a build the store pack says is too old: More → "Quotation number" → the digits → refused in
 *     plain words BEFORE the store computer is asked (head office is never called to convert it), English and Tamil.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const WAREHOUSE_WEB = 'apps/warehouse-app/web';

const said = (page: Page, selector: string, pattern: RegExp): Promise<unknown> => page.waitForFunction(
  ([sel, src]) => new RegExp(src!).test((globalThis as unknown as { document: { querySelector(s: string): { textContent: string | null } | null } }).document.querySelector(sel!)?.textContent ?? ''),
  [selector, pattern.source], { timeout: 15_000 },
).catch(async (e: unknown) => {
  const seen = await page.evaluate((sel) => (globalThis as unknown as { document: { querySelector(s: string): { textContent: string | null } | null } }).document.querySelector(sel)?.textContent ?? '(none)', selector);
  throw new Error(`${selector} never said ${pattern.source}; it says: ${JSON.stringify(seen)} (${String(e)})`);
});

async function warehouseShell(data: Record<string, unknown>): Promise<{ base: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const [path = '/'] = (req.url ?? '/').split('?');
      const file = path === '/' ? 'index.html' : path.replace(/^\//, '');
      try {
        let body = (await readFile(join(WAREHOUSE_WEB, file))).toString('utf8');
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream';
        if (file.endsWith('.html')) body = body.replace('<!--SCREEN-DATA-->', `<script>window.warehouseData = ${JSON.stringify(data).replace(/</g, '\\u003c')};</script>`);
        res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
        res.end(body);
      } catch {
        res.writeHead(404); res.end('not found');
      }
    })();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      resolve({ base: `http://127.0.0.1:${port}`, stop: () => new Promise((done) => { server.close(() => { done(); }); server.closeAllConnections(); }) });
    });
  });
}

interface WarehouseGlobals { dsdSession?: unknown; warehouseOutbox?: { unsentCount(): number; all(): { event: { type: string; payload: unknown } }[] } }

describe.skipIf(!HAVE_BROWSER)('R11-A: the DSD door takes the batch (OB-504); a barred till refuses a quotation first (OB-501)', () => {
  let browser: Browser;
  const stops: (() => Promise<void>)[] = [];
  const dirs: string[] = [];
  const savedFetch = globalThis.fetch;
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'warehouse-app'], { stdio: 'ignore' });
    execFileSync('node', ['scripts/build-app.mjs', 'pos'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 120_000);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => {
    globalThis.fetch = savedFetch;
    for (const stop of stops.splice(0).reverse()) await stop();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  it('OB-504 · OB-605 · OB-604: packed and batch-tracked items are refused without their batch facts (English and Tamil); two batches are shown split; the record carries them', async () => {
    const srv = await warehouseShell({
      assignmentId: 'A-DSD', workerId: 'u-recv', storeId: 'S-A', bins: [],
      barcodes: [{ barcode: '890DET', productId: 'p-det', level: 'unit' }, { barcode: '890BRM', productId: 'p-brm', level: 'unit' }, { barcode: '890MILK', productId: 'p-milk', level: 'unit' }],
      packs: [
        { productId: 'p-det', baseUom: 'ea', levels: [{ level: 'unit', containsMinor: 1, barcode: '890DET' }] },
        { productId: 'p-brm', baseUom: 'ea', levels: [{ level: 'unit', containsMinor: 1, barcode: '890BRM' }] },
      ],
      // The store computer's word (the store pack's `packedProductIds`): the detergent is a packed product.
      packedProductIds: ['p-det'],
      // OB-605: the store computer's catalogue marks the milk batch-tracked.
      batchTrackedProductIds: ['p-milk'],
      openDeliveries: [{ poId: 'po-det', number: 'PO-0009', supplierId: 'sup-det', grnId: 'grn-det', ordered: [{ productId: 'p-det', quantityMinor: 2, unitCost: { minor: 9_000, currency: 'INR' } }, { productId: 'p-brm', quantityMinor: 1, unitCost: { minor: 4_000, currency: 'INR' } }, { productId: 'p-milk', quantityMinor: 1, unitCost: { minor: 3_000, currency: 'INR' } }] }],
      goodsIn: [],
    });
    stops.push(srv.stop);
    const context = await browser.newContext();
    stops.push(() => context.close());
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const scan = async (code: string) => {
      await page.waitForSelector('#scan:not([hidden])', { timeout: 10_000 });
      await page.keyboard.type(code);
      await page.keyboard.press('Enter');
    };
    const pad = async (digits: string) => {
      await page.waitForSelector('#qty:not([hidden])');
      await page.click('#qty-keypad button:text-is("C")');
      for (const d of digits) await page.click(`#qty-keypad button:text-is("${d}")`);
      await page.click('#qty-ok');
    };
    const banner = async (title: RegExp) => { await said(page, '#banner-title', title); await page.click('#banner-ok'); };

    await page.goto(`${srv.base}/`, { waitUntil: 'load' });
    await page.waitForFunction(() => (globalThis as unknown as WarehouseGlobals).dsdSession != null, undefined, { timeout: 10_000 });
    await context.setOffline(true); // the van is at the door with the wifi down
    expect(await page.locator('input').count()).toBe(0); // still no text box on the handheld
    await page.click('#dsd-open');
    await expect.poll(() => page.locator('#dsd').isVisible()).toBe(true);
    await page.click('#dsd-choices button[data-choice="po:po-det"]');
    for (const d of '9876543210') await page.click(`#dsd-driver-keypad button:text-is("${d}")`);
    await page.click('#dsd-driver');
    await page.click('#dsd-start');
    await banner(/^Check-in started$/);
    await expect.poll(() => page.locator('#dsd-work-panel').isVisible()).toBe(true);
    await said(page, '#dsd-mfg', /^Month of manufacture \(packed goods\): not entered$/);
    await said(page, '#dsd-batch', /^Batch: not scanned$/);
    expect(await page.locator('#dsd-batch [data-sre-icon], #dsd-batch svg').count()).toBeGreaterThan(0); // an icon beside the word

    // A packed item with no month of manufacture: refused, in plain words, and not on the delivery.
    await page.click('#dsd-scan');
    await scan('890DET');
    await banner(/^Packed goods — enter the month of manufacture first$/);
    await said(page, '#dsd-lines [data-product="p-det"] .qty', /scanned 0/);
    // The loose broom needs none.
    await page.click('#dsd-scan');
    await scan('890BRM');
    await banner(/^Scanned$/);
    // Tamil: the same refusal in the worker's language.
    await page.evaluate(() => { (globalThis as unknown as { document: { getElementById(i: string): { click(): void } } }).document.getElementById('lang').click(); });
    await said(page, '#dsd-mfg', /^தயாரிப்பு மாதம் \(பொதி செய்த பொருள்\): உள்ளிடப்படவில்லை$/);
    await page.click('#dsd-scan');
    await scan('890DET');
    await banner(/^பொதி செய்த பொருள் — முதலில் தயாரிப்பு மாதத்தை உள்ளிடவும்$/);
    // OB-605: a batch-tracked item with no batch — refused, in Tamil too.
    await page.click('#dsd-scan');
    await scan('890MILK');
    await banner(/^தொகுதி கண்காணிக்கும் பொருள் — முதலில் தொகுதி எண்ணை ஸ்கேன் செய்யவும்$/);
    await page.evaluate(() => { (globalThis as unknown as { document: { getElementById(i: string): { click(): void } } }).document.getElementById('lang').click(); });
    await page.click('#dsd-scan');
    await scan('890MILK');
    await banner(/^Batch-tracked — scan the batch number first$/);

    // The batch label is scanned; the expiry and the month are keyed on the pad.
    await page.click('#dsd-batch');
    await scan('DETB2605');
    await said(page, '#dsd-batch', /^Batch: DETB2605$/);
    // OB-605: with a batch but no expiry, the batch-tracked milk is still refused.
    await page.click('#dsd-scan');
    await scan('890MILK');
    await banner(/^Batch-tracked — enter the expiry date first$/);
    await said(page, '#dsd-lines [data-product="p-milk"] .qty', /scanned 0/);
    await page.click('#dsd-expiry');
    await pad('20270230'); // not a date
    await said(page, '#banner-title', /^The expiry date is not readable$/);
    await page.click('#banner-ok');
    await page.click('#dsd-expiry');
    await pad('20270131');
    await said(page, '#dsd-expiry', /^Expiry: 2027-01-31$/);
    await page.click('#dsd-mfg');
    await pad('202605');
    await said(page, '#dsd-mfg', /^Month of manufacture \(packed goods\): 2026-05$/);
    for (let i = 0; i < 2; i += 1) {
      await page.click('#dsd-scan');
      await scan('890DET');
      await banner(/^Scanned$/);
    }
    await said(page, '#dsd-lines [data-product="p-det"] .qty', /scanned 2/);
    // OB-604: a second batch of the same product — the line shows each batch's share; the one beyond the order is held.
    await page.click('#dsd-batch');
    await scan('DETB2606');
    await page.click('#dsd-scan');
    await scan('890DET');
    await banner(/^Scanned$/);
    await said(page, '#dsd-lines [data-product="p-det"] .batches', /^Batch DETB2605 \(2027-01-31\): 2 · Batch DETB2606 \(2027-01-31\): 1 · held for a second person 1$/);

    await page.click('#dsd-note');
    await scan('NOTE-DET-1');
    await page.click('#dsd-close');
    await banner(/^Delivery closed — note signed$/);
    const queued = await page.evaluate(() => (globalThis as unknown as WarehouseGlobals).warehouseOutbox!.all().map((i) => ({ type: i.event.type, payload: i.event.payload as { scans: Record<string, unknown>[] } })));
    expect(queued).toHaveLength(1);
    expect(queued[0]!.type).toBe('DsdCheckInClosed');
    const scans = queued[0]!.payload.scans;
    expect(scans.filter((s) => s['productId'] === 'p-det')).toEqual([
      expect.objectContaining({ batchId: 'DETB2605', expiry: '2027-01-31', manufacturedOn: '2026-05', quantityMinor: 1 }),
      expect.objectContaining({ batchId: 'DETB2605', expiry: '2027-01-31', manufacturedOn: '2026-05', quantityMinor: 1 }),
      expect.objectContaining({ batchId: 'DETB2606', expiry: '2027-01-31', manufacturedOn: '2026-05', quantityMinor: 1 }),
    ]);
    expect(scans.some((s) => s['productId'] === 'p-milk')).toBe(false); // refused scans never travel
    expect(scans.find((s) => s['productId'] === 'p-brm')).not.toHaveProperty('manufacturedOn');
    expect(errors).toEqual([]);
  }, 90_000);

  it('OB-501: a till on a too-old build refuses the quotation number before the store computer is asked — English and Tamil', async () => {
    const KEY = ['r11a', 'barred', 'quote', 'key'].join('-').padEnd(48, '0');
    const BOX_TOKEN = TEST_IDP.issue({ sub: 'u-box', tenantId: 't-sre', branchId: 'store-1' });
    const PACK = {
      version: 1,
      policies: { storeId: 'store-1', branchId: 'store-1', branchName: 'Main', tradingDayCutoff: '02:00', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, cashVarianceToleranceMinor: 10_000, privacySlaDays: 15, warehouseId: 'wh-1' },
      lossPreventionRules: [],
      products: [{ productId: 'P1', name: 'Toor dal 1kg', categoryId: 'grocery', unitPriceMinor: 48_000, uom: 'ea', barcodes: ['8901234567890'], availableMinor: 100, taxBps: 0, status: 'active' }],
      // OB-501: head office's minimum is far above this build — the till may finish a bill, never start one.
      versionPolicy: { currentVersion: '99.0.0', previousVersion: '98.0.0', minimumSupportedVersion: '98.0.0' },
    };
    const converts: string[] = [];
    globalThis.fetch = (async (url: string | URL, init?: RequestInit): Promise<Response> => {
      const u = String(url);
      if (u.startsWith('http://127.0.0.1:')) return savedFetch(url, init);
      if (u.includes('/v1/pos/quotations/')) converts.push(u);
      return new Response('{}', { status: 503 });
    }) as unknown as typeof globalThis.fetch;
    const dir = await mkdtemp(join(tmpdir(), 'sre-r11a-barred-quote-'));
    dirs.push(dir);
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, JSON.stringify(PACK), 'utf8');
    const lines: string[] = [];
    const edge: EdgeProcess | undefined = await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY, EDGE_PACK_FILE: packFile,
      EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0', EDGE_LANE_ID: 'lane-1', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps',
      CLOUD_API_URL: 'https://cloud.example.test', CLOUD_API_TOKEN: BOX_TOKEN,
      ...await prepareTillBox({ dir, key: KEY, pack: PACK as unknown as Record<string, unknown> }),
    }, (line: string) => { lines.push(line); });
    if (edge === undefined) throw new Error(lines.join('\n'));
    stops.push(() => edge.stop());
    const context = await browser.newContext();
    stops.push(() => context.close());
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${edge.screens!.port}/pos/`, { waitUntil: 'load' });
    await page.waitForFunction(() => (globalThis as unknown as { posSession?: { hasCatalogue(): boolean } }).posSession?.hasCatalogue() === true, undefined, { timeout: 15_000 });
    await signInThroughScreen(page);

    const ringQuotation = async (option: string): Promise<void> => {
      await page.click('#more');
      await page.waitForSelector('#pay:not([hidden])');
      await page.click(`#pay-kinds button:text-is("${option}")`);
      await page.waitForSelector('#sheet:not([hidden])');
      for (const digit of '48151623') await page.click(`#keypad button:text-is("${digit}")`);
      await page.click('#sheet-ok');
    };
    await ringQuotation('Quotation number');
    await said(page, '#refusal-text', /a new bill cannot be started until the till is updated.* The quotation was not used; it can be rung up on an updated till\.$/);
    await page.click('#refusal-ok');
    expect(converts).toEqual([]); // head office was never asked to convert it
    expect(await page.evaluate(() => (globalThis as unknown as { posSession: { basket(): unknown[] } }).posSession.basket().length)).toBe(0);

    await page.click('#lang');
    await ringQuotation('விலைப்புள்ளி எண்');
    await said(page, '#refusal-text', /விலைப்புள்ளி பயன்படுத்தப்படவில்லை; புதுப்பிக்கப்பட்ட பில்லிங்கில் சேர்க்கலாம்\.$/);
    await page.click('#refusal-ok');
    expect(converts).toEqual([]);
    expect(errors).toEqual([]);
  }, 90_000);
});
