import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { chromium, type Browser } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';

/**
 * **A real browser till posts its sale to the till's socket, cross-origin, and it lands on the disk.**
 *
 * The screen is served on one loopback port and the write socket is on another, so the browser
 * treats the commit as a cross-origin request and — for a JSON POST — will not send it unless the
 * socket answers the preflight and names the origin back. The unit test proves the socket sends
 * those headers; this proves a REAL Chromium, which actually enforces CORS, accepts them and the
 * sale reaches the disk. Without the fix the browser would refuse the request and the till could not
 * take money, which no in-process test would ever show.
 *
 * Skips where no browser binary is present, exactly like the other e2e suites.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['till', 'cross', 'origin', 'signing', 'key'].join('-').padEnd(48, '0');

/** A page on ITS OWN loopback origin that posts one sale to the lane socket and shows the result. */
function pageServer(laneUrl: string): Promise<{ origin: string; stop: () => Promise<void> }> {
  const html = `<!doctype html><html><body><pre id="out">…</pre><script>
    fetch(${JSON.stringify(laneUrl)} + '/lane/sales', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'S-BROWSER', number: 'R-BROWSER', total: 100, currency: 'INR', lines: [], tenders: [] }),
    }).then(function (r) { return r.json(); })
      .then(function (b) { document.getElementById('out').textContent = 'OK:' + b.committed; })
      .catch(function (e) { document.getElementById('out').textContent = 'ERR:' + e; });
  </script></body></html>`;
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      resolve({ origin: `http://127.0.0.1:${port}`, stop: () => new Promise((d) => { server.close(() => d()); }) });
    });
  });
}

describe.skipIf(!HAVE_BROWSER)('a browser till commits cross-origin to the lane socket', () => {
  let browser: Browser;
  const dirs: string[] = [];
  const stops: (() => Promise<void>)[] = [];

  beforeAll(async () => { browser = await chromium.launch({ headless: true, executablePath: CHROMIUM }); }, 60_000);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => {
    for (const stop of stops.splice(0)) await stop();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  it('the sale reaches the disk — the browser accepted the cross-origin answer', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-xorigin-'));
    dirs.push(dir);
    const edge: EdgeProcess = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY,
      EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0',
    }, () => {}))!;
    stops.push(() => edge.stop());

    const page = await pageServer(`http://127.0.0.1:${edge.lane!.port}`);
    stops.push(page.stop);

    const context = await browser.newContext();
    stops.push(() => context.close());
    const tab = await context.newPage();
    await tab.goto(`${page.origin}/`, { waitUntil: 'load' });

    // The page fetched the lane socket on a DIFFERENT loopback origin; a browser only lets that
    // through when the socket answered the preflight and named the origin back (the fix).
    await tab.waitForFunction(() => (globalThis as unknown as { document: { getElementById(id: string): { textContent: string } | null } })
      .document.getElementById('out')?.textContent?.startsWith('OK:') === true, undefined, { timeout: 10_000 });
    const result = await tab.evaluate(() => (globalThis as unknown as { document: { getElementById(id: string): { textContent: string } | null } })
      .document.getElementById('out')?.textContent);
    expect(result).toBe('OK:true');

    // And it is durably on the disk — the whole point of the socket.
    const records = await readLog(edge.log.path);
    expect(records).toHaveLength(1);
    expect(records[0]?.ok === true && (JSON.parse(records[0].record) as { id: string }).id).toBe('S-BROWSER');
  });
});
