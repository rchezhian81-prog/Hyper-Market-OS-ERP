import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startInboxShop, ok, OWNER, MGR, type InboxShop } from './lib/ai-inbox-shop';
import { auditPage } from './lib/a11y-audit';

/**
 * **OB-154 "A" — the Weighing scales page, in a real browser, on the PRODUCTION API over real PostgreSQL (B6 · B7 · L2).**
 *
 * The page is served in front of the real API (no stub): who is looking comes from head office's own `GET /v1/identity/me`,
 * and every `/v1` call goes to the API under the signed-in person's token. Through Chromium:
 *
 *   • the owner opens an empty register (it says every till scale must be on it), adds a scale with its stamp, certificate
 *     and tills — nothing is written on open, and the register shows it with its stamp in words;
 *   • the store manager re-stamps it to a later date: head office refuses it until a second person approves, the page
 *     offers "ask", the manager asks; the owner approves; the manager saves it with that approval from "Waiting for
 *     approval" and the register shows the new date, the new certificate and both names;
 *   • a cashier cannot read the register; the page reads in Tamil; it fits a 360 px phone with no sideways page scroll;
 *     no page errors and no accessibility faults.
 *
 * Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS. Synthetic data only.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['scales', 'e2e', 'signing', 'key'].join('-').padEnd(48, '0');
const TENANT = randomUUID();
const CASHIER = 'u-cash-br1';
const day = (o: number): string => new Date(Date.now() + o * 86_400_000).toISOString().slice(0, 10);

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('the Weighing scales page on the production API, in a real browser (OB-154 · B6 · L2)', () => {
  let browser: Browser;
  let shop: InboxShop;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: TENANT, signingKey: KEY,
      page: { path: '/scales', html: 'scales.html', dataGlobal: 'scalesData' },
      seed: async (cloud) => { await cloud.grant(CASHIER, 'cashier', undefined, ['br-1']); },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 180_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  const open = async (who: string, opts: { branch?: string; width?: number } = {}) => {
    const context = await browser.newContext(opts.width === undefined ? {} : { viewport: { width: opts.width, height: 760 } });
    await shop.signIn(context, who, opts.branch);
    const page = await context.newPage();
    const writes: string[] = []; const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/v1/') && r.method() !== 'GET') writes.push(`${r.method()} ${u.pathname}`); });
    await page.goto(`${shop.base}/scales`, { waitUntil: 'load' });
    return { page, writes, errors, close: async () => { await page.waitForLoadState('networkidle').catch(() => {}); await context.close(); } };
  };
  const says = async (page: Page, id: string, expected: RegExp): Promise<void> => {
    await page.waitForFunction(([i, source]) => new RegExp(source!).test((globalThis as unknown as { document: { getElementById(x: string): { textContent: string | null } | null } }).document.getElementById(i!)?.textContent ?? ''), [id, expected.source], { timeout: 15_000 });
  };
  const fill = async (page: Page, f: Record<string, string>): Promise<void> => {
    for (const [id, v] of Object.entries(f)) await page.fill(`#${id}`, v);
  };

  it('the owner adds a scale; the manager re-stamps it with the owner\'s approval; a cashier cannot read it; Tamil; a phone', async () => {
    // ── The owner: an empty register, then a scale added ──
    let s = await open(OWNER);
    try {
      await says(s.page, 'no-scales', /Every till scale must be on it/);
      expect(s.writes, 'nothing is written on open').toEqual([]);
      await s.page.click('#tab-edit');
      await fill(s.page, { 'f-asset': 'SCALE-1', 'f-store': 'br-1', 'f-lanes': 'lane-1, lane-2', 'f-approval-no': 'LM/TN/APP/0042', 'f-capacity': '30000', 'f-stamped': day(-300), 'f-valid': day(20), 'f-certificate': 'LM/VC/2025/0042' });
      await s.page.click('#f-save');
      await s.page.locator('#scale-rows tr[data-asset="SCALE-1"][data-level="due_soon"]').waitFor({ timeout: 15_000 });
      expect(await s.page.locator('#scale-rows tr[data-asset="SCALE-1"]').innerText()).toMatch(/LM\/VC\/2025\/0042[\s\S]*Due soon — book the re-verification/);
      await says(s.page, 'v-soon', /^1$/);
      expect(s.writes).toEqual(['POST /v1/facilities/scales/SCALE-1']);
      expect(await auditPage(s.page, { expectLang: 'en' }), 'the register').toEqual([]);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }

    // ── The store manager re-stamps it: refused until a second person approves; asks ──
    s = await open(MGR, { branch: 'br-1' });
    let requestId = '';
    try {
      await s.page.locator('#scale-rows tr[data-asset="SCALE-1"]').waitFor({ timeout: 15_000 });
      await s.page.click('#scale-rows tr[data-asset="SCALE-1"]'); // opens "Add or update" with the scale as it stands
      expect(await s.page.inputValue('#f-certificate')).toBe('LM/VC/2025/0042');
      await fill(s.page, { 'f-stamped': day(0), 'f-valid': day(365), 'f-certificate': 'LM/VC/2026/0107' });
      await s.page.click('#f-save');
      await says(s.page, 'edit-status', /A later stamp date needs a second person/);
      await s.page.locator('#f-ask').waitFor({ state: 'visible' });
      await s.page.click('#f-ask');
      await s.page.locator('#request-rows li[data-status="waiting"]').waitFor({ timeout: 15_000 });
      requestId = (await s.page.locator('#request-rows li[data-status="waiting"]').getAttribute('data-request-id')) ?? '';
      expect(requestId).toMatch(/^areq-/);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }

    // ── The owner approves it in his own session (the Approvals page's own act) ──
    await ok(shop.cloud().request({ method: 'POST', path: `/v1/approvals/requests/${requestId}/decide`, userId: OWNER, idempotencyKey: `dec-${requestId}`, body: { decision: 'approved', reason: 'new certificate seen' } }), 'owner approves');

    // ── The manager saves it with the approval; the register shows the new stamp and both names ──
    s = await open(MGR, { branch: 'br-1' });
    try {
      await s.page.click('#tab-requests');
      const approved = s.page.locator(`#request-rows li[data-request-id="${requestId}"][data-status="approved"]`);
      await approved.waitFor({ timeout: 15_000 });
      expect(await approved.innerText()).toMatch(/Approved by u-owner/);
      await approved.locator('button[data-act="save-approved"]').click();
      await s.page.locator('#scale-rows tr[data-asset="SCALE-1"][data-level="current"]').waitFor({ timeout: 15_000 });
      const line = await s.page.locator('#scale-rows tr[data-asset="SCALE-1"]').innerText();
      expect(line).toContain(day(365));
      expect(line).toContain('LM/VC/2026/0107');
      expect(line).toContain(`${MGR} · ${OWNER}`);
      expect(s.writes).toEqual(['POST /v1/facilities/scales/SCALE-1']);
      // Tamil, on the same page.
      await s.page.click('#lang');
      await says(s.page, 'page-h', /எடைத் தராசுகள்/);
      expect(await s.page.locator('#scale-rows tr[data-asset="SCALE-1"]').innerText()).toMatch(/செல்லுபடியானது/);
      expect(await auditPage(s.page, { expectLang: 'ta' }), 'the register in Tamil').toEqual([]);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }

    // ── A cashier cannot read the register; nothing is offered ──
    s = await open(CASHIER, { branch: 'br-1' });
    try {
      await says(s.page, 'page-status', /Your role cannot read the scale register/);
      expect(await s.page.locator('#tab-edit').isVisible()).toBe(false);
      expect(s.writes).toEqual([]);
    } finally { await s.close(); }

    // ── The owner on a 360 px phone: no sideways page scroll ──
    s = await open(OWNER, { width: 360 });
    try {
      await s.page.locator('#scale-rows tr[data-asset="SCALE-1"]').waitFor({ timeout: 15_000 });
      for (const tab of ['register', 'edit', 'requests']) {
        await s.page.click(`#tab-${tab}`);
        const sideways = await s.page.evaluate(() => { const d = (globalThis as unknown as { document: { documentElement: { scrollWidth: number; clientWidth: number } } }).document.documentElement; return d.scrollWidth - d.clientWidth; });
        expect(sideways, `${tab}: sideways scroll`).toBeLessThanOrEqual(0);
      }
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
  });
});
