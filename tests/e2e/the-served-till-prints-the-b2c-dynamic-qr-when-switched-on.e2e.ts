import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync, mkdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { writeSignedPack } from '../../edge/store-edge/src/signed-pack-file';
import { hmacSigner, publishPack } from '../../services/catalogue/src/index';
import type { CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';
import { prepareTillBox, signInThroughScreen } from '../support/till-operator';

/**
 * **A22 (OB-326, built switched OFF) — the served till in real trading, in a real Chromium against a real store computer
 * with no head office: the B2C dynamic QR on the printed tax invoice.**
 *
 *   • OFF (the default): the printed bill has no QR and the screen says nothing about one;
 *   • ON in the store pack with the UPI ID, bank account and IFSC: the printed bill carries the QR image (drawn from the
 *     bill itself, nothing fetched), with its caption in English, and in Tamil after the language button; the shop's
 *     FSSAI licence number from the same pack is printed too (B10, now told to the served till);
 *   • ON with a detail missing: no QR on the paper; the screen's bill says which detail is NOT SET.
 * Screenshots only when SRE_SHOTS names a directory. Skips where no browser binary is present.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const SHOTS = process.env['SRE_SHOTS'];
const KEY = ['served', 'till', 'b2c', 'qr', 'key'].join('-').padEnd(48, '0');
const SHOP = { legalName: 'SRE Hyper Market Private Limited', gstin: '33ABCDE1234F1Z5', placeOfBusiness: ['12 Main Road', 'Tiruppur 641601, Tamil Nadu'] };
const DAL = '8901234567890';
const QR_ON = { on: true, upiId: 'srehyper@okaxis', bankAccountNo: '123456789012', bankIfsc: 'HDFC0001234' };
const packWith = (extra: Record<string, unknown>): Record<string, unknown> => ({
  version: 1,
  policies: {
    storeId: 'store-1', branchId: 'store-1', branchName: 'Main', tradingDayCutoff: '02:00', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000,
    handoverToleranceMinor: 10_000, cashVarianceToleranceMinor: 10_000, privacySlaDays: 15, warehouseId: 'wh-1', taxInvoice: SHOP, ...extra,
  },
  servicePolicy: { returnWindowDays: 30, approvalThresholdMinor: 1_000_000, noReceiptCapMinor: 0, agentAuthorityMinor: 0, compensationCapMinor: 0 },
  lossPreventionRules: [],
});
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
const PRINT_RECORDER = `
  window.prints = [];
  window.print = () => {
    const area = document.getElementById('print-area');
    const qr = area.querySelector('.pr-qr img');
    window.prints.push({ lang: area.lang, text: area.textContent, qrSrc: qr ? qr.getAttribute('src') : null, qrAlt: qr ? qr.getAttribute('alt') : null,
      qrBox: qr ? (() => { const r = qr.getBoundingClientRect(); return { w: r.width, h: r.height }; })() : null });
  };`;
interface PosWindow {
  readonly posSession?: { hasCatalogue(): boolean; basket(): unknown[] };
  readonly prints?: { lang: string; text: string; qrSrc: string | null; qrAlt: string | null; qrBox: { w: number; h: number } | null }[];
}

describe.skipIf(!HAVE_BROWSER)('A22 — the served till prints the B2C dynamic QR only when switched on', () => {
  let browser: Browser;
  const dirs: string[] = [];
  const stops: (() => Promise<void>)[] = [];
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'pos'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 90_000);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => {
    for (const stop of stops.splice(0).reverse()) await stop();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  const till = async (extra: Record<string, unknown>): Promise<{ page: Page; edge: EdgeProcess; requests: string[] }> => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-served-till-qr-'));
    dirs.push(dir);
    await writeSignedPack(dir, signedCatalogue());
    const edge: EdgeProcess = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0', EDGE_LANE_ID: 'lane-1',
      EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_REAL_TRADING: '1',
      ...await prepareTillBox({ dir, key: KEY, pack: packWith(extra), people: [{ userId: 'u-lanecash', displayName: 'Lane Cashier' }] }),
    }, () => {}))!;
    stops.push(() => edge.stop());
    const context = await browser.newContext();
    stops.push(() => context.close());
    const page = await context.newPage();
    page.setDefaultTimeout(8_000);
    const requests: string[] = [];
    page.on('request', (r) => { requests.push(r.url()); });
    await page.addInitScript(PRINT_RECORDER);
    await page.goto(`http://127.0.0.1:${edge.screens!.port}/pos/`, { waitUntil: 'load' });
    await page.waitForFunction(() => (globalThis as unknown as PosWindow).posSession?.hasCatalogue() === true, undefined, { timeout: 15_000 });
    await signInThroughScreen(page);
    return { page, edge, requests };
  };
  const sellOne = async (page: Page): Promise<void> => {
    await page.keyboard.type(DAL);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => (globalThis as unknown as PosWindow).posSession!.basket().length === 1);
    await page.click('#tender');
    await page.waitForSelector('#pay-kinds button');
    await page.click('#pay-kinds button:first-child'); // Cash
    await page.waitForSelector('#quick button');
    await page.click('#quick button:first-child'); // Exact
    await page.waitForSelector('#refusal:not([hidden])', { timeout: 15_000 });
  };
  const prints = (page: Page): Promise<NonNullable<PosWindow['prints']>> => page.evaluate(() => (globalThis as unknown as PosWindow).prints ?? []);
  const shot = async (page: Page, name: string): Promise<void> => {
    if (SHOTS === undefined) return;
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, `${name}.png`) });
  };

  it('OFF: no QR on the paper, nothing said', async () => {
    const { page } = await till({});
    await sellOne(page);
    expect(await page.textContent('#refusal-receipt')).not.toContain('QR');
    await page.click('#print-bill');
    const [p] = await prints(page);
    expect(p?.qrSrc).toBeNull();
  });

  it('ON with every detail: the QR image prints from the bill itself, with its caption — English and Tamil; the FSSAI number too', async () => {
    const { page, requests } = await till({ b2cDynamicQr: QR_ON, fssaiLicence: { number: '12419999000123', validUntil: '2099-12-31' } });
    await sellOne(page);
    expect(await page.textContent('#refusal-receipt')).toContain('[QR] Scan to pay this bill by UPI');
    const before = requests.length;
    await page.click('#print-bill');
    const [en] = await prints(page);
    expect(en?.qrSrc?.startsWith('data:image/svg+xml')).toBe(true);
    expect(decodeURIComponent(en!.qrSrc!.split(',')[1]!)).toContain('<svg');
    expect(en?.qrAlt).toBe('Scan to pay this bill by UPI');
    expect(en?.text).toContain('FSSAI Lic. No. 12419999000123');
    expect(requests.slice(before).filter((u) => !u.startsWith('data:'))).toEqual([]); // nothing fetched to print it
    await page.emulateMedia({ media: 'print' });
    await page.evaluate(() => { (globalThis as unknown as { print(): void }).print(); });
    const sized = (await prints(page))[1]!;
    expect(sized.qrBox!.w).toBeGreaterThan(100); // 34 mm ≈ 128 CSS px — big enough for a phone camera
    expect(Math.round(sized.qrBox!.w)).toBe(Math.round(sized.qrBox!.h));
    await page.emulateMedia({ media: 'screen' });
    await shot(page, 'till-b2c-qr-bill');
    await page.click('#refusal-ok');
    await page.click('#lang');
    await sellOne(page);
    await page.click('#print-bill');
    const ta = (await prints(page)).pop()!;
    expect(ta.lang).toBe('ta');
    expect(ta.qrAlt).toBe('இந்த பில்லை UPI மூலம் செலுத்த ஸ்கேன் செய்யவும்');
  });

  it('ON with the bank account missing: no QR on the paper; the screen\'s bill names what is not set', async () => {
    const { page } = await till({ b2cDynamicQr: { on: true, upiId: 'srehyper@okaxis', bankIfsc: 'HDFC0001234' } });
    await sellOne(page);
    expect(await page.textContent('#refusal-receipt')).toContain('UPI QR switched on but NOT SET: bank account number — no QR printed. Tell the manager.');
    await page.click('#print-bill');
    const [p] = await prints(page);
    expect(p?.qrSrc).toBeNull();
    expect(p?.text).not.toContain('NOT SET'); // never on the customer's paper
  });
});
