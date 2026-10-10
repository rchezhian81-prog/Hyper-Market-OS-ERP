import { describe, it, expect } from 'vitest';
import { apiHarness, TEST_PACK_KEY, type ApiHarness } from '../support/api-harness';
import { loyaltyMemberKey, memberRefFor, readWalletFeed, spendRefFor } from '../../packages/loyalty/src/index';

// PF-09 step 3 (audit PF-09, HIGH · M17-FR-01/03/04 · OB-28 "C and 1"): the till spends a member's points and store
// credit, and head office is where that spend becomes true. Proved through the real API, RBAC and append-only store:
//   • the wallet feed the store computers pull carries the owner's rule and till spend cap, every member's points and
//     store credit by CODE (never a phone number), and the spends head office has applied;
//   • a banked sale with a `loyalty_points` tender takes exactly the stamped points; a `store_credit` tender takes value
//     from the member's store-credit instruments oldest first; the same sale relayed twice spends once;
//   • points paid with points earn nothing (only the money part earns);
//   • a spend the true balance can no longer cover (spent elsewhere first) is applied as far as it goes, never below zero,
//     and raised as a valued exception — the sale is still banked (hard rules #1, #10).

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MOBILE = '98400 55555';
const MEMBER = memberRefFor(loyaltyMemberKey(TEST_PACK_KEY), MOBILE)!;

async function shop(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-mgr', 'store_manager');
  await h.provisionRole(A, 'u-cash', 'cashier');
  const set = async (key: string, value: number) =>
    expect((await h.request({ method: 'PUT', path: `/v1/platform/setup/${key}`, userId: 'u-owner', tenantId: A, idempotencyKey: `set-${key}`, body: { value } })).status).toBeLessThan(300);
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
    expect((await h.request({ method: 'PUT', path: '/v1/platform/setup/loyalty.till_spend_cap_paise', userId: 'u-owner', tenantId: A, idempotencyKey: 'off', body: { value: 0 } })).status).toBeLessThan(300);
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
