// Nutrition facts on the product master (M03-FR-03 · D01-FR-04 · OB-288 P2).
//
// OB-307 (owner, 23 Oct 2026, in writing): nutrition is REQUIRED only for food SRE packs or labels itself — a counter pack,
// a repacked staple, an own label. A bought-in pack prints its own panel, so for it the facts are RECORDED WHEN KNOWN and
// never block publishing. Whether SRE packs or labels a product is said on the product (`safety.packedBySre`), never
// guessed from its name or brand.
//
// The panel follows the nutrition-information list of the FSSAI Labelling and Display Regulations 2020 (energy, protein,
// carbohydrate with total and added sugars, total fat with saturated and trans fat, cholesterol, sodium), per 100 g or per
// 100 ml, with an optional serving size. The list is data (`NUTRIENTS`), so a change the food-safety validator asks for is
// one line. Figures are plain numbers in the panel's own unit; a figure that cannot be read is refused, never coerced, and
// the panel must add up (the sugars inside the carbohydrate, the saturated and trans fat inside the total fat).
//
// Pure and deterministic.

export type NutritionBasis = 'per_100g' | 'per_100ml';

export interface NutritionFacts {
  readonly basis: NutritionBasis;
  readonly energyKcal: number;
  readonly proteinG: number;
  readonly carbohydrateG: number;
  readonly totalSugarsG: number;
  readonly addedSugarsG: number;
  readonly totalFatG: number;
  readonly saturatedFatG: number;
  readonly transFatG: number;
  readonly cholesterolMg: number;
  readonly sodiumMg: number;
  /** One serving, in the basis unit (grams or millilitres), when the label states one. */
  readonly servingSize?: number;
}

/** The figures a panel carries, each with its words for the person fixing it. */
export const NUTRIENTS: readonly { readonly key: Exclude<keyof NutritionFacts, 'basis' | 'servingSize'>; readonly label: string }[] = Object.freeze([
  { key: 'energyKcal', label: 'energy (kcal)' },
  { key: 'proteinG', label: 'protein (g)' },
  { key: 'carbohydrateG', label: 'carbohydrate (g)' },
  { key: 'totalSugarsG', label: 'total sugars (g)' },
  { key: 'addedSugarsG', label: 'added sugars (g)' },
  { key: 'totalFatG', label: 'total fat (g)' },
  { key: 'saturatedFatG', label: 'saturated fat (g)' },
  { key: 'transFatG', label: 'trans fat (g)' },
  { key: 'cholesterolMg', label: 'cholesterol (mg)' },
  { key: 'sodiumMg', label: 'sodium (mg)' },
]);

const BASES: readonly NutritionBasis[] = ['per_100g', 'per_100ml'];
const figure = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** Every reason a panel cannot be printed or shown, in plain words — the empty list when it can. */
export function nutritionProblems(raw: unknown): readonly string[] {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return ['the nutrition panel must be a set of figures, not text'];
  const n = raw as Record<string, unknown>;
  const problems: string[] = [];
  if (!BASES.includes(n['basis'] as NutritionBasis)) problems.push('the nutrition panel must say whether it is per 100 g or per 100 ml');
  for (const { key, label } of NUTRIENTS) {
    if (!figure(n[key])) problems.push(`the nutrition panel has no readable ${label} — write 0 when there is none`);
  }
  if (n['servingSize'] !== undefined && !(figure(n['servingSize']) && (n['servingSize'] as number) > 0)) problems.push('the serving size must be a number above 0');
  if (problems.length > 0) return problems;
  const f = n as unknown as NutritionFacts;
  const per100 = f.basis === 'per_100g' ? 'g' : 'ml';
  if (f.totalSugarsG > f.carbohydrateG) problems.push('the total sugars cannot be more than the carbohydrate they are part of');
  if (f.addedSugarsG > f.totalSugarsG) problems.push('the added sugars cannot be more than the total sugars');
  if (f.saturatedFatG + f.transFatG > f.totalFatG) problems.push('the saturated and trans fat together cannot be more than the total fat');
  const grams = f.proteinG + f.carbohydrateG + f.totalFatG + (f.sodiumMg + f.cholesterolMg) / 1000;
  if (f.basis === 'per_100g' && grams > 100) problems.push(`the protein, carbohydrate and fat add up to more than 100 g per 100 ${per100}`);
  return problems;
}

/** OB-307: whether a product must carry a panel before it is published — food that SRE itself packs or labels. */
export function nutritionRequired(input: { readonly food: boolean; readonly packedBySre?: boolean }): boolean {
  return input.food && input.packedBySre === true;
}
