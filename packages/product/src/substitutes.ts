// Product-master substitutes (M03-FR-04 "… substitutes …" · OB-288 P2).
//
// The picker's order-time policy (`packages/orders/src/substitution-policy.ts`) decides, per customer and per order, whether
// a swap may happen. What it has lacked is the shop's own answer to "what is a fair swap for this item?" — an APPROVED list
// per product, kept on the product master, versioned (a change is a new version, never an edit), and served to the picker
// and the customer app. This module judges such a list.
//
// A list is refused by name, nothing kept, when a substitute:
//   • is the product itself, is listed twice, or is not a product head office holds;
//   • cannot be sold (a draft, discontinued or recall-blocked item);
//   • is a controlled item — tobacco, liquor or anything age-restricted is never a substitute and never substituted (the
//     picker policy's own rule, made a master-data rule too); and liquor is never sold at all (B17).
// A substitute that brings an allergen the original does not declare is kept but WARNED, so the person setting the list
// sees it; the picker's policy still asks the customer's own allergen rules at the time of the swap.
//
// Pure and deterministic.

import type { ProductRecord } from './product';

export const MAX_SUBSTITUTES = 10;

export interface SubstituteList {
  readonly productId: string;
  readonly version: number;
  /** The substitutes in the order a picker should try them. */
  readonly substitutes: readonly string[];
  readonly reason: string;
  readonly setBy: string;
  readonly setAt: string;
}

export type SubstituteRefusal =
  | 'substitute_list_too_long' | 'substitute_is_itself' | 'substitute_repeated' | 'substitute_unknown'
  | 'substitute_not_sellable' | 'substitute_controlled' | 'product_controlled' | 'product_unknown';

export interface SubstituteProblem {
  readonly refusal: SubstituteRefusal;
  readonly productId: string;
  readonly detail: string;
}

const controlled = (p: ProductRecord): boolean =>
  p.safety?.tobacco === true || p.safety?.liquor === true || p.safety?.minimumAge !== undefined;

const allergensOf = (p: ProductRecord): readonly string[] | undefined => p.safety?.allergens?.map((a) => a.trim().toLowerCase());

export function substituteProblems(input: {
  readonly productId: string;
  readonly substitutes: readonly string[];
  readonly product: (productId: string) => ProductRecord | undefined;
}): { readonly problems: readonly SubstituteProblem[]; readonly warnings: readonly string[] } {
  const problems: SubstituteProblem[] = [];
  const warnings: string[] = [];
  const own = input.product(input.productId);
  if (own === undefined) {
    return { problems: [{ refusal: 'product_unknown', productId: input.productId, detail: `${input.productId} is not a product head office holds` }], warnings };
  }
  if (input.substitutes.length > 0 && controlled(own)) {
    problems.push({ refusal: 'product_controlled', productId: input.productId, detail: `${input.productId} is a controlled item (tobacco, liquor or age-restricted) — it is never substituted, so it has no substitute list` });
  }
  if (input.substitutes.length > MAX_SUBSTITUTES) {
    problems.push({ refusal: 'substitute_list_too_long', productId: input.productId, detail: `at most ${MAX_SUBSTITUTES} substitutes — a picker tries them in order, and a long list is never read` });
  }
  const seen = new Set<string>();
  const ownAllergens = allergensOf(own);
  for (const id of input.substitutes) {
    if (id === input.productId) { problems.push({ refusal: 'substitute_is_itself', productId: id, detail: 'a product cannot be its own substitute' }); continue; }
    if (seen.has(id)) { problems.push({ refusal: 'substitute_repeated', productId: id, detail: `${id} is listed twice` }); continue; }
    seen.add(id);
    const p = input.product(id);
    if (p === undefined) { problems.push({ refusal: 'substitute_unknown', productId: id, detail: `${id} is not a product head office holds` }); continue; }
    if (p.lifecycle === 'draft' || p.lifecycle === 'discontinued' || p.recallBlocked === true) {
      problems.push({ refusal: 'substitute_not_sellable', productId: id, detail: `${id} is ${p.recallBlocked === true ? 'recall-blocked' : p.lifecycle} and cannot be sold, so it cannot stand in for anything` });
    }
    if (controlled(p)) problems.push({ refusal: 'substitute_controlled', productId: id, detail: `${id} is a controlled item (tobacco, liquor or age-restricted) — it is never given as a substitute` });
    const theirs = allergensOf(p);
    if (theirs === undefined && ownAllergens !== undefined) warnings.push(`${id} has no allergen declaration, while ${input.productId} declares its allergens — check before a picker offers it`);
    const extra = theirs === undefined || ownAllergens === undefined ? [] : theirs.filter((a) => !ownAllergens.includes(a));
    if (extra.length > 0) warnings.push(`${id} contains ${extra.join(', ')}, which ${input.productId} does not — a customer avoiding it would be refused this swap by their own rules`);
  }
  return { problems, warnings };
}

/** The list in force now — the latest version — or undefined when none was ever set. */
export function currentSubstitutes(history: readonly SubstituteList[], productId: string): SubstituteList | undefined {
  return history.filter((l) => l.productId === productId).sort((a, b) => a.version - b.version).at(-1);
}
