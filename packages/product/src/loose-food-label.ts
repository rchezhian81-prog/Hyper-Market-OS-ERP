// Loose / in-store food label: allergens + veg mark (roadmap v2.1 B9 — FSSAI Labelling & Display
// Regulations 2020). Food packed at the counter (a deli tray, a sweets box, a cut-fruit pack) still
// carries the statutory declarations, and two are non-negotiable: the major-allergen information and
// the veg / non-veg symbol. A counter label missing either is BLOCKED — an undeclared allergen on
// prepared food is a safety failure, not a formatting one.
//
// The label must state which of the major allergen groups are present, OR state explicitly that none
// are (silence is not a declaration). Pure and deterministic — declarations in, findings out.

/** The FSSAI major allergen groups that must be declared when present. */
export type Allergen =
  | 'cereals_gluten' | 'crustaceans' | 'eggs' | 'fish'
  | 'peanuts_tree_nuts' | 'milk' | 'soybeans' | 'sulphites';

export const MAJOR_ALLERGENS: readonly Allergen[] = [
  'cereals_gluten', 'crustaceans', 'eggs', 'fish', 'peanuts_tree_nuts', 'milk', 'soybeans', 'sulphites',
];

export type VegClass = 'veg' | 'non_veg';

export interface LooseFoodLabelCheck {
  readonly valid: boolean;
  /** Each mandatory declaration that is missing or malformed, named so it can be fixed. */
  readonly problems: readonly string[];
  readonly detail: string;
}

/**
 * Check a loose / in-store food counter label for the mandatory FSSAI declarations (B9): a veg /
 * non-veg mark, and a major-allergen declaration (a list of the groups present, or an explicit "none").
 * A missing or malformed declaration blocks the label.
 */
export function checkLooseFoodLabel(input: {
  readonly vegClass?: VegClass;
  /** True when the label carries an allergen declaration (even if it declares "none"). */
  readonly allergenDeclarationProvided?: boolean;
  /** The major allergen groups the label declares present. */
  readonly allergensPresent?: readonly string[];
}): LooseFoodLabelCheck {
  const problems: string[] = [];

  if (input.vegClass !== 'veg' && input.vegClass !== 'non_veg') {
    problems.push('vegMark (a veg or non-veg symbol is mandatory on loose/in-store food)');
  }

  if (input.allergenDeclarationProvided !== true) {
    problems.push('allergenDeclaration (the label must declare the major allergens present, or state there are none — silence is not a declaration)');
  } else {
    for (const a of input.allergensPresent ?? []) {
      if (!(MAJOR_ALLERGENS as readonly string[]).includes(a)) {
        problems.push(`allergen "${a}" is not one of the recognised major allergen groups`);
      }
    }
  }

  return {
    valid: problems.length === 0,
    problems,
    detail: problems.length === 0
      ? 'the counter label carries the veg/non-veg mark and a major-allergen declaration'
      : `the counter label may not be printed — ${problems.length} mandatory declaration(s) missing or malformed`,
  };
}
