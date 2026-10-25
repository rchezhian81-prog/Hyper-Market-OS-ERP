import { describe, it, expect } from 'vitest';
import { useRestartableBackings } from '../support/p3-backings';
import { fulfilmentShop, codeOf, OWNER, DISPATCHER, CASHIER, DOORS, type Shop } from '../support/fulfilment-shop';

// M17-FR-02 · D07-FR-04 · OB-351 (owner, 24 Oct 2026: "build now; reward per side 'not set' until the owner enters it") —
// the customer referral programme through the production routes. Each customer has one code; a friend claims it before
// their first delivered order; self-referral and a second referrer are refused. When the referred customer's FIRST online
// order is delivered, BOTH sides earn — but a side whose reward the owner has not set is given nothing and waits, said so.
// Once set, the reward is given once per side, on the loyalty referral register the liability check and the payout read;
// a second delivered order earns nothing more. A customer who already had an order delivered cannot be "referred". 403s
// for the till and the manager. In memory and on real PostgreSQL, with a cold restart. Synthetic data.
//
// OB-356 (owner, 24 Oct 2026, in writing: "a referral that qualified before the reward was set is paid once the owner sets
// the reward", as built) is PINNED here: c-2's first delivery earns while neither side is set (nothing given, both
// waiting); each side is given — once — when the owner sets it later, and a later change never gives it again.

const backings = useRestartableBackings();
const delivered = async (shop: Shop, customer: string, orderId: string, slot: number): Promise<void> => {
  await shop.placeConfirmed(customer, orderId, [['RICE', 1]], slot, DOORS.near);
  for (const event of ['pick', 'pack', 'dispatch', 'deliver']) await shop.ok('POST', `/v1/orders/${orderId}/transition`, OWNER, { event });
};

describe.each(backings)('a referral rewards both sides once, on the first delivery (M17-FR-02 · OB-351 · OB-356) — on $name', ({ harness }) => {
  it('one code each; no self-referral; "not set" gives nothing and waits; set → given once per side; a second delivery earns nothing; a restart', async () => {
    const h = harness();
    const shop = await fulfilmentShop(h);
    await h.enableFeature(shop.t, 'loyalty');

    // ── My code: issued once, the same on every read; the rewards read "not set".
    const mine = await shop.ok('GET', '/v1/me/referral', 'c-1');
    const code = mine['code'] as string;
    expect(code).toMatch(/^[2-9A-HJKMNP-Z]{8}$/);
    expect((await shop.ok('GET', '/v1/me/referral', 'c-1'))['code']).toBe(code);
    expect(mine['rewards']).toMatchObject({ referrer: { state: 'not_set' }, referred: { state: 'not_set' } });
    expect(mine['myReferrals']).toEqual([]);

    // ── Claims: my own code is refused; a bad or unknown code is refused; a friend's is kept once.
    expect(codeOf(await shop.call('POST', '/v1/me/referral/claim', 'c-1', { code }))).toBe('self_referral');
    expect(codeOf(await shop.call('POST', '/v1/me/referral/claim', 'c-2', { code: 'abc' }))).toBe('not_readable_as_a_referral_code');
    expect(codeOf(await shop.call('POST', '/v1/me/referral/claim', 'c-2', { code: 'ZZZZZZZZ' }))).toBe('referral_code_unknown');
    expect((await shop.call('POST', '/v1/me/referral/claim', 'c-2', { code: code.toLowerCase() })).status).toBe(201);
    expect((await shop.ok('POST', '/v1/me/referral/claim', 'c-2', { code }))['alreadyClaimed']).toBe(true);
    const code3 = (await shop.ok('GET', '/v1/me/referral', 'c-3'))['code'] as string;
    expect(codeOf(await shop.call('POST', '/v1/me/referral/claim', 'c-2', { code: code3 }))).toBe('already_referred');
    // The staff routes: the till reads but never sets; the manager may not set; only the owner sets.
    expect((await shop.call('POST', '/v1/loyalty/referral-rewards', CASHIER, { referrerRewardMinor: 1, reason: 'try' })).status).toBe(403);
    expect((await shop.call('POST', '/v1/loyalty/referral-rewards', DISPATCHER, { referrerRewardMinor: 1, reason: 'try' })).status).toBe(403);
    expect((await shop.call('GET', '/v1/loyalty/referral-programme', 'c-1')).status).toBe(403);
    expect(codeOf(await shop.call('POST', '/v1/loyalty/referral-rewards', OWNER, { referrerRewardMinor: -5, reason: 'oops' }))).toBe('not_readable_as_referral_rewards');

    // ── Before the first delivery: waiting; nothing given.
    const reg0 = await shop.ok('GET', '/v1/loyalty/referral-programme', OWNER);
    expect((reg0['referrals'] as { standing: string }[]).map((r) => r.standing)).toEqual(['waiting_for_first_delivery']);

    // ── c-2's first order is delivered — but neither reward is set: earned, NOTHING given, both sides waiting.
    await delivered(shop, 'c-2', 'ORD-R1', 1);
    const reg1 = await shop.ok('GET', '/v1/loyalty/referral-programme', OWNER);
    expect(reg1).toMatchObject({ givenMinor: 0, waitingForTheOwner: 1 });
    expect((reg1['referrals'] as { standing: string; waitingForReward: string[]; firstDeliveredOrderId: string }[])[0]).toMatchObject({ standing: 'earned_reward_not_set', waitingForReward: ['referrer', 'referred'], firstDeliveredOrderId: 'ORD-R1' });
    expect(((await shop.ok('GET', '/v1/finance/referral-liability', OWNER))['register'] as { outstandingMinor: number }).outstandingMinor).toBe(0);

    // ── OB-356: qualified BEFORE the reward was set — paid once the owner sets it.
    // ── The owner sets the referrer's reward only: that side is given; the referred side still waits, said so.
    await shop.ok('POST', '/v1/loyalty/referral-rewards', OWNER, { referrerRewardMinor: 50_00, reason: 'launch the programme' });
    expect((await shop.ok('GET', '/v1/me/referral', 'c-1'))['myReferrals']).toEqual([expect.objectContaining({ standing: 'earned_reward_not_set', rewardMinor: 50_00, waitingForReward: false })]);
    expect((await shop.ok('GET', '/v1/me/referral', 'c-2'))['iWasReferred']).toMatchObject({ standing: 'earned_reward_not_set', rewardMinor: null, waitingForReward: true });
    // ── Then the referred side: given once; the register says rewarded.
    const rewards = await shop.ok('POST', '/v1/loyalty/referral-rewards', OWNER, { referredRewardMinor: 25_00, reason: 'welcome reward' });
    expect(rewards).toMatchObject({ referrer: { state: 'set', amountMinor: 50_00 }, referred: { state: 'set', amountMinor: 25_00 } });
    expect((await shop.ok('GET', '/v1/me/referral', 'c-2'))['iWasReferred']).toMatchObject({ standing: 'rewarded', rewardMinor: 25_00 });
    const reg2 = await shop.ok('GET', '/v1/loyalty/referral-programme', OWNER);
    expect(reg2).toMatchObject({ givenMinor: 75_00, waitingForTheOwner: 0 });

    // ── A second delivered order earns nothing more; a later change of the reward does not re-give.
    await delivered(shop, 'c-2', 'ORD-R2', 2);
    await shop.ok('POST', '/v1/loyalty/referral-rewards', OWNER, { referrerRewardMinor: 80_00, reason: 'festival' });
    expect(await shop.ok('GET', '/v1/loyalty/referral-programme', OWNER)).toMatchObject({ givenMinor: 75_00 });
    // ── A customer who already had a delivery cannot then be "referred".
    await delivered(shop, 'c-3', 'ORD-R3', 3);
    expect(codeOf(await shop.call('POST', '/v1/me/referral/claim', 'c-3', { code }))).toBe('already_a_customer');

    // ── The rewards are on the loyalty referral register: the liability owes 75.00, and a person pays one out.
    const liability = await shop.ok('GET', '/v1/finance/referral-liability', OWNER);
    expect((liability['register'] as { outstandingMinor: number }).outstandingMinor).toBe(75_00);
    const referrerReward = ((liability['register'] as { referrals: { referralId: string; earnedMinor: number }[] }).referrals).find((r) => r.earnedMinor === 50_00)!;
    await shop.ok('POST', `/v1/loyalty/referrals/${referrerReward.referralId}/payout`, OWNER, { how: 'store_credit', reference: 'SC-REF-1' });

    // ── A cold restart reads the same register and the same code.
    const again = harness(h);
    const read = async (path: string, userId: string) => (await again.request({ method: 'GET', path, userId, tenantId: shop.t })).body as Record<string, unknown>;
    expect((await read('/v1/loyalty/referral-programme', OWNER))['referrals']).toEqual((await shop.ok('GET', '/v1/loyalty/referral-programme', OWNER))['referrals']);
    expect((await read('/v1/me/referral', 'c-1'))['code']).toBe(code);
  }, 120_000);
});
