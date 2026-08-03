import { describe, it, expect } from 'vitest';
import {
  resolvePrice,
  priceHistory,
  type PriceEntry,
  type ResolveContext,
} from '../../packages/price-list/src/index';
import { money } from '../../packages/contracts/src/money';

// Price resolution obeys precedence (customer > channel > zone > store), only
// applies published in-window entries, never activates a future price early, and
// lets a sale lock the version it referenced (M05-FR-01).

function entry(overrides: Partial<PriceEntry> & Pick<PriceEntry, 'id' | 'scope' | 'scopeRef'>): PriceEntry {
  return {
    productId: 'p1',
    price: money(100_00, 'INR'),
    effectiveFrom: '2026-08-01T00:00:00Z',
    effectiveTo: null,
    status: 'active',
    version: 1,
    ...overrides,
  };
}

const ctx: ResolveContext = {
  productId: 'p1',
  at: '2026-08-02T12:00:00Z',
  storeId: 'store-1',
  zoneId: 'zone-1',
  channel: 'web',
  customerId: 'cust-1',
};

describe('resolvePrice', () => {
  it('falls back to the store base price when nothing more specific matches', () => {
    const entries = [entry({ id: 'base', scope: 'store', scopeRef: 'store-1', price: money(90_00, 'INR') })];
    expect(resolvePrice(entries, ctx)?.price).toEqual(money(90_00, 'INR'));
  });

  it('prefers the more specific scope (customer over channel over zone over store)', () => {
    const entries = [
      entry({ id: 'base', scope: 'store', scopeRef: 'store-1', price: money(100_00, 'INR') }),
      entry({ id: 'zone', scope: 'zone', scopeRef: 'zone-1', price: money(95_00, 'INR') }),
      entry({ id: 'chan', scope: 'channel', scopeRef: 'web', price: money(92_00, 'INR') }),
      entry({ id: 'cust', scope: 'customer', scopeRef: 'cust-1', price: money(88_00, 'INR') }),
    ];
    expect(resolvePrice(entries, ctx)?.id).toBe('cust');
  });

  it('skips a scope with no match and uses the next precedence level', () => {
    const entries = [
      entry({ id: 'base', scope: 'store', scopeRef: 'store-1', price: money(100_00, 'INR') }),
      entry({ id: 'zone', scope: 'zone', scopeRef: 'zone-1', price: money(95_00, 'INR') }),
    ];
    // no customer/channel price → zone wins
    expect(resolvePrice(entries, ctx)?.id).toBe('zone');
  });

  it('does not activate a future price early', () => {
    const entries = [
      entry({ id: 'now', scope: 'store', scopeRef: 'store-1', price: money(100_00, 'INR') }),
      entry({
        id: 'future',
        scope: 'store',
        scopeRef: 'store-1',
        price: money(80_00, 'INR'),
        effectiveFrom: '2026-09-01T00:00:00Z', // after ctx.at
        version: 2,
      }),
    ];
    expect(resolvePrice(entries, ctx)?.id).toBe('now');
  });

  it('activates a scheduled price once its effective date arrives', () => {
    const entries = [
      entry({ id: 'now', scope: 'store', scopeRef: 'store-1', price: money(100_00, 'INR') }),
      entry({
        id: 'sept',
        scope: 'store',
        scopeRef: 'store-1',
        price: money(80_00, 'INR'),
        effectiveFrom: '2026-09-01T00:00:00Z',
        version: 2,
      }),
    ];
    const later = resolvePrice(entries, { ...ctx, at: '2026-09-02T12:00:00Z' });
    expect(later?.id).toBe('sept');
    expect(later?.price).toEqual(money(80_00, 'INR'));
  });

  it('ignores draft and rolled-back entries', () => {
    const entries = [
      entry({ id: 'base', scope: 'store', scopeRef: 'store-1', price: money(100_00, 'INR') }),
      entry({ id: 'draft', scope: 'customer', scopeRef: 'cust-1', price: money(1_00, 'INR'), status: 'draft' }),
      entry({ id: 'rb', scope: 'channel', scopeRef: 'web', price: money(2_00, 'INR'), status: 'rolled_back' }),
    ];
    expect(resolvePrice(entries, ctx)?.id).toBe('base');
  });

  it('resolves overlapping prices in one scope by the most recent effective date', () => {
    const entries = [
      entry({ id: 'old', scope: 'store', scopeRef: 'store-1', price: money(100_00, 'INR'), effectiveFrom: '2026-08-01T00:00:00Z', version: 1 }),
      entry({ id: 'new', scope: 'store', scopeRef: 'store-1', price: money(90_00, 'INR'), effectiveFrom: '2026-08-02T00:00:00Z', version: 2 }),
    ];
    expect(resolvePrice(entries, ctx)?.id).toBe('new');
  });

  it('returns null when no price applies', () => {
    expect(resolvePrice([], ctx)).toBeNull();
  });

  it('lets a sale lock the version it referenced (in-flight price is stable)', () => {
    const entries: PriceEntry[] = [
      entry({ id: 'v1', scope: 'store', scopeRef: 'store-1', price: money(100_00, 'INR'), effectiveFrom: '2026-08-01T00:00:00Z', version: 1 }),
    ];
    const atSale = resolvePrice(entries, ctx);
    expect(atSale?.version).toBe(1);
    // a new price is scheduled and later activates
    entries.push(
      entry({ id: 'v2', scope: 'store', scopeRef: 'store-1', price: money(80_00, 'INR'), effectiveFrom: '2026-08-10T00:00:00Z', version: 2 }),
    );
    const laterResolve = resolvePrice(entries, { ...ctx, at: '2026-08-11T00:00:00Z' });
    expect(laterResolve?.version).toBe(2);
    // the sale that captured v1 still holds v1 — the object never changed
    expect(atSale?.price).toEqual(money(100_00, 'INR'));
  });
});

describe('priceHistory', () => {
  it('returns the full chronological history for a product', () => {
    const entries = [
      entry({ id: 'b', scope: 'store', scopeRef: 'store-1', effectiveFrom: '2026-08-05T00:00:00Z', version: 2 }),
      entry({ id: 'a', scope: 'store', scopeRef: 'store-1', effectiveFrom: '2026-08-01T00:00:00Z', version: 1 }),
      entry({ id: 'other', scope: 'store', scopeRef: 'store-1', productId: 'p2', version: 1 }),
    ];
    const history = priceHistory(entries, 'p1');
    expect(history.map((e) => e.id)).toEqual(['a', 'b']); // chronological, p1 only
  });
});
