import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startInboxShop, ok, OWNER, MGR, type InboxShop } from './lib/ai-inbox-shop';
import type { RealCloud } from '../support/real-store';

/**
 * **Supplier bills, in a real browser, on the PRODUCTION API over real PostgreSQL (D03-FR-02 · WF-05 "Capture/OCR/import →
 * validate → PO-GRN-invoice match → discrepancy" · round 12).**
 *
 * The page is served in front of the real API (no stub): who is looking is head office's own `GET /v1/identity/me`; every
 * `/v1` call goes to the API under the signed-in person's token. Through Chromium, as the br-1 store manager (who holds the
 * bill-capture and bill-checking rights):
 *
 *   • nothing is written on open;
 *   • a supplier's GST e-invoice FILE is handed in; head office reads it into a draft, finds the supplier by GSTIN, and the
 *     page shows the lines; the same file again is the same document (head office says so); another file carrying the
 *     same bill number is refused in head office's words;
 *   • confirming with a line left unmapped is refused in head office's words; with every line mapped the bill goes onto the
 *     register; then the three-way match runs and its EXCEPTION is shown (the delivery was one short);
 *   • a SCAN (no OCR engine is connected — an outside party) waits for a person; it is typed from the paper on the page
 *     through head office's typed capture, which NAMES the scan — a total that does not add up is refused in its words, the
 *     right one is kept, and head office itself then lists the scan as captured (typed as that invoice); a second capture
 *     naming the same scan for another invoice is refused by name and nothing of it is kept;
 *   • after a RESTART of the API the register, the confirmed bill and its match, and the scan read as captured with its
 *     invoice, all read back from head office;
 *   • an accountant (bill-checking right, no capture right) is offered nothing and nothing is written; Tamil labels; no page
 *     errors.
 *
 * Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['supplier', 'bills', 'e2e', 'signing', 'key'].join('-').padEnd(48, '0');
const ACCT = 'u-acct-bills';
/** The buyer who set up the supplier and the order (company-wide), so the seed needs no branch on its token. */
const SEED_BUYER = 'u-seed-buyer';
const GSTIN = '33ABCDE1234F1Z5';
const IRN = 'a5c12dca80e743321740b001fd70953e8738d109865d28ba4013750f2046f229';

const eInvoice = (no = 'KA/101', irn = IRN) => ({
  Version: '1.1', Irn: irn,
  TranDtls: { TaxSch: 'GST', SupTyp: 'B2B' },
  DocDtls: { Typ: 'INV', No: no, Dt: '05/10/2026' },
  SellerDtls: { Gstin: GSTIN, LglNm: 'Kaveri Agro Traders (synthetic)', Addr1: 'Synthetic street', Loc: 'Erode', Pin: 638001, Stcd: '33' },
  BuyerDtls: { Gstin: '33ZZZZZ9999Z1Z9', LglNm: 'Synthetic Hyper Market', Pos: '33', Addr1: 'Synthetic road', Loc: 'Erode', Pin: 638001, Stcd: '33' },
  ItemList: [
    { SlNo: '1', PrdDesc: 'Ponni rice 1 kg', IsServc: 'N', HsnCd: '1006', Barcde: 'K-RICE', Qty: 10, Unit: 'NOS', UnitPrice: 50, TotAmt: 500, AssAmt: 500, GstRt: 5, CgstAmt: 12.5, SgstAmt: 12.5, IgstAmt: 0, TotItemVal: 525 },
    { SlNo: '2', PrdDesc: 'Toor dal 500 g', IsServc: 'N', HsnCd: '0713', Barcde: 'K-DAL', Qty: 4, Unit: 'NOS', UnitPrice: 100, TotAmt: 400, AssAmt: 400, GstRt: 5, CgstAmt: 10, SgstAmt: 10, IgstAmt: 0, TotItemVal: 420 },
  ],
  ValDtls: { AssVal: 900, CgstVal: 22.5, SgstVal: 22.5, IgstVal: 0, TotInvVal: 945 },
});
// A synthetic "photo" of a paper bill — a few PNG-signature bytes; no engine reads it (none is connected).
const SCAN = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('synthetic paper bill INV-77', 'utf8')]);

interface Doc { documentId: string; state: string; supplierId: string | null; invoiceId?: string; channel: string }

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('the Supplier bills page on the production API, in a real browser (D03-FR-02 · WF-05)', () => {
  let browser: Browser;
  let shop: InboxShop;

  const asOwner = (c: RealCloud, method: 'POST', path: string, body: unknown, key: string, userId = OWNER) => c.request({ method, path, userId, body, idempotencyKey: key });
  const docsAtHeadOffice = async (): Promise<Doc[]> => ((await shop.cloud().request({ method: 'GET', path: '/v1/purchase/invoice-documents', userId: OWNER })).body as { documents: Doc[] }).documents;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/supplier-bills', html: 'supplier-bills.html', dataGlobal: 'supplierBillsData' },
      seed: async (c) => {
        await c.grant(ACCT, 'accountant', undefined, 'all');
        await c.grant(SEED_BUYER, 'store_manager', undefined, 'all');
        // The shop's places: a company and the br-1 store the order is delivered to.
        await ok(asOwner(c, 'POST', '/v1/org/nodes/C-E2E', { kind: 'company', name: 'Synthetic Retail' }, 'org-c'), 'company');
        await ok(asOwner(c, 'POST', '/v1/org/nodes/br-1', { kind: 'branch', name: 'Store One', parentId: 'C-E2E', companyId: 'C-E2E' }, 'org-br1'), 'store');
        // The supplier with its GSTIN in the master: proposed by the manager, approved by finance (two people).
        await ok(asOwner(c, 'POST', '/v1/purchase/suppliers/sup-k', { name: 'Kaveri Agro Traders (synthetic)', gstin: GSTIN }, 'sup', SEED_BUYER), 'supplier');
        await ok(asOwner(c, 'POST', '/v1/purchase/suppliers/sup-k/approval', { reason: 'documents checked' }, 'sup-ok', ACCT), 'supplier approved');
        // An issued order (10 rice @ ₹50, 4 dal @ ₹100) and a delivery that came ONE DAL SHORT.
        await ok(asOwner(c, 'POST', '/v1/purchase/orders/po-1', { supplierId: 'sup-k', deliverToLocationId: 'br-1', lines: [{ productId: 'RICE', orderedQty: 10, unitCost: { minor: 5_000, currency: 'INR' } }, { productId: 'DAL', orderedQty: 4, unitCost: { minor: 10_000, currency: 'INR' } }] }, 'po-1', SEED_BUYER), 'po');
        await ok(asOwner(c, 'POST', '/v1/purchase/orders/po-1/approval', { reason: 'weekly order' }, 'po-1-ok'), 'po approved');
        await ok(asOwner(c, 'POST', '/v1/inventory/goods-receipt/grn-1', {
          warehouseId: 'br-1', receivedOnDate: '2026-10-05', currency: 'INR', poId: 'po-1',
          lines: [
            { lineId: 'L1', productId: 'RICE', orderedMinor: 10, countedMinor: 10, uom: 'ea', unitCost: { minor: 5_000, currency: 'INR' }, condition: 'good' },
            { lineId: 'L2', productId: 'DAL', orderedMinor: 4, countedMinor: 3, uom: 'ea', unitCost: { minor: 10_000, currency: 'INR' }, condition: 'good' },
          ],
        }, 'grn-1'), 'delivery');
      },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 180_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  const open = async (who: string) => {
    const context = await browser.newContext();
    await shop.signIn(context, who, who === MGR ? 'br-1' : undefined);
    const page = await context.newPage();
    const writes: string[] = []; const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/v1/') && r.method() !== 'GET') writes.push(`${r.method()} ${u.pathname}`); });
    await page.goto(`${shop.base}/supplier-bills`, { waitUntil: 'load' });
    return { page, writes, errors, close: () => context.close() };
  };
  const says = async (page: Page, id: string, expected: RegExp): Promise<void> => {
    try {
      await page.waitForFunction(([i, source]) => new RegExp(source!).test((globalThis as unknown as { document: { getElementById(x: string): { textContent: string | null } | null } }).document.getElementById(i!)?.textContent ?? ''), [id, expected.source], { timeout: 15_000 });
    } catch (e) {
      throw new Error(`#${id} never said ${String(expected)} — it says "${await page.locator(`#${id}`).textContent()}"`, { cause: e });
    }
  };
  const handIn = async (page: Page, name: string, mimeType: string, buffer: Buffer, po = ''): Promise<void> => {
    await page.setInputFiles('#bill-file', { name, mimeType, buffer });
    await page.fill('#hand-po', po);
    await page.click('#hand-in');
  };

  it('the manager hands in an e-invoice, confirms it line by line and checks it against the order; a scan is typed from the paper; all of it survives a restart', async () => {
    let s = await open(MGR);
    try {
      await says(s.page, 'register-status', /No bills handed in yet/);
      await says(s.page, 'engine', /No reading engine connected/);
      expect(s.writes, 'nothing is written on open').toEqual([]);

      // ── The e-invoice file: read into a draft, the supplier found by GSTIN ─────────────────────────────────────────
      const file = Buffer.from(JSON.stringify(eInvoice()), 'utf8');
      await handIn(s.page, 'KA-101.json', 'application/json', file, 'po-1');
      await says(s.page, 'hand-status', /^Handed in — head office read it/);
      await s.page.locator('#draft-lines tr[data-line="2"]').waitFor({ timeout: 15_000 });
      expect(await s.page.locator('#drawer-facts').innerText()).toMatch(/GST e-invoice · supplier sup-k · bill no\. KA\/101 · dated 2026-10-05 · printed total ₹945\.00 · 2 lines/);
      expect(await s.page.locator('#drawer-problems').innerText()).toMatch(/IRP signature is not verified here/);
      // The same file again is the same document — head office says so; nothing new.
      await handIn(s.page, 'KA-101.json', 'application/json', file, 'po-1');
      await says(s.page, 'hand-status', /already handed in — it is the same bill/);
      // Another file carrying the same bill number from the same GSTIN: refused in head office's words.
      await handIn(s.page, 'KA-101-again.json', 'application/json', Buffer.from(JSON.stringify(eInvoice('KA/101', 'another-irn')), 'utf8'));
      await says(s.page, 'hand-status', /^Head office refused: This bill \(another-irn\) was already handed in as document bill-/);

      // ── Confirm: an unmapped line is refused by head office; every line mapped → on the register ──────────────────
      await s.page.locator('#draft-lines tr[data-line="1"] .f-product').fill('RICE');
      await s.page.click('#confirm');
      await says(s.page, 'confirm-status', /^Head office refused: Line\(s\) 2 are not mapped to a product\./);
      expect(((await shop.cloud().request({ method: 'GET', path: '/v1/purchase/invoices', userId: OWNER })).body as { count: number }).count, 'nothing on the register after a refusal').toBe(0);
      await s.page.locator('#draft-lines tr[data-line="2"] .f-product').fill('DAL');
      expect(await s.page.inputValue('#confirm-invoice')).toBe('sup-k-KA-101');
      await s.page.click('#confirm');
      await says(s.page, 'confirm-status', /^Confirmed — the bill is on head office's register as sup-k-KA-101\./);
      await s.page.locator('#register li[data-state="confirmed"]').waitFor({ timeout: 15_000 });

      // ── The three-way match, and its exception: one dal never arrived ───────────────────────────────────────────
      await s.page.click('#run-match');
      await says(s.page, 'match-status', /Do not pay this yet/);
      expect(await s.page.locator('#match-verdict').getAttribute('data-blocked')).toBe('true');
      expect(await s.page.locator('#match-lines tr[data-product="DAL"]').getAttribute('data-status')).toBe('blocked');
      expect(await s.page.locator('#match-lines tr').nth(1).getAttribute('data-product'), 'the exception is listed first').toBe('DAL');
      expect(await s.page.locator('#match-lines tr[data-product="RICE"]').getAttribute('data-status')).toBe('matched');

      // ── A scan: no engine is connected, so a person types it — a wrong total is refused, the right one kept ────────
      await handIn(s.page, 'INV-77.png', 'image/png', SCAN);
      await says(s.page, 'hand-status', /no reading engine is connected, so it waits for a person to type it/);
      await s.page.locator('#type-part').waitFor({ state: 'visible', timeout: 15_000 });
      await s.page.fill('#type-invoice', 'sup-k-INV-77');
      await s.page.fill('#type-supplier', 'sup-k');
      await s.page.fill('#type-total', '600');
      const row = s.page.locator('#type-lines tr[data-row="1"]');
      await row.locator('.t-productId').fill('RICE');
      await row.locator('.t-quantity').fill('10');
      await row.locator('.t-unitPrice').fill('50');
      await row.locator('.t-amount').fill('500');
      await s.page.click('#type-save');
      await says(s.page, 'type-status', /^Head office refused: The lines add up to 50000 and the invoice says 60000\./);
      await s.page.fill('#type-total', '500');
      await s.page.click('#type-save');
      await says(s.page, 'type-status', /^Saved — the bill is on head office's register as sup-k-INV-77\./);
      // Head office linked the scan: the list reads it as captured, typed as this invoice — no memory of this tab's.
      await s.page.locator('#register li[data-state="captured"]').waitFor({ timeout: 15_000 });
      await says(s.page, 'match-invoice', /^Typed onto the register as sup-k-INV-77$/);
      expect(await s.page.locator('#type-part').isHidden(), 'a typed scan is not offered for typing again').toBe(true);
      expect(await s.page.textContent('#match-status'), 'the last bill\'s check is not left on the screen').toBe('');
      await s.page.click('#run-match');
      await s.page.locator('#match-verdict[data-invoice="sup-k-INV-77"]').waitFor({ timeout: 15_000 });
      await says(s.page, 'match-status', /Do not pay this yet/);
      expect(await s.page.locator('#match-verdict').innerText()).toMatch(/Head office also says: no_purchase_order/);
      expect(s.errors).toEqual([]);
      expect(s.writes.filter((w) => w.startsWith('POST /v1/purchase/invoice-documents/') && !w.endsWith('/confirm'))).toHaveLength(4);
    } finally { await s.close(); }

    // ── The same scan named by a capture of ANOTHER invoice: refused by name, nothing of it kept ────────────────────
    const scanId = (await docsAtHeadOffice()).find((d) => d.channel === 'ocr')!.documentId;
    const twice = await shop.cloud().request({
      method: 'POST', path: '/v1/purchase/invoices/sup-k-INV-78/capture', userId: OWNER, idempotencyKey: 'typed-twice',
      body: { supplierId: 'sup-k', declaredTotalMinor: 50_000, lines: [{ productId: 'RICE', quantity: 10, unitPriceMinor: 5_000, lineTotalMinor: 50_000 }], documentId: scanId },
    });
    expect(twice.status).toBe(409);
    expect((twice.body as { error: { code: string; whatHappened: string } }).error).toMatchObject({ code: 'scan_already_typed', whatHappened: `Scan ${scanId} was already typed as invoice sup-k-INV-77. One scan is one bill.` });
    expect((await shop.cloud().request({ method: 'GET', path: '/v1/purchase/invoices/sup-k-INV-78', userId: OWNER })).status).toBe(404);

    // ── Head office's own records — after a RESTART of the API ───────────────────────────────────────────────────
    await shop.restart();
    const docs = await docsAtHeadOffice();
    expect(docs.map((d) => [d.channel, d.state, d.supplierId])).toEqual([['ocr', 'captured', null], ['e_invoice', 'confirmed', 'sup-k']]);
    expect(docs[0]).toMatchObject({ documentId: scanId, invoiceId: 'sup-k-INV-77', typedBy: MGR });
    expect(docs[1]?.invoiceId).toBe('sup-k-KA-101');
    expect(((await shop.cloud().request({ method: 'GET', path: '/v1/purchase/invoice-documents', userId: OWNER })).body as { waiting: number }).waiting).toBe(0);
    const kept = (await shop.cloud().request({ method: 'GET', path: '/v1/purchase/invoices/sup-k-KA-101', userId: OWNER })).body as { invoice: { totalMinor: number; capturedBy: string; poId: string }; match: { blocked: boolean; matchedBy: string } };
    expect(kept.invoice).toMatchObject({ totalMinor: 94_500, capturedBy: MGR, poId: 'po-1' });
    expect(kept.match).toMatchObject({ blocked: true, matchedBy: MGR });
    expect(((await shop.cloud().request({ method: 'GET', path: '/v1/purchase/invoices/sup-k-INV-77', userId: OWNER })).body as { invoice: { totalMinor: number } }).invoice.totalMinor).toBe(50_000);

    s = await open(MGR);
    try {
      await s.page.locator('#register li[data-state="confirmed"] button[data-act="open"]').click();
      await says(s.page, 'match-invoice', /on the register as sup-k-KA-101/);
      await s.page.locator('#match-verdict[data-blocked="true"]').waitFor({ timeout: 15_000 });
      expect(await s.page.locator('#match-lines tr[data-product="DAL"]').getAttribute('data-status')).toBe('blocked');
      // The typed scan, after the restart: captured, as its invoice — read from head office, not remembered by a tab.
      await s.page.locator('#register li[data-state="captured"] button[data-act="open"]').click();
      await says(s.page, 'match-invoice', /^Typed onto the register as sup-k-INV-77$/);
      expect(await s.page.locator('#drawer-facts').innerText()).toMatch(/typed by /);
      expect(await s.page.locator('#type-part').isHidden()).toBe(true);
      expect(s.writes, 'reading back writes nothing').toEqual([]);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
  }, 180_000);

  it('an accountant (no capture right) is offered nothing and writes nothing — and, with the bill-matching right (OB-543/OB-547/OB-548), is not refused on open: the page says what the role does here and asks head office only what it may read; the page speaks Tamil', async () => {
    const s = await open(ACCT);
    const reads: string[] = []; const refusals: string[] = [];
    s.page.on('response', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/v1/')) { reads.push(`${r.request().method()} ${u.pathname}`); if (r.status() === 401 || r.status() === 403) refusals.push(`${r.status()} ${u.pathname}`); } });
    try {
      await s.page.reload({ waitUntil: 'load' });
      // Round 1 (screen audit B): the menu offers this page to the accountant for "Deliveries waiting for their bill"; the page
      // no longer opens on head office refusing a capture read the role was never given.
      await says(s.page, 'register-status', /^Your role matches supplier bills to deliveries/);
      expect(await s.page.getAttribute('#register-status', 'class')).not.toContain('err');
      await says(s.page, 'cnk-status', /\S/);
      expect(await s.page.textContent('#cnk-status')).not.toMatch(/refused|needs the bill-checking right/);
      expect(reads).toContain('GET /v1/inventory/receipts-cost-not-known');
      expect(reads).not.toContain('GET /v1/purchase/invoice-documents');
      expect(refusals).toEqual([]);
      expect(await s.page.locator('#hand-section').isHidden()).toBe(true);
      expect(await s.page.locator('#register li').count()).toBe(0);
      await s.page.click('#lang');
      expect(await s.page.locator('#title').innerText()).toBe('சப்ளையர் பில்கள்');
      expect(await s.page.locator('#register-h').innerText()).toBe('கொடுக்கப்பட்ட பில்கள்');
      expect(s.writes).toEqual([]);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
  }, 60_000);
});
