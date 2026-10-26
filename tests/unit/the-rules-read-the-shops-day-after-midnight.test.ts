import { describe, it, expect } from 'vitest';
import { tradingDayOfStamp, DEFAULT_SHOP_CALENDAR } from '../../packages/calendar/src/index';
import { redeemCoupon, type Coupon } from '../../packages/loyalty/src/coupons';
import { redeemValue, type Instrument } from '../../packages/loyalty/src/stored-value';
import { agedStockLots, type DatedMovement } from '../../packages/stock/src';
import { stockAdjustmentCheck, type StockAdjustmentSource } from '../../services/finance/src/period-books';
import { usageRecordsOf, type UsageSnapshot } from '../../services/platform/src/metering';
import { giftCardTimeOfSupplyAtRedemption } from '../../services/customer/src/stored-value';
import { planPayablesPostings } from '../../packages/finance/src/payables';

// Re-audit lane 1 R1b · R1c (M01-FR-02 · section 6): the rules that judge a date read the SHOP's day, never the UTC date
// of the moment. Every case is at a moment between 00:00 and 05:30 IST, where the UTC date is the previous day (and, on
// the 1st, the previous month). Each expectation failed on the code that sliced the UTC moment.

const AT_0040_IST_1_NOV = '2026-10-31T19:10:00.000Z'; // 00:40 IST on Sunday 1 November 2026
const AT_0510_IST_1_SEP = '2026-08-31T23:40:00.000Z'; // 05:10 IST on 1 September 2026

describe('a time stamp from another system (MG-09 delta sales)', () => {
  it('an instant is read in the shop calendar; a local stamp is the shop clock already', () => {
    expect(tradingDayOfStamp(AT_0040_IST_1_NOV)).toBe('2026-11-01');
    expect(tradingDayOfStamp('2026-11-01T00:40:00+05:30')).toBe('2026-11-01');
    expect(tradingDayOfStamp('2026-11-01T00:40:00')).toBe('2026-11-01');
    expect(tradingDayOfStamp('2026-11-01 00:40')).toBe('2026-11-01');
    expect(tradingDayOfStamp('2026-11-01')).toBe('2026-11-01');
    // A 02:00 cut-off puts 00:40 in the previous trading day, either way.
    expect(tradingDayOfStamp('2026-11-01T00:40:00', { ...DEFAULT_SHOP_CALENDAR, tradingDayCutoff: '02:00' })).toBe('2026-10-31');
    expect(() => tradingDayOfStamp('yesterday-ish')).toThrow(RangeError);
  });
});

describe('a coupon and a voucher are judged on the shop date', () => {
  it('a coupon valid until 31 October is expired at 00:40 IST on 1 November', () => {
    const coupon: Coupon = { code: 'OCT', kind: 'amount_off', valueMinor: 5_000, issuedAt: '2026-10-01T04:30:00Z', validUntil: '2026-10-31', maxRedemptions: 5, maxPerCustomer: 5 };
    const r = redeemCoupon({ coupon, redemption: { redemptionId: 'R1', code: 'OCT', customerRef: 'c1', at: AT_0040_IST_1_NOV, saleId: 'S1' }, knownRedemptions: [], basketMinor: 50_000 });
    expect(r).toMatchObject({ redeemed: false, outcome: 'expired' });
  });

  it('a coupon issued at 00:40 IST on 1 November is valid that day (not "not valid until") ', () => {
    const coupon: Coupon = { code: 'NOV', kind: 'amount_off', valueMinor: 5_000, issuedAt: AT_0040_IST_1_NOV, validUntil: '2026-11-30', maxRedemptions: 5, maxPerCustomer: 5 };
    const r = redeemCoupon({ coupon, redemption: { redemptionId: 'R2', code: 'NOV', customerRef: 'c1', at: '2026-10-31T19:20:00.000Z', saleId: 'S2' }, knownRedemptions: [], basketMinor: 50_000 });
    expect(r.outcome).not.toBe('not_yet_valid');
  });

  it('a gift card that expired on 31 October cannot be spent at 00:40 IST on 1 November', () => {
    const card: Instrument = { instrumentId: 'GC-1', kind: 'gift_card', ownerRef: 'c1', issuedAt: '2026-07-01T06:00:00Z', expiresOn: '2026-10-31' };
    const r = redeemValue({
      instrument: card,
      movements: [{ movementId: 'issue', instrumentId: 'GC-1', kind: 'issue', deltaMinor: 50_000, at: card.issuedAt, channel: 'store' }],
      movement: { movementId: 'm1', instrumentId: 'GC-1', kind: 'redeem', deltaMinor: -10_000, at: AT_0040_IST_1_NOV, channel: 'store' },
    });
    expect(r).toMatchObject({ redeemed: false, outcome: 'expired' });
  });

  it('a gift card issued at 00:40 IST has that day as its issue date for GST (A12)', () => {
    const card = { instrumentId: 'g1', kind: 'gift_card' as const, ownerRef: 'c1', issuedAt: AT_0040_IST_1_NOV, timeOfSupply: { basis: 'issue' as const, timeOfSupply: '2026-11-01', detail: '' } };
    // The default issue date (no calendar named) is the shop's trading day of the issue, never its UTC date.
    expect(giftCardTimeOfSupplyAtRedemption(card, '2026-11-03')).toMatchObject({ basis: 'issue', timeOfSupply: '2026-11-01' });
  });
});

describe('stock and the books read the shop day and month', () => {
  it('a lot received at 05:10 IST on 1 September is aged from 1 September', () => {
    const m: DatedMovement = { productId: 'P1', locationId: 'L1', effect: 1, quantityMinor: 10, isPurchaseReceipt: true, occurredAt: AT_0510_IST_1_SEP, unitCostMinor: 1_000 };
    expect(agedStockLots([m], 'INR').lots.map((l) => l.receivedOn)).toEqual(['2026-09-01']);
    expect(agedStockLots([m], 'INR', 'UTC').lots.map((l) => l.receivedOn)).toEqual(['2026-08-31']);
  });

  it('a write-off at 00:40 IST on 1 November is November\'s stock adjustment, not October\'s', () => {
    const s: StockAdjustmentSource = { sourceId: 'write_off:W1', kind: 'stock_write_off', productId: 'P1', locationId: 'L1', quantityMinor: 1, uom: 'ea', valueMinor: 500, at: AT_0040_IST_1_NOV, by: 'u1', approvedBy: null, reason: 'damaged' };
    expect(stockAdjustmentCheck('2026-11', [s], []).unposted).toEqual(['write_off:W1']);
    expect(stockAdjustmentCheck('2026-10', [s], []).check).toBeNull();
  });

  it('a supplier bill matched and a debit note decided at 00:40 IST on 1 November carry 1 November as their journal date', () => {
    const planned = planPayablesPostings([{
      supplierId: 'SUP-1',
      invoices: [{ invoiceId: 'INV-1', payableMinor: 11_800, matched: true, matchedAt: AT_0040_IST_1_NOV }],
      debitNotes: [{ debitNoteRef: 'DN-1', valueMinor: 1_180, decidedAt: AT_0040_IST_1_NOV }],
      payments: [],
    }], []);
    expect(planned.map((p) => [p.sourceId, p.documentDate])).toEqual([['INV-1', '2026-11-01'], ['DN-1', '2026-11-01']]);
  });

  it('a usage snapshot taken at 00:40 IST on 1 November counts in November, dated 1 November', () => {
    const snap: UsageSnapshot = { tenantId: 't1', hour: '2026-10-31T19', stores: 1, lanes: 2, users: 3, aiSpendMinor: 0, at: AT_0040_IST_1_NOV };
    const nov = usageRecordsOf('t1', [snap], '2026-11');
    expect(nov).toHaveLength(3);
    expect(nov[0]!.onDate).toBe('2026-11-01');
    expect(usageRecordsOf('t1', [snap], '2026-10')).toHaveLength(0);
  });
});
