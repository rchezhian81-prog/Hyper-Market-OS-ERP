import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startInboxShop, ok, OWNER, MGR, type InboxShop } from './lib/ai-inbox-shop';
import type { RealCloud } from '../support/real-store';
import { tradingMonthIn, shopDateIn } from '../../packages/calendar/src/shop-clock';

/**
 * **R2 · batch 18c — "Correct a saved receipt" on Goods receipt review, in a real browser, on the PRODUCTION API over real
 * PostgreSQL** (M07-FR-01/03 · hard rules #2, #10 · OB-873): the manager opens a saved receipt by its number, sees each line
 * as saved, types the right quantity and why; head office asks for a second person; he asks; the owner approves; the same
 * press saves `GRC1/…`; the page shows the line as saved (10) and as it stands now (8), and the correction with who asked,
 * who approved and why. The receipt itself is unchanged; stock and the order read the corrected figure — read back from
 * head office. Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const SHOTS = process.env['B18C_SHOTS'];
const KEY = ['b18c', 'r2', 'e2e', 'signing', 'key'].join('-').padEnd(48, '0');
const ACCT = 'u-acct-b18c-r2';
const SEED_BUYER = 'u-seed-buyer-b18c-r2';
type Doc = { getElementById(x: string): { textContent: string | null } | null };

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('R2: a saved goods receipt is corrected on Goods receipt review', () => {
  let browser: Browser;
  let shop: InboxShop;
  let grnNumber = '';
  const as = (c: RealCloud, userId: string, path: string, body: unknown, key: string) => c.request({ method: 'POST', path, userId, body, idempotencyKey: key });

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    if (SHOTS !== undefined) mkdirSync(SHOTS, { recursive: true });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/goods-receipt', html: 'goods-receipt.html', dataGlobal: 'goodsReceiptData' },
      seed: async (c) => {
        await c.grant(ACCT, 'accountant', undefined, 'all');
        await c.grant(SEED_BUYER, 'store_manager', undefined, 'all');
        await ok(as(c, SEED_BUYER, '/v1/purchase/suppliers/sup-1', { name: 'Sri Foods (synthetic)' }, 'sup'), 'supplier');
        await ok(as(c, ACCT, '/v1/purchase/suppliers/sup-1/approval', { reason: 'documents checked' }, 'sup-ok'), 'supplier approved');
        await ok(as(c, SEED_BUYER, '/v1/purchase/orders/PO-R2', { supplierId: 'sup-1', deliverToLocationId: 'br-1', lines: [{ productId: 'RICE', orderedQty: 10, unitCost: { minor: 5_000, currency: 'INR' } }] }, 'po'), 'po');
        await ok(as(c, OWNER, '/v1/purchase/orders/PO-R2/approval', { reason: 'weekly rice' }, 'po-ok'), 'po issued');
      },
    });
    const got = await shop.cloud().request({ method: 'POST', path: '/v1/inventory/goods-receipt/grn-r2', userId: MGR, branchId: 'br-1', idempotencyKey: 'grn-r2', body: {
      warehouseId: 'br-1', receivedOnDate: '2026-11-18', currency: 'INR', poId: 'PO-R2',
      lines: [{ lineId: 'L1', productId: 'RICE', orderedMinor: 10, countedMinor: 10, uom: 'ea', unitCost: { minor: 5_000, currency: 'INR' }, condition: 'good' }],
    } });
    if (got.status >= 300) throw new Error(`receive: ${got.status} ${JSON.stringify(got.body)}`);
    grnNumber = ((await shop.cloud().request({ method: 'GET', path: '/v1/inventory/goods-receipt/grn-r2', userId: OWNER })).body as { grn: { documentNumber: string } }).grn.documentNumber;
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 180_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  const statusSays = (page: Page, re: RegExp) =>
    page.waitForFunction((src) => new RegExp(src as string).test((globalThis as unknown as { document: Doc }).document.getElementById('grc-status')?.textContent ?? ''), re.source, { timeout: 20_000 });

  it('opens the receipt by its number, asks for the second person, saves the correction, and shows original and correction', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
    await shop.signIn(context, MGR, 'br-1');
    const page = await context.newPage();
    const writes: string[] = []; const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/v1/') && r.method() !== 'GET') writes.push(`${r.method()} ${u.pathname}`); });
    try {
      await page.goto(`${shop.base}/goods-receipt`, { waitUntil: 'load' });
      await page.locator('#grc-section').waitFor({ timeout: 20_000 });
      expect(grnNumber).toMatch(/^GRN1\//);
      await page.fill('#grc-ref', grnNumber);
      await page.click('#grc-open');
      await page.locator('#grc-lines tr[data-line="L1"]').waitFor({ timeout: 20_000 });
      expect(await page.locator('#grc-lines tr[data-line="L1"]').innerText()).toMatch(/L1 · RICE\s+10\s+10/);
      await page.selectOption('#grc-line', 'L1');
      await page.fill('#grc-right', '8');
      await page.fill('#grc-why', '10 keyed, 8 bags on the pallet');
      await page.click('#grc-save');
      await statusSays(page, /second person who handles stock approves it first/);
      await page.click('#grc-ask');
      await statusSays(page, /Asked — once another person approves it/);
      const inbox = (await shop.cloud().request({ method: 'GET', path: '/v1/approvals/requests', userId: OWNER })).body as { waitingForMe: { requestId: string; kind: string }[] };
      const req = inbox.waitingForMe.find((r) => r.kind === 'goods_receipt_correction');
      expect(req).toBeDefined();
      await ok(shop.cloud().request({ method: 'POST', path: `/v1/approvals/requests/${req!.requestId}/decide`, userId: OWNER, idempotencyKey: 'decide-r2', body: { decision: 'approved', reason: 'checked the pallet' } }), 'owner approves');
      await page.click('#grc-save');
      await statusSays(page, /Saved: GRC1\/\d\d-\d\d\/00001 · 10 → 8 · ₹100\.00/);
      await page.locator('#grc-list li[data-correction]').waitFor({ timeout: 20_000 });
      expect(await page.locator('#grc-lines tr[data-line="L1"]').innerText()).toMatch(/L1 · RICE\s+10\s+8/);
      expect(await page.locator('#grc-list').innerText()).toMatch(/10 → 8 · ₹100\.00 · asked by u-mgr-br1 · approved by u-owner · “10 keyed, 8 bags on the pallet”/);
      if (SHOTS !== undefined) await page.locator('#grc-section').screenshot({ path: `${SHOTS}/r2-1-receipt-corrected.png` });
      expect(writes.filter((x) => x.includes('/corrections/')).length).toBe(2);
      expect(writes).toContain('POST /v1/approvals/requests');
      // Head office: the receipt unchanged, the order's received figure corrected.
      const grn = (await shop.cloud().request({ method: 'GET', path: '/v1/inventory/goods-receipt/grn-r2', userId: OWNER })).body as { grn: { documentNumber: string; captured: { lines: { sellableMinor: number }[] } } };
      expect([grn.grn.documentNumber, grn.grn.captured.lines[0]!.sellableMinor]).toEqual([grnNumber, 10]);
      const po = (await shop.cloud().request({ method: 'GET', path: '/v1/purchase/orders/PO-R2', userId: OWNER })).body as { order: { receivedByProduct: Record<string, number> } };
      expect(po.order.receivedByProduct['RICE']).toBe(8);
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  });

  // OB-875 B (owner, 19 Nov 2026): once the receipt's month has its GST return filed, head office refuses a correction until
  // the CA reopens the month — the page says so when the receipt is opened, and again when Save is pressed.
  it('says, in plain words, that a receipt in a month whose GST return is filed waits for the CA to reopen the month', async () => {
    const grn = (await shop.cloud().request({ method: 'GET', path: '/v1/inventory/goods-receipt/grn-r2', userId: OWNER })).body as { grn: { receivedAt: string } };
    const month = tradingMonthIn(grn.grn.receivedAt);
    await ok(shop.cloud().request({ method: 'POST', path: `/v1/finance/returns/GSTR1/${month.slice(5, 7)}${month.slice(0, 4)}/filed`, userId: OWNER, idempotencyKey: 'gstr1-filed-r2', body: { arn: 'AA3311260000002', filedOn: shopDateIn(new Date().toISOString()) } }), 'GSTR-1 recorded filed');
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
    await shop.signIn(context, MGR, 'br-1');
    const page = await context.newPage();
    try {
      await page.goto(`${shop.base}/goods-receipt`, { waitUntil: 'load' });
      await page.locator('#grc-section').waitFor({ timeout: 20_000 });
      await page.fill('#grc-ref', grnNumber);
      await page.click('#grc-open');
      await page.locator('#grc-lines tr[data-line="L1"]').waitFor({ timeout: 20_000 });
      expect(await page.locator('#grc-state').innerText()).toMatch(/That month's GST return \(GSTR-1\) is filed, so the receipt is not corrected until the CA signs the month off\./);
      await page.selectOption('#grc-line', 'L1');
      await page.fill('#grc-right', '7');
      await page.fill('#grc-why', 'one more bag short');
      await page.click('#grc-save');
      await statusSays(page, /Head office did not save it: .*GST return \(GSTR-1\) is filed.*Approvals → Reopen a signed accounting month.*Nothing was changed\./);
      if (SHOTS !== undefined) await page.locator('#grc-section').screenshot({ path: `${SHOTS}/r2-2-month-filed-refused.png` });
      const po = (await shop.cloud().request({ method: 'GET', path: '/v1/purchase/orders/PO-R2', userId: OWNER })).body as { order: { receivedByProduct: Record<string, number> } };
      expect(po.order.receivedByProduct['RICE']).toBe(8);
    } finally { await context.close(); }
  });
});
