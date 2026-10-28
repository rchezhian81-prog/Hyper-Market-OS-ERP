import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';

/**
 * **Round 9 · R9-A · OB-534 — "Match the bill" on the goods-receipt screen, in a real browser.** A delivery with a line no
 * supplier bill is matched to yet offers the bill number field and the "Match the bill" button (beside its icon) to a reader
 * holding the bill-match right; the person who RECEIVED the goods is told someone else matches it, and gets no button. An
 * unknown bill is said by name; the matched bill is shown afterwards (which bill, what cost, by whom). English, then Tamil.
 * A stub head office answers on the same origin: the receipts list and the existing bill-match route.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const WEB_DIR = 'apps/web-erp/web';
const AT = '2026-10-20T08:30:00.000Z';

const receipt = (billCosts: unknown[] | undefined) => ({
  grnId: 'g-1', number: 'GRN-7', poId: null, warehouseId: 'wh-1', receivedBy: 'u-recv', receivedAt: AT, availableMinor: 10,
  captured: {
    requiresApproval: false, discrepancyValue: { minor: 0, currency: 'INR' }, discrepancies: [],
    lines: [{ lineId: 'L1', productId: 'p-brm', sellableMinor: 10, quarantinedMinor: 0, rejectedMinor: 0, disposition: 'sellable', uom: 'ea', batchId: null, expiry: null, unitCost: { minor: 0, currency: 'INR' }, costNotKnown: true }],
  },
  costNotKnown: [{ lineId: 'L1', productId: 'p-brm', quantityMinor: 10, uom: 'ea', because: 'no_issued_order', detail: 'x' }],
  ...(billCosts === undefined ? {} : { billCosts }),
});
const MATCHED = { lineId: 'L1', productId: 'p-brm', invoiceId: 'INV-1', unitCost: { minor: 4_200, currency: 'INR' }, quantityMinor: 10, valueMinor: 42_000, matchedBy: 'u-owner', matchedAt: AT };

async function startShell(): Promise<{ base: string; posts: unknown[]; stop: () => Promise<void> }> {
  const posts: unknown[] = [];
  let matched = false;
  const server: Server = createServer((req, res) => {
    void (async () => {
      const [path = '/', search = ''] = (req.url ?? '/').split('?');
      const json = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.method === 'POST' && path === '/v1/inventory/goods-receipt/g-1/bill-match') {
        let raw = '';
        for await (const chunk of req) raw += String(chunk);
        const body = JSON.parse(raw) as { invoiceId?: string };
        posts.push(body);
        if (body.invoiceId !== 'INV-1') { json(404, { error: { code: 'bill_unknown', whatHappened: `No supplier bill ${body.invoiceId} is on head office's register.` } }); return; }
        matched = true;
        json(201, { grnId: 'g-1', matched: [MATCHED], stillNotKnown: [], alreadyMatched: false });
        return;
      }
      if (path.startsWith('/v1/inventory/goods-receipt')) { json(200, { receipts: [receipt(matched ? [MATCHED] : undefined)], count: 1, needingApprovalCount: 0 }); return; }
      const file = path === '/' ? 'goods-receipt.html' : path.replace(/^\//, '');
      try {
        const buf = await readFile(join(WEB_DIR, file));
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream';
        let body = buf.toString('utf8');
        const as = new URLSearchParams(search).get('as') ?? 'u-owner';
        if (file.endsWith('.html')) body = body.replace('<!--SCREEN-DATA-->', `<script>window.goodsReceiptData = ${JSON.stringify({ userId: as, permissions: ['inventory.availability.read', 'purchase.invoice.match'] })};</script>`);
        res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
        res.end(body);
      } catch {
        res.writeHead(404); res.end('not found');
      }
    })();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      resolve({ base: `http://127.0.0.1:${port}`, posts, stop: () => new Promise((done) => { server.close(() => { done(); }); server.closeAllConnections(); }) });
    });
  });
}

const says = (page: Page, selector: string, text: string) => page.waitForFunction(([sel, want]) => {
  const node = (globalThis as unknown as { document: { querySelector(s: string): { textContent: string | null } | null } }).document.querySelector(sel!);
  return (node?.textContent ?? '').includes(want!);
}, [selector, text], { timeout: 15_000 });

describe.skipIf(!HAVE_BROWSER)('the goods-receipt screen matches the supplier bill (OB-534)', () => {
  let browser: Browser;
  let shell: Awaited<ReturnType<typeof startShell>>;
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
    shell = await startShell();
  }, 120_000);
  afterAll(async () => { await browser?.close(); await shell?.stop(); });

  it('the person who received the goods is told someone else matches the bill — no button; Tamil too', async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 900 } });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    try {
      await page.goto(`${shell.base}/?as=u-recv`, { waitUntil: 'load' });
      await says(page, '#rows .bill-match', 'You received these goods, so someone else (the buyer or the accountant) matches their supplier bill.');
      expect(await page.$('#rows .bill-match-btn')).toBeNull();
      await page.click('#lang');
      await says(page, '#rows .bill-match', 'இந்தச் சரக்கை நீங்கள் பெற்றீர்கள்');
      expect(shell.posts).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 90_000);

  it('another reader types the bill number and presses "Match the bill": an unknown bill is said; then the bill is matched and shown', async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 900 } });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    try {
      await page.goto(`${shell.base}/?as=u-owner`, { waitUntil: 'load' });
      await says(page, '#rows .bill-match-btn', 'Match the bill');
      // The button carries its icon beside the words, and is large enough to press.
      expect(await page.$('#rows .bill-match-btn svg')).not.toBeNull();
      expect((await page.locator('#rows .bill-match-btn').boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await page.fill('#rows .bill-invoice', 'INV-404');
      await page.click('#rows .bill-match-btn');
      await says(page, '#result-text', 'Not matched — head office has no such supplier bill.');
      await says(page, '#result-text', 'No supplier bill INV-404');
      await page.fill('#rows .bill-invoice', 'INV-1');
      await page.click('#rows .bill-match-btn');
      await says(page, '#result-text', 'Bill matched to this delivery.');
      await says(page, '#rows .bill-match', 'Bill INV-1 matched: p-brm at ₹42.00 each — by u-owner');
      await page.waitForFunction(() => (globalThis as unknown as { document: { querySelector(s: string): unknown } }).document.querySelector('#rows .bill-match-btn') === null, undefined, { timeout: 15_000 });
      expect(shell.posts).toEqual([{ invoiceId: 'INV-404' }, { invoiceId: 'INV-1' }]);
      await page.click('#lang');
      await says(page, '#rows .bill-match', 'பில் INV-1 பொருத்தப்பட்டது: p-brm ஒன்றுக்கு ₹42.00 — பொருத்தியவர் u-owner');
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 90_000);
});
