import { describe, it, expect } from 'vitest';
import { regulatedFlagsFor } from '../../services/catalogue/src/catalogue-preview';

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
