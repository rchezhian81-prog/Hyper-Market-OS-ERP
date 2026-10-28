import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';

/**
 * **Round 7 · OB-508 · OB-509 — the goods-receipt review page, in a real browser.** Each difference on a delivery says
 * whose it is (the buyer who raised the order; the receiving store's manager — or "No store manager named"), a line with no
 * order behind it says its cost is not known until the supplier bill is matched, and a difference on it says its value is
 * not known — never ₹0 — in English and in Tamil. A stub head office answers the receipts list on the same origin.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const WEB_DIR = 'apps/web-erp/web';
const AT = '2026-10-20T08:30:00.000Z';

const LIST = {
  receipts: [{
    grnId: 'g-1', number: 'GRN-7', poId: 'po-7', warehouseId: 'wh-1', receivedBy: 'u-recv', receivedAt: AT, availableMinor: 8,
    captured: {
      requiresApproval: true, discrepancyValue: { minor: 100_00, currency: 'INR' }, discrepancyValueIncomplete: true,
      discrepancies: [
        { lineId: 'L1', productId: 'p-det', kind: 'short', quantityMinor: 2, value: { minor: 100_00, currency: 'INR' }, requiresApproval: false, detail: '2 short of the 10 ordered' },
        { lineId: 'L2', productId: 'p-brm', kind: 'damaged', quantityMinor: 10, value: { minor: 0, currency: 'INR' }, requiresApproval: true, detail: 'received damaged', valueNotKnown: true },
      ],
      lines: [
        { lineId: 'L1', productId: 'p-det', sellableMinor: 8, quarantinedMinor: 0, rejectedMinor: 0, disposition: 'sellable', uom: 'ea', batchId: null, expiry: null, unitCost: { minor: 5_000, currency: 'INR' } },
        { lineId: 'L2', productId: 'p-brm', sellableMinor: 0, quarantinedMinor: 10, rejectedMinor: 0, disposition: 'quarantine', uom: 'ea', batchId: null, expiry: null, unitCost: { minor: 0, currency: 'INR' }, costNotKnown: true },
      ],
    },
    costNotKnown: [{ lineId: 'L2', productId: 'p-brm', quantityMinor: 10, uom: 'ea', because: 'not_on_order', detail: 'x' }],
    // R8-B · OB-528: the delivery against the supplier's advance ship notice — 2 fewer than advised, owned by the buyer.
    asnCheck: { asnId: 'ASN-7', expectedAt: AT, matched: false, differences: [{ productId: 'p-det', advisedMinor: 10, receivedMinor: 8, differenceMinor: -2, detail: '2 fewer than advised — the note is a promise, not a receipt', valueMinor: 100_00 }] },
    discrepancyOwners: [
      { lineId: 'asn:p-det', productId: 'p-det', kind: 'asn_difference', role: 'buyer', owners: ['u-buyer'], detail: 'the buyer who raised order po-7' },
      { lineId: 'L1', productId: 'p-det', kind: 'short', role: 'buyer', owners: ['u-buyer'], detail: 'the buyer who raised order po-7' },
      { lineId: 'L2', productId: 'p-brm', kind: 'damaged', role: 'store_manager', owners: [], missing: 'no_store_manager_named', detail: 'no store manager named for wh-1' },
    ],
  }],
  count: 1, needingApprovalCount: 1,
};

async function startShell(): Promise<{ base: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    void (async () => {
      const [path = '/'] = (req.url ?? '/').split('?');
      if (path.startsWith('/v1/inventory/goods-receipt')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(LIST));
        return;
      }
      const file = path === '/' ? 'goods-receipt.html' : path.replace(/^\//, '');
      try {
        const buf = await readFile(join(WEB_DIR, file));
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream';
        let body = buf.toString('utf8');
        if (file.endsWith('.html')) body = body.replace('<!--SCREEN-DATA-->', `<script>window.goodsReceiptData = ${JSON.stringify({ userId: 'u-owner', permissions: ['inventory.availability.read'] })};</script>`);
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

const says = (page: Page, selector: string, text: string) => page.waitForFunction(([sel, want]) => {
  const node = (globalThis as unknown as { document: { querySelector(s: string): { textContent: string | null } | null } }).document.querySelector(sel!);
  return (node?.textContent ?? '').includes(want!);
}, [selector, text], { timeout: 15_000 });

describe.skipIf(!HAVE_BROWSER)('the goods-receipt page names each difference\'s owner and the cost not known (OB-508 · OB-509)', () => {
  let browser: Browser;
  let shell: { base: string; stop: () => Promise<void> };
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
    shell = await startShell();
  }, 120_000);
  afterAll(async () => { await browser?.close(); await shell?.stop(); });

  it('R8-B · OB-528: a difference from the supplier\'s ASN is listed with its owner, the buyer — in English, then Tamil', async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 900 } });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    try {
      await page.goto(`${shell.base}/`, { waitUntil: 'load' });
      await says(page, '#rows li.diff[data-kind="asn_difference"]', 'Differs from the supplier’s delivery note (ASN)');
      await says(page, '#rows li.diff[data-kind="asn_difference"]', 'Owner: u-buyer (the buyer who raised the order)');
      await page.click('#lang');
      await says(page, '#rows li.diff[data-kind="asn_difference"]', 'சப்ளையரின் டெலிவரி அறிவிப்பிலிருந்து (ASN) வேறுபடுகிறது');
      await says(page, '#rows li.diff[data-kind="asn_difference"]', 'பொறுப்பாளர்: u-buyer (ஆர்டர் செய்த வாங்குநர்)');
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 90_000);

  it('owners, "No store manager named", value not known and cost not known — in English, then Tamil', async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 900 } });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    try {
      await page.goto(`${shell.base}/`, { waitUntil: 'load' });
      await says(page, '#rows', 'Owner: u-buyer (the buyer who raised the order)');
      await says(page, '#rows', 'Owner: No store manager named');
      await says(page, '#rows', 'Value not known — waiting for the supplier bill');
      await says(page, '#rows', 'Cost not known until the supplier bill is matched');
      // The damaged line's value is never shown as ₹0.00.
      const damaged = await page.textContent('#rows li.diff[data-kind="damaged"] .d-val');
      expect(damaged).not.toContain('₹0.00');
      await page.click('#lang');
      await says(page, '#rows', 'பொறுப்பாளர்: u-buyer (ஆர்டர் செய்த வாங்குநர்)');
      await says(page, '#rows', 'கடை மேலாளர் பெயரிடப்படவில்லை');
      await says(page, '#rows', 'சப்ளையர் பில் பொருத்தப்படும் வரை விலை தெரியாது');
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 90_000);
});
