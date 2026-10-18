import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';

/**
 * D-11 (R3, OB-141 "A") — the warehouse HANDHELD checks a direct delivery in at the back door, in a real browser, offline:
 * choose the order, key the driver's mobile number (buttons, no text box), scan what comes off the van, hand back a damaged
 * item with its reason, see every difference by name, and close ONLY with the delivery note scanned — then ONE record is
 * queued to the device outbox for the store computer, with no money anywhere in it.
 */
const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const WEB_DIR = 'apps/warehouse-app/web';

const assignment = (): Record<string, unknown> => ({
  assignmentId: 'A-DSD', workerId: 'u-recv', storeId: 'S-A',
  bins: [{ binId: 'BIN-A', storeId: 'S-A', capacityMinor: 1000, pickable: true, zone: 'chilled' }],
  barcodes: [{ barcode: '890MILK', productId: 'p-milk', level: 'unit' }, { barcode: '890CURD', productId: 'p-curd', level: 'unit' }],
  packs: [
    { productId: 'p-milk', baseUom: 'ea', levels: [{ level: 'unit', containsMinor: 1, barcode: '890MILK' }] },
    { productId: 'p-curd', baseUom: 'ea', levels: [{ level: 'unit', containsMinor: 1, barcode: '890CURD' }] },
  ],
  openDeliveries: [{ poId: 'po-dairy', number: 'PO-0007', supplierId: 'sup-dairy', grnId: 'grn-dairy', ordered: [{ productId: 'p-milk', quantityMinor: 2, unitCost: { minor: 2500, currency: 'INR' } }, { productId: 'p-curd', quantityMinor: 2, unitCost: { minor: 3000, currency: 'INR' } }] }],
  goodsIn: [],
});

async function startShell(data: Record<string, unknown>): Promise<{ base: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const [path = '/'] = (req.url ?? '/').split('?');
      const file = path === '/' ? 'index.html' : path.replace(/^\//, '');
      try {
        let body = (await readFile(join(WEB_DIR, file))).toString('utf8');
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream';
        if (file.endsWith('.html')) body = body.replace('<!--SCREEN-DATA-->', `<script>window.warehouseData = ${JSON.stringify(data).replace(/</g, '\\u003c')};</script>`);
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
      resolve({ base: `http://127.0.0.1:${port}`, stop: () => new Promise((done) => { server.close(() => { done(); }); server.closeAllConnections(); }) });
    });
  });
}

interface Globals { dsdSession?: unknown; warehouseOutbox?: { unsentCount(): number; all(): { event: { type: string; payload: unknown } }[] } }

describe.skipIf(!HAVE_BROWSER)('the warehouse handheld checks in a direct delivery at the door (D-11)', () => {
  let browser: Browser;
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'warehouse-app'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 60_000);
  afterAll(async () => { await browser?.close(); });

  const scan = async (page: Page, code: string) => {
    await page.waitForSelector('#scan:not([hidden])', { timeout: 10_000 });
    await page.keyboard.type(code);
    await page.keyboard.press('Enter');
  };
  const okBanner = async (page: Page) => { await page.click('#banner-ok'); };

  it('order → driver → scans → hand-back → differences → no close without the note → one record queued, no money', async () => {
    const srv = await startShell(assignment());
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(`${srv.base}/`, { waitUntil: 'load' });
      await page.waitForFunction(() => (globalThis as unknown as Globals).dsdSession != null, undefined, { timeout: 10_000 });
      expect(await page.locator('input').count()).toBe(0); // no text box on the handheld
      await page.click('#dsd-open');
      await expect.poll(() => page.locator('#dsd').isVisible()).toBe(true);
      expect(await page.textContent('#dsd-no-cash')).toMatch(/No cash at the door/);
      expect(await page.isDisabled('#dsd-start')).toBe(true);
      await page.click('#dsd-choices button[data-choice="po:po-dairy"]');
      for (const d of '9876543210') await page.click(`#dsd-driver-keypad button:text-is("${d}")`);
      await page.click('#dsd-driver');
      expect(await page.textContent('#dsd-driver')).toContain('9876543210');
      await page.click('#dsd-start');
      await okBanner(page);
      await expect.poll(() => page.locator('#dsd-work-panel').isVisible()).toBe(true);

      for (const code of ['890MILK', '890MILK', '890MILK', '890CURD']) {
        await page.click('#dsd-scan');
        await scan(page, code);
        await okBanner(page);
      }
      // milk 3 of 2 ordered → over; curd 1 of 2 → short — every difference by name
      await expect.poll(async () => page.locator('#dsd-differences .discrepancy').allTextContents()).toEqual(['p-curd: short 1', 'p-milk: over 1']);

      // hand one milk back, damaged
      await page.click('#dsd-hand-back');
      await page.click('#dsd-back-products button[data-product="p-milk"]');
      await page.waitForSelector('#qty:not([hidden])');
      await page.click('#qty-ok'); // 1, the default
      await page.click('#dsd-back-reasons button[data-reason="damaged"]');
      expect(await page.textContent('#banner-title')).toBe('Handed back to the driver');
      await okBanner(page);
      expect(await page.textContent('#dsd-lines [data-product="p-milk"] .qty')).toContain('kept 2');

      // cannot close until the delivery note is scanned
      expect(await page.isDisabled('#dsd-close')).toBe(true);
      expect(await page.evaluate(() => (globalThis as unknown as Globals).warehouseOutbox!.unsentCount())).toBe(0);
      await page.click('#dsd-note');
      await scan(page, 'NOTE-DAIRY-55');
      await page.click('#dsd-close');
      expect(await page.textContent('#banner-title')).toBe('Delivery closed — note signed');
      expect(await page.textContent('#banner-text')).toMatch(/no cash, paid later as a supplier bill/);
      await okBanner(page);

      const queued = await page.evaluate(() => (globalThis as unknown as Globals).warehouseOutbox!.all().map((i) => ({ type: i.event.type, payload: i.event.payload })));
      expect(queued).toHaveLength(1);
      expect(queued[0]!.type).toBe('DsdCheckInClosed');
      expect(queued[0]!.payload).toMatchObject({ poId: 'po-dairy', supplierId: 'sup-dairy', receivedBy: 'u-recv', storeId: 'S-A', deliveryNote: { noteRef: 'NOTE-DAIRY-55' }, handBacks: [{ productId: 'p-milk', quantityMinor: 1, reason: 'damaged' }] });
      expect(JSON.stringify(queued[0]!.payload)).not.toMatch(/cash|tender|payment/i);
      // closed: the screen goes back to choosing a delivery
      await expect.poll(() => page.locator('#dsd-start-panel').isVisible()).toBe(true);
    } finally {
      await context.close();
      await srv.stop();
    }
  });
});
