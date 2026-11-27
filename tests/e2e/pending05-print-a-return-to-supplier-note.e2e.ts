import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startInboxShop, ok, OWNER, MGR, type InboxShop } from './lib/ai-inbox-shop';
import type { RealCloud } from '../support/real-store';

/**
 * **Pending list 27 Nov — item 5: "A printed or PDF return-to-supplier note", in a real Chromium, on the PRODUCTION API
 * over real PostgreSQL** (S1 of batch 18c · M10-FR-01 · M31-FR-02 · OB-874 C · OB-879).
 *
 *   • Quarantine: the manager returns 2 expired oil pouches to the supplier; on the new row in "Returned to suppliers" a
 *     "Print return note" button opens the shared A4 sheet titled "Return to supplier": the RTS number, the SDN debit note,
 *     the shop's and supplier's GSTINs, the batch and its expiry, quantity, rate, GST rate, value, why, who returned it, the
 *     status "waiting for the supplier to accept" and the two signature lines (handed over by / received by the driver).
 *     On paper only the A4 page prints. In Tamil the page is Tamil. With head office out of reach it prints the copy kept
 *     on this computer and says so. Printing sends nothing (no write).
 *   • Supplier bills → Debit notes: after the accountant records "Supplier accepted", the same note prints from the shelf
 *     debit-note row and says "Supplier accepted, credit note …".
 * Screenshots (deviceScaleFactor 1) go to SRE_SCREENSHOT_DIR when set. Synthetic data only.
 * Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const SHOTS = process.env['SRE_SCREENSHOT_DIR'];
const KEY = ['pending05', 'rts', 'print', 'key'].join('-').padEnd(48, '0');
const SHOP_GSTIN = '33AABCS1429B1Z1';
const SUPPLIER_GSTIN = '33ZZZZZ9999Z1ZF';
const ACCT = 'u-acct-p05';
const SEED_BUYER = 'u-seed-buyer-p05';
type Doc = { querySelector(x: string): { textContent: string | null } | null };

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('pending 5 — print a return-to-supplier note', () => {
  let browser: Browser;
  let shop: InboxShop;
  let rtsNumber = '';
  const as = (c: RealCloud, userId: string, path: string, body: unknown, key: string) => ok(c.request({ method: 'POST', path, userId, body, idempotencyKey: key }), key);

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    if (SHOTS !== undefined) mkdirSync(SHOTS, { recursive: true });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/quarantine', html: 'quarantine.html', dataGlobal: 'quarantineData' },
      alsoPages: [{ path: '/supplier-bills', html: 'supplier-bills.html', dataGlobal: 'supplierBillsData' }],
      seed: async (c) => {
        await c.grant(ACCT, 'accountant', undefined, 'all');
        await c.grant(SEED_BUYER, 'store_manager', undefined, 'all');
        await as(c, OWNER, '/v1/org/nodes/C-P05', { kind: 'company', name: 'SRE Hyper Market Private Limited' }, 'org-c');
        await as(c, OWNER, `/v1/org/gst-registrations/${SHOP_GSTIN}`, { companyId: 'C-P05', legalName: 'SRE Hyper Market Private Limited' }, 'gst');
        await as(c, OWNER, '/v1/org/nodes/br-1', { kind: 'branch', name: 'SRE Hyper Market', parentId: 'C-P05', companyId: 'C-P05', gstin: SHOP_GSTIN, placeOfBusiness: '12 Main Road, Tiruppur 641601, Tamil Nadu' }, 'org-br1');
        await as(c, SEED_BUYER, '/v1/purchase/suppliers/sup-1', { name: 'Kaveri Traders', gstin: SUPPLIER_GSTIN }, 'sup');
        await as(c, ACCT, '/v1/purchase/suppliers/sup-1/approval', { reason: 'documents checked' }, 'sup-ok');
        await as(c, OWNER, '/v1/catalogue/tax-classes/1512/rates/2017-07-01', { rateBps: 500 }, 'tax');
        await as(c, OWNER, '/v1/catalogue/products/OIL/publish', { product: { sku: 'SKU-OIL', name: 'Sunflower oil 1L', baseUom: 'ea', primaryCategoryId: 'grocery', taxClass: '1512', lifecycle: 'active' }, categories: [{ categoryId: 'grocery', name: 'grocery', parentId: null }] }, 'pub-oil');
        await as(c, OWNER, '/v1/inventory/movements', { movementId: 'rx-oil', productId: 'OIL', locationId: 'br-1', kind: 'received', quantityMinor: 120, uom: 'ea', occurredAt: '2026-11-01T09:00:00.000Z', enteredBy: OWNER, unitCostMinor: 15_000, batchId: 'B-OLD', expiry: '2026-11-15' }, 'rx');
      },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 180_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  const open = async (who: string, path: string) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
    await shop.signIn(context, who, who === MGR ? 'br-1' : undefined);
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    const writes: string[] = []; const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/v1/') && r.method() !== 'GET') writes.push(`${r.method()} ${u.pathname}`); });
    await page.goto(`${shop.base}${path}`, { waitUntil: 'load' });
    return { page, context, writes, errors, close: async () => { await page.waitForLoadState('networkidle').catch(() => {}); await context.close(); } };
  };
  const says = (page: Page, selector: string, re: RegExp) =>
    page.waitForFunction(([sel, src]) => new RegExp(src!).test((globalThis as unknown as { document: Doc }).document.querySelector(sel!)?.textContent ?? ''), [selector, re.source], { timeout: 20_000 });
  const shot = async (page: Page, name: string) => { if (SHOTS !== undefined) await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true }); };
  const facts = async (page: Page): Promise<string[]> => page.locator('.sre-print-facts > div').allInnerTexts();

  it('Quarantine: after the return, "Print return note" opens the A4 "Return to supplier" — English, Tamil, on paper, and again offline', async () => {
    const s = await open(MGR, '/quarantine?return=1&product=OIL&batch=B-OLD&qty=2&reason=expired&place=br-1');
    try {
      await s.page.locator('#return-section').waitFor({ state: 'visible' });
      await s.page.waitForFunction(() => (globalThis as unknown as { document: { querySelectorAll(x: string): { length: number } } }).document.querySelectorAll('#rts-supplier option').length > 1);
      await s.page.selectOption('#rts-supplier', 'sup-1');
      await s.page.fill('#rts-note', 'found past its date on aisle 4');
      await s.page.click('#rts-send');
      await says(s.page, '#rts-status', /Returned: RTS1\/\d\d-\d\d\/00001 · debit note SDN\/\d\d-\d\d\/\d{5} · ₹300\.00/);
      rtsNumber = /RTS1\/\d\d-\d\d\/00001/.exec((await s.page.textContent('#rts-status')) ?? '')![0];
      const print = s.page.locator('#rts-list li[data-return] button.print-rts').first();
      await print.waitFor();
      expect(await print.textContent()).toBe('Print return note');
      await shot(s.page, 'p05-1-quarantine-print-return-note-button');
      const writesBefore = [...s.writes];

      await print.click();
      await s.page.locator('#sre-print-sheet .sre-print-page').waitFor();
      expect(await s.page.textContent('#sre-print-title')).toBe('Return to supplier');
      expect(await s.page.textContent('.sre-print-head')).toContain(rtsNumber);
      expect(await s.page.textContent('.sre-print-head')).toMatch(/Date\d{2}\/\d{2}\/\d{4}/);
      expect(await s.page.textContent('.sre-print-parties')).toMatch(new RegExp(`SRE Hyper Market.*GSTIN: ${SHOP_GSTIN}.*Kaveri Traders.*GSTIN: ${SUPPLIER_GSTIN}`));
      const f = (await facts(s.page)).map((t) => t.replace(/\s+/g, ' ').trim());
      expect(f[0]).toMatch(/^Debit note SDN\/\d\d-\d\d\/\d{5}$/);
      expect(f).toContain('Why it goes back Expired — found past its date on aisle 4');
      expect(f).toContain(`Returned by ${MGR}`);
      expect(f).toContain('Status Waiting for the supplier to accept — the debit note is not taken off what is owed yet');
      expect(f.some((x) => x.startsWith('Approved by')), 'no second person was needed').toBe(false);
      expect(f.some((x) => x.startsWith('E-way bill')), 'below the e-way-bill limit').toBe(false);
      const rows = await s.page.locator('.sre-print-lines tbody tr').allInnerTexts();
      expect(rows.map((r) => r.split('\t').map((c) => c.trim()))).toEqual([['1', 'Sunflower oil 1L (OIL)', '1512', 'B-OLD · expires 15/11/2026', '2', '150.00', '5%', '300.00']]);
      expect(await s.page.textContent('.sre-print-totals')).toMatch(/Total value at these rates\s*₹300\.00/);
      expect((await s.page.locator('.sre-print-note').allInnerTexts()).join(' ')).toMatch(/GST amounts are on the supplier's credit note/);
      expect(await s.page.locator('.sre-print-signature').allInnerTexts()).toEqual(['Handed over by (store)', 'Received by (supplier\'s driver)']);
      await shot(s.page, 'p05-2-return-note-a4-english');
      await s.page.emulateMedia({ media: 'print' });
      expect(await s.page.isVisible('#return-section')).toBe(false);
      expect(await s.page.isVisible('#sre-print-go')).toBe(false);
      expect(await s.page.isVisible('.sre-print-page')).toBe(true);
      await shot(s.page, 'p05-3-return-note-on-paper');
      await s.page.emulateMedia({ media: 'screen' });
      await s.page.click('#sre-print-close');
      expect(s.writes, 'printing sends nothing').toEqual(writesBefore);

      // Tamil: the button and the page.
      await s.page.click('#lang');
      await s.page.waitForFunction(() => (globalThis as unknown as { document: { documentElement: { lang: string } } }).document.documentElement.lang === 'ta');
      await says(s.page, '#rts-list li[data-return] button.print-rts', /^திருப்பும் குறிப்பை அச்சிடு$/);
      await print.click();
      await s.page.locator('#sre-print-sheet .sre-print-page').waitFor();
      expect(await s.page.textContent('#sre-print-title')).toBe('விநியோகஸ்தருக்குத் திருப்பும் குறிப்பு');
      expect(await s.page.locator('.sre-print-signature').allInnerTexts()).toEqual(['ஒப்படைத்தவர் (கடை)', 'பெற்றவர் (விநியோகஸ்தரின் ஓட்டுநர்)']);
      await shot(s.page, 'p05-4-return-note-a4-tamil');
      await s.page.click('#sre-print-close');
      await s.page.click('#lang');

      // Head office out of reach: the note prints from the copy kept on this computer, and says so.
      await s.context.route('**/v1/documents/print/**', (route) => route.abort('internetdisconnected'));
      await print.click();
      await s.page.locator('#sre-print-sheet .sre-print-page').waitFor();
      expect(await s.page.textContent('#sre-print-status')).toMatch(/^Printed from the copy kept on this computer \(read from head office at .+\)\. Head office could not be reached just now\.$/);
      expect(await s.page.textContent('.sre-print-head')).toContain(rtsNumber);
      await shot(s.page, 'p05-5-return-note-offline-kept-copy');
      await s.page.click('#sre-print-close');
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
  }, 120_000);

  it('Supplier bills → Debit notes: once the supplier accepts, the note prints "Supplier accepted, credit note …"', async () => {
    const returnId = ((await shop.cloud().request({ method: 'GET', path: '/v1/inventory/shelf-returns', userId: OWNER })).body as { returns: { returnId: string }[] }).returns[0]!.returnId;
    await ok(shop.cloud().request({ method: 'POST', path: `/v1/purchase/suppliers/sup-1/shelf-return-debit-notes/DN-RTS-${returnId}/accept`, userId: ACCT, idempotencyKey: 'accept-p05', body: { supplierCreditNoteNo: 'KA-CN-12', supplierCreditNoteDate: '2026-11-18' } }), 'accepted');
    const s = await open(ACCT, '/supplier-bills');
    try {
      await s.page.waitForSelector('#dn-part:not([hidden])');
      await s.page.fill('#dn-supplier', 'sup-1');
      await s.page.click('#dn-show');
      const row = s.page.locator(`#dn-shelf li[data-shelf-note="DN-RTS-${returnId}"]`);
      await row.waitFor();
      const print = row.locator('button.print-rts');
      expect(await print.textContent()).toBe('Print return note');
      await shot(s.page, 'p05-6-debit-notes-print-return-note-button');
      await print.click();
      await s.page.locator('#sre-print-sheet .sre-print-page').waitFor();
      expect(await s.page.textContent('#sre-print-title')).toBe('Return to supplier');
      expect(await s.page.textContent('.sre-print-head')).toContain(rtsNumber);
      const f = (await facts(s.page)).map((t) => t.replace(/\s+/g, ' ').trim());
      expect(f).toContain('Status Supplier accepted, credit note KA-CN-12 dated 18/11/2026 — ₹300.00 taken off what is owed');
      await shot(s.page, 'p05-7-return-note-supplier-accepted');
      await s.page.click('#sre-print-close');
      expect(s.writes, 'printing sends nothing').toEqual([]);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
  }, 120_000);
});
