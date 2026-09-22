import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';

/**
 * **The warehouse SUPERVISOR acts, in a real browser (M09 / OA-9 — the ERP oversight half).**
 *
 * M09's supervisory surface is the Web ERP warehouse screen: it decides §28 approvals and plans work
 * (propose a transfer, assign a task). Every rule lives in the tested `warehouse-supervisor-session`;
 * what units cannot prove is that a supervisor at the ACTUAL screen, clicking Approve or Propose,
 * commits that action DURABLY to the box's own outbox (offline-first — the supervisor keeps working with
 * no cloud, §31/P-01) and that §28's maker-checker holds on screen. This drives headless Chromium:
 *
 *   • an actionable approval → Approve + an on-screen reason → the decision lands in the durable outbox;
 *   • the request the supervisor MADE themselves shows blocked, with no Approve button and nothing
 *     queued (§28 maker-checker);
 *   • proposing a transfer queues it to the same outbox.
 *
 * The writes are offline-first: they go to the box's outbox, not a network call, so this asserts the
 * queued events rather than a POST. Self-skips where no browser is present, like every other e2e.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const WEB_DIR = 'apps/web-erp/web';

/** The slice of the browser's globals these callbacks touch, cast structurally inside each evaluate. */
interface BrowserGlobals {
  readonly warehouseSupervisorSession?: unknown;
  readonly warehouseSupervisorOutbox?: { pending(): { type: string }[] };
}

/** A supervisor with company-wide, unlimited authority, and two approvals: one raised by someone else
 *  (actionable) and one the supervisor raised themselves (blocked by §28). */
const supervisorData = (): Record<string, unknown> => ({
  storeId: 'store-1',
  bins: [],
  supervisor: { userId: 'u-super', branchScope: 'all', authorityLimit: null },
  approvals: [
    { id: 'req-other', subjectType: 'stock_transfer', subjectRef: 'tr-1', requestedBy: 'u-picker', branchId: null, value: { minor: 500000, currency: 'INR' }, status: 'pending' },
    { id: 'req-mine', subjectType: 'stock_transfer', subjectRef: 'tr-2', requestedBy: 'u-super', branchId: null, value: { minor: 200000, currency: 'INR' }, status: 'pending' },
  ],
  asAt: '2026-09-22T10:00:00.000Z',
});

async function startShell(data: Record<string, unknown>): Promise<{ base: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const [path = '/'] = (req.url ?? '/').split('?');
      const file = path === '/' || path === '/warehouse-supervisor' ? 'warehouse.html' : path.replace(/^\//, '');
      try {
        const buf = await readFile(join(WEB_DIR, file));
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream';
        let body = buf.toString('utf8');
        if (file.endsWith('.html')) {
          const inject = `<script>window.warehouseSupervisorData = ${JSON.stringify(data).replace(/</g, '\\u003c')};</script>`;
          body = body.replace('<!--SCREEN-DATA-->', inject);
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
      resolve({ base: `http://127.0.0.1:${port}`, stop: () => new Promise((done) => { server.close(() => { done(); }); }) });
    });
  });
}

describe.skipIf(!HAVE_BROWSER)('warehouse supervisor delivery, end to end in a real browser (M09)', () => {
  let browser: Browser;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  const open = async (data: Record<string, unknown>) => {
    const srv = await startShell(data);
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${srv.base}/`, { waitUntil: 'load' });
    await page.waitForFunction(
      () => (globalThis as unknown as BrowserGlobals).warehouseSupervisorSession != null,
      undefined, { timeout: 10_000 },
    );
    return { srv, context, page, teardown: async () => { await context.close(); await srv.stop(); } };
  };

  const pendingCount = (page: import('playwright-core').Page) =>
    page.evaluate(() => (globalThis as unknown as BrowserGlobals).warehouseSupervisorOutbox?.pending().length ?? -1);

  it('an authorised supervisor approves a request and the decision lands in the durable outbox (§31/P-01)', async () => {
    const { page, teardown } = await open(supervisorData());
    try {
      // The actionable request (raised by u-picker) shows an Approve button; the supervisor's own does not.
      await page.waitForSelector('button.approve', { timeout: 10_000 });
      expect(await pendingCount(page)).toBe(0);

      await page.click('button.approve');
      // The reason is chosen on-screen (never a prompt); the first valid code commits the decision.
      await page.waitForSelector('#reason-sheet:not([hidden]) #reason-choices button', { timeout: 10_000 });
      await page.click('#reason-choices button');

      // The decision is now durably queued in the box's outbox — offline-first, no network needed.
      await page.waitForFunction(
        () => ((globalThis as unknown as BrowserGlobals).warehouseSupervisorOutbox?.pending().length ?? 0) >= 1,
        undefined, { timeout: 10_000 },
      );
      expect(await pendingCount(page)).toBe(1);
    } finally {
      await teardown();
    }
  });

  it('the request the supervisor raised themselves is blocked on screen — no Approve, nothing queued (§28)', async () => {
    const { page, teardown } = await open(supervisorData());
    try {
      await page.waitForSelector('.appr .row', { timeout: 10_000 });
      // Exactly ONE row is actionable (the other supervisor's); the supervisor's own shows a blocked note.
      expect(await page.locator('button.approve').count()).toBe(1);
      expect(await page.locator('.appr .row .blocked').count()).toBe(1);
      // The maker-checker block is not a dead button the supervisor can push — nothing is queued.
      expect(await pendingCount(page)).toBe(0);
    } finally {
      await teardown();
    }
  });

  it('proposing a transfer queues it to the durable outbox', async () => {
    const { page, teardown } = await open(supervisorData());
    try {
      await page.waitForSelector('#t-do', { timeout: 10_000 });
      await page.fill('#t-from', 'BIN-A');
      await page.fill('#t-to', 'BIN-B');
      await page.fill('#t-product', 'p1');
      await page.fill('#t-qty', '6');
      await page.fill('#t-cost', '50');
      await page.click('#t-do');

      await page.waitForFunction(
        () => ((globalThis as unknown as BrowserGlobals).warehouseSupervisorOutbox?.pending().length ?? 0) >= 1,
        undefined, { timeout: 10_000 },
      );
      expect(await pendingCount(page)).toBe(1);
    } finally {
      await teardown();
    }
  });
});
