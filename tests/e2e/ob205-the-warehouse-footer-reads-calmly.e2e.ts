import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';

/**
 * **OB-205 (the handhelds' look, page by page): the warehouse handheld's footer reads calmly on a small phone.**
 *
 * At 360 and 412 px wide the footer's waiting actions ("Put away — scan the bin", "Issue to the floor — scan the bin") had
 * wrapped to three or four lines and crowded the list above. In real Chromium, in English and in Tamil (the longer):
 *
 *   • no footer action's words wrap beyond two lines — the action itself (its full meaning, with its icon) and, apart from
 *     it, the smaller line that says what it is waiting for ("scan the bin"), neither more than two lines;
 *   • every footer action is at least 56px tall, and the one primary action is still the last, under the thumb;
 *   • the words of each action still carry its whole meaning: the action and what it waits for are both on the button.
 *
 * Synthetic work, served as the store box serves it (injected where the box puts it). Skips without a browser.
 * SHOTS_DIR set → a PNG of each footer is written there (for the owner's before/after).
 */
const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const SHOTS_DIR = process.env['SHOTS_DIR'];
const WIDTHS = [360, 412] as const;
const TARGET = 56;

const DATA = {
  assignmentId: 'A-1', workerId: 'u-worker', storeId: 'store-1', poId: 'po-1', grnId: 'grn-1',
  bins: [{ binId: 'BIN-A', storeId: 'store-1', capacityMinor: 1000, pickable: true, zone: 'ambient' }],
  ordered: [{ productId: 'p-rice', quantityMinor: 100, unitCost: { minor: 4000, currency: 'INR' } }],
  barcodes: [{ barcode: '890RICE', productId: 'p-rice', level: 'unit' }],
  packs: [{ productId: 'p-rice', baseUom: 'ea', levels: [{ level: 'unit', containsMinor: 1, barcode: '890RICE' }] }],
  goodsIn: [{ productId: 'p-good', batchId: null, quantityMinor: 6, uom: 'EA', state: 'good', expiry: null, recalled: false }],
  contents: { 'BIN-A|p-rice|': 40 },
  pickLines: [{ lineId: 'pl-1', orderRef: 'ORD-77', productId: 'p-rice', batchId: null, binId: 'BIN-A', quantityMinor: 12, uom: 'EA' }],
  indentLines: [{ indentId: 'ind-1', productId: 'p-rice', uom: 'EA', outstandingMinor: 6, requestedBy: 'u-floor', toLocationId: 'store-1' }],
};

async function serve(data: Record<string, unknown>): Promise<{ base: string; stop: () => Promise<void> }> {
  const dir = join('apps', 'warehouse-app', 'web');
  const server: Server = createServer((req, res) => {
    void (async () => {
      const [path = '/'] = (req.url ?? '/').split('?');
      const file = path === '/' ? 'index.html' : path.replace(/^\//, '');
      try {
        let text = (await readFile(join(dir, file))).toString('utf8');
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream';
        if (file === 'index.html') text = text.replace('<!--SCREEN-DATA-->', `<script>window.warehouseData = ${JSON.stringify(data).replace(/</g, '\\u003c')};</script>`);
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

interface FooterButton { readonly id: string; readonly h: number; readonly primary: boolean; readonly text: string; readonly runs: { readonly text: string; readonly lines: number }[] }

/**
 * Each visible footer action: its height, and every run of its words (the action, and the line saying what it waits for)
 * with the number of lines that run is drawn on — counted from the rendered text's own line boxes, not guessed from height.
 */
const FOOTER = `(() => {
  const lineCount = (el) => {
    const tops = new Set();
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
      if (n.textContent.trim() === '') continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      for (const r of range.getClientRects()) if (r.width > 0) tops.add(Math.round(r.top));
    }
    return tops.size;
  };
  return [...document.querySelectorAll('footer .actions > button')].filter((b) => getComputedStyle(b).display !== 'none').map((b) => {
    // A run is a direct child of the button that holds words (or the button itself when it holds them directly).
    const kids = [...b.children].filter((c) => c.textContent.trim() !== '');
    const runs = (kids.length === 0 ? [b] : kids).map((c) => ({ text: c.textContent.trim(), lines: lineCount(c) }));
    return { id: b.id, h: b.getBoundingClientRect().height, primary: b.classList.contains('primary'), text: b.textContent.replace(/\\s+/g, ' ').trim(), runs };
  });
})()`;

describe.skipIf(!HAVE_BROWSER)('OB-205: the warehouse footer reads calmly at 360 and 412, in English and Tamil', () => {
  let browser: Browser;
  const stops: (() => Promise<void>)[] = [];
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'warehouse-app'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 180_000);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop(); });

  async function open(width: number): Promise<Page> {
    const srv = await serve(DATA);
    stops.push(srv.stop);
    const context = await browser.newContext({ viewport: { width, height: 740 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
    stops.push(() => context.close());
    const page = await context.newPage();
    await page.goto(`${srv.base}/`, { waitUntil: 'load' });
    await page.waitForFunction('globalThis.warehouseSession !== undefined', undefined, { timeout: 15_000 });
    return page;
  }
  const footer = (page: Page): Promise<FooterButton[]> => page.evaluate(FOOTER) as Promise<FooterButton[]>;

  async function expectCalm(page: Page, label: string): Promise<FooterButton[]> {
    const buttons = await footer(page);
    if (SHOTS_DIR !== undefined) {
      mkdirSync(SHOTS_DIR, { recursive: true });
      await page.locator('footer').screenshot({ path: join(SHOTS_DIR, `gap-warehouse-footer-${label}.png`) });
      await page.screenshot({ path: join(SHOTS_DIR, `gap-warehouse-page-${label}.png`) });
    }
    expect(buttons.map((b) => b.id)).toEqual(['count-bin', 'adjust-stock', 'receive', 'put-away', 'pick', 'issue']);
    const wrapped = buttons.flatMap((b) => b.runs.filter((r) => r.lines > 2).map((r) => `${b.id} "${r.text}" on ${r.lines} lines`));
    expect(wrapped, `${label}: no footer action wraps beyond two lines`).toEqual([]);
    expect(buttons.filter((b) => b.h < TARGET).map((b) => `${b.id} ${Math.round(b.h)}px`), `${label}: every action at least ${TARGET}px`).toEqual([]);
    expect(buttons[buttons.length - 1]!.primary, `${label}: the primary action stays last`).toBe(true);
    return buttons;
  }

  for (const width of WIDTHS) {
    it(`at ${width} in English and Tamil: no footer label beyond two lines, each at least 56px, the primary last, its full meaning kept`, async () => {
      const page = await open(width);
      const en = await expectCalm(page, `${width}-en`);
      const byId = new Map(en.map((b) => [b.id, b.text] as const));
      // The full meaning stays on each waiting action: the action AND what it waits for.
      expect(byId.get('put-away')).toMatch(/Put away.*scan the bin/);
      expect(byId.get('pick')).toMatch(/Pick.*scan the bin/);
      expect(byId.get('issue')).toMatch(/Issue to the floor.*scan the bin/);
      await page.click('#lang');
      await page.waitForFunction('document.documentElement.lang === "ta"');
      const ta = await expectCalm(page, `${width}-ta`);
      const taById = new Map(ta.map((b) => [b.id, b.text] as const));
      expect(taById.get('put-away')).toMatch(/அடுக்கு.*இடத்தை ஸ்கேன் செய்/);
      expect(taById.get('issue')).toMatch(/தளத்திற்கு வழங்கு.*இடத்தை ஸ்கேன் செய்/);
      // A line tapped opens its action: the words stay as calm once it is enabled.
      await page.click('#lang');
      await page.waitForFunction('document.documentElement.lang === "en"');
      await page.locator('#goods-in .item').first().click();
      expect(await page.isDisabled('#put-away')).toBe(false);
      await expectCalm(page, `${width}-en-open`);
    });
  }
});
