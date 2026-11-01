import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startInboxShop, ok, OWNER, type InboxShop } from './lib/ai-inbox-shop';

/**
 * **M03-FR-03 (tax side) · A6 · A7 — GST and cess by HSN code on the Products and prices page**, in a real browser, on the
 * PRODUCTION API over real PostgreSQL:
 *
 *   • the owner (who keeps the catalogue) records the FIRST GST rate of an HSN code — head office holds it, and the page
 *     reads the schedule back in plain words;
 *   • a CHANGE (a later rate) is refused in head office's own words (`tax_change_needs_finance_approval`) and nothing is
 *     saved; the page offers to ask a Finance approver for exactly that change; the owner can NOT approve his own request;
 *     the accountant approves it (in her own session, as on her Approvals page); "Save the approved change" then saves it,
 *     naming her approval — and the new rate stands from its date with the old one still on record;
 *   • a compensation cess is recorded; with head office unreachable the page says nothing was saved, and nothing was;
 *   • the words switch to Tamil; a cashier reads the schedule and is offered no way to record.
 *
 * Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */
const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['tax', 'rates', 'e2e', 'signing', 'key'].join('-').padEnd(48, '0');
const CASHIER = 'u-cash';
const ACCOUNTANT = 'u-acc';
const HSN = '04061000';
const TOBACCO = '24022010';

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('tax rates on the catalogue page, on the production API (M03-FR-03)', () => {
  let browser: Browser;
  let shop: InboxShop;
  const schedule = async (hsn: string): Promise<{ effectiveFrom: string; rateBps: number }[]> =>
    ((await shop.cloud().request({ method: 'GET', path: `/v1/catalogue/tax-classes/${hsn}/rates`, userId: OWNER })).body as { schedule: { effectiveFrom: string; rateBps: number }[] }).schedule;
  const cess = async (hsn: string): Promise<unknown[]> =>
    ((await shop.cloud().request({ method: 'GET', path: `/v1/catalogue/tax-classes/${hsn}/cess`, userId: OWNER })).body as { schedule: unknown[] }).schedule;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/catalogue', html: 'catalogue.html', dataGlobal: 'catalogueData', extraData: async () => ({ storeId: 'br-1', products: [] }) },
      seed: async (cloud) => { await cloud.grant(CASHIER, 'cashier'); await cloud.grant(ACCOUNTANT, 'accountant'); },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 300_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  const open = async (who: string) => {
    const context = await browser.newContext();
    await shop.signIn(context, who);
    const page = await context.newPage();
    const writes: string[] = []; const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/v1/') && r.method() !== 'GET') writes.push(`${r.method()} ${u.pathname}`); });
    await page.goto(`${shop.base}/catalogue?tab=tax`, { waitUntil: 'load' });
    return { page, writes, errors, close: () => context.close() };
  };
  const says = async (page: Page, selector: string, expected: RegExp): Promise<void> => {
    await page.waitForFunction(([sel, source]) => new RegExp(source!).test((globalThis as unknown as { document: { querySelector(x: string): { textContent: string | null } | null } }).document.querySelector(sel!)?.textContent ?? ''), [selector, expected.source], { timeout: 15_000 });
  };

  it('a first rate saves; a change is refused, asked, approved by the accountant (never the asker) and then saved naming that approval', async () => {
    const s = await open(OWNER);
    try {
      await s.page.fill('#tax-hsn', HSN);
      await s.page.click('#tax-show');
      await says(s.page, '#tax-gst-list', /No GST rate is recorded for this HSN code/);
      expect(s.writes, 'reading writes nothing').toEqual([]);

      // The first rate is setting the class up — one person.
      await s.page.fill('#tax-gst-from', '2017-07-01');
      await s.page.fill('#tax-gst-rate', '12');
      await s.page.click('#tax-gst-save');
      await says(s.page, '#tax-gst-status', /^Saved at head office\./);
      await says(s.page, '#tax-gst-list [data-from="2017-07-01"]', /GST 12% from 2017-07-01/);
      expect(await schedule(HSN)).toEqual([{ effectiveFrom: '2017-07-01', rateBps: 1200 }]);

      // A change: refused in head office's words, nothing saved; the ask is offered.
      await s.page.fill('#tax-gst-from', '2025-09-22');
      await s.page.fill('#tax-gst-rate', '5');
      await s.page.click('#tax-gst-save');
      await says(s.page, '#tax-gst-status', /^Head office refused: HSN "04061000" already carries 1200 bps .*needs a Finance approver/);
      expect(await schedule(HSN)).toHaveLength(1);
      expect(await s.page.locator('#tax-ask').isVisible()).toBe(true);
      // No reason: nothing is sent.
      const before = s.writes.length;
      await s.page.click('#tax-ask-send');
      await says(s.page, '#tax-gst-status', /^Write why the rate changes/);
      expect(s.writes).toHaveLength(before);
      await s.page.fill('#tax-reason', 'GST 2.0 notification 9/2025');
      await s.page.click('#tax-ask-send');
      await says(s.page, '#tax-gst-status', /^Asked\. A Finance approver/);
      await says(s.page, '#tax-mine', /5% from 2025-09-22 — waiting for a Finance approver/);
      expect(await schedule(HSN)).toHaveLength(1);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }

    // The asker cannot approve his own; the accountant (a Finance approver) does, in her own session.
    const inbox = (await shop.cloud().request({ method: 'GET', path: '/v1/approvals/requests', userId: ACCOUNTANT })).body as { waitingForMe: { requestId: string; kind: string; subjectRef: string }[] };
    const req = inbox.waitingForMe.find((r) => r.kind === 'tax_rate_change' && r.subjectRef === HSN)!;
    expect(req).toBeDefined();
    expect((await shop.cloud().request({ method: 'POST', path: `/v1/approvals/requests/${req.requestId}/decide`, userId: OWNER, idempotencyKey: 'self', body: { decision: 'approved', reason: 'mine' } })).status).toBe(422);
    await ok(shop.cloud().request({ method: 'POST', path: `/v1/approvals/requests/${req.requestId}/decide`, userId: ACCOUNTANT, idempotencyKey: 'acc', body: { decision: 'approved', reason: 'matches the notification' } }), 'approve');

    const t = await open(OWNER);
    try {
      await t.page.fill('#tax-hsn', HSN);
      await t.page.click('#tax-show');
      await says(t.page, '#tax-mine', /5% from 2025-09-22 — approved by u-acc/);
      await t.page.click(`#tax-mine [data-use="${req.requestId}"]`);
      await says(t.page, '#tax-gst-status', /^Saved at head office with the approval of u-acc\./);
      await says(t.page, '#tax-gst-list [data-from="2025-09-22"]', /GST 5% from 2025-09-22/);
      await says(t.page, '#tax-mine', /5% from 2025-09-22 — approved and saved/);
      expect(t.writes).toEqual([`POST /v1/catalogue/tax-classes/${HSN}/rates/2025-09-22`]);
      expect(await schedule(HSN)).toEqual([{ effectiveFrom: '2017-07-01', rateBps: 1200 }, { effectiveFrom: '2025-09-22', rateBps: 500 }]);

      // A compensation cess; then head office unreachable — said, never a success, nothing saved.
      await t.page.fill('#tax-hsn', TOBACCO);
      await t.page.fill('#tax-cess-from', '2026-01-01');
      await t.page.fill('#tax-cess-adv', '36');
      await t.page.fill('#tax-cess-specific', '4170');
      await t.page.fill('#tax-cess-block', '1000');
      await t.page.click('#tax-cess-save');
      await says(t.page, '#tax-cess-status', /^Saved at head office\./);
      await says(t.page, '#tax-cess-list [data-from="2026-01-01"]', /Cess 36% plus ₹4,170\.00 per 1000 from 2026-01-01/);
      await t.page.route('**/v1/catalogue/tax-classes/**', (route) => route.abort());
      await t.page.fill('#tax-cess-from', '2027-01-01');
      await t.page.fill('#tax-cess-adv', '0'); await t.page.fill('#tax-cess-specific', '0');
      await t.page.click('#tax-cess-save');
      await says(t.page, '#tax-cess-status', /^Head office cannot be reached — nothing was saved\./);
      await says(t.page, '#tax-list-status', /^Head office cannot be reached — the schedule could not be read/);
      await t.page.unroute('**/v1/catalogue/tax-classes/**');
      expect(await cess(TOBACCO)).toHaveLength(1);

      await t.page.click('#lang');
      await says(t.page, '#tab-tax', /^வரி விகிதங்கள்/);
      await t.page.click('#tax-show');
      await says(t.page, '#tax-cess-list [data-from="2026-01-01"]', /2026-01-01 முதல் செஸ் 36%/);
      expect(t.errors).toEqual([]);
    } finally { await t.close(); }
  }, 180_000);

  it('a cashier reads the schedule and is offered no way to record a rate', async () => {
    const s = await open(CASHIER);
    try {
      await says(s.page, '#tax-status', /You can read the tax rates; recording one needs the catalogue role\./);
      expect(await s.page.locator('#tax-form').isHidden()).toBe(true);
      await s.page.fill('#tax-hsn', HSN);
      await s.page.click('#tax-show');
      await says(s.page, '#tax-gst-list [data-from="2017-07-01"]', /GST 12% from 2017-07-01/);
      expect(s.writes).toEqual([]);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
    expect((await shop.cloud().request({ method: 'POST', path: `/v1/catalogue/tax-classes/${HSN}/rates/2030-01-01`, userId: CASHIER, idempotencyKey: randomUUID(), body: { rateBps: 1800 } })).status).toBe(403);
  }, 60_000);
});
