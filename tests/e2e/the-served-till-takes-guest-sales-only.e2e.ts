import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { prepareTillBox, signInThroughScreen } from '../support/till-operator';

/**
 * **Guest sales only on the served till (OB-252), in a real Chromium against a real store box.**
 *
 * With the store computer's setting on, the till SAYS so under its header — in English, and in Tamil after the language
 * button — and the More menu's loyalty entry reads "not on this till (guest sales only)" and explains why when tapped,
 * instead of asking for a mobile number. The refund screen offers no store credit. With the setting off, nothing of this
 * shows, the member entry is as before, and store credit is offered again.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['served', 'till', 'guest', 'only', 'key'].join('-').padEnd(48, '0');
const PACK = {
  version: 1,
  policies: { storeId: 'store-1', branchId: 'store-1', branchName: 'Main', tradingDayCutoff: '02:00', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, cashVarianceToleranceMinor: 10_000, privacySlaDays: 15, warehouseId: 'wh-1' },
  // A no-receipt cap, so the refund screen can be walked to its "how is the refund given?" step.
  servicePolicy: { returnWindowDays: 30, approvalThresholdMinor: 0, noReceiptCapMinor: 100_000, agentAuthorityMinor: 0, compensationCapMinor: 0 },
  lossPreventionRules: [],
  products: [{ productId: 'P1', name: 'Toor dal 1kg', categoryId: 'grocery', unitPriceMinor: 48_000, uom: 'ea', barcodes: ['8901234567890'], availableMinor: 100, taxBps: 0, status: 'active' }],
};

interface PosWindow { readonly posSession?: { hasCatalogue(): boolean; guestSalesOnly(): boolean } }

describe.skipIf(!HAVE_BROWSER)('the served till says "guest sales only" and takes no customer number (OB-252)', () => {
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

  const till = async (guestOnly: boolean): Promise<Page> => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-served-till-guest-'));
    dirs.push(dir);
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, JSON.stringify(PACK), 'utf8');
    const edge: EdgeProcess = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY, EDGE_PACK_FILE: packFile,
      EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0', EDGE_LANE_ID: 'lane-1', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps',
      ...(guestOnly ? { EDGE_GUEST_SALES_ONLY: '1' } : {}),
      ...await prepareTillBox({ dir, key: KEY, pack: PACK }),
    }, () => {}))!;
    stops.push(() => edge.stop());
    const context = await browser.newContext();
    stops.push(() => context.close());
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${edge.screens!.port}/pos/`, { waitUntil: 'load' });
    await page.waitForFunction(() => (globalThis as unknown as PosWindow).posSession?.hasCatalogue() === true, undefined, { timeout: 15_000 });
    await signInThroughScreen(page);
    return page;
  };
  const shows = (page: Page, panelId: string, titleId: string, startsWith: string): Promise<unknown> => page.waitForFunction(
    `(() => { const p = document.getElementById(${JSON.stringify(panelId)}); const t = document.getElementById(${JSON.stringify(titleId)});`
    + ` return p !== null && !p.hidden && t !== null && (t.textContent || '').startsWith(${JSON.stringify(startsWith)}); })()`,
    undefined, { timeout: 15_000 },
  );
  /** Walk a return without a receipt to the refund-method choice and read what it offers (then cancel). */
  const refundMethods = async (page: Page): Promise<string[]> => {
    await page.click('#more');
    await shows(page, 'pay', 'pay-title', 'More');
    await page.click('#pay-kinds button:text-is("Return without receipt")');
    await shows(page, 'sheet', 'sheet-title', 'Scan the item coming back');
    await page.keyboard.type('8901234567890');
    await page.keyboard.press('Enter');
    await shows(page, 'sheet', 'sheet-title', 'How many are coming back?');
    await page.click('#sheet-ok');
    await shows(page, 'sheet', 'sheet-title', 'Why is it coming back?');
    await page.click('#reasons button:text-is("Damaged / faulty")');
    await shows(page, 'pay', 'pay-title', 'What condition is the item in?');
    await page.click('#pay-kinds button:text-is("Good — back on the shelf")');
    await shows(page, 'sheet', 'sheet-title', 'How much to refund?');
    for (const digit of '100') await page.click(`#keypad button:text-is("${digit}")`);
    await page.click('#sheet-ok');
    await shows(page, 'pay', 'pay-title', 'How is the refund given?');
    const offered = await page.$$eval('#pay-kinds button', (b) => b.map((x) => x.textContent ?? ''));
    await page.click('#pay-cancel');
    return offered;
  };
  const more = async (page: Page): Promise<string[]> => {
    await page.click('#more');
    await page.waitForSelector('#pay:not([hidden])');
    return page.$$eval('#pay-kinds button', (b) => b.map((x) => x.textContent ?? ''));
  };

  it('on: said under the header in English and Tamil; the loyalty entry explains, and asks for no number', async () => {
    const page = await till(true);
    expect(await page.evaluate(() => (globalThis as unknown as PosWindow).posSession!.guestSalesOnly())).toBe(true);
    await page.waitForSelector('#guest-only:not([hidden])');
    expect(await page.textContent('#guest-only')).toContain('Guest sales only (pilot): this till takes no customer mobile number and no loyalty');

    const options = await more(page);
    expect(options).toContain('Loyalty member — not on this till (guest sales only)');
    expect(options).not.toContain('Loyalty member');
    await page.click('#pay-kinds button:text-is("Loyalty member — not on this till (guest sales only)")');
    await page.waitForSelector('#refusal:not([hidden])');
    expect(await page.textContent('#refusal-title')).toContain('Guest sales only');
    expect(await page.textContent('#refusal-text')).toMatch(/no customer mobile number and no loyalty points or store credit/);
    expect(await page.isHidden('#sheet')).toBe(true); // no keypad asking for a number
    await page.click('#refusal-ok');

    // Tamil.
    await page.click('#lang');
    expect(await page.textContent('#guest-only')).toContain('விருந்தினர் விற்பனை மட்டும் (பைலட்)');
    expect(await more(page)).toContain('லாயல்டி உறுப்பினர் — இந்தக் கல்லாவில் இல்லை (விருந்தினர் விற்பனை மட்டும்)');
    await page.click('#pay-cancel');
    await page.click('#lang');

    // A refund names no customer: no store credit is offered.
    const methods = await refundMethods(page);
    expect(methods).toEqual(expect.arrayContaining(['Cash', 'Card', 'UPI']));
    expect(methods).not.toContain('Store credit');
  }, 60_000);

  it('off: nothing is shown and the loyalty entry is as before', async () => {
    const page = await till(false);
    expect(await page.isHidden('#guest-only')).toBe(true);
    const options = await more(page);
    expect(options).toContain('Loyalty member');
    expect(options.join('|')).not.toContain('guest sales only');
    await page.click('#pay-cancel');
    expect(await refundMethods(page)).toContain('Store credit');
  }, 60_000);
});
