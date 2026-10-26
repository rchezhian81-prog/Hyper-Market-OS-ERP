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
import { tobaccoAdvertisingRefusal } from '../../restricted-sales/src/advertising';

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
  | 'bundle_component_gold'
  /** B15: the bundle product itself is tobacco — a bundle promotes what it is (COTPA s.5). */
  | 'bundle_product_tobacco';

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
  // B15: the ONE advertising guard every surface asks (`tobaccoAdvertisingRefusal`) — over the bundle and what it holds.
  const tobacco = tobaccoAdvertisingRefusal('bundle', [input.bundleProductId, ...input.components.map((c) => c.productId)], (id) => input.product(id)?.safety?.tobacco === true);
  const isTobaccoHere = new Set(tobacco?.tobaccoProductIds ?? []);
  if (isTobaccoHere.has(input.bundleProductId)) out.push({ refusal: 'bundle_product_tobacco', detail: `${input.bundleProductId}: ${tobacco!.whatHappened}` });
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
    if (isTobaccoHere.has(c.productId)) out.push({ refusal: 'bundle_component_tobacco', detail: `${c.productId} is tobacco — a bundle promotes what it holds. ${tobacco!.whatHappened}` });
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

// ── OB-306 · OB-288 till side: the explosion a SALE LINE carries ───────────────────────────────────────────────────────
//
// The till explodes a bundle line with the definition its signed pack carries (`explodeBundleLine`) and FREEZES the result
// on the line it records: which bundle, which version, and what each component took off the shelf (with the component's
// unit). Head office writes one `sold` movement per component from it — and a return of the bundle puts back the same
// components, in proportion to the bundles returned. Pure.

/** One component's stock on a bundle line, in the component's base-unit minor units. */
export interface LineBundleComponent {
  readonly productId: string;
  readonly quantityMinor: number;
  /** The component's base unit, as the till's pack holds it (absent when the pack did not say). */
  readonly uom?: string;
}

/** The explosion a bundle line carries: the bundle, the definition version it was sold under, and its components. */
export interface LineBundle {
  readonly bundleProductId: string;
  readonly version: number;
  readonly components: readonly LineBundleComponent[];
}

/** The explosion to record on a line of `bundlesSold` bundles, or undefined when nothing can be taken (0, not whole). */
export function lineBundleOf(definition: BundleDefinition, bundlesSold: number, uomOf?: (productId: string) => string | undefined): LineBundle | undefined {
  const exploded = explodeBundleLine(definition, Math.abs(bundlesSold));
  if (exploded.length === 0) return undefined;
  return {
    bundleProductId: definition.bundleProductId, version: definition.version,
    components: exploded.map((c) => {
      const uom = uomOf?.(c.productId);
      return { productId: c.productId, quantityMinor: c.quantityMinor, ...(uom === undefined || uom === '' ? {} : { uom }) };
    }),
  };
}

const posWhole = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const textOf = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);

/** Read an untrusted explosion off a record. Anything malformed is refused whole — never half a bundle. */
export function readLineBundle(raw: unknown): LineBundle | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const bundleProductId = textOf(r['bundleProductId']);
  if (bundleProductId === undefined || !posWhole(r['version']) || !Array.isArray(r['components']) || r['components'].length === 0) return undefined;
  const components: LineBundleComponent[] = [];
  for (const c of r['components'] as unknown[]) {
    const o = (c !== null && typeof c === 'object' ? c : {}) as Record<string, unknown>;
    const productId = textOf(o['productId']);
    if (productId === undefined || !posWhole(o['quantityMinor'])) return undefined;
    const uom = textOf(o['uom']);
    components.push({ productId, quantityMinor: o['quantityMinor'], ...(uom === undefined ? {} : { uom }) });
  }
  return { bundleProductId, version: r['version'], components };
}

/**
 * The part of a sold explosion `returned` bundles out of `sold` give back — each component in proportion. Undefined when it
 * does not divide exactly (a bundle line is whole bundles, so it always does for an honest record).
 */
export function returnedLineBundle(sold: LineBundle, soldBundles: number, returnedBundles: number): LineBundle | undefined {
  if (!posWhole(soldBundles) || !posWhole(returnedBundles) || returnedBundles > soldBundles) return undefined;
  const components: LineBundleComponent[] = [];
  for (const c of sold.components) {
    const per = c.quantityMinor / soldBundles;
    if (!Number.isSafeInteger(per)) return undefined;
    components.push({ ...c, quantityMinor: per * returnedBundles });
  }
  return { ...sold, components };
}
