// Product master (M03-FR-01/03/04) — the single trusted product truth every channel
// shares (P-02).
//
// A wrong product record does not stay wrong in one place. It multiplies into every
// sale, every order, every report and every tax return, and it is discovered months
// later at stock-take. So this module's job is to be **hard to publish something
// wrong through**, and it does that with one rule:
//
//     AN INCOMPLETE PRODUCT IS A DRAFT, NOT AN ERROR.
//
// You can always save what you know. The system tells you exactly what is still
// missing and refuses to PUBLISH until it is there. A product that never reaches the
// shelf because a field is missing is a nuisance; a product that reaches the shelf
// with no tax class, no allergen data or the wrong MRP is a liability.
//
// What can never be published:
//   • no primary category, no tax class (M03-FR-01 acceptance);
//   • a food item with no allergen declaration (M03-FR-03 acceptance) — "contains
//     nothing" must be stated explicitly, because silence is not a declaration;
//   • a packed or weighed item missing its Legal Metrology label fields (§9.3);
//   • an attribute that does not match the schema its department defines.
//
// What can never be SOLD, published or not: a recall-blocked item, a discontinued
// item, and anything not in an active lifecycle state — enforced here so the answer
// is the same online, offline and in every channel (§31).
//
// Attributes are per-tenant and typed ("make everything choose-able"): a fish
// counter and an electronics aisle do not need the same fields, and neither list
// belongs in our code.
//
// Pure and deterministic: no clock, no I/O.

import type { Money } from '../../contracts/src/money';

export type ProductLifecycle = 'draft' | 'new' | 'active' | 'clearance' | 'discontinued';

/** Lifecycle states in which an item may be sold at all (M03-FR-04). */
export const SELLABLE_LIFECYCLE: readonly ProductLifecycle[] = ['new', 'active', 'clearance'];

export type AttributeType = 'text' | 'number' | 'boolean' | 'enum' | 'date';

/** One field a department requires or offers — defined per tenant, never by us. */
export interface AttributeDefinition {
  readonly key: string;
  readonly label: string;
  readonly type: AttributeType;
  readonly required?: boolean;
  /** Allowed values for an `enum` attribute. */
  readonly allowed?: readonly string[];
}

/** A department/category node. A product sits in exactly one primary category. */
export interface Category {
  readonly categoryId: string;
  readonly name: string;
  readonly parentId: string | null;
  /** Attributes every product in this category must or may carry. */
  readonly attributes?: readonly AttributeDefinition[];
  /** Food, medicine, alcohol… — drives the safety rules below (⟳ AVR-12). */
  readonly regulated?: readonly RegulatedKind[];
}

export type RegulatedKind = 'food' | 'packed' | 'weighed' | 'age_restricted' | 'drug' | 'hazardous';

/** Safety and compliance content (M03-FR-03 / D01). */
export interface SafetyContent {
  /** Ingredient list, where the law requires one. */
  readonly ingredients?: string;
  /**
   * Allergens present. An EMPTY ARRAY is a positive declaration of "none";
   * `undefined` means nobody has declared anything, which is not the same thing.
   */
  readonly allergens?: readonly string[];
  readonly countryOfOrigin?: string;
  readonly storageConditions?: string;
  /** Net quantity as printed — a Legal Metrology label field (§9.3). */
  readonly netQuantity?: string;
  /** Name and address of the packer/importer — a Legal Metrology label field. */
  readonly packerDetails?: string;
  readonly minimumAge?: number;
}

/** An effective-dated value — MRP and tax are historised, never overwritten. */
export interface EffectiveValue<T> {
  readonly value: T;
  /** ISO-8601 date (YYYY-MM-DD) this value takes effect. */
  readonly effectiveFrom: string;
}

export interface ProductRecord {
  readonly productId: string;
  readonly tenantId: string;
  readonly sku: string;
  readonly name: string;
  readonly brand?: string;
  readonly manufacturer?: string;
  /** Exactly one primary category — the reporting home (M03-FR-01). */
  readonly primaryCategoryId: string | null;
  /** A variant shares a parent with its siblings (size, colour, flavour). */
  readonly parentProductId?: string | null;
  readonly baseUom: string;
  /** HSN / tax class code. Nothing publishes without one. */
  readonly taxClass: string | null;
  /** Effective-dated MRP history, newest last (M03-FR-03). */
  readonly mrpHistory?: readonly EffectiveValue<Money>[];
  readonly attributes?: Readonly<Record<string, string>>;
  readonly safety?: SafetyContent;
  readonly lifecycle: ProductLifecycle;
  /** Stops sale AND purchase everywhere, honoured offline (M10-FR-04 / D01-FR-05). */
  readonly recallBlocked?: boolean;
}

export type ValidationSeverity = 'blocks_publish' | 'advisory';

export interface ProductIssue {
  readonly field: string;
  readonly severity: ValidationSeverity;
  /** Plain English — the person fixing it is not a programmer. */
  readonly message: string;
}

export interface ValidationResult {
  readonly productId: string;
  readonly issues: readonly ProductIssue[];
  /** True when nothing blocks publication. Advisory issues do not stop it. */
  readonly publishable: boolean;
}

export class CategoryNotFoundError extends Error {
  constructor(public readonly categoryId: string) {
    super(`No category "${categoryId}" — a product cannot sit outside the hierarchy`);
    this.name = 'CategoryNotFoundError';
  }
}

export class NotPublishableError extends Error {
  constructor(
    public readonly productId: string,
    public readonly issues: readonly ProductIssue[],
  ) {
    super(
      `Product "${productId}" cannot be published: ${issues.map((i) => i.message).join('; ')}`,
    );
    this.name = 'NotPublishableError';
  }
}

function attributeIssue(
  definition: AttributeDefinition,
  raw: string | undefined,
): ProductIssue | null {
  if (raw === undefined || raw.trim() === '') {
    return definition.required === true
      ? {
          field: `attributes.${definition.key}`,
          severity: 'blocks_publish',
          message: `"${definition.label}" is required for this category and is empty`,
        }
      : null;
  }
  switch (definition.type) {
    case 'number':
      return Number.isFinite(Number(raw))
        ? null
        : {
            field: `attributes.${definition.key}`,
            severity: 'blocks_publish',
            message: `"${definition.label}" must be a number, but reads "${raw}"`,
          };
    case 'boolean':
      return ['true', 'false', 'yes', 'no'].includes(raw.toLowerCase())
        ? null
        : {
            field: `attributes.${definition.key}`,
            severity: 'blocks_publish',
            message: `"${definition.label}" must be yes or no, but reads "${raw}"`,
          };
    case 'enum':
      return (definition.allowed ?? []).includes(raw)
        ? null
        : {
            field: `attributes.${definition.key}`,
            severity: 'blocks_publish',
            message: `"${definition.label}" must be one of ${(definition.allowed ?? []).join(', ')}, but reads "${raw}"`,
          };
    case 'date':
      return /^\d{4}-\d{2}-\d{2}$/.test(raw) && !Number.isNaN(Date.parse(raw))
        ? null
        : {
            field: `attributes.${definition.key}`,
            severity: 'blocks_publish',
            message: `"${definition.label}" must be a date like 2026-08-01, but reads "${raw}"`,
          };
    case 'text':
      return null;
  }
}

/**
 * Check a product against its category's rules. Never throws for incompleteness —
 * an incomplete product is a legitimate draft; the result says exactly what is
 * missing and whether it may be published.
 */
export function validateProduct(
  product: ProductRecord,
  categories: readonly Category[],
): ValidationResult {
  const issues: ProductIssue[] = [];

  if (product.name.trim() === '') {
    issues.push({ field: 'name', severity: 'blocks_publish', message: 'the product has no name' });
  }
  if (product.sku.trim() === '') {
    issues.push({ field: 'sku', severity: 'blocks_publish', message: 'the product has no SKU' });
  }
  if (product.baseUom.trim() === '') {
    issues.push({
      field: 'baseUom',
      severity: 'blocks_publish',
      message: 'no unit of measure — the system cannot count or price it',
    });
  }

  // A product with no home cannot be reported on, replenished or taxed correctly.
  if (product.primaryCategoryId === null || product.primaryCategoryId.trim() === '') {
    issues.push({
      field: 'primaryCategoryId',
      severity: 'blocks_publish',
      message: 'no category — every product sits in exactly one place in the hierarchy',
    });
  }
  if (product.taxClass === null || product.taxClass.trim() === '') {
    issues.push({
      field: 'taxClass',
      severity: 'blocks_publish',
      message: 'no HSN / tax class — the bill would charge the wrong tax',
    });
  }

  const category =
    product.primaryCategoryId === null
      ? undefined
      : categories.find((c) => c.categoryId === product.primaryCategoryId);
  if (product.primaryCategoryId !== null && product.primaryCategoryId.trim() !== '' && !category) {
    throw new CategoryNotFoundError(product.primaryCategoryId);
  }

  for (const definition of category?.attributes ?? []) {
    const issue = attributeIssue(definition, product.attributes?.[definition.key]);
    if (issue) issues.push(issue);
  }

  // --- safety and compliance content (M03-FR-03) ------------------------------
  const regulated = category?.regulated ?? [];
  const safety = product.safety;

  if (regulated.includes('food') && safety?.allergens === undefined) {
    // The acceptance test: a food item missing allergen data is blocked from publish.
    // An empty list means "declared: none" and passes; silence does not.
    issues.push({
      field: 'safety.allergens',
      severity: 'blocks_publish',
      message:
        'no allergen declaration — a food item must state its allergens, or state explicitly that it has none',
    });
  }
  if (regulated.includes('food') && (safety?.countryOfOrigin ?? '') === '') {
    issues.push({
      field: 'safety.countryOfOrigin',
      severity: 'blocks_publish',
      message: 'no country of origin — required for a food item',
    });
  }
  if (
    (regulated.includes('packed') || regulated.includes('weighed')) &&
    (safety?.netQuantity ?? '') === ''
  ) {
    issues.push({
      field: 'safety.netQuantity',
      severity: 'blocks_publish',
      message: 'no net quantity — a Legal Metrology label field for packed or weighed goods',
    });
  }
  if (regulated.includes('packed') && (safety?.packerDetails ?? '') === '') {
    issues.push({
      field: 'safety.packerDetails',
      severity: 'blocks_publish',
      message: 'no packer or importer details — a Legal Metrology label field',
    });
  }
  if (regulated.includes('age_restricted') && safety?.minimumAge === undefined) {
    issues.push({
      field: 'safety.minimumAge',
      severity: 'blocks_publish',
      message: 'no minimum age — the till must know when to ask for proof of age',
    });
  }
  if (regulated.includes('food') && (safety?.storageConditions ?? '') === '') {
    issues.push({
      field: 'safety.storageConditions',
      severity: 'advisory',
      message: 'no storage conditions — worth adding for a food item',
    });
  }

  return {
    productId: product.productId,
    issues,
    publishable: !issues.some((i) => i.severity === 'blocks_publish'),
  };
}

/** Publish a validated product. Throws `NotPublishableError` with every reason. */
export function publishProduct(
  product: ProductRecord,
  categories: readonly Category[],
): ProductRecord {
  const result = validateProduct(product, categories);
  if (!result.publishable) {
    throw new NotPublishableError(
      product.productId,
      result.issues.filter((i) => i.severity === 'blocks_publish'),
    );
  }
  return { ...product, lifecycle: product.lifecycle === 'draft' ? 'new' : product.lifecycle };
}

export type SellRefusal = 'recall_blocked' | 'not_published' | 'discontinued' | 'sellable';

/**
 * May this be sold right now? The same answer online, offline and in every channel
 * (P-02 / §31) — a recall block is honoured with the network cable out.
 */
export function sellability(product: ProductRecord): SellRefusal {
  if (product.recallBlocked === true) return 'recall_blocked';
  if (product.lifecycle === 'discontinued') return 'discontinued';
  if (product.lifecycle === 'draft') return 'not_published';
  return 'sellable';
}

export function canSell(product: ProductRecord): boolean {
  return sellability(product) === 'sellable';
}

/** May this be ordered from a supplier? A recall block stops purchase too. */
export function canPurchase(product: ProductRecord): boolean {
  return (
    product.recallBlocked !== true &&
    product.lifecycle !== 'discontinued' &&
    product.lifecycle !== 'clearance' &&
    product.lifecycle !== 'draft'
  );
}

/**
 * The MRP in force on a date. Effective-dated and historised, so a bill printed
 * last month can still be explained (M03-FR-03) — nothing is overwritten.
 */
export function mrpOn(product: ProductRecord, onDate: string): Money | undefined {
  const applicable = (product.mrpHistory ?? [])
    .filter((entry) => entry.effectiveFrom <= onDate)
    .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  return applicable[applicable.length - 1]?.value;
}
