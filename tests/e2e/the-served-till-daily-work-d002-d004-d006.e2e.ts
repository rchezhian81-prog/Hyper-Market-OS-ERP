import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { prepareTillBox, signInThroughScreen, takeFloatOnPage } from '../support/till-operator';

/**
 * **Three till defects from the daily-work walkthrough, each done the way a cashier does it, in a real browser on the
 * served till (docs/registers/daily-work-defects.md D-002 · D-004 · D-006).**
 *
 *   • D-002 — Void → "Reason for void" → OK with NO reason picked: the panel stays open and says "Pick a reason first —
 *     nothing was voided" (and in Tamil); the line is not voided. Picking a reason then voids it as before.
 *   • D-004 — More → Refund → the bill: a weighed line reads "can return 0.850 kg", never a bare "850" (grams) beside a
 *     counted line's "can return 3". Words only: what comes back is still counted in grams.
 *   • D-006 — the bill after a sale prints the cashier's NAME, as the people register gave it at sign-in ("Till: Lane
 *     Cashier"), not the login id.
 *
 * Skips where no browser binary is present. Synthetic data only.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['daily', 'work', 'till', 'fixes', 'key'].join('-').padEnd(48, '0');
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

describe.skipIf(!HAVE_BROWSER)('the served till: void needs a reason, a refund says kg, the bill names the cashier (D-002 · D-004 · D-006)', () => {
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
    const dir = await mkdtemp(join(tmpdir(), 'sre-daily-work-till-'));
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
  const scanCode = async (page: Page, code: string, words: string): Promise<void> => {
    await page.keyboard.type(code);
    await page.keyboard.press('Enter');
    await page.waitForFunction(`((document.getElementById('lines') || {}).textContent || '').includes(${JSON.stringify(words)})`, undefined, { timeout: 15_000 });
  };

  it('D-002: Void → OK with no reason keeps the panel open and says "Pick a reason first — nothing was voided" (and in Tamil); then a reason voids the line', async () => {
    const { page } = await till();
    await scanCode(page, '8900000000159', 'Curd 400g');

    await page.click('#lines tr:first-child');
    await page.click('#void');
    await sheetTitled(page, 'Reason for void');
    await page.click('#sheet-ok'); // OK, with no reason picked

    // The panel is still open and says why; nothing was voided.
    expect(await page.locator('#sheet').isHidden()).toBe(false);
    expect(await page.textContent('#sheet-title')).toBe('Reason for void');
    expect(await page.textContent('#entry-hint')).toBe('Pick a reason first — nothing was voided');
    expect(await page.evaluate(() => (globalThis as unknown as PosWindow).posSession!.basket().some((l) => l.voided))).toBe(false);

    // Picking a reason then voids it, as before — and the warning goes away with the panel.
    await page.locator('#reasons button', { hasText: 'Scanned twice' }).click();
    await page.click('#sheet-ok');
    await page.waitForFunction(() => (globalThis as unknown as PosWindow).posSession!.basket().some((l) => l.voided), undefined, { timeout: 5_000 });
    expect(await page.locator('#sheet').isHidden()).toBe(true);

    // In Tamil: the same refusal in the screen's language.
    await scanCode(page, '8900000000166', 'Biscuits');
    await page.click('#lang');
    await page.click('#lines tr:last-child');
    await page.click('#void');
    await sheetTitled(page, 'நீக்கக் காரணம்');
    await page.click('#sheet-ok');
    expect(await page.locator('#sheet').isHidden()).toBe(false);
    expect(await page.textContent('#entry-hint')).toBe('முதலில் ஒரு காரணத்தைத் தேர்ந்தெடுக்கவும் — எதுவும் நீக்கப்படவில்லை');
    expect(await page.evaluate(() => (globalThis as unknown as PosWindow).posSession!.basket().filter((l) => l.voided).length)).toBe(1);
    // Cancel still goes back with nothing voided.
    await page.click('#sheet-cancel');
    expect(await page.locator('#sheet').isHidden()).toBe(true);
    expect(await page.evaluate(() => (globalThis as unknown as PosWindow).posSession!.basket().filter((l) => l.voided).length)).toBe(1);
  });

  it('D-004: More → Refund → the bill lists the weighed tomato as "can return 0.850 kg" and the biscuits as "can return 3"; the how-much hint says kg too', async () => {
    const { page } = await till();
    // The bill the customer brings back: 850 g of loose tomato and 3 packets of biscuits, paid in cash.
    const billNo = await page.evaluate(async () => {
      const w = globalThis as unknown as PosWindow;
      w.posSession!.scan({ productId: 'P-TOM', description: 'Tomato (loose)', unitPriceMinor: 4_000, qty: 850, uom: 'kg' });
      w.posSession!.scan({ productId: 'P-BISC', description: 'Biscuits', unitPriceMinor: 1_000, qty: 3 });
      const n = await w.posSession!.nextReceipt();
      await w.posSession!.tenderCash('S-D004', n, new Date().toISOString());
      w.posSession!.newSale();
      return n;
    });

    await page.click('#more');
    await panelTitled(page, 'More');
    await page.click('#pay-kinds button:text-is("Refund")');
    await sheetTitled(page, 'Scan the receipt, or key the bill number');
    await page.keyboard.type(billNo);
    await page.keyboard.press('Enter');

    await panelTitled(page, 'Which item is coming back?');
    const items = await page.$$eval('#pay-kinds button', (b) => b.map((x) => (x.textContent ?? '').trim()));
    expect(items).toContain('Tomato (loose) — can return 0.850 kg');
    expect(items).toContain('Biscuits — can return 3');
    expect(items.some((x) => /can return 850\b/.test(x))).toBe(false);

    // The how-much question for the weighed line says kg too (D-059: it is keyed in kg, with the point).
    await page.click('#pay-kinds button:text-is("Tomato (loose) — can return 0.850 kg")');
    await sheetTitled(page, 'How much is coming back, in kg? — Tomato (loose)');
    expect(await page.textContent('#entry-hint')).toBe('Key it in kg with the point: 0.850 is 850 g. Can return: 0.850 kg.');
  });

  it('D-006: after a sale the bill reads "Till: Lane Cashier" — the name from the people register, not the login id', async () => {
    const { page } = await till();
    await takeFloatOnPage(page);
    await scanCode(page, '8900000000159', 'Curd 400g');
    await page.click('#tender');
    await page.waitForSelector('#pay-kinds button');
    await page.click('#pay-kinds button:first-child'); // Cash
    await page.waitForSelector('#quick button');
    await page.click('#quick button:first-child'); // Exact
    await page.waitForSelector('#refusal:not([hidden]) #refusal-receipt:not([hidden])', { timeout: 10_000 });
    const bill = (await page.textContent('#refusal-receipt')) ?? '';
    expect(bill).toMatch(/Till: Lane Cashier/);
    expect(bill).not.toContain('u-lanecash');
  });
});
