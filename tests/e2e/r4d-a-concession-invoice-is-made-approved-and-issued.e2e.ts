import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { HAVE_BROWSER, startBoxPageShop, says, type BoxPageShop } from './lib/r4c-box-page';
import { aBranch } from '../support/a-branch';
import { approvedBody } from '../support/approval-request';
import { DEFAULT_RETAIL_POSTING_MAP } from '../../packages/finance/src/index';

/**
 * **Round 4d (M27-FR-03): a concession invoice on the Concessions page, on the store computer.**
 *   • the accountant records the GST the CA confirmed (until then the page says it is not set);
 *   • the owner previews August's invoice for the gold counter (the share, utilities, GST, what our tills held, the net
 *     payable and the deposit stated, not netted), asks for approval; the accountant approves in her own session; the owner
 *     issues it: CI/2026-27/0001, and the list says the books hold it figure for figure;
 *   • a cashier the box lets open the page is refused by head office.
 */

const OWNER = 'u-owner'; const ACCT = 'u-acct'; const CASH = 'u-cash';
const READ = ['concession.charge.read']; const MANAGE = [...READ, 'concession.contract.manage'];
const RULE = {
  kind: 'concession_settlement',
  legs: [
    { account: 'concession_collections_held', side: 'debit', component: 'collected' }, { account: 'concessionaire_receivable', side: 'debit', component: 'receivable' },
    { account: 'concession_income', side: 'credit', component: 'charge' }, { account: 'utilities_recovered', side: 'credit', component: 'utilities' },
    { account: 'gst_output_cgst', side: 'credit', component: 'cgst' }, { account: 'gst_output_sgst', side: 'credit', component: 'sgst' },
    { account: 'gst_output_igst', side: 'credit', component: 'igst' }, { account: 'payable_to_concessionaire', side: 'credit', component: 'payable' },
  ],
};

describe.skipIf(!HAVE_BROWSER)('Concession invoices (Round 4d)', () => {
  let shop: BoxPageShop;
  beforeAll(async () => {
    shop = await startBoxPageShop({
      name: 'concession-invoice',
      people: [{ userId: OWNER, permissions: MANAGE }, { userId: ACCT, permissions: [...MANAGE, 'finance.posting.configure'] }, { userId: CASH, permissions: READ }],
      seed: async (ho, T, store) => {
        await ho.seedOwner(T, OWNER);
        await aBranch(ho, T, OWNER, store);
        await ho.provisionRole(T, ACCT, 'accountant');
        await ho.provisionRole(T, CASH, 'cashier', [store]);
        await ho.enableFeature(T, 'dept.concession');
        const send = async (method: 'POST' | 'PUT', path: string, userId: string, body: unknown, key: string) => {
          const r = await ho.request({ method, path, userId, tenantId: T, idempotencyKey: key, body });
          if (r.status >= 300) throw new Error(`${path}: ${JSON.stringify(r.body)}`);
        };
        const terms = { concessionaireId: 'cx-gold', name: 'Gold counter', branchId: store, startsOn: '2026-01-01', endsOn: '2027-12-31', basis: 'revenue_share', revenueShareBps: 1_500, depositMinor: 5_000_000, utilitiesMinor: 50_000, insuranceUntil: '2027-12-31', licenceUntil: '2027-12-31' };
        await send('POST', '/v1/concession/contracts/ct-gold', OWNER, await approvedBody(ho, T, OWNER, ACCT, 'concession_contract', 'ct-gold', terms, { contractId: 'ct-gold' }), 'ct');
        await send('POST', '/v1/concession/contracts/ct-gold/sales', OWNER, { saleId: 's1', grossMinor: 20_000_000, taxMinor: 0, tenderedTo: 'store_till', at: '2026-08-05T10:00:00.000Z' }, 's1');
        await send('PUT', '/v1/finance/posting-map', ACCT, { rules: [...DEFAULT_RETAIL_POSTING_MAP.rules, RULE] }, 'map');
      },
    });
  }, 240_000);
  afterAll(async () => { await shop?.stop(); });

  it('the accountant sets the GST; the owner makes the invoice, the accountant approves, the owner issues it', async () => {
    const a = await shop.open(ACCT, '/concessions');
    await says(a.page, '#ci-gst', /Not set — the CA decides/);
    await a.page.fill('#ci-rent', '18'); await a.page.fill('#ci-share', '18'); await a.page.fill('#ci-util', '18');
    await a.page.click('#ci-save-gst');
    await says(a.page, '#ci-status', /^GST treatment saved as version 1\.$/);
    await says(a.page, '#ci-gst', /Revenue share 18% .*within the state/);
    await a.close();

    const o = await shop.open(OWNER, '/concessions');
    await o.page.waitForSelector('#invoices:not([hidden])');
    await o.page.selectOption('#m-contract', 'ct-gold');
    await o.page.fill('#m-from', '2026-08-01'); await o.page.fill('#m-to', '2026-08-31'); await o.page.fill('#m-banked', '2,00,000');
    await o.page.click('#ci-preview');
    await says(o.page, '#ci-figs', /Invoice total\s*₹35,990\.00/);
    await says(o.page, '#ci-figs', /Net payable to them\s*₹1,64,010\.00/);
    await says(o.page, '#ci-figs', /Deposit held \(not netted\)\s*₹50,000\.00/);
    await o.page.click('#ci-ask');
    await says(o.page, '#ci-status', /^Asked\./);
    // the accountant approves in her own session
    const mine = (await shop.call('GET', '/v1/approvals/requests', OWNER)).body as { mine: { requestId: string; kind: string }[] };
    const req = mine.mine.find((m) => m.kind === 'concession_invoice')!;
    const decided = await shop.call('POST', `/v1/approvals/requests/${req.requestId}/decide`, ACCT, { decision: 'approved', reason: 'checked against the counter (synthetic)' });
    expect(decided.status, JSON.stringify(decided.body)).toBeLessThan(300);
    await o.page.click('#ci-preview');
    await o.page.waitForSelector('#ci-issue:not([hidden])');
    await o.page.click('#ci-issue');
    await says(o.page, '#ci-status', /^Issued CI\/2026-27\/0001\.$/);
    await says(o.page, '#ci-rows', /CI\/2026-27\/0001.*in the books, figure for figure/);
    await o.page.click('#lang');
    await says(o.page, '#ci-h', /^சலுகையாளருக்கான விலைப்பட்டியல்கள்$/);
    expect(o.errors).toEqual([]);
    await o.close();
  });

  it('a cashier is refused by head office and offered no invoice action', async () => {
    const c = await shop.open(CASH, '/concessions');
    await says(c.page, '#page-status', /Head office refused:|cannot/);
    expect(await c.page.isVisible('#ci-ask')).toBe(false);
    expect(c.writes).toEqual([]);
    await c.close();
  });
});
