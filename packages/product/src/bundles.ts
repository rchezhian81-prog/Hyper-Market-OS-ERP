// Own-barcode bundle products (M03-FR-02 "… and bundles" · OB-306 "both", the first kind · OB-288 P2).
//
// A bundle PRODUCT is sold as one item — its own SKU, its own barcode, its own price and tax class — and is MADE of named
// component products. Selling one takes stock off EACH component (the bundle itself holds no stock: it is assembled from
// the shelf). The second kind OB-306 names, a price offer such as "these 3 together for ₹199", is a promotion
// (`bundle_price` in `@sre/promotions`) — no new product, stock moves item by item.
//
// A definition is versioned and append-only: a change is a new version, never an edit (hard rule #2), and every sale is
// exploded by the version in force when it was sold.
//
// What a bundle may not hold, each refused by name (no override):
//   • itself, or another bundle (one level: a bundle explodes once, never in a circle);
//   • tobacco — a bundle is a promotion of what it holds (COTPA s.5 · B15); liquor — never sold (B17);
//   • a carry bag — a bag is its own line at its price (OB-173 · B19); a gold piece — one HUID is one piece (B13).
//
// Pure and deterministic.

import type { ProductRecord } from './product';

export interface BundleComponent {
  readonly productId: string;
  /** How much of the component ONE bundle holds, in the component's base-unit minor units (6 for six tins; 500 for 500 g). */
  readonly quantityMinor: number;
}

export interface BundleDefinition {
  readonly bundleProductId: string;
  readonly version: number;
  readonly components: readonly BundleComponent[];
  readonly reason: string;
  readonly definedBy: string;
  readonly definedAt: string;
}

export type BundleRefusal =
  | 'bundle_product_unknown' | 'bundle_needs_components' | 'bundle_component_repeated' | 'bundle_component_quantity'
  | 'bundle_contains_itself' | 'bundle_component_unknown' | 'bundle_component_is_a_bundle' | 'bundle_is_a_component'
  | 'bundle_component_not_sellable' | 'bundle_component_tobacco' | 'bundle_component_liquor' | 'bundle_component_carry_bag'
  | 'bundle_component_gold';

export interface BundleProblem {
  readonly refusal: BundleRefusal;
  readonly detail: string;
}

/** Every reason a definition cannot stand, in plain words. `bundles` is every OTHER bundle's current definition. */
export function bundleProblems(input: {
  readonly bundleProductId: string;
  readonly components: readonly BundleComponent[];
  readonly product: (productId: string) => ProductRecord | undefined;
  readonly bundles: readonly BundleDefinition[];
}): readonly BundleProblem[] {
  const out: BundleProblem[] = [];
  const own = input.product(input.bundleProductId);
  if (own === undefined) out.push({ refusal: 'bundle_product_unknown', detail: `${input.bundleProductId} is not a product head office holds — publish the bundle as a product (its own SKU, barcode and price) first` });
  const total = input.components.reduce((s, c) => s + (Number.isSafeInteger(c.quantityMinor) && c.quantityMinor > 0 ? c.quantityMinor : 0), 0);
  if (input.components.length === 0 || (input.components.length === 1 && total < 2)) {
    out.push({ refusal: 'bundle_needs_components', detail: 'a bundle is made of at least two things — two products, or two or more of one' });
  }
  const seen = new Set<string>();
  const otherBundles = input.bundles.filter((b) => b.bundleProductId !== input.bundleProductId);
  if (otherBundles.some((b) => b.components.some((c) => c.productId === input.bundleProductId))) {
    out.push({ refusal: 'bundle_is_a_component', detail: `${input.bundleProductId} is already a component of another bundle — a bundle explodes once, so it cannot also be one` });
  }
  for (const c of input.components) {
    if (seen.has(c.productId)) out.push({ refusal: 'bundle_component_repeated', detail: `${c.productId} is listed twice — give it once with the whole quantity` });
    seen.add(c.productId);
    if (!Number.isSafeInteger(c.quantityMinor) || c.quantityMinor <= 0) out.push({ refusal: 'bundle_component_quantity', detail: `${c.productId}: the quantity must be a whole number above 0 in its base unit (pieces, grams or millilitres)` });
    if (c.productId === input.bundleProductId) { out.push({ refusal: 'bundle_contains_itself', detail: 'a bundle cannot contain itself' }); continue; }
    const p = input.product(c.productId);
    if (p === undefined) { out.push({ refusal: 'bundle_component_unknown', detail: `${c.productId} is not a product head office holds` }); continue; }
    if (otherBundles.some((b) => b.bundleProductId === c.productId)) out.push({ refusal: 'bundle_component_is_a_bundle', detail: `${c.productId} is itself a bundle — list its own components instead` });
    if (p.lifecycle === 'draft' || p.lifecycle === 'discontinued' || p.recallBlocked === true) out.push({ refusal: 'bundle_component_not_sellable', detail: `${c.productId} is ${p.recallBlocked === true ? 'recall-blocked' : p.lifecycle} and cannot be sold, so a bundle cannot hold it` });
    if (p.safety?.tobacco === true) out.push({ refusal: 'bundle_component_tobacco', detail: `${c.productId} is tobacco — a bundle promotes what it holds, and tobacco may not be promoted (COTPA s.5 · B15)` });
    if (p.safety?.liquor === true) out.push({ refusal: 'bundle_component_liquor', detail: `${c.productId} is liquor — SRE does not sell liquor (TASMAC · B17)` });
    if (p.safety?.carryBag === true) out.push({ refusal: 'bundle_component_carry_bag', detail: `${c.productId} is a carry bag — a bag is always its own line at its price (OB-173)` });
    if (p.safety?.gold === true) out.push({ refusal: 'bundle_component_gold', detail: `${c.productId} is a gold piece — each hallmarked piece is sold alone, by its HUID (B13)` });
  }
  return out;
}

/** The definition in force at `at` (the latest version defined at or before it), or undefined. */
export function bundleInForce(history: readonly BundleDefinition[], bundleProductId: string, at: string): BundleDefinition | undefined {
  return history
    .filter((d) => d.bundleProductId === bundleProductId && d.definedAt <= at)
    .sort((a, b) => a.version - b.version)
    .at(-1);
}

export interface ExplodedLine {
  readonly productId: string;
  readonly quantityMinor: number;
  /** The bundle the quantity came from, and its definition version — the stock movement's evidence. */
  readonly fromBundle: string;
  readonly bundleVersion: number;
}

/**
 * The component stock one sold bundle line takes off the shelf: each component's quantity × the bundles sold. `bundlesSold`
 * is the line's quantity in the bundle's own unit (a whole number of bundles). Pure — the caller writes the movements.
 */
export function explodeBundleLine(definition: BundleDefinition, bundlesSold: number): readonly ExplodedLine[] {
  if (!Number.isSafeInteger(bundlesSold) || bundlesSold === 0) return [];
  return definition.components.map((c) => ({
    productId: c.productId, quantityMinor: c.quantityMinor * bundlesSold, fromBundle: definition.bundleProductId, bundleVersion: definition.version,
  }));
}
