// Product completeness (D01) — "shows what is missing before an item can sell online".
//
// `validateProduct` already answers *may this be published*. What it cannot answer is *how close is
// this to being finished*, and on a catalogue of twenty thousand items that is the question somebody
// actually has: which two hundred records are one field away from selling, and which field.
//
// ── Why this is counts first and a percentage second ────────────────────────
//
// A bare "68% complete" is the kind of number that gets put on a dashboard and then decided upon,
// and nobody can say what the other 32% is. Worse, a percentage computed over an unnamed set of
// checks changes meaning silently the moment somebody adds a check — the same product drops to 60%
// overnight and reads as a regression.
//
// So the score is **a list of named checks with a verdict each**, and the percentage is derived
// from those counts and always rendered beside them. Anybody can point at the missing ones.
//
// ── The checks are per-tenant, not ours ─────────────────────────────────────
//
// Which attributes matter, and which departments are regulated, come from the tenant's own category
// definitions (`Category.attributes`, `Category.regulated`). This file adds no opinion about what a
// hypermarket in Tamil Nadu ought to record. It reports what THIS tenant said it requires, and what
// the law requires of the departments this tenant declared regulated.
//
// ── An unscoreable product scores nothing, not zero ─────────────────────────
//
// A product in a category this list does not contain cannot be checked at all — its required
// attributes and its regulated flags are unknown. That is reported as **not knowable**, with the
// reason, rather than as 0%: a zero reads as *somebody has filled in nothing*, which would send
// a person to fix a record that may already be perfect.

import {
  validateProduct,
  CategoryNotFoundError,
  type Category,
  type ProductIssue,
  type ProductRecord,
} from './product';

/** One named thing a finished product record has. */
export interface CompletenessCheck {
  readonly field: string;
  /** Plain English — the person reading this is not a programmer. */
  readonly label: string;
  /** True when this one is done. */
  readonly done: boolean;
  /** Whether not doing it stops the product being published at all. */
  readonly blocksPublish: boolean;
  /** Why it is not done, when it is not. */
  readonly missing?: string;
}

export type CompletenessScore =
  | {
    readonly knowable: true;
    readonly productId: string;
    readonly checks: readonly CompletenessCheck[];
    /** Checks that must be done before this can be published at all. */
    readonly required: { readonly done: number; readonly total: number };
    /** Checks worth doing that do not stop publication. */
    readonly advisory: { readonly done: number; readonly total: number };
    /** Whole percent over every check, always shown beside the counts it came from. */
    readonly percent: number;
    /** True when nothing blocking is outstanding — the same answer `validateProduct` gives. */
    readonly publishable: boolean;
  }
  | {
    readonly knowable: false;
    readonly productId: string;
    readonly why: string;
  };

/**
 * The checks every product record is measured against, whatever it sells.
 *
 * Per-tenant attributes and the regulated-department rules are added on top of these from the
 * category, so this is the floor rather than the whole list.
 */
const UNIVERSAL: readonly { readonly field: string; readonly label: string; readonly blocks: boolean }[] = Object.freeze([
  { field: 'name', label: 'a name', blocks: true },
  { field: 'sku', label: 'an item code', blocks: true },
  { field: 'primaryCategoryId', label: 'a department', blocks: true },
  { field: 'taxClass', label: 'an HSN / tax code', blocks: true },
  { field: 'baseUom', label: 'a unit it is sold in', blocks: true },
  { field: 'brand', label: 'a brand', blocks: false },
  { field: 'mrp', label: 'a printed MRP', blocks: false },
]);

/** The safety and label fields, which apply only to the departments this tenant declared regulated. */
const REGULATED: readonly { readonly field: string; readonly label: string }[] = Object.freeze([
  { field: 'safety.allergens', label: 'an allergen declaration' },
  { field: 'safety.countryOfOrigin', label: 'a country of origin' },
  { field: 'safety.storageConditions', label: 'how it must be stored' },
  { field: 'safety.netQuantity', label: 'the net quantity on the label' },
  { field: 'safety.packerDetails', label: 'the packer or importer' },
  { field: 'safety.minimumAge', label: 'the minimum age to buy it' },
  { field: 'safety.ingredients', label: 'an ingredient list' },
]);

/** Did the validator complain about this field? */
const issueFor = (issues: readonly ProductIssue[], field: string): ProductIssue | undefined =>
  issues.find((i) => i.field === field);

/**
 * Score one product against its own category's rules.
 *
 * Every check the validator can raise is listed whether or not it fired, so the denominator is a
 * named set rather than however many complaints happened to come back. A check the tenant's
 * category does not ask for is simply not in the list — it is not a check this product failed.
 */
export function completeness(
  product: ProductRecord,
  categories: readonly Category[],
): CompletenessScore {
  let issues: readonly ProductIssue[];
  try {
    issues = validateProduct(product, categories).issues;
  } catch (e) {
    if (e instanceof CategoryNotFoundError) {
      // Not 0%. Nobody can say what this record is missing without knowing what its department
      // asks for, and a zero would send somebody to fix a record that may already be finished.
      return {
        knowable: false,
        productId: product.productId,
        why: `this product is in department "${e.categoryId}", which is not in the list this screen was given — so what it needs is unknown`,
      };
    }
    throw e;
  }

  const category = categories.find((c) => c.categoryId === product.primaryCategoryId);
  const checks: CompletenessCheck[] = [];

  const push = (field: string, label: string, blocks: boolean, done: boolean): void => {
    const issue = issueFor(issues, field);
    checks.push({
      field,
      label,
      done,
      blocksPublish: blocks,
      ...(done ? {} : { missing: issue?.message ?? `no ${label}` }),
    });
  };

  for (const check of UNIVERSAL) {
    // MRP and brand are not validator fields — they are advisory content, so they are read off the
    // record directly. Everything else is done exactly when the validator did not complain.
    const done = check.field === 'mrp'
      ? (product.mrpHistory ?? []).length > 0
      : check.field === 'brand'
        ? (product.brand ?? '').trim() !== ''
        : issueFor(issues, check.field) === undefined;
    push(check.field, check.label, check.blocks, done);
  }

  // What THIS tenant said this department requires. Never our opinion of what a shop should record.
  for (const attribute of category?.attributes ?? []) {
    const value = product.attributes?.[attribute.key];
    push(
      `attributes.${attribute.key}`,
      attribute.label,
      attribute.required === true,
      issueFor(issues, `attributes.${attribute.key}`) === undefined && value !== undefined && value.trim() !== '',
    );
  }

  // The safety and label fields, only where the tenant declared the department regulated. An
  // unregulated department is not failing these checks; it is not being asked them.
  if ((category?.regulated ?? []).length > 0) {
    for (const field of REGULATED) {
      const issue = issueFor(issues, field.field);
      // Present only when the validator considers it relevant to this department, or it is filled
      // in. Listing every safety field against a tin of paint would make the score meaningless.
      const filled = safetyFilled(product, field.field);
      if (issue === undefined && !filled) continue;
      push(field.field, field.label, issue?.severity === 'blocks_publish', issue === undefined);
    }
  }

  const required = checks.filter((c) => c.blocksPublish);
  const advisory = checks.filter((c) => !c.blocksPublish);
  const done = checks.filter((c) => c.done).length;

  return {
    knowable: true,
    productId: product.productId,
    checks,
    required: { done: required.filter((c) => c.done).length, total: required.length },
    advisory: { done: advisory.filter((c) => c.done).length, total: advisory.length },
    // Rounded down on purpose: 99% must never be printed next to an outstanding required field.
    percent: checks.length === 0 ? 100 : Math.floor((done * 100) / checks.length),
    publishable: !issues.some((i) => i.severity === 'blocks_publish'),
  };
}

/** Is this safety field filled in on the record? */
function safetyFilled(product: ProductRecord, field: string): boolean {
  const safety = product.safety;
  if (safety === undefined) return false;
  switch (field) {
    case 'safety.allergens': return safety.allergens !== undefined;
    case 'safety.countryOfOrigin': return (safety.countryOfOrigin ?? '') !== '';
    case 'safety.storageConditions': return (safety.storageConditions ?? '') !== '';
    case 'safety.netQuantity': return (safety.netQuantity ?? '') !== '';
    case 'safety.packerDetails': return (safety.packerDetails ?? '') !== '';
    case 'safety.minimumAge': return safety.minimumAge !== undefined;
    case 'safety.ingredients': return (safety.ingredients ?? '') !== '';
    default: return false;
  }
}

/**
 * The catalogue's own worklist: the records closest to being sellable, worst blocker first.
 *
 * Sorted so the people doing the work start where one field unlocks an item, rather than at the top
 * of an alphabetical list. Products that cannot be scored at all come first regardless — a record
 * nobody can even measure is a bigger problem than one that is 60% done.
 */
export function worklist(
  products: readonly ProductRecord[],
  categories: readonly Category[],
): readonly CompletenessScore[] {
  const scores = products.map((p) => completeness(p, categories));
  return [...scores].sort((a, b) => {
    if (a.knowable !== b.knowable) return a.knowable ? 1 : -1;
    if (!a.knowable || !b.knowable) return a.productId.localeCompare(b.productId);
    if (a.publishable !== b.publishable) return a.publishable ? 1 : -1;
    const aLeft = a.required.total - a.required.done;
    const bLeft = b.required.total - b.required.done;
    if (aLeft !== bLeft) return aLeft - bLeft;
    return a.productId.localeCompare(b.productId);
  });
}
