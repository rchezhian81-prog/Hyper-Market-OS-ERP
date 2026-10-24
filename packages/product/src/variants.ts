// Variants and manufacturer (M03-FR-01 · OB-288 P2): "variants share a parent" (M03.md rules).
//
// A variant is a product of its own (its own SKU, barcode, price and stock) that names a PARENT — the size, colour or
// flavour family it belongs to. Four rules keep the family a family:
//   1. the parent is a product head office holds, in the same shop (a tenant's products are the only ones it can see);
//   2. the parent is not itself a variant — a family is one level deep, so a report rolls up once and never in a circle;
//   3. a product that already HAS variants cannot become a variant of something else, for the same reason;
//   4. two siblings differ in at least one attribute — two variants with the same attributes are the same item twice.
// A report by category rolls every variant up under its parent, and keeps the manufacturer, so "how many kinds of
// shampoo do we carry, from whom?" has one answer.
//
// Pure and deterministic.

import type { ProductRecord } from './product';

export type VariantRefusal =
  | 'variant_of_itself' | 'variant_parent_unknown' | 'variant_parent_is_a_variant' | 'product_has_variants' | 'variant_same_as_sibling';

export interface VariantCheck {
  readonly ok: boolean;
  readonly refusal?: VariantRefusal;
  readonly detail?: string;
}

const attributesOf = (p: Pick<ProductRecord, 'attributes'>): Readonly<Record<string, string>> => p.attributes ?? {};

/** Whether two attribute sets differ in at least one key's value (a key one has and the other lacks is a difference). */
export function attributesDiffer(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if ((a[k] ?? '').trim() !== (b[k] ?? '').trim()) return true;
  return false;
}

/** Judge a product's variant parent against the products head office already holds (the product's own earlier versions excluded). */
export function checkVariant(product: ProductRecord, held: readonly ProductRecord[]): VariantCheck {
  const parentId = product.parentProductId ?? null;
  const others = held.filter((p) => p.productId !== product.productId);
  const children = others.filter((p) => (p.parentProductId ?? null) === product.productId);
  if (parentId === null || parentId.trim() === '') return { ok: true };
  if (parentId === product.productId) {
    return { ok: false, refusal: 'variant_of_itself', detail: `${product.productId} cannot be a variant of itself` };
  }
  const parent = others.find((p) => p.productId === parentId);
  if (parent === undefined) {
    return { ok: false, refusal: 'variant_parent_unknown', detail: `the parent ${parentId} is not a product head office holds — publish the parent first` };
  }
  if ((parent.parentProductId ?? null) !== null && parent.parentProductId!.trim() !== '') {
    return { ok: false, refusal: 'variant_parent_is_a_variant', detail: `the parent ${parentId} is itself a variant of ${parent.parentProductId} — name ${parent.parentProductId} as the parent instead` };
  }
  if (children.length > 0) {
    return { ok: false, refusal: 'product_has_variants', detail: `${product.productId} already has variants (${children.map((c) => c.productId).sort().join(', ')}), so it cannot also be a variant of ${parentId}` };
  }
  const same = others.find((p) => (p.parentProductId ?? null) === parentId && !attributesDiffer(attributesOf(p), attributesOf(product)));
  if (same !== undefined) {
    return { ok: false, refusal: 'variant_same_as_sibling', detail: `${product.productId} has the same attributes as its sibling ${same.productId} under ${parentId} — a variant must differ in at least one (its size, colour or flavour)` };
  }
  return { ok: true };
}

export interface VariantFamilyRow {
  readonly productId: string;
  readonly sku: string;
  readonly name: string;
  readonly brand: string | null;
  /** The manufacturer as recorded — `null` is "not recorded", never a blank guess. */
  readonly manufacturer: string | null;
  readonly categoryId: string | null;
  readonly variantCount: number;
  readonly variants: readonly { readonly productId: string; readonly sku: string; readonly name: string; readonly attributes: Readonly<Record<string, string>>; readonly manufacturer: string | null }[];
}

export interface CategoryRollup {
  readonly families: readonly VariantFamilyRow[];
  /** Distinct families (a family counts once), then every record in them (the parent and each variant). */
  readonly familyCount: number;
  readonly productCount: number;
  readonly byManufacturer: readonly { readonly manufacturer: string | null; readonly families: number; readonly products: number }[];
  /** A variant whose parent is not held at all — said, never dropped. */
  readonly orphanVariants: readonly string[];
}

/**
 * Roll every product in `inCategory` up under its parent. A variant in the category whose parent sits elsewhere is rolled
 * up under that parent (taken from `all`), so the family appears once and in full. Sorted by product id.
 */
export function rollUpVariants(inCategory: readonly ProductRecord[], all: readonly ProductRecord[]): CategoryRollup {
  const byId = new Map(all.map((p) => [p.productId, p] as const));
  const families = new Map<string, { head: ProductRecord; variants: ProductRecord[] }>();
  const orphans: string[] = [];
  for (const p of inCategory) {
    const parentId = p.parentProductId ?? null;
    if (parentId === null || parentId.trim() === '') {
      if (!families.has(p.productId)) families.set(p.productId, { head: p, variants: [] });
      continue;
    }
    const parent = byId.get(parentId);
    if (parent === undefined) { orphans.push(p.productId); continue; }
    const fam = families.get(parent.productId) ?? { head: parent, variants: [] };
    if (!fam.variants.some((v) => v.productId === p.productId)) fam.variants.push(p);
    families.set(parent.productId, fam);
  }
  // A family head in the category brings every variant it has, wherever the variant is filed.
  for (const fam of families.values()) {
    for (const v of all) {
      if ((v.parentProductId ?? null) === fam.head.productId && !fam.variants.some((x) => x.productId === v.productId)) fam.variants.push(v);
    }
  }
  const rows: VariantFamilyRow[] = [...families.values()]
    .sort((a, b) => (a.head.productId < b.head.productId ? -1 : 1))
    .map(({ head, variants }) => ({
      productId: head.productId, sku: head.sku, name: head.name, brand: head.brand ?? null, manufacturer: head.manufacturer ?? null,
      categoryId: head.primaryCategoryId, variantCount: variants.length,
      variants: [...variants].sort((a, b) => (a.productId < b.productId ? -1 : 1)).map((v) => ({
        productId: v.productId, sku: v.sku, name: v.name, attributes: attributesOf(v), manufacturer: v.manufacturer ?? head.manufacturer ?? null,
      })),
    }));
  const makers = new Map<string | null, { families: number; products: number }>();
  for (const r of rows) {
    const m = makers.get(r.manufacturer) ?? { families: 0, products: 0 };
    m.families += 1;
    m.products += 1 + r.variantCount;
    makers.set(r.manufacturer, m);
  }
  return {
    families: rows, familyCount: rows.length,
    productCount: rows.reduce((s, r) => s + 1 + r.variantCount, 0),
    byManufacturer: [...makers.entries()].map(([manufacturer, v]) => ({ manufacturer, ...v }))
      .sort((a, b) => (a.manufacturer ?? '￿').localeCompare(b.manufacturer ?? '￿')),
    orphanVariants: orphans.sort(),
  };
}
