import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startInboxShop, ok, OWNER, MGR, type InboxShop } from './lib/ai-inbox-shop';
import { DEFAULT_RETAIL_POSTING_MAP } from '../../packages/finance/src/index';
import type { RealCloud } from '../support/real-store';

/**
 * **OB-866 B (owner, 19 Nov 2026) — a supplier bill's "Round off" line, typed from the paper, in a real browser, on the
 * PRODUCTION API over real PostgreSQL (M07-FR-04 · WF-05 · pilot audit B-10).** Synthetic data only.
 *
 *   1. SUPPLIER BILLS — the br-1 store manager types a paper bill ending "Round off −0.40": ₹1.50 is refused in plain words,
 *      a word is refused before anything is sent, "−0.40" saves; the match agrees and says the round off.
 *   2. DAY BOOK — the accountant puts supplier bills in the books: the bill's entry WAITS, said "Accounting entry waiting —
 *      the accountant has not named the Purchase round-off account"; nothing of it is in the books.
 *   3. ACCOUNTS AND TALLY NAMES — the supplier-bill rule offers the two round-off figures blank; the accountant names his own
 *      account and saves the map.
 *   4. DAY BOOK — put in the books again: the bill posts, the round off on its own account; nothing waits.
 * Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['round', 'off', 'e2e', 'signing', 'key'].join('-').padEnd(48, '0');
const ACCT = 'u-acct-roundoff';
const SEED_BUYER = 'u-seed-buyer';
const SHOTS = process.env['B19_SHOTS'];

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('OB-866 B — a supplier bill\'s round off is typed, matched, and waits for the accountant\'s account', () => {
  let browser: Browser;
  let shop: InboxShop;
  const as = (c: RealCloud, path: string, body: unknown, key: string, userId = OWNER, method: 'POST' | 'PUT' = 'POST') => ok(c.request({ method, path, userId, body, idempotencyKey: key }), path);

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    if (SHOTS !== undefined) mkdirSync(SHOTS, { recursive: true });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/supplier-bills', html: 'supplier-bills.html', dataGlobal: 'supplierBillsData' },
      alsoPages: [
        { path: '/day-book', html: 'day-book.html', dataGlobal: 'dayBookData' },
        { path: '/posting-map', html: 'posting-map.html', dataGlobal: 'postingMapData' },
      ],
      seed: async (c) => {
        await c.grant(ACCT, 'accountant', undefined, 'all');
        await c.grant(SEED_BUYER, 'store_manager', undefined, 'all');
        await as(c, '/v1/org/nodes/C-E2E', { kind: 'company', name: 'Synthetic Retail' }, 'org-c');
        await as(c, '/v1/org/nodes/br-1', { kind: 'branch', name: 'Store One', parentId: 'C-E2E', companyId: 'C-E2E' }, 'org-br1');
        await as(c, '/v1/purchase/suppliers/sup-k', { name: 'Kaveri Agro Traders (synthetic)' }, 'sup', SEED_BUYER);
        await as(c, '/v1/purchase/suppliers/sup-k/approval', { reason: 'documents checked' }, 'sup-ok', ACCT);
        const unit = (minor: number) => ({ minor, currency: 'INR' });
        await as(c, '/v1/purchase/orders/po-1', { supplierId: 'sup-k', deliverToLocationId: 'br-1', lines: [{ productId: 'RICE', orderedQty: 10, unitCost: unit(5_000) }] }, 'po-1', SEED_BUYER);
        await as(c, '/v1/purchase/orders/po-1/approval', { reason: 'weekly order' }, 'po-1-ok');
        await as(c, '/v1/inventory/goods-receipt/grn-1', {
          warehouseId: 'br-1', receivedOnDate: '2026-11-18', currency: 'INR', poId: 'po-1',
          lines: [{ lineId: 'L1', productId: 'RICE', orderedMinor: 10, countedMinor: 10, uom: 'ea', unitCost: unit(5_000), condition: 'good' }],
        }, 'grn-1');
        // OB-879: ₹300 of shelf oil sent back to the supplier — its debit note waits for the supplier to accept.
        await as(c, '/v1/inventory/movements', { movementId: 'rx-oil', productId: 'OIL', locationId: 'br-1', kind: 'received', quantityMinor: 20, uom: 'ea', occurredAt: '2026-11-01T09:00:00.000Z', enteredBy: OWNER, unitCostMinor: 15_000 }, 'rx-oil');
        await as(c, '/v1/inventory/shelf-returns/rts-a', { productId: 'OIL', locationId: 'br-1', qty: 2, uom: 'ea', supplierId: 'sup-k', reason: 'expired' }, 'rts-a');
        // The accountant's posting rules as suggested — which name NO purchase round-off account.
        await as(c, '/v1/finance/posting-map', DEFAULT_RETAIL_POSTING_MAP, 'map', ACCT, 'PUT');
      },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 180_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  const open = async (who: string, path: string) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
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
  const shot = async (page: Page, name: string) => { if (SHOTS !== undefined) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }); };
  const api = (path: string, userId = OWNER) => shop.cloud().request({ method: 'GET', path, userId });

  it('typed "Round off −0.40", matched, waits in the Day book, the accountant names the account, then it posts', async () => {
    // ── 1. Supplier bills: the paper bill is typed with its round off ────────────────────────────────────────────
    let s = await open(MGR, '/supplier-bills');
    try {
      await s.page.waitForFunction('globalThis.sreOffice !== undefined');
      await s.page.click('#type-paper');
      await s.page.locator('#type-part').waitFor({ state: 'visible', timeout: 15_000 });
      await s.page.fill('#type-invoice', 'sup-k-RO-1');
      await s.page.fill('#type-supplier', 'sup-k');
      await s.page.fill('#type-po', 'po-1');
      await s.page.click('#type-from-order');
      await says(s.page, '#type-status', /^Filled 1 line\(s\) from order po-1/);
      await s.page.fill('#type-total', '499.60');
      expect(await s.page.locator('#l-type-round-off').innerText()).toBe('Round off on the bill (₹, for example −0.40)');
      // More than a rupee: head office refuses, in plain words; nothing kept.
      await s.page.fill('#type-round-off', '-1.50');
      await s.page.click('#type-save');
      await says(s.page, '#type-status', /^Head office refused: The round off typed is −₹1\.50\. A round off is at most one rupee either way/);
      // Not money: said before anything is sent.
      const before = s.writes.length;
      await s.page.fill('#type-round-off', 'forty paise');
      await s.page.click('#type-save');
      await says(s.page, '#type-status', /^The round off is not an amount of money/);
      expect(s.writes.length, 'nothing sent for a round off that is not money').toBe(before);
      await s.page.fill('#type-round-off', '−0.40');
      await shot(s.page, '1-typed-with-round-off');
      await s.page.click('#type-save');
      await says(s.page, '#type-status', /^Saved — the bill is on head office's register as sup-k-RO-1\.$/);
      await s.page.click('#run-match');
      await s.page.locator('#match-verdict[data-invoice="sup-k-RO-1"]').waitFor({ timeout: 15_000 });
      await says(s.page, '#match-status', /These agree — the bill may be paid/);
      expect(await s.page.locator('#match-verdict').innerText()).toMatch(/May be paid: ₹499\.60 · Billed: ₹499\.60 · Round off: −₹0\.40/);
      await shot(s.page, '2-matched-with-round-off');
      await s.page.click('#lang');
      expect(await s.page.locator('#l-type-round-off').innerText()).toBe('பில்லில் முழுமையாக்கல் (₹, உதாரணமாக −0.40)');
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
    const kept = (await api('/v1/purchase/invoices/sup-k-RO-1')).body as { invoice: { totalMinor: number; roundOffMinor: number }; match: { payableMinor: number; roundOffMinor: number } };
    expect(kept).toMatchObject({ invoice: { totalMinor: 49_960, roundOffMinor: -40 }, match: { payableMinor: 49_960, roundOffMinor: -40 } });

    // ── 2. Day book: the bill's accounting entry waits, said in plain words ─────────────────────────────────────
    s = await open(ACCT, '/day-book');
    try {
      await s.page.waitForSelector('#ap:not([hidden])', { timeout: 15_000 });
      await s.page.click('#ap-post');
      await says(s.page, '#ap-status', /^Nothing new to put in the books\.$/);
      const waiting = s.page.locator('#ap-exceptions li[data-reason="purchase_round_off_not_named"]');
      await waiting.waitFor({ timeout: 15_000 });
      expect(await waiting.innerText()).toMatch(/^⚠ Bill · Accounting entry waiting — the accountant has not named the Purchase round-off account — Bill sup-k-RO-1 \(supplier sup-k\) has a round off of −₹0\.40/);
      await says(s.page, '#ap-suppliers li[data-supplier="sup-k"]', /register ₹499\.60 · books ₹0\.00 — does not agree$/);
      expect(await s.page.locator('#ap-journals li[data-kind]').count(), 'nothing of it is in the books').toBe(0);
      await shot(s.page, '3-day-book-waiting');
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }

    // ── 3. Accounts and Tally names: the accountant names the Purchase round-off account ────────────────────────
    s = await open(ACCT, '/posting-map');
    try {
      const row = '#kind-rows tr[data-key="supplier_invoice"]';
      await s.page.fill('#kinds-search', 'matched supplier bill');
      await s.page.locator(row).waitFor({ timeout: 15_000 });
      await s.page.click(`${row} .sre-row-open`);
      const legs = s.page.locator('#legs-form input');
      await legs.first().waitFor({ timeout: 15_000 });
      expect(await legs.count()).toBe(7);
      expect([await s.page.inputValue('#leg-5'), await s.page.inputValue('#leg-6')], 'no account is filled in for him').toEqual(['', '']);
      expect(await s.page.locator('#legs-form').innerText()).toContain('Purchase round off — bill rounded down');
      expect(await s.page.locator('#legs-form').innerText()).toContain('Not named yet — supplier bills with a round off wait until you name this account.');
      await shot(s.page, '4-posting-map-round-off-blank');
      await s.page.fill('#leg-5', 'Purchase round off');
      await s.page.fill('#leg-6', 'Purchase round off');
      await s.page.click('#keep-legs');
      await s.page.fill('#map-note', 'OB-866 B: the purchase round-off account');
      await s.page.click('#save-map');
      await says(s.page, '#map-status', /^Saved as version 2\.$/);
      expect(s.writes).toEqual(['PUT /v1/finance/posting-map']);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }

    // ── 4. Day book: the waiting bill posts, its round off on its own account ──────────────────────────────────
    s = await open(ACCT, '/day-book');
    try {
      await s.page.waitForSelector('#ap:not([hidden])', { timeout: 15_000 });
      await s.page.click('#ap-post');
      await says(s.page, '#ap-status', /^Put in the books: Bill sup-k-RO-1$/);
      await says(s.page, '#ap-journals li[data-kind="supplier_invoice"]', /purchases_grni Debit ₹500\.00 · supplier_payable Credit ₹499\.60 · Purchase round off Credit ₹0\.40/);
      await says(s.page, '#ap-suppliers li[data-supplier="sup-k"]', /register ₹499\.60 · books ₹499\.60 — agrees$/);
      expect(await s.page.locator('#ap-exceptions li[data-reason]').count(), 'nothing waits any more').toBe(0);
      await shot(s.page, '5-day-book-posted');
      // Pressed again: nothing posts twice.
      await s.page.click('#ap-post');
      await says(s.page, '#ap-status', /^Nothing new to put in the books\.$/);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
    const books = (await api('/v1/finance/payables', ACCT)).body as { journals: { sourceId: string }[] };
    expect(books.journals.filter((j) => j.sourceId === 'sup-k-RO-1')).toHaveLength(1);
  }, 240_000);

  it('OB-879: the accountant records "Supplier accepted" on a shelf-return debit note, and only then is it taken off what is owed', async () => {
    const s = await open(ACCT, '/supplier-bills');
    try {
      await s.page.waitForSelector('#dn-part:not([hidden])', { timeout: 15_000 });
      await s.page.fill('#dn-supplier', 'sup-k');
      await s.page.click('#dn-show');
      const row = s.page.locator('#dn-shelf li[data-shelf-note="DN-RTS-rts-a"]');
      await row.waitFor({ timeout: 15_000 });
      expect(await row.getAttribute('data-state')).toBe('waiting_for_supplier');
      await says(s.page, '#dn-shelf li[data-shelf-note="DN-RTS-rts-a"] .shelf-head', /^SDN\/\d\d-\d\d\/\d{5} \(RTS1\/\d\d-\d\d\/00001\) · OIL × 2 · ₹300\.00 — waiting for the supplier to accept — not taken off what is owed yet$/);
      const owedBefore = await s.page.locator('#dn-owed').innerText();
      await row.locator('button.shelf-accept').click();
      await says(s.page, '#dn-status', /^Type the supplier's credit-note number and its date first\.$/);
      await row.locator('input.shelf-cn').fill('KA-CN-12');
      await row.locator('input.shelf-date').fill('2026-11-18');
      await row.locator('input.shelf-amount').fill('250');
      await row.locator('button.shelf-accept').click();
      await says(s.page, '#dn-status', /^Head office refused: The supplier accepted ₹250\.00 of ₹300\.00\. Say why/);
      await row.locator('input.shelf-reason').fill('one tin past the date he takes back');
      // OB-881 B: the credit note's GST is optional; a minus figure is refused by head office in plain words.
      await row.locator('input.shelf-cgst').fill('-6.25');
      await row.locator('button.shelf-accept').click();
      await says(s.page, '#dn-status', /^Head office refused: The GST on a credit note cannot be below nothing\. Type it as the credit note shows it, without a minus sign\./);
      await row.locator('input.shelf-cgst').fill('');
      await shot(s.page, '6-supplier-accepted-typed');
      await row.locator('button.shelf-accept').click();
      await says(s.page, '#dn-status', /^Recorded — taken off what is owed: ₹250\.00\.$/);
      await says(s.page, '#dn-shelf li[data-shelf-note="DN-RTS-rts-a"] .shelf-head', /accepted by the supplier as credit note KA-CN-12 · 2026-11-18 · ₹250\.00 taken off what is owed$/);
      await says(s.page, '#dn-shelf li[data-shelf-note="DN-RTS-rts-a"] .shelf-diff', /^₹50\.00 not accepted by the supplier — one tin past the date he takes back$/);
      expect(await s.page.locator('#dn-owed').innerText()).not.toBe(owedBefore);
      expect(await s.page.locator('#dn-shelf button.shelf-accept').count(), 'an accepted note offers no second acceptance').toBe(0);
      await shot(s.page, '7-supplier-accepted');
      expect(s.writes).toEqual(Array(3).fill('POST /v1/purchase/suppliers/sup-k/shelf-return-debit-notes/DN-RTS-rts-a/accept'));
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
  }, 120_000);
});
