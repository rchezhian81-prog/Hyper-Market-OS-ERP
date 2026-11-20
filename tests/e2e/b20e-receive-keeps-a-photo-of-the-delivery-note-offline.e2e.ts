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
import { tinyPng } from '../support/tiny-png';
import { ROLE_CATALOGUE } from '../../services/api/src/roles';

const OWNER_PERMISSIONS = [...(ROLE_CATALOGUE.find((r) => r.id === 'owner') as unknown as { permissions: readonly string[] }).permissions];
let deviceTls: Awaited<ReturnType<typeof sharedDeviceTls>>;

/**
 * **Batch 20e · R6 (M07-FR-04 "evidence attachments" · WF-04) in a real browser on a real store computer with NO head office:**
 * on Receive (office) the person picks a photo of the delivery note (a 640×480 picture, made smaller on this computer and kept
 * as a JPEG), the supplier's challan as a PDF scan, and a damage photo of one item; a file that is not a photo or PDF is refused
 * in words before anything is kept. The delivery is saved first and never waits for its files; the files go on their own queue,
 * one per hand-over, to the store computer's disk, and each says where it has got to ("With the store computer…"). Once the
 * store computer holds a file its bytes leave this screen's own storage. English and Tamil. Synthetic data only.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const SHOTS = process.env['SRE_SCREENSHOT_DIR'];
const KEY = ['b20e', 'receive', 'photo', 'key'].join('-').padEnd(48, '0');
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
    openDeliveries: [{
      poId: 'po-8', number: 'PO-0008', supplierId: 'sup-demo-foods', deliverToLocationId: 'wh-1', grnId: 'grn-po-8',
      ordered: [{ productId: 'p-rice', quantityMinor: 10, unitCostMinor: 50_000, currency: 'INR' }, { productId: 'p-oil', quantityMinor: 12, unitCostMinor: 18_000, currency: 'INR' }],
    }],
  },
}, [{ userId: 'u-mgr', permissions: OWNER_PERMISSIONS }]));

type Logged = { type: string; payload: Record<string, unknown> };

describe.skipIf(!HAVE_BROWSER)('batch 20e — Receive (office) keeps a photo or scan with the delivery, offline', () => {
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

  it('a delivery note photo, a challan PDF and a damage photo go with the saved delivery to the store computer; a wrong file is refused; Tamil', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-b20e-receive-'));
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
    await page.route(`http://127.0.0.1:${edge.screens!.port}/**`, (route) => route.continue({ headers: { ...route.request().headers(), 'x-sre-user': 'u-mgr' } }));
    await page.route(`http://127.0.0.1:${edge.lane!.port}/lane/**`, (route) => route.continue({ headers: { ...route.request().headers(), 'x-sre-user': 'u-mgr' } }));
    await page.goto(`http://127.0.0.1:${edge.screens!.port}/manager`, { waitUntil: 'load' });
    await page.waitForFunction('globalThis.managerSession !== undefined && typeof globalThis.laneWriteBase === "string" && globalThis.receiptAttachments !== undefined', undefined, { timeout: 15_000 });
    await page.click('#tab-receive');
    await says(page, '#receive-files-title', 'Photos and scans with this delivery');
    await page.fill('#grn-number', 'DN-801');
    await page.selectOption('#grn-order', 'po:po-8');
    await says(page, '#receive-lines', 'Groundnut oil 1 L');

    // A text file is not a photo or a scan: refused in words, nothing kept.
    await page.setInputFiles('#receive-file', { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not a photo') });
    await says(page, '#receive-file-status', 'Only a JPEG or PNG photo, or a PDF scan, can be kept.');
    expect(await page.locator('#receive-file-list li').count()).toBe(0);

    // The delivery note: a 640×480 photo, made smaller here and kept as a JPEG.
    await page.setInputFiles('#receive-file', { name: 'delivery-note.png', mimeType: 'image/png', buffer: tinyPng() });
    await says(page, '#receive-file-list', 'Delivery note · delivery-note.jpg');
    // The supplier's challan as a PDF scan.
    await page.selectOption('#receive-file-kind', 'supplier_challan');
    await page.setInputFiles('#receive-file', { name: 'challan-4471.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n% supplier challan 4471\n') });
    await says(page, '#receive-file-list', 'Supplier\'s challan · challan-4471.pdf');
    // A damage photo of the oil.
    await page.selectOption('#receive-file-kind', 'damage_photo');
    expect(await page.isVisible('#receive-file-item')).toBe(true);
    await page.selectOption('#receive-file-item', 'p-oil');
    await page.setInputFiles('#receive-file', { name: 'torn-carton.png', mimeType: 'image/png', buffer: tinyPng(320, 240) });
    await says(page, '#receive-file-list', 'Damage photo · for Groundnut oil 1 L · torn-carton.jpg');
    await says(page, '#receive-file-status', '3 file(s) will go with this delivery when you save it.');
    await page.locator('#receive-files').scrollIntoViewIfNeeded();
    await shot(page, 'b20e-receive-files-picked-en-1366.png');

    // Save: the delivery first, then its three files on their own queue — each handed to the store computer.
    await page.click('#save-receipt');
    await says(page, '#banner-title', 'Delivery saved');
    await says(page, '#banner-text', '3 photo(s) or scan(s) kept with the delivery.');
    await page.click('#banner-ok');
    const logged = async (): Promise<Logged[]> => (await readLog(edge.deviceEventsLog.path)).filter((r) => r.ok).map((r) => JSON.parse(r.ok ? r.record : '{}') as Logged);
    const files = async () => (await logged()).filter((e) => e.type === 'GoodsReceiptAttachmentCaptured').map((e) => e.payload);
    for (let i = 0; i < 80 && (await files()).length < 3; i += 1) await page.waitForTimeout(100);
    const receipt = (await logged()).find((e) => e.type === 'GoodsReceived')!.payload;
    const kept = await files();
    expect(kept.map((f) => [f['kind'], f['mediaType'], f['productId'] ?? null])).toEqual([
      ['delivery_note', 'image/jpeg', null], ['supplier_challan', 'application/pdf', null], ['damage_photo', 'image/jpeg', 'p-oil'],
    ]);
    for (const f of kept) expect(f).toMatchObject({ grnId: receipt['grnId'], receiptNumber: 'DN-801', attachedBy: 'u-mgr', source: 'manager-screen' });
    expect(Number(kept[0]!['bytes'])).toBeLessThanOrEqual(153_600);
    expect(JSON.stringify(receipt)).not.toContain('contentBase64'); // the delivery travels on its own, never carrying a file
    await page.waitForFunction(() => {
      const d = (globalThis as unknown as { document: { querySelectorAll(q: string): ArrayLike<{ dataset: { state?: string } }> } }).document;
      const rows = Array.from(d.querySelectorAll('#receive-files-sent li'));
      return rows.length === 3 && rows.every((r) => r.dataset.state === 'handed_to_box');
    }, undefined, { timeout: 15_000 });
    expect(await page.textContent('#receive-files-sent')).toContain('With the store computer — it will send this to head office');
    // The store computer holds them: their bytes have left this screen's own storage.
    const stored = await page.evaluate(() => (globalThis as unknown as { localStorage: { getItem(k: string): string | null } }).localStorage.getItem('sre.receipt-attachments.outbox.store-1') ?? '');
    expect(stored).toContain('contentKeptOnStoreComputer');
    expect(stored).not.toContain('contentBase64');
    await page.locator('#receive-files-sent').scrollIntoViewIfNeeded();
    await shot(page, 'b20e-receive-files-sent-en-1366.png');

    // Tamil.
    await page.click('#lang');
    await says(page, '#receive-files-title', 'இந்த டெலிவரியுடன் புகைப்படங்கள், ஸ்கேன்கள்');
    await says(page, '#receive-files-sent', 'சேதப் புகைப்படம்');
    await page.locator('#receive-files').scrollIntoViewIfNeeded();
    await shot(page, 'b20e-receive-files-ta-1366.png');
  }, 120_000);
});
