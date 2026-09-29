import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { auditPage } from './lib/a11y-audit';

/**
 * **The customer app meets WCAG 2.2 AA on the key journeys — audited on the rendered page, and its three frequent
 * actions fit the spec's budget (Stage G slice 3 · customer-app.md · NFR-07 · design system §1 rules 1, 6, 7, §5).**
 *
 * customer-app.md names the bar: a public-facing surface at WCAG 2.2 AA, English/Tamil, large targets,
 * screen-reader labelled; reorder a past basket ≤ 3, add a searched item ≤ 2, reach checkout from the cart ≤ 2.
 * The static guardrail (`the-customer-app-is-honest`) holds the source to the rules a file can show; this holds the
 * RENDERED app to the ones only a browser can — the contrast of every word on the surface it actually sits on, the
 * size of every target as laid out, the accessible name of every control, the page language after the toggle — on
 * every view a customer reaches: shop, results, basket with sign-in, order, privacy, and all of it again in Tamil.
 *
 * Served the way the store's proxy serves it: the app's own files, with `window.shopData` injected in place of the
 * box's marker. Skips where no browser binary is present, like its siblings.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const WEB_DIR = 'apps/customer-app/web';
const DATA_MARKER = '<!--SCREEN-DATA-->';

function shopData(): Record<string, unknown> {
  const starts = new Date(Date.now() + 3 * 3_600_000);
  const ends = new Date(Date.now() + 5 * 3_600_000);
  return {
    tenantId: 'ab000000-0000-4000-8000-000000000050', customerRef: 'guest', packVersion: 3, locationId: 'L1',
    products: [
      { productId: 'MILK', name: 'Aavin Milk 1L', categoryId: 'dairy', unitPriceMinor: 60_00, uom: 'each', barcodes: ['8901234567891'], status: 'active', availableMinor: 5, availabilityAgeMinutes: 1 },
      { productId: 'DAL', name: 'Toor dal 1kg', categoryId: 'grocery', unitPriceMinor: 160_00, uom: 'each', barcodes: ['8901234567890'], status: 'active', availableMinor: 9, availabilityAgeMinutes: 1 },
    ],
    savedLists: [{ listId: 'weekly', customerRef: 'guest', name: 'Weekly shop', lines: [{ productId: 'MILK', quantityMinor: 2 }, { productId: 'DAL', quantityMinor: 1 }] }],
    slots: [{ slotId: 'this-evening', startsAt: starts.toISOString(), endsAt: ends.toISOString(), capacity: 4, booked: 0, kind: 'delivery' }],
    storeLocation: { lat: 11.0168, lon: 76.9558 }, policy: { radiusMetres: 10_000, deliveryFeeMinor: 40_00 }, deliveryFeeMinor: 40_00,
    // The privacy view's consent switches — one required (on, disabled) and one optional (off), so both states are audited.
    consentPurposes: [{ purpose: 'order_updates', channel: 'sms', required: true }, { purpose: 'marketing', channel: 'sms' }],
    consent: { grants: [{ purpose: 'order_updates', channel: 'sms', granted: true }] },
  };
}

/** The store's proxy, minus the API: the app's files with the shop's data injected where the box would put it. */
async function serve(): Promise<{ base: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    void (async () => {
      const [path = '/'] = (req.url ?? '/').split('?');
      const file = path === '/' || path === '/index.html' ? 'index.html' : path.replace(/^\//, '');
      try {
        let text = (await readFile(join(WEB_DIR, file))).toString('utf8');
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.webmanifest') ? 'application/manifest+json' : 'application/octet-stream';
        if (file === 'index.html') text = text.replace(DATA_MARKER, `<script>window.shopData = ${JSON.stringify(shopData()).replace(/</g, '\\u003c')};</script>`);
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
      resolve({ base: `http://127.0.0.1:${port}`, stop: () => new Promise((done) => { server.close(() => { done(); }); }) });
    });
  });
}

class Tally {
  count = 0;
  constructor(private readonly page: Page) {}
  async tap(selector: string): Promise<void> { this.count += 1; await this.page.click(selector); }
  async type(selector: string, text: string): Promise<void> { this.count += 1; await this.page.fill(selector, text); }
  reset(): number { const n = this.count; this.count = 0; return n; }
}

describe.skipIf(!HAVE_BROWSER)('the customer app, audited on the rendered page', () => {
  let browser: Browser;
  const stops: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'customer-app'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 120_000);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => { for (const stop of stops.splice(0)) await stop(); });

  async function open(): Promise<Page> {
    const { base, stop } = await serve();
    stops.push(stop);
    // A low-spec phone's viewport (design system §1 rule 8), not a desktop's.
    const context = await browser.newContext({ viewport: { width: 360, height: 740 }, deviceScaleFactor: 2, hasTouch: true });
    stops.push(() => context.close());
    const page = await context.newPage();
    await page.goto(`${base}/`, { waitUntil: 'load' });
    // The real shop, not the sample: the bundle read window.shopData and hid the sample strip.
    await page.waitForFunction(() => (globalThis as unknown as { document: { getElementById(id: string): { hidden: boolean } | null } }).document.getElementById('sample')?.hidden === true, undefined, { timeout: 10_000 });
    return page;
  }

  it('every view a customer reaches passes: contrast, targets, names, labels, one heading, page language — in English and Tamil', async () => {
    const page = await open();
    const found: Record<string, unknown> = {};

    found['shop'] = await auditPage(page, { expectLang: 'en' });
    await page.fill('#search', 'milk');
    await page.waitForSelector('#results .row');
    found['results'] = await auditPage(page, { expectLang: 'en' });
    await page.click('button[aria-label="Add Aavin Milk 1L"]');
    await page.click('#tab-basket');
    await page.waitForSelector('#view-basket:not([hidden])');
    found['basket'] = await auditPage(page, { expectLang: 'en' });
    await page.click('#tab-order');
    found['order'] = await auditPage(page, { expectLang: 'en' });
    await page.click('#tab-privacy');
    await page.waitForSelector('#view-privacy:not([hidden])');
    await page.waitForSelector('#consent [role="switch"]');
    found['privacy'] = await auditPage(page, { expectLang: 'en' });

    // Tamil: the words change, the language of the page must follow (3.1.1), and every pair must still read.
    await page.click('#lang');
    found['privacy-ta'] = await auditPage(page, { expectLang: 'ta' });
    await page.click('#tab-shop');
    found['shop-ta'] = await auditPage(page, { expectLang: 'ta' });

    expect(found).toEqual({ shop: [], results: [], basket: [], order: [], privacy: [], 'privacy-ta': [], 'shop-ta': [] });
  });

  it('tripwire — the audit bites: faint words, a tiny unnamed control and an unlabelled input are each reported', async () => {
    // Otherwise a pass above would be indistinguishable from an audit that reads nothing.
    const page = await open();
    await page.evaluate(() => {
      const d = (globalThis as unknown as { document: { body: { insertAdjacentHTML(where: string, html: string): void } } }).document;
      d.body.insertAdjacentHTML('beforeend', '<div id="trip"><p style="color:#777777;font-size:14px">faint words nobody can read</p>'
        + '<button type="button" style="width:20px;height:20px;min-height:0;padding:0"></button>'
        + '<input id="trip-input" type="text" /></div>');
    });
    const findings = await auditPage(page, { expectLang: 'en' });
    const rules = new Set(findings.filter((f) => f.selector.includes('trip') || f.selector.includes('faint') || f.selector === 'button' || f.selector === 'input#trip-input').map((f) => f.rule));
    expect([...rules].sort()).toEqual(['1.4.3', '2.5.8', '3.3.2', '4.1.2']);
    await page.evaluate(() => { (globalThis as unknown as { document: { getElementById(id: string): { remove(): void } | null } }).document.getElementById('trip')?.remove(); });
    expect(await auditPage(page, { expectLang: 'en' })).toEqual([]);
  });

  it('reorder a past basket ≤ 3 · add a searched item ≤ 2 · reach checkout from the cart ≤ 2 (customer-app.md)', async () => {
    const page = await open();
    const taps = new Tally(page);

    // Reorder: one tap on "Buy again" rebuilds the basket from the saved list and lands on it.
    await taps.tap('#lists .row button');
    await page.waitForSelector('#view-basket:not([hidden])');
    await page.click('#banner-ok');
    expect(taps.reset(), 'reorder a past basket').toBeLessThanOrEqual(3);
    expect(await page.$$eval('#basket-lines .row', (rows) => rows.length)).toBe(2);

    // Add a searched item: type, tap Add.
    await page.click('#tab-shop');
    await taps.type('#search', 'dal');
    await page.waitForSelector('button[aria-label="Add Toor dal 1kg"]');
    await taps.tap('button[aria-label="Add Toor dal 1kg"]');
    expect(taps.reset(), 'add a searched item to the cart').toBeLessThanOrEqual(2);

    // Reach checkout from the cart: the Basket tab, then "Check my basket" — the slots and sign-in follow.
    await taps.tap('#tab-basket');
    await taps.tap('#review');
    await page.waitForSelector('#banner:not([hidden])');
    expect(taps.reset(), 'reach checkout from the cart').toBeLessThanOrEqual(2);
  });
});
