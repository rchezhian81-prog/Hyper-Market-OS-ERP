import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readLog } from '../../edge/store-edge/src/file-log';
import { CONNECTED, OWNER, ok, startBoxPageOnCloud, type BoxCloudShop } from './lib/box-page-on-cloud';
import { says } from './lib/r4c-box-page';
import { setUpPracticeStores } from '../support/real-store';
import { approvedBody } from '../support/approval-request';
import { DEFAULT_RETAIL_POSTING_MAP } from '../../packages/finance/src/index';

/**
 * **W4 · M27-FR-03 · M27-FR-04 — ONE connected run of the concession desk: the Concessions page and the till's concession-tag
 * panel in Chromium, both served by a REAL store computer linked to head office, head office the PRODUCTION API on real
 * PostgreSQL.** Synthetic data only. (M27-FR-02 — the concessionaire's own login sees only its own counter and stock — is
 * proven connected on PostgreSQL by tests/e2e/ob676-a-concessionaire-sees-only-its-own-counter.e2e.ts, W3.)
 *
 *   • M27-FR-03 — the CA's GST gate stays as it is: with no GST treatment set the page says "Not set — the CA decides", the
 *     owner's preview is REFUSED in head office's words and no invoice can be issued (head office refuses it by name, nothing
 *     written). Then, in THIS TEST TENANT ONLY, the accountant records a SYNTHETIC 18% (not the CA's figure — the CA has not
 *     given one); the owner previews August's invoice for the gold counter, asks; the accountant approves in her own
 *     session; the owner issues it, and head office's books hold it figure for figure;
 *   • M27-FR-04 — the store computer pulls the counters' agreement terms from head office. On the till's concession-tag
 *     panel the silver counter, whose insurance has lapsed, is refused in the store computer's words before any money is
 *     taken, and nothing is saved; the gold counter's docket line saves, and the store computer's sync agent carries it to
 *     head office. Head office says the silver counter cannot take new sales, and holds no tag for it.
 * Needs DATABASE_URL and Chromium; else it SKIPS.
 */

const STORE = 'br-1';
const ACCT = 'u-acct';
const BOX = 'u-box';
const RULE = {
  kind: 'concession_settlement',
  legs: [
    { account: 'concession_collections_held', side: 'debit', component: 'collected' }, { account: 'concessionaire_receivable', side: 'debit', component: 'receivable' },
    { account: 'concession_income', side: 'credit', component: 'charge' }, { account: 'utilities_recovered', side: 'credit', component: 'utilities' },
    { account: 'gst_output_cgst', side: 'credit', component: 'cgst' }, { account: 'gst_output_sgst', side: 'credit', component: 'sgst' },
    { account: 'gst_output_igst', side: 'credit', component: 'igst' }, { account: 'payable_to_concessionaire', side: 'credit', component: 'payable' },
  ],
};
const year = new Date().getUTCFullYear();

describe.skipIf(!CONNECTED)('W4 · M27-FR-03/04 connected: a concession invoice and a lapsed counter, on the store computer over PostgreSQL', () => {
  let shop: BoxCloudShop;
  beforeAll(async () => {
    shop = await startBoxPageOnCloud({
      name: 'w4-m27-concessions', store: STORE,
      people: [{ userId: OWNER }, { userId: ACCT }],
      link: { boxUser: BOX },
      seed: async (cloud, h) => {
        await setUpPracticeStores(cloud, OWNER, [STORE]);
        await cloud.grant(ACCT, 'accountant');
        await cloud.grant(BOX, 'store_computer', undefined, [STORE]);
        let n = 0;
        const as = (method: 'POST' | 'PUT', path: string, body: unknown, userId = OWNER) => ok(cloud.request({ method, path, userId, idempotencyKey: `seed-${n += 1}`, body }), path);
        await as('PUT', '/v1/platform/entitlements/dept.concession', { enabled: true });
        const contract = async (contractId: string, terms: Record<string, unknown>) =>
          as('POST', `/v1/concession/contracts/${contractId}`, await approvedBody(h, cloud.tenantId, OWNER, ACCT, 'concession_contract', contractId, terms, { contractId }));
        // The gold counter, in date; the silver counter, whose insurance ran out at the end of last year.
        await contract('ct-gold', { concessionaireId: 'cx-gold', name: 'Gold counter', branchId: STORE, startsOn: `${year - 1}-01-01`, endsOn: `${year + 1}-12-31`, basis: 'revenue_share', revenueShareBps: 1_500, depositMinor: 5_000_000, utilitiesMinor: 50_000, insuranceUntil: `${year + 1}-12-31`, licenceUntil: `${year + 1}-12-31` });
        await contract('ct-silver', { concessionaireId: 'cx-silver', name: 'Silver counter', branchId: STORE, startsOn: `${year - 1}-01-01`, endsOn: `${year + 1}-12-31`, basis: 'revenue_share', revenueShareBps: 1_200, depositMinor: 1_000_000, insuranceUntil: `${year - 1}-12-31`, licenceUntil: `${year + 1}-12-31` });
        await as('POST', '/v1/concession/contracts/ct-gold/sales', { saleId: 's1', grossMinor: 20_000_000, taxMinor: 0, tenderedTo: 'store_till', at: `${year - 1}-08-05T10:00:00.000Z` });
        await as('PUT', '/v1/finance/posting-map', { rules: [...DEFAULT_RETAIL_POSTING_MAP.rules, RULE] }, ACCT);
      },
    });
  }, 300_000);
  afterAll(async () => { await shop?.stop(); });

  // Last year's August: always a whole month already past, whenever this runs.
  const period = { from: `${year - 1}-08-01`, to: `${year - 1}-08-31` };

  it('M27-FR-03: no GST from the CA → refused, nothing issued; a synthetic test rate in this test tenant → previewed, approved by a second person, issued, in the books', async () => {
    // ── The gate: the CA has given no GST treatment.
    const a = await shop.open(ACCT, '/concessions');
    expect(a.status).toBe(200);
    await says(a.page, '#ci-gst', /Not set — the CA decides/);
    const o = await shop.open(OWNER, '/concessions');
    await o.page.waitForSelector('#invoices:not([hidden])');
    await o.page.selectOption('#m-contract', 'ct-gold');
    await o.page.fill('#m-from', period.from); await o.page.fill('#m-to', period.to); await o.page.fill('#m-banked', '2,00,000');
    await o.page.click('#ci-preview');
    await says(o.page, '#ci-status', /The CA has not yet said which GST applies/);
    expect(await o.page.isVisible('#ci-ask'), 'nothing to ask for without the CA\'s GST').toBe(false);
    // Head office refuses an invoice by name, and writes nothing.
    const refused = await shop.call('POST', '/v1/concession/contracts/ct-gold/invoices/inv-no-gst', OWNER, { ...period, bankedForThemMinor: 20_000_000 });
    expect(refused.status).toBe(409);
    expect(JSON.stringify(refused.body)).toContain('concession_gst_not_set');
    expect(JSON.stringify((await shop.call('GET', '/v1/concession/contracts/ct-gold/invoices', OWNER)).body)).not.toContain('CI/');

    // ── THIS TEST TENANT ONLY: a synthetic 18% recorded by the accountant (the CA has given no figure; nothing else changes).
    await a.page.fill('#ci-rent', '18'); await a.page.fill('#ci-share', '18'); await a.page.fill('#ci-util', '18');
    await a.page.fill('#ci-note', 'SYNTHETIC test rate for this test tenant only — not the CA\'s figure');
    await a.page.click('#ci-save-gst');
    await says(a.page, '#ci-status', /^GST treatment saved as version 1\.$/);
    await says(a.page, '#ci-gst', /Revenue share 18% .*within the state/);
    expect(a.errors).toEqual([]);
    await a.close();

    await o.page.click('#ci-preview');
    await says(o.page, '#ci-figs', /Invoice total\s*₹35,990\.00/);
    await says(o.page, '#ci-figs', /Net payable to them\s*₹1,64,010\.00/);
    await says(o.page, '#ci-figs', /Deposit held \(not netted\)\s*₹50,000\.00/);
    await o.page.click('#ci-ask');
    await says(o.page, '#ci-status', /^Asked\./);
    // The accountant approves in her own session (a different person from the one who asked).
    const mine = (await shop.call('GET', '/v1/approvals/requests', OWNER)).body as { mine: { requestId: string; kind: string }[] };
    const req = mine.mine.find((m) => m.kind === 'concession_invoice')!;
    const decided = await shop.call('POST', `/v1/approvals/requests/${req.requestId}/decide`, ACCT, { decision: 'approved', reason: 'checked against the counter (synthetic)' });
    expect(decided.status, JSON.stringify(decided.body)).toBeLessThan(300);
    await o.page.click('#ci-preview');
    await o.page.waitForSelector('#ci-issue:not([hidden])');
    await o.page.click('#ci-issue');
    await says(o.page, '#ci-status', /^Issued CI\/\d{4}-\d{2}\/0001\.$/);
    await says(o.page, '#ci-rows', /CI\/\d{4}-\d{2}\/0001.*in the books, figure for figure/);
    // Head office holds the invoice on PostgreSQL, with the synthetic rate it was written under.
    const held = (await ok(shop.call('GET', '/v1/concession/contracts/ct-gold/invoices', OWNER), 'invoices')) as { invoices: { number: string; invoiceTotalMinor: number; netPayableToThemMinor: number }[] };
    expect(held.invoices.map((i) => [i.invoiceTotalMinor, i.netPayableToThemMinor])).toEqual([[35_990_00, 1_64_010_00]]);
    expect(o.errors).toEqual([]);
    await o.close();
  }, 240_000);

  it('M27-FR-04: the store computer pulls the counters\' terms; the lapsed silver counter is refused on the tag panel before any money, the gold one saves and reaches head office', async () => {
    expect((await shop.edge.refreshConcessionTrading!()).status).toBe('updated');
    // Head office's own judgement: the silver counter cannot take new sales (its insurance lapsed).
    const silver = (await ok(shop.call('GET', '/v1/concession/contracts/ct-silver/may-trade', OWNER), 'may-trade')) as { mayTrade: boolean; blockedBy: string[] };
    expect(silver).toMatchObject({ mayTrade: false, blockedBy: ['insurance_lapsed'] });

    const p = await shop.open(OWNER, `/pos/concession-tag.html?lane=${shop.edge.lane!.port}`);
    const fill = async (concessionaireId: string, saleId: string) => {
      const values: Record<string, string> = {
        capturedBy: 'u-cashier-w4', tillId: 'till-1', saleId, concessionaireId, counterId: `counter-${concessionaireId}`,
        productId: 'item-1', qty: '1', grossMinor: '50000', discountMinor: '0', taxMinor: '1500', source: 'docket-w4',
      };
      for (const [id, v] of Object.entries(values)) await p.page.fill(`#${id}`, v);
    };
    await fill('cx-silver', 'S-W4-1');
    await p.page.click('#record');
    await says(p.page, '#status', /may not trade/);
    const said = await p.page.locator('#status').innerText();
    expect(said).toMatch(/insurance is not in date/);
    expect(said).toMatch(/Do not take money/);
    expect(await readLog(shop.edge.concessionTagsLog.path)).toHaveLength(0);

    await fill('cx-gold', 'S-W4-2');
    await p.page.click('#record');
    await says(p.page, '#status', /Saved/);
    expect(await readLog(shop.edge.concessionTagsLog.path)).toHaveLength(1);
    expect(p.errors).toEqual([]);
    await p.close();

    // The store computer's sync agent carries the gold counter's line to head office; nothing ever left for the silver one.
    const pass = await shop.edge.syncOnce!();
    expect(pass.dead, JSON.stringify(pass)).toBe(0);
    await expect.poll(async () => JSON.stringify((await shop.call('GET', '/v1/concession/contracts/ct-gold/tags', OWNER)).body), { timeout: 15_000 }).toContain('S-W4-2');
    expect(JSON.stringify((await shop.call('GET', '/v1/concession/contracts/ct-silver/tags', OWNER)).body)).not.toContain('S-W4-1');
  }, 180_000);
});
