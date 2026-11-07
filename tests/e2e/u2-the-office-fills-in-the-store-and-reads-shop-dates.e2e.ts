import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser } from 'playwright-core';
import { auditPage } from './lib/a11y-audit';
import { startOfficeShop, PEOPLE, type OfficeShop } from './lib/office-shop';

/**
 * **U2 (UI/UX gap audit, 2 Nov 2026) — group D, on the REAL store computer fed by the REAL head office (G5 · G14 · G10 ·
 * P-07 · P-08 · NFR-08).**
 *
 *   • The Floor heat map and Dispatch open with the signed-in person's own store filled in and said by NAME beside the
 *     field ("SRE Hyper Market — your store"), in English and, after the toggle, in Tamil; the page still sends the id.
 *   • A date is written as a shop person writes it (dd/mm/yyyy): 31/02/2026 is refused beside the field and sends nothing;
 *     01/10/2026 is sent to head office as 2026-10-01. The Day book opens on yesterday shown the same way. The Tally files
 *     month is a named list of the last 24 months, in the reader's language.
 *   • A plain view's refusal carries the three parts: an unknown tax class on GST and cess rates says what happened, that
 *     nothing was changed, and what to do — never "status 404".
 *   • The audit stays clean with the shared fields on the page, at a desk and on a phone.
 * Skips where no browser binary is present.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DESK = { viewport: { width: 1280, height: 860 } };
const PHONE = { viewport: { width: 360, height: 640 }, hasTouch: true, isMobile: true };

describe.skipIf(!existsSync(CHROMIUM))('U2: the office fills in the store and reads dates as a shop person writes them', () => {
  let browser: Browser;
  let shop: OfficeShop;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
    shop = await startOfficeShop(browser);
  }, 300_000);
  afterAll(async () => { await shop?.stop(); await browser?.close(); });

  const open = async (who: string, path: string, device = DESK) => {
    const s = await shop.asPerson(who, device);
    await s.page.goto(`${shop.base}${path}`, { waitUntil: 'load' });
    await s.page.waitForFunction('globalThis.sreChrome !== undefined && globalThis.sreOffice !== undefined');
    await s.page.waitForLoadState('networkidle');
    return s;
  };

  it('Floor heat map: the store is filled in and named; a wrong date is refused; a right one is sent as ISO; Tamil follows', async () => {
    const { page, context, errors } = await open(PEOPLE.manager, '/floor-heat-map');
    // the store computer's own store, by id in the field and by name beside it
    expect(await page.inputValue('#store')).toBe('S1');
    await expect.poll(() => page.locator('#store-own').innerText()).toMatch(/SRE Hyper Market — your store/);
    // the shared date field: a text a shop person writes, not the browser's own date widget
    expect(await page.getAttribute('#from', 'type')).toBe('text');
    expect(await page.getAttribute('#from', 'placeholder')).toBe('dd/mm/yyyy');
    expect(await page.locator('label[for="from"]').innerText()).toMatch(/^From/);
    // 31 February is refused beside the field and gives no date
    await page.fill('#from', '31/02/2026');
    await page.locator('#from').blur();
    const msg = page.locator('#from').locator('xpath=ancestor::*[contains(@class,"sre-field")][1]').locator('.sre-field-msg');
    await expect.poll(() => msg.isVisible()).toBe(true);
    expect(await page.evaluate(() => (globalThis as unknown as { sreOffice: { dateValue(id: string): string | null } }).sreOffice.dateValue('from'))).toBeNull();
    // a real date goes to head office as ISO, for the store the page filled in
    await page.fill('#from', '01/10/2026');
    await page.fill('#to', '31/10/2026');
    const asked: string[] = [];
    page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.includes('/heat-map')) asked.push(`${u.pathname}${u.search}`); });
    await page.click('#show');
    await expect.poll(() => asked.length).toBeGreaterThan(0);
    expect(asked[0]).toMatch(/\/v1\/merchandising\/stores\/S1\/heat-map\?/);
    expect(asked[0]).toContain('from=2026-10-01');
    expect(asked[0]).toContain('to=2026-10-31');
    // Tamil: the note and the shared field's label follow the toggle; the typed date stays
    await page.click('#lang');
    await expect.poll(() => page.locator('#store-own').innerText()).toMatch(/உங்கள் கடை/);
    await expect.poll(() => page.locator('label[for="from"]').innerText()).toMatch(/^முதல்/);
    expect(await page.inputValue('#from')).toBe('01/10/2026');
    expect(await auditPage(page, { expectLang: 'ta' })).toEqual([]);
    expect(errors).toEqual([]);
    await context.close();
  });

  it('Dispatch and the Day book: the store named, the run date and the trading day as dd/mm/yyyy; clean on a phone', async () => {
    const dispatch = await open(PEOPLE.manager, '/dispatch', PHONE);
    expect(await dispatch.page.inputValue('#store')).toBe('S1');
    await expect.poll(() => dispatch.page.locator('#store-own').innerText()).toMatch(/SRE Hyper Market/);
    expect(await dispatch.page.getAttribute('#run-date', 'placeholder')).toBe('dd/mm/yyyy');
    expect(await dispatch.page.locator('label[for="run-date"]').innerText()).not.toMatch(/YYYY/);
    expect(await auditPage(dispatch.page)).toEqual([]);
    expect(dispatch.errors).toEqual([]);
    await dispatch.context.close();

    const book = await open(PEOPLE.accountant, '/day-book');
    // yesterday in the shop's calendar, shown as a shop person writes it; the page still holds it as ISO
    expect(await book.page.inputValue('#day')).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
    const iso = await book.page.evaluate(() => (globalThis as unknown as { sreOffice: { dateValue(id: string): string | null } }).sreOffice.dateValue('day'));
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(await auditPage(book.page)).toEqual([]);
    expect(book.errors).toEqual([]);
    await book.context.close();
  });

  it('Tally files: the month is picked from a named list of the last 24 months, in the reader\'s language', async () => {
    const { page, context, errors } = await open(PEOPLE.accountant, '/tally-files');
    expect(await page.locator('#tb-month').evaluate((e) => e.tagName)).toBe('SELECT');
    const options = await page.locator('#tb-month option').allTextContents();
    expect(options).toHaveLength(24);
    expect(options[0]).toMatch(/^(January|February|March|April|May|June|July|August|September|October|November|December) \d{4}$/);
    expect(await page.locator('#tb-month option').first().getAttribute('value')).toMatch(/^\d{4}-\d{2}$/);
    await page.click('#lang');
    await expect.poll(() => page.locator('#tb-month option').first().innerText()).toMatch(/[஀-௿]/);
    expect(errors).toEqual([]);
    await context.close();
  });

  it('a plain view\'s refusal carries the three parts: an unknown tax class on GST and cess rates, never a bare status', async () => {
    const { page, context, errors } = await open(PEOPLE.owner, '/tax-rates');
    // Head office's answer is pinned here so the proof is of the PAGE's wiring: a refusal with a code and no sentence —
    // the case that used to print "Head office refused: 404". (A later page.route wins over the harness's catch-all.)
    await page.route('**/v1/catalogue/tax-classes/9999/rates', (route) => route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: { code: 'not_found' } }) }));
    await page.fill('#hsn', '9999');
    await page.click('#open');
    await expect.poll(() => page.locator('#record-status').innerText()).toMatch(/Nothing was changed/);
    const said = await page.locator('#record-status').innerText();
    expect(said).toMatch(/^Head office refused: /);
    expect(said).not.toMatch(/status 404|unreadable_answer|\b404\b/);
    // and in Tamil, the same three parts in Tamil
    await page.click('#lang');
    await page.click('#open');
    await expect.poll(() => page.locator('#record-status').innerText()).toMatch(/எதுவும் மாற்றப்படவில்லை/);
    expect(errors).toEqual([]);
    await context.close();
  });
});
