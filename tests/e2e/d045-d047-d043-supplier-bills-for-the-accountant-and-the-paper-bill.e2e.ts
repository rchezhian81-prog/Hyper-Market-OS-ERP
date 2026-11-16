import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startBoxPageShop, says, HAVE_BROWSER, type BoxPageShop } from './lib/r4c-box-page';
import { P3, p3Shop, caller, issuedOrder, received, capturedAndMatched } from '../support/p3-purchase';
import { ROLE_CATALOGUE } from '../../services/api/src/roles';
import { approvedRequestId } from '../support/approval-request';

/**
 * **Fix batch 3 (bills and receiving) — the Supplier bills page, in a real browser on the real store computer, with head
 * office's production routes behind it (in memory). Each task is done as the person would do it.**
 *
 *   • D-045: the ACCOUNTANT (who checks bills, but does not hand them in) sees the bills on head office's register waiting to
 *     be checked against their order, opens one with "Check against the order" and checks it; it then leaves the list. No
 *     role's permissions change: the list is head office's invoice register, read with a word the accountant already holds.
 *   • D-047: on "Record a payment", the bills it settles are TICK BOXES of the chosen supplier's matched, unpaid bills with
 *     their amounts and the running total — never bill numbers typed with commas; the ask names exactly the ticked bills.
 *   • D-043: the buyer types a PAPER bill with no scan or photo, fills its lines from the received order (quantities
 *     received, agreed prices), types only the total, and saves it onto head office's register; no file is handed in.
 *
 * Synthetic data only. Without a browser binary it SKIPS.
 */
const permsOf = (roleId: string): readonly string[] => ROLE_CATALOGUE.find((r) => r.id === roleId)!.permissions;
const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const [y, m, d] = day.split('-');
const ddmm = `${d}/${m}/${y}`;

interface Inv { readonly invoice: { readonly invoiceId: string; readonly capturedBy: string; readonly totalMinor: number; readonly lines: readonly { productId: string; quantity: number; unitPriceMinor: number }[] }; readonly match: { readonly blocked: boolean; readonly matchedBy: string } | null }

describe.skipIf(!HAVE_BROWSER)('fix batch 3 — the accountant checks bills, a payment ticks its bills, a paper bill is typed with no file', () => {
  let shop: BoxPageShop;
  beforeAll(async () => {
    shop = await startBoxPageShop({
      name: 'd045-bills',
      people: [
        { userId: P3.MATCHER, permissions: permsOf('accountant') },
        { userId: P3.PAYER, permissions: permsOf('accountant') },
        { userId: P3.BUYER, permissions: permsOf('store_manager') },
      ],
      seed: async (h, T) => {
        await p3Shop(h, T, 'sup-1');
        const call = caller(h, T);
        const rice = [{ productId: 'rice', qty: 10, unitMinor: 5_000 }];
        // inv-a: captured by the buyer, nobody has checked it yet (the accountant's work, D-045).
        await issuedOrder(call, 'po-a', rice);
        await received(call, 'grn-a', 'po-a', rice);
        const captured = await call('POST', '/v1/purchase/invoices/inv-a/capture', P3.BUYER, { supplierId: 'sup-1', poId: 'po-a', declaredTotalMinor: 50_000, lines: [{ productId: 'rice', quantity: 10, unitPriceMinor: 5_000, lineTotalMinor: 50_000 }] });
        if (captured.status >= 300) throw new Error(`capture inv-a: ${captured.status} ${JSON.stringify(captured.body)}`);
        // inv-b: captured and matched — agreed, ₹300 may be paid (D-047).
        const dal = [{ productId: 'dal', qty: 3, unitMinor: 10_000 }];
        await issuedOrder(call, 'po-b', dal);
        await received(call, 'grn-b', 'po-b', dal);
        await capturedAndMatched(call, 'inv-b', 'po-b', dal);
        // D-048 (fix batch 5): a bank payment is asked for only to a supplier whose bank account was checked — sup-1's is.
        const change = { newAccount: 'HDFC-0001-2345-6789', requestedVia: 'letter', calledBackOn: '+91-800-1', numberWeAlreadyHeld: '+91-800-1', requestedAt: '2026-09-30T08:00:00.000Z' };
        const approvalId = await approvedRequestId(h, T, P3.OWNER, P3.MATCHER, { kind: 'supplier_bank_change', subjectRef: 'sup-1', details: { ...change, supplierId: 'sup-1' } });
        const bank = await call('POST', '/v1/purchase/suppliers/sup-1/bank-details', P3.OWNER, { ...change, approvalId });
        if (bank.status >= 300) throw new Error(`bank sup-1: ${bank.status} ${JSON.stringify(bank.body)}`);
        // po-c: issued and received; its paper bill has not been typed yet (D-043).
        const paper = [{ productId: 'rice', qty: 8, unitMinor: 5_000 }, { productId: 'dal', qty: 4, unitMinor: 10_000 }];
        await issuedOrder(call, 'po-c', paper);
        await received(call, 'grn-c', 'po-c', paper);
      },
    });
  }, 300_000);
  afterAll(async () => { await shop?.stop(); });

  it('D-045: the accountant sees the bills waiting to be checked and checks one against its order', async () => {
    const p = await shop.open(P3.MATCHER, '/supplier-bills');
    try {
      const { page } = p;
      await says(page, '#register-h', /^Bills waiting to be checked against the order$/);
      expect(await page.isVisible('#register-h')).toBe(true);
      await says(page, '#check-only', /^Handing in and typing bills is done by a person with that right/);
      const row = page.locator('#register li[data-invoice="inv-a"]');
      await row.waitFor();
      expect(await row.getAttribute('data-state')).toBe('not_checked');
      expect(await row.innerText()).toMatch(/not checked yet/);
      expect(await row.innerText()).toMatch(/order po-a · Billed ₹500\.00/);
      // The matched, agreed bill is not waiting.
      expect(await page.locator('#register li[data-invoice="inv-b"]').count()).toBe(0);
      expect(await page.isHidden('#hand-section')).toBe(true);
      await row.locator('button[data-act="check"]').click();
      await says(page, '#match-invoice', /on the register as inv-a/);
      expect(await page.isVisible('#run-match')).toBe(true);
      await page.click('#run-match');
      await says(page, '#match-status', /^These agree — the bill may be paid$/);
      // Checked and agreed: it leaves the list.
      await says(page, '#register-status', /^No bill is waiting to be checked against its order\.$/);
      expect(p.writes).toEqual(['POST /v1/purchase/invoices/inv-a/match']);
      // Tamil.
      await page.click('#lang');
      await says(page, '#register-h', /^ஆர்டருடன் சரிபார்க்கக் காத்திருக்கும் பில்கள்$/);
      expect(p.errors).toEqual([]);
    } finally { await p.close(); }
    const held = (await shop.call('GET', '/v1/purchase/invoices/inv-a', P3.MATCHER)).body as Inv;
    expect(held.match).toMatchObject({ blocked: false, matchedBy: P3.MATCHER });
  });

  it('D-047: the payer ticks the supplier\'s matched, unpaid bills — with their amounts and the total — and the ask names exactly those', async () => {
    const p = await shop.open(P3.PAYER, '/supplier-bills');
    try {
      const { page } = p;
      await page.waitForSelector('#pay:not([hidden])');
      await page.waitForFunction('globalThis.sreOffice !== undefined');
      expect(await page.locator('#pay-settles').count(), 'no comma-separated box').toBe(0);
      await says(page, '#pay-bills-note', /^Choose the supplier to see their matched bills not yet paid\.$/);
      await page.fill('#pay-supplier', 'sup-1');
      await page.locator('#pay-bills-list label[data-bill="inv-b"]').waitFor();
      await page.locator('#pay-bills-list label[data-bill="inv-a"]').waitFor();
      expect(await page.locator('#pay-bills-list label[data-bill="inv-b"]').innerText()).toBe('inv-b — ₹300.00 may be paid');
      expect(await page.locator('#pay-bills-list label[data-bill="inv-a"]').innerText()).toBe('inv-a — ₹500.00 may be paid');
      await says(page, '#pay-bills-total', /^No bill ticked\.$/);
      await page.check('#pay-bills-list input[value="inv-b"]');
      await says(page, '#pay-bills-total', /^Ticked: 1 bill\(s\), ₹300\.00 in all$/);
      await page.check('#pay-bills-list input[value="inv-a"]');
      await says(page, '#pay-bills-total', /^Ticked: 2 bill\(s\), ₹800\.00 in all$/);
      expect(await page.inputValue('#pay-amount'), 'the amount follows the ticks').toBe('800.00');
      await page.fill('#pay-on', ddmm);
      await page.selectOption('#pay-method', 'bank_transfer');
      await page.fill('#pay-ref', 'NEFT-D047');
      await page.click('#pay-ask');
      await says(page, '#pay-status', /^Asked\./);
      expect(p.errors).toEqual([]);
    } finally { await p.close(); }
    const mine = (await shop.call('GET', '/v1/approvals/requests', P3.PAYER)).body as { mine: { kind: string; details: { settles?: string[]; amountMinor?: number } }[] };
    const ask = mine.mine.find((q) => q.kind === 'supplier_payment')!;
    expect([...(ask.details.settles ?? [])].sort()).toEqual(['inv-a', 'inv-b']);
    expect(ask.details.amountMinor).toBe(80_000);
  });

  it('D-043: the buyer types a paper bill with no file, fills its lines from the received order, and saves it', async () => {
    const p = await shop.open(P3.BUYER, '/supplier-bills');
    try {
      const { page } = p;
      await page.waitForFunction('globalThis.sreOffice !== undefined');
      expect(await page.locator('#bill-file').inputValue(), 'no file picked').toBe('');
      await page.click('#type-paper');
      await page.locator('#type-part').waitFor({ state: 'visible' });
      await says(page, '#drawer-h', /^Paper bill — typed, no file$/);
      await says(page, '#type-lede', /no scan or photo is needed/);
      await page.fill('#type-invoice', 'sup-1-P-9');
      await page.fill('#type-supplier', 'sup-1');
      await page.fill('#type-po', 'po-c');
      await page.click('#type-from-order');
      await says(page, '#type-status', /^Filled 2 line\(s\) from order po-c: the quantities received and the agreed prices\./);
      const r1 = page.locator('#type-lines tr[data-row="1"]');
      const r2 = page.locator('#type-lines tr[data-row="2"]');
      expect([await r1.locator('.t-productId').inputValue(), await r1.locator('.t-quantity').inputValue(), await r1.locator('.t-unitPrice').inputValue(), await r1.locator('.t-amount').inputValue()]).toEqual(['rice', '8', '50.00', '400.00']);
      expect([await r2.locator('.t-productId').inputValue(), await r2.locator('.t-quantity').inputValue(), await r2.locator('.t-unitPrice').inputValue(), await r2.locator('.t-amount').inputValue()]).toEqual(['dal', '4', '100.00', '400.00']);
      // Only what the paper says differently is typed: here, its total.
      await page.fill('#type-total', '800');
      await page.click('#type-save');
      await says(page, '#type-status', /^Saved — the bill is on head office's register as sup-1-P-9\.$/);
      await says(page, '#match-invoice', /^Typed onto the register as sup-1-P-9$/);
      expect(await page.isHidden('#type-part')).toBe(true);
      expect(p.writes).toEqual(['POST /v1/purchase/invoices/sup-1-P-9/capture']);
      expect(p.errors).toEqual([]);
    } finally { await p.close(); }
    const kept = (await shop.call('GET', '/v1/purchase/invoices/sup-1-P-9', P3.BUYER)).body as Inv;
    expect(kept.invoice).toMatchObject({ capturedBy: P3.BUYER, totalMinor: 80_000 });
    expect(kept.invoice.lines.map((l) => [l.productId, l.quantity, l.unitPriceMinor])).toEqual([['rice', 8, 5_000], ['dal', 4, 10_000]]);
  });
});
