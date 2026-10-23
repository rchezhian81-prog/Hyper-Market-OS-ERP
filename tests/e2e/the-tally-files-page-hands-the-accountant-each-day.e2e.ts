import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser } from 'playwright-core';
import { startInboxShop, ok, MGR, type InboxShop } from './lib/ai-inbox-shop';
import { DEFAULT_RETAIL_POSTING_MAP } from '../../packages/finance/src/index';
import { validateTallyImport } from '../../packages/tally-export/src/index';

/**
 * OB-293 (owner, 23 Oct 2026: "a daily Tally import file first") · M23-FR-04 · M32-FR-04 — the Tally files page, in a
 * real browser, on the PRODUCTION API over real PostgreSQL (synthetic data). Nothing is read on open. The accountant
 * sees the dead letter FIRST — the day whose petty-cash journal touches a ledger nobody named, with that reason in words
 * — and every ended day's file with what it carries; downloads a ready day as Tally XML (which Tally's import check
 * accepts); once the ledger is named, requeues the dead day with what was fixed (a requeue without words is refused on
 * the page) and makes the files; reads the month's trial balance, balanced; Tamil. A store manager reads but cannot make
 * or requeue; a cashier reads nothing. Needs DATABASE_URL and Chromium; else it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['tally', 'e2e', 'signing', 'key'].join('-').padEnd(48, '0');
const dayAgo = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const DAY_OK = dayAgo(3);
const DAY_DEAD = dayAgo(2);

const sale = (saleId: string, day: string, totalMinor: number) => ({
  saleId, receiptNumber: `R-${saleId}`, laneId: 'lane-1', cashierId: 'u-cash', tradingDay: day, committedAt: `${day}T06:30:00.000Z`,
  totalMinor, currency: 'INR', packVersion: 1,
  lines: [{ productId: 'P1', quantityMinor: 1, uom: 'each', unitPriceMinor: totalMinor, lineTotalMinor: totalMinor, taxRateBps: 1800 }],
  tenders: [{ kind: 'cash', amountMinor: totalMinor }],
});

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('the Tally files page (OB-293) on the production API, in a real browser', () => {
  let browser: Browser;
  let shop: InboxShop;
  let accounts: string[] = [];
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/tally-files', html: 'tally-files.html', dataGlobal: 'tallyFilesData' },
      seed: async (cloud) => {
        await cloud.grant('u-acc', 'accountant');
        await cloud.grant('u-cash', 'cashier');
        await ok(cloud.request({ method: 'POST', path: '/v1/sales', userId: 'u-cash', idempotencyKey: 'bank-S1', body: sale('S1', DAY_OK, 118_000) }), 'sale S1');
        await ok(cloud.request({ method: 'POST', path: '/v1/sales', userId: 'u-cash', idempotencyKey: 'bank-S2', body: sale('S2', DAY_DEAD, 59_000) }), 'sale S2');
        await ok(cloud.request({ method: 'PUT', path: '/v1/finance/posting-map', userId: 'u-acc', idempotencyKey: 'map', body: DEFAULT_RETAIL_POSTING_MAP }), 'posting map');
        for (const d of [DAY_OK, DAY_DEAD]) await ok(cloud.request({ method: 'POST', path: `/v1/finance/day-book/${d}/post`, userId: 'u-acc', idempotencyKey: `db-${d}`, body: {} }), `day book ${d}`);
        await ok(cloud.request({
          method: 'POST', path: '/v1/finance/journals', userId: 'u-acc', idempotencyKey: 'petty',
          body: { entryId: 'manual-petty-1', period: DAY_DEAD.slice(0, 7), documentDate: DAY_DEAD, narrative: 'Petty cash spent on shop cleaning, voucher PC-7 (synthetic)', postedBy: 'u-acc',
            lines: [{ accountCode: 'shop_expenses', debitMinor: 5_000, creditMinor: 0 }, { accountCode: 'cash_in_hand', debitMinor: 0, creditMinor: 5_000 }] },
        }), 'petty cash journal');
        const tb = (await cloud.request({ method: 'GET', path: `/v1/finance/periods/${DAY_DEAD.slice(0, 7)}/trial-balance`, userId: 'u-acc' })).body as { rows: { account: string }[] };
        accounts = tb.rows.map((r) => r.account);
        // Every ledger named but the petty-cash one: that day goes to the dead letter, the other is ready.
        await ok(cloud.request({ method: 'POST', path: '/v1/finance/tally/ledger-names', userId: 'u-acc', idempotencyKey: 'names-1',
          body: { companyName: 'SRE Hyper Market (synthetic)', names: Object.fromEntries(accounts.filter((a) => a !== 'shop_expenses').map((a) => [a, `Tally ${a}`])) } }), 'ledger names');
        await ok(cloud.request({ method: 'POST', path: '/v1/finance/tally/outbox/run', userId: 'u-acc', idempotencyKey: 'run-1', body: {} }), 'first run');
      },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 300_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  it('dead letter first with its reason; a ready day downloads as importable Tally XML; requeue with words, make, trial balance; Tamil; the manager and the cashier', async () => {
    const context = await browser.newContext({ acceptDownloads: true });
    await shop.signIn(context, 'u-acc');
    const page = await context.newPage();
    const reads: string[] = []; const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/v1/')) reads.push(`${r.method()} ${u.pathname}`); });
    await page.goto(`${shop.base}/tally-files`, { waitUntil: 'load' });
    expect(reads, 'nothing is read on open').toEqual([]);
    await page.click('#read');
    await page.locator('#dead li.row').first().waitFor({ timeout: 15_000 });
    const dead = page.locator(`#dead li.row[data-day="${DAY_DEAD}"]`);
    expect(await dead.getAttribute('data-state')).toBe('dead_lettered');
    expect(await dead.locator('.why').innerText()).toMatch(/⚠ Why: .*shop_expenses/);
    expect(await page.textContent('#dead-n')).toBe('⚠ 1');
    expect(await page.textContent('#posted-n')).toBe('✓ 1');
    expect(await page.textContent('#company-n')).toBe('SRE Hyper Market (synthetic)');
    const ready = page.locator(`#files li.row[data-day="${DAY_OK}"]`);
    expect(await ready.getAttribute('data-state')).toBe('posted');
    expect(await ready.innerText()).toMatch(/✓ Day .* — Ready to import/);

    // Download the ready day: the XML Tally imports, and head office's own import check accepts it.
    const download = page.waitForEvent('download');
    await ready.locator('button', { hasText: 'Download for Tally' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe(`sre-tally-${DAY_OK}-01.xml`);
    const xml = readFileSync((await file.path())!, 'utf8');
    expect(xml).toContain('<TALLYMESSAGE');
    expect(validateTallyImport(xml).ok, 'Tally would import it').toBe(true);
    expect(await page.textContent('#page-status')).toBe(`✓ Saved as sre-tally-${DAY_OK}-01.xml`);

    // A requeue with no words is refused on the page; the ledger is named; requeued with what was fixed; made.
    await dead.locator('button', { hasText: 'Requeue this day' }).click();
    expect(await page.textContent('#page-status')).toBe('Say what you fixed before requeueing.');
    await ok(shop.cloud().request({ method: 'POST', path: '/v1/finance/tally/ledger-names', userId: 'u-acc', idempotencyKey: 'names-2',
      body: { companyName: 'SRE Hyper Market (synthetic)', names: Object.fromEntries(accounts.map((a) => [a, `Tally ${a}`])) } }), 'all ledger names');
    await dead.locator('input.reason').fill('Named the Tally ledger for shop expenses');
    await dead.locator('button', { hasText: 'Requeue this day' }).click();
    await page.locator('#page-status', { hasText: '✓ Requeued as' }).waitFor({ timeout: 15_000 });
    expect(await page.textContent('#page-status')).toBe(`✓ Requeued as tally-day:${DAY_DEAD}:1:r1`);
    await page.click('#run');
    await page.locator('#page-status', { hasText: '✓ Done' }).waitFor({ timeout: 15_000 });
    expect(await page.textContent('#page-status')).toBe('✓ Done — files made: ✓ 1 · ⚠ 0');
    const fixed = page.locator(`#files li.row[data-posting="tally-day:${DAY_DEAD}:1:r1"]`);
    expect(await fixed.getAttribute('data-state')).toBe('posted');
    expect(await fixed.innerText()).toMatch(new RegExp(`↺ Requeued from tally-day:${DAY_DEAD}:1`));
    // The original stays on the record, in the dead letter's history (never deleted).
    expect(await page.locator(`#files li.row[data-posting="tally-day:${DAY_DEAD}:1"]`).getAttribute('data-state')).toBe('dead_lettered');

    // The month's trial balance, balanced; a month written wrong is refused on the page.
    await page.fill('#tb-month', '2026-13');
    await page.click('#tb-read');
    expect(await page.textContent('#tb-status')).toBe('Write the month as YYYY-MM.');
    await page.fill('#tb-month', DAY_DEAD.slice(0, 7));
    await page.click('#tb-read');
    await page.locator('#tb-rows tr').first().waitFor({ timeout: 15_000 });
    expect(await page.textContent('#tb-status')).toBe('✓ Balanced — debit and credit agree to the paisa.');
    expect(await page.locator('#tb-rows tr[data-account="shop_expenses"] td').nth(2).innerText()).toBe('₹50.00');

    await page.click('#lang');
    expect(await page.textContent('#page-h')).toBe('டேலி கோப்புகள்');
    expect(await page.textContent('#tb-status')).toBe('✓ Balanced — debit and credit agree to the paisa.'); // a past answer is not re-worded
    expect(await fixed.innerText()).toMatch(/இறக்குமதிக்குத் தயார்/);
    expect(errors).toEqual([]);
    await context.close();

    // The store manager reads but cannot make or requeue; the cashier reads nothing.
    const m = await browser.newContext();
    await shop.signIn(m, MGR, 'br-1');
    const pm = await m.newPage();
    await pm.goto(`${shop.base}/tally-files`, { waitUntil: 'load' });
    expect(await pm.isDisabled('#run')).toBe(true);
    await pm.click('#read');
    await pm.locator('#files li.row').first().waitFor({ timeout: 15_000 });
    // The dead-lettered day stays on the record, now named with the requeue that carried it — and nothing waits.
    expect(await pm.locator(`#dead li.row[data-day="${DAY_DEAD}"] .corrected`).innerText()).toBe(`↺ Requeued as tally-day:${DAY_DEAD}:1:r1 — ✓ Ready to import`);
    expect(await pm.textContent('#dead-n')).toBe('✓ 0');
    expect(await pm.locator('button', { hasText: 'Requeue this day' }).count()).toBe(0);
    await m.close();

    const c = await browser.newContext();
    await shop.signIn(c, 'u-cash');
    const pc = await c.newPage();
    await pc.goto(`${shop.base}/tally-files`, { waitUntil: 'load' });
    expect(await pc.textContent('#page-status')).toBe('Your role cannot read the books.');
    expect(await pc.isDisabled('#read')).toBe(true);
    await c.close();
  }, 240_000);
});
