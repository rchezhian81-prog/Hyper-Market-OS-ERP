import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { HAVE_BROWSER, startBoxPageShop, says, type BoxPageShop } from './lib/r4c-box-page';

/**
 * **Round 4d (M23-FR-01 · Screen D): the Accounts and Tally names page, on the store computer, over head office's posting map
 * and Tally ledger names.**
 *   • the accountant opens it: nothing is defined (said, never a zero); she puts every suggested rule in the change, maps
 *     Supplier offer funding (no account suggested — she types both), saves version 1; head office holds it, and the history
 *     says who saved it and why; she names an account in Tally with the company and saves the names as version 1;
 *   • the store manager may look but is offered no change; a cashier is refused by head office, in its words.
 */

const OWNER = 'u-owner'; const ACCT = 'u-acct'; const MGR = 'u-mgr'; const CASH = 'u-cash';

describe.skipIf(!HAVE_BROWSER)('Accounts and Tally names (Round 4d)', () => {
  let shop: BoxPageShop;
  beforeAll(async () => {
    shop = await startBoxPageShop({
      name: 'posting-map',
      people: [{ userId: ACCT, permissions: ['finance.period.read', 'finance.posting.configure'] }, { userId: MGR, permissions: ['finance.period.read'] }, { userId: CASH, permissions: ['finance.period.read'] }],
      seed: async (ho, T, store) => {
        await ho.seedOwner(T, OWNER);
        await ho.provisionRole(T, ACCT, 'accountant');
        await ho.provisionRole(T, MGR, 'store_manager', [store]);
        await ho.provisionRole(T, CASH, 'cashier', [store]);
      },
    });
  }, 240_000);
  afterAll(async () => { await shop?.stop(); });

  it('the accountant maps the kinds, saves version 1, and names an account in Tally', async () => {
    const a = await shop.open(ACCT, '/posting-map');
    await says(a.page, '#cards', /Posting map in force\s*none defined yet/);
    await says(a.page, '#kinds-count', /Showing 1–10 of \d+/);
    await a.page.fill('#kinds-search', 'offer funding');
    await says(a.page, '#kind-rows tr[data-key="promotion_funding"]', /waiting for a rule — nothing suggested/);
    // the save refuses an empty change before anything is sent
    await a.page.click('#save-map');
    await says(a.page, '#map-status', /^Nothing has changed yet\.$/);
    await a.page.click('#adopt-all');
    await says(a.page, '#map-status', /suggested rules put in the change/);
    // Supplier offer funding: no account suggested — both are typed by her
    await a.page.click('#kind-rows tr[data-key="promotion_funding"] .sre-row-open');
    expect(await a.page.inputValue('#leg-0')).toBe('');
    await a.page.click('#keep-legs');
    await says(a.page, '#leg-0-msg', /Fill in/);
    await a.page.fill('#leg-0', 'bank_clearing');
    await a.page.fill('#leg-1', 'offer_funding_income');
    await a.page.click('#keep-legs');
    await says(a.page, '#draft-kinds li[data-kind="promotion_funding"]', /Debit bank_clearing · Credit offer_funding_income/);
    await a.page.fill('#map-note', 'first map, from the suggestion');
    expect(a.writes).toEqual([]);
    await a.page.click('#save-map');
    await says(a.page, '#map-status', /^Saved as version 1\.$/);
    await says(a.page, '#cards', /Posting map in force\s*version 1/);
    await says(a.page, '#map-history li[data-version="1"]', /by u-acct.*first map, from the suggestion/);
    const held = (await shop.call('GET', '/v1/finance/posting-map', ACCT)).body as { map: { version: number; rules: { kind: string; legs: { account: string }[] }[] } };
    expect(held.map.version).toBe(1);
    expect(held.map.rules.find((r) => r.kind === 'promotion_funding')?.legs.map((l) => l.account)).toEqual(['bank_clearing', 'offer_funding_income']);
    expect(held.map.rules.some((r) => r.kind === 'sale')).toBe(true);

    // Tally names: the accounts the map in force posts to are listed, none named yet
    await a.page.fill('#accounts-search', 'sales_revenue');
    await says(a.page, '#account-rows tr[data-key="sales_revenue"]', /not named/);
    await a.page.click('#account-rows tr[data-key="sales_revenue"] .sre-row-open');
    await a.page.fill('#tally-name', 'Sales Accounts');
    await a.page.click('#keep-name');
    await says(a.page, '#account-rows tr[data-key="sales_revenue"]', /Sales Accounts/);
    await a.page.click('#save-names');
    await says(a.page, '#names-form', /Fill in/);
    await a.page.fill('#company', 'SRE Hyper Market');
    await a.page.click('#save-names');
    await says(a.page, '#names-status', /^Tally names saved as version 1\.$/);
    const names = (await shop.call('GET', '/v1/finance/tally/ledger-names', ACCT)).body as { ledgerNames: { companyName: string; names: Record<string, string>; setBy: string } };
    expect(names.ledgerNames).toMatchObject({ companyName: 'SRE Hyper Market', names: { sales_revenue: 'Sales Accounts' }, setBy: ACCT });
    await a.page.click('#lang');
    await says(a.page, '#map-h', /^பதிவு வரைபடம்$/);
    expect(a.errors).toEqual([]);
    await a.close();
  });

  it('the store manager looks but is offered no change; a cashier is refused by head office', async () => {
    const m = await shop.open(MGR, '/posting-map');
    await says(m.page, '#page-status', /changing it needs the accountant's permission/);
    await says(m.page, '#kind-rows', /in force/);
    expect(await m.page.isVisible('#draft')).toBe(false);
    expect(await m.page.isVisible('#names-form')).toBe(false);
    await m.close();
    const c = await shop.open(CASH, '/posting-map');
    await says(c.page, '#page-status', /^Head office refused:/);
    expect(c.writes).toEqual([]);
    await c.close();
  });
});
