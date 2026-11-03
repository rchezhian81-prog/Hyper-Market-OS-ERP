import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { Pool } from 'pg';
import { startInboxShop, ok, OWNER, MGR, type InboxShop } from './lib/ai-inbox-shop';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { makeEvent } from '../../packages/contracts/src/event';
import { STREAM } from '../../services/api/src/adapters';

/**
 * **W5 — the GST and statutory tax desk, in a real browser, on the PRODUCTION API over real PostgreSQL** (route audit
 * section 2, bundle 2 · API-09 · M23 · M23-FR-02 · OB-683 · A14 · A17 · A18 · A19 · A24 · OB-143 · OB-191 · OB-428 · OB-432 · OB-433 · §28 · §31).
 *
 * The fault first (route audit rows 166–167): the GST returns page used to queue `GstReturnActionRequested` in the browser,
 * and nothing — not the page, not the store computer's sync agent (it has no route for it) — ever sent it to head office,
 * so "Approve" never approved anything. Now: the store manager PREPARES May on the page (head office records its own
 * digest); the owner sees it live, presses Approve (twice, quickly) and head office holds ONE approval by the owner; filing
 * to the portal is shown switched off and never sent.
 *
 * Then the desk: Table 12 from the till's sales (₹300.00 taxable from the two May sales), the GSTN file downloaded with
 * its name (nothing filed), the owner's warning window changed with a reason; the chartered accountant sees reverse charge
 * and TDS "not set", lists a reverse-charge head and a TDS section (and is offered no switch); the owner sees the TDS switch.
 * On the ITC page the owner reads the claim (not reconciled — no GSTR-2B) and records a Rule 42 reversal.
 *
 * Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['w5', 'gst', 'desk', 'key'].join('-').padEnd(48, '0');
const GSTIN = '33ABCDE1234F1Z5';
const CA = 'u-ca';

interface Doc { querySelector(s: string): { textContent: string | null } | null; querySelectorAll(s: string): { length: number } }
const textOf = (page: Page, sel: string) => page.evaluate((s) => (globalThis as unknown as { document: Doc }).document.querySelector(s)?.textContent ?? '', sel);
const countOf = (page: Page, sel: string) => page.evaluate((s) => (globalThis as unknown as { document: Doc }).document.querySelectorAll(s).length, sel);

const sale = (saleId: string, productId: string, qty: number, lineTotalMinor: number, tradingDay: string, hsnCode: string, taxRateBps: number) => ({
  saleId, receiptNumber: `R-${saleId}`, laneId: 'lane-1', cashierId: OWNER, tradingDay, committedAt: `${tradingDay}T05:30:00Z`,
  totalMinor: lineTotalMinor, currency: 'INR', packVersion: 1,
  lines: [{ productId, quantityMinor: qty, uom: 'each', unitPriceMinor: lineTotalMinor / qty, lineTotalMinor, hsnCode, taxRateBps }],
  tenders: [{ kind: 'cash', amountMinor: lineTotalMinor }],
});

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('W5: the GST and tax desk on the production API, in a real browser', () => {
  let browser: Browser;
  let shop: InboxShop;

  const tenantId = randomUUID();

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId, signingKey: KEY,
      page: { path: '/gst-returns', html: 'gst-returns.html', dataGlobal: 'gstReturnsData' },
      alsoPages: [{ path: '/itc-review', html: 'itc-review.html', dataGlobal: 'itcReviewData' }],
      seed: async (cloud) => {
        await ok(cloud.request({ method: 'POST', path: '/v1/sales', userId: OWNER, idempotencyKey: 's-1', body: sale('S-1', 'p-paneer', 2, 21_000, '2026-05-10', '040610', 500) }), 'sale 1');
        await ok(cloud.request({ method: 'POST', path: '/v1/sales', userId: OWNER, idempotencyKey: 's-2', body: sale('S-2', 'p-ghee', 1, 11_800, '2026-05-12', '040590', 1800) }), 'sale 2');
        // The CA's role holds what no approver in a fresh shop holds (finance.rcm.configure, finance.tds.configure), so a
        // two-person grant cannot lay it down here; the operator lays it down as the test harness does (synthetic tenant).
        const pool = new Pool({ connectionString: DATABASE_URL!, max: 1, options: '-c app.tenant_id=*' });
        try {
          await new SqlEventStore(pgPoolClient(pool)).append(tenantId, STREAM.identity, makeEvent({
            id: `grant-chartered_accountant-${CA}`, type: 'RoleGranted', occurredAt: new Date().toISOString(),
            idempotencyKey: `grant-${tenantId}-chartered_accountant-${CA}`, source: 'test/provision',
            payload: { userId: CA, roleId: 'chartered_accountant', branchScope: 'all', request: { grantId: `chartered_accountant-${CA}`, userId: CA, roleId: 'chartered_accountant', branchScope: 'all', requestedBy: 'test', approvedBy: 'test', requestedAt: new Date().toISOString() } },
          }));
        } finally { await pool.end(); }
      },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 180_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  it('rows 161–167: the manager prepares May, the owner approves it ONCE at head office, and filing stays switched off', async () => {
    // The maker: the store manager prepares May for approval on the page.
    const mgr = await browser.newContext();
    await shop.signIn(mgr, MGR, 'br-1');
    const m = await mgr.newPage();
    try {
      await m.goto(`${shop.base}/gst-returns`, { waitUntil: 'load' });
      await m.locator('#prepare:not([hidden])').waitFor({ timeout: 15_000 });
      await m.fill('#prepare-period', '052026');
      await m.click('#prepare-btn');
      await expect.poll(() => textOf(m, '#act-result'), { timeout: 15_000 }).toBe('Prepared — waiting for a second person to approve: 052026');
      // The maker cannot approve (and holds no approve role) — the button says why.
      await expect.poll(() => countOf(m, '#rows li .do[data-act="approve"] button:disabled'), { timeout: 15_000 }).toBe(1);
    } finally { await mgr.close(); }
    const prepared = (await shop.cloud().request({ method: 'GET', path: '/v1/finance/gstr1/submission/052026', userId: OWNER })).body as { state: string; previewedBy: string; returnDigest: string };
    expect(prepared).toMatchObject({ state: 'previewed', previewedBy: MGR });
    const g3b = (await shop.cloud().request({ method: 'GET', path: '/v1/finance/gstr3b/052026', userId: OWNER })).body as { gstr1PreviewDigest: string };
    expect(prepared.returnDigest).toBe(g3b.gstr1PreviewDigest); // head office's own digest, never the page's

    // The checker: the owner sees it live and approves — two quick presses are ONE approval at head office.
    const ctx = await browser.newContext();
    await shop.signIn(ctx, OWNER);
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const posts: string[] = [];
    page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/v1/finance/gstr1/submission/')) posts.push(new URL(r.url()).pathname); });
    try {
      await page.goto(`${shop.base}/gst-returns`, { waitUntil: 'load' });
      const approve = page.locator('#rows li .do[data-act="approve"] button');
      await approve.waitFor({ timeout: 15_000 });
      await expect.poll(() => approve.isEnabled(), { timeout: 15_000 }).toBe(true);
      await approve.dblclick();
      await expect.poll(() => textOf(page, '#act-result'), { timeout: 15_000 }).toBe('Approved: 052026');
      await expect.poll(() => textOf(page, '#rows li .status'), { timeout: 15_000 }).toBe('Approved — ready to file');
      // Filing to the portal: shown, switched off, never sent.
      const file = page.locator('#rows li .do[data-act="submit"]');
      expect(await file.locator('button').isDisabled()).toBe(true);
      expect(await file.locator('.do-note').textContent()).toBe('Filing to the GST portal is switched off. Nothing is filed from this page.');
      expect(posts).toEqual(['/v1/finance/gstr1/submission/052026/approve']);
      // Nothing was queued in the browser for a relay that does not exist.
      expect(await page.evaluate(() => (globalThis as unknown as { localStorage: { getItem(k: string): string | null } }).localStorage.getItem('sre.gst-returns-outbox'))).toBeNull();
      expect(errors).toEqual([]);
    } finally { await ctx.close(); }
    const approved = (await shop.cloud().request({ method: 'GET', path: '/v1/finance/gstr1/submission/052026', userId: OWNER })).body as { state: string; approvedBy: string };
    expect(approved).toMatchObject({ state: 'approved', approvedBy: OWNER });
  }, 120_000);

  it('OB-683 · M23-FR-02: the owner uploaded May on the portal by hand and records its ARN — refused in words when empty or malformed, then "Filed by hand on the portal"', async () => {
    const ARN = 'AA330626012345X';
    const ctx = await browser.newContext();
    await shop.signIn(ctx, OWNER);
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const posts: string[] = [];
    page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/v1/finance/gstr1/submission/')) posts.push(new URL(r.url()).pathname); });
    try {
      await page.goto(`${shop.base}/gst-returns`, { waitUntil: 'load' });
      const hand = page.locator('#rows li .do[data-act="fileByHand"]');
      await hand.locator('button').waitFor({ timeout: 15_000 });
      await expect.poll(() => hand.locator('button').isEnabled(), { timeout: 15_000 }).toBe(true);
      // Nothing typed: refused on the page, nothing sent.
      await hand.locator('button').click();
      await expect.poll(() => textOf(page, '#act-result'), { timeout: 15_000 }).toBe('Type the acknowledgement number (ARN) the GST portal showed. Nothing was sent.');
      // A malformed one: refused in words, nothing sent.
      await hand.locator('input[name="arn"]').fill('SANDBOX-052026');
      await hand.locator('button').click();
      await expect.poll(() => textOf(page, '#act-result'), { timeout: 15_000 }).toMatch(/^That is not an ARN the GST portal gives\./);
      expect(posts).toEqual([]);
      // The portal's ARN, as he copied it (small letters, a space): recorded once at head office.
      await page.locator('#rows li .do[data-act="fileByHand"] input[name="arn"]').fill('aa33 0626012345x');
      await page.locator('#rows li .do[data-act="fileByHand"] button').click();
      await expect.poll(() => textOf(page, '#act-result'), { timeout: 15_000 }).toBe('Recorded as filed by hand on the portal: 052026');
      await expect.poll(() => textOf(page, '#rows li .status'), { timeout: 15_000 }).toBe('Filed by hand on the portal');
      expect(posts).toEqual(['/v1/finance/gstr1/submission/052026/filed-by-hand']);
      expect(await countOf(page, '#rows li .do[data-act="fileByHand"]')).toBe(0); // filed: nothing left to do
      expect(errors).toEqual([]);
      const filed = (await shop.cloud().request({ method: 'GET', path: '/v1/finance/gstr1/submission/052026', userId: OWNER })).body as { state: string; arn: string; filedByHand: { by: string; name: string } };
      expect(filed).toMatchObject({ state: 'filed', arn: ARN, filedByHand: { by: OWNER } });
      await expect.poll(() => textOf(page, '#rows li .filed-by-hand'), { timeout: 15_000 }).toBe(`Filed by hand on the portal · Portal reference ${ARN} · recorded by ${filed.filedByHand.name}`);
      // After a reload it still says so — head office's record, not the page's.
      await page.reload({ waitUntil: 'load' });
      await expect.poll(() => textOf(page, '#rows li .filed-by-hand'), { timeout: 15_000 }).toContain(ARN);
    } finally { await ctx.close(); }
  }, 120_000);

  it('rows 150, 155–158: Table 12 from the till, the GSTN file to upload by hand, and the owner\'s warning window', async () => {
    const ctx = await browser.newContext({ acceptDownloads: true });
    await shop.signIn(ctx, OWNER);
    const page = await ctx.newPage();
    try {
      await page.goto(`${shop.base}/gst-returns`, { waitUntil: 'load' });
      await page.locator('#g1-form').waitFor({ timeout: 15_000 });
      await page.fill('#g1-month', '052026');
      // No turnover typed: refused on the page — never a default.
      await page.click('#g1-t12s');
      await expect.poll(() => textOf(page, '#g1-said'), { timeout: 15_000 }).toBe('Write the annual turnover in rupees.');
      await page.fill('#g1-turnover', '7,50,00,000');
      await page.click('#g1-t12s');
      await expect.poll(() => textOf(page, '#g1-out [data-part="from-sales"]'), { timeout: 15_000 }).toContain('net of returns: taxable ₹300.00');
      expect(await textOf(page, '#g1-out [data-part="from-sales"]')).toContain('2 sold lines');
      await page.click('#g1-return');
      await page.locator('#g1-return li[data-part="totals"]').waitFor({ timeout: 15_000 });

      await page.fill('#g1-gstin', GSTIN.toLowerCase());
      const [download] = await Promise.all([page.waitForEvent('download', { timeout: 15_000 }), page.click('#g1-file')]);
      expect(download.suggestedFilename()).toBe(`GSTR1_${GSTIN}_052026.json`);
      await expect.poll(() => textOf(page, '#g1-said'), { timeout: 15_000 }).toContain('Nothing was filed.');

      // The owner's warning window (OB-191: 180 days until he changes it, with a reason).
      await page.fill('#tb-days', '90');
      await page.click('#tb-save');
      await expect.poll(() => textOf(page, '#tb-said'), { timeout: 15_000 }).toBe('Write the reason first.');
      await page.fill('#tb-reason', 'the CA asked for a shorter warning');
      await page.click('#tb-save');
      await expect.poll(() => textOf(page, '#tb-said'), { timeout: 15_000 }).toBe('Warning window now: 90');
      await page.reload({ waitUntil: 'load' });
      await expect.poll(() => textOf(page, '#controls li[data-control="time-bar-warning-days"] .word'), { timeout: 15_000 }).toBe('90 days');
      // The TDS switch is the owner's.
      await page.locator('#tds-on').waitFor({ timeout: 15_000 });
    } finally { await ctx.close(); }
  }, 120_000);

  it('rows 151–152, 242: the CA sees reverse charge and TDS "not set", fills them, and is offered no switch (OB-143)', async () => {
    const ctx = await browser.newContext();
    await shop.signIn(ctx, CA);
    const page = await ctx.newPage();
    try {
      await page.goto(`${shop.base}/gst-returns`, { waitUntil: 'load' });
      await expect.poll(() => textOf(page, '#rcm-state'), { timeout: 15_000 }).toBe('SWITCHED OFF — NOT SET — the CA has not listed any head yet');
      await expect.poll(() => countOf(page, '#tds-sections li[data-section="none"]'), { timeout: 15_000 }).toBe(1);
      expect(await countOf(page, '#tds-on')).toBe(0);
      expect(await countOf(page, '#prepare:not([hidden])')).toBe(0); // OB-192: the CA prepares nothing

      await page.fill('#rcm-code', 'gta');
      await page.fill('#rcm-name', 'Goods transport agency');
      await page.fill('#rcm-rate', '5');
      await page.fill('#rcm-cite', 'Notfn 13/2017-CT(R) entry 1');
      await page.click('#rcm-head-save');
      await expect.poll(() => textOf(page, '#rcm-said'), { timeout: 15_000 }).toBe('Head saved: GTA');
      await expect.poll(() => textOf(page, '#rcm-heads li[data-head="GTA"] .word'), { timeout: 15_000 }).toBe('GTA — Goods transport agency · 5%');

      await page.fill('#tds-sec', '194c');
      await page.fill('#tds-label', 'Payments to contractors');
      await page.fill('#tds-rate', '1');
      await page.fill('#tds-single', '30,000');
      await page.click('#tds-sec-add');
      await page.click('#tds-save');
      await expect.poll(() => textOf(page, '#tds-said'), { timeout: 15_000 }).toBe('The CA\'s list saved — version 1');
      await page.reload({ waitUntil: 'load' });
      await expect.poll(() => textOf(page, '#tds-sections li[data-section="194C"] .word'), { timeout: 15_000 }).toBe('194C — Payments to contractors · 1%');
      await expect.poll(() => textOf(page, '#rcm-state'), { timeout: 15_000 }).toBe('SWITCHED OFF');
    } finally { await ctx.close(); }
    const tds = (await shop.cloud().request({ method: 'GET', path: '/v1/finance/tds', userId: OWNER })).body as { enabled: boolean; config: { version: number; setBy: string } };
    expect(tds).toMatchObject({ enabled: false, config: { version: 1, setBy: CA } });
  }, 120_000);

  it('rows 180–181: on the ITC page the owner reads the claim and records a Rule 42 reversal', async () => {
    const ctx = await browser.newContext();
    await shop.signIn(ctx, OWNER);
    const page = await ctx.newPage();
    try {
      await page.goto(`${shop.base}/itc-review?period=2026-05`, { waitUntil: 'load' });
      await expect.poll(() => page.getAttribute('#claim-line', 'data-status'), { timeout: 15_000 }).toBe('not_reconciled');
      await page.selectOption('#rev-rule', 'rule_42');
      await page.fill('#rev-source', 'INV-7 cleaning material');
      await page.fill('#rev-reason', 'used for the staff canteen');
      await page.fill('#rev-cgst', '45');
      await page.fill('#rev-sgst', '45');
      await page.click('#rev-save');
      await expect.poll(() => textOf(page, '#rev-said'), { timeout: 15_000 }).toMatch(/^Reversal recorded: REV-/);
      await expect.poll(() => countOf(page, '#rev-rows li[data-rule="rule_42"]'), { timeout: 15_000 }).toBe(1);
      expect(await textOf(page, '#rev-rows li[data-rule="rule_42"]')).toContain('₹90.00');
    } finally { await ctx.close(); }
  }, 120_000);
});
