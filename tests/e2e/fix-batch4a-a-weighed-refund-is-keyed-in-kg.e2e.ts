import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { prepareTillBox, signInThroughScreen } from '../support/till-operator';

/**
 * BROWSER. **Fix batch 4a — D-059: a weighed item comes back in kg, keyed with the point (M13-FR-02 · OB-31).** On the
 * served till, More → Refund → the bill → the weighed tomato: the how-much keypad takes kg WITH a decimal point ("0.5" is
 * 500 g), never grams; the refund is valued on the 500 g (₹20.00 at ₹40/kg). An amount the unit cannot hold (a fourth
 * decimal) or more than can come back keeps the panel open and says why. A counted line keeps its whole-number keypad
 * (with C, no point). Skips where no browser binary is present. Synthetic data only.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['batch', 'four', 'kg', 'refund', 'key'].join('-').padEnd(48, '0');
const day = (offset: number): string => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

const PACK = {
  version: 1,
  policies: { storeId: 'S1', branchId: 'S1', branchName: 'Demo store', warehouseId: 'S1-BACK', tradingDayCutoff: '00:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 0 },
  servicePolicy: { returnWindowDays: 30, approvalThresholdMinor: 0, noReceiptCapMinor: 100_000, agentAuthorityMinor: 0, compensationCapMinor: 0 },
  products: [
    { productId: 'P-CURD', name: 'Curd 400g', categoryId: 'dairy', unitPriceMinor: 4_500, unitCostMinor: 3_200, uom: 'ea', barcodes: ['8900000000159'], availableMinor: 20, taxBps: 0, status: 'active' },
    { productId: 'P-BISC', name: 'Biscuits', categoryId: 'food', unitPriceMinor: 1_000, unitCostMinor: 700, uom: 'ea', barcodes: ['8900000000166'], availableMinor: 20, taxBps: 1_800, status: 'active' },
    { productId: 'P-TOM', name: 'Tomato (loose)', categoryId: 'veg', unitPriceMinor: 4_000, unitCostMinor: 2_500, uom: 'kg', barcodes: [], availableMinor: 50_000, taxBps: 0, status: 'active' },
  ],
  lossPreventionRules: [],
  // A stamped scale on this lane, so a weighed line may be sold here (B14).
  weighingScales: [{ assetId: 'SCALE-L1', laneIds: ['lane-1'], approvalNo: 'LM/TN/APP/0042', capacityGrams: 30_000, lastStampedOn: day(-30), reverificationDueOn: day(300) }],
};

interface PosWindow {
  readonly posSession?: {
    scan(item: { productId: string; description: string; unitPriceMinor: number; qty: number; uom?: string }): void;
    basket(): { lineId: string; voided: boolean }[];
    tenderCash(saleId: string, receiptNumber: string, atIsoUtc: string): Promise<string>;
    nextReceipt(): Promise<string>;
    newSale(): void;
  };
}

const shows = (page: Page, panelId: string, titleId: string, startsWith: string): Promise<unknown> => page.waitForFunction(
  `(() => { const p = document.getElementById(${JSON.stringify(panelId)}); const t = document.getElementById(${JSON.stringify(titleId)});`
  + ` return p !== null && !p.hidden && t !== null && (t.textContent || '').startsWith(${JSON.stringify(startsWith)}); })()`,
  undefined, { timeout: 15_000 },
);
const sheetTitled = (page: Page, startsWith: string): Promise<unknown> => shows(page, 'sheet', 'sheet-title', startsWith);
const panelTitled = (page: Page, startsWith: string): Promise<unknown> => shows(page, 'pay', 'pay-title', startsWith);

describe.skipIf(!HAVE_BROWSER)('fix batch 4a: a weighed refund is keyed in kg with a decimal point (D-059)', () => {
  let browser: Browser;
  const dirs: string[] = [];
  const stops: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'pos'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 120_000);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => {
    for (const stop of stops.splice(0).reverse()) await stop();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  async function till(): Promise<{ edge: EdgeProcess; page: Page }> {
    const dir = await mkdtemp(join(tmpdir(), 'sre-batch4a-kg-refund-'));
    dirs.push(dir);
    const edge: EdgeProcess = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY,
      EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0', EDGE_LANE_ID: 'lane-1', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps',
      ...await prepareTillBox({ dir, key: KEY, pack: PACK, people: [{ userId: 'u-lanecash', displayName: 'Lane Cashier' }] }),
    }, () => {}))!;
    stops.push(() => edge.stop());
    const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    stops.push(() => context.close());
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${edge.screens!.port}/pos/`, { waitUntil: 'load' });
    await page.waitForFunction(() => (globalThis as unknown as PosWindow).posSession !== undefined, undefined, { timeout: 15_000 });
    await signInThroughScreen(page);
    return { edge, page };
  }
  const keys = async (page: Page, typed: string): Promise<void> => {
    for (const k of typed) await page.click(`#keypad button:text-is("${k}")`);
  };
  const keypad = (page: Page): Promise<string[]> => page.$$eval('#keypad button', (b) => b.map((x) => (x.textContent ?? '').trim()));

  it('the tomato is keyed "0.5" (kg) on a keypad with a point; a fourth decimal or too much is refused; 500 g is refunded at ₹20.00', async () => {
    const { page } = await till();
    const billNo = await page.evaluate(async () => {
      const w = globalThis as unknown as PosWindow;
      w.posSession!.scan({ productId: 'P-TOM', description: 'Tomato (loose)', unitPriceMinor: 4_000, qty: 850, uom: 'kg' });
      w.posSession!.scan({ productId: 'P-BISC', description: 'Biscuits', unitPriceMinor: 1_000, qty: 3 });
      const n = await w.posSession!.nextReceipt();
      await w.posSession!.tenderCash('S-D059', n, new Date().toISOString());
      w.posSession!.newSale();
      return n;
    });
    const openRefund = async (): Promise<void> => {
      await page.click('#more');
      await panelTitled(page, 'More');
      await page.click('#pay-kinds button:text-is("Refund")');
      await sheetTitled(page, 'Scan the receipt, or key the bill number');
      await page.keyboard.type(billNo);
      await page.keyboard.press('Enter');
      await panelTitled(page, 'Which item is coming back?');
    };

    // ── A counted line keeps its whole-number keypad: C, no point ──
    await openRefund();
    await page.click('#pay-kinds button:text-is("Biscuits — can return 3")');
    await sheetTitled(page, 'How many are coming back? — Biscuits');
    expect(await keypad(page)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', '⌫']);
    await page.click('#sheet-cancel');

    // ── The weighed line: kg, with the point ──
    await openRefund();
    await page.click('#pay-kinds button:text-is("Tomato (loose) — can return 0.850 kg")');
    await sheetTitled(page, 'How much is coming back, in kg? — Tomato (loose)');
    expect(await keypad(page)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', '⌫']);

    // A fourth decimal is not a weight the till holds (to the gram): the panel stays open and says why.
    await keys(page, '0.8505');
    expect(await page.textContent('#entry')).toBe('0.8505');
    await page.click('#sheet-ok');
    expect(await page.isHidden('#sheet')).toBe(false);
    expect(await page.textContent('#entry-hint')).toContain('Key the amount in kg with the point (for example 0.850)');
    // More than came back on the bill (0.9 kg of 0.850): refused the same way.
    for (let i = 0; i < 6; i += 1) await page.click('#keypad button:text-is("⌫")');
    await keys(page, '0.9');
    await page.click('#sheet-ok');
    expect(await page.isHidden('#sheet')).toBe(false);
    expect(await page.textContent('#entry-hint')).toContain('no more than can come back: 0.850 kg');

    // 0.5 kg: taken as 500 g — the refund is valued on 500 g of tomato at ₹40/kg.
    for (let i = 0; i < 3; i += 1) await page.click('#keypad button:text-is("⌫")');
    await keys(page, '0.5');
    expect(await page.textContent('#entry')).toBe('0.5');
    await page.click('#sheet-ok');
    await sheetTitled(page, 'Why is it coming back?');
    await page.click('#reasons button:text-is("No longer needed")');
    await panelTitled(page, 'What condition is the item in?');
    await page.click('#pay-kinds button:text-is("Good — back on the shelf")');
    await panelTitled(page, 'How is the refund given?');
    expect(await page.textContent('#pay-title')).toContain('20.00');
  }, 120_000);
});
