import { describe, it, expect } from 'vitest';
import { apiHarness, TEST_PACK_KEY, type ApiHarness } from '../support/api-harness';
import { withApprovals } from '../support/refund-approval';
import { loyaltyMemberKey, memberRefFor } from '../../packages/loyalty/src/index';
import { DEFAULT_RETAIL_POSTING_MAP } from '../../packages/finance/src/index';

// PF-09 step 3 · M17-FR-01 ("points earned/burned reconcile to the liability"), M17-FR-03 ("balances reconcile to
// finance"), M23: the loyalty liability is in the books, and reconciles exactly to what the members hold.
//   • the day book posts points EARNED (credit the liability), points TAKEN BACK by a return (debit it), points SPENT at the
//     till (a tender — debit it), store credit ISSUED on a refund (credit) and SPENT at the till (debit);
//   • GET /v1/finance/loyalty-liability compares those balances with the members' own movements, to the paisa;
//   • a spend the true balance could not cover shows as a named difference — never hidden.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa11ab';
const MOBILE = '98400 31313';
const MEMBER = memberRefFor(loyaltyMemberKey(TEST_PACK_KEY), MOBILE)!;
// The trading day and the moment of each sale are TODAY and NOW: a member earns only on a sale made after they joined
// (`wasMemberAt`), and the member is enrolled at run time — a fixed clock time made this pass only before 06:00 UTC.
const DAY = new Date().toISOString().slice(0, 10);

async function shop(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-mgr', 'store_manager');
  await h.provisionRole(A, 'u-cash', 'cashier');
  await h.provisionRole(A, 'u-acct', 'accountant');
  const set = async (key: string, value: number) =>
    expect((await h.request({ method: 'PUT', path: `/v1/platform/setup/${key}`, userId: 'u-owner', tenantId: A, idempotencyKey: `set-${key}`, body: { value } })).status).toBeLessThan(300);
  await set('loyalty.points_per_100_inr', 2);
  await set('loyalty.point_value_paise', 50);
  await set('loyalty.till_spend_cap_paise', 100_000);
  expect((await h.request({ method: 'POST', path: '/v1/pos/store-credit-cap', userId: 'u-owner', tenantId: A, idempotencyKey: 'cap', body: { capMinor: 100_000 } })).status).toBe(200);
  expect((await h.request({ method: 'POST', path: '/v1/loyalty/members', userId: 'u-mgr', tenantId: A, idempotencyKey: 'enrol', body: { mobile: MOBILE, consent: true, verifiedHow: 'seen_on_phone' } })).status).toBe(201);
  return h;
}

const sale = (saleId: string, totalMinor: number, tenders: readonly Record<string, unknown>[]) => ({
  saleId, receiptNumber: `R-${saleId}`, laneId: 'lane-1', cashierId: 'u-cash', tradingDay: DAY, committedAt: new Date().toISOString(),
  totalMinor, currency: 'INR', packVersion: 1, customerRef: MEMBER,
  lines: [{ productId: 'P1', quantityMinor: 2, uom: 'each', unitPriceMinor: totalMinor / 2, lineTotalMinor: totalMinor, taxRateBps: 0 }],
  tenders,
});
const bank = async (h: ApiHarness, body: Record<string, unknown>) =>
  expect((await h.request({ method: 'POST', path: '/v1/sales', userId: 'u-cash', tenantId: A, idempotencyKey: `bank-${body['saleId']}`, body })).status).toBe(202);
const liability = async (h: ApiHarness) => {
  const res = await h.request({ method: 'GET', path: '/v1/finance/loyalty-liability', userId: 'u-acct', tenantId: A });
  expect(res.status).toBe(200);
  return res.body as { reconciles: boolean; points: { outstandingPoints: number; heldValueMinor: number; postedMinor: number; differenceMinor: number }; storeCredit: { heldMinor: number; postedMinor: number; differenceMinor: number }; detail: string };
};

describe('PF-09 step 3: the loyalty liability is in the books and reconciles to what members hold', () => {
  it('earn, take-back, points spent, credit issued and spent all post; the liability reconciles to the paisa; a cashier cannot read it', async () => {
    const h = await shop();
    // S1: ₹1,000 cash → 20 points (₹10 at 50 paise).
    await bank(h, sale('S1', 100_000, [{ kind: 'cash', amountMinor: 100_000 }]));
    // A return of one of the two items (₹500) as store credit to the member: 10 points come back off them.
    const body = await withApprovals(h, A, 'u-owner', 'S1', {
      returnId: 'RT-1', number: 'RN-1', reasonCode: 'customer_changed_mind', lines: [{ productId: 'P1', uom: 'each', quantityMinor: 1, disposition: 'resell' }],
      refundMinor: 50_000, refundTender: 'store_credit', approvedBy: 'u-mgr', customerRef: MEMBER,
    });
    const ret = await h.request({ method: 'POST', path: '/v1/sales/S1/returns', userId: 'u-owner', tenantId: A, idempotencyKey: 'ret-1', body });
    expect(ret.status, JSON.stringify(ret.body)).toBe(201);
    // S2: ₹400 — 4 points (₹2) + ₹100 store credit + ₹298 cash; earns on ₹398 → 7 points.
    await bank(h, sale('S2', 40_000, [{ kind: 'loyalty_points', amountMinor: 200, points: 4 }, { kind: 'store_credit', amountMinor: 10_000 }, { kind: 'cash', amountMinor: 29_800 }]));

    // Before the day is posted the books carry nothing: the difference is the whole liability, said.
    const before = await liability(h);
    expect(before.points.outstandingPoints).toBe(20 - 10 - 4 + 7);
    expect(before.reconciles).toBe(false);
    expect(before.detail).toMatch(/books carry .* less/);

    expect((await h.request({ method: 'PUT', path: '/v1/finance/posting-map', userId: 'u-acct', tenantId: A, idempotencyKey: 'map', body: DEFAULT_RETAIL_POSTING_MAP })).status).toBeLessThan(300);
    const posted = await h.request({ method: 'POST', path: `/v1/finance/day-book/${DAY}/post`, userId: 'u-acct', tenantId: A, idempotencyKey: 'post' });
    expect(posted.status, JSON.stringify(posted.body)).toBeLessThan(300);
    const day = posted.body as { journals: { kind: string; lines: { accountCode: string; debitMinor: number; creditMinor: number }[] }[]; exceptions: unknown[] };
    expect(day.exceptions).toEqual([]);
    expect(day.journals.map((j) => j.kind)).toEqual(expect.arrayContaining(['loyalty:earn', 'loyalty:takeback', 'tender:loyalty_points', 'tender:store_credit', 'refund:store_credit']));
    for (const j of day.journals) expect(j.lines.reduce((n, l) => n + l.debitMinor - l.creditMinor, 0), j.kind).toBe(0);

    const after = await liability(h);
    // 13 points × 50 paise = ₹6.50 held; posted: earned (20 + 7) × 50 − taken back 10 × 50 − spent 200 = 650.
    expect(after.points).toMatchObject({ outstandingPoints: 13, heldValueMinor: 650, postedMinor: 650, differenceMinor: 0 });
    // ₹500 credit issued − ₹100 spent = ₹400 held and posted.
    expect(after.storeCredit).toMatchObject({ heldMinor: 40_000, postedMinor: 40_000, differenceMinor: 0 });
    expect(after.reconciles).toBe(true);

    // Posting the day again posts nothing twice.
    const again = await h.request({ method: 'POST', path: `/v1/finance/day-book/${DAY}/post`, userId: 'u-acct', tenantId: A, idempotencyKey: 'post-again' });
    expect((again.body as { journals: unknown[] }).journals).toEqual([]);
    expect((await liability(h)).reconciles).toBe(true);

    expect((await h.request({ method: 'GET', path: '/v1/finance/loyalty-liability', userId: 'u-cash', tenantId: A })).status).toBe(403);
  });

  it('value spent twice across channels is a named difference between the books and the members', async () => {
    const h = await shop();
    await bank(h, sale('S1', 50_000, [{ kind: 'cash', amountMinor: 50_000 }])); // 10 points
    await bank(h, sale('S-A', 500, [{ kind: 'loyalty_points', amountMinor: 500, points: 10 }]));
    await bank(h, sale('S-B', 500, [{ kind: 'loyalty_points', amountMinor: 500, points: 10 }])); // the same 10 points again
    expect((await h.request({ method: 'PUT', path: '/v1/finance/posting-map', userId: 'u-acct', tenantId: A, idempotencyKey: 'map', body: DEFAULT_RETAIL_POSTING_MAP })).status).toBeLessThan(300);
    expect((await h.request({ method: 'POST', path: `/v1/finance/day-book/${DAY}/post`, userId: 'u-acct', tenantId: A, idempotencyKey: 'post' })).status).toBeLessThan(300);
    const l = await liability(h);
    // The members hold 0; the books: +500 earned (10 × 50) − 1,000 spent at the tills = −500 — the ₹5 given away twice.
    expect(l.points).toMatchObject({ outstandingPoints: 0, heldValueMinor: 0, postedMinor: -500, differenceMinor: -500 });
    expect(l.reconciles).toBe(false);
  });
});
