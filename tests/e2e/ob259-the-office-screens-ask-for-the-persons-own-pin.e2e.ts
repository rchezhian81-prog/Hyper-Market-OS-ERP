import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { auditPage } from './lib/a11y-audit';
import { PEOPLE, startOfficeBox, type OfficeBox } from '../support/office-box';

/**
 * OB-259 in real Chromium, on a real store box: the manager's office screen asks "Enter your PIN" — in English and in
 * Tamil — and the page passes the accessibility audit; a wrong PIN and a cashier's PIN are refused with the reason in
 * both languages; the manager's own PIN opens the manager's screen, which shows who is signed in and a Sign out button
 * (its Tamil word too); Sign out brings the PIN page back; the till's own page never asks.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);

describe.skipIf(!HAVE_BROWSER)('the office screens ask for the person\'s own PIN, in English and Tamil (OB-259)', () => {
  let browser: Browser;
  const stops: (() => Promise<void>)[] = [];
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    execFileSync('node', ['scripts/build-app.mjs', 'pos'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 240_000);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop(); });

  async function open(): Promise<{ box: OfficeBox; page: Page }> {
    const box = await startOfficeBox();
    stops.push(() => box.stop());
    const context = await browser.newContext({ viewport: { width: 1366, height: 860 }, serviceWorkers: 'block' });
    stops.push(() => context.close());
    return { box, page: await context.newPage() };
  }
  const signIn = async (page: Page, who: { userId: string; pin: string }): Promise<void> => {
    await page.fill('#office-staff', who.userId);
    await page.fill('#office-pin', who.pin);
    await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.click('#office-submit')]);
  };

  it('asks in both languages, refuses a wrong PIN and a cashier, opens for the manager, and signs out', async () => {
    const { box, page } = await open();
    await page.goto(`${box.base}/manager/`, { waitUntil: 'load' });
    expect(await page.locator('#office-heading [lang="en"]').innerText()).toBe('Enter your PIN');
    expect(await page.locator('#office-heading [lang="ta"]').innerText()).toBe('உங்கள் PIN-ஐ உள்ளிடுங்கள்');
    expect(await page.locator('#office-pin').getAttribute('type')).toBe('password');
    expect(await auditPage(page)).toEqual([]);

    await signIn(page, { userId: PEOPLE.manager.userId, pin: '000000' });
    expect(await page.locator('#office-problem [lang="en"]').innerText()).toBe('That staff ID and PIN do not match. Try again.');
    expect(await page.locator('#office-problem [lang="ta"]').innerText()).toBe('அந்தப் பணியாளர் எண்ணும் PIN-உம் பொருந்தவில்லை. மீண்டும் முயலுங்கள்.');

    await signIn(page, PEOPLE.cashier);
    expect(await page.locator('#office-problem [lang="en"]').innerText()).toMatch(/^This PIN opens the till only\./);
    expect(await page.locator('#office-problem [lang="ta"]').innerText()).toMatch(/^இந்த PIN விற்பனை முனையத்தை மட்டுமே திறக்கும்\./);
    expect(await auditPage(page)).toEqual([]);

    await signIn(page, PEOPLE.manager);
    expect(new URL(page.url()).pathname).toBe('/manager/');
    await page.locator('#sre-office-bar').waitFor({ state: 'visible', timeout: 15_000 });
    expect(await page.locator('#sre-office-bar span').innerText()).toBe('Manager Person');
    expect(await page.locator('#sre-office-sign-out').innerText()).toBe('Sign out · வெளியேறு');
    expect(await page.evaluate('window.managerData && window.managerData.userId')).toBe('u-manager');

    await Promise.all([page.waitForLoadState('load'), page.click('#sre-office-sign-out')]);
    expect(await page.locator('#office-heading [lang="en"]').innerText()).toBe('Enter your PIN');
    await page.goto(`${box.base}/manager/`, { waitUntil: 'load' });
    expect(await page.locator('#office-heading [lang="ta"]').innerText()).toBe('உங்கள் PIN-ஐ உள்ளிடுங்கள்');
  }, 120_000);

  it('the till never asks: its own page opens as before', async () => {
    const { box, page } = await open();
    const res = await page.goto(`${box.base}/pos/`, { waitUntil: 'load' });
    expect(res?.status()).toBe(200);
    expect(await page.locator('#office-heading').count()).toBe(0);
  }, 60_000);
});
