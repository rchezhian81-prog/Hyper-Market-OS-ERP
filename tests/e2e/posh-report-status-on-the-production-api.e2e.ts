import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser } from 'playwright-core';
import { startInboxShop, ok, OWNER, MGR, type InboxShop } from './lib/ai-inbox-shop';
import { actionDetails } from '../../services/identity/src/approval-requests';

/**
 * **R2 addendum C20 · OB-154 "A" — the owner's "Committee annual report" page, in a real browser, on the PRODUCTION API
 * over real PostgreSQL.**
 *
 * The committee member is added the way OB-165 says (the owner asks, a second person confirms). Through Chromium the owner:
 * sees last year's report as due or overdue and "not made yet"; tries to record it filed — head office refuses (there is
 * no report to file) and the page says so; after the committee makes the report, sees its COUNTS (never a complaint's
 * words) and records the filing with the District Officer's acknowledgement — the year moves to "Filed" and nothing is
 * due. The page speaks Tamil. A store manager, who may not read the report, is told the status cannot be read.
 *
 * Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['posh', 'report', 'e2e', 'key'].join('-').padEnd(48, '0');
const IC = 'u-ic-e2e';
const SUMMARY = 'SYNTHETIC-E2E-COMPLAINT-WORDS';
const YEAR = new Date().getUTCFullYear() - 1;
const TODAY = new Date().toISOString().slice(0, 10);
const STATE = TODAY <= `${YEAR + 1}-01-31` ? 'Due' : 'Overdue';

interface Doc { querySelectorAll(s: string): { length: number } }

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('Committee annual report (C20 · OB-154) on the production API, in a real browser', () => {
  let browser: Browser;
  let shop: InboxShop;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/posh-report', html: 'posh-report.html', dataGlobal: 'poshReportData' },
      seed: async (cloud) => {
        // OB-165: the owner adds a committee member; the second initial admin (u-hr) confirms in their own session.
        const change = { action: 'add', userId: IC, reason: 'synthetic: the committee is set up' };
        const asked = await cloud.request({ method: 'POST', path: '/v1/approvals/requests', userId: OWNER, idempotencyKey: 'ask-ic', body: { kind: 'posh_committee_change', subjectRef: 'IC-1', details: actionDetails(change, { changeId: 'IC-1' }), valueMinor: null, summary: 'add a committee member', reason: 'synthetic' } });
        if (asked.status !== 201) throw new Error(`ask: ${asked.status} ${JSON.stringify(asked.body)}`);
        const requestId = (asked.body as { requestId: string }).requestId;
        await ok(cloud.request({ method: 'POST', path: `/v1/approvals/requests/${requestId}/decide`, userId: 'u-hr', idempotencyKey: 'decide-ic', body: { decision: 'approved', reason: 'confirmed' } }), 'confirm');
        await ok(cloud.request({ method: 'POST', path: '/v1/identity/internal-committee/changes/IC-1', userId: OWNER, idempotencyKey: 'add-ic', body: { ...change, approvalId: requestId } }), 'add member');
        // One complaint received last year (synthetic) — the owner will see it only as a count.
        await ok(cloud.request({ method: 'POST', path: '/v1/hr/posh/complaints', userId: IC, idempotencyKey: 'c-1', body: { receivedOn: `${YEAR}-06-01`, complainantRef: 'SYN-A', respondentRef: 'SYN-B', summary: SUMMARY } }), 'receive');
      },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 180_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  it('the owner sees the report due, is refused filing a report not made, then records the filing once the committee makes it', async () => {
    const context = await browser.newContext();
    await shop.signIn(context, OWNER);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    try {
      await page.goto(`${shop.base}/posh-report`, { waitUntil: 'load' });
      await page.waitForFunction(() => (globalThis as unknown as { document: Doc }).document.querySelectorAll('#rows .row').length === 1, undefined, { timeout: 15_000 });
      expect(await page.textContent('#summary')).toBe('1 report(s) not filed');
      const row = page.locator(`#rows .row[data-year="${YEAR}"]`);
      expect(await row.locator('.state .word').textContent()).toContain(STATE);
      expect(await row.locator('.facts').textContent()).toContain('The committee has not made this report yet');
      expect(await row.locator('.facts').textContent()).toContain(`Due by: ${YEAR + 1}-01-31`);

      // Filing a report the committee has not made: head office refuses, the page says so, the year stays open.
      await row.locator('input.reference').fill('DO-ACK-SYNTH-1');
      await row.locator('button.record').click();
      await page.locator('#result.tone-error').waitFor({ timeout: 15_000 });
      expect(await page.textContent('#result')).toMatch(/Not recorded: No annual report has been generated/);
      expect(await page.locator('#rows .row').count()).toBe(1);

      // The committee makes the report; the owner sees its counts — never the complaint's words.
      await ok(shop.cloud().request({ method: 'POST', path: `/v1/hr/posh/annual-reports/${YEAR}`, userId: IC, idempotencyKey: 'gen', body: {} }), 'generate');
      await page.reload({ waitUntil: 'load' });
      await page.locator(`#rows .row[data-year="${YEAR}"] .count`).first().waitFor({ timeout: 15_000 });
      const ready = page.locator(`#rows .row[data-year="${YEAR}"]`);
      const facts = await ready.locator('.facts').textContent();
      expect(facts).toContain('The committee has made this report');
      expect(facts).toContain('Received: 1');
      expect(facts).toContain('Still open at year end: 1');
      expect(await page.content()).not.toContain(SUMMARY);
      expect(await page.content()).not.toContain('SYN-A');

      // Recorded as filed: the year moves to Filed and nothing is due.
      await ready.locator('input.reference').fill('DO-ACK-SYNTH-1');
      await ready.locator('button.record').click();
      await page.locator(`#done-rows .row[data-year="${YEAR}"]`).waitFor({ timeout: 15_000 });
      expect(await page.textContent('#result')).toMatch(new RegExp(`Recorded as filed: ${YEAR}`));
      expect(await page.textContent('#summary')).toBe('Nothing is due — every year that has ended is recorded as filed.');
      expect(await page.locator(`#done-rows .row[data-year="${YEAR}"] .facts`).textContent()).toContain(`Filed on: ${TODAY}`);

      // Tamil words for the same page.
      await page.click('#lang');
      expect(await page.textContent('#done-heading')).toBe('சமர்ப்பிக்கப்பட்டவை');
      expect(errors).toEqual([]);
    } finally { await context.close(); }

    // Head office holds the filing.
    const status = (await shop.cloud().request({ method: 'GET', path: '/v1/hr/posh/annual-report-status', userId: OWNER })).body as { exceptions: unknown[]; filed: { year: number }[] };
    expect(status.exceptions).toEqual([]);
    expect(status.filed.map((f) => f.year)).toEqual([YEAR]);
  }, 120_000);

  it('a store manager may not read the report status — the page says it cannot be read', async () => {
    const context = await browser.newContext();
    await shop.signIn(context, MGR, 'br-1');
    const page = await context.newPage();
    try {
      await page.goto(`${shop.base}/posh-report`, { waitUntil: 'load' });
      await page.locator('#state:not([hidden])').waitFor({ timeout: 15_000 });
      expect(await page.textContent('#state')).toBe('The report status could not be read from head office. Nothing here is current.');
      expect(await page.locator('#rows .row').count()).toBe(0);
    } finally { await context.close(); }
  }, 60_000);
});
