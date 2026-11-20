import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { withTillPeople } from '../support/till-operator';
import { sharedDeviceTls, trustingBrowserArgs } from '../support/box-tls';
import { apiHarness } from '../support/api-harness';
import { tinyPng } from '../support/tiny-png';
import { sha256Hex } from '../../packages/fulfilment/src/sha256';

let deviceTls: Awaited<ReturnType<typeof sharedDeviceTls>>;

/**
 * **Batch 20e · R6 (M07-FR-04 · WF-04 · OB-907) in a real browser, Goods receipt review on the store computer answered by a REAL
 * head office (the in-memory API, the person's own calls routed to it):** a delivery whose damage photo came from the store shows
 * "Photos and scans (1)"; opened, it shows a small picture of the photo, who attached it and from where, and Open opens the full
 * file in its own tab. The manager adds the supplier's challan (a PDF) at head office, then marks it attached by mistake with a
 * reason — it stays listed, struck through, with who, when and why. A mistake with no reason is refused in words. Head office's
 * list then counts the files. English and Tamil. Synthetic data only.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const SHOTS = process.env['SRE_SCREENSHOT_DIR'];
const KEY = ['b20e', 'grn', 'files', 'key'].join('-').padEnd(48, '0');
const AT = '2026-11-20T05:00:00.000Z';
const PACK = JSON.stringify(withTillPeople({
  version: 1,
  policies: { tradingDayCutoff: '02:00', storeId: 'store-1', branchId: 'store-1', branchName: 'Main', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, privacySlaDays: 15, warehouseId: 'store-1' },
  managerPolicy: { userId: 'u-mgr', approvalLimitMinor: 500_000 },
  goodsReceiptPolicy: { userId: 'u-mgr', permissions: ['inventory.availability.read', 'inventory.goodsreceipt.read', 'inventory.movement.append'] },
  lossPreventionRules: [],
}, [{ userId: 'u-mgr', permissions: ['inventory.availability.read', 'inventory.goodsreceipt.read', 'inventory.movement.append'] }]));

describe.skipIf(!HAVE_BROWSER)('batch 20e — Goods receipt review shows a delivery\'s photos and scans', () => {
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
  const says = (page: Page, selector: string, text: string) => page.waitForFunction(([sel, want]) => {
    const node = (globalThis as unknown as { document: { querySelector(s: string): { textContent: string | null } | null } }).document.querySelector(sel!);
    return (node?.textContent ?? '').includes(want!);
  }, [selector, text], { timeout: 15_000 });

  it('a photo from the store with its picture and Open; a challan added at head office then marked attached by mistake (kept); Tamil', async () => {
    // ── head office: the store, a delivery booked at the store, and its damage photo, both carried by the store computer ──
    const h = apiHarness({});
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-mgr', 'store_manager', 'all');
    await h.provisionRole(T, 'u-box', 'store_computer', ['store-1']);
    let n = 0;
    const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, branchId?: string) =>
      h.request({ method, path, userId, tenantId: T, ...(branchId === undefined ? {} : { branchId }), ...(method === 'GET' ? {} : { idempotencyKey: `e2e-${n += 1}` }), ...(body === undefined ? {} : { body }) });
    for (const [id, body] of [['C-1', { kind: 'company', name: 'Synthetic Retail' }], ['store-1', { kind: 'branch', name: 'Store 1', parentId: 'C-1', companyId: 'C-1' }]] as const) {
      expect((await call('POST', `/v1/org/nodes/${id}`, 'u-owner', body)).status).toBe(201);
    }
    expect((await call('POST', '/v1/inventory/goods-receipt/grn-dn-77/synced', 'u-box', {
      grnId: 'grn-dn-77', number: 'DN-77', poId: null, warehouseId: 'store-1', receivedBy: 'u-mgr', receivedAt: AT,
      lines: [{ productId: 'p-oil', quantityMinor: 12, uom: 'ea', batchId: null }], storeId: 'store-1', source: 'manager-screen',
    }, 'store-1')).status).toBeLessThan(300);
    const photo = tinyPng(320, 240);
    expect((await call('POST', '/v1/inventory/goods-receipt/grn-dn-77/attachments/ra-photo-1/synced', 'u-box', {
      attachmentId: 'ra-photo-1', grnId: 'grn-dn-77', receiptNumber: 'DN-77', warehouseId: 'store-1', storeId: 'store-1', kind: 'damage_photo', productId: 'p-oil',
      fileName: 'torn-carton.png', mediaType: 'image/png', bytes: photo.length, sha256: sha256Hex(photo), contentBase64: photo.toString('base64'),
      attachedBy: 'u-mgr', attachedAt: AT, source: 'manager-screen',
    }, 'store-1')).status).toBe(201);

    // ── the store computer serves the page; the person's own calls to head office are answered by head office ──
    const dir = await mkdtemp(join(tmpdir(), 'sre-b20e-grn-'));
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
    const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, deviceScaleFactor: 1, serviceWorkers: 'block' });
    stops.push(() => context.close());
    const page = await context.newPage();
    await page.route(`http://127.0.0.1:${edge.screens!.port}/**`, async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      if (url.pathname.startsWith('/v1/')) {
        const body = req.postData();
        const res = await h.request({
          method: req.method() as 'GET' | 'POST', path: url.pathname, userId: 'u-mgr', tenantId: T, query: Object.fromEntries(url.searchParams),
          ...(req.method() === 'GET' ? {} : { idempotencyKey: req.headers()['idempotency-key'] ?? `k-${randomUUID()}` }),
          ...(body === null ? {} : { body: JSON.parse(body) as unknown }),
        });
        return route.fulfill({ status: res.status, contentType: 'application/json', body: JSON.stringify(res.body) });
      }
      return route.continue({ headers: { ...req.headers(), 'x-sre-user': 'u-mgr' } });
    });
    await page.goto(`http://127.0.0.1:${edge.screens!.port}/goods-receipt/`, { waitUntil: 'load' });
    await says(page, '#rows', 'Photos and scans (1)');

    // Opened: the picture, the words, Open.
    await page.click('#rows .grn-files-btn');
    await page.waitForSelector('#rows .grn-file .thumb img');
    await says(page, '#rows .grn-files', 'Damage photo · for p-oil · torn-carton.png');
    await says(page, '#rows .grn-files', 'Attached by u-mgr');
    await says(page, '#rows .grn-files', 'from the store computer');
    const popup = page.waitForEvent('popup');
    await page.click('#rows .grn-file-open');
    expect((await popup).url()).toMatch(/^blob:/);

    // A challan added at head office (a PDF scan).
    await page.selectOption('#rows .grn-file-kind', 'supplier_challan');
    await page.setInputFiles('#rows .grn-file-input', { name: 'challan-4471.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n% challan 4471\n') });
    await says(page, '#rows .grn-files-status', 'Kept with the delivery.');
    expect(await page.locator('#rows .grn-file').count()).toBe(2);
    await shot(page, 'b20e-goods-receipt-files-en-1366.png');

    // Attached by mistake: a reason is needed; then it stays, struck through, with who and why.
    const challan = page.locator('#rows .grn-file[data-kind="supplier_challan"]');
    await challan.locator('.grn-file-mistake-btn').click();
    await says(page, '#rows .grn-files-status', 'Type why it was attached by mistake');
    await challan.locator('.grn-file-reason').fill('challan of another delivery');
    await challan.locator('.grn-file-mistake-btn').click();
    await says(page, '#rows .grn-files-status', 'Marked attached by mistake. The file stays kept with the delivery.');
    const marked = page.locator('#rows .grn-file[data-mistake="true"]');
    expect(await marked.count()).toBe(1);
    expect(await marked.locator('s.grn-file-title').textContent()).toContain('challan-4471.pdf');
    expect(await marked.textContent()).toContain('Marked attached by mistake by u-mgr');
    expect(await marked.textContent()).toContain('challan of another delivery');
    await shot(page, 'b20e-goods-receipt-files-mistake-en-1366.png');

    // Head office keeps both and counts them.
    const files = (await call('GET', '/v1/inventory/goods-receipt/grn-dn-77/attachments', 'u-owner')).body as { kept: number; mistaken: number };
    expect([files.kept, files.mistaken]).toEqual([1, 1]);

    // Tamil.
    await page.click('#lang');
    await says(page, '#rows', 'புகைப்படங்கள், ஸ்கேன்கள்');
    await says(page, '#rows .grn-files', 'சேதப் புகைப்படம்');
    await shot(page, 'b20e-goods-receipt-files-ta-1366.png');
  }, 120_000);
});
