import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser } from 'playwright-core';
import { startInboxShop, type InboxShop } from './lib/ai-inbox-shop';

/**
 * M02-FR-01/02 (OB-288 lane 1 · P1) — the Access review page, in a real browser, on the PRODUCTION API over real
 * PostgreSQL: nothing is read on open; the accountant sees who holds which role, where and up to how much (the store
 * manager's ₹5,000 refund limit, the cashier's ₹0), the rows that need a look first with their reason in words; the
 * permission matrix saves as a CSV; Tamil; a cashier reads nothing. Needs DATABASE_URL and Chromium; else it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['access', 'e2e', 'signing', 'key'].join('-').padEnd(48, '0');

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('the Access review page (M02-FR-01/02) on the production API, in a real browser', () => {
  let browser: Browser;
  let shop: InboxShop;
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/access-review', html: 'access-review.html', dataGlobal: 'accessReviewData' },
      seed: async (cloud) => { await cloud.grant('u-acc', 'accountant'); await cloud.grant('u-cash', 'cashier'); },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 300_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  it('lists who holds what, where and up to how much, the ones that need a look first; saves the matrix; English and Tamil; a cashier reads nothing', async () => {
    const context = await browser.newContext({ acceptDownloads: true });
    await shop.signIn(context, 'u-acc');
    const page = await context.newPage();
    const reads: string[] = []; const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/v1/')) reads.push(`${r.method()} ${u.pathname}`); });
    await page.goto(`${shop.base}/access-review`, { waitUntil: 'load' });
    expect(reads, 'nothing is read on open').toEqual([]);
    await page.click('#read');
    await page.locator('#rows li.row').first().waitFor({ timeout: 15_000 });
    const cash = page.locator('#rows li.row[data-user="u-cash"]');
    expect(await cash.locator('.limits').innerText()).toMatch(/Refund ✓ ₹0\.00/);
    const mgr = page.locator('#rows li.row[data-user="u-mgr-br1"]');
    expect(await mgr.innerText()).toMatch(/Store manager — Where: br-1 · all departments/);
    expect(await mgr.locator('.limits').innerText()).toMatch(/Refund ✓ ₹5,000\.00 · Purchase order ✓ ₹25,000\.00 · Stock adjustment ✓ ₹2,000\.00/);
    // The seeded people hold roles with no sign-in given at head office — flagged, in words, and listed first.
    expect(await page.locator('#rows li.row').first().getAttribute('data-flags')).toMatch(/holds_roles_with_no_sign_in/);
    expect(await page.locator('#rows li.row[data-user="u-owner"] .flags').innerText()).toMatch(/⚠ Holds a role, but head office gave this name no sign-in/);
    expect(await page.textContent('#last-sign-in')).toBe('Last sign-in: kept by the identity server, not by head office.');
    const download = page.waitForEvent('download');
    await page.click('#export');
    expect((await download).suggestedFilename()).toMatch(/^permission-matrix-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(await page.textContent('#page-status')).toMatch(/^✓ The permission matrix is saved as permission-matrix-/);
    await page.click('#lang');
    expect(await page.textContent('#page-h')).toBe('அணுகல் மீளாய்வு');
    expect(await mgr.innerText()).toMatch(/br-1 · எல்லாத் துறைகளும்/);
    expect(errors).toEqual([]);
    await context.close();

    const c = await browser.newContext();
    await shop.signIn(c, 'u-cash');
    const p2 = await c.newPage();
    await p2.goto(`${shop.base}/access-review`, { waitUntil: 'load' });
    expect(await p2.textContent('#page-status')).toBe('Your role cannot read the access review.');
    expect(await p2.isDisabled('#read')).toBe(true);
    await c.close();
  }, 180_000);
});
