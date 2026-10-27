import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startInboxShop, ok, OWNER, MGR, type InboxShop } from './lib/ai-inbox-shop';
import { auditPage } from './lib/a11y-audit';
import { approveSupplierWith, SUPPLIER_MAKER, SUPPLIER_CHECKER } from '../support/approved-supplier';

/**
 * OB-288 commercial desks — the three office screens in a real browser, on the PRODUCTION API over real PostgreSQL:
 *   • Business customers (M22-FR-01/02): the accountant proposes a contract and asks; the OWNER approves; the accountant
 *     puts it in force; the store manager quotes WITHOUT typing a price (the contract prices it), makes the order, sends the
 *     challan and the tax invoice — and a cashier opens nothing; (OB-416) the accountant records the customer's GSTIN, a
 *     mistyped one refused by name, and the tax invoice is made out to it; (OB-426) its delivery State starts as the
 *     GSTIN's State; (OB-427) the accountant removes the GSTIN with a reason and the issued invoice keeps it;
 *   • Supplier submissions (M24-FR-01/02): a claim is rejected only with a reason, leaves the queue, and the supplier's
 *     "delayed" delivery update is on the order;
 *   • Concessions (M27-FR-01/04 · OB-304): switched off it says so; switched on, a contract approved by a second person is
 *     put in force, its insurance ending in 5 days shows, and the owner is told.
 * English and Tamil; every button its icon; the accessibility audit clean. Needs DATABASE_URL and Chromium; else it SKIPS.
 * Synthetic data only.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['desks', 'e2e', 'key'].join('-').padEnd(48, '0');
const day = (n: number): string => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('the commercial desks (OB-288 package 3) on the production API, in a real browser', () => {
  let browser: Browser;
  let shop: InboxShop;
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/b2b', html: 'b2b.html', dataGlobal: 'b2bDeskData' },
      alsoPages: [
        { path: '/supplier-submissions', html: 'supplier-submissions.html', dataGlobal: 'supplierSubmissionsData' },
        { path: '/concessions', html: 'concessions.html', dataGlobal: 'concessionsData' },
      ],
      seed: async (cloud) => {
        const post = (path: string, body: unknown, key: string, userId = OWNER, method: 'POST' | 'PUT' = 'POST') => ok(cloud.request({ method, path, userId, idempotencyKey: key, body }), key);
        await cloud.grant('u-acct', 'accountant');
        await cloud.grant('u-cash', 'cashier', undefined, ['br-1']);
        await cloud.grant(SUPPLIER_MAKER, 'store_manager');
        await cloud.grant(SUPPLIER_CHECKER, 'accountant');
        await post('/v1/platform/entitlements/b2b', { enabled: true }, 'b2b-on', OWNER, 'PUT');
        await post('/v1/inventory/movements', { movementId: 'rice-in', productId: 'rice', locationId: 'br-1', kind: 'received', quantityMinor: 25, uom: 'ea', occurredAt: new Date().toISOString(), enteredBy: OWNER }, 'rice-in');
        // A supplier with a portal login and an issued order; it sends a claim and says the order is delayed.
        await approveSupplierWith((method, path, userId, body, idempotencyKey) => cloud.request({ method, path, userId, idempotencyKey, body }), 'sup-a');
        await post('/v1/purchase/orders/po-a', { supplierId: 'sup-a', deliverToLocationId: 'br-1', lines: [{ productId: 'p-oil', orderedQty: 12, unitCost: { minor: 1_800, currency: 'INR' } }] }, 'po-a', SUPPLIER_MAKER);
        await post('/v1/purchase/orders/po-a/approval', { reason: 'synthetic order' }, 'po-a-issue');
        await post('/v1/supplier-portal/partners/sup-a', { grants: ['view_orders', 'raise_claim', 'acknowledge_orders'], documents: [], requiredDocuments: [], logins: [] }, 'cfg-sup-a', SUPPLIER_MAKER);
        // What the supplier sent, keyed in by the buyer from its email (the supplier's own portal login is an outside-party
        // invite, OB-76 — the integration test drives that door; here the buyer's door records the same submissions).
        await post('/v1/supplier-portal/partners/sup-a/submissions', { submissionId: 'sub-claim', kind: 'claim', document: { poId: 'po-a', claimMinor: 3_600, why: 'two short (synthetic)' } }, 'claim', SUPPLIER_MAKER);
        await post('/v1/supplier-portal/partners/sup-a/submissions', { submissionId: 'ds-1', kind: 'delivery_status', document: { poId: 'po-a', status: 'delayed', expectedOn: day(4), note: 'lorry broke down (synthetic)' } }, 'delayed', SUPPLIER_MAKER);
      },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 300_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  const open = async (who: string, path: string, branch?: string): Promise<{ page: Page; errors: string[]; close: () => Promise<void> }> => {
    const context = await browser.newContext();
    await shop.signIn(context, who, branch);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${shop.base}${path}`, { waitUntil: 'load' });
    return { page, errors, close: () => context.close() };
  };
  const waitText = (page: Page, selector: string, text: string) => page.waitForFunction(([sel, want]) => {
    const node = (globalThis as unknown as { document: { querySelector(s: string): { textContent: string | null } | null } }).document.querySelector(sel!);
    return (node?.textContent ?? '').includes(want!);
  }, [selector, text], { timeout: 15_000 });
  /** The owner approves, in his own session, the one request waiting for him of this kind. */
  const ownerApproves = async (kind: string) => {
    const inbox = (await shop.cloud().request({ method: 'GET', path: '/v1/approvals/requests', userId: OWNER })).body as { waitingForMe: { requestId: string; kind: string }[] };
    const r = inbox.waitingForMe.find((x) => x.kind === kind);
    expect(r, `a ${kind} request waits for the owner`).toBeDefined();
    await ok(shop.cloud().request({ method: 'POST', path: `/v1/approvals/requests/${r!.requestId}/decide`, userId: OWNER, idempotencyKey: `decide-${r!.requestId}`, body: { decision: 'approved', reason: 'terms checked (synthetic)' } }), 'owner approves');
  };

  it('business customers: contract proposed → owner approves → in force; the manager quotes without a price and runs the chain', async () => {
    // ── The accountant proposes and asks.
    const acct = await open('u-acct', '/b2b');
    await acct.page.waitForSelector('#customers:not([hidden])');
    await acct.page.fill('#c-id', 'SCHOOL'); await acct.page.click('#c-open');
    await acct.page.waitForSelector('#propose:not([hidden])');
    await acct.page.fill('#k-id', 'K-1'); await acct.page.fill('#k-from', day(-1)); await acct.page.fill('#k-to', day(60));
    await acct.page.fill('#k-prices', 'rice = 1200'); await acct.page.fill('#k-limit', '6000'); await acct.page.fill('#k-terms', '30');
    expect(await acct.page.locator('#k-save svg').count()).toBe(1);
    await acct.page.click('#k-save');
    await waitText(acct.page, '#k-status', 'Saved.');
    await waitText(acct.page, '#k-rows li[data-contract="K-1"]', 'waiting for approval');
    await acct.page.click('#k-ask');
    await waitText(acct.page, '#k-asked', 'waiting');
    expect(await auditPage(acct.page, { expectLang: 'en' }), 'the business customers page').toEqual([]);
    expect(acct.errors).toEqual([]);
    await acct.close();

    await ownerApproves('b2b_contract');

    const back = await open('u-acct', '/b2b');
    await back.page.waitForSelector('#customers:not([hidden])');
    await back.page.fill('#c-id', 'SCHOOL'); await back.page.click('#c-open');
    await back.page.locator('#k-asked button[data-act="put-in-force"]').click();
    await waitText(back.page, '#k-rows li[data-contract="K-1"]', 'in force');
    await waitText(back.page, '#acct', '₹6,000.00');
    // OB-416: the accountant records the customer's GSTIN (synthetic, valid check character). A mistyped one is refused by
    // name; the account then shows the GSTIN its tax invoices are made out to.
    await waitText(back.page, '#acct-gstin', 'No GSTIN on record');
    await back.page.waitForSelector('#gstin-form:not([hidden])');
    expect(await back.page.locator('#g-save svg').count()).toBe(1);
    await back.page.fill('#g-gstin', '33ZZZZZ9999Z1ZA'); await back.page.fill('#g-name', 'Synthetic School Trust'); await back.page.fill('#g-reason', 'GST certificate on file (synthetic)');
    await back.page.click('#g-save');
    await waitText(back.page, '#g-status', 'check character does not match');
    await back.page.fill('#g-gstin', '33ZZZZZ9999Z1ZF');
    await back.page.click('#g-save');
    await waitText(back.page, '#acct-gstin', '33ZZZZZ9999Z1ZF — Synthetic School Trust (Tamil Nadu, 33)');
    // OB-427: with a GSTIN on record, it can be removed (with the reason typed above) — the button carries its icon.
    await back.page.waitForSelector('#g-remove:not([hidden])');
    expect(await back.page.locator('#g-remove svg').count()).toBe(1);
    expect(await auditPage(back.page, { expectLang: 'en' }), 'the business customers page with the GSTIN form').toEqual([]);
    await back.page.click('#lang');
    expect(await back.page.textContent('#g-save-text')).toBe('GSTIN-ஐப் பதிவு செய்');
    expect(await back.page.textContent('#g-remove-text')).toBe('GSTIN-ஐ நீக்கு');
    expect(back.errors).toEqual([]);
    await back.close();

    // ── The store manager quotes WITHOUT a price — the contract prices it — then order, challan, tax invoice.
    const mgr = await open(MGR, '/b2b', 'br-1');
    await mgr.page.waitForSelector('#customers:not([hidden])');
    await mgr.page.locator('#c-rows li[data-customer="SCHOOL"] button[data-act="open"]').click();
    await mgr.page.waitForSelector('#quote:not([hidden])');
    expect(await mgr.page.isHidden('#propose')).toBe(true); // the order-taker never proposes a contract
    await mgr.page.fill('#q-store', 'br-1');
    await mgr.page.fill('#q-lines li[data-line="0"] input.q-productId', 'rice');
    await mgr.page.fill('#q-lines li[data-line="0"] input.q-description', 'Ponni rice 25kg');
    await mgr.page.fill('#q-lines li[data-line="0"] input.q-qty', '4');
    await mgr.page.click('#q-issue');
    await waitText(mgr.page, '#q-status', 'Saved.');
    const quote = mgr.page.locator('#d-rows li[data-kind="quotation"]');
    await quote.waitFor({ timeout: 15_000 });
    expect((await quote.textContent()) ?? '').toContain('contract price');
    expect((await quote.textContent()) ?? '').toContain('₹1,200.00');
    await quote.locator('button[data-act="to-order"]').click();
    const order = mgr.page.locator('#d-rows li[data-kind="sales_order"]');
    await order.waitFor({ timeout: 15_000 });
    await order.locator('input.dispatched').first().fill('4');
    await order.locator('button[data-act="challan"]').click();
    await mgr.page.locator('#d-rows li[data-kind="challan"]').waitFor({ timeout: 15_000 });
    // OB-426: the delivery State starts as the State of the customer's GSTIN (Tamil Nadu, 33), and says so; it can be changed.
    const orderNow = mgr.page.locator('#d-rows li[data-kind="sales_order"]');
    expect(await orderNow.locator('input.delivery-state').inputValue()).toBe('33');
    expect((await orderNow.textContent()) ?? '').toContain('Tamil Nadu (33) — Filled in from the State of the customer\'s GSTIN');
    await mgr.page.locator('#d-rows li[data-kind="sales_order"] button[data-act="invoice"]').click();
    await mgr.page.locator('#d-rows li[data-kind="tax_invoice"]').waitFor({ timeout: 15_000 });
    // OB-416: the tax invoice is made out to the customer's GSTIN; the order-taker cannot change the GSTIN.
    await waitText(mgr.page, '#d-rows li[data-kind="tax_invoice"]', 'Bill to: Synthetic School Trust · GSTIN 33ZZZZZ9999Z1ZF · Tamil Nadu (33)');
    expect(await mgr.page.isHidden('#gstin-form')).toBe(true);
    await waitText(mgr.page, '#o-rows', 'billed ₹5,040.00');
    const desk = (await shop.cloud().request({ method: 'GET', path: '/v1/b2b/desk/SCHOOL', userId: OWNER })).body as { orders: { orderedMinor: number; deliveredMinor: number; invoicedMinor: number }[] };
    expect(desk.orders[0]).toMatchObject({ orderedMinor: 504_000, deliveredMinor: 504_000, invoicedMinor: 504_000 });
    await mgr.page.click('#lang');
    expect(await mgr.page.textContent('#page-h')).toBe('வணிக வாடிக்கையாளர்கள்');
    expect(mgr.errors).toEqual([]);
    await mgr.close();

    // OB-427: the accountant removes the GSTIN (registration cancelled) with a reason; the account says none is on record,
    // and the invoice already issued still names the GSTIN it was made out to.
    const rm = await open('u-acct', '/b2b');
    await rm.page.waitForSelector('#customers:not([hidden])');
    await rm.page.fill('#c-id', 'SCHOOL'); await rm.page.click('#c-open');
    await rm.page.waitForSelector('#g-remove:not([hidden])');
    await rm.page.click('#g-remove');
    await waitText(rm.page, '#g-status', 'Type the reason the GSTIN is removed');
    await rm.page.fill('#g-reason', 'GST registration cancelled (synthetic)');
    await rm.page.click('#g-remove');
    await waitText(rm.page, '#acct-gstin', 'No GSTIN on record');
    expect(await rm.page.isHidden('#g-remove')).toBe(true);
    await waitText(rm.page, '#d-rows li[data-kind="tax_invoice"]', 'GSTIN 33ZZZZZ9999Z1ZF');
    expect(rm.errors).toEqual([]);
    await rm.close();

    const cash = await open('u-cash', '/b2b', 'br-1');
    expect(await cash.page.textContent('#page-status')).toBe('Your role cannot open the business desk.');
    await cash.close();
  }, 180_000);

  it('supplier submissions: a claim is rejected only with a reason and leaves the queue; the delayed delivery is on the order', async () => {
    const { page, errors, close } = await open(OWNER, '/supplier-submissions');
    const claim = page.locator('#q-rows li[data-submission="sub-claim"]');
    await claim.waitFor({ timeout: 15_000 });
    expect((await claim.textContent()) ?? '').toContain('Claim');
    await waitText(page, '#dl-rows', 'delayed');
    expect(await claim.locator('button[data-act="reject"] svg').count()).toBe(1);
    await claim.locator('button[data-act="reject"]').click();
    await waitText(page, '#q-status', 'Write the reason first');
    await claim.locator('input.reason').fill('the receipt shows all twelve (synthetic)');
    await claim.locator('button[data-act="reject"]').click();
    await waitText(page, '#q-rows', 'Nothing is waiting.');
    await waitText(page, '#dc-rows', 'the receipt shows all twelve');
    await page.fill('#po-id', 'po-a'); await page.click('#po-look');
    await waitText(page, '#po-rows', 'lorry broke down');
    expect(await auditPage(page, { expectLang: 'en' }), 'the supplier submissions page').toEqual([]);
    await page.click('#lang');
    expect(await page.textContent('#page-h')).toBe('சப்ளையர் சமர்ப்பிப்புகள்');
    expect(errors).toEqual([]);
    await close();
    const mine = (await shop.cloud().request({ method: 'GET', path: '/v1/supplier-portal/partners/sup-a/submissions', userId: OWNER })).body as { submissions: { submissionId: string; review: { decision: string } | null }[] };
    expect(mine.submissions.find((s) => s.submissionId === 'sub-claim')?.review).toMatchObject({ decision: 'rejected' });
  }, 120_000);

  it('concessions: off says so (OB-304); on, a second person approves, the 5-day insurance shows, and the owner is told', async () => {
    const off = await open(OWNER, '/concessions');
    await waitText(off.page, '#page-status', 'Concessions are switched off for this shop');
    expect(await off.page.isHidden('#counters')).toBe(true);
    await off.close();
    await ok(shop.cloud().request({ method: 'PUT', path: '/v1/platform/entitlements/dept.concession', userId: OWNER, idempotencyKey: 'conc-on', body: { enabled: true } }), 'concessions on');

    const acct = await open('u-acct', '/concessions');
    await acct.page.waitForSelector('#contract:not([hidden])');
    for (const [id, v] of [['#f-id', 'C-J'], ['#f-who', 'JEWEL'], ['#f-name', 'Jewellery counter'], ['#f-branch', 'br-1'], ['#f-start', day(-10)], ['#f-end', day(200)], ['#f-rent', '5000'], ['#f-deposit', '10000'], ['#f-ins', day(5)]] as const) await acct.page.fill(id, v);
    await acct.page.selectOption('#f-basis', 'fixed_rent');
    await acct.page.click('#f-save');
    await waitText(acct.page, '#c-rows li[data-contract="C-J"]', 'cannot take new sales');
    await acct.page.click('#f-ask');
    await waitText(acct.page, '#c-asked', 'waiting');
    await acct.close();

    await ownerApproves('concession_contract');

    const back = await open('u-acct', '/concessions');
    await back.page.locator('#c-asked button[data-act="put-in-force"]').click();
    await waitText(back.page, '#c-rows li[data-contract="C-J"]', 'may trade');
    await waitText(back.page, '#c-rows li[data-contract="C-J"]', 'within 7 days');
    await back.page.click('#raise');
    await waitText(back.page, '#c-status', 'alert(s) sent to the owner');
    expect(await auditPage(back.page, { expectLang: 'en' }), 'the concessions page').toEqual([]);
    await back.page.click('#lang');
    expect(await back.page.textContent('#page-h')).toBe('சலுகைக் கவுண்டர்கள்');
    expect(back.errors).toEqual([]);
    await back.close();
    const board = JSON.stringify((await shop.cloud().request({ method: 'GET', path: '/v1/platform/alerts', userId: OWNER })).body);
    expect(board).toContain(`concession-expiry:C-J:insurance:${day(5)}:within_7_days`);
  }, 180_000);
});
