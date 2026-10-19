import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { sliceTemplateCsv } from '../../packages/migration/src/slice-import';

/**
 * **MG-10 on the migration screen, in a real browser, in English and in Tamil (cutover readiness · OB-239).**
 *
 * The named daily reconciler types the old ERP's day-end totals beside the new system's, area by area. A difference
 * beyond the allowed amount is named on the page and needs a reason; the day cannot be signed while one has none. Once
 * every difference is explained the day is signed — and both acts are COMMITTED to the device queue and handed to the
 * store computer (hard rule #1), never kept only in the tab. The same page shows the witness figures and offers the
 * first department's four CSV templates for download, made in the page with no network (P-01).
 *
 * Synthetic data only. The suite skips where no browser binary is present, like the other delivery suites.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const WEB_DIR = 'apps/web-erp/web';
const DAY = '2026-10-10';

interface Batch { source: string; items: { key: string; event: { type: string; payload: Record<string, unknown> } }[] }

const migrationData = (userId: string): Record<string, unknown> => ({
  storeId: 'store-1', now: '2026-10-11T08:00:00.000Z', cutoverId: 'CUT-1', requiredCleanDays: 3, userId,
  loadOperator: 'u-loader', dailyReconcilerUserId: 'u-recon', parallelDays: [], parallelDifferences: [], parallelDaySignatures: [],
  verification: {
    covered: ['products', 'stock'], missing: ['bank'], signaturesOverThisPage: 0,
    findings: [
      { domain: 'stock', verdict: 'proved', figureLabel: '1,204 lines counted', provedBy: ['physical_count'], whatItCannotProve: 'that nothing was stolen before the count' },
      { domain: 'products', verdict: 'not_proved', whatItCannotProve: 'that every product was exported' },
    ],
  },
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

describe.skipIf(!HAVE_BROWSER)('the migration screen runs a parallel-run day — English and Tamil (MG-10)', () => {
  let browser: Browser;
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 90_000);
  afterAll(async () => { await browser?.close(); });

  const open = async (userId: string) => {
    const box = { batches: [] as Batch[] };
    const srv = await startShell(migrationData(userId), box);
    const context = await browser.newContext({ acceptDownloads: true });
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
  const dismiss = async (page: Page) => { await page.click('#banner-ok'); };
  const fillDay = async (page: Page) => {
    await page.click('#tab-both');
    await page.fill('#day-date', DAY);
    const figures: [string, string, string][] = [
      ['sales_value', '100000.00', '100000.00'], ['sales_count', '412', '412'], ['stock_movement', '1830', '1830'],
      ['tax', '9100.50', '9100.50'], ['payments', '100000.00', '99500.00'], ['loyalty', '2400', '2400'],
    ];
    for (const [area, old, now] of figures) {
      await page.fill(`#day-${area}-old`, old);
      await page.fill(`#day-${area}-new`, now);
    }
  };
  const handed = async (box: { batches: Batch[] }, n: number) => {
    const deadline = Date.now() + 10_000;
    const items = () => box.batches.flatMap((b) => b.items.map((i) => ({ source: b.source, type: i.event.type, payload: i.event.payload })));
    while (items().length < n && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    return items();
  };

  it('English: a difference is named and needs a reason; the day cannot be signed until it has one; both acts are queued and handed to the box', async () => {
    const { page, box, errors, teardown } = await open('u-recon');
    try {
      await fillDay(page);
      // The difference is named on the card as it is typed — ₹500 on payments, needing a reason.
      expect(await page.textContent('#day-payments-diff')).toMatch(/differs by ₹500\.00 — NEEDS A REASON/);
      await page.click('#day-save');
      expect(await banner(page)).toMatchObject({ hidden: false, good: false });
      await dismiss(page);
      // Signing is refused while the difference has no reason — and the refusal names it.
      await page.fill('#day-statement', 'compared the old day-end report with the new system day book, area by area');
      await page.click('#day-sign');
      const refused = await banner(page);
      expect(refused).toMatchObject({ hidden: false, good: false });
      expect(refused.text).toMatch(/Payments taken/);
      expect(refused.text).toMatch(/PD-2026-10-10-001/);
      await dismiss(page);
      expect(await page.textContent('#day-status')).toMatch(/NOT SIGNED/);

      // Explain it, save again, and sign.
      await page.fill('#day-payments-why', 'a UPI refund of 500 was keyed only in the old system — the customer was refunded once');
      await page.selectOption('#day-payments-side', 'legacy');
      await page.click('#day-save');
      expect(await banner(page)).toMatchObject({ hidden: false, good: true });
      await dismiss(page);
      await page.click('#day-sign');
      expect(await banner(page)).toMatchObject({ hidden: false, good: true });
      await dismiss(page);
      expect(await page.textContent('#day-status')).toMatch(/signed by u-recon/);

      const items = await handed(box, 3);
      expect(items.map((i) => i.type)).toEqual(['MigrationParallelDayEntered', 'MigrationParallelDayEntered', 'MigrationParallelDaySigned']);
      expect(items.every((i) => i.source === 'manager')).toBe(true);
      expect(items[1]!.payload).toMatchObject({ businessDate: DAY, enteredBy: 'u-recon', explanations: [{ area: 'payments', wrongSide: 'legacy' }] });
      expect(items[2]!.payload).toMatchObject({ businessDate: DAY, signedBy: 'u-recon' });

      // The witness figures and the four templates are on "The figures" tab — icons beside their words.
      await page.click('#tab-figures');
      expect(await page.textContent('#witness-summary')).toMatch(/2 \/ 3/);
      expect(await page.textContent('#witness-list')).toMatch(/1,204 lines counted/);
      expect(await page.textContent('#witness-list')).toMatch(/NOT PROVED YET/);
      expect(await page.locator('#templates-list button').count()).toBe(4);
      expect(await page.locator('#template-products svg.sre-icon').count()).toBe(1);
      const [download] = await Promise.all([page.waitForEvent('download'), page.click('#template-products')]);
      expect(download.suggestedFilename()).toBe('products.csv');
      const path = await download.path();
      expect(await readFile(path, 'utf8')).toBe(sliceTemplateCsv('products.csv'));
      expect(errors).toEqual([]);
    } finally {
      await teardown();
    }
  }, 60_000);

  it('Tamil: the same page in Tamil, and somebody who is not the named reconciler cannot enter a day — nothing is queued', async () => {
    const { page, box, errors, teardown } = await open('u-cashier');
    try {
      await page.setViewportSize({ width: 360, height: 800 }); // a phone: no sideways scroll on the page
      await page.click('#lang');
      await page.click('#tab-both');
      expect(await page.evaluate(() => { const d = (globalThis as unknown as { document: { documentElement: { scrollWidth: number; clientWidth: number } } }).document; return d.documentElement.scrollWidth <= d.documentElement.clientWidth + 1; })).toBe(true);
      expect(await page.textContent('#day-title')).toBe('ஒரு நாளைப் பதிவு செய்');
      expect(await page.textContent('#day-save')).toMatch(/நாளைச் சேமி/);
      expect(await page.locator('#day-save svg.sre-icon').count()).toBe(1);
      expect(await page.textContent('#day-payments-name')).toBe('பெற்ற பணம் (₹)');
      await fillDay(page);
      await page.click('#day-save');
      const refused = await banner(page);
      expect(refused).toMatchObject({ hidden: false, good: false });
      expect(refused.text).toBe('ஒவ்வொரு நாளும் சரிபார்க்கப் பெயரிடப்பட்டவர் மட்டுமே இங்கே நாளைப் பதிவு செய்யவோ கையெழுத்திடவோ முடியும்.');
      await dismiss(page);
      await page.click('#tab-figures');
      expect(await page.textContent('#witness-title')).toBe('வெளிச் சான்று என்ன சொல்கிறது');
      expect(await page.textContent('#template-prices')).toMatch(/பதிவிறக்கு/);
      await page.waitForTimeout(500);
      expect((await handed(box, 0)).length).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await teardown();
    }
  }, 60_000);
});
