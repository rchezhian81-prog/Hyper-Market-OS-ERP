import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startInboxShop, ok, OWNER, MGR, type InboxShop } from './lib/ai-inbox-shop';
import { DEFAULT_RETAIL_POSTING_MAP } from '../../packages/finance/src/index';
import { validateTallyImport } from '../../packages/tally-export/src/index';
import type { RealCloud } from '../support/real-store';

/**
 * **W4 · WF-05 "Capture/OCR/import → validate → PO-GRN-invoice match → discrepancy → approval → AP/Tally" — ONE connected
 * browser run of the after-match steps, on the PRODUCTION API over real PostgreSQL.** Synthetic data only.
 *
 * A delivery of an order comes one dal short and with both oil tins damaged (a second person decided they go back to the
 * supplier — a debit note). Through Chromium:
 *   1. SUPPLIER BILLS — the br-1 store manager hands in the paper bill's scan (no reading engine: it waits to be typed),
 *      types it from the paper and asks a second person to check it; nothing is on the register yet;
 *   2. APPROVALS — the accountant checks it on HIS Approvals page (`supplier_invoice_check`) and approves it;
 *   3. SUPPLIER BILLS — the manager saves the bill exactly as checked, naming that approval (head office records the
 *      accountant as its checker); the three-way match holds back the short dal ("Do not pay this yet"); the oil's debit
 *      note is issued its DN number once;
 *   4. DAY BOOK — the accountant puts the supplier bills in the books through his own rules (nothing typed): the bill and
 *      the debit note are journals, and the supplier's register agrees with the books to the paisa;
 *   5. TALLY FILES — the month's supplier-bill file: Tally's import check accepts it; the voucher file is head office's.
 * Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['w4', 'wf05', 'e2e', 'signing', 'key'].join('-').padEnd(48, '0');
const ACCT = 'u-acct-wf05';
const SEED_BUYER = 'u-seed-buyer'; const RECV = 'u-recv-wf05'; const BOSS = 'u-boss-wf05';
const SCAN = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('synthetic paper bill KA-7', 'utf8')]);

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('WF-05 — a supplier bill from its second check to the Tally file, on the production API', () => {
  let browser: Browser;
  let shop: InboxShop;
  const as = (c: RealCloud, path: string, body: unknown, key: string, userId = OWNER, method: 'POST' | 'PUT' = 'POST') => ok(c.request({ method, path, userId, body, idempotencyKey: key }), path);

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/supplier-bills', html: 'supplier-bills.html', dataGlobal: 'supplierBillsData' },
      alsoPages: [
        { path: '/approvals', html: 'approvals.html', dataGlobal: 'approvalsData' },
        { path: '/day-book', html: 'day-book.html', dataGlobal: 'dayBookData' },
        { path: '/tally-files', html: 'tally-files.html', dataGlobal: 'tallyFilesData' },
      ],
      seed: async (c) => {
        await c.grant(ACCT, 'accountant', undefined, 'all');
        await c.grant(SEED_BUYER, 'store_manager', undefined, 'all');
        await c.grant(RECV, 'store_manager', undefined, 'all');
        await c.grant(BOSS, 'store_manager', undefined, 'all');
        await as(c, '/v1/org/nodes/C-E2E', { kind: 'company', name: 'Synthetic Retail' }, 'org-c');
        await as(c, '/v1/org/nodes/br-1', { kind: 'branch', name: 'Store One', parentId: 'C-E2E', companyId: 'C-E2E' }, 'org-br1');
        await as(c, '/v1/purchase/suppliers/sup-k', { name: 'Kaveri Agro Traders (synthetic)' }, 'sup', SEED_BUYER);
        await as(c, '/v1/purchase/suppliers/sup-k/approval', { reason: 'documents checked' }, 'sup-ok', ACCT);
        const unit = (minor: number) => ({ minor, currency: 'INR' });
        await as(c, '/v1/purchase/orders/po-1', { supplierId: 'sup-k', deliverToLocationId: 'br-1', lines: [
          { productId: 'RICE', orderedQty: 10, unitCost: unit(5_000) }, { productId: 'DAL', orderedQty: 4, unitCost: unit(10_000) }, { productId: 'OIL', orderedQty: 2, unitCost: unit(15_000) },
        ] }, 'po-1', SEED_BUYER);
        await as(c, '/v1/purchase/orders/po-1/approval', { reason: 'weekly order' }, 'po-1-ok');
        // The delivery: one dal short; both oil tins damaged, and a second person sends them back (the debit note).
        await as(c, '/v1/inventory/goods-receipt/grn-1', {
          warehouseId: 'br-1', receivedOnDate: '2026-10-20', currency: 'INR', poId: 'po-1',
          lines: [
            { lineId: 'L1', productId: 'RICE', orderedMinor: 10, countedMinor: 10, uom: 'ea', unitCost: unit(5_000), condition: 'good' },
            { lineId: 'L2', productId: 'DAL', orderedMinor: 4, countedMinor: 3, uom: 'ea', unitCost: unit(10_000), condition: 'good' },
            { lineId: 'L3', productId: 'OIL', orderedMinor: 2, countedMinor: 2, uom: 'ea', unitCost: unit(15_000), condition: 'damaged' },
          ],
        }, 'grn-1', RECV);
        await as(c, '/v1/inventory/goods-receipt/grn-1/lines/L3/disposition', { disposition: 'return', reason: 'tins dented' }, 'disp', BOSS);
        // The accountant's posting rules (the suggested map, which carries the supplier-account rules).
        await as(c, '/v1/finance/posting-map', DEFAULT_RETAIL_POSTING_MAP, 'map', ACCT, 'PUT');
      },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 180_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  const open = async (who: string, path: string) => {
    const context = await browser.newContext();
    await shop.signIn(context, who, who === MGR ? 'br-1' : undefined);
    const page = await context.newPage();
    const writes: string[] = []; const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/v1/') && r.method() !== 'GET') writes.push(`${r.method()} ${u.pathname}`); });
    await page.goto(`${shop.base}${path}`, { waitUntil: 'load' });
    return { page, writes, errors, close: async () => { await page.waitForLoadState('networkidle').catch(() => {}); await context.close(); } };
  };
  const says = async (page: Page, selector: string, expected: RegExp): Promise<void> => {
    try {
      await page.waitForFunction(([sel, source]) => new RegExp(source!).test((globalThis as unknown as { document: { querySelector(x: string): { textContent: string | null } | null } }).document.querySelector(sel!)?.textContent ?? ''), [selector, expected.source], { timeout: 15_000 });
    } catch (e) {
      throw new Error(`${selector} never said ${String(expected)} — it says "${await page.locator(selector).first().textContent().catch(() => '(nothing)')}"`, { cause: e });
    }
  };
  const api = (path: string, userId = OWNER) => shop.cloud().request({ method: 'GET', path, userId });

  it('typed, checked by a second person on the Approvals page, saved as checked, matched, its debit note issued, in the books and in the Tally file (WF-05)', async () => {
    // ── 1. Supplier bills: the scan is handed in and typed; a second person's check is asked ─────────────────────────
    let s = await open(MGR, '/supplier-bills');
    try {
      await s.page.waitForSelector('#chk-section:not([hidden])', { timeout: 15_000 });
      expect(s.writes, 'nothing is written on open').toEqual([]);
      await s.page.setInputFiles('#bill-file', { name: 'KA-7.png', mimeType: 'image/png', buffer: SCAN });
      await s.page.fill('#hand-po', 'po-1');
      await s.page.click('#hand-in');
      await s.page.locator('#type-part').waitFor({ state: 'visible', timeout: 15_000 });
      await s.page.fill('#type-invoice', 'sup-k-KA-7');
      await s.page.fill('#type-supplier', 'sup-k');
      await s.page.fill('#type-po', 'po-1');
      await s.page.fill('#type-total', '1200');
      await s.page.click('#type-add-line');
      await s.page.click('#type-add-line');
      for (const [n, product, qty, price, amount] of [[1, 'RICE', '10', '50', '500'], [2, 'DAL', '4', '100', '400'], [3, 'OIL', '2', '150', '300']] as const) {
        const row = s.page.locator(`#type-lines tr[data-row="${n}"]`);
        await row.locator('.t-productId').fill(product); await row.locator('.t-quantity').fill(qty);
        await row.locator('.t-unitPrice').fill(price); await row.locator('.t-amount').fill(amount);
      }
      await s.page.click('#type-ask');
      await says(s.page, '#type-status', /^Asked\. A second person checks it on their Approvals page/);
      await says(s.page, '#chk-list li[data-check="sup-k-KA-7"]', /Supplier bill sup-k-KA-7 from sup-k: ₹1200\.00 — waiting for the check/);
      expect(s.writes.filter((w) => w === 'POST /v1/approvals/requests')).toHaveLength(1);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
    expect((await api('/v1/purchase/invoices/sup-k-KA-7')).status, 'nothing on the register before the check').toBe(404);

    // ── 2. Approvals: the accountant checks it on his own page ─────────────────────────────────────────────────────
    s = await open(ACCT, '/approvals');
    try {
      const row = s.page.locator('#waiting li', { hasText: 'sup-k-KA-7' });
      await row.waitFor({ timeout: 15_000 });
      await row.locator('input.reason').fill('matches the paper bill');
      await row.locator('button.approve').click();
      await row.waitFor({ state: 'detached', timeout: 15_000 });
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }

    // ── 3. Supplier bills: saved as checked; the match holds back the short dal; the debit note is issued ────────────
    s = await open(MGR, '/supplier-bills');
    try {
      await s.page.waitForSelector('#chk-section:not([hidden])', { timeout: 15_000 });
      await s.page.click('#chk-show');
      const checked = s.page.locator('#chk-list li[data-status="approved"]');
      await checked.waitFor({ timeout: 15_000 });
      expect(await checked.innerText()).toContain(`checked by ${ACCT} — matches the paper bill`);
      await checked.locator('button.chk-save').click();
      await says(s.page, '#chk-status', new RegExp(`^Saved on the register, checked by ${ACCT} — sup-k-KA-7\\.$`));
      await s.page.locator('#register li[data-state="captured"] button[data-act="open"]').click();
      await says(s.page, '#match-invoice', /sup-k-KA-7/);
      await s.page.click('#run-match');
      await says(s.page, '#match-status', /Do not pay this yet/);
      expect(await s.page.locator('#match-lines tr[data-product="DAL"]').getAttribute('data-status')).toBe('blocked');

      await s.page.fill('#dn-supplier', 'sup-k');
      await s.page.click('#dn-show');
      const dn = s.page.locator('#dn-list li[data-debit-note="DN-grn-1-L3"]');
      await dn.waitFor({ timeout: 15_000 });
      expect(await dn.innerText()).toMatch(/DN-grn-1-L3 · OIL × 2 · ₹300\.00 — not issued yet/);
      await dn.locator('button.dn-issue').click();
      await says(s.page, '#dn-status', /^Issued as DN-000001\.$/);
      await says(s.page, '#dn-list li[data-debit-note="DN-grn-1-L3"]', /Issued as DN-000001/);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
    const held = (await api('/v1/purchase/invoices/sup-k-KA-7')).body as { invoice: { approvedBy: string; capturedBy: string; governanceFlags: string[] }; match: { blocked: boolean; payableMinor: number } };
    expect(held.invoice).toMatchObject({ approvedBy: ACCT, capturedBy: MGR });
    expect(held.invoice.governanceFlags).not.toContain('no_approval');
    expect(held.match.blocked).toBe(true);

    // ── 4. Day book: the accountant puts the supplier bills in the books ──────────────────────────────────────────
    s = await open(ACCT, '/day-book');
    let period = '';
    try {
      await s.page.waitForSelector('#ap:not([hidden])', { timeout: 15_000 });
      await s.page.click('#ap-post');
      await says(s.page, '#ap-status', /^Put in the books: .*Bill sup-k-KA-7/);
      await says(s.page, '#ap-status', /Debit note DN-grn-1-L3/);
      await says(s.page, '#ap-suppliers li[data-supplier="sup-k"]', new RegExp(`register ₹${((held.match.payableMinor - 30_000) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 }).replace(/[.,]/g, '\\$&')} · books .* — agrees$`));
      expect(await s.page.locator('#ap-journals li[data-kind="supplier_invoice"]').count()).toBe(1);
      expect(await s.page.locator('#ap-journals li[data-kind="supplier_debit_note"]').count()).toBe(1);
      expect(s.writes).toEqual(['POST /v1/finance/payables/post']);
      expect(s.errors).toEqual([]);
      const journals = ((await api('/v1/finance/payables', ACCT)).body as { journals: { period: string; lines: { accountCode: string }[] }[] }).journals;
      period = journals[0]!.period;
      const codes = [...new Set(journals.flatMap((j) => j.lines.map((l) => l.accountCode)))];
      // The accountant names the Tally ledgers (on the Accounts and Tally names page in the shop; here, his own call).
      await ok(shop.cloud().request({ method: 'POST', path: '/v1/finance/tally/ledger-names', userId: ACCT, idempotencyKey: 'ledger-names', body: { companyName: 'SRE Hyper Market (synthetic)', names: Object.fromEntries(codes.map((c) => [c, `Tally ${c}`])) } }), 'ledger names');
    } finally { await s.close(); }

    // ── 5. Tally files: the month's supplier-bill file ───────────────────────────────────────────────────────────
    s = await open(ACCT, '/tally-files');
    try {
      await s.page.waitForSelector('#tap:not([hidden])', { timeout: 15_000 });
      await s.page.fill('#tap-month', period);
      await s.page.click('#tap-read');
      await says(s.page, '#tap-status', /^Ready to import: 2 voucher\(s\) · .* — Tally's import check accepts it\.$/);
      expect(await s.page.isVisible('#tap-download')).toBe(true);
      expect(await s.page.locator('#tap-rows li[data-voucher]').count()).toBe(2);
      await s.page.click('#lang');
      await says(s.page, '#tap-h', /ஒரு மாதத்தின் சப்ளையர் பில்கள் டேலிக்கு/);
      expect(s.writes, 'reading the file writes nothing').toEqual([]);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
    const file = (await api(`/v1/finance/tally/ap-vouchers?period=${period}`, ACCT)).body as { xml: string; controlTotals: { voucherCount: number; debitMinor: number; creditMinor: number }; complete: boolean };
    expect(file.complete).toBe(true);
    expect(validateTallyImport(file.xml, file.controlTotals).ok).toBe(true);
  }, 240_000);
});
