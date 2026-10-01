import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';

/**
 * **The merchandising screen's two saves leave the page, in a real browser (SP-8c-ii · F08 · M04-FR-02/03 · WF-06 · §31 ·
 * P-01 · P-08 — ADR-0013 the E2E matrix).**
 *
 * The audit's F08, at this surface: the shelf count saved on the merchandising screen changed the page and nothing else, and a
 * refill task was a line on a list nobody could act on from here. Every layer below the browser is unit-tested — the session
 * model, the composition root's shared queue and relay, the cloud's synced shelf-count route with real RBAC, the box → cloud
 * relay. The one thing units cannot prove is that a person at the ACTUAL screen in a browser:
 *
 *   • COUNTS a shelf and the count is on the DURABLE device queue before the screen says saved, then WITH THE STORE COMPUTER
 *     (on the REAL box: on its fsync'd device-events log and in its queue for head office), listed with the five shared state
 *     words, "posted" only on the box's word — and RELOADING the page still lists it and sends nothing twice;
 *   • turns the refill tasks into ONE indent with one tap, on the SAME queue, through the Indents session — the same record
 *     the floor raises by hand — and a second tap raises nothing new;
 *   • with nobody named at the screen is REFUSED the count, in words, with nothing saved.
 *
 * Head office delivery from the box is proven by `tests/integration/shelf-count.test.ts` (real API, real box).
 * The browser binary is the environment's pre-installed Chromium; where none is present the suite SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const WEB_DIR = 'apps/web-erp/web';
const KEY = ['merchandising', 'count', 'refill', 'signing', 'key'].join('-').padEnd(48, '0');
const TENANT = 't-sre';
const NOW = '2026-10-01T10:00:00.000Z';

interface MerchWindow {
  readonly laneWriteBase?: string;
  readonly merchandisingRelay?: unknown;
  readonly merchandisingSession?: {
    savedCounts(): { countId: string; state: string }[];
    refills(): { tasks: unknown[]; canRaise: boolean; alreadySaved: boolean; saved: { indentId: string; state: string }[] };
    raiseRefill(): { ok: boolean; alreadySaved?: boolean; refusal?: string };
  };
  readonly merchandisingGaps?: string[];
}

/** The shop as the box tells the screen it: one shelf map, one plan (24 rice on A1, 18 oil on B3), stock in the back, nobody has counted. */
const SHOP = {
  storeId: 'S1', today: '2026-10-01', now: NOW, refillAtBp: 5_000, countStaleAfterMinutes: 120, refillRole: 'shelf-filler',
  shelfLocations: [
    { storeId: 'S1', locationId: 'L-A1', aisle: 1, rack: 1, bay: 1, shelf: 1, position: 1, label: 'A1' },
    { storeId: 'S1', locationId: 'L-B3', aisle: 2, rack: 3, bay: 1, shelf: 1, position: 1, label: 'B3' },
  ],
  shelfAssignments: [
    { storeId: 'S1', productId: 'RICE', locationId: 'L-A1', capacityMinor: 24, primary: true },
    { storeId: 'S1', productId: 'OIL', locationId: 'L-B3', capacityMinor: 18, primary: true },
  ],
  planogram: {
    planogramId: 'pg-1', storeId: 'S1', version: 1, effectiveFrom: '2026-09-01', createdBy: 'u-merch',
    assignments: [
      { storeId: 'S1', productId: 'RICE', locationId: 'L-A1', capacityMinor: 24, primary: true },
      { storeId: 'S1', productId: 'OIL', locationId: 'L-B3', capacityMinor: 18, primary: true },
    ],
  },
  shelfCounts: [], backstock: { RICE: 100, OIL: 100 }, assortment: [], spaceAreas: [],
};
const INDENTS = { userId: 'u-merch', permissions: ['inventory.indent.read', 'inventory.indent.request'], storeId: 'S1', backStoreId: 'S1-BACK', products: [{ productId: 'RICE', name: 'Rice 5kg', uom: 'EA' }, { productId: 'OIL', name: 'Oil 1l', uom: 'LTR' }] };
const merchandisingData = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ ...SHOP, userId: 'u-merch', indents: INDENTS, ...over });

/** The box's pack for the real-box case: the same shop, with who is at the merchandising screen and the Indents policy. */
const PACK_JSON = JSON.stringify({
  version: 1,
  policies: { tradingDayCutoff: '02:00', storeId: 'S1', branchId: 'S1', warehouseId: 'S1-BACK' },
  merchandisingPolicy: { refillAtBp: 5_000, countStaleAfterMinutes: 120, refillRole: 'shelf-filler', userId: 'u-merch' },
  indentsPolicy: { userId: 'u-merch', permissions: ['inventory.indent.read', 'inventory.indent.request'] },
  shelfLocations: SHOP.shelfLocations, shelfAssignments: SHOP.shelfAssignments, planogram: SHOP.planogram, shelfCounts: [], backstock: SHOP.backstock,
  products: [
    { productId: 'RICE', name: 'Rice 5kg', categoryId: 'grocery', unitPriceMinor: 45_000, uom: 'EA', barcodes: [], availableMinor: 50, taxBps: 0, status: 'active' },
    { productId: 'OIL', name: 'Oil 1l', categoryId: 'grocery', unitPriceMinor: 18_000, uom: 'LTR', barcodes: [], availableMinor: 20, taxBps: 0, status: 'active' },
  ],
  lossPreventionRules: [],
});

interface HandedItem { readonly key: string; readonly event: { type: string; payload: Record<string, unknown> } }
interface Recorder { data: Record<string, unknown>; readonly handed: HandedItem[] }

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw === '' ? {} : JSON.parse(raw) as Record<string, unknown>;
}

/** Serves the merchandising shell (the box's payload + `window.laneWriteBase` = this origin injected) AND the box's `/lane/outbox`
 *  socket on one origin, so `credentials:'same-origin'` and relative paths work as in prod. */
async function startShellAndSocket(rec: Recorder): Promise<{ base: string; stop: () => Promise<void> }> {
  let base = '';
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const [path = '/', query = ''] = (req.url ?? '/').split('?');
      const json = (status: number, body: unknown): void => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.method === 'POST' && path === '/lane/outbox') {
        const body = await readJson(req);
        const items = (Array.isArray(body['items']) ? body['items'] : []) as HandedItem[];
        rec.handed.push(...items);
        json(200, { acks: items.map((i) => ({ key: i.key, status: 'accepted' })) });
        return;
      }
      if (req.method === 'GET' && path === '/lane/outbox/status') {
        const keys = decodeURIComponent(query.replace(/^keys=/, '')).split(',').filter((k) => k !== '');
        json(200, { items: keys.map((key) => ({ key, state: 'posted', attempts: 1 })) });
        return;
      }
      const file = path === '/' || path === '/merchandising' || path === '/merchandising/' ? 'merchandising.html' : path.replace(/^\/(merchandising\/)?/, '');
      try {
        const buf = await readFile(join(WEB_DIR, file));
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream';
        let html = buf.toString('utf8');
        if (file.endsWith('.html')) {
          const inject = `<script>window.merchandisingData = ${JSON.stringify(rec.data).replace(/</g, '\\u003c')}; window.laneWriteBase = ${JSON.stringify(base)};</script>`;
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
      base = `http://127.0.0.1:${port}`;
      resolve({ base, stop: () => new Promise((done) => { server.close(() => { done(); }); server.closeAllConnections(); }) });
    });
  });
}

describe.skipIf(!HAVE_BROWSER)('the merchandising screen: a count and a refill ask leave the page, in a real browser (SP-8c-ii · F08 · §31)', () => {
  let browser: Browser;
  const dirs: string[] = [];
  const stops: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 180_000);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => {
    for (const stop of stops.splice(0).reverse()) await stop();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  const ready = (page: Page) => page.waitForFunction(() => (globalThis as unknown as MerchWindow).merchandisingSession !== undefined && typeof (globalThis as unknown as MerchWindow).laneWriteBase === 'string', undefined, { timeout: 15_000 });
  const open = async (rec: Recorder) => {
    const srv = await startShellAndSocket(rec);
    stops.push(srv.stop);
    const context = await browser.newContext();
    stops.push(() => context.close());
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${srv.base}/merchandising/`, { waitUntil: 'load' });
    await ready(page);
    expect(errors).toEqual([]);
    return page;
  };
  /** Count the rice shelf: pick A1, type RICE, type the number, save. */
  async function countRice(page: Page, qty: string): Promise<void> {
    await page.selectOption('#count-location', 'L-A1');
    await page.fill('#count-product', 'RICE');
    await page.fill('#count-qty', qty);
    await page.click('#save-count');
    await page.waitForSelector('#banner:not([hidden])');
  }
  const savedCounts = (page: Page) => page.evaluate(() => (globalThis as unknown as MerchWindow).merchandisingSession!.savedCounts());

  it('a count is on the durable queue before the screen says saved → handed to the store computer → "posted" on its word; a reload keeps it and sends nothing twice', async () => {
    const rec: Recorder = { data: merchandisingData(), handed: [] };
    const page = await open(rec);
    expect(await page.evaluate(() => (globalThis as unknown as MerchWindow).merchandisingRelay !== undefined)).toBe(true);

    await countRice(page, '0');
    expect((await page.textContent('#banner-title')) ?? '').toContain('Count saved');
    expect((await page.textContent('#banner-text')) ?? '').toContain('kept on this device');
    await page.click('#banner-ok');
    await page.waitForSelector('#saved-counts li.saved');
    // Handed to the (stub) box, then "posted" — only because the box said so.
    await page.waitForSelector('#saved-counts li.saved[data-state="posted"]', { timeout: 10_000 });
    expect((await page.textContent('#saved-counts li.saved .pill')) ?? '').toContain('Posted at head office');
    expect(rec.handed.map((h) => h.event.type)).toEqual(['ShelfCounted']);
    expect(rec.handed[0]!.event.payload).toMatchObject({ storeId: 'S1', locationId: 'L-A1', productId: 'RICE', countedMinor: 0, countedBy: 'u-merch', at: NOW, knownLocationIds: ['L-A1', 'L-B3'], source: 'merchandising-screen' });
    expect(rec.handed[0]!.key).toBe(`shelf-count:${(rec.handed[0]!.event.payload as { countId: string }).countId}`);
    // No expected quantity anywhere on the wire or the page — counted blind stays blind.
    expect(JSON.stringify(rec.handed[0]!.event.payload)).not.toContain('expected');

    // RELOAD. The count is still listed with its state; nothing was re-sent (the queue holds the acknowledgement).
    await page.reload({ waitUntil: 'load' });
    await ready(page);
    await page.waitForSelector('#saved-counts li.saved');
    expect((await savedCounts(page)).map((c) => c.state)).toEqual(['posted']);
    expect(rec.handed).toHaveLength(1);
  });

  it('the refill tasks become ONE indent with one tap — through the Indents session, on the same queue — and a second tap raises nothing new', async () => {
    const rec: Recorder = { data: merchandisingData(), handed: [] };
    const page = await open(rec);
    // Nothing counted yet → nothing to fill → no button (an uncounted shelf never becomes a task, let alone an ask).
    await page.click('#tab-refill');
    expect(await page.isHidden('#raise-refill')).toBe(true);
    expect((await page.textContent('#tasks-list')) ?? '').toContain('Nothing needs filling');

    // Somebody looks: rice shelf empty → one urgent task → the button appears.
    await page.click('#tab-count');
    await countRice(page, '0');
    await page.click('#banner-ok');
    await page.click('#tab-refill');
    await page.waitForSelector('#raise-refill:not([hidden])');
    expect((await page.textContent('#tasks-list')) ?? '').toContain('RICE');
    await page.click('#raise-refill');
    await page.waitForSelector('#banner:not([hidden])');
    expect((await page.textContent('#banner-title')) ?? '').toContain('Indent raised');
    const indentId = ((await page.textContent('#banner-text')) ?? '').trim();
    expect(indentId.startsWith('ind-refill-2026-10-01-')).toBe(true);
    await page.click('#banner-ok');
    await page.waitForSelector('#saved-refills li.saved');
    // The ask is the same record the floor raises by hand: from the back store to the floor, in the merchandiser's name, the catalogue's unit.
    await page.waitForFunction(() => (globalThis as unknown as MerchWindow).merchandisingSession!.refills().saved[0]?.state === 'posted', undefined, { timeout: 10_000 });
    const ask = rec.handed.find((h) => h.event.type === 'FloorIndentRequested');
    expect(ask).toBeDefined();
    expect(ask!.key).toBe(`indent:${indentId}`);
    expect(ask!.event.payload).toMatchObject({ indentId, fromLocationId: 'S1-BACK', toLocationId: 'S1', requestedBy: 'u-merch', storeId: 'S1', lines: [{ productId: 'RICE', quantityMinor: 24, uom: 'EA' }], reason: 'shelf refill · A1' });
    expect(rec.handed.map((h) => h.event.type).sort()).toEqual(['FloorIndentRequested', 'ShelfCounted']);

    // Asked once a day: the button now says so and is disabled; asking through the session again raises nothing.
    expect((await page.textContent('#raise-refill')) ?? '').toContain('Already asked');
    expect(await page.isDisabled('#raise-refill')).toBe(true);
    expect(await page.evaluate(() => (globalThis as unknown as MerchWindow).merchandisingSession!.raiseRefill())).toMatchObject({ ok: true, alreadySaved: true });
    expect(rec.handed).toHaveLength(2);
  });

  it('with nobody named at the screen the count is refused in words and nothing is saved; the gap is listed; the refill ask is not offered', async () => {
    const rec: Recorder = { data: merchandisingData({ userId: undefined, indents: { ...INDENTS, userId: undefined } }), handed: [] };
    const page = await open(rec);
    expect(await page.evaluate(() => (globalThis as unknown as MerchWindow).merchandisingGaps)).toContain('who_is_counting');
    expect((await page.textContent('#gaps-list')) ?? '').toContain('who is at this screen');
    await countRice(page, '3');
    expect((await page.textContent('#banner-text')) ?? '').toContain('nobody put their name');
    expect(await savedCounts(page)).toEqual([]);
    expect(rec.handed).toEqual([]);
    expect(await page.evaluate(() => (globalThis as unknown as MerchWindow).merchandisingSession!.refills().canRaise)).toBe(false);
  });

  // ── on the REAL box ─────────────────────────────────────────────────────────────────────────────────────────

  it('on the real box: a count taken in the browser is on the box\'s fsync\'d device-events log and in its queue for head office in the counter\'s name; the refill ask follows it on the same log', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-merch-e2e-'));
    dirs.push(dir);
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, PACK_JSON, 'utf8');
    const edge: EdgeProcess = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: TENANT, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
      EDGE_LANE_PORT: '0', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_PACK_FILE: packFile,
    }, () => {}))!;
    stops.push(() => edge.stop());
    const context = await browser.newContext();
    stops.push(() => context.close());
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${edge.screens!.port}/merchandising/`, { waitUntil: 'load' });
    await ready(page);

    await countRice(page, '0');
    await page.click('#banner-ok');
    await page.waitForFunction(() => (globalThis as unknown as MerchWindow).merchandisingSession!.savedCounts()[0]?.state === 'handed_to_box', undefined, { timeout: 10_000 });
    expect((await page.textContent('#saved-counts li.saved .pill')) ?? '').toContain('With the store computer');
    await page.click('#tab-refill');
    await page.waitForSelector('#raise-refill:not([hidden])');
    await page.click('#raise-refill');
    await page.waitForFunction(() => (globalThis as unknown as MerchWindow).merchandisingSession!.refills().saved[0]?.state === 'handed_to_box', undefined, { timeout: 10_000 });

    const pending = edge.deviceEventsOutbox.pending();
    expect(pending.map((i) => i.event.type)).toEqual(['ShelfCounted', 'FloorIndentRequested']);
    const records = (await readLog(edge.deviceEventsLog.path)).filter((r) => r.ok).map((r) => JSON.parse(r.ok ? r.record : '{}') as { type: string; payload: Record<string, unknown> });
    expect(records.map((r) => r.type)).toEqual(['ShelfCounted', 'FloorIndentRequested']);
    expect(records[0]?.payload).toMatchObject({ storeId: 'S1', locationId: 'L-A1', productId: 'RICE', countedMinor: 0, countedBy: 'u-merch', source: 'merchandising-screen' });
    expect(records[1]?.payload).toMatchObject({ fromLocationId: 'S1-BACK', toLocationId: 'S1', requestedBy: 'u-merch', lines: [{ productId: 'RICE', quantityMinor: 24, uom: 'EA' }] });

    // RELOAD on the real box: both still listed, nothing re-sent.
    await page.reload({ waitUntil: 'load' });
    await ready(page);
    await page.waitForSelector('#saved-counts li.saved');
    expect(edge.deviceEventsOutbox.all()).toHaveLength(2);
  });
});
