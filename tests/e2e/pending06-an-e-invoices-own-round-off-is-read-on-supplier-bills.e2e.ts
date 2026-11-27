import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startInboxShop, ok, OWNER, MGR, type InboxShop } from './lib/ai-inbox-shop';
import type { RealCloud } from '../support/real-store';

/**
 * **Pending list 27 Nov 2026 — item 6: a GST e-invoice's own round off (`ValDtls.RndOffAmt`) — in a real browser, on the
 * PRODUCTION API over real PostgreSQL (OB-866 B · M07-FR-04 · WF-05).**
 *
 * Before: an e-invoice ending "Round off −0.40" was refused as "does not add up" and needed "accept the difference".
 * Now, through Chromium, as the br-1 store manager:
 *   • the e-invoice is handed in; the page shows the round off head office read beside the printed total;
 *   • it confirms with NO difference accepted, and the check against the order AGREES — "Round off: −₹0.40" on the verdict;
 *   • an e-invoice whose round off is −₹1.40 (more than a rupee) is said on its draft; confirming it without accepting the
 *     difference is refused in head office's words, as before;
 *   • head office's own record carries the round off (read back from the API, not from the page); Tamil words are there.
 *
 * Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS. Synthetic data only.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['round', 'off', 'einv', 'e2e', 'signing', 'key'].join('-').padEnd(48, '0');
const ACCT = 'u-acct-roundoff';
const SEED_BUYER = 'u-seed-buyer';
const GSTIN = '33ABCDE1234F1Z5';
const SHOTS = process.env['PENDING06_SHOTS'];

// 10 rice at ₹50.80 = ₹508.00 + CGST ₹12.70 + SGST ₹12.70 = ₹533.40, printed as ₹533.00 after its round off.
const eInvoice = (no: string, irn: string, val: Record<string, unknown>) => ({
  Version: '1.1', Irn: irn,
  TranDtls: { TaxSch: 'GST', SupTyp: 'B2B' },
  DocDtls: { Typ: 'INV', No: no, Dt: '06/10/2026' },
  SellerDtls: { Gstin: GSTIN, LglNm: 'Kaveri Agro Traders (synthetic)', Addr1: 'Synthetic street', Loc: 'Erode', Pin: 638001, Stcd: '33' },
  BuyerDtls: { Gstin: '33ZZZZZ9999Z1Z9', LglNm: 'Synthetic Hyper Market', Pos: '33', Addr1: 'Synthetic road', Loc: 'Erode', Pin: 638001, Stcd: '33' },
  ItemList: [{ SlNo: '1', PrdDesc: 'Ponni rice 1 kg', IsServc: 'N', HsnCd: '1006', Barcde: 'K-RICE', Qty: 10, Unit: 'NOS', UnitPrice: 50.8, TotAmt: 508, AssAmt: 508, GstRt: 5, CgstAmt: 12.7, SgstAmt: 12.7, IgstAmt: 0, TotItemVal: 533.4 }],
  ValDtls: { AssVal: 508, CgstVal: 12.7, SgstVal: 12.7, IgstVal: 0, ...val },
});

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('an e-invoice\'s own round off is read on the Supplier bills page (pending item 6 · OB-866 B)', () => {
  let browser: Browser;
  let shop: InboxShop;
  const as = (c: RealCloud, path: string, body: unknown, key: string, userId = OWNER) => c.request({ method: 'POST', path, userId, body, idempotencyKey: key });
  const order = async (c: RealCloud, po: string, grn: string): Promise<void> => {
    await ok(as(c, `/v1/purchase/orders/${po}`, { supplierId: 'sup-k', deliverToLocationId: 'br-1', lines: [{ productId: 'RICE', orderedQty: 10, unitCost: { minor: 5_080, currency: 'INR' } }] }, po, SEED_BUYER), po);
    await ok(as(c, `/v1/purchase/orders/${po}/approval`, { reason: 'weekly order' }, `${po}-ok`), `${po} approved`);
    await ok(as(c, `/v1/inventory/goods-receipt/${grn}`, {
      warehouseId: 'br-1', receivedOnDate: '2026-10-06', currency: 'INR', poId: po,
      lines: [{ lineId: 'L1', productId: 'RICE', orderedMinor: 10, countedMinor: 10, uom: 'ea', unitCost: { minor: 5_080, currency: 'INR' }, condition: 'good' }],
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
  const handIn = async (page: Page, name: string, bill: unknown, po: string): Promise<void> => {
    await page.setInputFiles('#bill-file', { name, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(bill), 'utf8') });
    await page.fill('#hand-po', po);
    await page.click('#hand-in');
  };
  const shot = async (page: Page, name: string): Promise<void> => { if (SHOTS !== undefined) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }); };

  it('an e-invoice ending "Round off −0.40" confirms with no difference to accept and matches; −1.40 is a difference to decide', async () => {
    const context = await browser.newContext({ deviceScaleFactor: 1 });
    await shop.signIn(context, MGR, 'br-1');
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    try {
      await page.goto(`${shop.base}/supplier-bills`, { waitUntil: 'load' });
      await says(page, 'register-status', /No bills handed in yet/);

      // ── "Round off −0.40": read and said; confirmed with no difference accepted; the check agrees ─────────────────
      await handIn(page, 'KA-301.json', eInvoice('KA/301', 'c0ffee0080e743321740b001fd70953e8738d109865d28ba4013750f2046f229', { RndOffAmt: -0.4, TotInvVal: 533 }), 'po-1');
      await says(page, 'hand-status', /^Handed in — head office read it/);
      await page.locator('#draft-lines tr[data-line="1"]').waitFor({ timeout: 15_000 });
      expect(await page.locator('#drawer-facts').innerText()).toMatch(/printed total ₹533\.00 · Round off −₹0\.40 · 1 lines/);
      // D-150: the line head office read shows its figures (before, the list printed "Not known" for each of them).
      const row = await page.locator('#draft-lines tr[data-line="1"]').innerText();
      expect(row).toMatch(/10[\s\S]*₹50\.80[\s\S]*₹508\.00[\s\S]*₹25\.40/);
      expect(row).not.toMatch(/Not known/);
      await shot(page, 'pending06-einvoice-round-off-read-en');
      await page.locator('#draft-lines tr[data-line="1"] .f-product').fill('RICE');
      expect(await page.isChecked('#confirm-accept'), 'no difference is accepted — the bill adds up').toBe(false);
      await page.click('#confirm');
      await says(page, 'confirm-status', /^Confirmed — the bill is on head office's register as sup-k-KA-301\./);
      await page.click('#run-match');
      await says(page, 'match-status', /These agree — the bill may be paid/);
      expect(await page.locator('#match-verdict').innerText()).toMatch(/May be paid: ₹533\.00 · Billed: ₹533\.00 · Round off: −₹0\.40/);
      await shot(page, 'pending06-einvoice-round-off-matched-en');

      // ── "Round off −1.40" is more than a rupee: said on the draft; without accepting the difference it is refused ───
      await handIn(page, 'KA-302.json', eInvoice('KA/302', 'c0ffee0180e743321740b001fd70953e8738d109865d28ba4013750f2046f229', { RndOffAmt: -1.4, TotInvVal: 532 }), 'po-2');
      await says(page, 'hand-status', /^Handed in — head office read it/);
      await says(page, 'drawer-problems', /round off \(RndOffAmt\) is −₹1\.40 — more than one rupee either way, so it is not taken as a round off/);
      await page.locator('#draft-lines tr[data-line="1"] .f-product').fill('RICE');
      await page.click('#confirm');
      await says(page, 'confirm-status', /come to 53340 paise but the bill states 53200/);
      await shot(page, 'pending06-einvoice-round-off-too-large-en');

      // Tamil: the round off is said in Tamil on the draft's facts.
      await page.click('#lang');
      await says(page, 'drawer-facts', /முழுமையாக்கல் −₹1\.40/);
      await shot(page, 'pending06-einvoice-round-off-too-large-ta');
      expect(errors).toEqual([]);
    } finally { await context.close(); }

    const read = async (id: string) => (await shop.cloud().request({ method: 'GET', path: `/v1/purchase/invoices/${id}`, userId: OWNER })) as { status: number; body: unknown };
    expect((await read('sup-k-KA-301')).body).toMatchObject({ invoice: { totalMinor: 53_300, roundOffMinor: -40 }, match: { blocked: false, payableMinor: 53_300, roundOffMinor: -40 } });
    expect((await read('sup-k-KA-302')).status, 'the refused bill was not recorded').toBe(404);
  }, 180_000);
});
