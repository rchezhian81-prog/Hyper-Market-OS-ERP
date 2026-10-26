import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { ApiError, buildRouter, type Method, type Router } from '../../services/kernel/src/index';
import { freeSampleRoutes, type FreeSampleDecision, type FreeSampleIssue, type FreeSampleRequest } from '../../services/inventory/src/free-samples';
import type { ItcReversal } from '../../packages/input-tax/src/index';

/**
 * **OB-393 on the write-off capture screen, in a real browser — a free sample waits for a store manager OTHER THAN THE
 * GIVER before the stock leaves and the GST give-back is placed.** A stub head office MOUNTS THE REAL `freeSampleRoutes`
 * over in-memory records, with the pipeline's permission check in front:
 *
 *   • store manager 1 gives two rice: the page says "Recorded and waiting"; nothing moved and no credit was given back;
 *     on "Show the waiting samples" their own sample carries no approve button — "You gave this one";
 *   • a direct self-approval is refused by name (`free_sample_self_approval`);
 *   • store manager 2, in their own session, sees it waiting and approves it with a reason: the page says "Approved … CGST
 *     ₹2.50, SGST ₹2.50"; the issue names both people; the list is then empty; another is rejected and nothing moves;
 *   • a Tamil twin; icons beside the words.
 * The browser binary is the environment's pre-installed Chromium; where none is present the suite SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const WEB_DIR = 'apps/web-erp/web';
const T = 'tenant-e2e';
const MGR1 = 'u-mgr1';
const MGR2 = 'u-mgr2';
const PERMS: Record<string, readonly string[]> = {
  [MGR1]: ['inventory.movement.append', 'inventory.freesample.approve'],
  [MGR2]: ['inventory.movement.append', 'inventory.freesample.approve'],
};

interface HeadOffice {
  readonly router: Router;
  readonly requests: FreeSampleRequest[];
  readonly decisions: FreeSampleDecision[];
  readonly issues: FreeSampleIssue[];
  readonly reversals: ItcReversal[];
  signedIn: string;
}

function newHeadOffice(): HeadOffice {
  const requests: FreeSampleRequest[] = [];
  const decisions: FreeSampleDecision[] = [];
  const issues: FreeSampleIssue[] = [];
  const reversals: ItcReversal[] = [];
  const built = buildRouter([...freeSampleRoutes({
    now: () => new Date().toISOString(),
    requests: async () => requests, recordRequest: async (_t, r) => { requests.push(r); },
    decisions: async () => decisions, recordDecision: async (_t, d) => { decisions.push(d); },
    issues: async () => issues, recordIssue: async (_t, i) => { issues.push(i); },
    unitCostAt: async () => 5_000,
    ownersOfStockAt: async () => [],
    bills: async () => [{ invoiceId: 'inv-r', capturedAt: '2026-10-01T10:00:00Z', productId: 'p-rice', lineTotalMinor: 50_000, cgstMinor: 1_250, sgstMinor: 1_250 }],
    lockedMonths: async () => new Set(),
    recordReversal: async (_t, r) => { reversals.push(r); return r; },
    checks: async () => [], recordCheck: async () => {},
    tradingDay: async () => '2026-10-26',
    // OB-396: both are store managers of the store; the decider is judged from these grants.
    grants: async () => [{ userId: MGR1, roleId: 'store_manager', branchScope: 'all' }, { userId: MGR2, roleId: 'store_manager', branchScope: 'all' }],
  })]);
  if (!built.ok || built.router === undefined) throw new Error(`stub head office refused its routes: ${JSON.stringify(built.refusals)}`);
  return { router: built.router, requests, decisions, issues, reversals, signedIn: MGR1 };
}

let keyN = 0;
async function call(ho: HeadOffice, userId: string, method: Method, path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const matched = ho.router.match(method, path);
  if (matched === undefined) return { status: 404, body: { error: { code: 'not_found', whatHappened: `No route ${method} ${path}.` } } };
  if (!(PERMS[userId] ?? []).includes(matched.route.permission)) return { status: 403, body: { error: { code: 'forbidden', whatHappened: `${userId} does not hold ${matched.route.permission}.` } } };
  try {
    const out = await matched.route.handler({ tenantId: T, userId, branchId: null, scope: 'all', params: matched.params, query: {}, body, traceId: 't', ...(method === 'GET' ? {} : { idempotencyKey: `k-${keyN++}` }) });
    return { status: out.status, body: out.body };
  } catch (e) {
    if (e instanceof ApiError) return { status: e.status, body: { error: e.body } };
    return { status: 500, body: { error: { code: 'internal', whatHappened: String(e) } } };
  }
}

async function startHeadOffice(ho: HeadOffice): Promise<{ base: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const [path = '/'] = (req.url ?? '/').split('?');
      const method = (req.method ?? 'GET') as Method;
      if (path.startsWith('/v1/')) {
        let raw = '';
        for await (const c of req) raw += String(c);
        const answer = await call(ho, ho.signedIn, method, path, raw === '' ? undefined : JSON.parse(raw));
        res.writeHead(answer.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(answer.body));
        return;
      }
      const file = path === '/' ? 'write-off-capture.html' : path.replace(/^\//, '');
      try {
        const buf = await readFile(join(WEB_DIR, file));
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream';
        let out = buf.toString('utf8');
        if (file.endsWith('.html')) out = out.replace('<!--SCREEN-DATA-->', `<script>window.writeOffCaptureData = ${JSON.stringify({ userId: ho.signedIn, permissions: PERMS[ho.signedIn], materialThresholdMinor: 50_000 })};</script>`);
        res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
        res.end(out);
      } catch { res.writeHead(404); res.end('not found'); }
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

/** Wait for words to appear — never read the text in the same tick as the click that changes it. */
const waitForWords = (page: Page, selector: string, words: string) =>
  page.waitForFunction(([s, w]) => ((globalThis as unknown as { document: { querySelector(q: string): { textContent: string | null } | null } }).document.querySelector(s)?.textContent ?? '').includes(w), [selector, words] as const, { timeout: 10_000 });

describe.skipIf(!existsSync(CHROMIUM))('OB-393: a free sample waits for a store manager other than the giver, in a real browser', () => {
  let browser: Browser;
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 60_000);
  afterAll(async () => { await browser?.close(); });

  const openAs = async (base: string, ho: HeadOffice, who: string) => {
    ho.signedIn = who;
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}/`, { waitUntil: 'load' });
    await page.locator('#fs:not([hidden])').waitFor({ timeout: 10_000 });
    return { page, errors, close: () => context.close() };
  };

  it('given by one manager, waiting; the giver cannot approve it; another manager approves it — then the stock and GST change', async () => {
    const ho = newHeadOffice();
    const srv = await startHeadOffice(ho);
    try {
      // ── store manager 1 gives two rice ──
      const one = await openAs(srv.base, ho, MGR1);
      await one.page.fill('#fs-product', 'p-rice'); await one.page.fill('#fs-location', 'br-1'); await one.page.fill('#fs-qty', '2'); await one.page.fill('#fs-note', 'tasting at the counter (synthetic)');
      await one.page.click('#fs-save');
      await waitForWords(one.page, '#fs-result', 'Recorded and waiting');
      expect([ho.requests.length, ho.issues.length, ho.reversals.length]).toEqual([1, 0, 0]);
      // Their own waiting sample: no approve button.
      expect(await one.page.locator('#fsp-load svg').count()).toBe(1);
      await one.page.click('#fsp-load');
      await waitForWords(one.page, '#fsp-rows', 'You gave this one');
      expect(await one.page.locator('#fsp-rows button[data-act="approve"]').count()).toBe(0);
      expect(one.errors).toEqual([]);
      await one.close();

      // ── a self-approval sent straight to head office is refused by name ──
      const issueId = ho.requests[0]!.issueId;
      const self = await call(ho, MGR1, 'POST', `/v1/inventory/free-samples/${issueId}/decision`, { decision: 'approve', reason: 'mine' });
      expect([self.status, (self.body as { error: { code: string } }).error.code]).toEqual([403, 'free_sample_self_approval']);

      // ── store manager 2 approves it in their own session ──
      const two = await openAs(srv.base, ho, MGR2);
      await two.page.click('#fsp-load');
      await waitForWords(two.page, '#fsp-rows', '2 ea p-rice');
      await waitForWords(two.page, '#fsp-rows', `given by ${MGR1}`);
      expect(await two.page.locator('#fsp-rows button[data-act="approve"] svg').count()).toBe(1);
      // No reason: refused on the page, nothing sent.
      await two.page.click('#fsp-rows button[data-act="approve"]');
      await waitForWords(two.page, '#fsp-rows .result', 'Write the reason first');
      expect(ho.decisions).toEqual([]);
      await two.page.fill('#fsp-rows input.decision-reason', 'seen at the counter');
      await two.page.click('#fsp-rows button[data-act="approve"]');
      await waitForWords(two.page, '#fsp-said', 'Approved. The stock has left.');
      await waitForWords(two.page, '#fsp-said', 'CGST ₹2.50, SGST ₹2.50');
      await waitForWords(two.page, '#fsp-rows', 'No free sample is waiting for approval.');
      expect(ho.issues).toEqual([expect.objectContaining({ issuedBy: MGR1, approvedBy: MGR2 })]);
      expect(ho.reversals.length).toBe(1);

      // ── another sample, rejected: nothing moves ──
      ho.signedIn = MGR1;
      expect((await call(ho, MGR1, 'POST', '/v1/inventory/free-samples/fs-two', { productId: 'p-rice', locationId: 'br-1', qty: 1, uom: 'ea', note: 'second tasting' })).status).toBe(202);
      ho.signedIn = MGR2;
      await two.page.click('#fsp-load');
      await waitForWords(two.page, '#fsp-rows', '1 ea p-rice');
      await two.page.fill('#fsp-rows input.decision-reason', 'not an approved tasting');
      await two.page.click('#fsp-rows button[data-act="reject"]');
      await waitForWords(two.page, '#fsp-said', 'Rejected. Nothing moved.');
      expect([ho.issues.length, ho.reversals.length]).toEqual([1, 1]);

      // Tamil.
      await two.page.click('#lang');
      await waitForWords(two.page, '#fsp-title', 'ஒப்புதலுக்காகக் காத்திருக்கும் இலவச மாதிரிகள்');
      expect(two.errors).toEqual([]);
      await two.close();
    } finally {
      await srv.stop();
    }
  });
});
