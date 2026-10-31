import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import { ROLE_CATALOGUE, STORE_MANAGER_ROLE_ID } from '../../services/api/src/roles';

/**
 * **The scrap page SAYS why a store manager has no record form (Round B · M28-FR-02 · OB-515 · P-07 · P-08).** The owner
 * decided (OB-515, 28 Oct 2026, in writing): the owner and the accountant record a scrap or recycling sale; store managers
 * review. So the store manager's role holds `scrap.review.read` and not `scrap.sale.record`, and the record form is not
 * shown to them — but the page used to hide it with not a word, so it looked broken. Now it says why, in English and
 * Tamil; the accountant still gets the form. Nothing about who may record is changed here.
 *
 * The page and the real web-erp bundle are served from apps/web-erp/web with the person's identity; no `/v1` call is made
 * on open. Skips where no browser is present.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const permsOf = (id: string): readonly string[] => ROLE_CATALOGUE.find((r) => r.id === id)!.permissions;
let viewer: { userId: string; permissions: readonly string[] } = { userId: 'u-manager', permissions: [] };

function startServer(): Promise<{ base: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname.startsWith('/v1/')) { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{}'); return; }
      const file = url.pathname.replace(/^\/+/, '') || 'scrap.html';
      try {
        let body = (await readFile(join('apps/web-erp/web', file))).toString('utf8');
        if (file.endsWith('.html')) body = body.replace('<!--SCREEN-DATA-->', `<script>window.scrapData = ${JSON.stringify(viewer)};</script>`);
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream';
        res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
        res.end(body);
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

describe.skipIf(!HAVE_BROWSER)('the scrap page says why the manager has no record form', () => {
  let browser: Browser;
  let shell: { base: string; stop: () => Promise<void> };
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
    shell = await startServer();
  }, 120_000);
  afterAll(async () => { await shell?.stop(); await browser?.close(); });

  async function open(as: { userId: string; permissions: readonly string[] }) {
    viewer = as;
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    await page.goto(`${shell.base}/scrap.html`, { waitUntil: 'load' });
    await page.waitForFunction(`((document.getElementById('page-h') || {}).textContent || '') !== '' && window.scrap !== undefined`);
    return { page, close: () => context.close() };
  }

  it('the store manager (review, not record — OB-515) sees the review and is told why there is no form, in English and Tamil', async () => {
    const manager = permsOf(STORE_MANAGER_ROLE_ID);
    expect(manager).toContain('scrap.review.read');
    expect(manager).not.toContain('scrap.sale.record');
    const { page, close } = await open({ userId: 'u-manager', permissions: manager });
    try {
      expect(await page.isVisible('#review')).toBe(true);
      expect(await page.isVisible('#record')).toBe(false);
      expect(await page.textContent('#page-status')).toContain('recording a scrap or recycling sale is for the owner or the accountant');
      await page.click('#lang');
      expect(await page.textContent('#page-status')).toContain('உரிமையாளர் அல்லது கணக்காளரின்');
    } finally { await close(); }
  });

  it('the accountant (who records) gets the form and no such line', async () => {
    const { page, close } = await open({ userId: 'u-accountant', permissions: permsOf('accountant') });
    try {
      expect(await page.isVisible('#record')).toBe(true);
      expect(((await page.textContent('#page-status')) ?? '').trim()).toBe('');
    } finally { await close(); }
  });
});
