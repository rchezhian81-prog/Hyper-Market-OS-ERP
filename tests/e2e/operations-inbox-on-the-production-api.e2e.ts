import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startInboxShop, ok, OWNER, MGR, type InboxShop } from './lib/ai-inbox-shop';

/**
 * **The Operations inbox (A06), in a real browser, on the PRODUCTION API (audit EA-09 · A06 · QG-11 · PA-01).**
 *
 * The page is served in front of the real API over real PostgreSQL; the incidents are raised through the real alert
 * route, each from a rule that names the store computer it watches (br-1's lane queue, br-2's dead letters) or none (a
 * head-office connector). Through Chromium it proves:
 *   • a br-1 manager sees br-1's incident and the shop-wide one, never br-2's — the server's scope;
 *   • the manager sets br-1's recommendation aside in their own name; the shop-wide one is head office's to set aside,
 *     so the server refuses it and the page says so, and nothing moves;
 *   • the alert itself is untouched (the AI acknowledged nothing); when an operator acknowledges one the ordinary way,
 *     it drops off on reload (refreshed data);
 *   • the kill switch empties the inbox and says why; and after a RESTART the set-aside is read back.
 *
 * Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['operations', 'inbox', 'e2e', 'signing', 'key'].join('-').padEnd(48, '0');

const rowsText = (page: Page, list: '#rows' | '#dismissed-rows') => page.$$eval(`${list} .row .headline`, (els) => els.map((e) => e.textContent ?? ''));
const rule = (alertId: string, component: string, branchId?: string) => ({ alertId, component, firesAt: 'degraded', ownerUserId: 'u-op', ownerName: 'Operator', ackWithinMinutes: 15, ...(branchId === undefined ? {} : { branchId }) });

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('the Operations inbox (A06) on the production API, in a real browser (EA-09)', () => {
  let browser: Browser;
  let shop: InboxShop;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/operations', html: 'operations.html', dataGlobal: 'operationsInboxData' },
      seed: async (cloud) => {
        await ok(cloud.request({
          method: 'POST', path: '/v1/platform/alerts/raise', userId: OWNER, idempotencyKey: 'raise',
          body: { signals: { queueDepth: 500, deadLetterCount: 3, integrations: { gstn: false } }, alertRules: [rule('q-br1', 'queue', 'br-1'), rule('dl-br2', 'dead_letter', 'br-2'), rule('gstn-shop', 'integration:gstn')] },
        }), 'raise');
      },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await shop?.stop();
  });

  const open = async (who: string, branch?: string) => {
    const context = await browser.newContext();
    await shop.signIn(context, who, branch);
    const page = await context.newPage();
    const asked: string[] = [];
    page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/v1/')) asked.push(`${r.method()} ${u.pathname}`); });
    await page.goto(`${shop.base}/operations`, { waitUntil: 'load' });
    return { page, asked, close: () => context.close() };
  };
  const alertState = async (alertId: string): Promise<string | undefined> => ((await shop.cloud().request({ method: 'GET', path: '/v1/platform/alerts', userId: OWNER })).body as { alerts: { alert: { alertId: string }; state: string }[] }).alerts.find((a) => a.alert.alertId === alertId)?.state;

  it('a br-1 manager sees br-1 and shop-wide incidents only; sets br-1\'s aside; the shop-wide one is refused', async () => {
    const { page, asked, close } = await open(MGR, 'br-1');
    try {
      await page.waitForFunction(() => (globalThis as unknown as { document: { querySelectorAll(s: string): { length: number } } }).document.querySelectorAll('#rows .row').length === 2, undefined, { timeout: 15_000 });
      const shown = await rowsText(page, '#rows');
      expect(shown.some((t) => t.startsWith('queue'))).toBe(true);
      expect(shown.some((t) => t.startsWith('integration:gstn'))).toBe(true);
      expect(shown.some((t) => t.startsWith('dead_letter'))).toBe(false); // br-2's store computer — never on this page

      // The shop-wide incident is head office's to set aside: refused by the server, the page says so, nothing moves.
      const shopRow = page.locator('#rows .row', { hasText: 'integration:gstn' });
      await shopRow.locator('.reason').fill('not mine to judge');
      await shopRow.locator('.act.dismiss').click();
      await page.locator('#result.tone-error').waitFor({ timeout: 15_000 });
      expect(await page.locator('#dismissed-rows .row').count()).toBe(0);

      const row = page.locator('#rows .row', { hasText: /^queue/ });
      await row.locator('.reason').fill('the lane is being restarted');
      await row.locator('.act.dismiss').click();
      await page.locator('#dismissed-rows .row', { hasText: 'queue' }).waitFor({ timeout: 15_000 });
      expect(asked).toEqual(expect.arrayContaining(['GET /v1/ai/operations/worklist', 'POST /v1/ai/operations/dismissals']));

      const wl = (await shop.cloud().request({ method: 'GET', path: '/v1/ai/operations/worklist', userId: OWNER })).body as { dismissed: { finding: { alertId: string }; dismissal: { by: string } }[] };
      expect(wl.dismissed.map((e) => [e.finding.alertId, e.dismissal.by])).toEqual([['q-br1', MGR]]);
      // The AI acknowledged nothing: the alert is still open until an operator takes it.
      expect(await alertState('q-br1')).toBe('open');
    } finally {
      await close();
    }
  }, 60_000);

  it('refreshed data, the kill switch, and a restart — each read from head office', async () => {
    // An operator acknowledges the shop-wide incident the ordinary way: its recommendation drops off on reload.
    await ok(shop.cloud().request({ method: 'POST', path: '/v1/platform/alerts/gstn-shop/acknowledge', userId: OWNER, idempotencyKey: 'ack-gstn', body: {} }), 'ack');
    let s = await open(MGR, 'br-1');
    try {
      await s.page.locator('#dismissed-rows .row', { hasText: 'queue' }).waitFor({ timeout: 15_000 });
      expect(await s.page.locator('#rows .row').count()).toBe(0);
    } finally { await s.close(); }

    await ok(shop.cloud().request({ method: 'PUT', path: '/v1/ai/kill-switch', userId: OWNER, idempotencyKey: 'kill', body: { on: true } }), 'kill');
    s = await open(MGR, 'br-1');
    try {
      await s.page.locator('#state-text', { hasText: /kill switch/i }).waitFor({ timeout: 15_000 });
    } finally { await s.close(); }
    await ok(shop.cloud().request({ method: 'PUT', path: '/v1/ai/kill-switch', userId: OWNER, idempotencyKey: 'unkill-2', body: { on: false } }), 'unkill');

    await shop.restart();
    s = await open(MGR, 'br-1');
    try {
      await s.page.locator('#dismissed-rows .row', { hasText: 'queue' }).waitFor({ timeout: 15_000 });
      expect((await rowsText(s.page, '#rows')).some((t) => t.startsWith('dead_letter'))).toBe(false);
    } finally { await s.close(); }
    s = await open(OWNER);
    try {
      await s.page.locator('#rows .row', { hasText: 'dead_letter' }).waitFor({ timeout: 15_000 });
    } finally { await s.close(); }
  }, 90_000);
});
