import { describe, it, expect } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { apiHarness, TEST_PACK_KEY, type ApiHarness } from '../support/api-harness';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { loyaltyMemberKey, memberRefFor, readWalletFeed, spendRefFor } from '../../packages/loyalty/src/index';
import { ownerApprovedSetting } from '../support/owner-approved-setting';

// PF-09 step 3 (audit PF-09, HIGH · M17-FR-01/03/04 · OB-28 "C and 1"): the till spends a member's points and store
// credit, and head office is where that spend becomes true. Proved through the real API, RBAC and append-only store:
//   • the wallet feed the store computers pull carries the owner's rule and till spend cap, every member's points and
//     store credit by CODE (never a phone number), and the spends head office has applied;
//   • a banked sale with a `loyalty_points` tender takes exactly the stamped points; a `store_credit` tender takes value
//     from the member's store-credit instruments oldest first; the same sale relayed twice spends once;
//   • points paid with points earn nothing (only the money part earns);
//   • a spend the true balance can no longer cover (spent elsewhere first) is applied as far as it goes, never below zero,
//     and raised as a valued exception — the sale is still banked (hard rules #1, #10).

// The PostgreSQL leg runs under a fresh tenant each time (the database keeps every earlier run's facts).
let A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MOBILE = '98400 55555';
const MEMBER = memberRefFor(loyaltyMemberKey(TEST_PACK_KEY), MOBILE)!;

async function shop(h: ApiHarness = apiHarness()): Promise<ApiHarness> {
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-mgr', 'store_manager');
  await h.provisionRole(A, 'u-cash', 'cashier');
  // OB-336: the till's spend cap is high-impact — the owner approves the administrator's answer; the others one person sets.
  const set = async (key: string, value: number) =>
    expect((key === 'loyalty.till_spend_cap_paise' ? await ownerApprovedSetting(h, A, key, { value }) : await h.request({ method: 'PUT', path: `/v1/platform/setup/${key}`, userId: 'u-owner', tenantId: A, idempotencyKey: `set-${key}`, body: { value } })).status).toBeLessThan(300);
  await set('loyalty.points_per_100_inr', 2);   // 2 points per ₹100
  await set('loyalty.point_value_paise', 50);   // one point = ₹0.50
  await set('loyalty.till_spend_cap_paise', 100_000);
  expect((await h.request({ method: 'POST', path: '/v1/loyalty/members', userId: 'u-mgr', tenantId: A, idempotencyKey: 'enrol', body: { mobile: MOBILE, consent: true, verifiedHow: 'seen_on_phone' } })).status).toBe(201);
  return h;
}

const sale = (saleId: string, totalMinor: number, tenders: readonly Record<string, unknown>[]) => ({
  saleId, receiptNumber: `R-${saleId}`, laneId: 'lane-1', cashierId: 'u-cash',
  tradingDay: '2026-10-10', committedAt: new Date().toISOString(), totalMinor, currency: 'INR', packVersion: 1,
  lines: [{ productId: 'P1', quantityMinor: 1, uom: 'each', unitPriceMinor: totalMinor, lineTotalMinor: totalMinor }],
  tenders, customerRef: MEMBER,
});
const bank = async (h: ApiHarness, body: Record<string, unknown>, key?: string) => {
  const res = await h.request({ method: 'POST', path: '/v1/sales', userId: 'u-cash', tenantId: A, idempotencyKey: key ?? `bank-${body['saleId']}`, body });
  expect(res.status).toBe(202);
  return res.body as { banked: true; loyalty?: { outcome: string; points?: number }; spends?: { kind: string; appliedMinor: number; shortfallMinor: number; alreadyApplied: boolean }[] };
};
const points = async (h: ApiHarness) =>
  ((await h.request({ method: 'GET', path: `/v1/customers/${MEMBER}/points`, userId: 'u-owner', tenantId: A })).body as { pointsBalance?: number }).pointsBalance;
const feed = async (h: ApiHarness) => {
  const res = await h.request({ method: 'GET', path: '/v1/loyalty/wallets', userId: 'u-cash', tenantId: A });
  expect(res.status).toBe(200);
  const f = readWalletFeed(res.body);
  expect(f, 'the feed reads as a wallet feed').toBeDefined();
  return f!;
};
const issueCredit = async (h: ApiHarness, instrumentId: string, faceValueMinor: number) =>
  expect((await h.request({ method: 'POST', path: '/v1/stored-value/instruments', userId: 'u-cash', tenantId: A, idempotencyKey: `issue-${instrumentId}`, body: { instrumentId, kind: 'store_credit', ownerRef: MEMBER, faceValueMinor } })).status).toBe(201);

describe('PF-09 step 3: points and store credit spent at the till are spent once, at head office, never below zero', () => {
  it('the wallet feed: the rule and the till cap, balances by member code, no phone number anywhere', async () => {
    const h = await shop();
    await bank(h, sale('S1', 100_000, [{ kind: 'cash', amountMinor: 100_000 }])); // ₹1,000 → 20 points
    await issueCredit(h, 'sc-1', 30_000);
    const f = await feed(h);
    expect(f.rule).toEqual({ pointsPer100Inr: 2, pointValuePaise: 50, tillSpendCapPaise: 100_000 });
    expect(f.members).toEqual([{ memberRef: MEMBER, points: 20, storeCreditMinor: 30_000, appliedSpendRefs: [] }]);
    expect(JSON.stringify(f)).not.toMatch(/98400|55555/);
  });

  it('a points tender takes exactly its points, a store-credit tender takes oldest credit first; a resend spends nothing more; points paid with points earn nothing', async () => {
    const h = await shop();
    await bank(h, sale('S1', 200_000, [{ kind: 'cash', amountMinor: 200_000 }])); // 40 points
    await issueCredit(h, 'sc-old', 1_000);
    await issueCredit(h, 'sc-new', 2_000);
    expect(await points(h)).toBe(40);

    // ₹100 bill: 20 points (₹10) + ₹15 store credit + ₹75 cash. Earns on the ₹90 not paid with points → 1 point.
    const body = sale('S2', 10_000, [
      { kind: 'loyalty_points', amountMinor: 1_000, points: 20 },
      { kind: 'store_credit', amountMinor: 1_500 },
      { kind: 'cash', amountMinor: 7_500 },
    ]);
    const first = await bank(h, body);
    expect(first.spends).toEqual([
      expect.objectContaining({ kind: 'loyalty_points', appliedMinor: 1_000, shortfallMinor: 0, alreadyApplied: false }),
      expect.objectContaining({ kind: 'store_credit', appliedMinor: 1_500, shortfallMinor: 0, alreadyApplied: false }),
    ]);
    expect(first.loyalty).toMatchObject({ outcome: 'earned', points: 1 });
    expect(await points(h)).toBe(40 - 20 + 1);
    const credit = async (id: string) => ((await h.request({ method: 'GET', path: `/v1/stored-value/instruments/${id}`, userId: 'u-owner', tenantId: A })).body as { balanceMinor: number }).balanceMinor;
    expect(await credit('sc-old')).toBe(0);      // the older credit is used first…
    expect(await credit('sc-new')).toBe(1_500); // …then ₹5 of the newer

    // The same sale relayed twice (a lost reply, a fresh key): one spend, one earn.
    const again = await bank(h, body, 'bank-S2-again');
    expect(again.spends!.every((s) => s.alreadyApplied)).toBe(true);
    expect(await points(h)).toBe(21);
    expect(await credit('sc-new')).toBe(1_500);
    const f = await feed(h);
    expect(f.members[0]).toMatchObject({ points: 21, storeCreditMinor: 1_500 });
    expect([...f.members[0]!.appliedSpendRefs].sort()).toEqual([spendRefFor('S2', 'loyalty_points'), spendRefFor('S2', 'store_credit')].sort());
  });

  it('a spend the true balance cannot cover is applied as far as it goes, never below zero, and raised as a valued exception', async () => {
    const h = await shop();
    await bank(h, sale('S1', 50_000, [{ kind: 'cash', amountMinor: 50_000 }])); // 10 points
    // Two store computers each spent the same 10 points from their copies before either reached head office.
    const a = await bank(h, sale('S-A', 500, [{ kind: 'loyalty_points', amountMinor: 500, points: 10 }]));
    expect(a.banked).toBe(true);
    expect(a.spends![0]).toMatchObject({ appliedMinor: 500, shortfallMinor: 0 });
    const b = await bank(h, sale('S-B', 500, [{ kind: 'loyalty_points', amountMinor: 500, points: 10 }]));
    expect(b.banked).toBe(true);
    expect(b.spends![0]).toMatchObject({ appliedMinor: 0, shortfallMinor: 500 });
    expect(await points(h)).toBe(0); // never negative
    const ex = (await h.request({ method: 'GET', path: '/v1/sales/exceptions', userId: 'u-owner', tenantId: A })).body as { exceptions?: unknown[] } & Record<string, unknown>;
    expect(JSON.stringify(ex)).toMatch(/loyalty_value_spent_twice/);
    expect(JSON.stringify(ex)).toMatch(/S-B/);
  });

  it('OB-33 "A": with no limit set the feed carries the owner\'s ₹500 default; setting 0 switches till spending off', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier');
    expect((await feed(h)).rule.tillSpendCapPaise).toBe(50_000);
    // OB-336: switching it off is a change to a high-impact setting too — one person alone cannot.
    expect((await h.request({ method: 'PUT', path: '/v1/platform/setup/loyalty.till_spend_cap_paise', userId: 'u-owner', tenantId: A, idempotencyKey: 'off', body: { value: 0 } })).status).toBe(422);
    expect((await ownerApprovedSetting(h, A, 'loyalty.till_spend_cap_paise', { value: 0 })).status).toBeLessThan(300);
    expect((await feed(h)).rule.tillSpendCapPaise).toBe(0);
  });

  it('a spend on a sale that names no member takes nothing and is raised', async () => {
    const h = await shop();
    const body = { ...sale('S-X', 500, [{ kind: 'store_credit', amountMinor: 500 }]) } as Record<string, unknown>;
    delete body['customerRef'];
    const r = await bank(h, body);
    expect(r.banked).toBe(true);
    expect(r.spends![0]).toMatchObject({ appliedMinor: 0, shortfallMinor: 500 });
  });
});

/**
 * Verifier r20 IC-3 (hard rule #10): loyalty follows only the bill head office BANKED. A store computer that gave one sale id
 * to two different bills (a restored disk) sends the second; head office keeps the first and says the second was not banked.
 * The second bill's member, points and store credit are NOT earned or spent at head office — they are raised as an exception
 * (`loyalty_on_a_bill_not_banked`) for the person who banks it by hand. Re-sent, it still moves nothing.
 */
async function loyaltyFollowsTheBankedBill(h: ApiHarness): Promise<void> {
  await shop(h);
  await bank(h, sale('S1', 100_000, [{ kind: 'cash', amountMinor: 100_000 }])); // 20 points
  await issueCredit(h, 'sc-1', 5_000);
  expect(await points(h)).toBe(20);
  // The banked bill: no member named, cash only.
  const walkIn = { ...sale('S-IC3', 2_000, [{ kind: 'cash', amountMinor: 2_000 }]) } as Record<string, unknown>;
  delete walkIn['customerRef'];
  const first = await bank(h, walkIn, 'ic3-first');
  expect(first.loyalty === undefined || (first.loyalty as { outcome: string }).outcome !== 'earned').toBe(true);
  // A DIFFERENT bill under the same sale id, naming the member and spending 10 points and ₹20 of store credit.
  const other = sale('S-IC3', 10_000, [
    { kind: 'loyalty_points', amountMinor: 500, points: 10 },
    { kind: 'store_credit', amountMinor: 2_000 },
    { kind: 'exchange_credit', amountMinor: 1_000 },
    { kind: 'cash', amountMinor: 6_500 },
  ]);
  const second = await bank(h, other, 'ic3-second') as unknown as Record<string, unknown>;
  expect(second).toMatchObject({ thisBillBanked: false, notBankedBecause: 'a_different_bill_holds_this_sale_id' });
  expect(await points(h)).toBe(20); // nothing spent, nothing earned for a bill head office did not bank
  const credit = ((await h.request({ method: 'GET', path: '/v1/stored-value/instruments/sc-1', userId: 'u-owner', tenantId: A })).body as { balanceMinor: number }).balanceMinor;
  expect(credit).toBe(5_000);
  expect((await feed(h)).members[0]!.appliedSpendRefs).not.toEqual(expect.arrayContaining([spendRefFor('S-IC3', 'loyalty_points')]));
  // Raised for a person: what the not-banked bill carried.
  const ex = JSON.stringify((await h.request({ method: 'GET', path: '/v1/sales/exceptions', userId: 'u-owner', tenantId: A })).body);
  expect(ex).toMatch(/loyalty_on_a_bill_not_banked/);
  expect(ex).toMatch(/points worth 500 and store credit worth 2000/);
  // Verifier r21 IC-3 breadth: the not-banked bill's OTHER effects are itemised too — every payment, what each leaves open,
  // its stock and its coupons — so the person who banks it by hand settles all of it, not only the loyalty.
  expect(ex).toMatch(/Not applied at head office — payments: points 500 \(10 points\), store credit 2000, exchange credit 1000, cash 6500/);
  expect(ex).toMatch(/the cash \(6500\) is in till lane-1's drawer, which will count OVER by it at shift close until this bill is banked/);
  expect(ex).toMatch(/the exchange credit \(1000\) was given against a return that IS banked, so its exchange clearing stays open by 1000/);
  expect(ex).toMatch(/stock: P1 × 1 each — not taken out of stock at head office/);
  expect(ex).toMatch(/coupons: any coupon redeemed for this sale id stays redeemed/);
  expect(ex).toMatch(/Settle ALL of it when you bank it/);
  expect(ex).not.toMatch(/98400|55555/); // a member code, never the phone number
  // Re-sent (a lost reply, a fresh key): still nothing moves.
  await bank(h, other, 'ic3-second-again');
  expect(await points(h)).toBe(20);
  // The same bill re-sent is still "already banked" and its loyalty follows it as before (nothing for a walk-in).
  const again = await bank(h, walkIn, 'ic3-first-again') as unknown as Record<string, unknown>;
  expect(again['thisBillBanked']).toBeUndefined();
  expect(await points(h)).toBe(20);
}

describe('verifier r20 IC-3: loyalty follows only the banked bill', () => {
  it('memory', async () => { await loyaltyFollowsTheBankedBill(apiHarness()); }, 60_000);
  const DATABASE_URL = process.env['DATABASE_URL'];
  it.skipIf(DATABASE_URL === undefined)('PostgreSQL', async () => {
    const pool = new Pool({ connectionString: DATABASE_URL, max: 8, options: '-c app.tenant_id=*' });
    const sql = pgPoolClient(pool);
    const memoryTenant = A;
    A = randomUUID();
    try { await loyaltyFollowsTheBankedBill(apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) })); } finally { A = memoryTenant; await pool.end(); }
  }, 120_000);
});
