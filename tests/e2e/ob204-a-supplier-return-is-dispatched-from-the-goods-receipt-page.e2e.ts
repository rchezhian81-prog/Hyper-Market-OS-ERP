import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startInboxShop, ok, OWNER, type InboxShop } from './lib/ai-inbox-shop';
import { auditPage } from './lib/a11y-audit';
import { SUPPLIER_MAKER, SUPPLIER_CHECKER } from '../support/approved-supplier';
import { supplierReturnEwbMovementId } from '../../services/inventory/src/goods-receipt';

/**
 * **OB-204 (owner, 18 Oct 2026, in writing): the "Dispatch" button on the goods-receipt page, in a real browser, on the
 * PRODUCTION API over real PostgreSQL.** A delivery of rice comes in damaged; a second person sends the line back to the
 * supplier — ₹1,00,100, above the ₹1,00,000 intra-Tamil-Nadu e-way-bill threshold, so it must leave under a generated
 * e-way bill (OB-194). Through Chromium the receiver:
 *   1. sees the return with "no e-way bill yet" in words, a Dispatch button beside it, and nothing offered as "gone back";
 *   2. presses Dispatch — head office refuses (`ewb_required`), the page says why in plain words, the return stays
 *      undispatched and nothing is recorded;
 *   3. once the e-way bill is generated (the finance desk's step), Refresh shows "E-way bill 391000654321 generated";
 *   4. presses Dispatch — the number is shown, and the line is offered as gone back;
 *   5. records it as gone back — head office's record carries the e-way bill number.
 * Also: in Tamil the same states read in Tamil; a cashier (who may not read receiving at all) is shown no return and no
 * button; and with the connection cut, Dispatch says "needs connection" and nothing is pretended. (A reader who may see
 * receipts but not move stock — no role in today's register — sees the state and no button: the session's unit test.)
 *
 * Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const SHOTS = process.env['OB204_SHOTS_DIR'];
const KEY = ['ob204', 'dispatch', 'e2e', 'key'].join('-').padEnd(48, '0');
const TN_SHOP = '33AAACS1111A1ZH';
const TN_SUPPLIER = '33AAACS1111A2ZG';
const RICE = { minor: 10_000, currency: 'INR' }; // ₹100.00 a bag
const RECV = 'u-recv';
const MOVEMENT = supplierReturnEwbMovementId('grn-big', { kind: 'line', lineId: 'L1' });
const EWB = '391000654321';

interface Doc { querySelectorAll(s: string): { length: number } }
const shot = async (page: Page, name: string): Promise<void> => {
  if (SHOTS === undefined) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, name), fullPage: true });
};

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('OB-204 · a supplier return is dispatched from the goods-receipt page, on the production API', () => {
  let browser: Browser;
  let shop: InboxShop;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY, deferManagerGrant: true,
      page: { path: '/goods-receipt', html: 'goods-receipt.html', dataGlobal: 'goodsReceiptData' },
      seed: async (cloud) => {
        const req = (method: 'GET' | 'POST', path: string, body: unknown, userId = OWNER) => cloud.request({ method, path, userId, idempotencyKey: `${method}-${path}-${userId}`, body });
        await cloud.grant(RECV, 'store_manager');
        await cloud.grant('u-boss', 'store_manager');
        // OB-288 P3 (§28): the person who raises the order never also books its goods in — a separate buyer raises it.
        await cloud.grant('u-po-buyer', 'store_manager');
        await cloud.grant('u-till', 'cashier');
        await cloud.grant(SUPPLIER_MAKER, 'store_manager');
        await cloud.grant(SUPPLIER_CHECKER, 'accountant');
        // The organisation: the warehouse under the shop's Tamil Nadu registration; a Tamil Nadu supplier with its GSTIN.
        await ok(req('POST', '/v1/org/nodes/C1', { kind: 'company', name: 'Synthetic Retail' }), 'company');
        await ok(req('POST', `/v1/org/gst-registrations/${TN_SHOP}`, { companyId: 'C1', legalName: 'Synthetic Retail TN' }), 'registration');
        await ok(req('POST', '/v1/org/nodes/WH', { kind: 'warehouse', name: 'Back store', parentId: 'C1', companyId: 'C1', gstin: TN_SHOP }), 'warehouse');
        await ok(req('POST', '/v1/purchase/suppliers/sup-tn', { name: 'Synthetic Rice Mills', gstin: TN_SUPPLIER }, SUPPLIER_MAKER), 'propose supplier');
        await ok(req('POST', '/v1/purchase/suppliers/sup-tn/approval', { reason: 'synthetic, documents checked' }, SUPPLIER_CHECKER), 'approve supplier');
        await ok(req('POST', '/v1/inventory/receipt-policy', { excessToleranceBp: 0, shortageToleranceBp: 0, nearExpiryDays: 7 }), 'policy');
        await ok(req('POST', '/v1/purchase/orders/po-rice', { supplierId: 'sup-tn', deliverToLocationId: 'WH', lines: [{ productId: 'p-rice', orderedQty: 5_000, unitCost: RICE }] }, 'u-po-buyer'), 'po');
        await ok(req('POST', '/v1/purchase/orders/po-rice/approval', { reason: 'fixture' }), 'issue po');
        // 1,001 damaged bags, sent back by a second person: ₹1,00,100 — above the ₹1,00,000 threshold.
        await ok(req('POST', '/v1/inventory/goods-receipt/grn-big', { warehouseId: 'WH', receivedOnDate: '2026-10-18', currency: 'INR', poId: 'po-rice', lines: [{ lineId: 'L1', productId: 'p-rice', orderedMinor: 1_001, countedMinor: 1_001, uom: 'ea', unitCost: RICE, condition: 'damaged' }] }, RECV), 'grn');
        await ok(req('POST', '/v1/inventory/goods-receipt/grn-big/lines/L1/disposition', { disposition: 'return', reason: 'bags torn' }, 'u-boss'), 'disposition');
      },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 180_000);

  afterAll(async () => {
    await browser?.close();
    await shop?.stop();
  });

  const headOffice = async (): Promise<{ returnDispatches?: { state: string; ewbNo: string | null }[]; lineReturns?: { lineId: string; dispatch?: { ewbNo: string | null } }[] }> =>
    ((await shop.cloud().request({ method: 'GET', path: '/v1/inventory/goods-receipt', userId: OWNER })).body as { receipts: { grnId: string }[] }).receipts.find((g) => g.grnId === 'grn-big') as never;
  const openAs = async (who: string, ready = 'ul.returns li[data-line-id="L1"]'): Promise<{ page: Page; close: () => Promise<void>; errors: string[] }> => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await shop.signIn(context, who);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${shop.base}/goods-receipt`, { waitUntil: 'load' });
    await page.waitForFunction((sel) => (globalThis as unknown as { document: Doc }).document.querySelectorAll(sel).length > 0, ready, { timeout: 20_000 });
    return { page, errors, close: () => context.close() };
  };
  const line = (page: Page) => page.locator('#rows li.row', { hasText: 'grn-big' }).locator('ul.returns li[data-line-id="L1"]');

  it('refused without an e-way bill and said plainly; dispatched once one is generated, showing its number; then recorded as gone back', async () => {
    const { page, errors, close } = await openAs(RECV);
    const asked: string[] = [];
    page.on('request', (r) => { const u = new URL(r.url()); if (r.method() === 'POST' && u.pathname.startsWith('/v1/')) asked.push(u.pathname); });
    try {
      // 1. Where it stands, in words; Dispatch beside it; nothing offered as gone back yet.
      expect(await line(page).locator('.sre-chip.ewb').textContent()).toBe('Above the e-way-bill limit — no e-way bill yet, so it cannot leave');
      expect(await line(page).locator('.sre-chip.ewb').getAttribute('data-tone')).toBe('error');
      expect(await line(page).locator('.sre-chip.ewb svg').getAttribute('data-icon')).toBe('circle-alert');
      expect(await line(page).locator('button.dispatch').textContent()).toBe('Dispatch');
      expect(await line(page).locator('button.dispatch svg').getAttribute('data-icon')).toBe('truck');
      expect(await page.textContent('#return-none')).toMatch(/^Nothing can be recorded as gone back yet — a return above the e-way-bill limit is dispatched first/);
      expect(await page.isVisible('#return')).toBe(false);
      expect(await auditPage(page, { expectLang: 'en' }), 'the page with a return to dispatch').toEqual([]);
      await shot(page, 'ob204-after-1-no-ewb.png');

      // 2. Dispatch with no e-way bill: refused by name, said plainly; the return stays undispatched.
      await line(page).locator('input.dispatch-reason').fill('supplier lorry TN-01-AB-1234');
      await line(page).locator('button.dispatch').click();
      await page.locator('#result.tone-error').waitFor({ timeout: 15_000 });
      expect(await page.textContent('#result-text')).toBe(`Not dispatched — it needs a generated e-way bill first. Head office said: This supplier return cannot leave without an e-way bill: movement ${MOVEMENT} is worth ₹1,00,100.00, above the ₹1,00,000.00 threshold, and no e-way bill has been generated for it.`);
      expect(await line(page).locator('.sre-chip.ewb').textContent()).toMatch(/no e-way bill yet/);
      expect(await line(page).locator('button.dispatch').isVisible()).toBe(true);
      expect(await page.isVisible('#return')).toBe(false);
      expect((await headOffice()).returnDispatches).toEqual([expect.objectContaining({ state: 'no_ewb' })]);
      await shot(page, 'ob204-after-2-refused.png');

      // 3. The finance desk generates the e-way bill (submitted, then the portal's answer); Refresh shows it with its number.
      await ok(shop.cloud().request({ method: 'POST', path: `/v1/finance/e-way-bill/movements/${MOVEMENT}/submit`, userId: OWNER, idempotencyKey: 'ewb-submit', body: { request: { supplierGstin: TN_SHOP, recipientGstin: TN_SUPPLIER, documentType: 'CHL', documentNumber: 'SR-grn-big-L1', documentDate: '2026-10-18', hsnCode: '1006', consignmentValueMinor: 10_010_000, supplyRoute: 'intra_state', movementReason: 'supplier_return', fromPincode: '600001', toPincode: '641001' } } }), 'submit');
      await page.click('#refresh');
      await expect.poll(() => line(page).locator('.sre-chip.ewb').textContent(), { timeout: 15_000 }).toBe('E-way bill waiting — asked for, not generated yet');
      await ok(shop.cloud().request({ method: 'POST', path: `/v1/finance/e-way-bill/movements/${MOVEMENT}/record-response`, userId: OWNER, idempotencyKey: 'ewb-generated', body: { result: { status: 'generated', ewbNo: EWB, ewbDate: '2026-10-18', validUpto: '2026-10-19' } } }), 'generated');
      await page.click('#refresh');
      await expect.poll(() => line(page).locator('.sre-chip.ewb').textContent(), { timeout: 15_000 }).toBe(`E-way bill ${EWB} generated — ready to dispatch`);
      await shot(page, 'ob204-after-3-generated.png');

      // 4. Dispatch: the number is shown, and "gone back" is offered.
      await line(page).locator('input.dispatch-reason').fill('supplier lorry TN-01-AB-1234');
      await line(page).locator('button.dispatch').click();
      await page.locator('#result.tone-ok').waitFor({ timeout: 15_000 });
      expect(await page.textContent('#result-text')).toBe(`Dispatched under e-way bill ${EWB}. You can now record it as gone back.`);
      await expect.poll(() => line(page).locator('.sre-chip.ewb').textContent(), { timeout: 15_000 }).toBe(`Dispatched under e-way bill ${EWB}`);
      expect(await line(page).locator('button.dispatch').count()).toBe(0);
      expect(await page.isVisible('#return')).toBe(true);
      expect(await page.locator('#return-line option').allTextContents()).toEqual([expect.stringContaining('p-rice')]);
      expect((await headOffice()).returnDispatches).toEqual([expect.objectContaining({ state: 'dispatched', ewbNo: EWB })]);
      await shot(page, 'ob204-after-4-dispatched.png');

      // 5. Recorded as gone back — head office's record carries the e-way bill number.
      await page.fill('#return-reason', 'collected by the supplier lorry TN-01-AB-1234');
      await page.click('#return');
      await page.locator('#result.tone-ok').filter({ hasText: 'Recorded' }).waitFor({ timeout: 15_000 });
      await expect.poll(() => line(page).locator('.r-word').textContent(), { timeout: 15_000 }).toBe('Gone back to the supplier');
      expect(await line(page).locator('.sre-chip.ewb').textContent()).toBe(`Dispatched under e-way bill ${EWB}`);
      const record = await headOffice();
      expect(record.lineReturns).toEqual([expect.objectContaining({ lineId: 'L1', dispatch: expect.objectContaining({ ewbNo: EWB, movementId: MOVEMENT }) })]);
      // Exactly the two writes a person made: the refused dispatch, the dispatch, the return.
      expect(asked).toEqual(['/v1/inventory/goods-receipt/grn-big/lines/L1/dispatch', '/v1/inventory/goods-receipt/grn-big/lines/L1/dispatch', '/v1/inventory/goods-receipt/grn-big/lines/L1/returned']);

      // In Tamil, the same state in Tamil.
      await page.click('#lang');
      await page.waitForFunction('document.documentElement.lang === "ta"');
      expect(await line(page).locator('.sre-chip.ewb').textContent()).toBe(`இ-வே பில் ${EWB} உடன் அனுப்பப்பட்டது`);
      expect(await auditPage(page, { expectLang: 'ta' }), 'the page in Tamil').toEqual([]);
      expect(errors).toEqual([]);
    } finally { await close(); }
  }, 180_000);

  it('a cashier is shown no button; with the connection cut, Dispatch says "needs connection" and nothing is pretended', async () => {
    // A second return to dispatch, so there is one still to go.
    const req = (path: string, body: unknown, userId: string) => shop.cloud().request({ method: 'POST', path, userId, idempotencyKey: `${path}-${userId}`, body });
    await ok(req('/v1/inventory/goods-receipt/grn-two', { warehouseId: 'WH', receivedOnDate: '2026-10-18', currency: 'INR', poId: 'po-rice', lines: [{ lineId: 'L1', productId: 'p-rice', orderedMinor: 1_500, countedMinor: 1_500, uom: 'ea', unitCost: RICE, condition: 'damaged' }] }, RECV), 'grn-two');
    await ok(req('/v1/inventory/goods-receipt/grn-two/lines/L1/disposition', { disposition: 'return', reason: 'bags torn' }, 'u-boss'), 'disposition two');
    const two = (page: Page) => page.locator('#rows li.row', { hasText: 'grn-two' }).locator('ul.returns li[data-line-id="L1"]');

    const till = await openAs('u-till', '#state:not([hidden])');
    try {
      // The cashier may not read receiving: a plain not-permitted state, no return, no Dispatch.
      expect(await till.page.textContent('#state-text')).toBe('You do not have permission to see goods receipts.');
      expect(await till.page.locator('button.dispatch').count()).toBe(0);
    } finally { await till.close(); }

    const recv = await openAs(RECV);
    try {
      await expect.poll(() => two(recv.page).count(), { timeout: 15_000 }).toBe(1);
      await recv.page.route('**/v1/inventory/goods-receipt/**/dispatch', (route) => route.abort('internetdisconnected'));
      await two(recv.page).locator('input.dispatch-reason').fill('supplier lorry TN-01-AB-1234');
      await two(recv.page).locator('button.dispatch').click();
      await recv.page.locator('#result.tone-degraded').waitFor({ timeout: 15_000 });
      expect(await recv.page.textContent('#result-text')).toBe('Needs connection — head office could not be reached, so nothing was dispatched. Try again when connected.');
      expect(await two(recv.page).locator('.sre-chip.ewb').textContent()).toMatch(/no e-way bill yet/);
      expect(await two(recv.page).locator('button.dispatch').isVisible()).toBe(true);
      const g = ((await shop.cloud().request({ method: 'GET', path: '/v1/inventory/goods-receipt', userId: OWNER })).body as { receipts: { grnId: string; returnDispatches?: { state: string }[] }[] }).receipts.find((x) => x.grnId === 'grn-two');
      expect(g?.returnDispatches).toEqual([expect.objectContaining({ state: 'no_ewb' })]);
      expect(recv.errors).toEqual([]);
    } finally { await recv.close(); }
  }, 120_000);
});
