import { describe, it, expect } from 'vitest';
import { storedFraudSignals, couponUsesFrom, codRecordsFrom, type StoredCodStop, type StoredSupplierBill } from '../../packages/loss-prevention/src/signal-sources';

// M15-FR-02 (audit-2 P4): the four detectors over the shop's STORED registers, each signal reconciled to its records.

const FROM = '2026-10-01T00:00:00.000Z';
const TO = '2026-10-31T23:59:59.999Z';
const AT = '2026-10-24T12:00:00.000Z';
const none = { known: true as const, records: [] };

describe('stored fraud signals', () => {
  it('cash on delivery: a driver short three times, and cash collected two days ago not handed in — each traced to its orders', () => {
    const stop = (i: number, collected: number, at: string, handedInAt?: string): StoredCodStop => ({
      routeId: 'R1', stopId: `s${i}`, driverId: 'u-drv', orderRef: `ORD-${i}`, state: 'delivered', codExpectedMinor: 1_000, codCollectedMinor: collected,
      codMethod: 'cash', at, ...(handedInAt === undefined ? {} : { handedInAt }),
    });
    const stops = [stop(1, 900, '2026-10-22T10:00:00.000Z'), stop(2, 950, '2026-10-22T11:00:00.000Z'), stop(3, 800, '2026-10-22T12:00:00.000Z'), stop(4, 1_000, '2026-10-24T09:00:00.000Z')];
    const r = storedFraudSignals({ from: FROM, to: TO, at: AT, thresholds: {}, coupons: none, points: none, supplierBills: none, cod: { known: true, records: stops } });
    expect(r.signals.map((s) => [s.kind, s.subjectRef, s.valueMinor, s.reconciles])).toEqual([
      ['cod_collected_but_not_banked', 'u-drv', 2_650, true], ['cod_short_repeatedly', 'u-drv', 350, true],
    ]);
    expect(r.sources.find((s) => s.domain === 'delivery')).toMatchObject({ known: true, read: 4 });
    expect(r.allReconcile).toBe(true);
    expect(r.actionTaken).toBe(false);
    // A UPI stop, a failed stop and a stop with nothing to collect are not cash on delivery.
    expect(codRecordsFrom([{ ...stops[0]!, codMethod: 'upi' }, { ...stops[0]!, state: 'failed' }, { ...stops[0]!, codExpectedMinor: 0 }])).toEqual([]);
  });

  it('suppliers: a price far from the supplier\'s own history before the window; too little history says nothing', () => {
    const bill = (id: string, at: string, price: number): StoredSupplierBill => ({ invoiceId: id, supplierId: 'sup-1', capturedAt: at, lines: [{ productId: 'p-oil', quantity: 10, unitPriceMinor: price }] });
    const history = [1, 2, 3, 4, 5].map((n) => bill(`H${n}`, `2026-09-0${n}T10:00:00.000Z`, 10_000));
    const r = storedFraudSignals({ from: FROM, to: TO, at: AT, thresholds: {}, coupons: none, points: none, cod: none, supplierBills: { known: true, records: [...history, bill('B1', '2026-10-10T10:00:00.000Z', 14_000)] } });
    expect(r.signals.map((s) => [s.kind, s.subjectRef, s.confidence, s.evidenceRefs[0], s.reconciles])).toEqual([['supplier_price_out_of_history', 'sup-1', 'probable', 'B1', true]]);
    expect(r.sources.find((s) => s.domain === 'supplier')).toMatchObject({ read: 1, history: 5 });
    const thin = storedFraudSignals({ from: FROM, to: TO, at: AT, thresholds: {}, coupons: none, points: none, cod: none, supplierBills: { known: true, records: [bill('H1', '2026-09-01T10:00:00.000Z', 10_000), bill('B1', '2026-10-10T10:00:00.000Z', 14_000)] } });
    expect(thin.signals).toEqual([]);
  });

  it('a register that cannot be read is "not known", never zero; a percentage coupon is counted, not valued', () => {
    const r = storedFraudSignals({ from: FROM, to: TO, at: AT, thresholds: {}, coupons: { known: false, why: 'the coupon register could not be read' }, points: none, cod: none, supplierBills: none });
    expect(r.sources[0]).toEqual({ domain: 'coupon', register: 'the coupon register', known: false, read: 0, why: 'the coupon register could not be read' });
    const uses = couponUsesFrom([{ redemptionId: 'r1', code: 'P10', saleId: 'S1', at: AT, coupon: { kind: 'percent_off', maxPerCustomer: 1 } }]);
    expect(uses).toEqual({ uses: [expect.objectContaining({ discountMinor: 0, accountRef: 'walk-in', limitPerAccount: 1 })], notValued: 1 });
  });

  it('points from nowhere name the person who issued them; records outside the window are not read', () => {
    const r = storedFraudSignals({
      from: FROM, to: TO, at: AT, thresholds: {}, coupons: none, cod: none, supplierBills: none,
      points: { known: true, records: [
        { movementId: 'mv-1', customerId: 'M-1', delta: 500, reason: 'earn', sourceRef: null, at: '2026-10-05T10:00:00.000Z', issuedBy: 'u-cash' },
        { movementId: 'mv-2', customerId: 'M-1', delta: 50, reason: 'earn', sourceRef: 'S-9', at: '2026-10-05T10:00:00.000Z' },
        { movementId: 'mv-0', customerId: 'M-2', delta: 900, reason: 'earn', sourceRef: null, at: '2026-09-05T10:00:00.000Z', issuedBy: 'u-cash' },
      ] },
    });
    expect(r.signals.map((s) => [s.kind, s.subjectRef, s.evidenceRefs, s.reconciles])).toEqual([['loyalty_earn_without_sale', 'u-cash', ['mv-1'], true]]);
    expect(r.sources.find((s) => s.domain === 'loyalty')!.read).toBe(2);
  });
});
