import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startInboxShop, ok, OWNER, type InboxShop } from './lib/ai-inbox-shop';

/**
 * OB-290 / OB-292 / OB-291 (owner, 23 Oct 2026) — the Approval rules page, in a real browser, on the PRODUCTION API over
 * real PostgreSQL, in English and Tamil:
 *
 *   • MONEY LIMITS: opening writes and reads nothing; the owner's ladder shows (∞ Unlimited, ₹2,000.00, ○ Not set); the
 *     accountant asks for the store manager's adjustment limit to be ₹3,000; it waits; the owner approves in his own
 *     session; the accountant applies it; it is in force at version 1 and reads back after an API restart;
 *   • ESCALATION WAITS: the store manager asks for the refund wait to be 90 minutes; the owner approves; applied;
 *   • PRICE-CHECK SIZE: the accountant asks for 5% / ₹25; the owner approves; applied (the API's refusal of a larger change
 *     is proven in tests/integration/p1-money-limits-escalation-and-price-check.test.ts);
 *   • a cashier cannot read the rules; every page shows its words in Tamil.
 *
 * Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['rules', 'e2e', 'signing', 'key'].join('-').padEnd(48, '0');
const ACC = 'u-acc'; const SM = 'u-hr'; const CASH = 'u-cash';

type Doc = { document: { getElementById(x: string): { textContent: string | null } | null; querySelector(x: string): { getAttribute(a: string): string | null } | null } };

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('the Approval rules page (OB-290/291/292) on the production API, in a real browser', () => {
  let browser: Browser;
  let shop: InboxShop;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/approval-rules', html: 'approval-rules.html', dataGlobal: 'approvalRulesData' },
      seed: async (cloud) => { await cloud.grant(ACC, 'accountant'); await cloud.grant(CASH, 'cashier'); },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 300_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  const open = async (who: string) => {
    const context = await browser.newContext();
    await shop.signIn(context, who);
    const page = await context.newPage();
    const writes: string[] = []; const reads: string[] = []; const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => { const u = new URL(r.url()); if (!u.pathname.startsWith('/v1/')) return; (r.method() === 'GET' ? reads : writes).push(`${r.method()} ${u.pathname}`); });
    await page.goto(`${shop.base}/approval-rules`, { waitUntil: 'load' });
    return { page, writes, reads, errors, close: () => context.close() };
  };
  const showRules = async (page: Page): Promise<void> => {
    await page.click('#read');
    await page.locator('#limits-body tr').first().waitFor({ timeout: 15_000 });
  };
  const waitStatus = (page: Page, id: string, pattern: RegExp) => page.waitForFunction(([i, src]) => new RegExp(src as string).test((globalThis as unknown as Doc).document.getElementById(i as string)?.textContent ?? ''), [id, pattern.source], { timeout: 15_000 });
  /** The owner approves the one waiting rule change in his own session (as he would on the Approvals page). */
  const ownerApproves = async (): Promise<void> => {
    const inbox = (await shop.cloud().request({ method: 'GET', path: '/v1/approvals/requests', userId: OWNER })).body as { waitingForMe: { requestId: string; kind: string }[] };
    const r = inbox.waitingForMe.find((x) => x.kind === 'approval_rule_change')!;
    await ok(shop.cloud().request({ method: 'POST', path: `/v1/approvals/requests/${r.requestId}/decide`, userId: OWNER, idempotencyKey: `own-${r.requestId}`, body: { decision: 'approved', reason: 'agreed' } }), 'owner approves');
  };
  const applyApproved = async (page: Page): Promise<void> => {
    await page.click('#read');
    await page.locator('#asked li.row[data-status="approved"] button.apply').waitFor({ timeout: 15_000 });
    await page.click('#asked li.row[data-status="approved"] button.apply');
    await waitStatus(page, 'asked-status', /Applied|செயல்படுத்தப்பட்டது/);
  };

  it('money limits: the ladder shows; the accountant asks; the owner approves; applied, in force, kept across a restart — English and Tamil', async () => {
    let s = await open(ACC);
    try {
      expect(s.writes, 'nothing is written on open').toEqual([]);
      expect(s.reads, 'nothing is read before the person asks').toEqual([]);
      await showRules(s.page);
      const cell = (role: string, kind: string) => s.page.locator(`#limits-body tr[data-role="${role}"] .now[data-kind="${kind}"]`).innerText();
      expect(await cell('owner', 'refund')).toBe('∞ Unlimited');
      expect(await cell('store_manager', 'stock_adjustment')).toBe('✓ ₹2,000.00');
      expect(await cell('accountant', 'refund')).toBe('○ Not set');
      expect(await s.page.textContent('#limits-meta')).toMatch(/Version 0 · The owner's figures of 23 Oct 2026/);
      // No reason → refused on the screen, nothing sent.
      await s.page.fill('#limit-store_manager-stock_adjustment', '3000');
      const before = s.writes.length;
      await s.page.click('#limits-ask');
      expect(await s.page.textContent('#limits-status')).toBe('Say, in writing, why.');
      expect(s.writes.length).toBe(before);
      await s.page.fill('#limits-reason', 'more write-offs at Diwali');
      await s.page.click('#limits-ask');
      await waitStatus(s.page, 'limits-status', /Asked\./);
      expect(await s.page.locator('#asked li.row[data-status="waiting"]').innerText()).toMatch(/Money limits — Waiting for the owner/);
      await ownerApproves();
      await applyApproved(s.page);
      expect(await cell('store_manager', 'stock_adjustment')).toBe('✓ ₹3,000.00');
      expect(await s.page.textContent('#limits-meta')).toMatch(/Version 1 · Changed by u-acc/);
      await s.page.click('#lang');
      expect(await s.page.textContent('#limits-h')).toBe('பண வரம்புகள்');
      expect(await cell('accountant', 'refund')).toBe('○ அமைக்கப்படவில்லை');
      expect(await cell('owner', 'refund')).toBe('∞ வரம்பு இல்லை');
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }

    await shop.restart();
    s = await open(ACC);
    try {
      await showRules(s.page);
      expect(await s.page.locator('#limits-body tr[data-role="store_manager"] .now[data-kind="stock_adjustment"]').innerText()).toBe('✓ ₹3,000.00');
      expect(await s.page.textContent('#limits-meta')).toMatch(/Version 1/);
    } finally { await s.close(); }
  }, 240_000);

  it('escalation waits: the store manager asks for a 90-minute refund wait; the owner approves; applied — English and Tamil', async () => {
    const s = await open(SM);
    try {
      await showRules(s.page);
      expect(await s.page.locator('#waits-form .now[data-kind="refund"]').innerText()).toBe('⏱ 60 minutes (1 hour)');
      expect(await s.page.locator('#waits-form .now[data-kind="stock_adjustment"]').innerText()).toBe('⏱ 2880 minutes (48 hours)');
      await s.page.fill('#wait-refund', '0');
      await s.page.click('#waits-ask');
      expect(await s.page.textContent('#waits-status')).toBe('Each wait must be a whole number of minutes, at least 1.');
      await s.page.fill('#wait-refund', '90');
      await s.page.fill('#waits-reason', 'the owner is often on the shop floor for an hour');
      await s.page.click('#waits-ask');
      await waitStatus(s.page, 'waits-status', /Asked\./);
      await ownerApproves();
      await applyApproved(s.page);
      expect(await s.page.locator('#waits-form .now[data-kind="refund"]').innerText()).toBe('⏱ 90 minutes');
      expect(((await shop.cloud().request({ method: 'GET', path: '/v1/approvals/escalations', userId: OWNER })).body as { waits: Record<string, number> }).waits['refund']).toBe(90);
      await s.page.click('#lang');
      expect(await s.page.textContent('#waits-h')).toBe('மேல்நிலைக்கு அனுப்பும் காத்திருப்பு');
      expect(await s.page.locator('#waits-form .now[data-kind="refund"]').innerText()).toBe('⏱ 90 நிமிடங்கள்');
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
  }, 180_000);

  it('price-check size: the accountant asks for 5% / ₹25; the owner approves; applied — English and Tamil; a cashier reads nothing', async () => {
    const s = await open(ACC);
    try {
      await showRules(s.page);
      expect(await s.page.inputValue('#price-percent')).toBe('10');
      expect(await s.page.inputValue('#price-amount')).toBe('50');
      await s.page.fill('#price-percent', '5');
      await s.page.fill('#price-amount', '25');
      await s.page.fill('#price-reason', 'tighter checks while the new till beds in');
      await s.page.click('#price-ask');
      await waitStatus(s.page, 'price-status', /Asked\./);
      await ownerApproves();
      await applyApproved(s.page);
      expect(await s.page.textContent('#price-meta')).toMatch(/5\.00% · ₹25\.00/);
      await s.page.click('#lang');
      expect(await s.page.textContent('#price-h')).toBe('விலைச் சோதனை அளவு');
      expect(await s.page.textContent('#price-percent-l')).toBe('இதை விட அதிகம் (சதவீதம்)');
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }

    const c = await open(CASH);
    try {
      expect(await c.page.textContent('#page-status')).toBe('Your role cannot read the approval rules.');
      expect(await c.page.isDisabled('#read')).toBe(true);
      expect(c.writes).toEqual([]);
      await c.page.click('#lang');
      expect(await c.page.textContent('#page-h')).toBe('ஒப்புதல் விதிகள்');
    } finally { await c.close(); }
  }, 180_000);
});
