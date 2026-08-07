import { describe, it, expect } from 'vitest';
import {
  Assortment,
  dropFromRange,
  checkAssortmentIntegrity,
  RangeDecisionError,
  type AssortmentEntry,
} from '../../packages/merchandising/src/index';

// M04-FR-01 — the assortment answers "does this store carry this?". Without one,
// replenishment reorders things you stopped selling, and things sell that you have
// no space, reorder point or supplier line for.

const STORE = 'store-1';
const TODAY = '2026-08-04';

const ENTRIES: AssortmentEntry[] = [
  { storeId: STORE, productId: 'rice', status: 'listed', effectiveFrom: '2026-01-01' },
  { storeId: STORE, productId: 'oil', status: 'listed', effectiveFrom: '2026-01-01' },
  { storeId: STORE, productId: 'jam', status: 'clearance', effectiveFrom: '2026-07-01', reason: 'poor_sales' },
  { storeId: STORE, productId: 'candles', status: 'listed', effectiveFrom: '2026-01-01' },
  { storeId: STORE, productId: 'candles', status: 'delisted', effectiveFrom: '2026-06-01', reason: 'seasonal_end' },
  { storeId: 'store-2', productId: 'imported-cheese', status: 'listed', effectiveFrom: '2026-01-01' },
];

describe('Assortment — effective-dated, and scoped to one store', () => {
  const assortment = new Assortment(STORE, ENTRIES);

  it('answers what this store carries today', () => {
    expect(assortment.listedOn(TODAY)).toEqual(['oil', 'rice']);
    expect(assortment.statusOn('jam', TODAY)).toBe('clearance');
    expect(assortment.statusOn('candles', TODAY)).toBe('delisted');
  });

  it('never activates a range change before its date', () => {
    // Candles were listed until 1 June.
    expect(assortment.statusOn('candles', '2026-05-31')).toBe('listed');
    expect(assortment.statusOn('candles', '2026-06-01')).toBe('delisted');
    // And nothing exists before its first entry.
    expect(assortment.statusOn('rice', '2025-12-31')).toBeUndefined();
  });

  it('ignores another store’s range entirely', () => {
    expect(assortment.statusOn('imported-cheese', TODAY)).toBeUndefined();
    expect(assortment.maySell('imported-cheese', TODAY)).toBe(false);
  });

  it('clearance still SELLS but is never REORDERED — that is the whole point', () => {
    expect(assortment.maySell('jam', TODAY)).toBe(true);
    expect(assortment.mayReorder('jam', TODAY)).toBe(false);
    expect(assortment.maySell('rice', TODAY)).toBe(true);
    expect(assortment.mayReorder('rice', TODAY)).toBe(true);
    expect(assortment.maySell('candles', TODAY)).toBe(false);
  });
});

describe('dropFromRange — stock is never made invisible (acceptance)', () => {
  const base = {
    storeId: STORE,
    productId: 'jam',
    reason: 'poor_sales' as const,
    decidedBy: 'merch-1',
    effectiveFrom: TODAY,
  };

  it('routes a dropped item WITH stock to clearance, not deletion', () => {
    const decision = dropFromRange({ ...base, onHandMinor: 42 });
    expect(decision.outcome).toBe('routed_to_clearance');
    expect(decision.entry.status).toBe('clearance');
    expect(decision.detail).toContain('stays sellable until it is gone');
  });

  it('delists cleanly when there is nothing left', () => {
    const decision = dropFromRange({ ...base, onHandMinor: 0 });
    expect(decision.outcome).toBe('delisted');
    expect(decision.entry.status).toBe('delisted');
  });

  it('records who decided and why — asked six months later by someone else', () => {
    const decision = dropFromRange({ ...base, onHandMinor: 0, reasonNote: 'two units a month' });
    expect(decision.entry.decidedBy).toBe('merch-1');
    expect(decision.entry.reason).toBe('poor_sales');
    expect(decision.entry.reasonNote).toBe('two units a month');
  });

  it('refuses an anonymous decision, and "replaced" with no replacement', () => {
    expect(() => dropFromRange({ ...base, onHandMinor: 0, decidedBy: '  ' })).toThrow(
      RangeDecisionError,
    );
    expect(() =>
      dropFromRange({ ...base, onHandMinor: 0, reason: 'replaced_by_alternative' }),
    ).toThrow(/the customer is simply told no/);
    expect(() =>
      dropFromRange({
        ...base,
        onHandMinor: 0,
        reason: 'replaced_by_alternative',
        replacedByProductId: 'jam-new',
      }),
    ).not.toThrow();
  });
});

describe('checkAssortmentIntegrity — control failures and commercial signals', () => {
  const assortment = new Assortment(STORE, ENTRIES);

  it('catches an item sold at a store that does not carry it', () => {
    const issues = checkAssortmentIntegrity({
      assortment,
      onDate: TODAY,
      soldProductIds: ['rice', 'oil', 'imported-cheese'],
    });
    const finding = issues.find((i) => i.productId === 'imported-cheese');
    expect(finding?.finding).toBe('sold_not_in_assortment');
    expect(finding?.detail).toContain('the next customer is disappointed');
  });

  it('catches a dropped item that replenishment keeps ordering', () => {
    const issues = checkAssortmentIntegrity({
      assortment,
      onDate: TODAY,
      soldProductIds: ['rice', 'oil'],
      reorderedProductIds: ['rice', 'jam', 'candles'],
    });
    expect(issues.filter((i) => i.finding === 'reordered_not_listed').map((i) => i.productId)).toEqual([
      'jam',
      'candles',
    ]);
  });

  it('says when a clearance is finished, and when a listed item earns nothing', () => {
    const issues = checkAssortmentIntegrity({
      assortment,
      onDate: TODAY,
      soldProductIds: ['rice'],
      onHand: { jam: 0 },
    });
    expect(issues.find((i) => i.finding === 'clearance_with_no_stock')?.productId).toBe('jam');
    const idle = issues.find((i) => i.finding === 'listed_never_sold');
    expect(idle?.productId).toBe('oil');
    expect(idle?.detail).toContain('holding shelf space and cash');
  });

  it('reports nothing when the range and the trading agree', () => {
    const issues = checkAssortmentIntegrity({
      assortment,
      onDate: TODAY,
      soldProductIds: ['rice', 'oil'],
      reorderedProductIds: ['rice', 'oil'],
    });
    expect(issues).toEqual([]);
  });
});
