import { describe, it, expect } from 'vitest';
import { PosSession, taxRateFromPercent } from '../../apps/pos/src/index';
import { Ledger, InMemoryLedgerStore } from '../../packages/ledger/src/index';
import { SyncOutbox } from '../../packages/sync/src/index';
import { money } from '../../packages/contracts/src/money';
import {
  readCouponPack, readGiftCardPack, couponForTill, giftCardAvailable, assessGiftCardTenders, assessGiftCardSale,
  vouchersOfSaleRecord, maskVoucherCode, giftCardCodeRefusal, giftCardMovementId, couponRedemptionId,
  DEFAULT_GIFT_CARD_OFFLINE_CAP_MINOR, THIS_CUSTOMER,
} from '../../packages/loyalty/src/till-vouchers';
import type { Coupon } from '../../packages/loyalty/src/coupons';
import { withoutCardData } from '../../packages/tender/src/tender-card-data';

// W3 · D06-FR-03 · OB-673 (owner, 2 Nov 2026: the till accepts a coupon with the internet down; a coupon used twice is an
// exception for the manager, never blocking the sale) and D07-FR-04 · OB-677 (a gift card is taken offline up to ₹500 per
// till per card; above it the till asks for another payment until the link is back). The pure rules the store computer and
// the till run with no network. Synthetic data only.

const NOW = '2026-11-02T06:30:00Z'; // 12:00 at the shop
const COUPON: Coupon = { code: 'DIWALI50', kind: 'amount_off', valueMinor: 5_000, issuedAt: '2026-10-25T00:00:00Z', validUntil: '2026-11-30', maxRedemptions: 1, maxPerCustomer: 1 };
const NO_USES = { spends: [], sold: [], couponUses: [] };

describe('OB-673 · the store pack carries what the till needs to judge a coupon offline', () => {
  const pack = readCouponPack({ coupons: [COUPON, { code: 'BAD' }], redemptions: [] }, '2026-11-02T06:00:00Z')!;

  it('reads the section defensively and says how old the copy is', () => {
    expect(pack.coupons.map((c) => c.code)).toEqual(['DIWALI50']); // a part that does not read is left out, never guessed
    const c = couponForTill({ pack, code: 'diwali50', uses: NO_USES, now: NOW });
    expect(c).toMatchObject({ known: true, cacheAgeMinutes: 30, staleAfterMinutes: 15, customerSegments: [] });
    expect(readCouponPack(undefined, NOW)).toBeUndefined();
    expect(couponForTill({ pack: undefined, code: 'X', uses: NO_USES, now: NOW })).toMatchObject({ known: false, refusedBecause: 'coupons_not_known' });
    expect(couponForTill({ pack, code: 'NOPE', uses: NO_USES, now: NOW })).toMatchObject({ known: false, refusedBecause: 'coupon_not_known' });
  });

  it('counts a use this store computer saved but head office has not seen, and never hands a member code to the till', () => {
    const record = { id: 'S-1', laneId: 'lane-1', committedAt: NOW, customerRef: 'm-aaaaaaaaaaaaaaaaaaaaaaaa', coupons: [{ code: 'DIWALI50', discountMinor: 5_000 }], tenders: [] };
    const uses = vouchersOfSaleRecord(record);
    expect(uses.couponUses).toEqual([{ redemptionId: couponRedemptionId('S-1', 'DIWALI50'), code: 'DIWALI50', saleId: 'S-1', at: NOW, customerRef: 'm-aaaaaaaaaaaaaaaaaaaaaaaa' }]);
    const forSame = couponForTill({ pack, code: 'DIWALI50', uses, memberRef: 'm-aaaaaaaaaaaaaaaaaaaaaaaa', isMember: true, now: NOW });
    expect(forSame.known && forSame.knownRedemptions.map((r) => r.customerRef)).toEqual([THIS_CUSTOMER]);
    expect(forSame.known && forSame.customerSegments).toEqual(['member']);
    const forOther = couponForTill({ pack, code: 'DIWALI50', uses, memberRef: 'm-bbbbbbbbbbbbbbbbbbbbbbbb', now: NOW });
    expect(JSON.stringify(forOther)).not.toContain('m-aaaa');
  });
});

describe('OB-673 · the till spreads a coupon over the lines it may reach, with no network', () => {
  const till = () => {
    const s = new PosSession(
      { laneId: 'lane-1', cashierId: 'clerk-1', tradingDay: '2026-11-02', currency: 'INR', defaultTaxRate: taxRateFromPercent(5) },
      new Ledger(new InMemoryLedgerStore()), new SyncOutbox(),
      (_id, record) => { saved.push(record); return Promise.resolve({ committed: true as const, durable: true as const, detail: 'test', laneMessage: 'Saved.' }); },
    );
    s.setNow(NOW);
    return s;
  };
  const saved: string[] = [];
  const tillCoupon = (over: Partial<Coupon> = {}, knownRedemptions: readonly { redemptionId: string; code: string; saleId: string; at: string }[] = []) => ({
    code: 'DIWALI50', coupon: { ...COUPON, ...over }, knownRedemptions, customerSegments: [], cacheAgeMinutes: 0, staleAfterMinutes: 15,
  });

  it('₹50 off a ₹300 + ₹100 bill comes off the lines by value; the lines still add to what is paid; the record carries the coupon', async () => {
    const s = till();
    s.scan({ productId: 'P1', description: 'Rice', unitPrice: money(30_000, 'INR'), quantityMinor: 1, uom: 'ea' });
    s.scan({ productId: 'P2', description: 'Dal', unitPrice: money(10_000, 'INR'), quantityMinor: 1, uom: 'ea' });
    expect(s.setCoupon(tillCoupon())).toMatchObject({ redeemed: true, discountMinor: 5_000 });
    expect(s.totals().payable.minor).toBe(35_000);
    expect(s.totals().couponDiscount?.minor).toBe(5_000);
    await s.commit('S-9', 'R-9', NOW, [{ kind: 'cash', amount: money(35_000, 'INR'), status: 'settled' }]);
    const rec = JSON.parse(saved.at(-1)!) as { lines: { lineTotalMinor: number }[]; coupons: unknown; total: number };
    expect(rec.lines.map((l) => l.lineTotalMinor)).toEqual([26_250, 8_750]);
    expect(rec.total).toBe(35_000);
    expect(rec.coupons).toEqual([{ code: 'DIWALI50', discountMinor: 5_000 }]);
  });

  it('a coupon this store already counts as used, an expired one, or a bill too small is refused in the engine\'s words — and stays off', () => {
    const s = till();
    s.scan({ productId: 'P1', description: 'Rice', unitPrice: money(30_000, 'INR'), quantityMinor: 1, uom: 'ea' });
    expect(s.setCoupon(tillCoupon({}, [{ redemptionId: 'x', code: 'DIWALI50', saleId: 'S-0', at: NOW }]))).toMatchObject({ redeemed: false, outcome: 'limit_reached' });
    expect(s.setCoupon(tillCoupon({ validUntil: '2026-11-01' }))).toMatchObject({ redeemed: false, outcome: 'expired' });
    expect(s.setCoupon(tillCoupon({ minimumBasketMinor: 50_000 }))).toMatchObject({ redeemed: false, outcome: 'basket_too_small' });
    expect(s.couponCode()).toBeNull();
    expect(s.totals().payable.minor).toBe(30_000);
  });

  it('a new customer on the bill, or a new bill, takes the coupon off', () => {
    const s = till();
    s.scan({ productId: 'P1', description: 'Rice', unitPrice: money(30_000, 'INR'), quantityMinor: 1, uom: 'ea' });
    s.setCoupon(tillCoupon());
    expect(s.couponCode()).toBe('DIWALI50');
    s.setLoyaltyMobile('9840077777');
    expect(s.couponCode()).toBeNull();
    s.setCoupon(tillCoupon());
    s.newSale();
    expect(s.couponCode()).toBeNull();
  });
});

describe('OB-677 · a gift card at the store computer: offline up to the owner\'s limit per till per card', () => {
  const pack = readGiftCardPack({ offlineCapMinor: 50_000, cards: [{ code: 'GC-1001', balanceMinor: 200_000, appliedMovementIds: [] }, { code: 'GC-OLD', balanceMinor: 10_000, expiresOn: '2026-10-31', appliedMovementIds: [] }] }, NOW)!;
  const spend = (saleId: string, amount: number, laneId: string, offline: boolean) => vouchersOfSaleRecord({
    id: saleId, laneId, committedAt: NOW, tenders: [{ kind: 'gift_card', amount: { minor: amount, currency: 'INR' }, giftCard: { code: 'GC-1001', ...(offline ? { capturedOffline: true } : {}) } }],
  });

  it('online the whole balance may be taken; offline at most ₹500 per till per card, the rest counted against this till only', () => {
    expect(giftCardAvailable({ pack, code: 'gc-1001', uses: NO_USES, laneId: 'lane-1', linkUp: true, today: '2026-11-02' })).toMatchObject({ known: true, balanceMinor: 200_000, mayTakeMinor: 200_000, last4: '1001' });
    expect(giftCardAvailable({ pack, code: 'GC-1001', uses: NO_USES, laneId: 'lane-1', linkUp: false, today: '2026-11-02' })).toMatchObject({ mayTakeMinor: 50_000, offlineRemainingMinor: 50_000 });
    const s1 = spend('S-1', 30_000, 'lane-1', true);
    expect(s1.spends[0]).toMatchObject({ movementId: giftCardMovementId('S-1', 0), capturedOffline: true });
    expect(giftCardAvailable({ pack, code: 'GC-1001', uses: s1, laneId: 'lane-1', linkUp: false, today: '2026-11-02' })).toMatchObject({ balanceMinor: 170_000, offlineRemainingMinor: 20_000, mayTakeMinor: 20_000 });
    // Another till on the same card has its own ₹500 (OB-677: per till per card).
    expect(giftCardAvailable({ pack, code: 'GC-1001', uses: s1, laneId: 'lane-2', linkUp: false, today: '2026-11-02' })).toMatchObject({ mayTakeMinor: 50_000 });
    expect(DEFAULT_GIFT_CARD_OFFLINE_CAP_MINOR).toBe(50_000);
    expect(readGiftCardPack({ cards: [] }, NOW)!.offlineCapMinor).toBe(50_000); // no cap sent → the owner's default, never "no limit"
  });

  it('decides a bill\'s gift-card tenders before the disk: above the offline limit → take another payment; within it → stamped offline', () => {
    const rec = (amount: number) => ({ id: 'S-2', tenders: [{ kind: 'gift_card', amount: { minor: amount, currency: 'INR' }, status: 'settled', giftCard: { code: 'gc-1001' } }] });
    const over = assessGiftCardTenders({ record: rec(60_000), pack, uses: NO_USES, laneId: 'lane-1', linkUp: false, today: '2026-11-02' });
    expect(over).toMatchObject({ ok: false, refusedBecause: 'gift_card_over_offline_limit' });
    expect(!over.ok && over.laneMessage).toMatch(/until the link is back/);
    const ok = assessGiftCardTenders({ record: rec(50_000), pack, uses: NO_USES, laneId: 'lane-1', linkUp: false, today: '2026-11-02' });
    expect(ok.ok && (ok.record['tenders'] as { giftCard: unknown }[])[0]!.giftCard).toEqual({ code: 'GC-1001', capturedOffline: true });
    const online = assessGiftCardTenders({ record: rec(150_000), pack, uses: NO_USES, laneId: 'lane-1', linkUp: true, today: '2026-11-02' });
    expect(online.ok && (online.record['tenders'] as { giftCard: unknown }[])[0]!.giftCard).toEqual({ code: 'GC-1001' });
    expect(assessGiftCardTenders({ record: rec(300_000), pack, uses: NO_USES, laneId: 'lane-1', linkUp: true, today: '2026-11-02' })).toMatchObject({ ok: false, refusedBecause: 'gift_card_balance_too_low' });
    expect(assessGiftCardTenders({ record: { tenders: [{ kind: 'gift_card', amountMinor: 100, giftCard: { code: 'GC-OLD' } }] }, pack, uses: NO_USES, laneId: 'lane-1', linkUp: true, today: '2026-11-02' })).toMatchObject({ ok: false, refusedBecause: 'gift_card_expired' });
    expect(assessGiftCardTenders({ record: { tenders: [{ kind: 'gift_card', amountMinor: 100, giftCard: { code: 'GC-NONE' } }] }, pack, uses: NO_USES, laneId: 'lane-1', linkUp: true, today: '2026-11-02' })).toMatchObject({ ok: false, refusedBecause: 'gift_card_not_known' });
  });

  it('a card sold on this store computer is spendable here before head office has it; selling the same code twice is refused', () => {
    const sale = { id: 'GC-S1', kind: 'gift_card_sale', laneId: 'lane-1', committedAt: NOW, total: 100_000, giftCardsSold: [{ code: 'gc-2002', faceValueMinor: 100_000 }], tenders: [{ kind: 'cash', amount: { minor: 100_000 } }] };
    const decided = assessGiftCardSale({ record: sale, pack, uses: NO_USES });
    expect(decided.ok && decided.record['giftCardsSold']).toEqual([{ code: 'GC-2002', faceValueMinor: 100_000 }]);
    const uses = vouchersOfSaleRecord(decided.ok ? decided.record : {});
    expect(giftCardAvailable({ pack, code: 'GC-2002', uses, laneId: 'lane-1', linkUp: false, today: '2026-11-02' })).toMatchObject({ known: true, balanceMinor: 100_000, mayTakeMinor: 50_000 });
    expect(assessGiftCardSale({ record: sale, pack, uses })).toMatchObject({ ok: false, refusedBecause: 'gift_card_already_issued' });
    expect(assessGiftCardSale({ record: { ...sale, giftCardsSold: [{ code: 'GC-1001', faceValueMinor: 100_000 }] }, pack, uses: NO_USES })).toMatchObject({ ok: false, refusedBecause: 'gift_card_already_issued' });
    expect(assessGiftCardSale({ record: { ...sale, tenders: [{ kind: 'store_credit', amountMinor: 100_000 }] }, pack, uses: NO_USES })).toMatchObject({ ok: false, refusedBecause: 'gift_card_sale_tender_not_allowed' });
    expect(assessGiftCardSale({ record: { ...sale, total: 1 }, pack, uses: NO_USES })).toMatchObject({ ok: false, refusedBecause: 'gift_card_sale_does_not_add_up' });
  });

  it('hard rule #3: a gift card is never a bank card — a card-number-shaped code is refused, and a code is shown by its last four only', () => {
    expect(giftCardCodeRefusal('4111111111111111')).toMatch(/bank card number/);
    expect(giftCardCodeRefusal('GC-1001')).toBeUndefined();
    expect(maskVoucherCode('GC-1001')).toBe('••••1001');
    expect(maskVoucherCode('AB')).toBe('••••');
    // The gift-card fact survives the store computer's card-data cleaning; a bank card number put there does not.
    expect(withoutCardData([{ kind: 'gift_card', amountMinor: 100, giftCard: { code: 'GC-1001' } }]).removed).toEqual([]);
    expect(withoutCardData([{ kind: 'gift_card', amountMinor: 100, giftCard: { code: '4111111111111111' } }]).removed[0]!.fields).toEqual(['giftCard']);
  });
});
