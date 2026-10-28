import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { tradingDayIn } from '../../packages/calendar/src/index';

/**
 * **OB-435 · OB-439 on the Owner alerts page, in a real browser over the real API (in memory): an alert reads in the
 * page's language — English, then Tamil at the press of the language button, then English again.**
 *
 *   • two bills voided by one cashier at one store and the owner's voided-bills alert set to 2: "Check now" raises the
 *     alert, and the Today list shows it — in English, word for word as it always read;
 *   • the owner presses தமிழ்: the same alert reads in Tamil (the page's own words too); English again on the way back;
 *   • the page never throws.
 *
 * The page is served as the store computer serves it (its viewer injected), and every `/v1/...` call it makes goes to the
 * real API routes (`apiHarness`, in memory) as the signed-in owner. The browser is the pre-installed Chromium; where none
 * is present the suite SKIPS. Synthetic data only.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const WEB_DIR = 'apps/web-erp/web';
const OWNER = 'u-owner';
const BOX = 'u-box';
const TAMIL = /[\u0B80-\u0BFF]/;

/** Serve the web files with the viewer injected, and bridge every /v1 call to the in-memory API as `who`. */
async function startBridge(h: ApiHarness, tenantId: string, who: string): Promise<{ base: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname.startsWith('/v1/')) {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const raw = Buffer.concat(chunks).toString('utf8');
        const idem = req.headers['idempotency-key'];
        const r = await h.request({
          method: (req.method ?? 'GET') as 'GET' | 'POST', path: url.pathname, userId: who, tenantId,
          ...(raw === '' ? {} : { body: JSON.parse(raw) as unknown }),
          ...(idem === undefined ? {} : { idempotencyKey: Array.isArray(idem) ? idem[0]! : idem }),
          query: Object.fromEntries(url.searchParams.entries()),
        });
        res.writeHead(r.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(r.body));
        return;
      }
      const file = url.pathname === '/' || url.pathname === '/owner-alerts' ? 'owner-alerts.html' : url.pathname.replace(/^\//, '');
      try {
        let body = (await readFile(join(WEB_DIR, file))).toString('utf8');
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream';
        if (file.endsWith('.html')) {
          const me = (await h.request({ method: 'GET', path: '/v1/identity/me', userId: who, tenantId })).body as { userId: string; permissions: string[] };
          body = body.replace('<!--SCREEN-DATA-->', `<script>window.ownerAlertsData = ${JSON.stringify({ userId: me.userId, permissions: me.permissions }).replace(/</g, '\\u003c')};</script>`);
        }
        res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
        res.end(body);
      } catch {
        res.writeHead(404);
        res.end('not found');
      }
    })();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      resolve({ base: `http://127.0.0.1:${port}`, stop: () => new Promise((done) => { server.close(() => { done(); }); server.closeAllConnections(); }) });
    });
  });
}

describe.skipIf(!existsSync(CHROMIUM))('an alert reads in the page\'s language on the Owner alerts page (OB-435, OB-439)', () => {
  let browser: Browser;
  let bridge: { base: string; stop: () => Promise<void> };
  const h = apiHarness();
  const T = randomUUID();

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    await h.seedOwner(T, OWNER);
    await h.provisionRole(T, BOX, 'store_computer', ['S1']);
    const day = tradingDayIn(new Date().toISOString(), { timeZone: 'Asia/Kolkata', tradingDayCutoff: '00:00' });
    const at = new Date().toISOString();
    for (const [id, bill] of [['V-1', 'B-1'], ['V-2', 'B-2']] as const) {
      const r = await h.request({ method: 'POST', path: `/v1/loss-prevention/activity/${id}/synced`, userId: BOX, tenantId: T, branchId: 'S1', idempotencyKey: `act-${id}`, body: { activityId: id, kind: 'void', laneId: 'lane-1', cashierId: 'c-1', billRef: bill, lineId: 'L1', productId: 'P1', description: 'Rice', valueMinor: 30_000, reason: 'customer_changed_mind', at, tradingDay: day } });
      expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
    }
    const set = await h.request({ method: 'POST', path: '/v1/reporting/owner-alert-thresholds/voided_bill', userId: OWNER, tenantId: T, idempotencyKey: 'th-1', body: { value: 2 } });
    expect(set.status, JSON.stringify(set.body)).toBe(201);
    bridge = await startBridge(h, T, OWNER);
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 300_000);
  afterAll(async () => { await browser?.close(); await bridge?.stop(); });

  const text = (page: Page, sel: string): Promise<string> => page.locator(sel).first().innerText();
  const waitText = (page: Page, selector: string, want: RegExp | string) => page.waitForFunction(([sel, w, isRe]) => {
    const node = (globalThis as unknown as { document: { querySelector(s: string): { textContent: string | null } | null } }).document.querySelector(sel!);
    const got = node?.textContent ?? '';
    return isRe === '1' ? new RegExp(w!).test(got) : got.includes(w!);
  }, [selector, typeof want === 'string' ? want : want.source, typeof want === 'string' ? '0' : '1'], { timeout: 15_000 });

  it('the voided-bills alert reads in English, in Tamil after the language button, and in English again', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${bridge.base}/owner-alerts`, { waitUntil: 'load' });
    await page.locator('#d-check:not([hidden])').waitFor({ timeout: 15_000 });
    await page.click('#d-check');
    await waitText(page, '#d-status', 'Alerts newly sent to your inbox: 1');
    await page.locator('#d-alerts li[data-alert]').waitFor({ timeout: 15_000 });
    // English: word for word the alert as it always read.
    expect(await text(page, '#d-alerts li[data-alert] strong')).toBe('⚠ c-1 voided 2 bills at S1 worth 60000');
    // Tamil: the same alert in Tamil, and the page's own words too.
    await page.click('#lang');
    await waitText(page, '#d-alerts li[data-alert] strong', TAMIL);
    const tamil = await text(page, '#d-alerts li[data-alert] strong');
    expect(tamil).toBe('⚠ c-1 S1 இல் 60000 மதிப்புள்ள 2 பில்களை ரத்து செய்தார்');
    expect(tamil).not.toMatch(/voided|bills|worth/);
    expect(await page.textContent('#page-h')).toMatch(TAMIL);
    expect(await text(page, '#d-alerts li[data-alert] span')).toMatch(TAMIL);   // "in your alert inbox", in Tamil
    // And back to English.
    await page.click('#lang');
    await waitText(page, '#d-alerts li[data-alert] strong', 'voided 2 bills');
    expect(errors).toEqual([]);
    await context.close();
  }, 120_000);
});
