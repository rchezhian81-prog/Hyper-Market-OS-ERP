import { describe, it, expect } from 'vitest';
import { apiHarness, TEST_PACK_KEY, type ApiHarness } from '../support/api-harness';
import { withApprovals } from '../support/refund-approval';
import { InMemoryEventStore } from '../../packages/persistence/src/event-store';
import { loyaltyMemberKey, memberRefFor } from '../../packages/loyalty/src/index';
import { loyaltyMembersAdapter } from '../../services/api/src/adapters';

// PF-09-a (audit, HIGH): head office kept loyalty points safely, but nothing joined a sale or a return to them — a sale
// never earned and a return never took back. Owner decisions OB-28 "C and 1" (the owner sets the rule; the cashier keys
// the customer's mobile number) and OB-29 "A" (staff enrol at the desk, number checked on the customer's phone; the SMS
// code is R4). Proved end to end through the real API:
//   • loyalty is OFF until the owner sets points per ₹100 — and says so;
//   • a member joins only with consent and a checked number, and head office never stores the phone number;
//   • a sale naming a member code earns once, per the rule; a resend earns nothing more;
//   • a non-member, a sale rung before joining, or after leaving, earns nothing — said, not silent;
//   • a return takes back in proportion, across part-returns, and never below what the member holds (the shortfall is said).

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MOBILE = '98400 12345';
const KEY = loyaltyMemberKey(TEST_PACK_KEY);
const MEMBER = memberRefFor(KEY, MOBILE)!;

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
interface Loyalty { outcome: string; points?: number; shortfall?: number; detail: string }

async function shop(store = new InMemoryEventStore()): Promise<{ h: ApiHarness; store: InMemoryEventStore }> {
  const h = apiHarness({ store });
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-mgr', 'store_manager');
  await h.provisionRole(A, 'u-cash', 'cashier');
  return { h, store };
}
const setRule = async (h: ApiHarness, points: number) =>
  expect((await h.request({ method: 'PUT', path: '/v1/platform/setup/loyalty.points_per_100_inr', userId: 'u-owner', tenantId: A, idempotencyKey: `rule-${points}`, body: { value: points } })).status).toBeLessThan(300);
const enrol = (h: ApiHarness, body: Record<string, unknown>, key = 'enrol-1', userId = 'u-mgr') =>
  h.request({ method: 'POST', path: '/v1/loyalty/members', userId, tenantId: A, idempotencyKey: key, body });
const balance = async (h: ApiHarness, ref = MEMBER) =>
  ((await h.request({ method: 'GET', path: `/v1/customers/${ref}/points`, userId: 'u-owner', tenantId: A })).body as { pointsBalance?: number }).pointsBalance;

/** A ₹1,250 bill: 5 × P1 at ₹250, cash. */
const sale = (saleId: string, over: Record<string, unknown> = {}) => ({
  saleId, receiptNumber: `R-${saleId}`, laneId: 'lane-1', cashierId: 'u-cash',
  tradingDay: '2026-10-10', committedAt: new Date().toISOString(), totalMinor: 125_000, currency: 'INR', packVersion: 1,
  lines: [{ productId: 'P1', quantityMinor: 5, uom: 'each', unitPriceMinor: 25_000, lineTotalMinor: 125_000 }],
  tenders: [{ kind: 'cash', amountMinor: 125_000 }],
  customerRef: MEMBER,
  ...over,
});
const bank = async (h: ApiHarness, body: Record<string, unknown>, key?: string) =>
  ((await h.request({ method: 'POST', path: '/v1/sales', userId: 'u-cash', tenantId: A, idempotencyKey: key ?? `bank-${body['saleId']}`, body })).body as { loyalty?: Loyalty }).loyalty!;
const giveBack = async (h: ApiHarness, saleId: string, returnId: string, qty: number) => {
  const body = await withApprovals(h, A, 'u-owner', saleId, {
    returnId, reasonCode: 'customer_changed_mind', lines: [{ productId: 'P1', uom: 'each', quantityMinor: qty, disposition: 'resell' }],
    refundMinor: qty * 25_000, refundTender: 'cash', approvedBy: 'u-mgr',
  });
  const res = await h.request({ method: 'POST', path: `/v1/sales/${saleId}/returns`, userId: 'u-owner', tenantId: A, idempotencyKey: `ret-${returnId}`, body });
  expect(res.status).toBe(201);
  return (res.body as { loyalty: Loyalty }).loyalty;
};

describe('PF-09-a: a sale earns loyalty points per the owner\'s rule, and a return takes them back', () => {
  it('loyalty is OFF until the owner sets the rule — a member\'s sale earns nothing and says why', async () => {
    const { h } = await shop();
    const rule = (await h.request({ method: 'GET', path: '/v1/loyalty/rule', userId: 'u-mgr', tenantId: A })).body as { on: boolean; detail: string };
    expect(rule.on).toBe(false);
    expect(rule.detail).toMatch(/OFF/);
    expect((await enrol(h, { mobile: MOBILE, consent: true, verifiedHow: 'seen_on_phone' })).status).toBe(201);
    expect(await bank(h, sale('S0'))).toMatchObject({ outcome: 'rule_not_set' });
    expect(await balance(h)).toBeUndefined();
  });

  it('joining needs the customer\'s yes and a checked number; head office never keeps the phone number', async () => {
    const { h, store } = await shop();
    expect(codeOf(await enrol(h, { mobile: '12345', consent: true, verifiedHow: 'seen_on_phone' }, 'e-bad'))).toBe('not_a_mobile_number');
    expect(codeOf(await enrol(h, { mobile: MOBILE, verifiedHow: 'seen_on_phone' }, 'e-noconsent'))).toBe('consent_required');
    expect(codeOf(await enrol(h, { mobile: MOBILE, consent: true }, 'e-unchecked'))).toBe('number_not_checked');
    expect((await enrol(h, { mobile: MOBILE, consent: true, verifiedHow: 'seen_on_phone' }, 'e-cashier', 'u-cash')).status).toBe(403);

    const joined = await enrol(h, { mobile: '+91 98400-12345', consent: true, verifiedHow: 'seen_on_phone' });
    expect(joined.status).toBe(201);
    expect(joined.body).toMatchObject({ memberRef: MEMBER, mobileLast4: '2345', enrolled: true });
    expect((await enrol(h, { mobile: '09840012345', consent: true, verifiedHow: 'seen_on_phone' }, 'e-again')).body).toMatchObject({ alreadyMember: true });

    // What head office holds about the member: the code and the last four digits — never the number.
    const held = JSON.stringify(await loyaltyMembersAdapter({ store, now: () => new Date().toISOString(), rule: () => ({ pointsPer100Inr: 0, pointValuePaise: 0 }) }).memberHistory(A, MEMBER));
    expect(held).toContain('2345');
    expect(held).not.toContain('9840012345');
    expect(held).not.toContain('98400');

    // The desk finds them by the number in the body of a POST, never a URL.
    const found = await h.request({ method: 'POST', path: '/v1/loyalty/members/lookup', userId: 'u-cash', tenantId: A, idempotencyKey: 'look-1', body: { mobile: MOBILE } });
    expect(found.body).toMatchObject({ member: true, memberRef: MEMBER, mobileLast4: '2345', pointsBalance: 0 });
  });

  it('a member\'s sale earns once, per the rule; a resend earns nothing more', async () => {
    const { h } = await shop();
    await setRule(h, 1);
    await enrol(h, { mobile: MOBILE, consent: true, verifiedHow: 'seen_on_phone' });
    // ₹1,250 at 1 point per ₹100 → 12 points (whole points, rounded down).
    expect(await bank(h, sale('S1'))).toMatchObject({ outcome: 'earned', points: 12 });
    expect(await bank(h, sale('S1'), 'bank-S1-again')).toMatchObject({ outcome: 'already_earned', points: 12 });
    expect(await balance(h)).toBe(12);
    // A walk-in names nobody — no personal data, no points.
    expect(await bank(h, sale('S2', { customerRef: undefined }))).toMatchObject({ outcome: 'no_customer' });
    // A raw phone number is never accepted as a member.
    expect(await bank(h, sale('S3', { customerRef: '9840012345' }))).toMatchObject({ outcome: 'not_a_member_code' });
    expect(await balance(h)).toBe(12);
  });

  it('a number that is not a member — or a sale rung before joining or after leaving — earns nothing', async () => {
    const { h } = await shop();
    await setRule(h, 2);
    const before = new Date(Date.now() - 60_000).toISOString();
    await enrol(h, { mobile: MOBILE, consent: true, verifiedHow: 'seen_on_phone' });
    expect(await bank(h, sale('S-other', { customerRef: memberRefFor(KEY, '9000000001') }))).toMatchObject({ outcome: 'not_a_member' });
    expect(await bank(h, sale('S-early', { committedAt: before }))).toMatchObject({ outcome: 'not_a_member' });
    expect(await bank(h, sale('S-in'))).toMatchObject({ outcome: 'earned', points: 25 });

    expect((await h.request({ method: 'POST', path: `/v1/loyalty/members/${MEMBER}/leave`, userId: 'u-mgr', tenantId: A, idempotencyKey: 'leave-1', body: { reason: 'asked to leave' } })).status).toBe(200);
    expect(await bank(h, sale('S-after', { committedAt: new Date(Date.now() + 1_000).toISOString() }))).toMatchObject({ outcome: 'not_a_member' });
    expect((await h.request({ method: 'POST', path: '/v1/loyalty/members/lookup', userId: 'u-mgr', tenantId: A, idempotencyKey: 'look-2', body: { mobile: MOBILE } })).body).toMatchObject({ member: false });
  });

  it('a return takes back in proportion — across part-returns — exactly once each', async () => {
    const { h } = await shop();
    await setRule(h, 1);
    await enrol(h, { mobile: MOBILE, consent: true, verifiedHow: 'seen_on_phone' });
    expect(await bank(h, sale('S1'))).toMatchObject({ points: 12 });
    // 1 of 5 back (₹250): 12 × 250/1250 = 2.4 → 2.
    expect(await giveBack(h, 'S1', 'RT1', 1)).toMatchObject({ outcome: 'taken_back', points: 2, shortfall: 0 });
    // 2 more (₹750 refunded in all): 12 × 750/1250 = 7.2 → 7 in all, so 5 now.
    expect(await giveBack(h, 'S1', 'RT2', 2)).toMatchObject({ outcome: 'taken_back', points: 5 });
    // The last 2 (all of it): 12 in all, so 5 now — never more than the sale earned.
    expect(await giveBack(h, 'S1', 'RT3', 2)).toMatchObject({ outcome: 'taken_back', points: 5 });
    expect(await balance(h)).toBe(0);
  });

  it('points the member already spent cannot be taken back below zero — the shortfall is said', async () => {
    const { h } = await shop();
    await setRule(h, 1);
    await enrol(h, { mobile: MOBILE, consent: true, verifiedHow: 'seen_on_phone' });
    await bank(h, sale('S1'));
    // The member spends 10 of their 12 points.
    expect((await h.request({ method: 'POST', path: `/v1/customers/${MEMBER}/points`, userId: 'u-cash', tenantId: A, idempotencyKey: 'burn-1', body: { movementId: 'burn-1', kind: 'burn', points: 10 } })).status).toBe(201);
    // All 5 come back: 12 owed, 2 held → 2 taken, 10 shortfall.
    expect(await giveBack(h, 'S1', 'RT1', 5)).toMatchObject({ outcome: 'taken_back', points: 2, shortfall: 10 });
    expect(await balance(h)).toBe(0);
  });

  it('a return on a sale that earned nothing takes nothing back', async () => {
    const { h } = await shop();
    await bank(h, sale('S1', { customerRef: undefined }));
    expect(await giveBack(h, 'S1', 'RT1', 1)).toMatchObject({ outcome: 'no_points_on_sale' });
  });
});
