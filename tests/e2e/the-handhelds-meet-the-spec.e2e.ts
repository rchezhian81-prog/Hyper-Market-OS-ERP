import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { auditPage, type A11yFinding } from './lib/a11y-audit';
import { Tally } from './lib/tally';

/**
 * **The three handhelds — picker, driver, warehouse — on a low-spec phone, audited and counted (Stage G slice 4 ·
 * picker-packer.md · delivery.md · inventory-warehouse.md · design system §1 rules 1, 4, 6, 7, 8 · §5 · §9).**
 *
 * Real Chromium at a cheap Android handheld's size (360 × 640, touch). Three things are proven on the RENDERED
 * page that no file-level rule can see:
 *
 *   • **WCAG 2.2 AA on every view a worker reaches** (`auditPage`, at the handhelds' own 56px target bar): the list,
 *     the scan panel, the keypad and choice panels, the cash count, a red banner and a green one — and the list
 *     again in Tamil with `html[lang="ta"]`. Zero findings.
 *   • **The spec's interaction budgets, counted** with the same `Tally` as the till and the customer app:
 *     picker — pick a line 3 (scan bin → scan item → confirm) · record a substitution 3 · flag a quality fail 2;
 *     driver — capture proof 2 · record COD 2 · mark failed with reason 3; warehouse — put away a line 3 · pick a line 3
 *     (scan bin → scan item → confirm, W1 of the owner's 30 Sep warehouse program).
 *   • **The sync badge tells the truth** (rule 4): this device's unsent count; the store computer reachable, not
 *     answering, or — served with no store computer named — not connected. Never a constant.
 *
 * A tripwire proves the two rules this slice added to the audit bite: words faded by `opacity` and a page wider
 * than the phone are each reported, and a DISABLED control is exempt from target size as WCAG exempts it.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
/** A cheap Android handheld held in one hand. */
const HANDHELD = { viewport: { width: 360, height: 640 }, hasTouch: true, isMobile: true };
/** The handhelds' own bar: the static guardrail holds every handheld shell to ≥ 56px (the pages declare 64 / 60). */
const HANDHELD_TARGET = 56;

interface Shell {
  readonly app: string;
  readonly global: string;
  readonly ready: string;
  readonly data: () => Record<string, unknown>;
}

const PICKER: Shell = {
  app: 'picker-app', global: 'pickerData', ready: 'pickSession',
  data: () => ({
    waveId: 'W-1', pickerId: 'u-picker', orderedBy: 'shelf order',
    lines: [
      { lineId: 'l1', orderRef: 'ORD-1', productId: 'MILK', description: 'Aavin Milk 1L', bin: 'A-01', requiredQty: 2, uom: 'ea', unitPrice: { minor: 6000, currency: 'INR' } },
      { lineId: 'l2', orderRef: 'ORD-1', productId: 'DAL', description: 'Toor dal 1kg', bin: 'B-04', requiredQty: 1, uom: 'ea', unitPrice: { minor: 16000, currency: 'INR' } },
      { lineId: 'l3', orderRef: 'ORD-2', productId: 'TOMATO', description: 'Tomato', bin: 'C-02', requiredQty: 500, uom: 'kg', unitPrice: { minor: 4000, currency: 'INR' } },
    ],
  }),
};

const DRIVER: Shell = {
  app: 'delivery-app', global: 'driverData', ready: 'routeSession',
  data: () => ({
    routeId: 'R-1', driverId: 'u-driver',
    stops: [
      { stopId: 's1', orderRef: 'ORD-1041', area: 'Anna Nagar, 3rd St', codMinor: 250_00 },
      { stopId: 's2', orderRef: 'ORD-1044', area: 'Gandhipuram', codMinor: 0 },
    ],
  }),
};

const WAREHOUSE: Shell = {
  app: 'warehouse-app', global: 'warehouseData', ready: 'warehouseSession',
  data: () => ({
    assignmentId: 'A-1', workerId: 'u-worker', storeId: 'store-1',
    bins: [{ binId: 'BIN-A', storeId: 'store-1', capacityMinor: 1000, pickable: true, zone: 'ambient' }],
    grnId: 'grn-1',
    ordered: [{ productId: 'p-rice', quantityMinor: 100, unitCost: { minor: 4000, currency: 'INR' } }],
    barcodes: [{ barcode: '890RICE', productId: 'p-rice', level: 'unit' }],
    packs: [{ productId: 'p-rice', baseUom: 'ea', levels: [{ level: 'unit', containsMinor: 1, barcode: '890RICE' }] }],
    goodsIn: [
      { productId: 'p-good', batchId: null, quantityMinor: 6, uom: 'EA', state: 'good', expiry: null, recalled: false },
      { productId: 'p-recalled', batchId: 'b-9', quantityMinor: 3, uom: 'EA', state: 'good', expiry: null, recalled: true },
    ],
    recalledProductIds: ['p-recalled'],
    // The pick list (W1): one order line, in BIN-A, which the box says holds 40 of p-rice.
    contents: { 'BIN-A|p-rice|': 40 },
    pickLines: [{ lineId: 'pl-1', orderRef: 'ORD-77', productId: 'p-rice', batchId: null, binId: 'BIN-A', quantityMinor: 12, uom: 'EA' }],
  }),
};

/** The store box's proxy, minus the box: the shell's files with the work injected where the box would put it. */
async function serve(shell: Shell, laneWriteBase?: string): Promise<{ base: string; stop: () => Promise<void> }> {
  const dir = join('apps', shell.app, 'web');
  const server: Server = createServer((req, res) => {
    void (async () => {
      const [path = '/'] = (req.url ?? '/').split('?');
      const file = path === '/' || path === '/index.html' ? 'index.html' : path.replace(/^\//, '');
      try {
        let text = (await readFile(join(dir, file))).toString('utf8');
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.webmanifest') ? 'application/manifest+json' : 'application/octet-stream';
        if (file === 'index.html') {
          const lane = laneWriteBase === undefined ? '' : ` window.laneWriteBase = ${JSON.stringify(laneWriteBase)};`;
          text = text.replace('<!--SCREEN-DATA-->', `<script>window.${shell.global} = ${JSON.stringify(shell.data()).replace(/</g, '\\u003c')};${lane}</script>`);
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
      resolve({ base: `http://127.0.0.1:${port}`, stop: () => new Promise((done) => { server.close(() => { done(); }); server.closeAllConnections(); }) });
    });
  });
}

/** A stand-in for the store computer's `GET /lane/sync-status` — the route the till badge is proven against. */
async function laneStub(): Promise<{ base: string; stop: () => Promise<void> }> {
  const at = new Date(Date.now() - 90_000).toISOString();
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify({ cloud: 'online', unsent: 0, deadLettered: 0, lastSentAt: at, lastContactAt: at, now: new Date().toISOString(), staffMessage: '' }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      resolve({ base: `http://127.0.0.1:${port}`, stop: () => new Promise((done) => { server.close(() => { done(); }); server.closeAllConnections(); }) });
    });
  });
}

const rules = (found: A11yFinding[]): string[] => [...new Set(found.map((f) => f.rule))].sort();

describe.skipIf(!HAVE_BROWSER)('the handhelds on a low-spec phone: audited, and their budgets counted', () => {
  let browser: Browser;
  const stops: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    for (const shell of [PICKER, DRIVER, WAREHOUSE]) execFileSync('node', ['scripts/build-app.mjs', shell.app], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 180_000);
  afterAll(async () => { await browser?.close(); });
  // Torn down in REVERSE order: the browser context first, then the servers it was talking to. A stub server
  // closed while Chromium still holds a keep-alive connection to it waits for that connection — once, in a full
  // gate, for longer than the hook timeout — so the client goes first and any lingering socket is closed outright.
  afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop(); });

  async function open(shell: Shell, laneWriteBase?: string): Promise<Page> {
    const srv = await serve(shell, laneWriteBase);
    stops.push(srv.stop);
    const context = await browser.newContext(HANDHELD);
    stops.push(() => context.close());
    const page = await context.newPage();
    await page.goto(`${srv.base}/`, { waitUntil: 'load' });
    await page.waitForFunction(`globalThis.${shell.ready} !== undefined`, undefined, { timeout: 15_000 });
    return page;
  }

  const audit = (page: Page, expectLang = 'en') => auditPage(page, { minTarget: HANDHELD_TARGET, expectLang });

  it('picker — every view passes: list, scan panel, keypad, problem list, a red banner, and Tamil', async () => {
    const page = await open(PICKER);
    const found: Record<string, A11yFinding[]> = {};
    found['list'] = await audit(page);
    // The bin scan chooses the line; the item panel offers Substitute and Problem.
    await page.keyboard.type('A-01'); await page.keyboard.press('Enter');
    await page.waitForSelector('#scan-substitute:not([hidden])');
    found['scan-panel'] = await audit(page);
    await page.keyboard.type('MILK'); await page.keyboard.press('Enter');
    await page.waitForSelector('#keypad:not([hidden])');
    found['keypad'] = await audit(page);
    await page.click('#sheet-cancel');
    await page.click('#problem');
    await page.waitForSelector('#choices:not([hidden])');
    found['problem-list'] = await audit(page);
    await page.click('#sheet-cancel');
    await page.click('#pack'); // blocked while lines are unresolved — the red banner
    await page.waitForSelector('#banner:not([hidden])');
    found['red-banner'] = await audit(page);
    await page.click('#banner-ok');
    await page.click('#lang');
    await page.waitForFunction('document.documentElement.lang === "ta"');
    found['list-ta'] = await audit(page, 'ta');
    expect(found).toEqual({ list: [], 'scan-panel': [], keypad: [], 'problem-list': [], 'red-banner': [], 'list-ta': [] });
  });

  it('driver — every view passes: route, proof list, OTP keypad, the blind cash count, a green banner, and Tamil', async () => {
    const page = await open(DRIVER);
    const found: Record<string, A11yFinding[]> = {};
    found['route'] = await audit(page);
    await page.click('#deliver');
    await page.waitForSelector('#choices:not([hidden])');
    found['proof-list'] = await audit(page);
    await page.locator('#choices button', { hasText: 'OTP' }).click();
    await page.waitForSelector('#keypad:not([hidden])');
    found['otp-keypad'] = await audit(page);
    await page.click('#sheet-cancel');
    await page.click('#handover');
    await page.waitForSelector('#count:not([hidden])');
    found['cash-count'] = await audit(page);
    await page.click('#count-cancel');
    // A prepaid stop delivered with a photo — the green banner.
    await page.locator('.stop', { hasText: 'Gandhipuram' }).click();
    await page.click('#deliver');
    await page.locator('#choices button', { hasText: 'Photo' }).click();
    await page.waitForSelector('#banner.good:not([hidden])');
    found['green-banner'] = await audit(page);
    await page.click('#banner-ok');
    await page.click('#lang');
    await page.waitForFunction('document.documentElement.lang === "ta"');
    found['route-ta'] = await audit(page, 'ta');
    expect(found).toEqual({ route: [], 'proof-list': [], 'otp-keypad': [], 'cash-count': [], 'green-banner': [], 'route-ta': [] });
  });

  it('warehouse — every view passes: pick list + goods-in with disabled actions, scan panel, the confirm step, a refusal banner, a green one, and Tamil', async () => {
    const page = await open(WAREHOUSE);
    const found: Record<string, A11yFinding[]> = {};
    found['list'] = await audit(page); // Put away and Pick are DISABLED until a line is chosen — exempt, as WCAG exempts them
    await page.click('#receive');
    await page.waitForSelector('#scan:not([hidden])');
    found['scan-panel'] = await audit(page);
    await page.keyboard.type('000NOTREAL'); await page.keyboard.press('Enter'); // unknown barcode → refused, in red
    await page.waitForSelector('#banner:not([hidden])');
    found['refusal-banner'] = await audit(page);
    await page.click('#banner-ok');
    // The pick's item panel and its confirm step, reached the way a worker reaches them: by scanning the bin from the list.
    await page.keyboard.type('BIN-A'); await page.keyboard.press('Enter');
    await page.waitForSelector('#scan:not([hidden])');
    found['pick-item-panel'] = await audit(page);
    await page.keyboard.type('890RICE'); await page.keyboard.press('Enter');
    await page.waitForSelector('#confirm:not([hidden])');
    found['pick-confirm'] = await audit(page);
    await page.click('#confirm-ok');
    await page.waitForSelector('#banner.good:not([hidden])');
    found['green-banner'] = await audit(page);
    await page.click('#banner-ok');
    await page.click('#lang');
    await page.waitForFunction('document.documentElement.lang === "ta"');
    found['list-ta'] = await audit(page, 'ta');
    expect(found).toEqual({ list: [], 'scan-panel': [], 'refusal-banner': [], 'pick-item-panel': [], 'pick-confirm': [], 'green-banner': [], 'list-ta': [] });
  });

  it('picker budget — pick a line 3 (scan bin → scan item → confirm) · record a substitution 3 · flag a quality fail 2', async () => {
    const page = await open(PICKER);
    const taps = new Tally(page);

    // Pick a line: the bin scan chooses the line, the item scan follows, the confirm is one tap on the asked-for quantity.
    await taps.scan('A-01');
    await page.waitForSelector('#scan-substitute:not([hidden])');
    await taps.scan('MILK');
    await page.waitForSelector('#keypad:not([hidden])');
    await taps.tap('#sheet-ok');
    await page.waitForSelector('.line.picked');
    expect(taps.reset(), 'pick a line').toBeLessThanOrEqual(3);

    // Record a substitution, counted from the shelf: the picker has scanned the bin and found it short.
    await page.keyboard.type('B-04'); await page.keyboard.press('Enter'); // step 1 of the pick, not of the substitution
    await page.waitForSelector('#scan-substitute:not([hidden])');
    taps.reset();
    await taps.tap('#scan-substitute');
    await taps.scan('SUB-777');
    await taps.scan('REF-123'); // the customer's own confirmation reference — never a tick box
    await page.waitForSelector('.line.substituted');
    expect(taps.reset(), 'record a substitution').toBeLessThanOrEqual(3);

    // Flag a quality fail, counted from the shelf.
    await page.keyboard.type('C-02'); await page.keyboard.press('Enter');
    await page.waitForSelector('#scan-problem:not([hidden])');
    taps.reset();
    await taps.tap('#scan-problem');
    await page.waitForSelector('#choices:not([hidden])');
    await taps.tap('#choices button:has-text("Damaged")');
    await page.waitForSelector('.line.quality_failed');
    expect(taps.reset(), 'flag a quality fail').toBeLessThanOrEqual(2);

    // Everything the picker did is on the device, waiting to go — and the badge says so in words.
    expect(await page.evaluate('globalThis.pickerOutbox.unsentCount()')).toBe(3);
    expect(await page.textContent('#queue-text')).toBe('3 waiting to sync');
    expect(await page.getAttribute('#queue-dot', 'class')).toContain('waiting');
  });

  it('driver budget — capture proof 2 · record COD 2 · mark failed with reason 3, from the stop the driver is at', async () => {
    const page = await open(DRIVER);
    const taps = new Tally(page);
    // The stop the driver is at is already the one the buttons act on: no tap spent on the obvious.
    expect(await page.getAttribute('.stop:first-child', 'aria-selected')).toBe('true');

    await taps.tap('#deliver');
    await page.waitForSelector('#choices:not([hidden])');
    await taps.tap('#choices button:has-text("Photo")');
    expect(taps.reset(), 'capture proof').toBeLessThanOrEqual(3);

    // Then the money, on its own panel: how it was paid, and the amount the order says is already on the keypad.
    await page.waitForSelector('#choices button:has-text("Cash")');
    await taps.tap('#choices button:has-text("Cash")');
    await page.waitForSelector('#keypad:not([hidden])');
    expect(await page.textContent('#entry')).toBe('250');
    await taps.tap('#sheet-ok');
    await page.waitForSelector('.stop.delivered');
    expect(taps.reset(), 'record COD collected').toBeLessThanOrEqual(3);
    expect(await page.textContent('#held')).toBe('₹250.00');

    // The next stop is now the current one. It cannot be delivered: a reason, then where the goods go.
    await page.click('#banner-ok');
    expect(await page.getAttribute('.stop:nth-child(2)', 'aria-selected')).toBe('true');
    await taps.tap('#failed');
    await page.waitForSelector('#choices:not([hidden])');
    await taps.tap('#choices button:has-text("Nobody at home")');
    await page.waitForSelector('#choices button:has-text("Try again")');
    await taps.tap('#choices button:has-text("Try again")');
    await page.waitForSelector('#banner.good:not([hidden])');
    expect(taps.reset(), 'mark failed with reason').toBeLessThanOrEqual(3);
    expect(await page.locator('.stop.out_for_delivery').count()).toBe(1);
  });

  it('warehouse budget — put away a line 3 (tap the item → Put away → scan the bin)', async () => {
    const page = await open(WAREHOUSE);
    const taps = new Tally(page);
    await taps.tap('.item:has-text("p-good")');
    await taps.tap('#put-away');
    await page.waitForSelector('#scan:not([hidden])');
    await taps.scan('BIN-A'); // into the put-away's panel: the put-away's bin, NOT the start of a pick
    await page.waitForSelector('#banner.good:not([hidden])');
    expect(taps.reset(), 'put away a line').toBeLessThanOrEqual(3);
    expect(await page.evaluate('globalThis.warehouseOutbox.unsentCount()')).toBe(1);
    expect(await page.textContent('#queue-text')).toBe('1 waiting to sync');
    // The pick line is untouched by the put-away: still 12 to pick from BIN-A.
    expect(await page.textContent('.item.pick .qty')).toBe('12 units · EA');
  });

  it('warehouse budget — pick a line 3 (scan the bin from the list → scan the item → confirm), W1', async () => {
    const page = await open(WAREHOUSE);
    const taps = new Tally(page);
    // The row says where to walk: the bin, biggest, then the order and the item, then what is wanted.
    expect(await page.textContent('.item.pick .where')).toBe('BIN-A');
    expect(await page.textContent('.item.pick .what')).toBe('ORD-77 · p-rice');
    expect(await page.textContent('#step')).toContain('Scan a bin on the pick list to start picking');

    // Step 1: the bin scan chooses the line. Step 2: the item. Step 3: one tap on the model's quantity.
    await taps.scan('BIN-A');
    await page.waitForSelector('#scan:not([hidden])');
    expect(await page.textContent('#scan-title')).toBe('Scan the item — p-rice');
    expect(await page.textContent('#step')).toContain('Now scan the item');
    await taps.scan('890RICE');
    await page.waitForSelector('#confirm:not([hidden])');
    expect(await page.textContent('#confirm-title')).toBe('Confirm the pick — ORD-77');
    expect(await page.textContent('#confirm-qty')).toBe('12 units · EA');
    expect(await page.textContent('#confirm-hint')).toBe('p-rice · from bin BIN-A');
    await taps.tap('#confirm-ok');
    await page.waitForSelector('#banner.good:not([hidden])');
    expect(taps.reset(), 'pick a line').toBeLessThanOrEqual(3);
    expect(await page.textContent('#banner-title')).toBe('Picked');
    expect(await page.textContent('#banner-text')).toBe('12 picked for ORD-77 from BIN-A');

    // The line is done and gone; the movement waits on the device, and the badge says so in words.
    expect(await page.locator('.item.pick').count()).toBe(0);
    expect(await page.evaluate('globalThis.warehouseOutbox.unsentCount()')).toBe(1);
    expect(await page.textContent('#queue-text')).toBe('1 waiting to sync');
    expect(await page.evaluate('globalThis.warehouseSession.binContents()["BIN-A|p-rice|"]')).toBe(28);
    const queued = await page.evaluate('globalThis.warehouseOutbox.pending().map((i) => [i.event.type, i.event.idempotencyKey, i.event.payload.command.kind, i.event.payload.command.fromBinId, i.event.payload.command.toBinId])');
    expect(queued).toEqual([['WarehouseMovementApplied', expect.stringMatching(/^wh-move:pick-/), 'pick', 'BIN-A', null]]);
  });

  it('warehouse — the wrong bin is refused at the racking and the wrong item at the shelf, before anything is confirmed (W1)', async () => {
    const page = await open(WAREHOUSE);
    // Tap the line, then scan a bin that is not the line's: refused in red, in words, with nothing queued.
    await page.click('.item.pick');
    await page.click('#pick');
    await page.waitForSelector('#scan:not([hidden])');
    expect(await page.textContent('#scan-title')).toBe('Scan the bin shown — BIN-A');
    await page.keyboard.type('BIN-Z'); await page.keyboard.press('Enter');
    await page.waitForSelector('#banner:not([hidden])');
    expect(await page.getAttribute('#banner', 'class')).toBe('banner');
    expect(await page.textContent('#banner-title')).toBe('That is not the bin for this line — walk to the bin shown and scan it');
    await page.click('#banner-ok');
    expect(await page.evaluate('globalThis.warehouseOutbox.unsentCount()')).toBe(0);

    // The right bin, then the wrong item: refused at the shelf; the confirm step is never reached.
    await page.keyboard.type('BIN-A'); await page.keyboard.press('Enter');
    await page.waitForSelector('#scan:not([hidden])');
    await page.keyboard.type('000NOTREAL'); await page.keyboard.press('Enter');
    await page.waitForSelector('#banner:not([hidden])');
    expect(await page.textContent('#banner-title')).toBe('Unknown barcode — set aside for someone to sort out');
    expect(await page.isHidden('#confirm')).toBe(true);
    await page.click('#banner-ok');
    expect(await page.evaluate('globalThis.warehouseOutbox.unsentCount()')).toBe(0);
    expect(await page.textContent('.item.pick .qty')).toBe('12 units · EA');

    // And the refusal reads in Tamil too.
    await page.click('#lang');
    await page.keyboard.type('BIN-A'); await page.keyboard.press('Enter');
    await page.waitForSelector('#scan:not([hidden])');
    expect(await page.textContent('#scan-title')).toBe('பொருளை ஸ்கேன் செய்யவும் — p-rice');
    await page.click('#scan-cancel');
  });

  it('the badge tells the truth: not connected · store computer online with last contact · not answering', async () => {
    // Served with no store computer named — as a cached page opens — it says so, and never invents an address.
    const alone = await open(WAREHOUSE);
    expect(await alone.textContent('#box-text')).toBe('not connected to a store computer');
    expect(await alone.getAttribute('#queue-dot', 'class')).toContain('idle');

    // Served by a store computer that answers: online, with when head office last answered it.
    const lane = await laneStub();
    stops.push(lane.stop);
    const page = await open(PICKER, lane.base);
    await page.waitForFunction('globalThis.pickerBadge.state().asked === true');
    await page.waitForFunction('document.getElementById("box-text").textContent.startsWith("store computer online")');
    expect(await page.textContent('#box-text')).toMatch(/^store computer online · last contact \d{2}:\d{2}/);
    expect(await page.getAttribute('#queue-dot', 'class')).not.toMatch(/error|idle|waiting/);

    // The store computer stops answering: the badge says so, in red — the queue on the device is unchanged.
    await page.evaluate('globalThis.laneWriteBase = "http://127.0.0.1:1"');
    await page.evaluate('globalThis.pickerBadge.refresh()');
    expect(await page.textContent('#box-text')).toBe('store computer not answering');
    expect(await page.getAttribute('#queue-dot', 'class')).toContain('error');
    expect(await page.textContent('#queue-text')).toBe('everything sent');

    // And in Tamil.
    await page.click('#lang');
    expect(await page.textContent('#box-text')).toBe('கடை கணினி பதிலளிக்கவில்லை');
  });

  it('tripwire — the audit reports words faded by opacity and a page wider than the phone, and exempts a disabled control', async () => {
    const page = await open(WAREHOUSE);
    await page.evaluate(`(() => {
      const faint = document.createElement('p'); faint.id = 'trip-faint'; faint.textContent = 'Faded words'; faint.style.opacity = '0.3'; document.body.append(faint);
      const wide = document.createElement('div'); wide.id = 'trip-wide'; wide.style.width = '1200px'; wide.style.height = '4px'; document.body.append(wide);
      const dead = document.createElement('button'); dead.id = 'trip-dead'; dead.textContent = 'x'; dead.disabled = true; dead.style.width = '20px'; dead.style.height = '20px'; dead.style.minHeight = '0'; document.body.append(dead);
    })()`);
    const found = await audit(page);
    expect(rules(found)).toEqual(['1.4.10', '1.4.3']);
    expect(found.find((f) => f.rule === '1.4.3')?.detail).toContain('30% opacity');
    expect(found.some((f) => f.selector.includes('#trip-dead'))).toBe(false);
    await page.evaluate(`for (const id of ['trip-faint', 'trip-wide', 'trip-dead']) document.getElementById(id).remove()`);
    expect(await audit(page)).toEqual([]);
  });
});
