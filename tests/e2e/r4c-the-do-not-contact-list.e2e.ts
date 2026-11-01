import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { HAVE_BROWSER, startBoxPageShop, says, type BoxPageShop } from './lib/r4c-box-page';
import { aBranch } from '../support/a-branch';

/**
 * **Round 4c (M31-FR-04): the Do not contact page, on the store computer, over head office's suppression register.**
 *   • the store manager records that customer c-77 asked never to be sent SMS (with why); head office then holds it, and
 *     the history shows who recorded it; lifting it needs a reason and keeps the earlier entry on the record;
 *   • a cashier the box lets open the page is refused by head office, in its words, and offered no add.
 */

const OWNER = 'u-owner'; const MGR = 'u-mgr'; const CASH = 'u-cash';
const WORDS = ['notification.send.check', 'notification.suppression.manage'];

describe.skipIf(!HAVE_BROWSER)('Do not contact (Round 4c)', () => {
  let shop: BoxPageShop;
  beforeAll(async () => {
    shop = await startBoxPageShop({
      name: 'dnc',
      people: [{ userId: MGR, permissions: WORDS }, { userId: CASH, permissions: ['notification.send.check'] }],
      seed: async (ho, T, store) => {
        await ho.seedOwner(T, OWNER);
        await aBranch(ho, T, OWNER, store);
        await ho.provisionRole(T, MGR, 'store_manager', [store]);
        await ho.provisionRole(T, CASH, 'cashier', [store]);
      },
    });
  }, 240_000);
  afterAll(async () => { await shop?.stop(); });

  it('the manager records a customer\'s "no SMS", then lifts it with a reason — both kept', async () => {
    const m = await shop.open(MGR, '/do-not-contact/');
    await says(m.page, '#rows', /Nobody is on the do-not-contact list\./);
    await m.page.fill('#a-customer', 'c-77'); await m.page.selectOption('#a-channel', 'sms'); await m.page.selectOption('#a-source', 'customer_request');
    await m.page.click('#a-add');
    await says(m.page, '#add-status', /^Say why\.$/);
    await m.page.fill('#a-reason', 'asked at the desk, 1 Nov');
    await m.page.click('#a-add');
    await says(m.page, '#add-status', /^Added\./);
    await says(m.page, '#rows li[data-customer="c-77"]', /c-77 — not to be contacted: SMS/);
    await says(m.page, '#history', /c-77 · SMS · not to be contacted \(the customer asked\).*by u-mgr/);
    const held = (await shop.call('GET', '/v1/notifications/suppressions', OWNER)).body as { suppressed: { customerId: string; channels: string[] }[] };
    expect(held.suppressed).toEqual([{ customerId: 'c-77', channels: ['sms'] }]);
    await m.page.fill('#rows li[data-customer="c-77"] [data-channel="sms"] input', 'customer asked to hear about offers again');
    await m.page.click('#rows li[data-customer="c-77"] [data-channel="sms"] button');
    await says(m.page, '#rows', /Nobody is on the do-not-contact list\./);
    expect(await m.page.$$('#history li')).toHaveLength(2);
    await m.page.click('#lang');
    await says(m.page, '#list-h', /^தொடர்பு கொள்ளக்கூடாதவர்கள்$/);
    expect(m.errors).toEqual([]);
    await m.close();
  });

  it('a cashier is refused by head office, in its words, and offered no add', async () => {
    const c = await shop.open(CASH, '/do-not-contact/');
    await says(c.page, '#list-status', /^Head office refused:/);
    expect(await c.page.isVisible('#add')).toBe(false);
    await c.close();
  });
});
