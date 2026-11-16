import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser } from 'playwright-core';
import { startInboxShop, ok, MGR, type InboxShop } from './lib/ai-inbox-shop';
import type { RealCloud } from '../support/real-store';
import { actionDetails } from '../../services/identity/src/approval-requests';

/**
 * **OB-808 A (owner, 16 Nov 2026) · D-013 — in a real browser, on the PRODUCTION API over real PostgreSQL.**
 *
 * The walkthrough: the store manager approved "Write off 6 pouches of Sunflower Oil" on Approvals; the page said "The
 * person who asked can now go ahead — once", and the oil stayed at 120. Now, through Chromium:
 *
 *   • the back-store person asks for the loss (6 pouches, torn — with a photo, a second person needed);
 *   • the manager opens Approvals, writes a reason and presses Approve — the ONE write is the decision;
 *   • the page says "Written off: 6 of Sunflower Oil … from …", and head office's own stock reads 114 at once;
 *   • the write-off is the asker's, approved by the manager — read back from head office, not from the page.
 *
 * Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['ob808', 'e2e', 'signing', 'key'].join('-').padEnd(48, '0');
const BACK = 'u-back-ob808';
const WO = 'wo-oil-ob808';

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('OB-808 A · D-013: approving a write-off on Approvals writes it off at once, in the asker\'s name', () => {
  let browser: Browser;
  let shop: InboxShop;
  let requestId = '';
  const as = (c: RealCloud, userId: string, path: string, body: unknown, key: string, branchId?: string) =>
    c.request({ method: 'POST', path, userId, body, idempotencyKey: key, ...(branchId === undefined ? {} : { branchId }) });
  const onHand = async (): Promise<number> =>
    ((await shop.cloud().request({ method: 'GET', path: '/v1/inventory/availability?productId=OIL', userId: MGR, branchId: 'br-1' })).body as { rows: { locationId: string; onHandMinor: number }[] })
      .rows.find((r) => r.locationId === 'br-1')?.onHandMinor ?? 0;
  const loss = { productId: 'OIL', locationId: 'br-1', qty: 6, uom: 'ea', lossType: 'damage', reasonCode: 'damage', valueMinor: 90_000, evidenceRef: 'photo-torn-pouches' };

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/approvals', html: 'approvals.html', dataGlobal: 'approvalsData' },
      seed: async (c) => {
        await c.grant(BACK, 'store_manager', undefined, ['br-1']);
        await ok(as(c, 'u-owner', '/v1/catalogue/tax-classes/1507/rates/2017-07-01', { rateBps: 500 }, 'tax'), 'tax');
        await ok(as(c, 'u-owner', '/v1/catalogue/products/OIL/publish', {
          product: { sku: 'SKU-OIL', name: 'Sunflower Oil 1 L (synthetic)', baseUom: 'ea', primaryCategoryId: 'grocery', taxClass: '1507', lifecycle: 'active' },
          categories: [{ categoryId: 'grocery', name: 'Grocery', parentId: null }],
        }, 'pub-oil'), 'publish oil');
        // 120 pouches on the shelf at ₹150 each — head office's own cost values the loss (₹900: a second person).
        await ok(as(c, 'u-owner', '/v1/inventory/movements', { movementId: 'oil-in', productId: 'OIL', locationId: 'br-1', kind: 'received', quantityMinor: 120, uom: 'ea', occurredAt: '2026-11-01T09:00:00.000Z', enteredBy: 'u-owner', unitCostMinor: 15_000 }, 'oil-in'), 'oil in');
      },
    });
    // The back-store person asks for exactly this loss.
    const asked = await as(shop.cloud(), BACK, '/v1/approvals/requests', {
      kind: 'stock_write_off', subjectRef: WO, details: actionDetails(loss, { writeOffId: WO }), valueMinor: 90_000,
      summary: 'Write off 6 pouches of Sunflower Oil', reason: 'the pouches are torn',
    }, 'ask-ob808', 'br-1');
    if (asked.status !== 201) throw new Error(`ask: ${asked.status} ${JSON.stringify(asked.body)}`);
    requestId = (asked.body as { requestId: string }).requestId;
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 180_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  it('the manager approves on Approvals, and the oil is written off at once — the asker\'s loss, the manager\'s approval', async () => {
    expect(await onHand()).toBe(120);
    const context = await browser.newContext();
    await shop.signIn(context, MGR, 'br-1');
    const page = await context.newPage();
    const writes: string[] = []; const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/v1/') && r.method() !== 'GET') writes.push(`${r.method()} ${u.pathname}`); });
    try {
      await page.goto(`${shop.base}/approvals`, { waitUntil: 'load' });
      const reason = page.locator(`#reason-${requestId}`);
      await reason.waitFor({ timeout: 20_000 });
      expect(writes, 'opening Approvals writes nothing').toEqual([]);
      await reason.fill('checked the torn pouches myself');
      await page.locator(`button.approve[data-request-id="${requestId}"]`).click();
      await page.waitForFunction(() => /Written off: /.test((globalThis as unknown as { document: { getElementById(x: string): { textContent: string | null } | null } }).document.getElementById('result-text')?.textContent ?? ''), undefined, { timeout: 20_000 });
      const said = (await page.locator('#result-text').textContent()) ?? '';
      expect(said).toMatch(/^Written off: 6 of Sunflower Oil 1 L \(synthetic\) from .+\.$/);
      expect(said).not.toMatch(/go ahead/);
      // The one write the page made was the decision; head office wrote the loss off itself.
      expect(writes).toEqual([`POST /v1/approvals/requests/${requestId}/decide`]);
      expect(errors).toEqual([]);
    } finally { await context.close(); }

    // Read back from head office: the stock fell by 6 at once, by the asker's write-off, approved by the manager.
    expect(await onHand()).toBe(114);
    const wo = ((await shop.cloud().request({ method: 'GET', path: '/v1/inventory/write-offs', userId: MGR, branchId: 'br-1' })).body as { writeOffs: { id: string; qtyRemoved: number; raisedBy: string; approvedBy: string | null }[] }).writeOffs.filter((w) => w.id === WO);
    expect(wo).toHaveLength(1);
    expect(wo[0]).toMatchObject({ qtyRemoved: 6, raisedBy: BACK, approvedBy: MGR });
  });
});
