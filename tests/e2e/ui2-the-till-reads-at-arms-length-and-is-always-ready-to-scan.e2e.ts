import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { auditPage } from './lib/a11y-audit';
import { serveShell, tillStoreComputer, tillCatalogue, SIDEWAYS, smallTargets } from './lib/device-screens';

/**
 * **UI-2 (owner, 1 Nov 2026: "UI/UX also very poor" — "Till and handhelds"): the till, fast and clear at a busy counter.**
 *
 * In real Chromium, the real till page with the real bundled session and a stand-in store computer on its loopback
 * socket (head office out of reach), at the till's own 1366×768 and at 1024×768, in English and Tamil:
 *
 *   1. the scan line over the bill SAYS the till is ready to scan; the digits a keyboard types show as they arrive (the
 *      panel turns "reading", in words too), Backspace takes one back and Esc clears them — and none of that adds a line;
 *   2. a scan adds its line and the scan line names it ("Last added: Ponni rice 1kg · 1 · ₹70.00"), the bill counts its
 *      lines under the total, and a quantity changed afterwards is said as it now stands;
 *   3. a code the price list does not hold says what happened, that nothing was added, and what to do — in Tamil too;
 *   4. "Type a barcode" opens the till's own keypad and the code goes down exactly the scan's path;
 *   5. a scan makes no network call and the line is on screen well inside the 300 ms scan-to-line target (§32);
 *   6. every control is a 56px till target, nothing scrolls sideways, the accessibility audit is clean.
 *
 * Every check of 1–4 failed on the page before UI-2 (there was no scan line, no count, and the unknown code read the
 * catalogue's English-only "Barcode … is not in the catalogue."). Screenshots go to SRE_SHOTS when it names a folder.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const SHOTS = process.env['SRE_SHOTS'];
const RICE = '8900000000707';
const DAL = '8901234567890';

describe.skipIf(!existsSync(CHROMIUM))('UI-2: the till reads at arm\'s length and is always ready to scan', () => {
  let browser: Browser;
  const stops: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    if (SHOTS !== undefined) mkdirSync(SHOTS, { recursive: true });
    execFileSync('node', ['scripts/build-app.mjs', 'pos'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 180_000);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop(); });

  async function till(width: number, height: number): Promise<{ page: Page; errors: string[]; requests: string[] }> {
    const srv = await serveShell('pos', { posCatalogue: tillCatalogue() });
    stops.push(srv.stop);
    const context = await browser.newContext({ viewport: { width, height }, serviceWorkers: 'block' });
    stops.push(() => context.close());
    await tillStoreComputer(context);
    const page = await context.newPage();
    const errors: string[] = [];
    const requests: string[] = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
    page.on('request', (r) => { requests.push(new URL(r.url()).pathname); });
    await page.goto(`${srv.base}/index.html`, { waitUntil: 'load' });
    await page.waitForFunction('globalThis.posSession !== undefined && globalThis.posSession.hasCatalogue() && typeof globalThis.sreIcon === "function" && globalThis.posBadge.state().asked', undefined, { timeout: 15_000 });
    return { page, errors, requests };
  }
  const shot = async (page: Page, name: string): Promise<void> => { if (SHOTS !== undefined) await page.screenshot({ path: join(SHOTS, `${name}.png`) }); };
  const text = async (page: Page, sel: string): Promise<string> => ((await page.textContent(sel)) ?? '').trim();
  const lines = (page: Page): Promise<string[]> => page.$$eval('#lines tr .desc', (d) => d.map((x) => x.textContent ?? ''));

  for (const [width, height] of [[1366, 768], [1024, 768]] as const) {
    it(`at ${width}×${height}: ready, the digits as typed, the last item named, the lines counted; 56px targets, no sideways scroll, audit clean`, async () => {
      const { page, errors } = await till(width, height);
      // 1. ready, in words, before anything is scanned
      expect(await text(page, '#scan-say')).toBe('Ready to scan — scan the item, or type its barcode and press Enter');
      expect(await page.getAttribute('#scan-ready', 'data-state')).toBe('ready');
      expect(await text(page, '#bill-count')).toBe('');
      expect(await page.locator('#scan-ready svg[data-icon="scan-barcode"]').count()).toBe(1);

      // the digits a keyboard types show as they arrive; Backspace takes one back; Esc clears; no line is added
      await page.keyboard.type('89000');
      expect(await text(page, '#scan-code')).toBe('89000');
      expect(await page.getAttribute('#scan-ready', 'data-state')).toBe('reading');
      expect(await text(page, '#scan-say')).toBe('Typed so far — press Enter to add it, Esc to clear');
      await page.keyboard.press('Backspace');
      expect(await text(page, '#scan-code')).toBe('8900');
      await page.keyboard.press('Escape');
      expect(await text(page, '#scan-code')).toBe('');
      expect(await page.getAttribute('#scan-ready', 'data-state')).toBe('ready');
      expect(await lines(page)).toEqual([]);

      // 2. a scan adds its line, and the scan line names it; the bill counts its lines
      await page.keyboard.type(RICE); await page.keyboard.press('Enter');
      await page.waitForSelector('#lines tr');
      expect(await text(page, '#scan-last')).toBe('Last added: Ponni rice 1kg · 1 · ₹70.00');
      expect(await text(page, '#scan-code')).toBe('');
      await page.keyboard.type(DAL); await page.keyboard.press('Enter');
      await page.waitForFunction('document.querySelectorAll("#lines tr").length === 2');
      expect(await text(page, '#scan-last')).toBe('Last added: Toor dal 1kg · 1 · ₹145.00');
      expect(await text(page, '#bill-count')).toBe('2 line(s) on the bill');
      expect(await text(page, '#total')).toBe('₹215.00');
      await shot(page, `till-${width}-after-scans`);

      // 6. targets, no sideways scroll, the audit — the bill and the scan line in place
      expect(await page.evaluate(smallTargets(56)), 'every till control is a 56px target').toEqual([]);
      expect(await page.evaluate(SIDEWAYS)).toEqual([]);
      expect(await auditPage(page, { expectLang: 'en' })).toEqual([]);

      // Tamil: every word of the scan line and the count
      await page.click('#lang');
      await page.waitForFunction('document.documentElement.lang === "ta"');
      expect(await text(page, '#scan-say')).toBe('ஸ்கேன் செய்யத் தயார் — பொருளை ஸ்கேன் செய்யவும், அல்லது அதன் பார்கோடை உள்ளிட்டு Enter அழுத்தவும்');
      expect(await text(page, '#scan-last')).toBe('கடைசியாகச் சேர்த்தது: Toor dal 1kg · 1 · ₹145.00');
      expect(await text(page, '#bill-count')).toBe('பில்லில் 2 வரி(கள்)');
      expect(await text(page, '#key-code')).toBe('பார்கோடை உள்ளிடு');
      expect(await page.evaluate(SIDEWAYS)).toEqual([]);
      expect(await auditPage(page, { expectLang: 'ta' })).toEqual([]);
      await shot(page, `till-${width}-after-scans-ta`);
      expect(errors).toEqual([]);
    });
  }

  it('a quantity changed after the scan is said as it stands; a code not in the price list says what happened and what to do', async () => {
    const { page, errors } = await till(1366, 768);
    await page.keyboard.type(DAL); await page.keyboard.press('Enter');
    await page.waitForSelector('#lines tr');
    // the line's quantity changes the way a cashier changes it — tap the line, Qty, the quick 3
    await page.click('#lines tr');
    await page.click('#qty');
    await page.waitForSelector('#sheet:not([hidden]) #quick button');
    await page.locator('#quick button', { hasText: /^3$/ }).click();
    await page.waitForFunction('document.getElementById("total").textContent === "₹435.00"');
    expect(await text(page, '#scan-last')).toBe('Last added: Toor dal 1kg · 3 · ₹435.00');

    // 3. a code the list does not hold
    await page.keyboard.type('8900000000123'); await page.keyboard.press('Enter');
    await page.waitForSelector('#refusal:not([hidden])');
    expect(await text(page, '#refusal-title')).toBe('Not in the price list');
    expect(await text(page, '#refusal-text')).toBe('Barcode 8900000000123 is not in this shop\'s price list. Nothing was added to the bill.\nScan it again, or type the number under the barcode. If it is still not found, put the item aside and call the manager.');
    expect(await lines(page)).toEqual(['Toor dal 1kg']);
    expect(await auditPage(page, { expectLang: 'en' })).toEqual([]);
    await shot(page, 'till-1366-not-in-the-price-list');
    await page.click('#refusal-ok');
    await page.click('#lang');
    await page.keyboard.type('8900000000123'); await page.keyboard.press('Enter');
    await page.waitForSelector('#refusal:not([hidden])');
    expect(await text(page, '#refusal-title')).toBe('விலைப் பட்டியலில் இல்லை');
    expect(await text(page, '#refusal-text')).toMatch(/^பார்கோடு 8900000000123 இந்தக் கடையின் விலைப் பட்டியலில் இல்லை\. பில்லில் எதுவும் சேர்க்கப்படவில்லை\./);
    expect(await auditPage(page, { expectLang: 'ta' })).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('"Type a barcode" opens the till\'s keypad and the code goes the scan\'s own way; Cancel adds nothing', async () => {
    const { page, errors } = await till(1366, 768);
    await page.click('#key-code');
    await page.waitForSelector('#sheet:not([hidden])');
    expect(await text(page, '#sheet-title')).toBe('Type the number under the barcode');
    expect(await text(page, '#entry-hint')).toBe('Then press OK. The item is added exactly as a scan would add it.');
    await shot(page, 'till-1366-type-a-barcode');
    await page.click('#sheet-cancel');
    expect(await lines(page)).toEqual([]);
    await page.click('#key-code');
    await page.waitForSelector('#sheet:not([hidden])');
    for (const digit of RICE) await page.click(`#keypad button:text-is("${digit}")`);
    expect(await text(page, '#entry')).toBe(RICE);
    await page.click('#sheet-ok');
    await page.waitForSelector('#lines tr');
    expect(await lines(page)).toEqual(['Ponni rice 1kg']);
    expect(await text(page, '#scan-last')).toBe('Last added: Ponni rice 1kg · 1 · ₹70.00');
    // the scanner's Enter afterwards scans; it never presses "Type a barcode" again
    await page.keyboard.type(RICE); await page.keyboard.press('Enter');
    await page.waitForFunction('globalThis.posSession.basket().reduce((n, l) => n + l.qty, 0) === 2');
    expect(await page.isHidden('#sheet')).toBe(true);
    expect(errors).toEqual([]);
  });

  it('a scan makes no network call and its line is on screen inside the 300 ms scan-to-line target', async () => {
    const { page, requests } = await till(1366, 768);
    const before = requests.length;
    // The scanner's thirteen keys and its Enter, dispatched as one burst; the line is drawn before the call returns.
    const ms = await page.evaluate(`(() => {
      const started = performance.now();
      for (const key of [...'${RICE}', 'Enter']) window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      const drawn = document.querySelectorAll('#lines tr').length === 1 && document.getElementById('scan-last').textContent.includes('Ponni rice 1kg');
      return drawn ? performance.now() - started : -1;
    })()`) as number;
    expect(ms, 'the line is on screen when the scan returns').toBeGreaterThanOrEqual(0);
    expect(ms).toBeLessThan(300);
    await page.waitForTimeout(200);
    expect(requests.slice(before).filter((p) => p !== '/lane/sync-status'), 'no network call for a scan').toEqual([]);
  });
});
