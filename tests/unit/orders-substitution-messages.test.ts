import { describe, it, expect } from 'vitest';
import {
  substitutionMessage,
  substitutionMessageKind,
  substitutionMessageKinds,
  type SubstitutionMessageInput,
} from '../../packages/orders/src/index';

// M19-FR-01 / P-07 §19 — the customer-facing substitution message in English AND Tamil. A substitution
// the customer only half-understands is where trust is lost; the store is in Tamil Nadu, so Tamil is not
// an afterthought. Pure: an outcome + a language in, a sentence out.

const base = (over: Partial<SubstitutionMessageInput>): SubstitutionMessageInput =>
  ({ orderedName: 'Aavin Milk 500ml', outcome: 'substituted', substituteName: 'Arokya Milk 500ml', ...over });

// A representative input for every message kind, so completeness can be checked across all of them.
const SAMPLES: Record<string, SubstitutionMessageInput> = {
  not_available: base({ outcome: 'short_picked', substituteName: undefined }),
  swapped_refund: base({ settlementKind: 'prepaid_refund', settlementMinor: 2_000 }),
  swapped_collect_less: base({ settlementKind: 'collect_less', settlementMinor: 2_000 }),
  swapped_dearer_approved: base({ aboveCap: true, settlementKind: 'prepaid_additional_charge', settlementMinor: 3_000 }),
  swapped_same_price: base({ settlementKind: 'none' }),
};

describe('substitutionMessage — bilingual customer message (M19-FR-01, P-07)', () => {
  it('picks the right kind for each outcome', () => {
    expect(substitutionMessageKind(SAMPLES.not_available!)).toBe('not_available');
    expect(substitutionMessageKind(SAMPLES.swapped_refund!)).toBe('swapped_refund');
    expect(substitutionMessageKind(SAMPLES.swapped_collect_less!)).toBe('swapped_collect_less');
    expect(substitutionMessageKind(SAMPLES.swapped_dearer_approved!)).toBe('swapped_dearer_approved');
    expect(substitutionMessageKind(SAMPLES.swapped_same_price!)).toBe('swapped_same_price');
    // A dearer capped swap (not approved) reads as same-price to the customer — they pay no more.
    expect(substitutionMessageKind(base({ settlementKind: 'none', aboveCap: false }))).toBe('swapped_same_price');
  });

  it('English: an item left out is named and states nothing was charged', () => {
    const m = substitutionMessage(SAMPLES.not_available!, 'en');
    expect(m).toContain('Aavin Milk 500ml');
    expect(m.toLowerCase()).toContain('not been charged');
  });

  it('English: a cheaper prepaid swap states the refunded amount in rupees', () => {
    const m = substitutionMessage(SAMPLES.swapped_refund!, 'en');
    expect(m).toContain('Arokya Milk 500ml');
    expect(m).toContain('₹20.00'); // ₹20.00 from 2000 paise
    expect(m.toLowerCase()).toContain('refund');
  });

  it('English: an approved dearer swap states the extra amount', () => {
    const m = substitutionMessage(SAMPLES.swapped_dearer_approved!, 'en');
    expect(m).toContain('₹30.00');
    expect(m.toLowerCase()).toContain('more');
  });

  it('English: a same-price / capped swap promises no more than the original price', () => {
    expect(substitutionMessage(SAMPLES.swapped_same_price!, 'en').toLowerCase()).toContain('original price');
  });

  it('Tamil: every kind renders a non-blank Tamil sentence that differs from the English (really translated)', () => {
    for (const kind of substitutionMessageKinds) {
      const input = SAMPLES[kind]!;
      const en = substitutionMessage(input, 'en');
      const ta = substitutionMessage(input, 'ta');
      expect(ta.trim().length, `Tamil missing for ${kind}`).toBeGreaterThan(0);
      expect(ta, `Tamil not translated for ${kind}`).not.toBe(en);
      expect(/[஀-௿]/.test(ta), `no Tamil script for ${kind}`).toBe(true); // real Tamil script
    }
  });

  it('Tamil: the product name and the rupee amount still appear (interpolation works in both languages)', () => {
    const ta = substitutionMessage(SAMPLES.swapped_refund!, 'ta');
    expect(ta).toContain('Arokya Milk 500ml');
    expect(ta).toContain('₹20.00');
  });

  it('covers exactly the declared kinds — the samples and the templates agree', () => {
    expect(new Set(Object.keys(SAMPLES))).toEqual(new Set(substitutionMessageKinds));
  });

  it('a no-answer (not_confirmed) outcome reads as not-available too', () => {
    const m = substitutionMessage(base({ outcome: 'not_confirmed', substituteName: undefined }), 'en');
    expect(m.toLowerCase()).toContain('not been charged');
  });
});
