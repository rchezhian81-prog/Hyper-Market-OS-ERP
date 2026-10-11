import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startInboxShop, ok, OWNER, MGR, type InboxShop } from './lib/ai-inbox-shop';

/**
 * **The Workforce guidance inbox (A10), in a real browser, on the PRODUCTION API (audit EA-09 · A10 · QG-11 · PA-01).**
 *
 * Until EA-09 the browser evidence for this inbox was a stub server that flipped its own fixture after a POST. Here the
 * page is served in front of the real API assembly over real PostgreSQL; the tasks are written through the real task
 * route and the guidance is what the server re-derives. Through Chromium it proves:
 *   • a manager whose grant reaches ONE branch (br-1) sees br-1's escalated task and the shop-wide one — never br-2's —
 *     because the SERVER limits the inbox, not the page;
 *   • setting guidance aside, with a reason, is the manager's act in their own name; the row moves only because the
 *     server's re-read says so; the task itself is still open (the AI committed nothing);
 *   • the data refreshes — a task completed the ordinary way drops off on reload;
 *   • the kill switch empties the inbox and says why; switching it off brings it back;
 *   • after a RESTART of the API the set-aside is still there.
 *
 * Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['workforce', 'inbox', 'e2e', 'signing', 'key'].join('-').padEnd(48, '0');
const PAST = new Date(Date.now() - 60 * 60 * 1000).toISOString();

const rowsText = (page: Page, list: '#rows' | '#dismissed-rows') => page.$$eval(`${list} .row .headline`, (els) => els.map((e) => e.textContent ?? ''));

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('the Workforce inbox (A10) on the production API, in a real browser (EA-09)', () => {
  let browser: Browser;
  let shop: InboxShop;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/workforce', html: 'workforce.html', dataGlobal: 'workforceInboxData' },
      seed: async (cloud) => {
        for (const [id, label, branchId] of [['T-br1', 'Anna Nagar chiller check', 'br-1'], ['T-br2', 'T. Nagar chiller check', 'br-2'], ['T-shop', 'Head office fire drill', undefined]] as const) {
          await ok(cloud.request({ method: 'POST', path: `/v1/hr/workforce/tasks/${id}`, userId: OWNER, idempotencyKey: `task-${id}`, body: { description: label, forRole: 'store_manager', dueAt: PAST, critical: true, ...(branchId === undefined ? {} : { branchId }) } }), id);
        }
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
    await page.goto(`${shop.base}/workforce`, { waitUntil: 'load' });
    return { page, asked, close: () => context.close() };
  };

  it('a br-1 manager sees br-1 and shop-wide guidance only, and sets br-1\'s aside in their own name', async () => {
    const { page, asked, close } = await open(MGR, 'br-1');
    try {
      await page.waitForFunction(() => (globalThis as unknown as { document: { querySelectorAll(s: string): { length: number } } }).document.querySelectorAll('#rows .row').length === 2, undefined, { timeout: 15_000 });
      const shown = await rowsText(page, '#rows');
      expect(shown.some((t) => t.includes('Anna Nagar chiller check'))).toBe(true);
      expect(shown.some((t) => t.includes('Head office fire drill'))).toBe(true);
      expect(shown.some((t) => t.includes('T. Nagar'))).toBe(false); // another branch's task never reaches this page

      const row = page.locator('#rows .row', { hasText: 'Anna Nagar chiller check' });
      await row.locator('.reason').fill('the closing lead is on it');
      await row.locator('.act.dismiss').click();
      await page.locator('#dismissed-rows .row', { hasText: 'Anna Nagar chiller check' }).waitFor({ timeout: 15_000 });
      expect(asked).toEqual(expect.arrayContaining(['GET /v1/ai/workforce/worklist', 'POST /v1/ai/workforce/dismissals']));

      // Head office recorded it in the manager's name; the task is still a person's to do — no AI completed it.
      const wl = (await shop.cloud().request({ method: 'GET', path: '/v1/ai/workforce/worklist', userId: OWNER })).body as { dismissed: { finding: { taskId: string }; dismissal: { by: string; reason: string } }[] };
      expect(wl.dismissed.map((e) => [e.finding.taskId, e.dismissal.by])).toEqual([['T-br1', MGR]]);
      const tasks = (await shop.cloud().request({ method: 'GET', path: '/v1/hr/workforce/tasks', userId: OWNER })).body as { tasks: { taskId: string; status: string }[] };
      expect(tasks.tasks.find((t) => t.taskId === 'T-br1')!.status).toBe('escalated');
    } finally {
      await close();
    }
  }, 60_000);

  it('refreshed data, the kill switch, and a restart — each read from head office', async () => {
    // A person completes the shop-wide task the ordinary way: it drops off on reload.
    await ok(shop.cloud().request({ method: 'POST', path: '/v1/hr/workforce/tasks/T-shop/complete', userId: OWNER, idempotencyKey: 'done-shop', body: { doneBy: OWNER } }), 'complete');
    let s = await open(MGR, 'br-1');
    try {
      await s.page.locator('#dismissed-rows .row', { hasText: 'Anna Nagar chiller check' }).waitFor({ timeout: 15_000 });
      expect(await s.page.locator('#rows .row').count()).toBe(0);
    } finally { await s.close(); }

    // The kill switch: the inbox is emptied and says why.
    await ok(shop.cloud().request({ method: 'PUT', path: '/v1/ai/kill-switch', userId: OWNER, idempotencyKey: 'kill', body: { on: true } }), 'kill');
    s = await open(MGR, 'br-1');
    try {
      await s.page.locator('#state-text', { hasText: /kill switch/i }).waitFor({ timeout: 15_000 });
      expect(await s.page.locator('#dismissed-rows .row').count()).toBe(0);
    } finally { await s.close(); }
    await ok(shop.cloud().request({ method: 'PUT', path: '/v1/ai/kill-switch', userId: OWNER, idempotencyKey: 'unkill-2', body: { on: false } }), 'unkill');

    // RESTART the API: the set-aside is read back from the store; br-2's task still never shows here.
    await shop.restart();
    s = await open(MGR, 'br-1');
    try {
      await s.page.locator('#dismissed-rows .row', { hasText: 'Anna Nagar chiller check' }).waitFor({ timeout: 15_000 });
      expect((await rowsText(s.page, '#rows')).some((t) => t.includes('T. Nagar'))).toBe(false);
    } finally { await s.close(); }
    // The owner, company-wide, still sees br-2's.
    s = await open(OWNER);
    try {
      await s.page.locator('#rows .row', { hasText: 'T. Nagar chiller check' }).waitFor({ timeout: 15_000 });
    } finally { await s.close(); }
  }, 90_000);
});
