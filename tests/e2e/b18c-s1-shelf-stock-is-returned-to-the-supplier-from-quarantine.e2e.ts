import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startInboxShop, ok, OWNER, MGR, type InboxShop } from './lib/ai-inbox-shop';
import type { RealCloud } from '../support/real-store';

/**
 * **S1 · batch 18c — "Return to supplier" on the Quarantine page, in a real browser, on the PRODUCTION API over real
 * PostgreSQL** (roadmap §29 purchase_return · M10-FR-01 · OB-872):
 *
 *   • opened from an Expiry row's link, the box is filled with the item, the batch, how many and why; the manager picks the
 *     supplier and presses "Return to supplier": head office gives it `RTS1/…`, issues the debit note `SDN/…` and the
 *     stock on hand falls — read back from head office, not the page;
 *   • a bigger return needs a second person: "Ask for approval" appears; once the owner approves, the same press returns it
 *     in the manager's name with the owner as approver.
 * Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const SHOTS = process.env['B18C_SHOTS'];
const KEY = ['b18c', 's1', 'e2e', 'signing', 'key'].join('-').padEnd(48, '0');
const ACCT = 'u-acct-b18c-s1';
const SEED_BUYER = 'u-seed-buyer-b18c-s1';
type Doc = { getElementById(x: string): { textContent: string | null } | null };

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('S1: expired or damaged shelf stock is returned to the supplier from Quarantine', () => {
  let browser: Browser;
  let shop: InboxShop;
  const as = (c: RealCloud, userId: string, path: string, body: unknown, key: string) => c.request({ method: 'POST', path, userId, body, idempotencyKey: key });
  const onHand = async (): Promise<number> =>
    ((await shop.cloud().request({ method: 'GET', path: '/v1/inventory/availability', userId: OWNER, query: { productId: 'OIL' } })).body as { rows: { locationId: string; onHandMinor: number }[] }).rows.find((r) => r.locationId === 'br-1')?.onHandMinor ?? 0;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    if (SHOTS !== undefined) mkdirSync(SHOTS, { recursive: true });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/quarantine', html: 'quarantine.html', dataGlobal: 'quarantineData' },
      seed: async (c) => {
        await c.grant(ACCT, 'accountant', undefined, 'all');
        await c.grant(SEED_BUYER, 'store_manager', undefined, 'all');
        await ok(as(c, SEED_BUYER, '/v1/purchase/suppliers/sup-1', { name: 'Sri Foods (synthetic)' }, 'sup'), 'supplier');
        await ok(as(c, ACCT, '/v1/purchase/suppliers/sup-1/approval', { reason: 'documents checked' }, 'sup-ok'), 'supplier approved');
        await ok(as(c, OWNER, '/v1/inventory/movements', { movementId: 'rx-oil', productId: 'OIL', locationId: 'br-1', kind: 'received', quantityMinor: 120, uom: 'ea', occurredAt: '2026-11-01T09:00:00.000Z', enteredBy: OWNER, unitCostMinor: 15_000, batchId: 'B-OLD' }, 'rx'), 'stock');
      },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 180_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  const open = async (who: string, path: string) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
    await shop.signIn(context, who, who === MGR ? 'br-1' : undefined);
    const page = await context.newPage();
    const writes: string[] = []; const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/v1/') && r.method() !== 'GET') writes.push(`${r.method()} ${u.pathname}`); });
    await page.goto(`${shop.base}${path}`, { waitUntil: 'load' });
    return { page, writes, errors, close: () => context.close() };
  };
  const statusSays = (page: Page, re: RegExp) =>
    page.waitForFunction((src) => new RegExp(src as string).test((globalThis as unknown as { document: Doc }).document.getElementById('rts-status')?.textContent ?? ''), re.source, { timeout: 20_000 });
  const shot = async (page: Page, name: string) => { if (SHOTS !== undefined) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }); };

  it('a small return goes at once with its RTS and SDN numbers; a bigger one waits for the owner\'s approval', async () => {
    const s = await open(MGR, '/quarantine?return=1&product=OIL&batch=B-OLD&qty=2&reason=expired&place=br-1');
    try {
      await s.page.locator('#return-section').waitFor({ state: 'visible', timeout: 20_000 });
      await s.page.waitForFunction(() => (globalThis as unknown as { document: { querySelectorAll(x: string): { length: number } } }).document.querySelectorAll('#rts-supplier option').length > 1, undefined, { timeout: 20_000 });
      expect(await s.page.inputValue('#rts-product')).toBe('OIL');
      expect(await s.page.inputValue('#rts-batch')).toBe('B-OLD');
      expect(await s.page.inputValue('#rts-qty')).toBe('2');
      expect(await s.page.inputValue('#rts-reason')).toBe('expired');
      expect(s.writes, 'opening the page sends nothing').toEqual([]);
      // No supplier chosen → nothing is sent.
      await s.page.click('#rts-send');
      await statusSays(s.page, /Fill in the item/);
      expect(s.writes).toEqual([]);
      await s.page.selectOption('#rts-supplier', 'sup-1');
      await s.page.fill('#rts-note', 'found past its date on aisle 4');
      await shot(s.page, 's1-1-return-box-filled-from-expiry');
      await s.page.click('#rts-send');
      await statusSays(s.page, /Returned: RTS1\/\d\d-\d\d\/00001 · debit note SDN\/\d\d-\d\d\/\d{5} · ₹300\.00/);
      expect(s.writes).toEqual(['POST /v1/inventory/shelf-returns/' + s.writes[0]!.split('/').pop()]);
      expect(await onHand()).toBe(118);
      await s.page.locator('#rts-list li[data-return]').first().waitFor({ timeout: 20_000 });
      await shot(s.page, 's1-2-returned-with-rts-and-sdn');

      // ₹900: above the write-off limit — the same approval as a write-off of that value.
      await s.page.fill('#rts-product', 'OIL'); await s.page.fill('#rts-place', 'br-1'); await s.page.fill('#rts-batch', 'B-OLD');
      await s.page.fill('#rts-qty', '6'); await s.page.selectOption('#rts-reason', 'damaged'); await s.page.fill('#rts-note', 'pouches torn');
      await s.page.click('#rts-send');
      await statusSays(s.page, /second person must approve this return first/);
      await s.page.locator('#rts-ask').waitFor({ state: 'visible' });
      await s.page.click('#rts-ask');
      await statusSays(s.page, /Asked — once another person approves it/);
      await shot(s.page, 's1-3-asked-for-approval');
      const inbox = (await shop.cloud().request({ method: 'GET', path: '/v1/approvals/requests', userId: OWNER })).body as { waitingForMe: { requestId: string; kind: string }[] };
      const req = inbox.waitingForMe.find((r) => r.kind === 'stock_write_off');
      expect(req).toBeDefined();
      await ok(shop.cloud().request({ method: 'POST', path: `/v1/approvals/requests/${req!.requestId}/decide`, userId: OWNER, idempotencyKey: 'decide-s1', body: { decision: 'approved', reason: 'torn, supplier agreed' } }), 'owner approves');
      await s.page.click('#rts-send');
      await statusSays(s.page, /Returned: RTS1\/\d\d-\d\d\/00002 .* ₹900\.00/);
      expect(await onHand()).toBe(112);
      const list = (await shop.cloud().request({ method: 'GET', path: '/v1/inventory/shelf-returns', userId: OWNER })).body as { returns: { raisedBy: string; approvedBy: string | null; quantityMinor: number }[] };
      expect(list.returns.map((r) => [r.quantityMinor, r.raisedBy, r.approvedBy])).toEqual([[6, MGR, OWNER], [2, MGR, null]]);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
  });
});
