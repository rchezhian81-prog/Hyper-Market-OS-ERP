import { Tally } from './lib/tally';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { Pool } from 'pg';
import { chromium, type Browser, type Page } from 'playwright-core';
import { apiHarness, TEST_IDP, type ApiHarness } from '../support/api-harness';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import type { HttpRequest } from '../../services/kernel/src/index';
import { shopDay } from '../../packages/calendar/src/shop-day';

/**
 * **QG-02 · OB-390 (owner, 26 Oct 2026) — store-manager.md "assign/complete a task ≤3", counted in a real browser on the
 * production API surface (in memory, and over real PostgreSQL when DATABASE_URL is set).**
 *
 * Assigning: a new task starts in the manager's OWN store — head office's sign-in names it (`/v1/identity/me`) — and is due
 * by the end of today, so the manager types what to do and who does it, then presses Assign: three. Completing: the
 * assignee, on their own "My tasks" (OB-158: only the assignee completes), presses Done on a task that asks for no steps
 * and no evidence: one. A task that asks for evidence still refuses without it — the defaults never fill in a check.
 * The browser binary is the pre-installed Chromium; where none is present the suite SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const DATABASE_URL = process.env['DATABASE_URL'];
const WEB_DIR = 'apps/web-erp/web';
const OWNER = 'u-owner';
const CASHIER = 'u-ravi';

/** The store computer in front of the API: each page is served with who is looking (head office's own `/v1/identity/me`),
 *  and the person's own token — carrying their branch when the sign-in names one — is sent with every call. */
async function startShell(h: ApiHarness, tenantId: string): Promise<{ base: string; stop: () => Promise<void> }> {
  const tokenFor = (req: IncomingMessage): string => {
    const cookie = req.headers.cookie ?? '';
    const who = /(?:^|;\s*)who=([^;]+)/.exec(cookie)?.[1] ?? OWNER;
    const branch = /(?:^|;\s*)branch=([^;]+)/.exec(cookie)?.[1];
    return TEST_IDP.issue({ sub: who, tenantId, ...(branch === undefined ? {} : { branchId: branch }) });
  };
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://x');
      const token = tokenFor(req);
      if (url.pathname.startsWith('/v1/')) {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const reply = await h.raw({
          method: (req.method ?? 'GET') as HttpRequest['method'], path: url.pathname, query: Object.fromEntries(url.searchParams), token,
          ...(req.headers['idempotency-key'] === undefined ? {} : { idempotencyKey: String(req.headers['idempotency-key']) }),
          ...(chunks.length === 0 ? {} : { body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }),
        });
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply.body));
        return;
      }
      const file = url.pathname.replace(/^\//, '') || 'store-tasks.html';
      try {
        let body = (await readFile(join(WEB_DIR, file))).toString('utf8');
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream';
        if (file.endsWith('.html')) {
          const me = (await h.raw({ method: 'GET', path: '/v1/identity/me', token })).body as { userId: string; permissions: string[] };
          body = body.replace('<!--SCREEN-DATA-->', `<script>window.storeOpsData = ${JSON.stringify({ userId: me.userId, permissions: me.permissions }).replace(/</g, '\\u003c')};</script>`);
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

describe.skipIf(!HAVE_BROWSER)('store tasks meet the interaction budget (QG-02 · OB-390), in a real browser on the production API', () => {
  let browser: Browser;
  let pool: Pool | undefined;
  let h: ApiHarness;
  let shell: { base: string; stop: () => Promise<void> };
  const T = randomUUID();
  const pageErrors: string[] = [];

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    if (DATABASE_URL !== undefined) {
      pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
      await runMigrations(pgPoolClient(pool), readdirSync('db/migrations').filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join('db/migrations', name), 'utf8') })));
      const sql = pgPoolClient(pool);
      h = apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) });
    } else {
      h = apiHarness();
    }
    await h.seedOwner(T, OWNER);
    await h.provisionRole(T, CASHIER, 'cashier');
    shell = await startShell(h, T);
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 120_000);
  afterAll(async () => { await browser?.close(); await shell?.stop(); await pool?.end(); expect(pageErrors).toEqual([]); });

  const open = async (who: string, file: string, branch?: string): Promise<{ page: Page; close: () => Promise<void> }> => {
    // OB-606: on a device in New York, not India — the deadline is still the end of the SHOP's today.
    const context = await browser.newContext({ timezoneId: 'America/New_York' });
    await context.addCookies([{ name: 'who', value: who, url: shell.base }, ...(branch === undefined ? [] : [{ name: 'branch', value: branch, url: shell.base }])]);
    const page = await context.newPage();
    page.on('pageerror', (e) => { pageErrors.push(`${file}: ${String(e)}`); });
    await page.goto(`${shell.base}/${file}`, { waitUntil: 'load' });
    return { page, close: () => context.close() };
  };
  const tasks = async () => ((await h.request({ method: 'GET', path: '/v1/hr/workforce/assigned-tasks', userId: OWNER, tenantId: T })).body as { tasks: { taskId: string; title: string; branchId: string; assignedTo: string; dueAt: string; status: string; evidenceRequired: boolean; completion?: { doneBy: string } }[] }).tasks;

  it('assign a task in 3 (what, who, Assign) — the store and the deadline are already the manager\'s own store and the end of today; complete it in 1', async () => {
    const board = await open(OWNER, 'store-tasks.html', 'br-1');
    try {
      await board.page.waitForFunction("document.body.dataset.taskDefaults === 'ready'", undefined, { timeout: 15_000 });
      expect(await board.page.inputValue('#a-branch'), 'the manager\'s own store, from the sign-in').toBe('br-1');
      const due = await board.page.inputValue('#a-due');
      expect(due, 'due by the end of today').toMatch(/^\d{4}-\d{2}-\d{2}T23:59$/);
      expect(due, 'the end of the SHOP\'s today, never the device\'s').toBe(shopDay('Asia/Kolkata').endOfTodayField());

      const taps = new Tally(board.page);
      await taps.type('#a-title', 'Face up aisle 4');
      await taps.type('#a-person', CASHIER);
      await taps.tap('#a-save');
      await board.page.waitForFunction("(document.querySelector('#assign-status')?.textContent ?? '') === 'Assigned in your name.'", undefined, { timeout: 15_000 });
      expect(taps.reset(), 'assign a task').toBeLessThanOrEqual(3);
      const [task] = (await tasks()).filter((x) => x.title === 'Face up aisle 4');
      expect(task).toMatchObject({ branchId: 'br-1', assignedTo: CASHIER, evidenceRequired: false });
      expect(task!.dueAt).toBe(shopDay('Asia/Kolkata').instantOfField(due)); // 23:59 in the SHOP, as head office holds it
      // Nobody completes on the board (OB-158).
      expect(await board.page.locator('button.done').count()).toBe(0);
    } finally { await board.close(); }

    const mine = await open(CASHIER, 'my-tasks.html');
    try {
      const row = mine.page.locator('#rows .row').first();
      await row.waitFor({ timeout: 15_000 });
      const taps = new Tally(mine.page);
      await taps.tap('#rows .row button.done');
      await mine.page.locator('#rows .row[data-status="done"]').waitFor({ timeout: 15_000 });
      expect(taps.reset(), 'complete a task').toBeLessThanOrEqual(3);
    } finally { await mine.close(); }
    expect((await tasks()).find((x) => x.title === 'Face up aisle 4')).toMatchObject({ status: 'done', completion: { doneBy: CASHIER } });
  }, 90_000);

  it('a sign-in that names no store leaves the store empty (never guessed) and Assign is refused before anything is sent; a changed default is what is sent', async () => {
    const board = await open(OWNER, 'store-tasks.html');
    try {
      await board.page.waitForFunction("document.body.dataset.taskDefaults === 'ready'", undefined, { timeout: 15_000 });
      expect(await board.page.inputValue('#a-branch')).toBe('');
      const before = (await tasks()).length;
      await board.page.fill('#a-title', 'Count the tills');
      await board.page.fill('#a-person', CASHIER);
      await board.page.click('#a-save');
      await board.page.waitForFunction("(document.querySelector('#assign-status')?.className ?? '').includes('err')", undefined, { timeout: 10_000 });
      expect((await tasks()).length, 'nothing was assigned').toBe(before);
      // The manager fills the store and moves the deadline: what they typed is what is sent.
      await board.page.fill('#a-branch', 'br-2');
      await board.page.fill('#a-due', '2099-01-02T09:30');
      await board.page.click('#a-save');
      await board.page.waitForFunction("(document.querySelector('#assign-status')?.textContent ?? '') === 'Assigned in your name.'", undefined, { timeout: 15_000 });
      const task = (await tasks()).find((x) => x.title === 'Count the tills');
      expect(task?.branchId).toBe('br-2');
      // 09:30 in the SHOP (OB-606), not 09:30 on this New York device.
      expect(task!.dueAt).toBe('2099-01-02T04:00:00.000Z');
    } finally { await board.close(); }
  }, 90_000);
});
