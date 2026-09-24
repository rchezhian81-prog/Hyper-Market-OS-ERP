import { describe, it, expect } from 'vitest';
import {
  assessSubstitution,
  type SubstitutionCandidate,
  type ProductAttributes,
  type CustomerSubstitutionRules,
} from '../../packages/orders/src/index';

// M19-FR-01 substitution POLICY (eligibility, before the money). The owner-approved rules:
// preference no_substitution / best_match / contact_me; brand/category/size/allergen restrictions;
// controlled items never auto-substituted. Safety- and consent-critical refusals hold under EVERY
// preference; only when every restriction passes does the preference decide auto vs. ask-first.

const ordered = (over: Partial<ProductAttributes> = {}): ProductAttributes =>
  ({ productId: 'p-ord', name: 'Aachi Chilli Powder 200g', brand: 'aachi', categoryId: 'spices', sizeMinor: 200, allergens: [], ...over });
const substitute = (over: Partial<ProductAttributes> = {}): ProductAttributes =>
  ({ productId: 'p-sub', name: 'Sakthi Chilli Powder 200g', brand: 'sakthi', categoryId: 'spices', sizeMinor: 200, allergens: [], ...over });

const candidate = (rules: CustomerSubstitutionRules, o: Partial<ProductAttributes> = {}, s: Partial<ProductAttributes> = {}): SubstitutionCandidate =>
  ({ lineId: 'l1', ordered: ordered(o), substitute: substitute(s), rules });

describe('assessSubstitution — the owner-approved substitution policy (M19-FR-01)', () => {
  it('best_match with everything within the rules is auto-accepted', () => {
    const d = assessSubstitution(candidate({ preference: 'best_match' }));
    expect(d.eligibility).toBe('auto_accept');
    expect(d.reason).toBeUndefined();
    expect(d.tellTheCustomer).toContain('closest match');
  });

  it('contact_me with everything within the rules needs confirmation (A04 — the shop asks first)', () => {
    const d = assessSubstitution(candidate({ preference: 'contact_me' }));
    expect(d.eligibility).toBe('needs_confirmation');
    expect(d.tellTheCustomer).toContain('Can we substitute');
  });

  it('no_substitution refuses — the line is short-picked, not swapped', () => {
    const d = assessSubstitution(candidate({ preference: 'no_substitution' }));
    expect(d.eligibility).toBe('refused');
    expect(d.reason).toBe('customer_declines_substitution');
  });

  it('a controlled item is never auto-substituted — even under best_match', () => {
    const bySub = assessSubstitution(candidate({ preference: 'best_match' }, {}, { ageRestricted: true }));
    expect(bySub).toMatchObject({ eligibility: 'refused', reason: 'controlled_item' });
    const byOrdered = assessSubstitution(candidate({ preference: 'best_match' }, { ageRestricted: true }, {}));
    expect(byOrdered).toMatchObject({ eligibility: 'refused', reason: 'controlled_item' });
  });

  it('a substitute that introduces an avoided allergen is refused — even under best_match', () => {
    const d = assessSubstitution(
      candidate({ preference: 'best_match', avoidAllergens: ['Nuts'] }, { allergens: [] }, { allergens: ['milk', 'NUTS'] }),
    );
    expect(d).toMatchObject({ eligibility: 'refused', reason: 'allergen_introduced' });
    expect(d.detail.toLowerCase()).toContain('nuts');
  });

  it('unknown allergen data is never auto-accepted when the customer avoids allergens — a person must confirm (P-04)', () => {
    const d = assessSubstitution(
      candidate({ preference: 'best_match', avoidAllergens: ['milk'] }, {}, { allergens: undefined }),
    );
    expect(d.eligibility).toBe('needs_confirmation');
    expect(d.reason).toBe('allergen_data_unknown');
  });

  it('a blocked brand is refused (case-insensitive)', () => {
    const d = assessSubstitution(candidate({ preference: 'best_match', blockedBrands: ['Sakthi'] }));
    expect(d).toMatchObject({ eligibility: 'refused', reason: 'brand_blocked' });
  });

  it('a blocked category is refused', () => {
    const d = assessSubstitution(candidate({ preference: 'best_match', blockedCategories: ['spices'] }));
    expect(d).toMatchObject({ eligibility: 'refused', reason: 'category_blocked' });
  });

  it('a weighed substitute beyond tolerance is refused; within tolerance is accepted', () => {
    // ordered 1000g, tolerance 10% (1000bps). 800g = 20% out → refused.
    const out = assessSubstitution(
      candidate({ preference: 'best_match', weightToleranceBps: 1000 }, { sizeMinor: 1000 }, { sizeMinor: 800 }),
    );
    expect(out).toMatchObject({ eligibility: 'refused', reason: 'size_out_of_tolerance' });
    // 950g = 5% out → within tolerance, accepted.
    const within = assessSubstitution(
      candidate({ preference: 'best_match', weightToleranceBps: 1000 }, { sizeMinor: 1000 }, { sizeMinor: 950 }),
    );
    expect(within.eligibility).toBe('auto_accept');
  });

  it('with no tolerance configured, size is not checked (a countable line)', () => {
    const d = assessSubstitution(
      candidate({ preference: 'best_match' }, { sizeMinor: 1000 }, { sizeMinor: 250 }),
    );
    expect(d.eligibility).toBe('auto_accept');
  });

  it('safety refusals take precedence over the preference (controlled beats no_substitution reporting is moot, but allergen beats contact_me)', () => {
    const d = assessSubstitution(
      candidate({ preference: 'contact_me', avoidAllergens: ['soy'] }, {}, { allergens: ['soy'] }),
    );
    expect(d).toMatchObject({ eligibility: 'refused', reason: 'allergen_introduced' });
  });

  it('every decision carries the line id and a plain-English customer message', () => {
    for (const pref of ['no_substitution', 'best_match', 'contact_me'] as const) {
      const d = assessSubstitution(candidate({ preference: pref }));
      expect(d.lineId).toBe('l1');
      expect(d.tellTheCustomer.length).toBeGreaterThan(10);
    }
  });
});
