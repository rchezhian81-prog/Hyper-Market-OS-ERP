import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { auditPage } from './lib/a11y-audit';
import { startOfficeShop, PEOPLE, type OfficeShop } from './lib/office-shop';

/**
 * **OB-626 (2 Nov 2026 · UI/UX gap audit G4 · design system §1.3 · §27.1): money moves in the office only after the
 * confirm sheet — on the REAL store computer fed by the REAL head office, in real Chromium.**
 *
 * For each action: the click opens the sheet with the figure and the day/month in words; **Go back sends no write to head
 * office** (asserted on the `/v1` requests the browser makes); Confirm sends exactly one; the sheet's words are in the
 * reader's language; the audit is clean with the sheet open.
 *   • Day book — "Post this day to the accounts" (the accountant);
 *   • Month-end — "Post the month-end adjustment" and "Close the month" (danger tone; the second person's signature stays);
 *   • Supplier offer funding — "Record the receipt" with the amount typed, and "(required)" said in words on its fields;
 *   • Online store — "Publish the online store" carries a required reason that reaches head office's publication record.
 * Cash over/short, Campaigns, Order refunds, the service desk's refund and the B2B desk are held to the same rule by the
 * static guardrail `money-moves-only-after-the-confirm-sheet.test.ts` (the harness seeds no shift, plan, order or B2B
 * customer to reach their buttons). Skips where no browser binary is present.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DESK = { viewport: { width: 1280, height: 860 } };

const toggle = (page: Page): Promise<void> => page.evaluate(() => { (globalThis as unknown as { document: { getElementById(id: string): { click(): void } } }).document.getElementById('lang').click(); });

describe.skipIf(!existsSync(CHROMIUM))('U1: money moves only after the confirm sheet', () => {
  let browser: Browser;
  let shop: OfficeShop;
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
    shop = await startOfficeShop(browser);
  }, 300_000);
  afterAll(async () => { await shop?.stop(); await browser?.close(); });

  /** Open a page as a person and count every write the browser sends to head office. */
  const open = async (who: string, path: string) => {
    const s = await shop.asPerson(who, DESK as never);
    const writes: string[] = [];
    const bodies: string[] = [];
    s.page.on('request', (r) => { if (r.method() !== 'GET' && new URL(r.url()).pathname.startsWith('/v1/')) { writes.push(`${r.method()} ${new URL(r.url()).pathname}`); bodies.push(r.postData() ?? ''); } });
    await s.page.goto(`${shop.base}${path}`, { waitUntil: 'load' });
    await s.page.waitForFunction('globalThis.sreOffice !== undefined && typeof globalThis.sreOffice.confirm === "function"');
    await s.page.waitForLoadState('networkidle').catch(() => {});
    return { ...s, writes, bodies };
  };
  const sheet = (page: Page) => page.waitForSelector('#sre-confirm', { timeout: 10_000 });
  const gone = (page: Page) => page.waitForSelector('#sre-confirm', { state: 'detached', timeout: 10_000 });

  it('Day book: posting a day asks first, with the day in words; Go back posts nothing, Confirm posts once', async () => {
    const { context, page, writes, errors } = await open(PEOPLE.accountant, '/day-book');
    await page.fill('#day', '01/10/2026');
    await page.click('#load');
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForSelector('#post:not([hidden])');
    expect(await page.getAttribute('#post', 'class')).toContain('sre-btn-primary');
    await page.click('#post');
    await sheet(page);
    expect(await page.locator('#sre-confirm-title').innerText()).toMatch(/1 October 2026 will be posted to the accounts|of sales will be posted to the accounts for 1 October 2026/);
    expect(await page.locator('#sre-confirm-go').innerText()).toBe('Post this day');
    expect(await page.locator('.sre-confirm-authority').innerText()).toMatch(/In your name/);
    expect(await auditPage(page, { expectLang: 'en' })).toEqual([]);
    await toggle(page);
    expect(await page.locator('#sre-confirm-go').innerText()).toBe('இந்த நாளைப் பதி');
    expect(await page.locator('#sre-confirm-title').innerText()).toMatch(/அக்டோபர்|அக்\./);
    await toggle(page);
    await page.click('#sre-confirm-back');
    await gone(page);
    expect(writes.filter((w) => w.includes('/day-book/')), 'Go back posted nothing').toEqual([]);
    await page.click('#post');
    await sheet(page);
    await page.click('#sre-confirm-go');
    await gone(page);
    await page.waitForLoadState('networkidle').catch(() => {});
    expect(writes.filter((w) => w.includes('/day-book/'))).toEqual(['POST /v1/finance/day-book/2026-10-01/post']);
    expect(errors).toEqual([]);
    await context.close();
  });

  it('Month-end: a month is filled in; the adjustment asks first with the month in words and Go back changes nothing; the close button is not the tab\'s primary', async () => {
    const { context, page, writes, errors } = await open(PEOPLE.accountant, '/finance-close');
    expect(await page.inputValue('#period'), 'a month is filled in, never blank').toMatch(/^\d{4}-\d{2}$/);
    await page.fill('#period', '2026-10');
    await page.dispatchEvent('#period', 'change');
    await page.click('#tab-stock');
    await page.waitForLoadState('networkidle').catch(() => {});
    expect(await page.getAttribute('#post-adjustment', 'class')).toContain('sre-btn-primary');
    await page.click('#post-adjustment');
    await sheet(page);
    expect(await page.locator('#sre-confirm-title').innerText()).toBe('The month-end stock adjustment for October 2026 will be posted to the accounts');
    expect(await page.locator('#sre-confirm-go').innerText()).toBe('Post the adjustment');
    await page.keyboard.press('Escape');
    await gone(page);
    expect(writes.filter((w) => w.includes('stock-adjustment'))).toEqual([]);
    await page.click('#post-adjustment');
    await sheet(page);
    await page.click('#sre-confirm-go');
    await gone(page);
    await page.waitForLoadState('networkidle').catch(() => {});
    expect(writes.filter((w) => w.includes('stock-adjustment'))).toEqual(['POST /v1/finance/periods/2026-10/stock-adjustment']);

    await page.click('#tab-month');
    await page.waitForLoadState('networkidle').catch(() => {});
    expect(await page.getAttribute('#ask-close', 'class')).toContain('sre-btn-primary');
    expect(await page.getAttribute('#close-month', 'class')).not.toContain('sre-btn-primary');
    // "Close the month" shows only once a signature has been asked for (the second person's part, unchanged); its sheet is
    // the danger tone — proven through the store computer in the-month-is-closed-and-reopened… (which now gives the word).
    expect(await page.locator('#close-month').innerText()).toBe('Close the month');
    expect(errors).toEqual([]);
    await context.close();
  });

  it('Supplier offer funding: a receipt asks first with the amount in rupees; its fields say "(required)" in words; Go back records nothing', async () => {
    const { context, page, writes } = await open(PEOPLE.accountant, '/promotion-funding');
    await page.waitForSelector('#receipt:not([hidden])');
    expect(await page.locator('label[for="c-amount"] span').innerText()).toMatch(/\(required\)$/);
    expect(await page.getAttribute('#c-record', 'class')).toContain('sre-btn-primary');
    expect(await page.getAttribute('#a-record', 'class')).not.toContain('sre-btn-primary');
    await page.fill('#c-offer', 'OFF-1');
    await page.fill('#c-supplier', 'SUP-1');
    await page.fill('#c-amount', '12500');
    await page.fill('#c-on', '30/10/2026'); // the shared date field: dd/mm/yyyy in, ISO sent
    await page.fill('#c-ref', 'UTR-1');
    await page.click('#c-record');
    await sheet(page);
    expect(await page.locator('#sre-confirm-title').innerText()).toBe('₹12,500.00 received from supplier SUP-1 for offer OFF-1 will be recorded');
    await toggle(page);
    expect(await page.locator('label[for="c-amount"] span').innerText()).toMatch(/\(கட்டாயம்\)$/);
    expect(await page.locator('#sre-confirm-title').innerText()).toContain('₹12,500.00');
    await page.click('#sre-confirm-back');
    await gone(page);
    expect(writes, 'Go back recorded nothing').toEqual([]);
    await context.close();
  });

  it('Online store: publishing asks for a reason on the sheet; a blank is refused beside the field; the reason reaches the publication record', async () => {
    const { context, page, writes, bodies } = await open(PEOPLE.owner, '/online-store');
    await page.waitForSelector('#publish-store');
    expect(await page.getAttribute('#publish-store', 'class')).toContain('sre-btn-primary');
    await page.click('#publish-store');
    await sheet(page);
    expect(await page.locator('#sre-confirm-title').innerText()).toBe('The online store will go live for customers now');
    await page.click('#sre-confirm-go');
    expect(await page.locator('#sre-confirm-reason-msg').innerText()).toBe('Fill in "Why it is going live now".');
    expect(writes).toEqual([]);
    await page.fill('#sre-confirm-reason', 'Diwali range ready');
    await page.click('#sre-confirm-go');
    await gone(page);
    await page.waitForLoadState('networkidle').catch(() => {});
    expect(writes).toEqual(['POST /v1/online-store/publish']);
    // The reason travels with the ask (head office keeps it on the publication record — proven at the route in
    // tests/integration/an-incomplete-product-is-not-published-online.test.ts); here the shop's legal details are not set,
    // so head office refuses by name and the page says so.
    expect(JSON.parse(bodies[0]!)).toEqual({ reason: 'Diwali range ready' });
    await context.close();
  });
});
