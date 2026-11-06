import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser } from 'playwright-core';
import { auditPage } from './lib/a11y-audit';
import { startOfficeShop, PEOPLE, type OfficeShop } from './lib/office-shop';

/**
 * **A privilege moves only through the shared confirm sheet (OB-694 A, 2 Nov 2026 · UI/UX gap audit G4 · design system
 * §1 rule 3 · §27.1 "destructive/financial actions show consequence, authorization and confirmation").**
 *
 * On the REAL store computer fed by the REAL head office, the owner lends the manager's refund authority to the
 * accountant on the Delegation page. Before anything is sent the sheet says what will happen (who, what, until when, the
 * cap), in whose name, and asks to confirm; the focus lands on Go back; Escape is Go back; the page then says "Nothing
 * was lent" and head office received NOTHING. Toggled to Tamil while open, the sheet's words follow. Confirmed, exactly
 * one delegation reaches head office. The sheet passes the audit (contrast, 44px targets, names, one h1 on the page).
 * The Staff schedule's commit takes the same road in `the-schedule-page-meets-the-spec.e2e.ts`.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DESK = { viewport: { width: 1280, height: 860 } };
const day = (plus: number): string => new Date(Date.now() + plus * 86_400_000).toISOString().slice(0, 10);
// U2: the dates are the shared dd/mm field; the sheet says them in words.
const ddmm = (d: string): string => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const words = (d: string): string => `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;

describe.skipIf(!existsSync(CHROMIUM))('U1: the Delegation page asks to confirm before authority is lent', () => {
  let browser: Browser;
  let shop: OfficeShop;
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
    shop = await startOfficeShop(browser);
  }, 300_000);
  afterAll(async () => { await shop?.stop(); await browser?.close(); });

  it('the sheet names the person, the kind, the dates and the cap; Go back and Escape send nothing; Confirm sends once; Tamil follows', async () => {
    const s = await shop.asPerson(PEOPLE.owner, DESK);
    const posts: string[] = [];
    s.page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/v1/access/delegations/')) posts.push(new URL(r.url()).pathname); });
    try {
      await s.page.goto(`${shop.base}/delegation`, { waitUntil: 'load' });
      await s.page.waitForFunction('globalThis.sreOffice !== undefined && typeof globalThis.sreOffice.confirm === "function"');
      const fill = async () => {
        await s.page.fill('#from', PEOPLE.manager);
        await s.page.fill('#to', PEOPLE.accountant);
        await s.page.fill('#from-date', ddmm(day(0)));
        await s.page.fill('#until-date', ddmm(day(10)));
        await s.page.fill('#cap', '2000');
        await s.page.check('input[name="kind"][value="refund"]');
        await s.page.fill('#reason', 'Manager on leave for ten days');
      };
      await fill();
      await s.page.click('#lend');
      const sheet = s.page.locator('#sre-confirm');
      await sheet.waitFor({ timeout: 15_000 });
      expect(await s.page.textContent('#sre-confirm-title')).toBe(`${PEOPLE.accountant} will be able to decide Refunds as ${PEOPLE.manager}, from ${words(day(0))} until ${words(day(10))}, up to ₹2000.00.`);
      expect(await s.page.textContent('#sre-confirm .sre-confirm-authority')).toMatch(/Authorised by you — a different person from the lender/);
      expect(await s.page.textContent('#sre-confirm-go')).toBe('Lend this authority');
      expect(await s.page.evaluate('document.activeElement && document.activeElement.id'), 'the safe choice has the focus').toBe('sre-confirm-back');
      expect(posts, 'nothing is sent while the sheet is open').toEqual([]);
      expect(await auditPage(s.page), 'the sheet passes the audit').toEqual([]);

      // Escape is Go back.
      await s.page.keyboard.press('Escape');
      await sheet.waitFor({ state: 'detached', timeout: 15_000 });
      expect(await s.page.textContent('#lend-status')).toBe('Nothing was lent.');
      expect(posts).toEqual([]);

      // Go back, by the button.
      await s.page.click('#lend');
      await sheet.waitFor({ timeout: 15_000 });
      await s.page.click('#sre-confirm-back');
      await sheet.waitFor({ state: 'detached', timeout: 15_000 });
      expect(posts).toEqual([]);

      // Tamil follows while the sheet is open; then Confirm sends exactly once.
      await s.page.click('#lend');
      await sheet.waitFor({ timeout: 15_000 });
      // The toggle sits under the sheet's scrim (the sheet is modal), so the language is switched as the toggle does it.
      await s.page.evaluate("document.documentElement.lang = 'ta'");
      await expect.poll(() => s.page.textContent('#sre-confirm-title')).toMatch(/[஀-௿]/);
      expect(await s.page.textContent('#sre-confirm-go')).toBe('இந்த அதிகாரத்தை வழங்கு');
      await s.page.evaluate("document.documentElement.lang = 'en'");
      await s.page.click('#sre-confirm-go');
      await expect.poll(() => s.page.textContent('#lend-status')).toMatch(/^Lent — head office recorded it, authorised by you/);
      expect(posts).toHaveLength(1);
      expect(s.errors).toEqual([]);
    } finally { await s.context.close(); }
  });

  it('without the chrome the page refuses to lend rather than skip the sheet (P-08)', async () => {
    const s = await shop.asPerson(PEOPLE.owner, DESK);
    const posts: string[] = [];
    s.page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/v1/access/delegations/')) posts.push(r.url()); });
    try {
      await s.page.goto(`${shop.base}/delegation`, { waitUntil: 'load' });
      await s.page.waitForFunction('globalThis.sreOffice !== undefined');
      await s.page.evaluate('delete globalThis.sreOffice');
      await s.page.fill('#from', PEOPLE.manager); await s.page.fill('#to', PEOPLE.accountant);
      await s.page.fill('#from-date', ddmm(day(0))); await s.page.fill('#until-date', ddmm(day(10)));
      await s.page.check('input[name="kind"][value="refund"]'); await s.page.fill('#reason', 'cover');
      await s.page.click('#lend');
      await expect.poll(() => s.page.textContent('#lend-status')).toMatch(/did not finish loading[\s\S]*Nothing was lent/);
      expect(posts).toEqual([]);
    } finally { await s.context.close(); }
  });
});
