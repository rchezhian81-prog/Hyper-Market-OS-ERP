import { describe, it, expect } from 'vitest';
import { regulatedFlagsFor, toMaster } from '../../services/catalogue/src/catalogue-preview';
import type { ProductRecord } from '../../packages/product/src/index';

// E1b (M03-FR-03 → M12-FR-04): the product master's declared minimum age is what the cloud-built pack carries as the
// pack contract's `regulatedFlags` — the ONE field the lane's age gate (`requiresAgeCheck`) and the publish step-up's
// SENSITIVE leg both read. This is the pure rule; the integration suites prove it through the real chain.

describe('regulatedFlagsFor — the product master’s restriction becomes the pack’s regulatedFlags', () => {
  it('a declared minimum age travels as { minimumAge } — exactly the field the lane’s age gate reads', () => {
    expect(regulatedFlagsFor({ safety: { minimumAge: 21 } })).toEqual({ minimumAge: 21 });
    expect(regulatedFlagsFor({ safety: { minimumAge: 18, allergens: [], countryOfOrigin: 'India' } })).toEqual({ minimumAge: 18 });
  });

  it('no safety content, or safety content with no minimum age, is no restriction — the flag is ABSENT, not an empty object', () => {
    expect(regulatedFlagsFor({})).toBeUndefined();
    expect(regulatedFlagsFor({ safety: {} })).toBeUndefined();
    expect(regulatedFlagsFor({ safety: { allergens: ['milk'], countryOfOrigin: 'India', netQuantity: '1 kg' } })).toBeUndefined();
  });

  it('zero, a fraction, a negative, NaN, infinity or text is not an age a till can prompt on — no flag', () => {
    for (const bad of [0, -1, 17.5, Number.NaN, Number.POSITIVE_INFINITY, '18' as unknown as number]) {
      expect(regulatedFlagsFor({ safety: { minimumAge: bad } }), `minimumAge ${String(bad)}`).toBeUndefined();
    }
  });
});

describe('toMaster — the product master\'s handling class becomes the pack\'s (HA-2)', () => {
  const record = (over: Partial<ProductRecord> = {}): ProductRecord => ({
    productId: 'p-milk', tenantId: 't1', sku: 'MILK1', name: 'Milk 1L', primaryCategoryId: 'grocery', baseUom: 'each', taxClass: '0401', lifecycle: 'active', ...over,
  });
  it('travels as the master holds it, and stays ABSENT when the master has none — never ambient by default', () => {
    expect(toMaster(record({ handling: 'chilled' }), '2026-10-03').handling).toBe('chilled');
    expect(toMaster(record(), '2026-10-03')).not.toHaveProperty('handling');
  });
});
