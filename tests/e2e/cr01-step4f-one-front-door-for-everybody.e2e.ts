import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { auditPage } from './lib/a11y-audit';
import { PEOPLE, startOfficeBox, type OfficeBox } from '../support/office-box';

/**
 * CR-01 step 4f · OB-795 "A for login" (owner, in writing) — the store PC's ONE front door, in real Chromium on a real store
 * box: `/` and `/office/` ask "Sign in — SRE Hyper Market" (English and Tamil) for a staff ID and PIN; the owner lands on
 * Today, the accountant on the first screen of their own daily work, a cashier is told "Your work is on the till" (and is
 * never signed in to the office); opening the front door again while signed in asks again — the last person is signed out
 * first; `/manager/` keeps its own PIN gate, as before.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';

describe.skipIf(!existsSync(CHROMIUM))('CR-01 step 4f: one sign-in front door for owner, manager and staff', () => {
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
    // The accountant holds the bill-matching word, as the real role does, so their own daily work opens.
    const box = await startOfficeBox({ rolePermissions: { accountant: ['purchase.invoice.match'] } });
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

  it('the shop\'s address asks everybody to sign in; the owner lands on Today', async () => {
    const { box, page } = await open();
    const res = await page.goto(`${box.base}/`, { waitUntil: 'load' });
    expect(res?.status()).toBe(200);
    expect(await page.title()).toBe('Sign in — SRE Hyper Market');
    expect(await page.locator('#office-heading [lang="en"]').innerText()).toBe('Sign in — SRE Hyper Market');
    expect(await page.locator('#office-heading [lang="ta"]').innerText()).toBe('உள்நுழைக — SRE ஹைப்பர் மார்க்கெட்');
    expect(await page.locator('#office-front').innerText()).toMatch(/owner, manager and staff/);
    expect(await auditPage(page)).toEqual([]);
    await signIn(page, PEOPLE.owner);
    expect(new URL(page.url()).pathname).toBe('/manager/');
    await page.locator('#sre-office-bar').waitFor({ state: 'visible', timeout: 15_000 });
    expect(await page.locator('#sre-office-bar span').innerText()).toBe('Owner Person');
  }, 120_000);

  it('the accountant lands on the first screen of their own daily work', async () => {
    const { box, page } = await open();
    await page.goto(`${box.base}/office/`, { waitUntil: 'load' });
    await signIn(page, PEOPLE.accountant);
    expect(new URL(page.url()).pathname).toBe('/supplier-bills/');
  }, 120_000);

  it('a cashier is told the work is on the till, and is never signed in to the office', async () => {
    const { box, page } = await open();
    await page.goto(`${box.base}/office/`, { waitUntil: 'load' });
    await signIn(page, PEOPLE.cashier);
    expect(await page.locator('#office-heading [lang="en"]').innerText()).toBe('Your work is on the till');
    expect(await page.locator('#office-heading [lang="ta"]').innerText()).toBe('உங்கள் வேலை விற்பனை முனையத்தில்');
    expect(await page.locator('#office-to-till').getAttribute('href')).toBe('/pos/');
    expect(await auditPage(page)).toEqual([]);
    // No office sign-in was made: the manager's screen still asks for a PIN.
    await page.goto(`${box.base}/manager/`, { waitUntil: 'load' });
    expect(await page.locator('#office-heading [lang="en"]').innerText()).toBe('Enter your PIN');
  }, 120_000);

  it('opening the front door while signed in asks again — the last person is signed out first; /manager/ keeps its own gate', async () => {
    const { box, page } = await open();
    await page.goto(`${box.base}/office/`, { waitUntil: 'load' });
    await signIn(page, PEOPLE.manager);
    expect(new URL(page.url()).pathname).toBe('/manager/');
    await page.goto(`${box.base}/office/`, { waitUntil: 'load' });
    expect(await page.locator('#office-heading [lang="en"]').innerText()).toBe('Sign in — SRE Hyper Market');
    // The manager's sign-in has ended: the old address asks for a PIN again, and opens for the manager as before.
    await page.goto(`${box.base}/manager/`, { waitUntil: 'load' });
    expect(await page.locator('#office-heading [lang="en"]').innerText()).toBe('Enter your PIN');
    await signIn(page, PEOPLE.manager);
    expect(new URL(page.url()).pathname).toBe('/manager/');
    await page.locator('#sre-office-bar').waitFor({ state: 'visible', timeout: 15_000 });
  }, 120_000);
});
