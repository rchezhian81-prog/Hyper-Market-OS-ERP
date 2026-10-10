import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';

/**
 * **PF-07 in a real browser — the investigations inbox shows what the store's rules raised today (M15-FR-01 · P-03).**
 *
 * The integration test proves the inbox's own read reaches the real API and the model words each exception. This proves
 * the served page DRAWS them: a manager opens the inbox and sees "Drawer opened with no sale — u-lanecash", "2 today — the
 * rule allows 1", with the case opened from it, and the price-override one escalated. The cloud is a stub here (same
 * origin, as in production); where no browser binary is present the suite SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const WEB_DIR = 'apps/web-erp/web';

const RAISED = [
  { exceptionId: 'lpx-1', day: '2026-10-10', cashierId: 'u-lanecash', kind: 'no_sale', breach: 'count', observed: 2, limit: 1, severity: 'flag', linkedTxnIds: ['N-1', 'N-2'], raisedAt: '2026-10-10T10:00:00.000Z', caseId: 'case-ns' },
  { exceptionId: 'lpx-2', day: '2026-10-10', cashierId: 'u-lanecash', kind: 'discount', breach: 'single_value', observed: 14_000, limit: 5_000, severity: 'escalate', linkedTxnIds: ['B-1:L1'], raisedAt: '2026-10-10T10:05:00.000Z' },
];

async function startShellAndCloud(): Promise<{ base: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const [path = '/'] = (req.url ?? '/').split('?');
      if (req.method === 'GET' && path === '/v1/loss-prevention/cases') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ openCount: 0, totalValueMinor: 0, cases: [] }));
        return;
      }
      if (req.method === 'GET' && path === '/v1/loss-prevention/exceptions') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ day: '2026-10-10', count: RAISED.length, exceptions: RAISED }));
        return;
      }
      const file = path === '/' ? 'loss-prevention.html' : path.replace(/^\//, '');
      try {
        let body = (await readFile(join(WEB_DIR, file))).toString('utf8');
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream';
        if (file.endsWith('.html')) {
          body = body.replace('<!--SCREEN-DATA-->', `<script>window.lossPreventionInboxData = ${JSON.stringify({ userId: 'u-mgr', permissions: ['lp.case.read', 'lp.case.manage'] })};</script>`);
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

describe.skipIf(!HAVE_BROWSER)('the investigations inbox shows the exceptions raised today (audit PF-07)', () => {
  let browser: Browser;
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 60_000);
  afterAll(async () => { await browser?.close(); });

  it('a manager opens the inbox: the raised no-sale and price-override exceptions are listed in words, with the case', async () => {
    const srv = await startShellAndCloud();
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(`${srv.base}/`, { waitUntil: 'load' });
      await page.waitForSelector('#raised-rows li', { timeout: 10_000 });
      expect(await page.textContent('#raised-heading')).toBe('Raised by the store\'s rules today');
      const rows = await page.$$eval('#raised-rows li', (lis) => lis.map((li) => li.textContent ?? ''));
      expect(rows).toHaveLength(2);
      expect(rows[0]).toContain('Drawer opened with no sale — u-lanecash');
      expect(rows[0]).toContain('2 today — the rule allows 1');
      expect(rows[0]).toContain('Case opened: case-ns');
      expect(rows[1]).toContain('Price overrides');
      expect(rows[1]).toContain('₹140.00');
      expect(rows[1]).toContain('Escalate');
    } finally {
      await context.close();
      await srv.stop();
    }
  }, 60_000);
});
