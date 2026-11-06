import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { HAVE_BROWSER, startBoxPageShop, says, type BoxPageShop } from './lib/r4c-box-page';
import { aBranch } from '../support/a-branch';

/**
 * **Wave 2 (M04-FR-04 · D02-FR-06 · §28 "Finance approves funding terms"): Supplier display space, on the store computer,
 * over head office's display-contract register and its maker-checker.** In a real browser:
 *   • with nothing recorded the register says "nothing yet" and the cards say 0 — never "all clear";
 *   • the manager records a tea end cap: it stands "Waiting for Finance"; she asks Finance to approve exactly those terms;
 *     the accountant approves in her own session; the manager records it again and it names the accountant; the register
 *     then says the money has not come in (Finance's journals hold none);
 *   • a cashier the box lets open the page is refused by head office in its words and offered no form; Tamil words.
 * Synthetic data only.
 */

const OWNER = 'u-owner'; const MGR = 'u-mgr'; const ACCT = 'u-acct'; const CASH = 'u-cash';

describe.skipIf(!HAVE_BROWSER)('Supplier display space (Wave 2)', () => {
  let shop: BoxPageShop;
  beforeAll(async () => {
    shop = await startBoxPageShop({
      name: 'display',
      people: [{ userId: MGR, permissions: ['merchandising.space.read', 'merchandising.display.manage'] }, { userId: CASH, permissions: ['merchandising.space.read'] }],
      seed: async (ho, T, store) => {
        await ho.seedOwner(T, OWNER);
        await aBranch(ho, T, OWNER, store);
        await ho.provisionRole(T, MGR, 'store_manager', [store]);
        await ho.provisionRole(T, ACCT, 'accountant', [store]);
        await ho.provisionRole(T, CASH, 'cashier', [store]);
      },
    });
  }, 240_000);
  afterAll(async () => { await shop?.stop(); });

  it('the manager records a contract, Finance approves exactly those terms, and the record names the approver', async () => {
    const m = await shop.open(MGR, '/display-contracts/');
    await says(m.page, '#register', /No display contracts yet/);
    await says(m.page, '#cards', /Display contracts\s*0/);
    const year = new Date().getFullYear();
    await m.page.fill('#c-id', 'DC-TEA'); await m.page.fill('#c-supplier', 'SUP-TEA'); await m.page.fill('#c-what', 'Tea end cap by the tills');
    expect(await m.page.inputValue('#c-store')).toBe(shop.store);
    await m.page.fill('#c-places', 'END-1'); await m.page.fill('#c-money', '5000');
    await m.page.fill('#c-from', `${year}-01-01`); await m.page.fill('#c-to', `${year + 1}-12-31`);
    await m.page.click('#record');
    await says(m.page, '#form-status', /^Recorded\. It waits for Finance/);
    await says(m.page, '#contract-rows tr[data-contract="DC-TEA"]', /Waiting for Finance/);
    await says(m.page, '#cards', /Waiting for Finance\s*1/);

    await m.page.fill('#why', 'Tea supplier pays for the end cap this year');
    await m.page.click('#ask');
    await says(m.page, '#form-status', /^Asked\./);
    const inbox = (await shop.call('GET', '/v1/approvals/requests', ACCT)).body as { waitingForMe: { requestId: string; kind: string; subjectRef: string }[] };
    const request = inbox.waitingForMe.find((r) => r.kind === 'display_contract' && r.subjectRef === 'DC-TEA');
    expect(request).toBeDefined();
    expect((await shop.call('POST', `/v1/approvals/requests/${request!.requestId}/decide`, ACCT, { decision: 'approved', reason: 'checked the letter' })).status).toBe(201);

    await m.page.click('#record');
    await says(m.page, '#form-status', /^Recorded with the approval of u-acct\.$/);
    await says(m.page, '#contract-rows tr[data-contract="DC-TEA"]', /Money not received/);
    await m.page.click('#contract-rows tr[data-contract="DC-TEA"] button');
    await says(m.page, '#sre-drawer', /Approved by\s*u-acct/);
    await says(m.page, '#sre-drawer', /₹5,000\.00 of the agreed money has not come in/);
    await m.page.keyboard.press('Escape');

    await m.page.click('#lang');
    await says(m.page, '#page-h', /^சப்ளையர் காட்சி இடம்$/);
    expect(m.errors).toEqual([]);
    await m.close();
  });

  it('a cashier is refused by head office, in its words, and offered no form', async () => {
    const c = await shop.open(CASH, '/display-contracts/');
    await says(c.page, '#page-status', /^Head office refused:/);
    expect(await c.page.isVisible('#form-section')).toBe(false);
    expect(c.writes).toEqual([]);
    await c.close();
  });
});
