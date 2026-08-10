import { describe, it, expect } from 'vitest';
import { checkLooseFoodLabel, MAJOR_ALLERGENS } from '../../packages/product/src/loose-food-label';

// Roadmap v2.1 B9 — loose / in-store food counter label (FSSAI): a veg/non-veg mark and a major-allergen
// declaration are both mandatory; a missing or malformed declaration blocks the label.

describe('checkLooseFoodLabel — B9 / FSSAI', () => {
  it('passes a label with a veg mark and an allergen declaration (contains milk + eggs)', () => {
    const r = checkLooseFoodLabel({ vegClass: 'non_veg', allergenDeclarationProvided: true, allergensPresent: ['milk', 'eggs'] });
    expect(r.valid).toBe(true);
    expect(r.problems).toEqual([]);
  });

  it('passes a label that declares NO allergens explicitly (declaration present, list empty)', () => {
    expect(checkLooseFoodLabel({ vegClass: 'veg', allergenDeclarationProvided: true, allergensPresent: [] }).valid).toBe(true);
  });

  it('blocks a label with no veg/non-veg mark', () => {
    const r = checkLooseFoodLabel({ allergenDeclarationProvided: true, allergensPresent: [] });
    expect(r.valid).toBe(false);
    expect(r.problems.some((p) => p.startsWith('vegMark'))).toBe(true);
  });

  it('blocks a label with no allergen declaration at all (silence is not a declaration)', () => {
    const r = checkLooseFoodLabel({ vegClass: 'veg' });
    expect(r.valid).toBe(false);
    expect(r.problems.some((p) => p.startsWith('allergenDeclaration'))).toBe(true);
  });

  it('rejects an allergen that is not a recognised major group', () => {
    const r = checkLooseFoodLabel({ vegClass: 'veg', allergenDeclarationProvided: true, allergensPresent: ['milk', 'msg'] });
    expect(r.valid).toBe(false);
    expect(r.problems.some((p) => p.includes('msg'))).toBe(true);
  });

  it('recognises each of the FSSAI major allergen groups', () => {
    expect(MAJOR_ALLERGENS).toHaveLength(8);
    const r = checkLooseFoodLabel({ vegClass: 'non_veg', allergenDeclarationProvided: true, allergensPresent: [...MAJOR_ALLERGENS] });
    expect(r.valid).toBe(true);
  });
});
