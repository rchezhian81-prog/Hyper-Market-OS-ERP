import { describe, it, expect } from 'vitest';
import { priceVariance, type PpvReceipt, type PpvOrder, type PpvAgreement } from '../../packages/purchasing/src/price-variance';

// FG-4 · D03-FR-05: the purchase-price variance engine. Received cost against the order's price and the contract price on
// the day; a line that cannot be compared is counted by its reason, never dropped and never a zero.

const INR = 'INR' as const;
const receipt = (over: Partial<PpvReceipt> = {}): PpvReceipt => ({
  grnId: 'g1', number: 'GRN-1', poId: 'po1', supplierId: null, receivedOn: '2026-10-20', locationId: 'wh',
  lines: [{ lineId: 'L1', productId: 'rice', keptMinor: 10, uom: 'ea', unitCost: { minor: 5_200, currency: INR } }], ...over,
});
const order = (over: Partial<PpvOrder> = {}): PpvOrder => ({ poId: 'po1', number: 'PO-1', supplierId: 'S1', lines: [{ productId: 'rice', unitCost: { minor: 5_000, currency: INR } }], ...over });
const agreement = (over: Partial<PpvAgreement> = {}): PpvAgreement => ({
  agreementId: 'B1', supplierId: 'S1', currency: INR, validFrom: '2026-10-01', validTo: '2026-12-31', approved: true,
  lines: [{ productId: 'rice', agreedUnitCost: { minor: 4_800 } }], ...over,
});

describe('purchase-price variance (D03-FR-05)', () => {
  it('values the variance on what was kept, against the order and the contract on the day', () => {
    const r = priceVariance({ receipts: [receipt()], orders: new Map([['po1', order()]]), agreements: [agreement()] });
    expect(r.lines[0]).toMatchObject({ receivedValueMinor: 52_000, supplierId: 'S1', order: { valueMinor: 50_000, varianceMinor: 2_000, varianceBps: 400, basis: 'purchase_order' }, contract: { agreementId: 'B1', varianceMinor: 4_000 } });
    expect(r.totals).toMatchObject({ lines: 1, comparedLines: 1, varianceMinor: 2_000, linesAboveOrder: 1, linesBelowOrder: 0, contractLines: 1, contractVarianceMinor: 4_000 });
  });

  it('a contract that is unapproved, out of date, another supplier\'s or silent on the product is no contract price', () => {
    for (const a of [agreement({ approved: false }), agreement({ validTo: '2026-10-19' }), agreement({ supplierId: 'S2' }), agreement({ lines: [{ productId: 'dal', agreedUnitCost: { minor: 1 } }] })]) {
      expect(priceVariance({ receipts: [receipt()], orders: new Map([['po1', order()]]), agreements: [a] }).lines[0]!.contract).toBeUndefined();
    }
  });

  it('a call-off release is compared at the agreement price it carries; a case cost (per N) is exact', () => {
    const r = priceVariance({
      receipts: [receipt({ lines: [{ lineId: 'L1', productId: 'rice', keptMinor: 24, uom: 'ea', unitCost: { minor: 25_000, per: 24, currency: INR } }] })],
      orders: new Map([['po1', order({ blanketAgreementId: 'B1', lines: [{ productId: 'rice', unitCost: { minor: 24_000, per: 24, currency: INR } }] })]]), agreements: [],
    });
    expect(r.lines[0]!.order).toMatchObject({ valueMinor: 24_000, varianceMinor: 1_000, basis: 'blanket_release' });
    expect(r.lines[0]!.receivedUnitCost).toEqual({ minor: 25_000, per: 24 });
  });

  it('every line that cannot be compared is counted by its reason and kept out of the variance, never a zero', () => {
    const r = priceVariance({
      receipts: [
        receipt({ grnId: 'a', poId: null }),
        receipt({ grnId: 'b', poId: 'ghost' }),
        receipt({ grnId: 'c', lines: [{ lineId: 'L1', productId: 'sugar', keptMinor: 1, uom: 'ea', unitCost: { minor: 100, currency: INR } }] }),
        receipt({ grnId: 'd', lines: [{ lineId: 'L1', productId: 'rice', keptMinor: 1, uom: 'ea', unitCost: { minor: 100, currency: 'USD' } }] }),
      ],
      orders: new Map([['po1', order()]]), agreements: [],
    });
    expect(r.totals.notCompared).toEqual({ no_purchase_order: 1, order_not_held: 1, product_not_on_order: 1, currency_differs: 1, not_yet_billed: 0 });
    expect(r.totals).toMatchObject({ lines: 4, comparedLines: 0, varianceMinor: 0, varianceBps: null });
    expect(r.lines.every((l) => l.order === undefined)).toBe(true);
  });

  it('OB-517: a line with no matched supplier bill is "not yet billed" — counted, no cost, no value, never compared at a guess', () => {
    const r = priceVariance({
      receipts: [
        receipt({ grnId: 'billed', lines: [{ lineId: 'L1', productId: 'rice', keptMinor: 10, uom: 'ea', unitCost: { minor: 5_200, currency: INR }, invoiceId: 'INV-1' }] }),
        receipt({ grnId: 'unbilled', lines: [{ lineId: 'L1', productId: 'rice', keptMinor: 7, uom: 'ea' }] }),
      ],
      orders: new Map([['po1', order()]]), agreements: [agreement()],
    });
    expect(r.lines.find((l) => l.grnId === 'billed')).toMatchObject({ invoiceId: 'INV-1', receivedValueMinor: 52_000, order: { varianceMinor: 2_000 } });
    const u = r.lines.find((l) => l.grnId === 'unbilled')!;
    expect(u).toMatchObject({ notCompared: 'not_yet_billed', receivedUnitCost: null, receivedValueMinor: null, invoiceId: null, keptMinor: 7 });
    expect(u.order).toBeUndefined();
    expect(u.contract).toBeUndefined();
    expect(r.totals).toMatchObject({ lines: 2, comparedLines: 1, receivedValueMinor: 52_000, varianceMinor: 2_000, notCompared: { not_yet_billed: 1 } });
  });

  it('rolls up per product (netting receipts) and per receipt (keeping them apart), worst first', () => {
    const r = priceVariance({
      receipts: [
        receipt({ grnId: 'g1' }),
        receipt({ grnId: 'g2', poId: 'po2', lines: [{ lineId: 'L1', productId: 'rice', keptMinor: 4, uom: 'ea', unitCost: { minor: 4_900, currency: INR } }] }),
      ],
      orders: new Map([['po1', order()], ['po2', order({ poId: 'po2', number: 'PO-2' })]]), agreements: [],
    });
    expect(r.byProduct).toEqual([expect.objectContaining({ key: 'rice', lines: 2, varianceMinor: 1_600, linesAboveOrder: 1, linesBelowOrder: 1 })]);
    expect(r.byReceipt.map((x) => [x.key, x.varianceMinor])).toEqual([['g1', 2_000], ['g2', -400]]);
  });
});
