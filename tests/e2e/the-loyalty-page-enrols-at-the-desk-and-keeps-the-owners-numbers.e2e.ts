import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser } from 'playwright-core';
import { startInboxShop, OWNER, MGR, type InboxShop } from './lib/ai-inbox-shop';

/**
 * OB-329 (the desk enrols with an OPTIONAL name) · OB-295 (tiers and points expiry, "not set" until the owner enters them,
 * the CA's note beside expiry) — the Loyalty page, in a real browser, on the PRODUCTION API over real PostgreSQL:
 *   • the enrolment notice is read out first, in English and Tamil, marked a DRAFT until the owner signs it;
 *   • enrolling refuses on the page until the customer's yes and the number seen on their phone are ticked; a skipped name
 *     stays "not on record"; a given one is kept; the desk then finds the member — points, "tiers: not set", "expiry: not set";
 *   • the owner enters two tiers and 12 months' expiry (a save without a reason is refused); the member then shows the tier
 *     their 12-month spend reaches; the expiry run says what it did;
 *   • OB-351: the two referral rewards read "not set — nothing is given" until the owner enters them (rupees, with a reason);
 *   • a store manager reads the programme but cannot change it (the owner-only line is shown, the saves are off).
 * Needs DATABASE_URL and Chromium; else it SKIPS.
 */
const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['loyalty', 'desk', 'e2e', 'key'].join('-').padEnd(48, '0');

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('the Loyalty page (OB-329 · OB-295) on the production API, in a real browser', () => {
  let browser: Browser;
  let shop: InboxShop;
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/loyalty', html: 'loyalty.html', dataGlobal: 'loyaltyDeskData' },
      seed: async () => {},
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 300_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  it('the notice first; enrol with the yes and the number seen, the name optional; find; the owner\'s tiers and expiry; Tamil; a manager reads only', async () => {
    const errors: string[] = [];
    const owner = await browser.newContext();
    try {
      await shop.signIn(owner, OWNER, 'br-1');
      const page = await owner.newPage();
      page.on('pageerror', (e) => { errors.push(String(e)); });
      const writes: string[] = [];
      page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/v1/') && r.method() !== 'GET') writes.push(`${r.method()} ${u.pathname}${u.search}`); });
      await page.goto(`${shop.base}/loyalty`, { waitUntil: 'load' });
      await page.locator('#notice-text', { hasText: 'Joining SRE Hyper Market loyalty' }).waitFor({ timeout: 15_000 });
      expect(await page.isVisible('#notice-draft')).toBe(true);
      expect(await page.textContent('#notice-draft')).toBe('⚠ DRAFT — waiting for the owner\'s signature');

      // Refused on the page until both ticks; nothing sent.
      await page.fill('#enrol-mobile', '98400 77701');
      await page.click('#enrol');
      expect(await page.textContent('#enrol-status')).toBe('⚠ Enrol only on the customer\'s yes. Tick it once they have said yes. Nothing was sent.');
      await page.check('#enrol-yes');
      await page.click('#enrol');
      expect(await page.textContent('#enrol-status')).toBe('⚠ Look at the number on the customer\'s own phone and tick the box. Nothing was sent.');
      expect(writes).toEqual([]);
      await page.check('#enrol-seen');
      await page.click('#enrol');
      await page.locator('#enrol-status', { hasText: '✓' }).waitFor({ timeout: 15_000 });
      expect(await page.textContent('#enrol-status')).toBe('✓ Enrolled — member ending 7701. Name not on record — the customer chose not to give one.');
      // The number travelled in a body, never a URL.
      expect(writes.every((w) => !w.includes('98400'))).toBe(true);
      await page.fill('#enrol-mobile', '98400 77702');
      await page.fill('#enrol-name', 'Lakshmi R');
      await page.check('#enrol-yes'); await page.check('#enrol-seen');
      await page.click('#enrol');
      await page.locator('#enrol-status', { hasText: '7702' }).waitFor({ timeout: 15_000 });
      expect(await page.textContent('#enrol-status')).toBe('✓ Enrolled — member ending 7702. Name kept with the membership.');

      // Find: points, tiers not set, expiry not set.
      await page.fill('#find-mobile', '9840077701');
      await page.click('#find');
      await page.locator('#found li.row').waitFor({ timeout: 15_000 });
      expect(await page.textContent('#found li.row strong')).toBe('✓ Member ending 7701 — 0 points');
      expect(await page.textContent('#found .tier')).toBe('○ Tiers: not set');
      expect(await page.textContent('#found .expiry')).toBe('○ Expiry: not set');

      // The programme: not set, with the CA's note; the owner enters two tiers and 12 months.
      expect(await page.getAttribute('#tiers-say', 'data-state')).toBe('not_set');
      expect(await page.textContent('#tiers-say')).toMatch(/^○ Tiers: not set\./);
      expect(await page.getAttribute('#expiry-say', 'data-state')).toBe('not_set');
      expect(await page.textContent('#ca-text')).toMatch(/Chartered Accountant must confirm how expired points are booked/);
      await page.click('#add-tier');
      await page.click('#add-tier');
      const rows = page.locator('#tier-rows .tier-row');
      await rows.nth(0).locator('.tier-name').fill('Silver'); await rows.nth(0).locator('.tier-name-ta').fill('வெள்ளி');
      await rows.nth(0).locator('.tier-spend').fill('10000'); await rows.nth(0).locator('.tier-multiplier').fill('1.5');
      await rows.nth(1).locator('.tier-name').fill('Gold'); await rows.nth(1).locator('.tier-spend').fill('50000'); await rows.nth(1).locator('.tier-multiplier').fill('2');
      await page.click('#save-tiers');
      expect(await page.textContent('#tiers-status')).toBe('⚠ Say why first. Nothing was sent.');
      await page.fill('#tiers-reason', 'OB-295 numbers (synthetic)');
      await page.click('#save-tiers');
      await page.locator('#tiers-status', { hasText: '✓' }).waitFor({ timeout: 15_000 });
      expect(await page.getAttribute('#tiers-say', 'data-state')).toBe('set');
      expect(await page.textContent('#tiers-say')).toMatch(/^✓ 2 tier\(s\) by 12-month spend\. · Last set by u-owner/);
      await page.fill('#expiry-months', '12');
      await page.fill('#expiry-reason', 'OB-295 numbers (synthetic)');
      await page.click('#save-expiry');
      await page.locator('#expiry-status', { hasText: '✓' }).waitFor({ timeout: 15_000 });
      expect(await page.textContent('#expiry-say')).toMatch(/^✓ Points expire 12 month\(s\) after they are earned, oldest first\./);
      await page.click('#run-expiry');
      await page.locator('#expiry-status', { hasText: 'Expiry run' }).waitFor({ timeout: 15_000 });
      expect(await page.textContent('#expiry-status')).toBe('✓ Expiry run: No points were due to expire (points expire 12 month(s) after they were earned).');
      // The member now shows no tier yet (no spend) and nothing waiting to expire.
      await page.click('#find');
      await page.locator('#found .tier', { hasText: 'No tier yet' }).waitFor({ timeout: 15_000 });
      expect(await page.textContent('#found .next')).toBe('↑ ₹10,000.00 more to reach Silver');
      // ── OB-351: the referral rewards, each "not set" — nothing is given — until the owner enters it.
      await page.locator('#referral-say[data-referrer="not_set"][data-referred="not_set"]').waitFor({ timeout: 15_000 });
      expect(await page.textContent('#referral-say')).toBe('○ The customer who referred earns: not set — nothing is given · The new customer earns: not set — nothing is given');
      await page.fill('#referrer-rupees', '5o');
      await page.click('#save-referral');
      expect(await page.textContent('#referral-status')).toBe('⚠ Enter a reward in rupees (for example 50 or 25.50) in at least one box. 0 means no reward on that side. Nothing was sent.');
      await page.fill('#referrer-rupees', '50');
      await page.click('#save-referral');
      expect(await page.textContent('#referral-status')).toBe('⚠ Say why first. Nothing was sent.');
      await page.fill('#referral-reason', 'launch the referral programme');
      await page.click('#save-referral');
      await page.locator('#referral-say[data-referrer="set"]').waitFor({ timeout: 15_000 });
      expect(await page.textContent('#referral-say')).toMatch(/^○ The customer who referred earns: ₹50\.00 · The new customer earns: not set — nothing is given · Last set by /);
      // Icons beside the words.
      for (const id of ['enrol', 'find', 'save-tiers', 'save-expiry', 'run-expiry', 'save-referral']) expect(await page.locator(`#${id} svg.sre-icon`).count(), id).toBe(1);

      await page.click('#lang');
      expect(await page.textContent('#enrol-h')).toBe('வாடிக்கையாளரைச் சேர்');
      expect(await page.textContent('#notice-text')).toMatch(/^SRE ஹைப்பர் மார்க்கெட் லாயல்டியில் சேருதல்/);
      expect(await page.textContent('#ca-text')).toMatch(/பட்டயக் கணக்காளர்/);
      expect(await page.textContent('#referral-h')).toBe('பரிந்துரைப் பரிசுகள்');
      expect(errors).toEqual([]);
    } finally { await owner.close(); }

    const mgr = await browser.newContext();
    try {
      await shop.signIn(mgr, MGR, 'br-1');
      const page = await mgr.newPage();
      await page.goto(`${shop.base}/loyalty`, { waitUntil: 'load' });
      await page.locator('#tiers-say[data-state="set"]').waitFor({ timeout: 15_000 });
      expect(await page.isVisible('#owner-only')).toBe(true);
      expect(await page.textContent('#owner-only')).toBe('○ Only the owner can change these numbers.');
      for (const id of ['save-tiers', 'save-expiry', 'add-tier', 'save-referral']) expect(await page.isDisabled(`#${id}`), id).toBe(true);
      await page.locator('#referral-say[data-referrer="set"]').waitFor({ timeout: 15_000 }); // the manager reads the rewards
      expect(await page.isDisabled('#enrol')).toBe(false);
    } finally { await mgr.close(); }
  });
});
