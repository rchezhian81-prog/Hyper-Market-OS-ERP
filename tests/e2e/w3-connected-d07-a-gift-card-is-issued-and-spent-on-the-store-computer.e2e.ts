import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { CONNECTED, OWNER, startBoxPageOnCloud, type BoxCloudShop } from './lib/box-page-on-cloud';
import { says } from './lib/r4c-box-page';
import { aBranch } from '../support/a-branch';

/**
 * **W3 · D07 (D07-FR-04 gift cards and store credit · M17-FR-03): ONE connected run — the Gift cards page in a real
 * browser, served by a REAL store computer, over the PRODUCTION API on real PostgreSQL.** Synthetic cards only.
 *   • the box serves the page to the store manager because head office's own answer for her (`/v1/identity/me`) holds the
 *     gift-card words; nothing is written on open;
 *   • she issues a ₹1,000 demo card; issuing the same card number again is refused by head office (it would create money
 *     the shop never took); a ₹300 phone-order payment is taken and the balance reads ₹700 from head office's own
 *     movements on PostgreSQL; an ₹800 payment is refused — a card never goes below zero — and nothing more is taken;
 *   • after a reload, the card still reads ₹700 (held by head office, not the page); Tamil words; no page errors;
 *   • with head office gone, the box still serves the page and it says plainly that nothing was taken (P-08).
 * Needs DATABASE_URL and Chromium; else it SKIPS.
 */

const MGR = 'u-mgr';

describe.skipIf(!CONNECTED)('D07 connected: a gift card issued and spent on the store computer, over the real cloud on PostgreSQL', () => {
  let shop: BoxCloudShop;
  beforeAll(async () => {
    shop = await startBoxPageOnCloud({
      name: 'd07-gift-cards',
      people: [{ userId: MGR, branchId: 'store-1' }],
      seed: async (cloud, h, store) => {
        await aBranch(h, cloud.tenantId, OWNER, store);
        await cloud.grant(MGR, 'store_manager', undefined, [store]);
      },
    });
  }, 300_000);
  afterAll(async () => { await shop?.stop(); });

  it('issued once, spent once, never below zero — and still there after a reload', async () => {
    const m = await shop.open(MGR, '/gift-cards/');
    expect(m.status).toBe(200);
    await says(m.page, '#look-h', /^Look up a card$/);
    expect(m.writes, 'nothing is written on open').toEqual([]);
    await m.page.fill('#i-card', 'DEMO-GC-0701'); await m.page.fill('#i-owner', 'demo-buyer'); await m.page.fill('#i-value', '1000');
    await m.page.click('#i-issue');
    await says(m.page, '#issue-status', /^Issued\. The card holds ₹1,000\.00\.$/);
    await m.page.click('#i-issue');
    await says(m.page, '#issue-status', /^Head office refused: instrument DEMO-GC-0701 has already been issued/);

    await m.page.fill('#d-card', 'DEMO-GC-0701'); await m.page.fill('#d-amount', '300'); await m.page.selectOption('#d-channel', 'phone');
    await m.page.click('#d-redeem');
    await says(m.page, '#redeem-status', /^Taken\. The card now holds ₹700\.00\.$/);
    await says(m.page, '#card .balance', /^Balance: ₹700\.00$/);
    await m.page.fill('#d-amount', '800');
    await m.page.click('#d-redeem');
    await says(m.page, '#redeem-status', /^Head office refused:/);
    expect(m.writes.filter((w) => w.startsWith('POST /v1/stored-value/instruments')).length, 'two issues and two payments asked').toBe(4);
    const held = (await shop.call('GET', '/v1/stored-value/instruments/DEMO-GC-0701', OWNER)).body as { balanceMinor: number; kind: string; redemptions: unknown[] };
    expect(held).toMatchObject({ balanceMinor: 70_000, kind: 'gift_card' });
    expect(held.redemptions).toHaveLength(1);
    expect(m.errors).toEqual([]);
    await m.close();

    const again = await shop.open(MGR, '/gift-cards/');
    await again.page.fill('#l-card', 'DEMO-GC-0701');
    await again.page.click('#l-look');
    await says(again.page, '#card .balance', /^Balance: ₹700\.00$/);
    await again.page.click('#lang');
    await says(again.page, '#look-h', /^அட்டையைத் தேடு$/);
    expect(again.errors).toEqual([]);
    await again.close();
  }, 120_000);

  it('with head office gone, the page on the store computer says so and nothing is taken (P-08)', async () => {
    await shop.cloud.stop();
    const m = await shop.open(MGR, '/gift-cards/');
    expect(m.status, 'the box still serves the page').toBe(200);
    await m.page.fill('#d-card', 'DEMO-GC-0701'); await m.page.fill('#d-amount', '100');
    await m.page.click('#d-redeem');
    await says(m.page, '#redeem-status', /^Head office cannot be reached — nothing was issued or taken\.$/);
    await m.close();
  });
});
