// U6 · M20-FR-01 · §27 "Customer: Category" (7 Nov 2026): browse the catalogue this phone holds BY CATEGORY — no network,
// the same products the search ranks. The store computer hands the app the pack's category names beside the products
// (`shopData.categories`); a category the pack does not name is shown by its id, never dropped (P-08). Pure, so a test
// drives it without a browser and the view holds no rule of its own.
import type { StorefrontProduct } from '../../../packages/storefront/src/browse';

export interface CatalogueCategory {
  readonly categoryId: string;
  readonly name: string;
  /** The category's Tamil name, when head office published one (U3 · OB-699: the product's own word). */
  readonly nameTa?: string;
  readonly parentId: string | null;
}

export interface BrowseCategory {
  readonly categoryId: string;
  readonly name: string;
  /** Sellable products in this category and, for a parent, in its children. */
  readonly count: number;
  readonly children: readonly { readonly categoryId: string; readonly name: string; readonly count: number }[];
}

const sellable = (p: StorefrontProduct): boolean => p.status === 'active' && p.recallBlock !== true;
const nameIn = (c: CatalogueCategory | undefined, id: string, language: 'en' | 'ta'): string =>
  c === undefined ? id : language === 'ta' && typeof c.nameTa === 'string' && c.nameTa !== '' ? c.nameTa : c.name;

/**
 * The categories worth a tap: the top-level ones (and, under each, its children) that hold at least one sellable product,
 * each with its count, named in the reader's language; then every product category the pack never named, by id.
 */
export function categoriesOf(products: readonly StorefrontProduct[], categories: readonly CatalogueCategory[], language: 'en' | 'ta' = 'en'): readonly BrowseCategory[] {
  const byId = new Map(categories.map((c) => [c.categoryId, c] as const));
  const direct = new Map<string, number>();
  for (const p of products.filter(sellable)) direct.set(p.categoryId, (direct.get(p.categoryId) ?? 0) + 1);
  const countOf = (id: string): number => (direct.get(id) ?? 0) + categories.filter((c) => c.parentId === id).reduce((n, c) => n + countOf(c.categoryId), 0);
  const tops = categories.filter((c) => c.parentId === null || !byId.has(c.parentId));
  const named: BrowseCategory[] = [];
  for (const top of tops) {
    const count = countOf(top.categoryId);
    if (count === 0) continue;
    const children = categories.filter((c) => c.parentId === top.categoryId)
      .map((c) => ({ categoryId: c.categoryId, name: nameIn(c, c.categoryId, language), count: countOf(c.categoryId) }))
      .filter((c) => c.count > 0);
    named.push({ categoryId: top.categoryId, name: nameIn(top, top.categoryId, language), count, children });
  }
  // A product whose category the pack never named: shown by its id, in the order the catalogue lists it, never dropped.
  const seen = new Set<string>();
  const unnamed: BrowseCategory[] = [];
  for (const p of products.filter(sellable)) {
    if (byId.has(p.categoryId) || seen.has(p.categoryId)) continue;
    seen.add(p.categoryId);
    unnamed.push({ categoryId: p.categoryId, name: p.categoryId, count: direct.get(p.categoryId) ?? 0, children: [] });
  }
  return [...named, ...unnamed];
}

/** The sellable products of a category — a parent reaches its children — by name, so the list reads the same every time. */
export function productsInCategory(products: readonly StorefrontProduct[], categories: readonly CatalogueCategory[], categoryId: string): readonly StorefrontProduct[] {
  const within = new Set<string>([categoryId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of categories) if (c.parentId !== null && within.has(c.parentId) && !within.has(c.categoryId)) { within.add(c.categoryId); grew = true; }
  }
  return products.filter((p) => sellable(p) && within.has(p.categoryId)).slice().sort((a, b) => a.name.localeCompare(b.name));
}
