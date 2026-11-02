import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startInboxShop, ok, OWNER, type InboxShop } from './lib/ai-inbox-shop';
import { startPageShell } from './lib/page-shell';
import { creditLimitWithApproval } from '../support/approved-credit-limit';
import { customerListPrice, unpriced } from '../support/b2b-price-on-record';

/**
 * **GST credit and debit notes to a business customer on the Business customers page — in a real browser, on the PRODUCTION
 * API over real PostgreSQL (M23-FR-02 · OB-678 · OB-290 · §28 · P-04 · P-08 · hard rules #2 #10).**
 *
 * Before W3 no screen issued a note, and the note route took the invoice from the request. Through Chromium, the ACCOUNTANT
 * opens the caterer on the Business customers page and shows its tax invoices: the line with what it charged and what is
 * left to credit. A credit note for more than the line carries is refused in head office's words; a ₹200 credit note is
 * worked out by head office (₹10 GST) and its approval asked — nothing is issued yet. The STORE MANAGER approves it in his
 * own session (within his ₹5,000 refund limit). Back on the page the accountant issues the approved credit note: CN-000001,
 * "waiting for the accountant's posting rule". A ₹10 debit note is issued at once (CDN-000001). The words switch to Tamil.
 * Head office then holds: the invoice unchanged, the balance moved, the notes in the GSTR-1 data's note section.
 *
 * Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS. Synthetic data only.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['w3', 'gst', 'notes', 'e2e', 'signing', 'key'].join('-').padEnd(48, '0');
const ACCOUNTANT = 'u-acct-cn'; const MANAGER = 'u-mgr-cn';
const STORE_GSTIN = '33AABCS1429B1Z1'; const BUYER_GSTIN = '33ZZZZZ9999Z1ZF';
const LINE = { lineId: 'l1', productId: 'rice', description: 'Rice 25kg', qty: 10, unitPriceMinor: 10_000, taxRateBps: 500 };

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('GST notes to a business customer on the Business customers page (M23-FR-02 · OB-678)', () => {
  let browser: Browser;
  let shop: InboxShop;
  let desk: { base: string; stop: () => Promise<void> };

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/b2b', html: 'b2b.html', dataGlobal: 'b2bDeskData' },
      seed: async (cloud) => {
        const as = (path: string, body: unknown, key: string, method: 'POST' | 'PUT' = 'POST', userId = OWNER) => ok(cloud.request({ method, path, userId, idempotencyKey: key, body }), path);
        await as('/v1/platform/entitlements/b2b', { enabled: true }, 'b2b-on', 'PUT');
        await cloud.grant(ACCOUNTANT, 'accountant');
        await cloud.grant(MANAGER, 'store_manager');
        // The store the caterer is supplied from carries the shop's GSTIN (Tamil Nadu), so its invoice carries CGST + SGST.
        await as('/v1/org/nodes/SRE', { kind: 'company', name: 'SRE Hyper Market Private Limited' }, 'org-sre');
        await as(`/v1/org/gst-registrations/${STORE_GSTIN}`, { companyId: 'SRE', legalName: 'SRE Hyper Market Private Limited' }, 'gst-reg');
        await as('/v1/org/nodes/S1', { kind: 'branch', name: 'SRE Hyper Market', parentId: 'SRE', companyId: 'SRE', gstin: STORE_GSTIN, placeOfBusiness: '12 Main Road\n\nTiruppur 641601, Tamil Nadu' }, 'org-s1');
        await ok(creditLimitWithApproval((r) => cloud.request(r), OWNER, ACCOUNTANT, 'CATERER', { creditLimitMinor: 500_000 }, 'acc-cat'), 'caterer account');
        await as('/v1/b2b/accounts/CATERER/gstin', { gstin: BUYER_GSTIN, legalName: 'Synthetic Caterers', reason: 'GST certificate on file' }, 'gstin', 'POST', ACCOUNTANT);
        const listed = customerListPrice('rice', 'CATERER', LINE.unitPriceMinor);
        await as(listed.path, listed.body, 'pl-rice');
        await as('/v1/inventory/movements', { movementId: 'rice-in', productId: 'rice', locationId: 'S1', kind: 'received', quantityMinor: 25, uom: 'ea', occurredAt: new Date(Date.now() - 3_600_000).toISOString(), enteredBy: OWNER }, 'rice-in');
        await as('/v1/b2b/documents/CATERER/quotations/q-c1', { lines: unpriced([LINE]), locationId: 'S1' }, 'q-c1');
        await as('/v1/b2b/documents/CATERER/orders/so-c1', { fromQuotationId: 'q-c1', locationId: 'S1' }, 'so-c1');
        await as('/v1/b2b/documents/CATERER/challans/dc-c1', { fromOrderId: 'so-c1', dispatched: { l1: 10 } }, 'dc-c1');
        await as('/v1/b2b/documents/CATERER/invoices/inv-c1', { fromOrderId: 'so-c1' }, 'inv-c1');
      },
    });
    desk = await startPageShell({ cloud: () => shop.cloud(), page: { path: '/b2b', html: 'b2b.html', dataGlobal: 'b2bDeskData' } });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 180_000);
  afterAll(async () => { await browser?.close(); await desk?.stop(); await shop?.stop(); });

  const open = async (who: string) => {
    const context = await browser.newContext();
    await context.addCookies([{ name: 'who', value: who, domain: new URL(desk.base).hostname, path: '/' }]);
    const page = await context.newPage();
    const writes: string[] = []; const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/v1/') && r.method() !== 'GET') writes.push(`${r.method()} ${u.pathname}`); });
    await page.goto(`${desk.base}/b2b`, { waitUntil: 'load' });
    return { page, writes, errors, close: async () => { await page.waitForLoadState('networkidle').catch(() => {}); await context.close(); } };
  };
  const says = async (page: Page, selector: string, expected: RegExp): Promise<void> => {
    try {
      await page.waitForFunction(([sel, source]) => new RegExp(source!).test((globalThis as unknown as { document: { querySelector(x: string): { textContent: string | null } | null } }).document.querySelector(sel!)?.textContent ?? ''), [selector, expected.source], { timeout: 15_000 });
    } catch (e) {
      throw new Error(`${selector} never said ${String(expected)} — it says "${await page.locator(selector).first().textContent().catch(() => '(nothing)')}"`, { cause: e });
    }
  };
  const openCaterer = async (page: Page) => {
    await page.waitForSelector('#cn:not([hidden])', { timeout: 15_000 });
    await page.fill('#c-id', 'CATERER');
    await page.click('#c-open');
    await page.waitForSelector('#customer:not([hidden])', { timeout: 15_000 });
    await page.click('#cn-show');
    await page.locator('#cn-invoices li[data-invoice="inv-c1"]').waitFor({ timeout: 15_000 });
  };
  const owed = async (): Promise<number> => ((await shop.cloud().request({ method: 'GET', path: '/v1/b2b/accounts/CATERER', userId: ACCOUNTANT })).body as { outstandingMinor: number }).outstandingMinor;

  it('the accountant asks approval for a credit note head office worked out; an over-credit is refused; nothing is issued yet', async () => {
    const s = await open(ACCOUNTANT);
    try {
      await s.page.waitForSelector('#cn:not([hidden])', { timeout: 15_000 });
      await s.page.waitForLoadState('networkidle');
      expect(s.writes, 'nothing is written on open').toEqual([]);
      await openCaterer(s.page);
      const inv = s.page.locator('#cn-invoices li[data-invoice="inv-c1"]');
      expect(await inv.innerText()).toMatch(/₹1,050\.00 · GSTIN 33ZZZZZ9999Z1ZF/);
      expect(await inv.innerText()).toMatch(/charged ₹1,000\.00 · credited ₹0\.00 · left to credit ₹1,000\.00/);
      // More than the line carries — refused by head office, from the invoice it holds.
      await inv.locator('input.cn-line').fill('1,200');
      await inv.locator('select.cn-reason').selectOption('goods_returned');
      await inv.locator('button.cn-raise').click();
      await says(s.page, '#cn-status', /^Head office refused: "Rice 25kg": 120000 asked, but INV-\d+ charged 100000 on it/);
      // ₹200 back: worked out and asked.
      await inv.locator('input.cn-line').fill('200');
      await inv.locator('button.cn-raise').click();
      await says(s.page, '#cn-status', /^Asked for approval\. A second person approves it/);
      await says(s.page, '#cn-asked', /Credit note to CATERER against INV-\d+: ₹210\.00 \(goods returned\) — waiting for approval/);
      expect(await s.page.locator('#cn-asked button.cn-issue').count(), 'nothing to issue until a second person approves').toBe(0);
      expect(s.writes).toEqual(['POST /v1/finance/credit-notes/preview', 'POST /v1/finance/credit-notes/preview', 'POST /v1/approvals/requests']);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
    expect(await owed(), 'asking issues nothing').toBe(105_000);
  }, 120_000);

  it('the store manager approves it in his own session; the accountant issues it, then a debit note; head office holds them', async () => {
    const before = (await shop.cloud().request({ method: 'GET', path: '/v1/b2b/documents/CATERER/inv-c1', userId: ACCOUNTANT })).body;
    const inbox = (await shop.cloud().request({ method: 'GET', path: '/v1/approvals/requests', userId: MANAGER })).body as { waitingForMe: { requestId: string; kind: string }[] };
    const req = inbox.waitingForMe.find((r) => r.kind === 'customer_credit_note');
    expect(req, 'the ₹210 credit note is in the store manager\'s inbox (within his ₹5,000 refund limit)').toBeDefined();
    await ok(shop.cloud().request({ method: 'POST', path: `/v1/approvals/requests/${req!.requestId}/decide`, userId: MANAGER, idempotencyKey: 'decide-cn', body: { decision: 'approved', reason: 'the bags came back' } }), 'manager approves');

    const s = await open(ACCOUNTANT);
    try {
      await openCaterer(s.page);
      const asked = s.page.locator('#cn-asked li[data-status="approved"]');
      await asked.waitFor({ timeout: 15_000 });
      expect(await asked.innerText()).toContain(`approved by ${MANAGER} — the bags came back`);
      await asked.locator('button.cn-issue').click();
      await says(s.page, '#cn-status', /^Issued\. The invoice is unchanged/);
      const cn = s.page.locator('#cn-notes li[data-note="CN-000001"]');
      await cn.waitFor({ timeout: 15_000 });
      expect(await cn.innerText()).toMatch(/CN-000001 · Credit note \(takes off\) · against INV-\d+ · ₹200\.00 \+ GST ₹10\.00 = ₹210\.00/);
      expect(await cn.getAttribute('data-posting')).toBe('waiting_for_posting_rule');
      expect(await cn.innerText()).toMatch(/Waiting for the accountant's posting rule/);
      await says(s.page, '#cn-invoices', /credited ₹200\.00 · left to credit ₹800\.00/);

      // A debit note: issued at once, from its own series.
      const inv = s.page.locator('#cn-invoices li[data-invoice="inv-c1"]');
      await inv.locator('select.cn-kind').selectOption('debit_note');
      expect(await inv.locator('button.cn-raise').innerText()).toBe('Issue the debit note');
      await inv.locator('input.cn-line').fill('10');
      await inv.locator('select.cn-reason').selectOption('price_correction');
      await inv.locator('button.cn-raise').click();
      await says(s.page, '#cn-status', /^Issued\./);
      await s.page.locator('#cn-notes li[data-note="CDN-000001"]').waitFor({ timeout: 15_000 });

      await s.page.click('#lang');
      await says(s.page, '#cn-h', /GST வரவு மற்றும் பற்றுக் குறிப்புகள்/);
      await says(s.page, '#cn-notes', /கணக்காளரின் பதிவு விதிக்காகக் காத்திருக்கிறது/);
      expect(s.writes.filter((w) => w.startsWith('POST /v1/finance/credit-notes'))).toEqual(['POST /v1/finance/credit-notes', 'POST /v1/finance/credit-notes']);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }

    // Head office: the invoice never changed; the balance moved by each note; both notes in the GSTR-1 note section.
    expect((await shop.cloud().request({ method: 'GET', path: '/v1/b2b/documents/CATERER/inv-c1', userId: ACCOUNTANT })).body).toEqual(before);
    expect(await owed()).toBe(105_000 - 21_000 + 1_050);
    const desk2 = (await shop.cloud().request({ method: 'GET', path: '/v1/finance/credit-notes/customers/CATERER', userId: ACCOUNTANT })).body as { notes: { number: string; issuedOn: string; approvedBy?: string }[] };
    expect(desk2.notes.map((n) => [n.number, n.approvedBy ?? null])).toEqual([['CDN-000001', null], ['CN-000001', MANAGER]]);
    const day = desk2.notes[0]!.issuedOn;
    const ret = (await shop.cloud().request({ method: 'GET', path: `/v1/finance/gstr1/return?from=${day.slice(0, 7)}-01&to=${day.slice(0, 7)}-31`, userId: ACCOUNTANT })).body as { creditDebitNotes?: { registered: { noteNumber: string; recipientGstin: string }[] } };
    expect(ret.creditDebitNotes?.registered.map((r) => [r.noteNumber, r.recipientGstin])).toEqual([['CDN-000001', BUYER_GSTIN], ['CN-000001', BUYER_GSTIN]]);
  }, 120_000);
});
