import { describe, it, expect } from 'vitest';
import {
  foldTillCash, decideCashMovement, decideShiftClose, shiftFigures, drawerMovements, drawerOfClose, readTillCashRecord,
  type TillCashMovementRecord,
} from '../../edge/store-edge/src/till-cash';
import { movesWords, createCashOfficeSession } from '../../apps/web-erp/src/cash-office-session';
import { priceCheck, offerWords } from '../../apps/pos/src/price-check';
import { CatalogueCache, type CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';
import type { Promotion } from '../../packages/promotions/src/promotions';
import { receiptsMatching, receiptLookupProblem } from '../../apps/web-erp/src/goods-receipt-session';
import { unitsFromCases } from '../../apps/web-erp/src/manager-session';

/**
 * **Batch 20a — the pure rules behind five missing options (synthetic data):**
 *   • T1 (M14-FR-01): a CASH LOAN (change added to the drawer) and a SAFE DROP are judged by the same guard as a float and a
 *     pickup (one custodian, no overdraw), and the close keeps them by kind — float, loans, pickups, safe drops — while the
 *     expected cash is exactly as before (float + loans + sales − pickups − drops − refunds).
 *   • T2 (M12-FR-01 "price enquiry"): a price check reads the till's own price list and offers and adds nothing.
 *   • R5 (M07-FR-01 · §27.1): a delivery is found by GRN number, order number or supplier, and by the days received.
 *   • R7 (M03-FR-02): "cases × pack size" + loose units becomes units, exactly.
 */

const LANE = 'lane-1';
const at = (h: number): string => `2026-11-20T${String(h).padStart(2, '0')}:00:00.000Z`;
const move = (movementId: string, kind: TillCashMovementRecord['movementKind'], amountMinor: number, h: number, custodianId = 'u-meena') => {
  const state = foldTillCash(records, LANE);
  const d = decideCashMovement({
    state, laneId: LANE, tradingDay: '2026-11-20', tradingCashMinor: 0,
    request: { movementId, movementKind: kind, amountMinor, at: at(h), custodianId, performedBy: custodianId },
  });
  if (d.ok) records.push(d.record);
  return d;
};
let records: TillCashMovementRecord[] = [];

describe('T1 — a cash loan and a safe drop on the store computer (M14-FR-01 · M14-FR-02)', () => {
  it('a loan adds to the drawer and a safe drop takes from it, under the same one-custodian, no-overdraw guard', () => {
    records = [];
    expect(move('m1', 'float_issue', 200_000, 9).ok).toBe(true);
    expect(move('m2', 'loan', 50_000, 10).ok).toBe(true);
    // Another cashier cannot add a loan to a till she does not hold.
    const notHers = move('m3', 'loan', 10_000, 10, 'u-ravi');
    expect(notHers).toMatchObject({ ok: false, refusedBecause: 'till_not_held_by_this_custodian' });
    // A safe drop of more than the drawer holds is refused, as a pickup is.
    expect(move('m4', 'safe_drop', 900_000, 11)).toMatchObject({ ok: false, refusedBecause: 'insufficient_till_cash' });
    expect(move('m5', 'safe_drop', 100_000, 12).ok).toBe(true);
    expect(move('m6', 'pickup', 30_000, 13).ok).toBe(true);
    expect(foldTillCash(records, LANE).balanceMinor).toBe(200_000 + 50_000 - 100_000 - 30_000);
    expect(drawerMovements(foldTillCash(records, LANE).movementsSinceOpen)).toEqual({ floatMinor: 200_000, loansMinor: 50_000, pickupsMinor: 30_000, safeDropsMinor: 100_000 });
  });

  it('the close keeps the loans and the safe drops by kind; the expected cash is unchanged; an older close has none', () => {
    const state = foldTillCash(records, LANE);
    const figures = shiftFigures({ state, laneId: LANE, closedAt: at(20), sales: [], returns: [] });
    expect(figures).toMatchObject({ openingFloatMinor: 250_000, pickupsMinor: 130_000 });
    const decision = decideShiftClose({
      state, laneId: LANE, tradingDay: '2026-11-20', figures, toleranceMinor: 10_000,
      request: { shiftId: 'sh-1', closedAt: at(20), cashierId: 'u-meena', countedMinor: 120_000 },
    });
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.record).toMatchObject({ expectedMinor: 120_000, varianceMinor: 0, loansMinor: 50_000, safeDropsMinor: 100_000 });
    expect(drawerOfClose(decision.record)).toEqual({ floatMinor: 200_000, loansMinor: 50_000, pickupsMinor: 30_000, safeDropsMinor: 100_000 });
    // Read back off the disk exactly as written.
    expect(readTillCashRecord(JSON.parse(JSON.stringify(decision.record)))).toMatchObject({ loansMinor: 50_000, safeDropsMinor: 100_000 });
    const older = { ...decision.record } as Record<string, unknown>;
    delete older['loansMinor']; delete older['safeDropsMinor'];
    const read = readTillCashRecord(older);
    expect(read).toBeDefined();
    expect(read !== undefined && read.kind === 'close' ? drawerOfClose(read) : 'x').toBeUndefined();
  });

  it('the cash office says the loans and safe drops of a drawer in words, in English and Tamil, and nothing when there were none', () => {
    expect(movesWords('en', { loansMinor: 50_000, safeDropsMinor: 100_000 })).toBe('Cash loans (change added): ₹500.00 · Safe drops: ₹1,000.00');
    expect(movesWords('ta', { loansMinor: 50_000, safeDropsMinor: 0 })).toBe('பணக் கடன் (சேர்த்த சில்லறை): ₹500.00');
    expect(movesWords('en', { loansMinor: null, safeDropsMinor: undefined })).toBeNull();
    const session = createCashOfficeSession({ userId: 'u-office' }, {
      worklist: () => ({ openCount: 1, totalVarianceMinor: -30_000, open: [{ shiftId: 'sh-1', tillId: 'L01', cashierId: 'u-meena', tradingDay: '2026-11-20', varianceMinor: -30_000, reasonCode: 'miscount', loansMinor: 50_000, safeDropsMinor: 100_000 }] }),
      mayRead: () => true, mayReview: () => true, signOffPort: () => ({ post: async () => 'signed' }),
    });
    expect(session.view('en').open[0]?.movesWords).toBe('Cash loans (change added): ₹500.00 · Safe drops: ₹1,000.00');
  });
});

const SNAPSHOT: CatalogueSnapshot = {
  tenantId: 't', version: 3, builtAt: '2026-11-20T03:00:00.000Z',
  products: [
    { productId: 'p-oil', sku: 'OIL1', name: 'Groundnut oil 1 L', baseUom: 'ea', unitPriceMinor: 19_000, mrpMinor: 21_000, taxBps: 500, status: 'active' },
    { productId: 'p-dal', sku: 'DAL1', name: 'Toor dal 1 kg', baseUom: 'ea', unitPriceMinor: 15_000, taxBps: 0, status: 'active' },
    { productId: 'p-rice', sku: 'RICE', name: 'Loose rice', baseUom: 'kg', unitPriceMinor: 6_000, taxBps: 0, status: 'active' },
    { productId: 'p-old', sku: 'OLD1', name: 'Old soap', baseUom: 'ea', unitPriceMinor: 3_000, taxBps: 1_800, status: 'delisted' },
  ],
  barcodes: [{ code: '8900000000011', productId: 'p-oil', kind: 'standard' }, { code: '8900000000028', productId: 'p-dal', kind: 'standard' }, { code: '8900000000035', productId: 'p-rice', kind: 'standard' }, { code: '8900000000042', productId: 'p-old', kind: 'standard' }],
} as unknown as CatalogueSnapshot;
const OFFERS: Promotion[] = [
  { id: 'o-oil', kind: 'percent_off', status: 'active', startsAt: '2026-11-01T00:00:00Z', endsAt: '2026-11-30T12:00:00Z', productIds: ['p-oil'], percentBps: 1_000 },
  { id: 'o-dal', kind: 'multibuy', status: 'active', startsAt: '2026-11-01T00:00:00Z', endsAt: '2026-11-30T12:00:00Z', productIds: ['p-dal'], multibuyQty: 3, multibuyPriceMinor: 40_000 },
  { id: 'o-dal-old', kind: 'amount_off', status: 'active', startsAt: '2026-10-01T00:00:00Z', endsAt: '2026-10-31T12:00:00Z', productIds: ['p-dal'], amountOffMinor: 1_000 },
  { id: 'o-dal-draft', kind: 'amount_off', status: 'draft', startsAt: '2026-11-01T00:00:00Z', endsAt: '2026-11-30T12:00:00Z', productIds: ['p-dal'], amountOffMinor: 2_000 },
] as unknown as Promotion[];

describe('T2 — the till\'s price check (M12-FR-01 "price enquiry")', () => {
  const cache = new CatalogueCache(SNAPSHOT);
  const check = (code: string, noOffersFor?: (id: string) => boolean) => priceCheck({ catalogue: cache, code, at: '2026-11-20T06:00:00.000Z', asOf: '2026-11-20', offers: OFFERS, ...(noOffersFor ? { noOffersFor } : {}) });

  it('a scan gives the price, the MRP and the offer in force — in both languages — and says nothing was added', () => {
    const a = check('8900000000011');
    expect(a).toMatchObject({ outcome: 'priced', productId: 'p-oil', priceMinor: 19_000, mrpMinor: 21_000, offers: [{ offerId: 'o-oil' }] });
    expect(a.words.en).toBe('Groundnut oil 1 L: ₹190.00. MRP ₹210.00. Offer: 10% off — until 2026-11-30. Nothing was added to the bill.');
    expect(a.words.ta).toContain('சலுகை: 10% தள்ளுபடி');
    expect(a.words.ta).toContain('பில்லில் எதுவும் சேர்க்கப்படவில்லை');
  });

  it('only offers in force now are named — not one that ended, nor a draft; a SKU picked from Find is checked too', () => {
    const a = check('DAL1');
    expect(a.offers.map((o) => o.offerId)).toEqual(['o-dal']);
    expect(a.words.en).toContain('3 for ₹400.00');
    expect(check('8900000000028').priceMinor).toBe(15_000);
  });

  it('a weighed item is priced per kg; tobacco or a carry bag shows no offer; an unknown or delisted item says so', () => {
    expect(check('8900000000035')).toMatchObject({ outcome: 'priced', priceMinor: 6_000, per: 'kg' });
    expect(check('8900000000011', (id) => id === 'p-oil').offers).toEqual([]);
    expect(check('123456789').outcome).toBe('not_found');
    expect(check('123456789').words.en).toContain('Nothing was added to the bill.');
    expect(check('8900000000042').outcome).toBe('not_sold_here');
    expect(priceCheck({ catalogue: undefined, code: '1', at: '2026-11-20T06:00:00.000Z', offers: [] }).outcome).toBe('no_list');
  });

  it('every kind of offer has words; a bank-card offer (never applied here) has none', () => {
    const name = (id: string) => id;
    expect(offerWords({ ...OFFERS[0]!, kind: 'buy_x_get_y', buyQty: 2, getQty: 1 } as Promotion, name)?.en).toBe('Buy 2, get 1 free — until 2026-11-30');
    expect(offerWords({ ...OFFERS[0]!, kind: 'member_price', memberUnitPrice: { minor: 17_500, currency: 'INR' } } as Promotion, name)?.en).toBe('Members pay ₹175.00 — until 2026-11-30');
    expect(offerWords({ ...OFFERS[0]!, requiresCoupon: 'DIWALI' } as Promotion, name)?.en).toBe('10% off (with coupon DIWALI) — until 2026-11-30');
    expect(offerWords({ ...OFFERS[0]!, kind: 'bank_offer' } as Promotion, name)).toBeUndefined();
  });
});

describe('R5 — look a delivery up (M07-FR-01 · §27.1)', () => {
  const rows = [
    { grnId: 'g1', number: 'GRN1/26-27/00012', reference: 'DN-601', poId: 'po-31', orderNumber: 'PO/26-27/00031', supplierId: 'sup-murugan', supplierName: 'Sri Murugan Traders', receivedAt: '2026-10-14T05:00:00.000Z' },
    { grnId: 'g2', number: 'GRN1/26-27/00013', poId: 'po-32', orderNumber: 'PO/26-27/00032', supplierId: 'sup-lakshmi', supplierName: 'Lakshmi Agencies', receivedAt: '2026-10-31T20:00:00.000Z' },
    { grnId: 'g3', number: 'GRN1/26-27/00020', poId: null, receivedAt: '2026-11-19T05:00:00.000Z' },
  ];
  // The shop's day of an instant (IST): 20:00 UTC on the 31st is already 1 November in the shop.
  const dayOf = (iso: string): string => new Date(Date.parse(iso) + 330 * 60_000).toISOString().slice(0, 10);

  it('by GRN number, its own reference, the order number, or the supplier\'s name or code — every word must match', () => {
    expect(receiptsMatching(rows, { text: '00012' }, dayOf).map((r) => r.grnId)).toEqual(['g1']);
    expect(receiptsMatching(rows, { text: 'dn-601' }, dayOf).map((r) => r.grnId)).toEqual(['g1']);
    expect(receiptsMatching(rows, { text: 'PO/26-27/00032' }, dayOf).map((r) => r.grnId)).toEqual(['g2']);
    expect(receiptsMatching(rows, { text: 'lakshmi' }, dayOf).map((r) => r.grnId)).toEqual(['g2']);
    expect(receiptsMatching(rows, { text: 'sup-murugan' }, dayOf).map((r) => r.grnId)).toEqual(['g1']);
    expect(receiptsMatching(rows, { text: 'lakshmi 00012' }, dayOf)).toEqual([]);
    expect(receiptsMatching(rows, {}, dayOf)).toHaveLength(3);
  });

  it('by the days received in the shop (both ends included); last month\'s delivery is found', () => {
    expect(receiptsMatching(rows, { from: '2026-10-01', to: '2026-10-31' }, dayOf).map((r) => r.grnId)).toEqual(['g1']);
    expect(receiptsMatching(rows, { from: '2026-11-01' }, dayOf).map((r) => r.grnId)).toEqual(['g2', 'g3']);
    expect(receiptsMatching(rows, { text: 'traders', to: '2026-10-14' }, dayOf).map((r) => r.grnId)).toEqual(['g1']);
  });

  it('dates that make no sense are said, and nothing is shown for them', () => {
    expect(receiptLookupProblem({ from: '2026-02-30' })).toBe('from_not_a_day');
    expect(receiptLookupProblem({ to: 'yesterday' })).toBe('to_not_a_day');
    expect(receiptLookupProblem({ from: '2026-11-02', to: '2026-11-01' })).toBe('from_after_to');
    expect(receiptsMatching(rows, { from: '2026-11-02', to: '2026-11-01' }, dayOf)).toEqual([]);
    expect(receiptLookupProblem({ from: '2026-11-01', to: '2026-11-01' })).toBeNull();
  });
});

describe('R7 — cases × pack size (M03-FR-02)', () => {
  it('4 cases of 12 and 3 loose is 51 units, exactly; anything not a whole number is refused', () => {
    expect(unitsFromCases(4, 12)).toBe(48);
    expect(unitsFromCases(4, 12, 3)).toBe(51);
    expect(unitsFromCases(0, 12, 5)).toBe(5);
    expect(unitsFromCases(1.5, 12)).toBeUndefined();
    expect(unitsFromCases(-1, 12)).toBeUndefined();
    expect(unitsFromCases(2, 1)).toBeUndefined();
    expect(unitsFromCases(2, 12, -1)).toBeUndefined();
  });
});
