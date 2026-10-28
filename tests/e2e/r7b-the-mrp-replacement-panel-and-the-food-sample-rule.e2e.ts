import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { writeHeldWorkFeeds } from '../../edge/store-edge/src/work-feeds-file';

/**
 * **Round 7 · OB-512 · OB-513 in a real browser.**
 *   OB-512  the Products & prices screen offers to replace only an MRP NOT YET IN FORCE: no reason → refused, nothing asked;
 *           asked → a second person's approval is requested; "Replace it" before the approval → nothing sent; after it, the
 *           publish goes to head office naming the approval, with the replaced date and the reason. English and Tamil.
 *           A stub head office on the same origin plays the approvals engine and records what it was sent.
 *   OB-513  the facilities screen on a REAL store box with NO cloud: a held FOOD batch with no recorded sample says why and
 *           offers no release; a non-food hold says it needs none and may be released. English and Tamil.
 * Synthetic data only.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const WEB_DIR = 'apps/web-erp/web';
const KEY = ['r7b', 'food', 'sample', 'key'].join('-').padEnd(48, '0');
const TENANT = 't-sre';
const inr = (minor: number) => ({ minor, currency: 'INR' });

const says = (page: Page, selector: string, text: string) => page.waitForFunction(([sel, want]) => {
  const node = (globalThis as unknown as { document: { querySelector(s: string): { textContent: string | null } | null } }).document.querySelector(sel!);
  return (node?.textContent ?? '').includes(want!);
}, [selector, text], { timeout: 15_000 });

const CATALOGUE = {
  userId: 'u-buyer', storeId: 'S1', today: '2026-10-28', now: '2026-10-28T10:00:00.000Z', permissions: ['catalogue.pack.publish'], marginFloorBps: 2000,
  categories: [{ categoryId: 'packed', name: 'Packed household', parentId: null, regulated: ['packed'] }],
  products: [{
    productId: 'p-det', tenantId: 't1', sku: 'SKU-DET', name: 'Synthetic detergent', baseUom: 'each', primaryCategoryId: 'packed', taxClass: '34022010', lifecycle: 'active',
    mrpHistory: [{ value: inr(120_00), effectiveFrom: '2026-01-01' }, { value: inr(150_00), effectiveFrom: '2026-11-15' }],
    safety: { netQuantity: '1 kg', packerDetails: 'Synthetic Packers', countryOfOrigin: 'India', consumerCareContact: 'Synthetic Care, 1800-000-0000' },
  }],
  priceEntries: [], costsMinor: {}, barcodes: [], promotions: [],
};

interface Office { asks: Record<string, unknown>[]; publishes: { path: string; body: Record<string, unknown> }[]; status: 'waiting' | 'approved' }
async function startOffice(office: Office): Promise<{ base: string; stop: () => Promise<void> }> {
  const json = (res: import('node:http').ServerResponse, status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const bodyOf = async (req: import('node:http').IncomingMessage): Promise<Record<string, unknown>> => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
  };
  const row = (ask: Record<string, unknown>) => ({
    requestId: 'areq-1', kind: ask['kind'], label: 'MRP replacement', subjectRef: ask['subjectRef'], valueMinor: null, details: ask['details'],
    summary: ask['summary'], reason: ask['reason'], requestedBy: 'u-buyer', requestedAt: '2026-10-28T10:00:00.000Z', status: office.status,
    ...(office.status === 'approved' ? { decidedBy: 'u-acct', decisionReason: 'reprint confirmed', decidedAt: '2026-10-28T10:05:00.000Z' } : {}),
  });
  const server: Server = createServer((req, res) => {
    void (async () => {
      const [path = '/'] = (req.url ?? '/').split('?');
      if (path === '/v1/approvals/requests' && req.method === 'POST') { const ask = await bodyOf(req); office.asks.push(ask); json(res, 201, row(ask)); return; }
      if (path === '/v1/approvals/requests') { json(res, 200, { waitingForMe: [], mine: office.asks.map(row), asAt: '2026-10-28T10:00:00.000Z' }); return; }
      if (path.startsWith('/v1/catalogue/products/') && req.method === 'POST') { office.publishes.push({ path, body: await bodyOf(req) }); json(res, 200, { ok: true }); return; }
      const file = path === '/' ? 'catalogue.html' : path.replace(/^\//, '');
      try {
        let body = (await readFile(join(WEB_DIR, file))).toString('utf8');
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream';
        if (file.endsWith('.html')) body = body.replace('<!--SCREEN-DATA-->', `<script>window.catalogueData = ${JSON.stringify(CATALOGUE).replace(/</g, '\\u003c')};</script>`);
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

describe.skipIf(!HAVE_BROWSER)('OB-512 · OB-513 — the replace-an-MRP panel and the food-sample rule, in a real browser', () => {
  let browser: Browser;
  const dirs: string[] = [];
  const stops: (() => Promise<void>)[] = [];
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 180_000);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => {
    for (const stop of stops.splice(0).reverse()) await stop();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  it('OB-512: only the MRP not yet in force is offered; refused without a reason; asked; nothing sent until approved; then replaced naming the approval', async () => {
    const office: Office = { asks: [], publishes: [], status: 'waiting' };
    const shell = await startOffice(office);
    stops.push(shell.stop);
    const context = await browser.newContext({ viewport: { width: 390, height: 900 } });
    stops.push(() => context.close());
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${shell.base}/`, { waitUntil: 'load' });
    await page.click('#tab-price');
    await page.fill('#price-item', 'SKU-DET');
    await page.waitForSelector('#mrp-replace:not([hidden])');
    await says(page, '#mrp-replace-title', 'Replace an MRP that is not yet in force');
    // Only the MRP from 15 Nov is offered — the one in force since January is not.
    expect(await page.locator('#mrp-replace-date option').allTextContents()).toEqual(['₹150.00 from 2026-11-15']);
    expect(await page.locator('#mrp-replace-ask svg').count()).toBe(1);
    expect(await page.locator('#mrp-replace-save svg').count()).toBe(1);

    await page.fill('#mrp-replace-new', '140');
    await page.click('#mrp-replace-ask');
    await page.waitForSelector('#banner:not([hidden])');
    await says(page, '#banner-text', 'Write why this is needed');
    await page.click('#banner-ok');
    expect(office.asks).toEqual([]);

    await page.fill('#mrp-replace-why', 'the supplier reprinted the pack at ₹140');
    await page.click('#mrp-replace-ask');
    await says(page, '#banner-text', 'the accountant or the owner');
    await page.click('#banner-ok');
    expect(office.asks).toHaveLength(1);
    expect(office.asks[0]).toMatchObject({ kind: 'mrp_replacement', subjectRef: 'product:p-det:mrp:2026-11-15', reason: 'the supplier reprinted the pack at ₹140' });

    // Not yet approved: "Replace it" sends nothing.
    await page.click('#mrp-replace-save');
    await page.waitForSelector('#banner:not([hidden])');
    await says(page, '#banner-text', 'the accountant or the owner');
    await page.click('#banner-ok');
    expect(office.publishes).toEqual([]);

    office.status = 'approved';
    await page.click('#mrp-replace-save');
    await says(page, '#banner-title', 'MRP replaced');
    await says(page, '#banner-text', '₹140.00');
    await page.click('#banner-ok');
    expect(office.publishes).toHaveLength(1);
    expect(office.publishes[0]!.path).toBe('/v1/catalogue/products/p-det/publish');
    expect(office.publishes[0]!.body).toMatchObject({
      approvalId: 'areq-1', mrpReplacement: { effectiveFrom: '2026-11-15', reason: 'the supplier reprinted the pack at ₹140' },
      product: { productId: 'p-det', mrpHistory: [{ value: inr(120_00), effectiveFrom: '2026-01-01' }, { value: inr(140_00), effectiveFrom: '2026-11-15' }] },
    });

    await page.click('#lang');
    await says(page, '#mrp-replace-title', 'இன்னும் நடைமுறைக்கு வராத MRP-ஐ மாற்றுதல்');
    expect(errors).toEqual([]);
  }, 90_000);

  it('OB-513: on the box with no cloud, a held food batch with no sample says why and offers no release; a non-food hold may be released', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-r7b-qh-')); dirs.push(dir);
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, JSON.stringify({
      version: 1, lossPreventionRules: [], policies: { tradingDayCutoff: '02:00', storeId: 'S1', branchId: 'S1' },
      facilitiesPolicy: { userId: 'u-qc', permissions: ['facilities.overdue.read', 'quality.hold.release'] },
    }), 'utf8');
    const asAt = new Date(Date.now() - 10 * 60_000).toISOString();
    await writeHeldWorkFeeds(dir, TENANT, {
      'quality-holds': { receivedAt: asAt, feed: { name: 'quality-holds', asAt, body: { holds: [
        { batchId: 'B-CURD', productId: 'CURD', reason: 'chiller ran warm', heldAt: asAt, heldBy: 'u-owner', samples: [], sampleRule: { required: true, because: 'food' } },
        { batchId: 'B-DET', productId: 'DETERGENT', reason: 'damp cartons', heldAt: asAt, heldBy: 'u-owner', samples: [], sampleRule: { required: false, because: 'not_food' } },
      ] } } },
    });
    const edge: EdgeProcess = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: TENANT, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
      EDGE_LANE_PORT: '0', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_PACK_FILE: packFile,
    }, () => {}))!;
    stops.push(() => edge.stop());
    const context = await browser.newContext({ viewport: { width: 390, height: 900 } });
    stops.push(() => context.close());
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${edge.screens!.port}/facilities/`, { waitUntil: 'load' });
    await page.waitForSelector('#qh:not([hidden])');
    const row = (b: string) => `#qh-rows li[data-batch="${b}"]`;
    await says(page, `${row('B-CURD')} .qh-sample-rule`, 'Food item');
    await says(page, `${row('B-CURD')} .qh-blocked`, 'No sample is recorded yet');
    expect(await page.locator(`${row('B-CURD')} button.qh-release`).count()).toBe(0);
    await says(page, `${row('B-DET')} .qh-sample-rule`, 'Not a food item');
    expect(await page.locator(`${row('B-DET')} button.qh-release`).count()).toBe(1);

    await page.fill(`${row('B-DET')} textarea.qh-notes`, 'cartons dried; contents sealed and fine');
    await page.click(`${row('B-DET')} button.qh-release`);
    await says(page, '#qh-result-text', 'Release saved on this screen');

    await page.click('#lang');
    await says(page, `${row('B-CURD')} .qh-sample-rule`, 'உணவுப் பொருள்');
    expect(errors).toEqual([]);
  }, 90_000);
});
