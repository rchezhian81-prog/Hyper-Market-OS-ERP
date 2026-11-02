import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startInboxShop, ok, OWNER, MGR, type InboxShop } from './lib/ai-inbox-shop';

/**
 * **OB-676 "A" (owner, 2 Nov 2026, in writing) · M19-FR-04 — the owner confirms the driver cash hand-over limit on the
 * Dispatch page, in a real browser, on the PRODUCTION API over real PostgreSQL (synthetic data).**
 *
 *   • nothing is read on open; "Show the limit" reads ₹100.00 in force at br-1, "NOT CONFIRMED by the owner", with ₹100 offered
 *     as the starting suggestion (already in the box); the day's routes say beside the cash "not confirmed by the owner";
 *   • the owner confirms it as it stands: "Confirmed by the owner (confirmed by u-owner …)", one row in "Every confirmation",
 *     and the routes' warning is gone;
 *   • he changes it to ₹75.50: a second row "changed from ₹100.00", and head office's store settings hold ₹75.50 as a NEW
 *     version (the older kept);
 *   • after a restart of the API the page reads the same; in Tamil; a store manager reads it but is offered no form.
 * Needs DATABASE_URL and Chromium; else it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['ob676', 'dispatch', 'e2e', 'signing', 'key'].join('-').padEnd(48, '0');
const SETTINGS = { tradingDayCutoff: '02:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, cashVarianceToleranceMinor: 5_000, privacySlaDays: 15, warehouseId: 'br-1' };
type Doc = { document: { getElementById(id: string): { hidden: boolean; textContent: string | null; dataset: Record<string, string> } | null } };

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('OB-676 — the owner confirms the driver cash limit on the Dispatch page (M19-FR-04), on the production API in a real browser', () => {
  let browser: Browser;
  let shop: InboxShop;
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/dispatch', html: 'dispatch.html', dataGlobal: 'dispatchData' },
      seed: async (cloud) => {
        await ok(cloud.request({ method: 'PUT', path: '/v1/platform/entitlements/delivery', userId: OWNER, idempotencyKey: 'delivery-on', body: { enabled: true } }), 'delivery on');
        await ok(cloud.request({ method: 'POST', path: '/v1/stores/br-1/settings', userId: OWNER, idempotencyKey: 'settings-br1', body: SETTINGS }), 'store settings');
      },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 300_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  const open = async (who: string, branch?: string): Promise<{ page: Page; reads: string[]; errors: string[]; close: () => Promise<void> }> => {
    const context = await browser.newContext();
    await shop.signIn(context, who, branch);
    const page = await context.newPage();
    const reads: string[] = []; const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/v1/')) reads.push(`${r.method()} ${u.pathname}`); });
    await page.goto(`${shop.base}/dispatch`, { waitUntil: 'load' });
    return { page, reads, errors, close: async () => { await page.waitForLoadState('networkidle').catch(() => {}); await context.close(); } };
  };
  const stateIs = (page: Page, state: string) => page.waitForFunction((s) => (globalThis as unknown as Doc).document.getElementById('tolerance-state')?.dataset['state'] === s, state, { timeout: 15_000 });

  it('not confirmed → the routes say so → the owner confirms it → changes it as a new version; a restart reads the same; Tamil; a manager gets no form', async () => {
    const day = new Date().toISOString().slice(0, 10);
    let s = await open(OWNER);
    try {
      expect(s.reads, 'nothing is read on open').toEqual([]);
      await s.page.fill('#store', 'br-1');
      await s.page.fill('#run-date', day);
      await s.page.click('#show-tolerance');
      await stateIs(s.page, 'not_confirmed');
      expect(await s.page.innerText('#tolerance-state')).toBe('⚠ In force at this store: ₹100.00 — NOT CONFIRMED by the owner — drivers and the store computer keep using it until he confirms or changes it. Starting suggestion: ₹100.00.');
      expect(await s.page.inputValue('#tolerance-value')).toBe('100');
      // The day's routes: the limit every cash difference is judged against, said "not confirmed".
      await s.page.click('#show-board');
      await s.page.waitForFunction(() => (globalThis as unknown as Doc).document.getElementById('board-tolerance')?.hidden === false, undefined, { timeout: 15_000 });
      expect(await s.page.innerText('#board-tolerance')).toBe('⚠ Cash-difference limit for drivers: ₹100.00 — not confirmed by the owner');

      // He confirms it as it stands.
      await s.page.click('#confirm-tolerance');
      await stateIs(s.page, 'confirmed');
      expect(await s.page.innerText('#tolerance-status')).toBe('✓ Confirmed: ₹100.00');
      expect(await s.page.innerText('#tolerance-state')).toMatch(/^✓ In force at this store: ₹100\.00 — Confirmed by the owner \(confirmed by u-owner, .+\)\.$/);
      expect(await s.page.locator('#tolerance-history li.row').count()).toBe(1);
      expect(await s.page.getAttribute('#tolerance-history li.row', 'data-kind')).toBe('as_suggested');
      await s.page.click('#show-board');
      await s.page.waitForFunction(() => (globalThis as unknown as Doc).document.getElementById('board-tolerance')?.dataset['state'] === 'confirmed', undefined, { timeout: 15_000 });
      expect(await s.page.isHidden('#board-tolerance')).toBe(true);

      // He changes it: a new version, the old one kept.
      await s.page.fill('#tolerance-value', '0');
      await s.page.click('#confirm-tolerance');
      expect(await s.page.innerText('#tolerance-status')).toBe('Enter the limit in rupees, above zero (e.g. 100 or 100.50).');
      await s.page.fill('#tolerance-value', '75.50');
      await s.page.fill('#tolerance-note', 'smaller vans, smaller bags');
      await s.page.click('#confirm-tolerance');
      await s.page.waitForFunction(() => (globalThis as unknown as { document: { querySelectorAll(x: string): { length: number } } }).document.querySelectorAll('#tolerance-history li.row').length === 2, undefined, { timeout: 15_000 });
      expect(await s.page.innerText('#tolerance-history li.row[data-version="2"]')).toMatch(/v2 · ₹75\.50 — changed from ₹100\.00[\s\S]*smaller vans, smaller bags/);
      expect(s.reads.filter((r) => r.startsWith('POST '))).toEqual(['POST /v1/delivery/handover-tolerance/br-1', 'POST /v1/delivery/handover-tolerance/br-1']);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
    const stored = await shop.cloud().request({ method: 'GET', path: '/v1/stores/br-1/settings', userId: OWNER });
    expect((stored.body as { settings: Record<string, unknown> }).settings).toMatchObject({ handoverToleranceMinor: 7_550, version: 2 });

    await shop.restart();
    s = await open(OWNER);
    try {
      await s.page.fill('#store', 'br-1');
      await s.page.click('#show-tolerance');
      await stateIs(s.page, 'confirmed');
      expect(await s.page.innerText('#tolerance-state')).toContain('₹75.50');
      await s.page.click('#lang');
      await s.page.click('#show-tolerance');
      await s.page.waitForFunction(() => /உரிமையாளர் உறுதிசெய்தார்/.test((globalThis as unknown as Doc).document.getElementById('tolerance-state')?.textContent ?? ''), undefined, { timeout: 15_000 });
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }

    // A store manager reads the limit but is offered no form (only the owner confirms it).
    s = await open(MGR, 'br-1');
    try {
      await s.page.fill('#store', 'br-1');
      await s.page.click('#show-tolerance');
      await stateIs(s.page, 'confirmed');
      expect(await s.page.isHidden('#tolerance-form')).toBe(true);
      expect(s.reads.every((r) => r.startsWith('GET '))).toBe(true);
    } finally { await s.close(); }
  }, 240_000);
});
