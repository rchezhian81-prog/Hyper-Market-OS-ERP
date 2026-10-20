import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { MIRROR_PILOT_NOT_COMPARED } from '../../edge/store-edge/src/screen-data';

/**
 * **MG-10 in the mirror pilot (OB-256, owner 20 Oct 2026), on the migration screen in a real browser, English and Tamil.**
 *
 * The evening comparison covers sales value, bill count, tax and stock; payments are not compared (the old system takes
 * every payment) and neither is loyalty (the old system keeps it, guest sales only OB-252). The store computer tells the
 * screen so (`notCompared`, exactly what `migrationPayload` serves in the mirror pilot). Those two cards then SAY the
 * decision and take no figures; the day is saved and signed on the four compared areas, and the day handed to the store
 * computer carries no payments or loyalty line — never a zero typed or invented (P-08). Synthetic data only.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const WEB_DIR = 'apps/web-erp/web';
const DAY = '2026-10-21';

interface Batch { source: string; items: { key: string; event: { type: string; payload: Record<string, unknown> } }[] }

const migrationData = (userId: string): Record<string, unknown> => ({
  storeId: 'store-1', now: '2026-10-22T08:00:00.000Z', cutoverId: 'CUT-1', requiredCleanDays: 3, userId,
  loadOperator: 'u-loader', dailyReconcilerUserId: 'u-recon', parallelDays: [], parallelDifferences: [], parallelDaySignatures: [],
  notCompared: MIRROR_PILOT_NOT_COMPARED,
});

async function startShell(data: Record<string, unknown>, box: { batches: Batch[] }): Promise<{ base: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const [path = '/'] = (req.url ?? '/').split('?');
      if (req.method === 'POST' && path === '/lane/outbox') {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const batch = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Batch;
        box.batches.push(batch);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ acks: batch.items.map((i) => ({ key: i.key, status: 'accepted' })) }));
        return;
      }
      if (req.method === 'GET' && path === '/lane/outbox/status') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ items: [] }));
        return;
      }
      const file = path === '/' ? 'migration.html' : path.replace(/^\//, '');
      try {
        const buf = await readFile(join(WEB_DIR, file));
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css'
          : file.endsWith('.webmanifest') ? 'application/manifest+json' : 'application/octet-stream';
        let body = buf.toString('utf8');
        if (file.endsWith('.html')) {
          body = body.replace('<!--SCREEN-DATA-->', `<script>window.migrationData = ${JSON.stringify(data).replace(/</g, '\\u003c')};window.laneWriteBase = location.origin;</script>`);
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

describe.skipIf(!HAVE_BROWSER)('the migration screen leaves payments and loyalty out in the mirror pilot — English and Tamil (MG-10 · OB-256)', () => {
  let browser: Browser;
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 90_000);
  afterAll(async () => { await browser?.close(); });

  const open = async (userId: string) => {
    const box = { batches: [] as Batch[] };
    const srv = await startShell(migrationData(userId), box);
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`${srv.base}/`, { waitUntil: 'load' });
    await page.waitForFunction(() => (globalThis as unknown as { migrationSession?: unknown }).migrationSession !== undefined, undefined, { timeout: 10_000 });
    return { page, box, errors, teardown: async () => { await context.close(); await srv.stop(); } };
  };
  const banner = (page: Page) => page.evaluate(() => {
    const d = (globalThis as unknown as { document: { getElementById(id: string): { hidden?: boolean; classList: { contains(c: string): boolean }; textContent: string | null } | null } }).document;
    const b = d.getElementById('banner');
    return { hidden: Boolean(b?.hidden), good: Boolean(b?.classList.contains('good')), text: d.getElementById('banner-text')?.textContent ?? '' };
  });
  const handed = async (box: { batches: Batch[] }, n: number) => {
    const deadline = Date.now() + 10_000;
    const items = () => box.batches.flatMap((b) => b.items.map((i) => ({ source: b.source, type: i.event.type, payload: i.event.payload })));
    while (items().length < n && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    return items();
  };

  it('the two cards say the decision and take no figures; the day is saved and signed on the four compared areas', async () => {
    const { page, box, errors, teardown } = await open('u-recon');
    try {
      await page.click('#tab-both');
      for (const area of ['payments', 'loyalty']) {
        expect(await page.textContent(`#day-${area}-off`)).toMatch(/^Not compared in the mirror pilot \(owner decision OB-256\)/);
        expect(await page.isVisible(`#day-${area}-old`)).toBe(false);
        expect(await page.isDisabled(`#day-${area}-old`)).toBe(true);
      }
      for (const area of ['sales_value', 'sales_count', 'stock_movement', 'tax']) expect(await page.isVisible(`#day-${area}-old`)).toBe(true);
      await page.fill('#day-date', DAY);
      for (const [area, old, now] of [['sales_value', '2100.00', '2100.00'], ['sales_count', '12', '12'], ['stock_movement', '30', '30'], ['tax', '100.00', '100.00']] as const) {
        await page.fill(`#day-${area}-old`, old);
        await page.fill(`#day-${area}-new`, now);
      }
      await page.click('#day-save');
      expect(await banner(page)).toMatchObject({ hidden: false, good: true });
      await page.click('#banner-ok');
      await page.fill('#day-statement', 'compared the old day-end report for the pilot department with the new day book');
      await page.click('#day-sign');
      expect(await banner(page)).toMatchObject({ hidden: false, good: true });
      await page.click('#banner-ok');
      const items = await handed(box, 2);
      expect(items.map((i) => i.type)).toEqual(['MigrationParallelDayEntered', 'MigrationParallelDaySigned']);
      const areas = (items[0]!.payload['comparisons'] as { area: string }[]).map((c) => c.area);
      expect(areas).toEqual(['sales_value', 'sales_count', 'stock_movement', 'tax']); // no payments or loyalty line, not a zero
      // Tamil: the same decision, in Tamil.
      await page.click('#lang');
      expect(await page.textContent('#day-payments-off')).toMatch(/^மிரர் பைலட்டில் ஒப்பிடப்படுவதில்லை \(உரிமையாளர் முடிவு OB-256\)/);
      expect(await page.textContent('#day-loyalty-off')).toMatch(/லாயல்டியையும் அதுவே வைத்திருக்கிறது/);
      expect(errors).toEqual([]);
    } finally {
      await teardown();
    }
  }, 60_000);
});
