import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { HAVE_BROWSER, startBoxPageShop, says, type BoxPageShop } from './lib/r4c-box-page';

/**
 * **W3 · D10-FR-04 "loyalty/gift/rebate liabilities" (M17-FR-01/03 · M17-FR-02 · OB-221): the Month-end page, on the store
 * computer, shows what the shop owes customers against the books — and puts referral rewards in the books.**
 *
 * Through Chromium, as the accountant:
 *   • the "Owed to customers" tab reads head office's two reads: loyalty points and store credit (nothing held, nothing in
 *     the books — agrees exactly); referral rewards ₹80 owed with NO posting rule — "Not known, not zero", never a zero;
 *   • putting them in the books before any posting map is refused in head office's words; once the accountant's rules are
 *     set, one press posts both movements and the books carry ₹80 — agrees; a second press posts nothing;
 *   • coupons are said not to be a liability (OB-221); the tab speaks Tamil;
 *   • a store manager who may read but not post is not offered the post.
 */

const OWNER = 'u-owner'; const ACCT = 'u-acct'; const MGR = 'u-mgr';
const MAP = {
  rules: [
    { kind: 'referral:earned', legs: [{ account: 'referral_reward_expense', side: 'debit', component: 'amount' }, { account: 'referral_reward_liability', side: 'credit', component: 'amount' }] },
    { kind: 'referral:paid', legs: [{ account: 'referral_reward_liability', side: 'debit', component: 'amount' }, { account: 'cash', side: 'credit', component: 'amount' }] },
    { kind: 'referral:expired', legs: [{ account: 'referral_reward_liability', side: 'debit', component: 'amount' }, { account: 'referral_reward_expense', side: 'credit', component: 'amount' }] },
  ],
};

describe.skipIf(!HAVE_BROWSER)('Month-end: what the shop owes customers (W3 · D10-FR-04)', () => {
  let shop: BoxPageShop;
  beforeAll(async () => {
    shop = await startBoxPageShop({
      name: 'owed',
      people: [{ userId: ACCT, permissions: ['finance.period.read', 'finance.journal.post'] }, { userId: MGR, permissions: ['finance.period.read'] }],
      seed: async (ho, T, store) => {
        await ho.seedOwner(T, OWNER);
        await ho.enableFeature(T, 'loyalty');
        await ho.provisionRole(T, ACCT, 'accountant');
        await ho.provisionRole(T, MGR, 'store_manager', [store]);
        for (const [id, a, b, reward] of [['R1', 'M-anu', 'M-bala', 5_000], ['R2', 'M-chitra', 'M-devi', 3_000]] as const) {
          const r = await ho.request({ method: 'POST', path: `/v1/loyalty/referrals/${id}`, userId: OWNER, tenantId: T, idempotencyKey: `ref-${id}`,
            body: { referrerRef: a, referredRef: b, referredPurchases: [{ netMinor: 60_000, at: '2026-10-01T10:00:00Z' }], qualifyingSpendMinor: 50_000, rewardMinor: reward } });
          if (r.status !== 201) throw new Error(`referral ${id}: ${JSON.stringify(r.body)}`);
        }
      },
    });
  }, 240_000);
  afterAll(async () => { await shop?.stop(); });

  it('the accountant reads the liabilities, is refused without a map, and posts the referral rewards once it is set', async () => {
    const a = await shop.open(ACCT, '/finance-close');
    await says(a.page, '#tab-owed', /^Owed to customers/);
    await a.page.click('#tab-owed');
    await says(a.page, '#owed-list li[data-owed="points"]', /Loyalty points.*agrees exactly.*Members hold: 0 points at ₹[\d.]+ each = ₹0\.00 · The books carry: ₹0\.00 · Difference: ₹0\.00/);
    await says(a.page, '#owed-list li[data-owed="credit"]', /Store credit.*agrees exactly/);
    await says(a.page, '#owed-list li[data-owed="referral"]', /Referral rewards.*does not agree.*Rewards still owed ₹80\.00 · The books carry: not known · Difference: not known/);
    await says(a.page, '#owed-list li[data-owed="referral"]', /Not known, not zero\./);
    await says(a.page, '#owed-list li[data-owed="referral"]', /Coupons: Coupons are not a liability/);
    await says(a.page, '#owed-tiles [data-tile="referral"]', /₹80\.00/);
    await a.page.click('#owed-post');
    await says(a.page, '#owed-status', /^Head office refused: No ledger mapping is defined/);

    const mapped = await shop.call('PUT', '/v1/finance/posting-map', ACCT, MAP);
    expect(mapped.status, JSON.stringify(mapped.body)).toBeLessThan(300);
    await a.page.click('#owed-show');
    await says(a.page, '#owed-list li[data-owed="referral"]', /The books carry: ₹0\.00 · Difference: −₹80\.00/);
    await says(a.page, '#owed-list li[data-owed="referral"]', /2 movement\(s\) not yet in the books/);
    await a.page.click('#owed-post');
    await says(a.page, '#owed-status', /^2 entr\(ies\) put in the books\.$/);
    await says(a.page, '#owed-list li[data-owed="referral"]', /agrees exactly.*The books carry: ₹80\.00 · Difference: ₹0\.00/);
    await a.page.click('#owed-post');
    await says(a.page, '#owed-status', /^Nothing to post — every movement is in the books\.$/);
    const held = (await shop.call('GET', '/v1/finance/referral-liability', ACCT)).body as { booksMinor: number; reconciles: boolean };
    expect(held).toMatchObject({ booksMinor: 8_000, reconciles: true });
    await a.page.click('#lang');
    await says(a.page, '#owed-h', /^கடை வாடிக்கையாளர்களுக்குச் செலுத்த வேண்டியது$/);
    expect(a.errors).toEqual([]);
    await a.close();
  }, 120_000);

  it('a store manager may read but is not offered the post', async () => {
    const m = await shop.open(MGR, '/finance-close');
    await m.page.click('#tab-owed');
    expect(await m.page.isHidden('#owed-post')).toBe(true);
    expect(m.writes).toEqual([]);
    await m.close();
  }, 60_000);
});
