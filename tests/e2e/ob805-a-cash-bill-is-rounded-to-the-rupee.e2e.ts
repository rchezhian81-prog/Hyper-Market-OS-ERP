import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { prepareTillBox, signInThroughScreen } from '../support/till-operator';
import { readLog } from '../../edge/store-edge/src/file-log';
import { readTillCashRecord } from '../../edge/store-edge/src/till-cash';

/**
 * **OB-805 A (owner, 16 Nov 2026, in writing) · daily-work defect D-003 — a cash bill rounded to the rupee, on the served
 * till, the way a cashier does it, and the blind count of the drawer balances.**
 *
 * Before: a ₹303.50 cash bill asked for ₹303.50 and gave ₹196.50 change from ₹500, and the blind count — which has no coin
 * below ₹1 — always showed the drawer short. Now the cash is the bill less its paise (DOWN only: OB-285, the customer never
 * pays above the goods): Tender → Cash says "Cash received — ₹303.00 (Round off −₹0.50 · Pay ₹303.00)"; ₹500 gives ₹197.00
 * change; the bill prints "Round off -0.50" above "TOTAL 303.00"; the store computer's record carries total ₹303.00 and round
 * off −₹0.50; and Close till, counting ₹2,000 float + ₹303 in notes and coins, BALANCES. In Tamil the round off is named too.
 *
 * A real Chromium against a real store computer. Skips where no browser binary is present. Synthetic data only.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['cash', 'round', 'off', 'signing', 'key'].join('-').padEnd(48, '0');

/** One item at ₹303.50 (no GST, so the figures read plainly), a ₹100 cash tolerance. */
const PACK = JSON.stringify({
  version: 1,
  policies: { storeId: 'store-1', branchId: 'store-1', branchName: 'Main', tradingDayCutoff: '02:00', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, cashVarianceToleranceMinor: 10_000, privacySlaDays: 15, warehouseId: 'wh-1' },
  lossPreventionRules: [],
  products: [{ productId: 'P-RICE', name: 'Ponni rice 5kg', categoryId: 'grocery', unitPriceMinor: 30_350, uom: 'ea', barcodes: ['8901234500011'], availableMinor: 100, taxBps: 0, status: 'active' }],
});

interface PosWindow { readonly posSession?: { hasCatalogue(): boolean; operator(): string | undefined } }

describe.skipIf(!HAVE_BROWSER)('OB-805 A · the served till rounds a cash bill to the rupee, and the drawer balances (D-003)', () => {
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

  const keys = async (page: Page, digits: string): Promise<void> => {
    for (const d of digits) await page.click(`#keypad button:text-is("${d}")`);
  };
  /** Key an amount on the sheet, OK, then confirm the consequence (a cash movement). */
  const keyMovement = async (page: Page, rupees: string): Promise<void> => {
    await page.waitForSelector('#sheet:not([hidden])');
    await keys(page, rupees);
    await page.click('#sheet-ok');
    await page.waitForSelector('#sheet:not([hidden]) #consequence:not([hidden])');
    await page.click('#sheet-ok');
  };
  const shown = async (page: Page): Promise<{ title: string; text: string; bill: string }> => {
    await page.waitForSelector('#refusal:not([hidden])');
    const title = (await page.textContent('#refusal-title')) ?? '';
    const text = (await page.textContent('#refusal-text')) ?? '';
    const bill = (await page.textContent('#refusal-receipt')) ?? '';
    await page.click('#refusal-ok');
    return { title, text, bill };
  };
  const pick = async (page: Page, label: RegExp): Promise<void> => {
    await page.waitForSelector('#pay:not([hidden])');
    await page.locator('#pay-kinds button', { hasText: label }).first().click();
  };

  async function till(): Promise<{ edge: EdgeProcess; page: Page }> {
    const dir = await mkdtemp(join(tmpdir(), 'sre-cash-round-off-'));
    dirs.push(dir);
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, PACK, 'utf8');
    const edge: EdgeProcess = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY, EDGE_PACK_FILE: packFile,
      EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0', EDGE_LANE_ID: 'lane-1', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps',
      ...await prepareTillBox({ dir, key: KEY, pack: JSON.parse(PACK) as Record<string, unknown> }),
    }, () => {}))!;
    stops.push(() => edge.stop());
    const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    stops.push(() => context.close());
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${edge.screens!.port}/pos/`, { waitUntil: 'load' });
    await page.waitForFunction(() => { const w = globalThis as unknown as PosWindow; return w.posSession !== undefined && w.posSession.hasCatalogue(); }, undefined, { timeout: 15_000 });
    await signInThroughScreen(page);
    return { edge, page };
  }

  it('₹303.50 in cash: "Round off −₹0.50 · Pay ₹303.00", ₹500 gives ₹197.00, the bill prints the round off, and the blind count balances', async () => {
    const { edge, page } = await till();
    // Open the till: a ₹2,000 float.
    await page.click('#more');
    await pick(page, /^Take float/);
    await keyMovement(page, '2000');
    expect((await shown(page)).title).toBe('Float taken — the till is open');

    await page.keyboard.type('8901234500011');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#lines tr');
    expect(await page.textContent('#total')).toBe('₹303.50');

    await page.click('#tender');
    await pick(page, /^Cash/);
    await page.waitForSelector('#sheet:not([hidden])');
    expect(await page.textContent('#sheet-title')).toBe('Cash received — ₹303.00 (Round off −₹0.50 · Pay ₹303.00)');
    expect(await page.textContent('#entry-hint')).toContain('Round off −₹0.50 · Pay ₹303.00');
    await keys(page, '500');
    expect(await page.textContent('#entry-hint')).toBe('Change due: ₹197.00');
    await page.click('#sheet-ok');
    const done = await shown(page);
    expect(done.title).toBe('Change due: ₹197.00');
    expect(done.bill).toMatch(/Round off\s+-0\.50/);
    expect(done.bill).toMatch(/TOTAL\s+303\.00/);
    expect(done.bill).toMatch(/cash\s+303\.00/);

    // What the store computer saved: the bill at ₹303.00, its round off, the cash taken — the line still ₹303.50.
    const sales = (await readLog(edge.log.path)).map((r) => (r.ok ? JSON.parse(r.record) as Record<string, unknown> : undefined)).filter((s) => s !== undefined);
    expect(sales).toHaveLength(1);
    expect(sales[0]).toMatchObject({ total: 30_300, roundOffMinor: -50, lines: [expect.objectContaining({ lineTotalMinor: 30_350 })], tenders: [expect.objectContaining({ kind: 'cash', amount: expect.objectContaining({ minor: 30_300 }) })] });

    // Close till: ₹2,000 float + ₹303 taken = four ₹500, three ₹100, one ₹2 and one ₹1 — the count has no coin below ₹1, and
    // now it needs none.
    await page.click('#more');
    await pick(page, /^Close till/);
    await page.waitForSelector('#count:not([hidden])');
    for (let i = 0; i < 4; i += 1) await page.click('button[aria-label="one more ₹500.00"]');
    for (let i = 0; i < 3; i += 1) await page.click('button[aria-label="one more ₹100.00"]');
    await page.click('button[aria-label="one more ₹2.00"]');
    await page.click('button[aria-label="one more ₹1.00"]');
    expect(await page.textContent('#count-total')).toContain('₹2,303.00');
    await page.click('#count-ok');
    expect((await shown(page)).title).toBe('The drawer balances exactly.');
    const closes = (await readLog(edge.tillCashLog.path)).map((r) => readTillCashRecord(JSON.parse((r as { record: string }).record))).filter((r) => r?.kind === 'close');
    expect(closes[0]).toMatchObject({ cashSalesMinor: 30_300, countedMinor: 230_300, expectedMinor: 230_300, varianceMinor: 0, exceptionRaised: false });
  });

  it('in Tamil the round off is named too', async () => {
    const { page } = await till();
    await page.click('#more');
    await pick(page, /^Take float/);
    await keyMovement(page, '2000');
    await shown(page);
    await page.keyboard.type('8901234500011');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#lines tr');
    await page.click('#lang'); // EN → த
    await page.click('#tender');
    await page.waitForSelector('#pay:not([hidden])');
    await page.locator('#pay-kinds button').first().click();
    await page.waitForSelector('#sheet:not([hidden])');
    expect(await page.textContent('#sheet-title')).toContain('முழுமையாக்கல் (ரவுண்ட் ஆஃப்) −₹0.50');
  });
});
