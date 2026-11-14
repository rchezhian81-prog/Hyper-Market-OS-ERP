import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startInboxShop, OWNER, MGR, type InboxShop } from './lib/ai-inbox-shop';

/**
 * **OB-676 "A" (owner, 2 Nov 2026, in writing) · M19-FR-01 · Item 2 — the owner sets which roles work each delivery-exception
 * queue on the Delivery exceptions page, in a real browser, on the PRODUCTION API over real PostgreSQL (synthetic data).**
 *
 *   • "Show who works each queue": every queue with its roles in words, "NOT CONFIRMED by the owner — the queues run on the
 *     starting suggestion", the suggested roles already ticked;
 *   • the owner unticks every role on the customer service desk and confirms: "Confirmed by the owner", the desk is shown
 *     UNOWNED (in words, never dropped), version 1 in "Every confirmation"; head office's worklist names it unowned;
 *   • after a restart the page reads the same; in Tamil; a store manager reads it and is offered no tick boxes and no button.
 * Needs DATABASE_URL and Chromium; else it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['ob676', 'staffing', 'e2e', 'signing', 'key'].join('-').padEnd(48, '0');
type Doc = { document: { getElementById(id: string): { hidden: boolean; textContent: string | null; dataset: Record<string, string> } | null } };

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('OB-676 — the owner sets who works each delivery-exception queue (M19-FR-01), on the production API in a real browser', () => {
  let browser: Browser;
  let shop: InboxShop;
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/substitution-exceptions', html: 'substitution-exceptions.html', dataGlobal: 'substitutionExceptionInboxData' },
      seed: async () => {},
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 300_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  const open = async (who: string, branch?: string): Promise<{ page: Page; writes: string[]; errors: string[]; close: () => Promise<void> }> => {
    const context = await browser.newContext();
    await shop.signIn(context, who, branch);
    const page = await context.newPage();
    const writes: string[] = []; const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/v1/') && r.method() !== 'GET') writes.push(`${r.method()} ${u.pathname}`); });
    await page.goto(`${shop.base}/substitution-exceptions`, { waitUntil: 'load' });
    await page.waitForFunction(() => (globalThis as unknown as Doc).document.getElementById('staffing')?.hidden === false, undefined, { timeout: 15_000 });
    return { page, writes, errors, close: async () => { await page.waitForLoadState('networkidle').catch(() => {}); await context.close(); } };
  };
  const stateIs = (page: Page, state: string) => page.waitForFunction((s) => (globalThis as unknown as Doc).document.getElementById('staffing-state')?.dataset['state'] === s, state, { timeout: 15_000 });
  const row = (queue: string) => `#staffing-queues li[data-queue="${queue}"]`;

  it('suggested and not confirmed → the owner leaves the service desk unowned and confirms; a restart reads the same; Tamil; a manager reads only', async () => {
    let s = await open(OWNER);
    try {
      expect(s.writes, 'nothing is written on open').toEqual([]);
      await s.page.click('#staffing-show');
      await stateIs(s.page, 'not_confirmed');
      expect(await s.page.innerText('#staffing-state')).toContain('NOT CONFIRMED by the owner — the queues run on the starting suggestion until he confirms.');
      expect(await s.page.innerText(`${row('customer_service_desk')} .headline`)).toContain('Customer service desk: Cashier (service desk), Owner, Store manager');
      expect(await s.page.innerText(`${row('finance_recon_queue')} .headline`)).toContain('Finance reconciliation: Accountant, Owner, Store manager');
      expect(await s.page.isChecked(`${row('customer_service_desk')} input.role[value="cashier"]`)).toBe(true);
      expect(await s.page.isChecked(`${row('customer_service_desk')} input.role[value="accountant"]`)).toBe(false);

      // He leaves the service desk with nobody, and confirms.
      for (const r of ['cashier', 'owner', 'store_manager']) await s.page.uncheck(`${row('customer_service_desk')} input.role[value="${r}"]`);
      await s.page.fill('#staffing-note', 'no service desk until the new hire starts');
      await s.page.click('#staffing-confirm');
      await stateIs(s.page, 'confirmed');
      expect(await s.page.innerText('#staffing-state')).toMatch(/Confirmed by the owner \(confirmed by u-owner, version 1\)\. Unowned queues: Customer service desk\.$/);
      expect(await s.page.getAttribute(row('customer_service_desk'), 'data-unowned')).toBe('true');
      expect(await s.page.innerText(`${row('customer_service_desk')} .headline`)).toContain('Customer service desk: UNOWNED — no role works this queue');
      expect(await s.page.locator('#staffing-history li.row').count()).toBe(1);
      expect(await s.page.innerText('#staffing-history li.row')).toContain('no service desk until the new hire starts');
      expect(s.writes).toEqual(['POST /v1/orders/exception-queue-staffing']);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
    const worklist = await shop.cloud().request({ method: 'GET', path: '/v1/orders/substitution-exceptions', userId: OWNER });
    expect((worklist.body as { staffing: unknown }).staffing).toMatchObject({ state: 'confirmed', unowned: ['customer_service_desk'] });

    await shop.restart();
    s = await open(OWNER);
    try {
      await s.page.click('#staffing-show');
      await stateIs(s.page, 'confirmed');
      expect(await s.page.getAttribute(row('customer_service_desk'), 'data-unowned')).toBe('true');
      await s.page.click('#lang');
      await s.page.waitForFunction(() => /உரிமையாளர் இல்லை/.test((globalThis as unknown as { document: { querySelector(x: string): { textContent: string | null } | null } }).document.querySelector('#staffing-queues li[data-queue="customer_service_desk"] .headline')?.textContent ?? ''), undefined, { timeout: 15_000 });
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }

    s = await open(MGR, 'br-1');
    try {
      await s.page.click('#staffing-show');
      await stateIs(s.page, 'confirmed');
      expect(await s.page.isHidden('#staffing-form')).toBe(true);
      expect(await s.page.locator('#staffing-queues input.role').count()).toBe(0);
      expect(s.writes).toEqual([]);
    } finally { await s.close(); }
  }, 240_000);
});
