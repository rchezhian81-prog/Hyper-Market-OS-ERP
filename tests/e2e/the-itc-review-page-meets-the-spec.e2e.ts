import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser } from 'playwright-core';
import { startInboxShop, OWNER, MGR, type InboxShop } from './lib/ai-inbox-shop';
import { seedItcShop, october2b, ACCOUNTANT, ITC_PERIOD } from '../support/itc-shop';

/**
 * **R3 · A17 · OB-145 "A" — the accountant's "Input tax credit (GSTR-2B)" page, in a real browser, on the PRODUCTION API
 * over real PostgreSQL.**
 *
 * The shop's October bills are booked and three-way matched through the real routes. Through Chromium the accountant:
 * picks October and is told no GSTR-2B is uploaded and nothing can be claimed; uploads the portal's JSON file; sees every
 * line matched with the books (A/101 and B-77 match, A/102 differs on SGST, B-78 has no bill) and the bill missing from
 * the 2B (B-90); cannot accept the line with no bill (the button is off) and is refused a reject with no reason; accepts,
 * rejects and keeps lines pending; and sees the credit to claim — the accepted lines only — once every line has a person's
 * decision. The page speaks Tamil. A store manager, who may not read the review, is told it cannot be read.
 *
 * Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['itc', 'review', 'e2e', 'key'].join('-').padEnd(48, '0');

interface Doc { querySelectorAll(s: string): { length: number } }

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('Input tax credit review (A17 · OB-145) on the production API, in a real browser', () => {
  let browser: Browser;
  let shop: InboxShop;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/itc-review', html: 'itc-review.html', dataGlobal: 'itcReviewData' },
      seed: async (cloud) => {
        await seedItcShop({
          call: (method, path, userId, body, idempotencyKey) => cloud.request({ method, path, userId, ...(body === undefined ? {} : { body }), ...(idempotencyKey === undefined ? {} : { idempotencyKey }) }),
          owner: OWNER, grant: (u, r) => cloud.grant(u, r), store: 'br-1', createStore: false,
        });
      },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 240_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  it('the accountant uploads the 2B, sees every line matched and every exception, decides each line, and sees only accepted credit claimed', async () => {
    const context = await browser.newContext();
    await shop.signIn(context, ACCOUNTANT);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    try {
      await page.goto(`${shop.base}/itc-review?period=${ITC_PERIOD}`, { waitUntil: 'load' });
      await page.locator('#state:not([hidden])').waitFor({ timeout: 15_000 });
      expect(await page.textContent('#state')).toBe('No GSTR-2B has been uploaded for this month yet.');
      expect(await page.textContent('#claim')).toBe('Not reconciled: no GSTR-2B has been uploaded for 2026-10');

      // Upload the portal's file.
      await page.setInputFiles('#file', { name: 'GSTR2B_102026.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(october2b())) });
      await page.click('#send-file');
      await page.waitForFunction(() => (globalThis as unknown as { document: Doc }).document.querySelectorAll('#rows .row').length === 4, undefined, { timeout: 15_000 });
      expect(await page.textContent('#result')).toBe('Uploaded: 2026-10 — 4 line(s)');
      const row = (no: string) => page.locator(`#rows .row[data-invoice="${no}"]`);
      expect(await row('A/101').locator('.match').textContent()).toBe('Matches the books');
      expect(await row('B-77').locator('.match').textContent()).toBe('Matches the books');
      expect(await row('A/102').locator('.match').textContent()).toBe('Differs from the books — differs on SGST');
      expect(await row('B-78').locator('.match').textContent()).toBe('No bill in the books');
      expect(await row('A/101').locator('.state .word').textContent()).toBe('Awaiting a person');
      expect(await page.locator('#missing-rows .row').count()).toBe(1);
      expect(await page.locator('#missing-rows .row[data-invoice="B-90"]').count()).toBe(1);
      expect(await page.textContent('#claim')).toMatch(/^Not reconciled: 4 line\(s\) of the 2026-10 GSTR-2B are awaiting/);

      // A line with no bill cannot be accepted (head office would refuse it); a reject needs a reason.
      expect(await row('B-78').locator('button.accept').isDisabled()).toBe(true);
      await row('B-78').locator('button.reject').click();
      expect(await page.textContent('#result')).toBe('Write the reason first — a reject or a pending needs one.');

      // Decide every line, as the person signed in.
      await row('A/101').locator('button.accept').click();
      await page.locator('#rows .row[data-invoice="A/101"][data-state="accepted"]').waitFor({ timeout: 15_000 });
      expect(await page.textContent('#result')).toBe('Recorded: A/101 — Accepted');
      await row('B-77').locator('button.accept').click();
      await page.locator('#rows .row[data-invoice="B-77"][data-state="accepted"]').waitFor({ timeout: 15_000 });
      await row('A/102').locator('input.reason').fill('SGST on the paper is ₹440; supplier asked to correct');
      await row('A/102').locator('button.keep').click();
      await page.locator('#rows .row[data-invoice="A/102"][data-state="pending"]').waitFor({ timeout: 15_000 });
      await row('B-78').locator('input.reason').fill('no such bill received');
      await row('B-78').locator('button.reject').click();
      await page.locator('#rows .row[data-invoice="B-78"][data-state="rejected"]').waitFor({ timeout: 15_000 });
      expect(await row('B-78').locator('.facts').textContent()).toContain(`By: ${ACCOUNTANT} — no such bill received`);

      // Every line decided: the credit to claim is the accepted lines only — CGST ₹900 + SGST ₹900 + IGST ₹240.
      expect(await page.textContent('#claim')).toBe('Reconciled — Credit to claim: ₹2,040.00');
      expect(await page.locator('.panel[data-panel="pending"] .v').textContent()).toBe('₹900.00');
      expect(await page.locator('.panel[data-panel="rejected"] .v').textContent()).toBe('₹120.00');

      // Tamil words for the same page.
      await page.click('#lang');
      expect(await page.textContent('#title')).toBe('உள்ளீட்டு வரி வரவு');
      expect(await row('A/101').locator('.state .word').textContent()).toBe('ஏற்கப்பட்டது');
      expect(errors).toEqual([]);
    } finally { await context.close(); }

    // Head office holds the decisions and the claim.
    const claim = (await shop.cloud().request({ method: 'GET', path: `/v1/finance/itc/${ITC_PERIOD}/claim`, userId: OWNER })).body as { claim: Record<string, unknown> };
    expect(claim.claim).toMatchObject({ status: 'reconciled', igstMinor: 24_000, cgstMinor: 90_000, sgstMinor: 90_000, cessMinor: 0 });
  }, 180_000);

  it('a store manager may not read the review — the page says it cannot be read', async () => {
    const context = await browser.newContext();
    await shop.signIn(context, MGR, 'br-1');
    const page = await context.newPage();
    try {
      await page.goto(`${shop.base}/itc-review?period=${ITC_PERIOD}`, { waitUntil: 'load' });
      await page.locator('#state:not([hidden])').waitFor({ timeout: 15_000 });
      expect(await page.textContent('#state')).toBe('The ITC review could not be read from head office. Nothing here is current.');
      expect(await page.locator('#rows .row').count()).toBe(0);
    } finally { await context.close(); }
  }, 60_000);
});
