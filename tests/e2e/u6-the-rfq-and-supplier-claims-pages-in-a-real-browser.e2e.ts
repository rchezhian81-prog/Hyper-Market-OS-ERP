import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Page } from 'playwright-core';
import { startBoxPageShop, says, HAVE_BROWSER, type BoxPageShop } from './lib/r4c-box-page';
import { askedThenConfirmed, writeCounter } from './lib/confirm-sheet';
import { approveSupplierWith, SUPPLIER_MAKER, SUPPLIER_CHECKER, deliveryPlaces } from '../support/approved-supplier';

/**
 * **U6 · M06-FR-02 · M07-FR-03 · M24-FR-01 · M24-FR-02 (UI/UX gap audit §27): the two new office pages, in a real browser, on
 * the real store computer and head office.**
 *   • Requests for quotation: the buyer chooses a requisition, finds the supplier by three letters of its NAME, gives the
 *     day, sends — head office holds the request for exactly those suppliers; the register shows it Open with each
 *     supplier's standing; the primary button says why it is grey before that; the accountant reads the register but is
 *     told they cannot send; Tamil twin.
 *   • Supplier claims: the damaged line a second person claimed is a debit note "Raised"; the accountant issues it — the
 *     confirm sheet says the rupees and the supplier, Go back sends nothing, Confirm issues once — and the row reads Issued
 *     with its DN number; the buyer cannot issue (the button says why) but rejects the supplier's own claim with a reason.
 */
const BUYER = 'u-buyer';
const ACCT = 'u-acct';
const BOSS = 'u-boss';
const rl = (lineId: string, productId: string, ordered: number, counted: number, unit: number, extra: Record<string, unknown> = {}) =>
  ({ lineId, productId, orderedMinor: ordered, countedMinor: counted, uom: 'ea', unitCost: { minor: unit, currency: 'INR' }, condition: 'good', ...extra });

async function pickByName(page: Page, pickButton: string, letters: string, name: RegExp): Promise<void> {
  await page.click(pickButton);
  await page.waitForSelector('#sre-picker');
  await page.fill('#sre-picker-q', letters);
  const row = page.locator('#sre-picker-list .sre-picker-row', { hasText: name }).first();
  await row.waitFor({ timeout: 10_000 });
  await row.click();
  await page.waitForSelector('#sre-picker', { state: 'detached' });
}

describe.skipIf(!HAVE_BROWSER)('U6: the Requests for quotation and Supplier claims pages', () => {
  let shop: BoxPageShop;
  beforeAll(async () => {
    shop = await startBoxPageShop({
      name: 'u6-rfq-claims',
      people: [
        { userId: BUYER, permissions: ['purchase.commitment.read', 'purchase.order.propose', 'supplier.portal.review'] },
        { userId: ACCT, permissions: ['purchase.commitment.read', 'purchase.invoice.match'] },
      ],
      seed: async (h, T, store) => {
        await h.seedOwner(T, 'u-owner');
        for (const [u, r] of [[BUYER, 'store_manager'], [BOSS, 'store_manager'], ['u-recv', 'store_manager'], [ACCT, 'accountant'], ['u-sup', 'supplier'], [SUPPLIER_MAKER, 'store_manager'], [SUPPLIER_CHECKER, 'accountant']] as const) await h.provisionRole(T, u, r);
        const post = async (path: string, userId: string, body: unknown, ok = 300) => {
          const r = await h.request({ method: 'POST', path, userId, tenantId: T, body, idempotencyKey: `seed-${path}-${userId}` });
          if (r.status >= ok) throw new Error(`${path}: ${r.status} ${JSON.stringify(r.body)}`);
        };
        const call = (method: 'POST', path: string, userId: string, body: unknown, idempotencyKey: string) => h.request({ method, path, userId, tenantId: T, body, idempotencyKey });
        await approveSupplierWith(call, 'sup-a', 'Aavin Dairy');
        await approveSupplierWith(call, 'sup-b', 'Bharat Grains');
        await deliveryPlaces(h, T, store);
        await post('/v1/purchase/requisitions/rq-1', BUYER, { currency: 'INR', lines: [{ productId: 'p-rice', quantity: 10 }, { productId: 'p-dal', quantity: 4 }] });
        // A delivery from sup-a with two damaged p2 — claimed by a second person: one debit note, raised.
        await post('/v1/inventory/receipt-policy', 'u-owner', { excessToleranceBp: 0, shortageToleranceBp: 0, nearExpiryDays: 7 });
        await post('/v1/purchase/orders/po-1', BUYER, { supplierId: 'sup-a', deliverToLocationId: store, lines: [{ productId: 'p2', orderedQty: 4, unitCost: { minor: 1000, currency: 'INR' } }] });
        await post('/v1/purchase/orders/po-1/approval', 'u-owner', { reason: 'fixture' });
        await post('/v1/inventory/goods-receipt/grn-1', 'u-recv', { warehouseId: store, receivedOnDate: '2026-09-30', currency: 'INR', poId: 'po-1', lines: [rl('L2', 'p2', 2, 2, 1000), rl('L3', 'p2', 2, 2, 1000, { condition: 'damaged' })] });
        await post('/v1/inventory/goods-receipt/grn-1/lines/L3/disposition', BOSS, { disposition: 'claim', reason: 'two cartons crushed' });
        // The supplier's own claim on the shop, through its portal.
        await post('/v1/supplier-portal/partners/sup-a', BUYER, { grants: ['raise_claim', 'view_statement', 'view_orders', 'respond_rfq'], documents: [], requiredDocuments: [], logins: ['u-sup'] });
        await post('/v1/supplier-portal/me/submissions', 'u-sup', { submissionId: 'claim-a-1', kind: 'claim', document: { poId: 'po-1', claimMinor: 150_000, why: 'freight paid by us, not billed' } });
      },
    });
  }, 300_000);
  afterAll(async () => { await shop?.stop(); });

  it('Requests for quotation: requisition chosen, supplier found by name, sent; the register shows it open; the accountant reads but cannot send', async () => {
    const s = await shop.open(BUYER, '/rfq');
    const { page } = s;
    try {
      await says(page, '#page-h', /^Requests for quotation$/);
      await page.waitForFunction('globalThis.sreOffice !== undefined && typeof globalThis.sreOffice.pick === "function"');
      await says(page, '#r-table', /No request|none|yet/i);
      // the one primary is grey and says why, before anything is chosen
      expect(await page.isDisabled('#s-send')).toBe(true);
      await page.waitForSelector('#s-req option[value="rq-1"]', { state: 'attached' });
      await page.selectOption('#s-req', 'rq-1');
      await says(page, '#s-lines', /p-rice × 10, p-dal × 4/);
      expect(await page.isDisabled('#s-send')).toBe(true);
      await pickByName(page, '#s-supplier-pick', 'aav', /Aavin Dairy/);
      await says(page, '#s-asked li[data-supplier="sup-a"]', /Aavin Dairy \(sup-a\)/);
      await pickByName(page, '#s-supplier-pick', 'bha', /Bharat Grains/);
      expect(await page.locator('#s-asked li[data-supplier]').count()).toBe(2);
      expect(await page.isDisabled('#s-send')).toBe(false);
      // no day yet: refused on the page, nothing sent
      await page.click('#s-send');
      await says(page, '#s-status', /Give the day the quotes are due\. Nothing was sent\./);
      expect(s.writes).toEqual([]);
      await page.fill('#s-due', '20/11/2099');
      await page.fill('#s-note', 'per kg, delivered');
      await page.click('#s-send');
      await says(page, '#s-status', /^Sent\. Each supplier now sees it on its portal\.$/);
      expect(s.writes).toHaveLength(1);
      expect(s.writes[0]).toMatch(/^POST \/v1\/purchase\/requisitions\/rq-1\/rfq\//);
      const held = (await shop.call('GET', '/v1/purchase/rfqs', BUYER)).body as { rfqs: { requisitionId: string; supplierIds: string[]; dueOn: string; note?: string; state: string }[]; counts: { open: number } };
      expect(held.rfqs).toHaveLength(1);
      expect(held.rfqs[0]).toMatchObject({ requisitionId: 'rq-1', supplierIds: ['sup-a', 'sup-b'], dueOn: '2099-11-20', note: 'per kg, delivered', state: 'open' });
      // the register on the page: one open request
      await says(page, '#r-table tbody tr', /rq-1/);
      await says(page, '#r-table tbody tr', /Open/);
      await says(page, '#r-cards', /Open\s*1/);
      await page.click('#r-table tbody tr .sre-row-open');
      await says(page, '#sre-drawer', /Aavin Dairy/);
      await page.click('#sre-drawer-close');
      await page.click('#lang');
      await says(page, '#page-h', /^விலைப்புள்ளிக் கோரிக்கைகள்$/);
      await says(page, '#r-table tbody tr', /திறந்துள்ளது/);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }

    const a = await shop.open(ACCT, '/rfq');
    try {
      await says(a.page, '#page-status', /^Your role cannot send a request for quotation\.$/);
      await says(a.page, '#r-table tbody tr', /rq-1/);
      expect(await a.page.isHidden('#send')).toBe(true);
      expect(a.writes).toEqual([]);
      expect(a.errors).toEqual([]);
    } finally { await a.close(); }
  });

  it('Supplier claims: the debit note is issued behind the confirm sheet and reads Issued with its number; the buyer cannot issue but rejects the supplier\'s claim with a reason', async () => {
    const b = await shop.open(BUYER, '/supplier-claims');
    try {
      await says(b.page, '#page-h', /^Supplier claims$/);
      await says(b.page, '#shop-table tbody tr[data-kind="debit_note"]', /Aavin Dairy/);
      await says(b.page, '#shop-table tbody tr[data-kind="debit_note"]', /Raised, not yet issued/);
      // the buyer does not hold the right to issue: the button is there, grey, and says why
      await b.page.click('#shop-table tbody tr[data-kind="debit_note"] .sre-row-open');
      await b.page.waitForSelector('#sre-drawer button[data-act="issue"]');
      expect(await b.page.isDisabled('#sre-drawer button[data-act="issue"]')).toBe(true);
      await says(b.page, '#sre-drawer', /Your role cannot issue a debit note\./);
      await b.page.click('#sre-drawer-close');
      // the supplier's own claim: no reason → refused on the page; with a reason → rejected, once
      await says(b.page, '#sup-table tbody tr[data-submission="claim-a-1"]', /₹1,500\.00/);
      await b.page.click('#sup-table tbody tr[data-submission="claim-a-1"] .sre-row-open');
      await b.page.click('#reject-claim-a-1');
      await says(b.page, '#sup-status', /^Give the reason first\. Nothing was decided\.$/);
      expect(b.writes).toEqual([]);
      await b.page.click('#sup-table tbody tr[data-submission="claim-a-1"] .sre-row-open');
      await b.page.fill('#reason-claim-a-1', 'freight was in the order price');
      await b.page.click('#reject-claim-a-1');
      await says(b.page, '#sup-table tbody tr[data-submission="claim-a-1"]', /Rejected|Not accepted/);
      expect(b.writes).toEqual(['POST /v1/supplier-portal/partners/sup-a/submissions/claim-a-1/review']);
      expect(b.errors).toEqual([]);
    } finally { await b.close(); }

    const a = await shop.open(ACCT, '/supplier-claims');
    try {
      const { page } = a;
      const sent = writeCounter(page);
      await says(page, '#shop-table tbody tr[data-kind="debit_note"]', /Raised, not yet issued/);
      const title = await askedThenConfirmed(page, async () => {
        await page.click('#shop-table tbody tr[data-kind="debit_note"] .sre-row-open');
        await page.click('#sre-drawer button[data-act="issue"]');
      }, /₹20\.00 will be taken off what the shop owes Aavin Dairy/, sent);
      expect(title).toMatch(/Aavin Dairy/);
      await says(page, '#shop-table tbody tr[data-kind="debit_note"]', /Issued/);
      await says(page, '#shop-table tbody tr[data-kind="debit_note"]', /DN-\d{6}/);
      expect(a.writes).toHaveLength(1);
      expect(a.writes[0]).toMatch(/^POST \/v1\/purchase\/suppliers\/sup-a\/debit-notes\/.+\/issue$/);
      await page.click('#lang');
      await says(page, '#page-h', /^விநியோகஸ்தர் உரிமைக்கோரல்கள்$/);
      expect(a.errors).toEqual([]);
    } finally { await a.close(); }
  });
});
