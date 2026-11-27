import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startInboxShop, ok, OWNER, MGR, type InboxShop } from './lib/ai-inbox-shop';
import type { RealCloud } from '../support/real-store';

/**
 * **OB-937 A (owner, 27 Nov 2026, in writing) · D-155 — a supplier's credit note or debit note e-invoice is refused on the
 * Supplier bills page — in a real browser, on the PRODUCTION API over real PostgreSQL.**
 *
 * Before: an e-invoice whose `DocDtls.Typ` is CRN (credit note) or DBN (debit note) was read as a draft BILL a person could
 * confirm. Now, through Chromium, as the br-1 store manager:
 *   • the credit note (.json) is handed in; the page says "This file is a supplier's credit note, not a bill. Nothing was
 *     recorded. Record it under Debit notes → Supplier accepted." — and the register still has no bill;
 *   • a debit note says "… debit note, not a bill … Ask the accountant how to record it.";
 *   • the same words in Tamil; a bill (INV) from the same supplier still reads;
 *   • head office's own register (read from the API, not the page) holds no document and no bill for either note.
 *
 * Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS. Synthetic data only.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['credit', 'note', 'einv', 'e2e', 'signing', 'key'].join('-').padEnd(48, '0');
const ACCT = 'u-acct-crn';
const SEED_BUYER = 'u-seed-buyer';
const GSTIN = '33ABCDE1234F1Z5';
const SHOTS = process.env['PENDING09_SHOTS'];

const eInvoice = (typ: string, no: string, irn: string) => ({
  Version: '1.1', Irn: irn,
  TranDtls: { TaxSch: 'GST', SupTyp: 'B2B' },
  DocDtls: { Typ: typ, No: no, Dt: '20/11/2026' },
  SellerDtls: { Gstin: GSTIN, LglNm: 'Kaveri Agro Traders (synthetic)', Addr1: 'Synthetic street', Loc: 'Erode', Pin: 638001, Stcd: '33' },
  BuyerDtls: { Gstin: '33ZZZZZ9999Z1Z9', LglNm: 'Synthetic Hyper Market', Pos: '33', Addr1: 'Synthetic road', Loc: 'Erode', Pin: 638001, Stcd: '33' },
  ItemList: [{ SlNo: '1', PrdDesc: 'Ponni rice 1 kg', IsServc: 'N', HsnCd: '1006', Barcde: 'K-RICE', Qty: 2, Unit: 'NOS', UnitPrice: 50, TotAmt: 100, AssAmt: 100, GstRt: 5, CgstAmt: 2.5, SgstAmt: 2.5, IgstAmt: 0, TotItemVal: 105 }],
  ValDtls: { AssVal: 100, CgstVal: 2.5, SgstVal: 2.5, IgstVal: 0, TotInvVal: 105 },
});

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('a credit or debit note e-invoice is refused on the Supplier bills page (OB-937 A)', () => {
  let browser: Browser;
  let shop: InboxShop;
  const as = (c: RealCloud, path: string, body: unknown, key: string, userId = OWNER) => c.request({ method: 'POST', path, userId, body, idempotencyKey: key });

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
  const handIn = async (page: Page, name: string, bill: unknown): Promise<void> => {
    await page.setInputFiles('#bill-file', { name, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(bill), 'utf8') });
    await page.click('#hand-in');
  };
  const shot = async (page: Page, name: string): Promise<void> => { if (SHOTS !== undefined) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }); };

  it('a credit note and a debit note are refused in plain words (English and Tamil) and never become a bill; a bill still reads', async () => {
    const context = await browser.newContext({ deviceScaleFactor: 1 });
    await shop.signIn(context, MGR, 'br-1');
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    try {
      await page.goto(`${shop.base}/supplier-bills`, { waitUntil: 'load' });
      await says(page, 'register-status', /No bills handed in yet/);

      // ── A supplier's credit note ───────────────────────────────────────────────────────────────────────────
      await handIn(page, 'KA-CN-7.json', eInvoice('CRN', 'KA/CN/7', 'c0ffee0280e743321740b001fd70953e8738d109865d28ba4013750f2046f229'));
      await says(page, 'hand-status', /^This file is a supplier's credit note, not a bill\. Nothing was recorded\. Record it under Debit notes → Supplier accepted\.$/);
      expect(await page.locator('#hand-status').getAttribute('class')).toContain('err');
      await says(page, 'register-status', /No bills handed in yet/);
      await shot(page, 'pending09-credit-note-refused-en');

      // ── A supplier's debit note ────────────────────────────────────────────────────────────────────────────
      await handIn(page, 'KA-DN-3.json', eInvoice('DBN', 'KA/DN/3', 'c0ffee0380e743321740b001fd70953e8738d109865d28ba4013750f2046f229'));
      await says(page, 'hand-status', /^This file is a supplier's debit note, not a bill\. Nothing was recorded\. Ask the accountant how to record it\.$/);

      // ── Tamil: the same refusal in Tamil ───────────────────────────────────────────────────────────────────
      await page.click('#lang');
      await handIn(page, 'KA-CN-7.json', eInvoice('CRN', 'KA/CN/7', 'c0ffee0280e743321740b001fd70953e8738d109865d28ba4013750f2046f229'));
      await says(page, 'hand-status', /^இந்தக் கோப்பு சப்ளையரின் வரவுக் குறிப்பு, பில் அல்ல\. எதுவும் பதிவு செய்யப்படவில்லை\./);
      await shot(page, 'pending09-credit-note-refused-ta');
      await page.click('#lang');

      // ── A bill (INV) from the same supplier still reads ──────────────────────────────────────────────────────
      await handIn(page, 'KA-401.json', eInvoice('INV', 'KA/401', 'c0ffee0480e743321740b001fd70953e8738d109865d28ba4013750f2046f229'));
      await says(page, 'hand-status', /^Handed in — head office read it/);
      expect(errors).toEqual([]);
    } finally { await context.close(); }

    // Head office's own register: only the bill — no document for either note, and no bill made from one.
    const reg = (await shop.cloud().request({ method: 'GET', path: '/v1/purchase/invoice-documents', userId: OWNER })) as { status: number; body: { documents: { extracted: { supplierInvoiceNo: string } | null }[] } };
    expect(reg.body.documents.map((d) => d.extracted?.supplierInvoiceNo)).toEqual(['KA/401']);
    for (const id of ['sup-k-KA-CN-7', 'sup-k-KA-DN-3']) expect((await shop.cloud().request({ method: 'GET', path: `/v1/purchase/invoices/${id}`, userId: OWNER })).status).toBe(404);
  }, 180_000);
});
