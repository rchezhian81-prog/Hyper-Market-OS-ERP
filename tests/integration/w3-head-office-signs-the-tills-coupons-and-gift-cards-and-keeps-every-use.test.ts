import { describe, it, expect, beforeAll } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

/**
 * **W3 · D06-FR-03 · OB-673 · D07-FR-04 · OB-677 — head office's side.** The signed store pack carries what the store
 * computer judges a coupon and a gift card by with no network (the live coupons and their uses; every gift card's balance,
 * the till redemptions already in it, and the owner's offline limit from the tenant setting — ₹500 until he changes it).
 * A gift card SOLD at a till arrives through its own door: issued once (a resend is the same card), never refused; a code
 * head office already holds is not overwritten — the customer paid, so it is kept and raised as `gift_card_sold_twice`.
 * A till bill's coupon past its limit is kept and raised, never refused. Synthetic data only.
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0673';
const STORE = 'S1';
const SETTINGS = { tradingDayCutoff: '00:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 5_000, cashVarianceToleranceMinor: 5_000, privacySlaDays: 15, warehouseId: STORE };

describe('head office signs the tills\' coupons and gift cards into the store pack and keeps every use (OB-673 · OB-677)', () => {
  let h: ApiHarness;
  const req = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, key?: string) =>
    h.request({ method, path, userId, tenantId: A, ...(body === undefined ? {} : { body }), ...(method === 'POST' ? { idempotencyKey: key ?? `k-${Math.random()}` } : {}) });

  beforeAll(async () => {
    h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.enableFeature(A, 'loyalty');
    await h.provisionRole(A, 'u-box', 'store_computer', [STORE]);
    await h.provisionRole(A, 'u-cash', 'cashier', [STORE]);
    expect((await req('POST', '/v1/org/nodes/C1', 'u-owner', { kind: 'company', name: 'SRE Retail' })).status).toBeLessThan(300);
    expect((await req('POST', `/v1/org/nodes/${STORE}`, 'u-owner', { kind: 'branch', name: 'SRE Hyper Market', parentId: 'C1', companyId: 'C1' })).status).toBeLessThan(300);
    expect((await req('POST', `/v1/stores/${STORE}/settings`, 'u-owner', SETTINGS)).status).toBeLessThan(300);
    expect((await req('POST', '/v1/loyalty/coupons/DIWALI50', 'u-owner', { kind: 'amount_off', valueMinor: 5_000, validUntil: '2099-12-31', maxRedemptions: 1, maxPerCustomer: 1 })).status).toBe(201);
    expect((await req('POST', '/v1/loyalty/coupons/OLD10', 'u-owner', { kind: 'amount_off', valueMinor: 1_000, validUntil: '2020-01-31', maxRedemptions: 5, maxPerCustomer: 1 })).status).toBe(201);
    expect((await req('POST', '/v1/stored-value/instruments', 'u-owner', { instrumentId: 'GC-1001', kind: 'gift_card', ownerRef: 'c-gift', faceValueMinor: 80_000, expiresOn: '2099-12-31' })).status).toBe(201);
    expect((await req('POST', '/v1/stored-value/instruments', 'u-owner', { instrumentId: 'SC-1', kind: 'store_credit', ownerRef: 'c-gift', faceValueMinor: 5_000 })).status).toBe(201);
  });

  const pack = async () => ((await req('GET', `/v1/store-packs/${STORE}`, 'u-box')).body as { sections: Record<string, unknown> }).sections;

  it('the pack carries the live coupons and the gift cards with the owner\'s ₹500 offline limit, and no build time inside', async () => {
    const s = await pack();
    expect(s['coupons']).toEqual({ coupons: [expect.objectContaining({ code: 'DIWALI50', maxRedemptions: 1 })], redemptions: [] }); // an expired coupon is not sent
    expect(s['giftCards']).toEqual({ offlineCapMinor: 50_000, cards: [{ code: 'GC-1001', balanceMinor: 80_000, expiresOn: '2099-12-31', appliedMovementIds: [] }] }); // store credit is not a gift card
    // No build time inside: an unchanged register signs the same contents.
    expect((await pack())['giftCards']).toEqual(s['giftCards']);
    // The limit is a tenant setting (OB-677: the owner's ₹500 is its default): its question is in store setup.
    const setup = await req('GET', '/v1/platform/setup', 'u-owner');
    expect(JSON.stringify(setup.body)).toContain('loyalty.gift_card_offline_cap_paise');
  });

  it('a gift card sold at a till is issued once, its own code its id; a code already held is kept as a finding, never overwritten', async () => {
    const sale = (saleId: string, code: string) => ({
      saleId, laneId: 'lane-1', cashierId: 'u-cash', tradingDay: '2026-11-02', committedAt: new Date(Date.now() - 1_000).toISOString(),
      totalMinor: 30_000, currency: 'INR', cards: [{ code, faceValueMinor: 30_000 }], tenders: [{ kind: 'cash', amountMinor: 30_000 }],
    });
    const first = await req('POST', '/v1/stored-value/till-sales', 'u-box', sale('GC-SALE-1', 'GC-2002'), 'gc-1');
    expect(first.status).toBe(202);
    expect(first.body).toMatchObject({ recorded: true, cards: [{ card: '••••2002', balanceMinor: 30_000 }], exceptions: [] });
    // The same sale again (a lost answer) — the same card, nothing added.
    const again = await req('POST', '/v1/stored-value/till-sales', 'u-box', sale('GC-SALE-1', 'GC-2002'), 'gc-1-again');
    expect(again.body).toMatchObject({ cards: [{ card: '••••2002', alreadyIssued: true }] });
    expect(((await req('GET', '/v1/stored-value/instruments/GC-2002', 'u-owner')).body as { balanceMinor: number }).balanceMinor).toBe(30_000);
    // Another till sells a card under a code head office already holds: kept, raised, the existing card untouched.
    const twice = await req('POST', '/v1/stored-value/till-sales', 'u-box', sale('GC-SALE-2', 'GC-1001'), 'gc-2');
    expect(twice.status).toBe(202);
    expect((twice.body as { exceptions: { kind: string; differenceMinor: number; detail: string }[] }).exceptions).toEqual([expect.objectContaining({ kind: 'gift_card_sold_twice', differenceMinor: 30_000 })]);
    expect(((await req('GET', '/v1/stored-value/instruments/GC-1001', 'u-owner')).body as { balanceMinor: number }).balanceMinor).toBe(80_000);
    // Someone with no relay right is refused before anything is issued (default-deny).
    expect((await req('POST', '/v1/stored-value/till-sales', 'u-nobody', sale('GC-SALE-3', 'GC-3003'), 'gc-3')).status).toBe(403);
    expect((await req('GET', '/v1/stored-value/instruments/GC-3003', 'u-owner')).status).toBe(404);
  });

  it('a till bill\'s expired coupon and an unknown gift card are kept and raised for the manager — the sale stands', async () => {
    const res = await req('POST', '/v1/sales', 'u-box', {
      saleId: 'S-T1', receiptNumber: 'R-T1', laneId: 'lane-1', cashierId: 'u-cash', tradingDay: '2026-11-02', committedAt: new Date(Date.now() - 1_000).toISOString(),
      totalMinor: 9_000, currency: 'INR', packVersion: 1, coupons: [{ code: 'OLD10', discountMinor: 1_000 }],
      lines: [{ productId: 'P1', quantityMinor: 1, uom: 'ea', unitPriceMinor: 10_000, lineTotalMinor: 9_000 }],
      tenders: [{ kind: 'gift_card', amountMinor: 4_000, giftCard: { code: 'GC-NOPE', capturedOffline: true } }, { kind: 'cash', amountMinor: 5_000 }],
    }, 'sale-t1');
    expect(res.status).toBe(202);
    const kinds = (res.body as { vouchers: { exceptions: { kind: string }[] } }).vouchers.exceptions.map((e) => e.kind).sort();
    expect(kinds).toEqual(['coupon_not_valid_when_used', 'gift_card_not_valid_when_spent']);
    const coupon = (await req('GET', '/v1/loyalty/coupons/OLD10', 'u-owner')).body as { redemptionCount: number };
    expect(coupon.redemptionCount).toBe(1); // the use is kept — the customer had the discount
  });
});
