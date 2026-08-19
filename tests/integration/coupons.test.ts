import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// M17-FR-02: coupons, personalised offers and referrals on the live API. A coupon is checked at EVERY
// redemption, never only at issue: single-use means single-use INCLUDING offline (the cloud holds the whole
// redemption history, so a cross-lane double-use a stale lane cache missed is caught and refused here — hard
// rule #10); a personalised offer needs BOTH profiling and marketing consent (M16-FR-02) or it is refused by
// name; a referral pays only on a real qualifying purchase and never on a self-referral. Issuing is gated
// loyalty.coupon.issue; recording a redemption (a lane action) is loyalty.coupon.redeem; reads are
// loyalty.coupon.read. Coupons + redemptions are event-sourced, so the register survives a restart.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FUTURE = '2099-12-31';
const PAST = '2000-01-01';

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

const define = (h: ApiHarness, u: string, code: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: `/v1/loyalty/coupons/${code}`, userId: u, tenantId: A, idempotencyKey: key, body });
const read = (h: ApiHarness, u: string, code: string) =>
  h.request({ method: 'GET', path: `/v1/loyalty/coupons/${code}`, userId: u, tenantId: A });
const redeem = (h: ApiHarness, u: string, code: string, redemptionId: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: `/v1/loyalty/coupons/${code}/redemptions/${redemptionId}`, userId: u, tenantId: A, idempotencyKey: key, body });
const offer = (h: ApiHarness, u: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: '/v1/loyalty/offers', userId: u, tenantId: A, idempotencyKey: key, body });
const referral = (h: ApiHarness, u: string, id: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: `/v1/loyalty/referrals/${id}`, userId: u, tenantId: A, idempotencyKey: key, body });

const singleUse = (extra: Record<string, unknown> = {}) =>
  ({ kind: 'amount_off', valueMinor: 5000, validUntil: FUTURE, maxRedemptions: 1, maxPerCustomer: 1, ...extra });

async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-mgr', 'store_manager'); // issue + redeem + read
  await h.provisionRole(A, 'u-cashier', 'cashier');   // redeem + read only
  return h;
}

describe('coupons, offers and referrals (M17-FR-02)', () => {
  it('defines a coupon, reads it back, and redeems it for a computed discount', async () => {
    const h = await cast();
    expect((await define(h, 'u-owner', 'SAVE50', singleUse(), 'k1')).status).toBe(201);
    const got = await read(h, 'u-cashier', 'SAVE50');
    expect(got.status).toBe(200);
    expect((got.body as { coupon: { kind: string } }).coupon.kind).toBe('amount_off');

    const r = await redeem(h, 'u-cashier', 'SAVE50', 'r1', { saleId: 's1', basketMinor: 20000 }, 'kr1');
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ outcome: 'redeemed', discountMinor: 5000 });
    // A percent coupon discounts proportionally, never above the basket.
    await define(h, 'u-owner', 'TEN', { kind: 'percent_off', percentBps: 1000, validUntil: FUTURE, maxRedemptions: 5, maxPerCustomer: 5 }, 'k2');
    expect((await redeem(h, 'u-cashier', 'TEN', 'r2', { saleId: 's2', basketMinor: 20000 }, 'kr2')).body).toMatchObject({ discountMinor: 2000 });
  });

  it('single-use means single-use across lanes: the second redemption is refused at the authoritative tier', async () => {
    const h = await cast();
    await define(h, 'u-owner', 'ONCE', singleUse(), 'k1');
    // Lane A syncs its redemption first — recorded.
    expect((await redeem(h, 'u-cashier', 'ONCE', 'laneA', { saleId: 'sA', basketMinor: 10000 }, 'kA')).status).toBe(201);
    // Lane B redeemed the same code offline against a stale cache; on sync the cloud sees the limit is used.
    const laneB = await redeem(h, 'u-cashier', 'ONCE', 'laneB', { saleId: 'sB', basketMinor: 10000 }, 'kB');
    expect(laneB.status).toBe(409);
    expect(codeOf(laneB)).toBe('coupon_limit_reached');
    // Only ONE redemption is recorded — the conflict was surfaced, not silently accepted.
    expect((await read(h, 'u-owner', 'ONCE')).body).toMatchObject({ redemptionCount: 1 });
  });

  it('a re-sync of the SAME redemption id is idempotent, not a second use', async () => {
    const h = await cast();
    await define(h, 'u-owner', 'IDEM', singleUse(), 'k1');
    expect((await redeem(h, 'u-cashier', 'IDEM', 'r1', { saleId: 's1', basketMinor: 10000 }, 'kr1')).status).toBe(201);
    const again = await redeem(h, 'u-cashier', 'IDEM', 'r1', { saleId: 's1', basketMinor: 10000 }, 'kr2');
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ outcome: 'already_redeemed' });
    expect((await read(h, 'u-owner', 'IDEM')).body).toMatchObject({ redemptionCount: 1 });
  });

  it('refuses redemption on expiry, wrong segment and too-small basket; refuses re-defining a code', async () => {
    const h = await cast();
    await define(h, 'u-owner', 'GONE', singleUse({ validUntil: PAST }), 'k1');
    expect(codeOf(await redeem(h, 'u-cashier', 'GONE', 'r', { saleId: 's', basketMinor: 10000 }, 'kr'))).toBe('coupon_expired');

    await define(h, 'u-owner', 'GOLDONLY', singleUse({ eligibleTo: ['gold'], maxPerCustomer: 5, maxRedemptions: 5 }), 'k2');
    const notGold = await redeem(h, 'u-cashier', 'GOLDONLY', 'r', { saleId: 's', basketMinor: 10000, customerRef: 'c1', customerSegments: ['silver'] }, 'kr2');
    expect(codeOf(notGold)).toBe('coupon_not_eligible');

    await define(h, 'u-owner', 'BIGBASKET', singleUse({ minimumBasketMinor: 50000, maxRedemptions: 5, maxPerCustomer: 5 }), 'k3');
    expect(codeOf(await redeem(h, 'u-cashier', 'BIGBASKET', 'r', { saleId: 's', basketMinor: 10000 }, 'kr3'))).toBe('coupon_basket_too_small');

    // A code names exactly one instrument — re-defining it is refused.
    const dup = await define(h, 'u-owner', 'GONE', singleUse(), 'k4');
    expect(dup.status).toBe(409);
    expect(codeOf(dup)).toBe('coupon_code_in_use');
  });

  it('issues a personalised offer only with BOTH consents, and names the missing one otherwise', async () => {
    const h = await cast();
    const draft = { code: 'FORYOU', kind: 'amount_off', valueMinor: 3000, validUntil: FUTURE, maxRedemptions: 1, maxPerCustomer: 1 };
    // No profiling consent → refused, named.
    const noProfiling = await offer(h, 'u-owner', { customerRef: 'c1', coupon: draft, consents: ['marketing'] }, 'ko1');
    expect(noProfiling.status).toBe(422);
    expect(codeOf(noProfiling)).toBe('offer_no_profiling_consent');
    // Profiling but no marketing → refused, named (two different permissions).
    expect(codeOf(await offer(h, 'u-owner', { customerRef: 'c1', coupon: draft, consents: ['profiling'] }, 'ko2'))).toBe('offer_no_marketing_consent');
    // Both consents → issued, and the offer is a real coupon that can then be read.
    const issued = await offer(h, 'u-owner', { customerRef: 'c1', coupon: draft, consents: ['profiling', 'marketing'] }, 'ko3');
    expect(issued.status).toBe(201);
    expect((issued.body as { coupon: { issuedTo: string; personalised: boolean } }).coupon).toMatchObject({ issuedTo: 'c1', personalised: true });
    expect((await read(h, 'u-owner', 'FORYOU')).status).toBe(200);
  });

  it('pays a referral only on a qualifying purchase, refuses self-referral, and never pays twice', async () => {
    const h = await cast();
    const base = { referrerRef: 'alice', referredRef: 'bob', qualifyingSpendMinor: 5000, rewardMinor: 1000 };
    // Not enough spend yet → not payable (a legitimate answer, not an error).
    const notYet = await referral(h, 'u-owner', 'ref1', { ...base, referredPurchases: [{ netMinor: 2000, at: '2026-08-07' }] }, 'k1');
    expect(notYet.status).toBe(200);
    expect(notYet.body).toMatchObject({ payable: false, outcome: 'no_qualifying_purchase' });
    // Self-referral is refused.
    expect((await referral(h, 'u-owner', 'ref2', { ...base, referredRef: 'alice', referredPurchases: [{ netMinor: 9000, at: '2026-08-07' }] }, 'k2')).body).toMatchObject({ outcome: 'self_referral' });
    // Qualifying purchase → payable and recorded.
    const paid = await referral(h, 'u-owner', 'ref3', { ...base, referredPurchases: [{ netMinor: 9000, at: '2026-08-07' }] }, 'k3');
    expect(paid.status).toBe(201);
    expect(paid.body).toMatchObject({ payable: true, rewardMinor: 1000 });
    // Assessing the same referral again → already paid (never twice).
    expect((await referral(h, 'u-owner', 'ref3', { ...base, referredPurchases: [{ netMinor: 9000, at: '2026-08-07' }] }, 'k4')).body).toMatchObject({ outcome: 'already_paid' });
  });

  it('gates the surface: a cashier may redeem/read but not issue, offer or decide a referral', async () => {
    const h = await cast();
    await define(h, 'u-owner', 'C', singleUse({ maxRedemptions: 5, maxPerCustomer: 5 }), 'k1');
    // The cashier is a lane — it records redemptions and reads coupons.
    expect((await redeem(h, 'u-cashier', 'C', 'r', { saleId: 's', basketMinor: 10000 }, 'kr')).status).toBe(201);
    expect((await read(h, 'u-cashier', 'C')).status).toBe(200);
    // But it cannot issue a coupon, an offer, or decide a referral payout (a store/marketing authority).
    expect((await define(h, 'u-cashier', 'X', singleUse(), 'k2')).status).toBe(403);
    expect((await offer(h, 'u-cashier', { customerRef: 'c1', coupon: { code: 'Y', kind: 'amount_off', valueMinor: 1, validUntil: FUTURE, maxRedemptions: 1, maxPerCustomer: 1 }, consents: ['profiling', 'marketing'] }, 'k3')).status).toBe(403);
    expect((await referral(h, 'u-cashier', 'r9', { referrerRef: 'a', referredRef: 'b', qualifyingSpendMinor: 1, rewardMinor: 1, referredPurchases: [{ netMinor: 5, at: '2026-08-07' }] }, 'k4')).status).toBe(403);
    // A manager may issue.
    expect((await define(h, 'u-mgr', 'MGR', singleUse(), 'k5')).status).toBe(201);
  });

  it('a 404 for an unknown coupon, a 400 for a malformed one, and survives a restart', async () => {
    const h = await cast();
    expect((await read(h, 'u-owner', 'NOPE')).status).toBe(404);
    expect((await redeem(h, 'u-cashier', 'NOPE', 'r', { saleId: 's', basketMinor: 100 }, 'kr')).status).toBe(404);
    // Malformed: missing maxRedemptions/validUntil.
    expect(codeOf(await define(h, 'u-owner', 'BAD', { kind: 'amount_off', valueMinor: 100 }, 'kb'))).toBe('not_readable_as_a_coupon');

    await define(h, 'u-owner', 'KEEP', singleUse(), 'k1');
    await redeem(h, 'u-cashier', 'KEEP', 'r1', { saleId: 's1', basketMinor: 10000 }, 'kr1');
    // A fresh harness over the SAME store is a cold start — the register folds from events.
    const restarted = apiHarness({ store: h.store });
    expect((await read(restarted, 'u-owner', 'KEEP')).body).toMatchObject({ redemptionCount: 1 });
  });
});
