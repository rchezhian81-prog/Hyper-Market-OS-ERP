import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { HAVE_BROWSER, startBoxPageShop, says, type BoxPageShop } from './lib/r4c-box-page';
import { aBranch } from '../support/a-branch';

/**
 * **W3 (D07-FR-04 · M17-FR-03 · M21-FR-03): the Gift cards and Compensation limits pages, on the store computer, over head
 * office's own stored-value and service-desk routes. Synthetic cards only.**
 *   • the manager issues a ₹1,000 demo gift card; issuing the same card number again is refused (it would create money the
 *     shop never took); a ₹300 phone-order payment is taken and the balance reads ₹700 from head office's own movements;
 *     a ₹800 payment is refused (a card never goes below zero) and nothing is taken;
 *   • the compensation limits read head office's standard ones until the owner sets the shop's own; an agent limit above the
 *     ceiling is refused before sending; the owner sets ₹300 / ₹3,000 and head office holds exactly that; the manager may
 *     read the limits but not change them.
 */

const OWNER = 'u-owner'; const MGR = 'u-mgr';
const CARD_WORDS = ['loyalty.value.read', 'loyalty.value.issue', 'loyalty.value.redeem'];

describe.skipIf(!HAVE_BROWSER)('Gift cards and compensation limits (W3 · D07-FR-04 · M21-FR-03)', () => {
  let shop: BoxPageShop;
  beforeAll(async () => {
    shop = await startBoxPageShop({
      name: 'gift-cards',
      people: [{ userId: OWNER, permissions: [...CARD_WORDS, 'service.case.read', 'service.compensation.approve'] }, { userId: MGR, permissions: [...CARD_WORDS, 'service.case.read'] }],
      seed: async (ho, T, store) => {
        await ho.seedOwner(T, OWNER);
        await aBranch(ho, T, OWNER, store);
        await ho.provisionRole(T, MGR, 'store_manager', [store]);
      },
    });
  }, 240_000);
  afterAll(async () => { await shop?.stop(); });

  it('a demo card is issued once, a payment is taken from it, and it never goes below zero', async () => {
    const m = await shop.open(MGR, '/gift-cards/');
    await says(m.page, '#look-h', /^Look up a card$/);
    expect(m.writes, 'nothing is written on open').toEqual([]);
    await m.page.fill('#i-card', 'DEMO-GC-0001'); await m.page.fill('#i-owner', 'demo-buyer'); await m.page.fill('#i-value', '1000');
    await m.page.click('#i-issue');
    await says(m.page, '#issue-status', /^Issued\. The card holds ₹1,000\.00\.$/);
    await m.page.click('#i-issue');
    await says(m.page, '#issue-status', /^Head office refused: instrument DEMO-GC-0001 has already been issued/);

    await m.page.fill('#d-card', 'DEMO-GC-0001'); await m.page.fill('#d-amount', '300'); await m.page.selectOption('#d-channel', 'phone');
    await m.page.click('#d-redeem');
    await says(m.page, '#redeem-status', /^Taken\. The card now holds ₹700\.00\.$/);
    await says(m.page, '#card .balance', /^Balance: ₹700\.00$/);
    await says(m.page, '#card', /₹300\.00 · /);

    await m.page.fill('#d-amount', '800');
    await m.page.click('#d-redeem');
    await says(m.page, '#redeem-status', /^Head office refused:/);
    const held = (await shop.call('GET', '/v1/stored-value/instruments/DEMO-GC-0001', OWNER)).body as { balanceMinor: number; kind: string; redemptions: unknown[] };
    expect(held).toMatchObject({ balanceMinor: 70_000, kind: 'gift_card' });
    expect(held.redemptions).toHaveLength(1);
    await m.page.click('#lang');
    await says(m.page, '#look-h', /^அட்டையைத் தேடு$/);
    expect(m.errors).toEqual([]);
    await m.close();
  });

  it('the compensation limits: head office\'s standard until the owner sets ₹300 / ₹3,000; the manager reads them, cannot change them', async () => {
    const o = await shop.open(OWNER, '/compensation-limits/');
    await says(o.page, '#now-limits', /One agent alone, up to \(₹\) ₹500\.00 · Desk ceiling, whoever signs \(₹\) ₹5,000\.00/);
    await says(o.page, '#now-source', /standard limits/);
    await o.page.fill('#s-agent', '3000'); await o.page.fill('#s-ceiling', '300');
    await o.page.click('#s-save');
    await says(o.page, '#set-status', /^An agent's own limit cannot be above the desk ceiling\.$/);
    expect(o.writes).toEqual([]);
    await o.page.fill('#s-agent', '300'); await o.page.fill('#s-ceiling', '3000');
    await o.page.click('#s-save');
    await says(o.page, '#set-status', /^Saved\./);
    await says(o.page, '#now-source', /^Set by the owner$/);
    expect((await shop.call('GET', '/v1/service/compensation-policy', OWNER)).body).toMatchObject({ agentAuthorityMinor: 30_000, deskCeilingMinor: 300_000, isDefault: false });
    expect(o.errors).toEqual([]);
    await o.close();

    const m = await shop.open(MGR, '/compensation-limits/');
    await says(m.page, '#now-limits', /₹300\.00 · .*₹3,000\.00/);
    await says(m.page, '#page-status', /only the owner can change them/);
    expect(await m.page.isVisible('#set')).toBe(false);
    await m.close();
  });
});
