import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';

/**
 * **Round B (screen gap audit 31 Oct 2026, OB-614 "wrong numbers first"): the handhelds, in real Chromium.**
 *
 *   • The warehouse handheld showed "prod-rice 200000 units · kg": the product's CODE, and a kg line's grams read as units.
 *     It now shows the product's name (Tamil where recorded) and "200.000 kg".
 *   • The warehouse, picker and driver handhelds said "the store computer could not be reached, trying again" when the
 *     store computer had ANSWERED 403 — not allowed — and kept retrying every ten seconds for ever. Each now says plainly
 *     that the person is not allowed (English and Tamil), keeps the work on the handheld, and stops retrying by itself.
 *
 * The store box's proxy, minus the box: the shell's files with the work injected where the box puts it, and the box's
 * device routes answering as a real box would (`/lane/sync-status`, `/lane/outbox`). Synthetic data. Skips without a browser.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);

interface Shell { readonly app: string; readonly global: string; readonly ready: string; readonly data: Record<string, unknown> }

const WAREHOUSE: Shell = {
  app: 'warehouse-app', global: 'warehouseData', ready: 'warehouseSession',
  data: {
    assignmentId: 'A-RB', workerId: 'u-worker', storeId: 'store-1',
    bins: [{ binId: 'BIN-A', storeId: 'store-1', capacityMinor: 1_000_000, pickable: true, zone: 'ambient' }],
    goodsIn: [{ productId: 'prod-rice-loose', batchId: null, quantityMinor: 200_000, uom: 'kg', state: 'on_hand', expiry: null, recalled: false }],
    pickLines: [{ lineId: 'pl-1', orderRef: 'ORD-77', productId: 'prod-soap', batchId: null, binId: 'BIN-A', quantityMinor: 12, uom: 'ea' }],
    productNames: { 'prod-rice-loose': 'Demo Ponni Rice (loose)', 'prod-soap': 'Demo Bath Soap 100g' },
    productNamesTa: { 'prod-rice-loose': 'டெமோ பொன்னி அரிசி' },
  },
};
const PICKER: Shell = {
  app: 'picker-app', global: 'pickerData', ready: 'pickSession',
  data: { waveId: 'W-1', pickerId: 'u-picker', orderedBy: 'shelf order',
    lines: [{ lineId: 'l1', orderRef: 'ORD-1', productId: 'MILK', description: 'Aavin Milk 1L', bin: 'A-01', requiredQty: 2, uom: 'ea', unitPrice: { minor: 6000, currency: 'INR' } }] },
};
const DRIVER: Shell = {
  app: 'delivery-app', global: 'driverData', ready: 'routeSession',
  data: { routeId: 'R-1', driverId: 'u-driver', stops: [{ stopId: 's1', orderRef: 'ORD-1041', area: 'Anna Nagar, 3rd St', codMinor: 0 }] },
};

const REASON = 'u-cashier may not hand over warehouse work';

/** Serve a shell as the box does, its device routes answering 200 (allowed) or 403 (not allowed). Counts hand-over posts. */
async function serve(shell: Shell, mode: 'allowed' | 'forbidden'): Promise<{ base: string; posts: () => number; stop: () => Promise<void> }> {
  const dir = join('apps', shell.app, 'web');
  let posts = 0;
  const json = (res: import('node:http').ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const server: Server = createServer((req, res) => {
    void (async () => {
      const [path = '/'] = (req.url ?? '/').split('?');
      if (path === '/lane/sync-status') {
        if (mode === 'forbidden') { json(res, 403, { error: 'not_allowed', detail: REASON }); return; }
        json(res, 200, { cloud: 'online', lastContactAt: new Date().toISOString() }); return;
      }
      if (path === '/lane/outbox') {
        posts += 1;
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        if (mode === 'forbidden') { json(res, 403, { acks: [], reason: REASON }); return; }
        const sent = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { items: { key: string }[] };
        json(res, 200, { acks: sent.items.map((i) => ({ key: i.key, status: 'accepted' })), boxNow: new Date().toISOString() }); return;
      }
      if (path === '/lane/outbox/status') { json(res, 200, { items: [] }); return; }
      const file = path === '/' || path === '/index.html' ? 'index.html' : path.replace(/^\//, '');
      try {
        let text = (await readFile(join(dir, file))).toString('utf8');
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.webmanifest') ? 'application/manifest+json' : 'application/octet-stream';
        if (file === 'index.html') {
          // Where the box puts the work, and its write base: '' — the page's own origin, as on the device socket.
          text = text.replace('<!--SCREEN-DATA-->', `<script>window.${shell.global} = ${JSON.stringify(shell.data).replace(/</g, '\\u003c')}; window.laneWriteBase = '';</script>`);
        }
        res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
        res.end(text);
      } catch {
        res.writeHead(404); res.end('not found');
      }
    })();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      resolve({ base: `http://127.0.0.1:${port}`, posts: () => posts, stop: () => new Promise((done) => { server.close(() => { done(); }); server.closeAllConnections(); }) });
    });
  });
}

describe.skipIf(!HAVE_BROWSER)('Round B: the handhelds name the product, read its unit, and say "not allowed" plainly', () => {
  let browser: Browser;
  const stops: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    for (const shell of [WAREHOUSE, PICKER, DRIVER]) execFileSync('node', ['scripts/build-app.mjs', shell.app], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 180_000);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop(); });

  async function open(shell: Shell, mode: 'allowed' | 'forbidden', fakeClock = false): Promise<{ page: Page; posts: () => number; errors: string[] }> {
    const srv = await serve(shell, mode);
    stops.push(srv.stop);
    const context = await browser.newContext({ viewport: { width: 412, height: 740 }, hasTouch: true, isMobile: true });
    stops.push(() => context.close());
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    if (fakeClock) await page.clock.install();
    await page.goto(`${srv.base}/`, { waitUntil: 'load' });
    await page.waitForFunction(`globalThis.${shell.ready} !== undefined`, undefined, { timeout: 15_000 });
    return { page, posts: srv.posts, errors };
  }
  const tamil = async (page: Page): Promise<void> => { await page.click('#lang'); await page.waitForFunction('document.documentElement.lang === "ta"'); };

  it('warehouse: goods waiting read "Demo Ponni Rice (loose) — 200.000 kg", never "prod-rice-loose 200000 units · kg"', async () => {
    const { page, errors } = await open(WAREHOUSE, 'allowed');
    await page.waitForSelector('#goods-in .item');
    expect(await page.textContent('#goods-in .item .what')).toBe('Demo Ponni Rice (loose)');
    expect(await page.textContent('#goods-in .item .qty')).toBe('200.000 kg');
    // A count of pieces keeps its words; the pick line names the product, not its code.
    expect(await page.textContent('#pick-lines .item .what')).toBe('ORD-77 · Demo Bath Soap 100g');
    expect(await page.textContent('#pick-lines .item .qty')).toBe('12 units · ea');
    await tamil(page);
    expect(await page.textContent('#goods-in .item .what')).toBe('டெமோ பொன்னி அரிசி');
    // Allowed: no "not allowed" anywhere.
    expect(await page.isHidden('#not-allowed')).toBe(true);
    expect(errors).toEqual([]);
  });

  it('warehouse: a 403 says "not allowed" (English and Tamil), keeps the work, and the timer stops asking', async () => {
    const { page, posts, errors } = await open(WAREHOUSE, 'forbidden', true);
    // One put-away, queued on the handheld exactly as the screen's own flow queues it.
    await page.evaluate(() => {
      const w = (globalThis as unknown as { warehouseSession: { putAway(i: unknown): unknown } }).warehouseSession;
      w.putAway({ commandId: 'm-1', scannedProductId: 'prod-rice-loose', scannedBinId: 'BIN-A', quantityMinor: 2_500, uom: 'kg', at: new Date().toISOString() });
    });
    await page.clock.runFor(10_500); // the slow timer's first pass hands the work over — and the box answers 403
    await page.waitForSelector('#not-allowed:not([hidden])', { timeout: 10_000 });
    expect(await page.textContent('#not-allowed')).toContain('You are not allowed to send this work from this handheld');
    expect(await page.textContent('#not-allowed')).toContain(REASON);
    expect(await page.textContent('#box-text')).toBe('store computer says: not allowed');
    const pill = (await page.textContent('#sent-work .sent .pill')) ?? '';
    expect(pill).toContain('you are not allowed to send this');
    expect(pill).not.toContain('could not be reached');
    expect(await page.textContent('#sent-work .sent .what')).toContain('Demo Ponni Rice (loose) · BIN-A — 2.500 kg');
    // The work is still on the handheld, and the slow timer no longer asks.
    expect(await page.evaluate(() => (globalThis as unknown as { warehouseOutbox: { unsentCount(): number } }).warehouseOutbox.unsentCount())).toBe(1);
    const asked = posts();
    expect(asked).toBeGreaterThanOrEqual(1);
    await page.clock.runFor(65_000);
    expect(posts()).toBe(asked);
    await tamil(page);
    expect(await page.textContent('#not-allowed')).toContain('அனுப்ப உங்களுக்கு அனுமதி இல்லை');
    expect(await page.textContent('#box-text')).toBe('கடை கணினி: அனுமதி இல்லை');
    expect(errors).toEqual([]);
  });

  for (const shell of [PICKER, DRIVER]) {
    it(`${shell.app}: a store computer that answers 403 is "not allowed", never "not answering" — in English and Tamil`, async () => {
      const { page, errors } = await open(shell, 'forbidden');
      await page.waitForSelector('#not-allowed:not([hidden])', { timeout: 10_000 });
      expect(await page.textContent('#not-allowed')).toContain('You are not allowed to send this work');
      expect(await page.textContent('#box-text')).toBe('store computer says: not allowed');
      expect(await page.textContent('#box-text')).not.toContain('not answering');
      await tamil(page);
      expect(await page.textContent('#not-allowed')).toContain('அனுமதி இல்லை');
      expect(errors).toEqual([]);
    });
  }
});
