import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';

/**
 * **The operator decides about the old shop's data, in a real browser (MG-04 · §31 — the E2E matrix).**
 *
 * The migration screen is the desk where, on the night SRE extracts itself from the old system, a named person
 * settles every exception the cleaning pass raised and — if it comes to it — rolls back. Every rule lives in the
 * tested session model; every route is integration-tested. The one thing units cannot prove is that a person
 * making a decision **in a real browser** has it COMMITTED and QUEUED (hard rule #1) rather than living only in
 * a tab that a refresh would erase — the exact fault the screen's own comments say the first version had. This
 * drives headless Chromium against a stub box to prove it end to end:
 *
 *   • an authorised operator settles an exception → the decision is committed to the device outbox and the page
 *     says so ("N decision(s) made here and not yet sent … saved and will be sent when the connection is back");
 *   • nobody named at the desk → the decision is REFUSED and nothing is queued (a decision about the old data
 *     carries the name of whoever made it — §28; in a year that name is the only record anybody did);
 *   • the screen opens with the network cut, from the service-worker cache, and says it is a cached page (§31).
 *
 * The browser binary is the environment's pre-installed Chromium; where none is present the suite SKIPS rather
 * than failing, exactly like the offline-open and other delivery suites.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const WEB_DIR = 'apps/web-erp/web';

/** The slice of the browser's globals these callbacks touch, cast structurally inside each page.evaluate so this
 *  file needs no DOM lib. The cast is erased at compile time; the browser receives plain globalThis. */
interface BrowserGlobals {
  readonly migrationSession?: unknown;
  readonly shellCachedAt?: unknown;
  readonly navigator: {
    readonly onLine: boolean;
    readonly serviceWorker: { ready: Promise<unknown>; controller: unknown };
  };
  readonly document: { getElementById(id: string): { readonly hidden?: boolean } | null };
}

/** One blocking exception the cleaning pass raised — the operator's to settle (a valid MigrationException). */
const EXCEPTION = {
  exceptionId: 'EX-1', tenantId: 'store-1', kind: 'negative_stock', severity: 'blocking',
  confidence: 'certain', legacyIds: ['p1'], evidence: 'stock on hand is -4 for Toor dal 1kg in the old system',
};

/** What the box injects about who is at the desk and what the cleaning pass found. `userId` absent → nobody
 *  named, and nothing may be signed, decided or rolled back (§28). */
const migrationData = (over: { userId?: string } = {}): Record<string, unknown> => ({
  storeId: 'store-1', now: '2026-09-14T21:00:00.000Z', cutoverId: 'CUT-1', exceptions: [EXCEPTION],
  ...(over.userId === undefined ? {} : { userId: over.userId }),
});

/** A server that serves the migration shell (GET, the operator context injected) and the static files the shell
 *  and its service worker need. No cloud routes: a decision here commits to the device outbox (hard rule #1) and
 *  the sync agent drains it later — the browser proof is that it is committed and queued, not that it is sent. */
async function startShell(data: Record<string, unknown>): Promise<{ base: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const [path = '/'] = (req.url ?? '/').split('?');
      const file = path === '/' || path === '/migration' ? 'migration.html' : path.replace(/^\//, '');
      try {
        const buf = await readFile(join(WEB_DIR, file));
        const type = file.endsWith('.html') ? 'text/html'
          : file.endsWith('.js') ? 'text/javascript'
          : file.endsWith('.webmanifest') ? 'application/manifest+json'
          : 'application/octet-stream';
        let body = buf.toString('utf8');
        if (file.endsWith('.html')) {
          const inject = `<script>window.migrationData = ${JSON.stringify(data).replace(/</g, '\\u003c')};</script>`;
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

describe.skipIf(!HAVE_BROWSER)('the operator settles an exception, end to end in a real browser (MG-04 · §31)', () => {
  let browser: Browser;

  beforeAll(async () => {
    // Build the CURRENT web-erp bundle so the browser runs this branch's code, not a stale artifact.
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  /** Open the migration screen and wait for the session to boot. */
  const openScreen = async (data: Record<string, unknown>) => {
    const srv = await startShell(data);
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${srv.base}/`, { waitUntil: 'load' });
    await page.waitForFunction(() => (globalThis as unknown as BrowserGlobals).migrationSession !== undefined, undefined, { timeout: 10_000 });
    return { srv, context, page, teardown: async () => { await context.close(); await srv.stop(); } };
  };

  const unsentHidden = (page: import('playwright-core').Page) =>
    page.evaluate(() => Boolean((globalThis as unknown as BrowserGlobals).document.getElementById('unsent')?.hidden));

  it('an authorised operator settles an exception: the decision is committed and the page shows it queued (hard rule #1)', async () => {
    const { page, teardown } = await openScreen(migrationData({ userId: 'u-owner' }));
    try {
      // Nothing is queued before a decision is made.
      expect(await unsentHidden(page)).toBe(true);

      // Open the "problems in the old data" tab, choose the exception, decide to correct it, and give the reason
      // that is the whole record a year from now.
      await page.click('#tab-data');
      await page.selectOption('#decide-id', 'EX-1');
      await page.selectOption('#decide-action', 'correct');
      await page.fill('#decide-reason', 'reconciled against the supplier GRN — the -4 was a mis-keyed return');
      await page.click('#decide');

      // The decision is COMMITTED to the device outbox and the page says so — it does not live only in the tab.
      await page.waitForSelector('#unsent:not([hidden])', { timeout: 10_000 });
      expect(await unsentHidden(page)).toBe(false);
      expect(((await page.textContent('#unsent')) ?? '')).toMatch(/1\b/);
    } finally {
      await teardown();
    }
  });

  it('nobody named at the desk: the decision is refused and nothing is queued (§28)', async () => {
    const { page, teardown } = await openScreen(migrationData()); // no userId
    try {
      await page.click('#tab-data');
      await page.selectOption('#decide-id', 'EX-1');
      await page.selectOption('#decide-action', 'correct');
      await page.fill('#decide-reason', 'this should not be recorded without a name');
      await page.click('#decide');

      // The refusal banner shows, and nothing was queued — a decision about the old data must carry a name.
      await page.waitForSelector('#banner:not([hidden])', { timeout: 10_000 });
      expect(await unsentHidden(page)).toBe(true);
    } finally {
      await teardown();
    }
  });

  it('the screen opens with the network cut, from the cache, and says it is a cached page (§31)', async () => {
    const srv = await startShell(migrationData({ userId: 'u-owner' }));
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(`${srv.base}/`, { waitUntil: 'load' });
      await page.evaluate(() => (globalThis as unknown as BrowserGlobals).navigator.serviceWorker.ready.then(() => true));
      await page.waitForFunction(() => (globalThis as unknown as BrowserGlobals).navigator.serviceWorker.controller !== null, { timeout: 15_000 });

      await context.setOffline(true);
      await page.reload({ waitUntil: 'domcontentloaded' });

      expect(await page.evaluate(() => (globalThis as unknown as BrowserGlobals).navigator.onLine)).toBe(false);
      expect(await page.title()).toContain('Moving from the old');
      expect(await page.evaluate(() => typeof (globalThis as unknown as BrowserGlobals).shellCachedAt === 'string')).toBe(true);
      expect(((await page.textContent('body')) ?? '').trim().length).toBeGreaterThan(0);
    } finally {
      await context.close();
      await srv.stop();
    }
  });
});
