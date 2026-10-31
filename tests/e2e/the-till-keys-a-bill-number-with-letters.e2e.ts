import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { prepareTillBox, signInOnPage } from '../support/till-operator';

/**
 * **A bill number can be keyed by hand at the till — letters and all (Round B · M13-FR-01 · P-07).** This till's bills
 * carry letters (ZZBFPJ75-000001), but the "Scan the receipt, or key the bill number" pad had digits only, so a receipt
 * whose barcode would not scan could not be found for a refund or an exchange. Now that question offers a letters pad (and
 * a switch to the digits), every key the till's full 56px; and a scan still finds the bill at once.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['served', 'till', 'bill', 'letters', 'signing', 'key'].join('-').padEnd(48, '0');
const PEOPLE = [{ userId: 'u-lanecash', displayName: 'Lane cashier' }, { userId: 'u-manager', displayName: 'Manager', manager: true }];

interface PosWindow {
  readonly posSession?: {
    scan(item: { productId: string; description: string; unitPriceMinor: number; qty: number }): void;
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

describe.skipIf(!HAVE_BROWSER)('the till keys a bill number with letters by hand', () => {
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

  async function tillWithABill(): Promise<{ page: Page; receipt: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'sre-bill-letters-'));
    dirs.push(dir);
    const edge: EdgeProcess = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY,
      EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0', EDGE_LANE_ID: 'lane-1', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps',
      ...await prepareTillBox({ dir, key: KEY, people: PEOPLE }),
    }, () => {}))!;
    stops.push(() => edge.stop());
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    stops.push(() => context.close());
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${edge.screens!.port}/pos/`, { waitUntil: 'load' });
    await page.waitForFunction(() => (globalThis as unknown as PosWindow).posSession !== undefined, undefined, { timeout: 15_000 });
    await signInOnPage(page);
    const receipt = await page.evaluate(async () => {
      const w = globalThis as unknown as PosWindow;
      w.posSession!.scan({ productId: 'P1', description: 'Amul Ghee Gold 1L', unitPriceMinor: 64_000, qty: 1 });
      const number = await w.posSession!.nextReceipt();
      await w.posSession!.tenderCash('S-L1', number, new Date().toISOString());
      w.posSession!.newSale();
      return number;
    });
    return { page, receipt };
  }

  it('More → Refund → the bill number tapped on the on-screen pads, letters and digits → the bill is found', { timeout: 60_000 }, async () => {
    const { page, receipt } = await tillWithABill();
    expect(receipt).toMatch(/[A-Z]/); // the bill number this box gave has letters in it

    await page.click('#more');
    await shows(page, 'pay', 'pay-title', 'More');
    await page.click('#pay-kinds button:text-is("Refund")');
    await shows(page, 'sheet', 'sheet-title', 'Scan the receipt, or key the bill number');

    // The letters pad shows, with the switch to the digits; every key is the till's full 56px.
    expect(await page.isVisible('#letterpad')).toBe(true);
    expect(await page.isVisible('#pad-switch')).toBe(true);
    const heights = await page.$$eval('#letterpad button, #pad-switch', (bs) => bs.map((b) => b.getBoundingClientRect().height));
    expect(heights.length).toBeGreaterThanOrEqual(28);
    for (const h of heights) expect(h).toBeGreaterThanOrEqual(56);

    // Tap the number in, a character at a time, switching pads as the number goes from letters to digits.
    for (const ch of receipt) {
      const wantLetters = /[A-Z-]/.test(ch);
      if (wantLetters !== await page.isVisible('#letterpad')) await page.click('#pad-switch');
      const before = (await page.textContent('#entry')) ?? '';
      await page.click(`${wantLetters ? '#letterpad' : '#keypad'} button:text-is("${ch}")`);
      // Each tap must land before the next (a lost tap names the key, rather than a shorter number at the end).
      await page.waitForFunction(([want]) => (globalThis as unknown as { document: { getElementById(id: string): { textContent: string | null } | null } }).document.getElementById('entry')?.textContent === want, [before + ch], { timeout: 5_000 });
    }
    expect(await page.textContent('#entry')).toBe(receipt);
    await page.click('#sheet-ok');
    await shows(page, 'pay', 'pay-title', 'Which item is coming back?');
  });

  it('a scanned receipt still finds the bill at once, and a sale\'s quantity pad shows no letters', { timeout: 60_000 }, async () => {
    const { page, receipt } = await tillWithABill();
    await page.click('#more');
    await shows(page, 'pay', 'pay-title', 'More');
    await page.click('#pay-kinds button:text-is("Refund")');
    await shows(page, 'sheet', 'sheet-title', 'Scan the receipt, or key the bill number');
    await page.keyboard.type(receipt);
    await page.keyboard.press('Enter');
    await shows(page, 'pay', 'pay-title', 'Which item is coming back?');
    expect(await page.isVisible('#letterpad')).toBe(false);
    expect(await page.isVisible('#pad-switch')).toBe(false);
  });
});
