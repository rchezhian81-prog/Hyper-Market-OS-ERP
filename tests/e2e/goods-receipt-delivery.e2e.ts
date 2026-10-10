import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';

/**
 * **The manager reviews goods receipts, in a real browser (M07-FR-02/03, ADR-0013 — the E2E matrix).**
 *
 * Every layer of "a manager opens the goods-receipt review and sees what came in the back door" is unit-tested —
 * the session's presenter, the browser's `fetchGoodsReceipt`, the cloud's GRN list route. The one thing units
 * cannot prove is that a person opening the actual screen in a browser makes that read reach the cloud under their
 * own session and render — deliveries needing a second person first (§28), the valued differences named, the
 * "as of" time — and that a reader without the permission is shown a plain not-permitted state and no figures.
 * This drives headless Chromium against a stub cloud to prove exactly that. Receiving itself is captured on the handheld;
 * the screen's ONE write (Batch 2) is proven here too: a held line a second person disposed of as a RETURN is recorded as
 * gone back to the supplier — offered only for such a line (never one needing a count first), a click POSTs exactly
 * `{ reason }` to the line's URL with no person in the body, the list is re-read and says it has gone; a cloud refusal is
 * shown verbatim; a reader without the right sees a word and no control.
 *
 * The browser binary is the environment's pre-installed Chromium; where none is present the suite SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const WEB_DIR = 'apps/web-erp/web';

interface BrowserGlobals {
  readonly goodsReceiptSession?: unknown;
  readonly document: {
    querySelectorAll(selector: string): { readonly length: number };
    getElementById(id: string): { readonly hidden?: boolean; readonly textContent?: string } | null;
  };
}

const AT = '2026-09-20T08:30:00.000Z';

/** The GRN list a manager's screen pulls: one delivery needing a second person (§28), then a clean one. */
const CLOUD = {
  receipts: [
    {
      grnId: 'g-approve', number: 'GRN-2', poId: 'po-2', warehouseId: 'W1', receivedBy: 'u-recv', receivedAt: AT,
      availableMinor: 80_00,
      captured: {
        requiresApproval: true, discrepancyValue: { minor: 150_00, currency: 'INR' },
        discrepancies: [{ lineId: 'l1', productId: 'p-oil', kind: 'excess', quantityMinor: 20_00, value: { minor: 150_00, currency: 'INR' }, requiresApproval: true, detail: '20 more than ordered' }],
        lines: [{ lineId: 'l1', productId: 'p-oil', sellableMinor: 80_00, quarantinedMinor: 0, rejectedMinor: 0, disposition: 'sellable', uom: 'ea', batchId: null, expiry: null }],
      },
    },
    {
      grnId: 'g-clean', number: 'GRN-1', poId: 'po-1', warehouseId: 'W1', receivedBy: 'u-recv', receivedAt: AT,
      availableMinor: 100_00,
      captured: {
        requiresApproval: false, discrepancyValue: { minor: 0, currency: 'INR' },
        discrepancies: [],
        lines: [{ lineId: 'l1', productId: 'p-rice', sellableMinor: 100_00, quarantinedMinor: 0, rejectedMinor: 0, disposition: 'sellable', uom: 'ea', batchId: null, expiry: null }],
      },
    },
  ],
  count: 2, needingApprovalCount: 1,
};

interface Recorder {
  goodsReceiptData: Record<string, unknown>;
  status: number; // status the GRN list GET answers with (200 authorised, 403 not)
  readonly gets: string[];
  /** Batch 2: the list this cloud answers (default CLOUD), the writes it took, and how it answers a return (201 / 409). */
  cloud?: { receipts: Record<string, unknown>[]; count: number; needingApprovalCount: number };
  writes?: { path: string; idempotencyKey: string | undefined; body: Record<string, unknown> }[];
  returnStatus?: number;
}

/** Batch 2: a delivery with a held line (2.5 kg paneer, cold chain broken) a second person disposed of as a RETURN, and one
 *  assembled from handheld scans whose disposed line needs a count first (head office would refuse it). */
const HELD = (): NonNullable<Recorder['cloud']> => ({
  receipts: [
    {
      grnId: 'g-held', number: 'GRN-3', poId: 'po-3', warehouseId: 'W1', receivedBy: 'u-recv', receivedAt: AT, availableMinor: 0,
      captured: {
        requiresApproval: false, discrepancyValue: { minor: 75_000, currency: 'INR' },
        discrepancies: [{ lineId: 'l2', productId: 'p-paneer', kind: 'temperature_breach', quantityMinor: 2_500, value: { minor: 75_000, currency: 'INR' }, requiresApproval: true, detail: 'arrived at 11°C' }],
        lines: [{ lineId: 'l2', productId: 'p-paneer', sellableMinor: 0, quarantinedMinor: 2_500, rejectedMinor: 0, disposition: 'quarantine', uom: 'kg', batchId: null, expiry: null, unitCost: { minor: 30_000, currency: 'INR' } }],
      },
      dispositions: [{ lineId: 'l2', productId: 'p-paneer', quantityMinor: 2_500, disposition: 'return', decidedBy: 'u-acct', decidedAt: AT, reason: 'cold chain broken', valueMinor: 75_000 }],
    },
    {
      grnId: 'g-scan', number: 'GRN-4', poId: 'po-4', warehouseId: 'W1', receivedBy: 'u-recv', receivedAt: AT, availableMinor: 0,
      assembledFrom: { scans: 2 }, governanceFlags: ['scan_posting_disagrees'],
      captured: {
        requiresApproval: false, discrepancyValue: { minor: 0, currency: 'INR' }, discrepancies: [],
        lines: [{ lineId: 'l1', productId: 'p-milk', sellableMinor: 0, quarantinedMinor: 6, rejectedMinor: 0, disposition: 'quarantine', uom: 'ea', batchId: null, expiry: null, unitCost: { minor: 2_800, currency: 'INR' } }],
      },
      dispositions: [{ lineId: 'l1', productId: 'p-milk', quantityMinor: 6, disposition: 'return', decidedBy: 'u-acct', decidedAt: AT, reason: 'leaking', valueMinor: 16_800 }],
    },
  ],
  count: 2, needingApprovalCount: 0,
});

/** A server that serves the goods-receipt shell (GET, operator context injected) AND answers the GRN list read
 *  on the same origin, so `credentials:'same-origin'` and a relative `/v1/inventory/...` reach it as in prod. */
async function startShellAndCloud(rec: Recorder): Promise<{ base: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const [path = '/'] = (req.url ?? '/').split('?');
      if (req.method === 'POST' && path.startsWith('/v1/inventory/goods-receipt/') && path.endsWith('/returned')) {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const raw = Buffer.concat(chunks).toString('utf8');
        const body = raw === '' ? {} : JSON.parse(raw) as Record<string, unknown>;
        const key = req.headers['idempotency-key'];
        (rec.writes ??= []).push({ path, idempotencyKey: typeof key === 'string' ? key : undefined, body });
        const [, , , , grnId = '', , lineId = ''] = path.split('/'); // '', v1, inventory, goods-receipt, <grn>, lines, <line>, returned
        res.writeHead(rec.returnStatus ?? 201, { 'content-type': 'application/json' });
        if ((rec.returnStatus ?? 201) >= 400) {
          res.end(JSON.stringify({ error: { code: 'line_not_disposed_for_return', whatHappened: `Line ${lineId} of ${grnId} has no disposition yet — a second person must decide to return it.`, wasItSaved: 'not_saved', nextSafeAction: 'Read the list again.' } }));
          return;
        }
        // The cloud's own state change: the line's return is on the record (recorded by the CALLER, never a body field).
        if (rec.cloud !== undefined) {
          rec.cloud = { ...rec.cloud, receipts: rec.cloud.receipts.map((g) => (g['grnId'] !== grnId ? g : { ...g, lineReturns: [{ lineId, productId: 'p-paneer', quantityMinor: 2_500, valueMinor: 75_000, currency: 'INR', returnedBy: 'u-mgr', returnedAt: AT, reason: body['reason'], movementIds: [] }] })) };
        }
        res.end(JSON.stringify({ grnId, lineId, alreadyReturned: false }));
        return;
      }
      if (path.startsWith('/v1/inventory/goods-receipt')) {
        rec.gets.push(path);
        res.writeHead(rec.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(rec.status < 400 ? rec.cloud ?? CLOUD : { code: 'forbidden' }));
        return;
      }
      const file = path === '/' || path === '/goods-receipt' ? 'goods-receipt.html' : path.replace(/^\//, '');
      try {
        const buf = await readFile(join(WEB_DIR, file));
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream';
        let html = buf.toString('utf8');
        if (file.endsWith('.html')) {
          const inject = `<script>window.goodsReceiptData = ${JSON.stringify(rec.goodsReceiptData).replace(/</g, '\\u003c')};</script>`;
          html = html.replace('<!--SCREEN-DATA-->', inject);
        }
        res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
        res.end(html);
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

const readerWith = (permissions: readonly string[]): Record<string, unknown> => ({ userId: 'u-mgr', permissions });

describe.skipIf(!HAVE_BROWSER)('manager goods-receipt review, end to end in a real browser (M07)', () => {
  let browser: Browser;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  const open = async (rec: Recorder) => {
    const srv = await startShellAndCloud(rec);
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${srv.base}/`, { waitUntil: 'load' });
    await page.waitForFunction(() => (globalThis as unknown as BrowserGlobals).goodsReceiptSession !== undefined, undefined, { timeout: 10_000 });
    return { srv, context, page, teardown: async () => { await context.close(); await srv.stop(); } };
  };

  it('an authorised manager sees the deliveries — exceptions first, the differences named and priced', async () => {
    const rec: Recorder = { goodsReceiptData: readerWith(['inventory.availability.read']), status: 200, gets: [] };
    const { page, teardown } = await open(rec);
    try {
      // The screen auto-reads the GRN list on load and renders it — wait for the rows to appear.
      await page.waitForFunction(() => (globalThis as unknown as BrowserGlobals).document.querySelectorAll('#rows li.row').length > 0, undefined, { timeout: 10_000 });

      // The read reached the cloud under the manager's own session.
      expect(rec.gets.some((p) => p.startsWith('/v1/inventory/goods-receipt'))).toBe(true);
      // Exceptions first: the needs-a-second-person delivery renders as an error-tone row (not colour alone).
      expect(await page.evaluate(() => (globalThis as unknown as BrowserGlobals).document.querySelectorAll('#rows li.row.tone-error').length), 'no needs-approval signal rendered').toBeGreaterThan(0);
      // The first row is the one that needs approval (worst-first), and it carries a screen-reader word.
      const firstAnnounced = await page.getAttribute('#rows li.row .status', 'aria-label');
      expect((firstAnnounced ?? '').length).toBeGreaterThan(0);
      // The valued difference is shown in rupees.
      expect((await page.textContent('#rows')) ?? '').toContain('₹');
      // Freshness is on the page.
      expect(((await page.textContent('#asof')) ?? '').toLowerCase()).toContain('as of');
    } finally {
      await teardown();
    }
  });

  it('Refresh re-reads the deliveries from the cloud (a browser→cloud read, on demand)', async () => {
    const rec: Recorder = { goodsReceiptData: readerWith(['inventory.availability.read']), status: 200, gets: [] };
    const { page, teardown } = await open(rec);
    try {
      await page.waitForFunction(() => (globalThis as unknown as BrowserGlobals).document.querySelectorAll('#rows li.row').length > 0, undefined, { timeout: 10_000 });
      const afterLoad = rec.gets.length;
      expect(afterLoad).toBeGreaterThanOrEqual(1);

      await page.click('#refresh');
      const grew = await new Promise<boolean>((resolve) => {
        const started = Date.now();
        const tick = (): void => {
          if (rec.gets.length > afterLoad) { resolve(true); return; }
          if (Date.now() - started > 5_000) { resolve(false); return; }
          setTimeout(tick, 50);
        };
        tick();
      });
      expect(grew, 'Refresh did not re-read the cloud').toBe(true);
    } finally {
      await teardown();
    }
  });

  it('Batch 2 · a held line disposed of as a return is recorded as gone back: offered only for such a line, POSTs exactly { reason }, then the list says it has gone', async () => {
    const rec: Recorder = { goodsReceiptData: readerWith(['inventory.availability.read', 'inventory.movement.append']), status: 200, gets: [], cloud: HELD() };
    const { page, teardown } = await open(rec);
    try {
      await page.waitForFunction(() => (globalThis as unknown as BrowserGlobals).document.querySelectorAll('#rows li.row').length > 0, undefined, { timeout: 10_000 });
      await page.waitForSelector('#returner:not([hidden])');
      // Both lines are on the list in words; the scan-assembled one says count first and is NOT offered (OB-31: 2.5 kg, not 2500).
      const rows = (await page.textContent('#rows')) ?? '';
      expect(rows).toContain('Waiting to go back to the supplier');
      expect(rows).toContain('Count it first');
      expect(rows).toContain('p-paneer × 2.5 kg');
      expect(await page.$$eval('#return-line option', (els) => els.map((e) => (e as unknown as { value: string }).value))).toEqual(['g-held|l2']);
      // A reason is needed — refused on the screen, nothing sent.
      await page.click('#return');
      await page.waitForSelector('#result:not([hidden])');
      expect((await page.textContent('#result-text')) ?? '').toContain('Say how it went back');
      expect(rec.writes ?? []).toHaveLength(0);

      await page.fill('#return-reason', 'the supplier driver collected it, van KA-01');
      await page.click('#return');
      await page.waitForFunction(() => ((globalThis as unknown as BrowserGlobals).document.getElementById('result-text')?.textContent ?? '').includes('Recorded'), undefined, { timeout: 10_000 });
      expect(rec.writes).toEqual([{ path: '/v1/inventory/goods-receipt/g-held/lines/l2/returned', idempotencyKey: expect.any(String), body: { reason: 'the supplier driver collected it, van KA-01' } }]);
      // Re-read: the line has gone back, by whom, and is offered no more.
      await page.waitForSelector('#rows ul.returns li[data-line-id="l2"][data-state="returned"]', { timeout: 10_000 });
      expect((await page.textContent('#rows ul.returns li[data-line-id="l2"]')) ?? '').toContain('sent back by u-mgr');
      expect(await page.$$eval('#return-line option', (els) => els.length)).toBe(0);
      expect(((await page.textContent('#return-none')) ?? '').length).toBeGreaterThan(0);
      // The scan-assembled line is refused by the session without a request.
      expect(await page.evaluate(() => (globalThis as unknown as { goodsReceiptSession: { recordReturn(i: unknown): Promise<{ outcome: string }> } }).goodsReceiptSession.recordReturn({ grnId: 'g-scan', lineId: 'l1', reason: 'collected' }))).toEqual({ outcome: 'needs_count' });
      expect(rec.writes).toHaveLength(1);
    } finally {
      await teardown();
    }
  });

  it('Batch 2 · a cloud refusal is shown verbatim and never claimed as recorded; without the right a word says so and no control is shown', async () => {
    const rec: Recorder = { goodsReceiptData: readerWith(['inventory.availability.read', 'inventory.movement.append']), status: 200, gets: [], cloud: HELD(), returnStatus: 409 };
    const { page, teardown } = await open(rec);
    try {
      await page.waitForSelector('#returner:not([hidden])', { timeout: 10_000 });
      await page.waitForSelector('#return-line option', { state: 'attached', timeout: 10_000 });
      await page.fill('#return-reason', 'collected by the driver');
      await page.click('#return');
      await page.waitForFunction(() => ((globalThis as unknown as BrowserGlobals).document.getElementById('result-text')?.textContent ?? '').includes('Head office refused'), undefined, { timeout: 10_000 });
      const text = (await page.textContent('#result-text')) ?? '';
      expect(text).toContain('a second person must decide to return it');
      expect(text).not.toContain('Recorded');
    } finally {
      await teardown();
    }
    const without: Recorder = { goodsReceiptData: readerWith(['inventory.availability.read']), status: 200, gets: [], cloud: HELD() };
    const second = await open(without);
    try {
      await second.page.waitForFunction(() => (globalThis as unknown as BrowserGlobals).document.querySelectorAll('#rows li.row').length > 0, undefined, { timeout: 10_000 });
      expect(await second.page.isHidden('#returner')).toBe(true);
      expect((await second.page.textContent('#no-return')) ?? '').toContain('stock-movement permission');
    } finally {
      await second.teardown();
    }
  });

  it('a reader WITHOUT the permission sees a plain not-permitted state and no deliveries', async () => {
    const rec: Recorder = { goodsReceiptData: readerWith([]), status: 403, gets: [] };
    const { page, teardown } = await open(rec);
    try {
      await page.waitForSelector('#state:not([hidden])', { timeout: 10_000 });
      expect(await page.evaluate(() => (globalThis as unknown as BrowserGlobals).document.querySelectorAll('#rows li.row').length)).toBe(0);
      expect(((await page.textContent('#state-text')) ?? '').toLowerCase()).toContain('permission');
    } finally {
      await teardown();
    }
  });
});
