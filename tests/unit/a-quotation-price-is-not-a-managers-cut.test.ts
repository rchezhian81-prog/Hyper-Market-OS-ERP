import { describe, it, expect } from 'vitest';
import { acceptSale, type IncomingSale, type IntakeContext } from '../../services/pos/src/index';
import type { CatalogueProduct } from '../../packages/catalogue/src/catalogue';

// OB-551 (owner, 29 Oct 2026, option B1): a line the till lowered to the price a retail quotation promised is NOT a
// manager's price cut — the quotation was approved on its own (OB-506 · OB-525 · OB-532) — so head office does not count
// it against any manager's limit. Only when head office's OWN record backs it: that quotation converted (rung up at a
// till) and promising exactly this price for this product. A quotation number the record does not back is judged as any
// other cut, so a till cannot name a made-up quotation to slip past a limit. The floor is still checked either way.

const CATALOGUE = new Map<string, CatalogueProduct>([['p-ghee', { productId: 'p-ghee', sku: 'GHEE', name: 'Ghee', baseUom: 'each', unitPriceMinor: 64_000, taxBps: 1200, mrpMinor: 64_000, status: 'active' }]]);

/** A sale whose one line the till lowered from ₹640 to `unitPriceMinor`, set from quotation Q-7 as the till records it. */
const quotedSale = (unitPriceMinor: number, quotationId = 'Q-7'): IncomingSale => ({
  saleId: 'S-1', receiptNumber: 'R-1', laneId: 'lane-1', cashierId: 'u-cash', tradingDay: '2026-10-29', committedAt: '2026-10-29T10:00:00Z',
  totalMinor: unitPriceMinor, currency: 'INR', packVersion: 3, tenders: [{ kind: 'cash', amountMinor: unitPriceMinor }],
  lines: [{
    productId: 'p-ghee', quantityMinor: 1, uom: 'each', unitPriceMinor, lineTotalMinor: unitPriceMinor,
    priceOverride: { fromUnitPriceMinor: 64_000, approvedBy: `quotation ${quotationId}`, activityId: `quotation:${quotationId}`, quotationId },
  }],
});

const ctx = (quotationsNamed: IntakeContext['quotationsNamed']): IntakeContext => ({
  catalogue: CATALOGUE, currentPackVersion: 3, saleHoldingThisReceipt: undefined, alreadyBanked: false, now: '2026-10-29T12:00:00Z',
  tillOverrideRules: { floors: new Map([['p-ghee', 50_000]]), limits: new Map([['u-mgr', { state: 'limit', limitMinor: 10_000 }]]) },
  ...(quotationsNamed === undefined ? {} : { quotationsNamed }),
});

const converted = (unitPriceMinor: number, state = 'converted') => [{ quotationId: 'Q-7', state, lines: [{ productId: 'p-ghee', unitPriceMinor }] }];
const cuts = (r: ReturnType<typeof acceptSale>) => r.exceptions.filter((e) => e.kind.startsWith('price_cut')).map((e) => [e.kind, e.differenceMinor]);

describe('OB-551 — a price set from a quotation head office backs is not counted against a manager\'s limit', () => {
  it('a ₹60 cut from a converted quotation promising exactly that price raises no limit finding', () => {
    const r = acceptSale(quotedSale(58_000), ctx(converted(58_000)));
    expect(r.banked).toBe(true);
    expect(cuts(r)).toEqual([]);
  });

  it('the floor still holds: a quotation below the product\'s lowest allowed price is still raised', () => {
    expect(cuts(acceptSale(quotedSale(48_000), ctx(converted(48_000))))).toEqual([['price_cut_below_floor', -2_000]]);
  });

  it('a quotation number head office cannot back is counted as any other cut (no made-up quotation slips past a limit)', () => {
    // No such quotation on record.
    expect(cuts(acceptSale(quotedSale(58_000), ctx([])))).toEqual([['price_cut_above_approver_limit', 6_000]]);
    // On record, but not converted.
    expect(cuts(acceptSale(quotedSale(58_000), ctx(converted(58_000, 'issued'))))).toEqual([['price_cut_above_approver_limit', 6_000]]);
    // Converted, but it promised another price.
    expect(cuts(acceptSale(quotedSale(58_000), ctx(converted(60_000))))).toEqual([['price_cut_above_approver_limit', 6_000]]);
    // Nobody looked the quotation up.
    expect(cuts(acceptSale(quotedSale(58_000), ctx(undefined)))).toEqual([['price_cut_above_approver_limit', 6_000]]);
  });
});
