import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser } from 'playwright-core';
import { startOfficeShop, PEOPLE, type OfficeShop } from './lib/office-shop';

/**
 * **U5 · NFR-08 · OB-699 (12 Nov 2026): Customer cases' list state — "Reading the cases from head office…", "cannot be
 * reached" — follows the language toggle while it is showing.** The office-wide Tamil sweep caught the reading line in
 * English on the Tamil screen: it was painted once, in the language of the moment head office was asked, and a toggle
 * during the read left it English. Here the case read is held back so the toggle lands while the page is still reading;
 * then the read fails, and the "cannot be reached" state must be Tamil too.
 */
const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';

describe.skipIf(!existsSync(CHROMIUM))('Customer cases: the list state follows the toggle', () => {
  let browser: Browser; let shop: OfficeShop;
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
    shop = await startOfficeShop(browser);
  }, 300_000);
  afterAll(async () => { await shop?.stop(); await browser?.close(); });

  it('reading, then unreachable — each in Tamil once the reader switched to Tamil', async () => {
    const s = await shop.asPerson(PEOPLE.manager, { viewport: { width: 1280, height: 900 } });
    let release: () => void = () => {};
    const held = new Promise<void>((r) => { release = r; });
    // the chrome's own route answers first (registered later wins in Playwright): hold the case read, then cut it
    await s.context.route('**/v1/service/cases', async (route) => { await held; await route.abort(); });
    await s.page.goto(`${shop.base}/service-desk`, { waitUntil: 'load' });
    await s.page.waitForFunction("/Reading the cases/.test(document.getElementById('cases-status')?.textContent ?? '')", undefined, { timeout: 15_000 });
    await s.page.click('#lang');
    await s.page.waitForFunction("document.documentElement.lang === 'ta'");
    const reading = await s.page.textContent('#cases-status');
    expect(reading, 'the reading line is not left in English').not.toMatch(/Reading the cases/);
    expect(reading).toMatch(/[஀-௿]/);
    // still READING — never "no cases yet" while head office has not answered (P-08)
    expect(await s.page.getAttribute('#cases-status .sre-state', 'data-state')).toBe('loading');
    release();
    await s.page.waitForFunction("document.querySelector('#cases-status .sre-state')?.dataset.state === 'offline'", undefined, { timeout: 15_000 });
    const unreachable = await s.page.textContent('#cases-status');
    expect(unreachable).toMatch(/[஀-௿]/);
    expect(unreachable).not.toMatch(/head office/i);
    await s.context.close();
  }, 120_000);
});
