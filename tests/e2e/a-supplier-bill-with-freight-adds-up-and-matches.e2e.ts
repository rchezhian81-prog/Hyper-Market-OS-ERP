import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startInboxShop, ok, OWNER, MGR, type InboxShop } from './lib/ai-inbox-shop';
import type { RealCloud } from '../support/real-store';

/**
 * **A supplier bill with freight adds up and matches — in a real browser, on the PRODUCTION API over real PostgreSQL
 * (M07-FR-04 "PO-GRN-invoice matching, landed cost" · re-audit 30 Oct 2026, lane 1).**
 *
 * Before: the Supplier bills page could not enter freight, duty or other charges, and head office's e-invoice reader
 * ignored the e-invoice's other charges (`ValDtls.OthChrg`), so a bill carrying freight was refused as "does not add up".
 * Now, through Chromium, as the br-1 store manager:
 *
 *   • a GST e-invoice whose printed total includes ₹60 of other charges is handed in; the page shows the charges head
 *     office read; it confirms (no "accept the difference" box ticked) and the match AGREES — the whole ₹1,005 may be paid,
 *     the charges said on the verdict;
 *   • a paper bill (a scan; no reading engine is connected) is typed with its real printed total: without the freight it is
 *     refused in head office's words; with ₹45.50 typed as freight it is saved, and its match agrees too;
 *   • head office's own records carry the charges on each bill (read back from the API, not from the page).
 *
 * Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['freight', 'bills', 'e2e', 'signing', 'key'].join('-').padEnd(48, '0');
const ACCT = 'u-acct-freight';
const SEED_BUYER = 'u-seed-buyer';
const GSTIN = '33ABCDE1234F1Z5';

const eInvoice = () => ({
  Version: '1.1', Irn: 'f00dfeed80e743321740b001fd70953e8738d109865d28ba4013750f2046f229',
  TranDtls: { TaxSch: 'GST', SupTyp: 'B2B' },
  DocDtls: { Typ: 'INV', No: 'KA/201', Dt: '06/10/2026' },
  SellerDtls: { Gstin: GSTIN, LglNm: 'Kaveri Agro Traders (synthetic)', Addr1: 'Synthetic street', Loc: 'Erode', Pin: 638001, Stcd: '33' },
  BuyerDtls: { Gstin: '33ZZZZZ9999Z1Z9', LglNm: 'Synthetic Hyper Market', Pos: '33', Addr1: 'Synthetic road', Loc: 'Erode', Pin: 638001, Stcd: '33' },
  ItemList: [
    { SlNo: '1', PrdDesc: 'Ponni rice 1 kg', IsServc: 'N', HsnCd: '1006', Barcde: 'K-RICE', Qty: 10, Unit: 'NOS', UnitPrice: 50, TotAmt: 500, AssAmt: 500, GstRt: 5, CgstAmt: 12.5, SgstAmt: 12.5, IgstAmt: 0, TotItemVal: 525 },
    { SlNo: '2', PrdDesc: 'Toor dal 500 g', IsServc: 'N', HsnCd: '0713', Barcde: 'K-DAL', Qty: 4, Unit: 'NOS', UnitPrice: 100, TotAmt: 400, AssAmt: 400, GstRt: 5, CgstAmt: 10, SgstAmt: 10, IgstAmt: 0, TotItemVal: 420 },
  ],
  // ₹900 taxable + ₹45 GST + ₹60 other charges (freight) = ₹1,005.
  ValDtls: { AssVal: 900, CgstVal: 22.5, SgstVal: 22.5, IgstVal: 0, OthChrg: 60, TotInvVal: 1005 },
});
const SCAN = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('synthetic paper bill INV-90 with freight', 'utf8')]);

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('a supplier bill with freight adds up and matches on the Supplier bills page (M07-FR-04)', () => {
  let browser: Browser;
  let shop: InboxShop;
  const as = (c: RealCloud, path: string, body: unknown, key: string, userId = OWNER) => c.request({ method: 'POST', path, userId, body, idempotencyKey: key });
  const order = async (c: RealCloud, po: string, grn: string): Promise<void> => {
    await ok(as(c, `/v1/purchase/orders/${po}`, { supplierId: 'sup-k', deliverToLocationId: 'br-1', lines: [{ productId: 'RICE', orderedQty: 10, unitCost: { minor: 5_000, currency: 'INR' } }, { productId: 'DAL', orderedQty: 4, unitCost: { minor: 10_000, currency: 'INR' } }] }, po, SEED_BUYER), po);
    await ok(as(c, `/v1/purchase/orders/${po}/approval`, { reason: 'weekly order' }, `${po}-ok`), `${po} approved`);
    // The whole order arrived — so the match can agree.
    await ok(as(c, `/v1/inventory/goods-receipt/${grn}`, {
      warehouseId: 'br-1', receivedOnDate: '2026-10-06', currency: 'INR', poId: po,
      lines: [
        { lineId: 'L1', productId: 'RICE', orderedMinor: 10, countedMinor: 10, uom: 'ea', unitCost: { minor: 5_000, currency: 'INR' }, condition: 'good' },
        { lineId: 'L2', productId: 'DAL', orderedMinor: 4, countedMinor: 4, uom: 'ea', unitCost: { minor: 10_000, currency: 'INR' }, condition: 'good' },
      ],
    }, grn), `${grn} delivered`);
  };

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/supplier-bills', html: 'supplier-bills.html', dataGlobal: 'supplierBillsData' },
      seed: async (c) => {
        await c.grant(ACCT, 'accountant', undefined, 'all');
        await c.grant(SEED_BUYER, 'store_manager', undefined, 'all');
        await ok(as(c, '/v1/org/nodes/C-E2E', { kind: 'company', name: 'Synthetic Retail' }, 'org-c'), 'company');
        await ok(as(c, '/v1/org/nodes/br-1', { kind: 'branch', name: 'Store One', parentId: 'C-E2E', companyId: 'C-E2E' }, 'org-br1'), 'store');
        await ok(as(c, '/v1/purchase/suppliers/sup-k', { name: 'Kaveri Agro Traders (synthetic)', gstin: GSTIN }, 'sup', SEED_BUYER), 'supplier');
        await ok(as(c, '/v1/purchase/suppliers/sup-k/approval', { reason: 'documents checked' }, 'sup-ok', ACCT), 'supplier approved');
        await order(c, 'po-1', 'grn-1');
        await order(c, 'po-2', 'grn-2');
      },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 180_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  const says = async (page: Page, id: string, expected: RegExp): Promise<void> => {
    try {
      await page.waitForFunction(([i, source]) => new RegExp(source!).test((globalThis as unknown as { document: { getElementById(x: string): { textContent: string | null } | null } }).document.getElementById(i!)?.textContent ?? ''), [id, expected.source], { timeout: 15_000 });
    } catch (e) {
      throw new Error(`#${id} never said ${String(expected)} — it says "${await page.locator(`#${id}`).textContent()}"`, { cause: e });
    }
  };
  const handIn = async (page: Page, name: string, mimeType: string, buffer: Buffer, po: string): Promise<void> => {
    await page.setInputFiles('#bill-file', { name, mimeType, buffer });
    await page.fill('#hand-po', po);
    await page.click('#hand-in');
  };

  it('an e-invoice with other charges and a typed bill with freight both add up, go on the register and match', async () => {
    const context = await browser.newContext();
    await shop.signIn(context, MGR, 'br-1');
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    try {
      await page.goto(`${shop.base}/supplier-bills`, { waitUntil: 'load' });
      await says(page, 'register-status', /No bills handed in yet/);

      // ── The e-invoice: head office reads its other charges; it confirms with no difference to accept ──────────────
      await handIn(page, 'KA-201.json', 'application/json', Buffer.from(JSON.stringify(eInvoice()), 'utf8'), 'po-1');
      await says(page, 'hand-status', /^Handed in — head office read it/);
      await page.locator('#draft-lines tr[data-line="2"]').waitFor({ timeout: 15_000 });
      expect(await page.locator('#drawer-facts').innerText()).toMatch(/printed total ₹1,005\.00 · other charges ₹60\.00 · 2 lines/);
      await page.locator('#draft-lines tr[data-line="1"] .f-product').fill('RICE');
      await page.locator('#draft-lines tr[data-line="2"] .f-product').fill('DAL');
      expect(await page.isChecked('#confirm-accept'), 'no difference is accepted — the bill adds up').toBe(false);
      await page.click('#confirm');
      await says(page, 'confirm-status', /^Confirmed — the bill is on head office's register as sup-k-KA-201\./);
      await page.click('#run-match');
      await says(page, 'match-status', /These agree — the bill may be paid/);
      expect(await page.locator('#match-verdict').getAttribute('data-blocked')).toBe('false');
      expect(await page.locator('#match-verdict').innerText()).toMatch(/May be paid: ₹1,005\.00 · Billed: ₹1,005\.00 · Freight and other charges: ₹60\.00/);

      // ── A paper bill typed with freight ───────────────────────────────────────────────────────────────────────
      await handIn(page, 'INV-90.png', 'image/png', SCAN, 'po-2');
      await says(page, 'hand-status', /no reading engine is connected/);
      await page.locator('#type-part').waitFor({ state: 'visible', timeout: 15_000 });
      await page.fill('#type-invoice', 'sup-k-INV-90');
      await page.fill('#type-supplier', 'sup-k');
      await page.fill('#type-total', '945.50');
      const typeLine = async (row: number, product: string, qty: string, price: string, amount: string): Promise<void> => {
        const r = page.locator(`#type-lines tr[data-row="${row}"]`);
        await r.locator('.t-productId').fill(product); await r.locator('.t-quantity').fill(qty);
        await r.locator('.t-unitPrice').fill(price); await r.locator('.t-amount').fill(amount);
      };
      await typeLine(1, 'RICE', '10', '50', '500');
      await page.click('#type-add-line');
      await typeLine(2, 'DAL', '4', '100', '400');
      // Without the freight the printed total does not add up — head office refuses, in its words; nothing kept.
      await page.click('#type-save');
      await says(page, 'type-status', /^Head office refused: The lines add up to 90000 and the invoice says 94550\./);
      await page.fill('#type-freight', 'twelve');
      await page.click('#type-save');
      await says(page, 'type-status', /^Freight, duty or other charges is not an amount of money/);
      await page.fill('#type-freight', '45.50');
      await page.click('#type-save');
      await says(page, 'type-status', /^Saved — the bill is on head office's register as sup-k-INV-90\./);
      await page.locator('#register li[data-state="captured"]').waitFor({ timeout: 15_000 });
      await page.click('#run-match');
      await page.locator('#match-verdict[data-invoice="sup-k-INV-90"]').waitFor({ timeout: 15_000 });
      await says(page, 'match-status', /These agree — the bill may be paid/);
      expect(await page.locator('#match-verdict').innerText()).toMatch(/May be paid: ₹945\.50 · Billed: ₹945\.50 · Freight and other charges: ₹45\.50/);

      // The words have Tamil twins.
      await page.click('#lang');
      expect(await page.locator('#l-type-freight').innerText()).toBe('பில்லில் சரக்குக் கட்டணம் (₹)');
      expect(errors).toEqual([]);
    } finally { await context.close(); }

    // ── Head office's own records carry the charges ──────────────────────────────────────────────────────────────
    const read = async (id: string) => (await shop.cloud().request({ method: 'GET', path: `/v1/purchase/invoices/${id}`, userId: OWNER })).body as { invoice: { totalMinor: number; landedCharges?: unknown }; match: { blocked: boolean; payableMinor: number } };
    expect(await read('sup-k-KA-201')).toMatchObject({ invoice: { totalMinor: 100_500, landedCharges: { freightMinor: 0, dutyMinor: 0, otherMinor: 6_000 } }, match: { blocked: false, payableMinor: 100_500 } });
    expect(await read('sup-k-INV-90')).toMatchObject({ invoice: { totalMinor: 94_550, landedCharges: { freightMinor: 4_550, dutyMinor: 0, otherMinor: 0 } }, match: { blocked: false, payableMinor: 94_550 } });
  }, 180_000);
});
