import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startOfficeShop, PEOPLE, type OfficeShop } from './lib/office-shop';

/**
 * **U3 (OB-699, 7 Nov 2026): the product's own words read in Tamil on the Tamil screen — through the REAL store computer
 * fed by the REAL head office.** The audit (G2, lanes 1, 3 and 4) found the words that come from the store computer or
 * head office English-only after the toggle: the Today page's notes, every report's name on Reports, the role names on
 * Users, the setup questions on Store setup, the Finance page's state sentence, the morning brief's lines. Each now comes
 * from its source in both languages, and the page shows the reader's:
 *
 *   • Today: the takings note under the first tile is Tamil, and the three typed ids carry a "Choose…" picker (U2c);
 *   • Reports: a report's name and the question it answers;
 *   • Users: the role names in the "give a role" list;
 *   • Store setup: every question;
 *   • Finance: the state sentence when the box has not said what the shop took (or the verdict otherwise);
 *   • Morning brief: the lines head office prepared.
 * Skips where no browser binary is present.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DESK = { viewport: { width: 1280, height: 860 } };
const TAMIL = /[஀-௿]/;

describe.skipIf(!existsSync(CHROMIUM))('U3: the product\'s own words read in Tamil', () => {
  let browser: Browser;
  let shop: OfficeShop;
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
    shop = await startOfficeShop(browser, {
      identityDirectory: { issue: async () => ({ result: 'issued', resumed: false }), end: async () => 'ended' },
    });
  }, 300_000);
  afterAll(async () => { await shop?.stop(); await browser?.close(); });

  const texts = (page: Page, sel: string): Promise<string[]> => page.$$eval(sel, (els) => els.map((e) => (e.textContent ?? '').trim()));
  const open = async (who: string, path: string) => {
    const s = await shop.asPerson(who, DESK as never);
    await s.page.goto(`${shop.base}${path}`, { waitUntil: 'load' });
    await s.page.waitForFunction('globalThis.sreOffice !== undefined');
    return s;
  };
  const toTamil = async (page: Page) => {
    await page.click('#lang');
    await page.waitForFunction('document.documentElement.lang === "ta"');
  };

  it('Today: the takings note is Tamil after the toggle, and the three typed ids pick by name', async () => {
    const { page, errors, context } = await open(PEOPLE.manager, '/manager/');
    await page.waitForSelector('#tiles .tile .note');
    const before = await page.textContent('#tiles .tile:first-child .note');
    expect(before).toMatch(/sales? on this box/);
    await toTamil(page);
    await page.waitForFunction(() => /[஀-௿]/.test((globalThis as unknown as { document: { querySelector(s: string): { textContent: string | null } | null } }).document.querySelector('#tiles .tile:first-child .note')?.textContent ?? ''));
    expect(await page.textContent('#tiles .tile:first-child .note')).toMatch(/இந்தக் கணினியில் \d+ விற்பனை/);
    // U2c: the delivery's item, the count's product and the carry-over's second person each have the picker's button.
    await page.click('#tab-receive');
    await page.waitForSelector('#grn-product-pick');
    expect(await page.textContent('#grn-product-pick')).toBe('தேர்வு…');
    expect(await page.textContent('#grn-product-label')).toBe('பொருள் (பெயர் அல்லது குறியீடு)');
    await page.click('#tab-count');
    await page.waitForSelector('#count-product-pick');
    expect(await page.textContent('#count-product-pick')).toBe('தேர்வு…');
    expect(await page.$('#carry-approver-pick')).not.toBeNull();
    expect(errors).toEqual([]);
    await context.close();
  }, 60_000);

  it('Reports: every report\'s name and purpose read in Tamil', async () => {
    const { page, errors, context } = await open(PEOPLE.accountant, '/reporting/');
    await page.waitForSelector('.row strong');
    expect(await texts(page, '.row strong')).toContain('Sales by day');
    await toTamil(page);
    await page.waitForFunction(() => [...(globalThis as unknown as { document: { querySelectorAll(s: string): Iterable<{ textContent: string | null }> } }).document.querySelectorAll('.row strong')].some((e) => /[஀-௿]/.test(e.textContent ?? '')));
    const names = await texts(page, '.row strong');
    expect(names).toContain('நாள் வாரியான விற்பனை');
    expect(names.filter((n) => !TAMIL.test(n))).toEqual([]);
    expect(errors).toEqual([]);
    await context.close();
  }, 60_000);

  it('Users: the role names read in Tamil', async () => {
    const { page, errors, context } = await open(PEOPLE.owner, '/users');
    await page.waitForFunction(() => (globalThis as unknown as { document: { querySelectorAll(s: string): { length: number } } }).document.querySelectorAll('#g-role option').length > 1);
    expect(await texts(page, '#g-role option')).toContain('Cashier');
    await toTamil(page);
    await page.waitForFunction(() => [...(globalThis as unknown as { document: { querySelectorAll(s: string): Iterable<{ textContent: string | null }> } }).document.querySelectorAll('#g-role option')].some((e) => e.textContent === 'கல்லாவர்'));
    expect(await texts(page, '#g-role option')).toContain('கடை மேலாளர்');
    expect(errors).toEqual([]);
    await context.close();
  }, 60_000);

  it('Store setup: every question reads in Tamil', async () => {
    const { page, errors, context } = await open(PEOPLE.owner, '/setup');
    await page.waitForSelector('strong[id^="q-"]');
    expect((await texts(page, 'strong[id^="q-"]')).some((q) => /GST/.test(q))).toBe(true);
    await toTamil(page);
    await page.waitForFunction(() => [...(globalThis as unknown as { document: { querySelectorAll(s: string): Iterable<{ textContent: string | null }> } }).document.querySelectorAll('strong[id^="q-"]')].every((e) => /[஀-௿]/.test(e.textContent ?? '')));
    const questions = await texts(page, 'strong[id^="q-"]');
    expect(questions.length).toBeGreaterThan(20);
    expect(questions.filter((q) => !TAMIL.test(q))).toEqual([]);
    expect(errors).toEqual([]);
    await context.close();
  }, 60_000);

  it('Finance: the state sentence reads in Tamil', async () => {
    const { page, errors, context } = await open(PEOPLE.accountant, '/finance');
    await page.waitForSelector('#verdict');
    await toTamil(page);
    await page.waitForFunction(() => /[஀-௿]/.test((globalThis as unknown as { document: { getElementById(id: string): { textContent: string | null } | null } }).document.getElementById('verdict')?.textContent ?? ''));
    const verdict = await page.textContent('#verdict');
    expect(verdict).toMatch(TAMIL);
    const empty = await page.$('#totals-list .empty');
    if (empty !== null) {
      // the box has not said what the shop took: the state sentence, in Tamil, at both places it is printed
      expect(await empty.textContent()).toMatch(/இந்தக் கடைக் கணினி/);
      expect(verdict).toMatch(/இந்தக் கடைக் கணினி/);
    }
    expect(errors).toEqual([]);
    await context.close();
  }, 60_000);

  it('Morning brief: the lines head office prepared read in Tamil', async () => {
    const { page, errors, context } = await open(PEOPLE.owner, '/morning-brief');
    await page.waitForSelector('#show');
    await page.click('#show');
    await page.waitForSelector('#lines li');
    expect((await texts(page, '#lines li')).join(' ')).toMatch(/Sales|THESE NUMBERS/);
    await toTamil(page);
    await page.waitForFunction(() => /[஀-௿]/.test((globalThis as unknown as { document: { getElementById(id: string): { textContent: string | null } | null } }).document.getElementById('lines')?.textContent ?? ''));
    const lines = await texts(page, '#lines li');
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.filter((l) => !TAMIL.test(l))).toEqual([]);
    expect(errors).toEqual([]);
    await context.close();
  }, 60_000);
});
