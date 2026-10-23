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
import type { TobaccoWarningRecord } from './tobacco-warning';
import { nutritionProblems, nutritionRequired, type NutritionFacts } from './nutrition';
import { liquorReason, LIQUOR_NOT_SOLD } from '../../restricted-sales/src/liquor';

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

/**
 * `bis_controlled` (B12 · OB-325): goods under a BIS Quality Control Order — packaged drinking water and the other QCO
 * goods — sold only with the ISI mark under a current BIS licence. A product in such a category must carry its BIS
 * licence number and the licence's expiry date to publish, and the till refuses it offline when either is missing or the
 * licence has run out.
 */
export type RegulatedKind = 'food' | 'packed' | 'weighed' | 'age_restricted' | 'drug' | 'hazardous' | 'bis_controlled'
  /** B17: a liquor category — nothing in it can be published or sold (TASMAC state monopoly). */
  | 'liquor';

/**
 * How a product travels and what it may share a crate with (M19-FR-02 / M10-FR-02) — owned HERE as master data, in the
 * same words the fulfilment pack engine judges by (`tests/unit/product-master.test.ts` pins the two lists together).
 * A product with none cannot be packed from a picker's wave: head office says `handling_unknown` and a person sets it.
 * Never defaulted to ambient, never inferred from the product's name.
 */
export const HANDLING_CLASSES = Object.freeze(['ambient', 'chilled', 'frozen', 'raw_meat', 'ready_to_eat', 'fragile', 'hazardous'] as const);
export type HandlingClass = (typeof HANDLING_CLASSES)[number];

/** The handling classes the pack engine judges by temperature — the only ones a per-product limit may be set on (HA-3). */
export const COLD_HANDLING_CLASSES = Object.freeze(['chilled', 'frozen', 'raw_meat'] as const);

/**
 * A product's own cold-chain limits at pack, in tenths of a degree (HA-3 · M10-FR-02 · M19-FR-02). Set only on a chilled,
 * frozen or raw-meat product. Absent means the pack engine's APPROVED class default applies — and every packed line says
 * which of the two it was judged by, so a default is never silent.
 */
export interface ColdChainLimits {
  readonly minTenthsC?: number;
  readonly maxTenthsC?: number;
}

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
  /**
   * B14 (COTPA 2003): the product is tobacco. It then needs the customer to be at least 18 at the till, whatever
   * `minimumAge` says, and `packMinimumMinor` must say one whole pack — the till refuses anything less.
   */
  readonly tobacco?: boolean;
  /** One whole pack, in the base unit's smallest units (e.g. 10 for a pack of 10 sold `ea`). Required for tobacco. */
  readonly packMinimumMinor?: number;
  /** B19: the product is a carry bag — the till sells it only as its own line, at a price above zero. */
  readonly carryBag?: boolean;
  /** B19: what the bag is made of — `plastic` is held to the 120-micron minimum; cloth, paper and compostable are not. */
  readonly plasticMaterial?: 'plastic' | 'cloth' | 'paper' | 'compostable';
  /** B19: a plastic bag's thickness in microns. A plastic carry bag with none recorded cannot be sold. */
  readonly plasticThicknessMicrons?: number;
  /** B19: the product is on the banned single-use-plastic list — the till never sells it. */
  readonly bannedSingleUsePlastic?: boolean;
  /**
   * B13 (BIS IS 1417:2016 · OB-138): the product is a gold article. Each piece is its own product and must carry its
   * hallmark's HUID before the till sells it.
   */
  readonly gold?: boolean;
  /** B13: the piece's 6-character Hallmark Unique ID (letters and digits), exactly as hallmarked. */
  readonly huid?: string;
  /**
   * B12 (OB-325): the product is under a BIS Quality Control Order. Set on publish from its category (`bis_controlled`);
   * may also be set on the product itself. The pack carries it to the till with the two fields below.
   */
  readonly bisControlled?: boolean;
  /** B12: the BIS licence number (for example "CM/L-1234567890") the ISI mark on the product is used under. */
  readonly bisLicenceNo?: string;
  /** B12: the last day (YYYY-MM-DD) that BIS licence is valid — the till stops selling the product after it. */
  readonly bisLicenceValidUntil?: string;
  /**
   * B8 (OB-298, owner 23 Oct 2026): a perishable whose barcode does not carry its date — the cashier confirms the date
   * printed on the pack with one tap before the line is added, and the confirmation is kept on the sale line.
   */
  readonly perishable?: boolean;
  /**
   * B17 (TASMAC state monopoly · OWNER_DECISIONS D3): the product is an alcoholic drink. Such a product is never published
   * or sold — the flag exists so it can be REFUSED by name, not so it can be age-checked.
   */
  readonly liquor?: boolean;
  /** OB-307: SRE itself packs or labels this product (a counter pack, a repack, an own label) — then food needs `nutrition`. */
  readonly packedBySre?: boolean;
  /** M03-FR-03 · D01-FR-04: the nutrition panel, per 100 g or 100 ml (FSSAI 2020 list). Recorded when known (OB-307). */
  readonly nutrition?: NutritionFacts;
}

/** A real calendar date written YYYY-MM-DD. */
const isCalendarDay = (v: unknown): v is string => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};

/** B12: whether a product is BIS-controlled — flagged itself, or in a `bis_controlled` category. */
export function isBisControlled(product: Pick<ProductRecord, 'safety'>, category: Pick<Category, 'regulated'> | undefined): boolean {
  return product.safety?.bisControlled === true || (category?.regulated ?? []).includes('bis_controlled');
}

/** B13: a Hallmark Unique ID — six characters, capital letters and digits (BIS). */
export const HUID_PATTERN = /^[A-Z0-9]{6}$/;

/** An effective-dated value — MRP and tax are historised, never overwritten. */
export interface EffectiveValue<T> {
  readonly value: T;
  /** ISO-8601 date (YYYY-MM-DD) this value takes effect. */
  readonly effectiveFrom: string;
}

/**
 * D01-FR-06 (round 8): what the customer app shows and searches for a product, authored on the product master and carried
 * to the app through the store pack — a Tamil name, a short description in each language, and the other words customers
 * use for it (synonyms: "dal" for "toor dal", "atta" for "wheat flour"). Images are NOT here: where product images live is
 * an open owner decision (no object store, ADR-0010 / OB-45).
 */
export interface AppContent {
  readonly nameTa?: string;
  readonly descriptionEn?: string;
  readonly descriptionTa?: string;
  readonly synonyms?: readonly string[];
  readonly setBy?: string;
  readonly setAt?: string;
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
  /** How it travels and what it may share a crate with (M19-FR-02). Absent = nobody has said; the pack refuses, never guesses. */
  readonly handling?: HandlingClass;
  /** The product's own cold-chain limits at pack (HA-3). Absent = the approved class default, said on the pack line. */
  readonly coldChain?: ColdChainLimits;
  /** D01-FR-06 (round 8): the customer app's content and synonyms — authored apart from the record, carried to the app. */
  readonly appContent?: AppContent;
  /**
   * B16 (OB-140 "A"): the tobacco health-warning confirmations a named person gave, and the government pictures known when
   * they were stamped. Authored on its own route (`/tobacco-warning-confirmation`), carried forward on every publish.
   */
  readonly tobaccoWarning?: TobaccoWarningRecord;
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
  // B14 · B19 (roadmap v2.1): the till's legal gates read these from the pack, so a value the till cannot read is refused
  // HERE rather than published as a product the till would then refuse at the counter for a reason nobody can fix there.
  const wholePositive = (v: unknown): boolean => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
  // B12 (OB-325): a BIS-controlled product needs its BIS licence number and the licence's expiry date before it publishes.
  if (isBisControlled(product, category)) {
    if (typeof safety?.bisLicenceNo !== 'string' || safety.bisLicenceNo.trim() === '') {
      issues.push({ field: 'safety.bisLicenceNo', severity: 'blocks_publish', message: 'this product is under a BIS Quality Control Order and has no BIS licence number — the till cannot sell it without one' });
    }
    if (!isCalendarDay(safety?.bisLicenceValidUntil)) {
      issues.push({ field: 'safety.bisLicenceValidUntil', severity: 'blocks_publish', message: 'this product is under a BIS Quality Control Order and has no BIS licence expiry date (YYYY-MM-DD) — the till cannot judge the licence current without one' });
    }
  } else if (safety?.bisLicenceValidUntil !== undefined && !isCalendarDay(safety.bisLicenceValidUntil)) {
    issues.push({ field: 'safety.bisLicenceValidUntil', severity: 'blocks_publish', message: `the BIS licence expiry "${String(safety.bisLicenceValidUntil)}" is not a date written YYYY-MM-DD` });
  }

  for (const key of ['tobacco', 'carryBag', 'bannedSingleUsePlastic', 'gold', 'bisControlled', 'perishable'] as const) {
    const v: unknown = safety?.[key];
    if (v !== undefined && typeof v !== 'boolean') {
      issues.push({ field: `safety.${key}`, severity: 'blocks_publish', message: `${key} must be true or false — the till cannot read "${String(v)}"` });
    }
  }
  if (safety?.tobacco === true && !wholePositive(safety.packMinimumMinor)) {
    issues.push({
      field: 'safety.packMinimumMinor',
      severity: 'blocks_publish',
      message: 'a tobacco product needs its pack size (a whole number of units) — the till sells whole packs only and refuses loose cigarettes',
    });
  }
  if (safety?.tobacco === true && safety.minimumAge !== undefined && safety.minimumAge < 18) {
    issues.push({
      field: 'safety.minimumAge',
      severity: 'blocks_publish',
      message: 'a tobacco product cannot be sold to anyone under 18 — its minimum age must be 18 or more',
    });
  }
  // B13 (OB-138): a HUID the till cannot read is no HUID — refused here, never published as a hallmark nobody can check.
  if (safety?.huid !== undefined && !(typeof safety.huid === 'string' && HUID_PATTERN.test(safety.huid))) {
    issues.push({
      field: 'safety.huid',
      severity: 'blocks_publish',
      message: 'the HUID must be the 6 letters and digits of the hallmark, exactly as printed (for example AB12CD)',
    });
  }
  if (safety?.gold === true && safety.huid === undefined) {
    issues.push({
      field: 'safety.huid',
      severity: 'advisory',
      message: 'a gold item cannot be sold at the till until its hallmark HUID is recorded on the product',
    });
  }
  if (safety?.plasticThicknessMicrons !== undefined && !wholePositive(safety.plasticThicknessMicrons)) {
    issues.push({
      field: 'safety.plasticThicknessMicrons',
      severity: 'blocks_publish',
      message: 'the plastic thickness must be a whole number of microns',
    });
  }
  if (safety?.plasticMaterial !== undefined && !['plastic', 'cloth', 'paper', 'compostable'].includes(safety.plasticMaterial)) {
    issues.push({
      field: 'safety.plasticMaterial',
      severity: 'blocks_publish',
      message: 'the bag material must be one of plastic, cloth, paper or compostable',
    });
  }
  if (safety?.carryBag === true && safety.plasticMaterial === 'plastic' && (safety.plasticThicknessMicrons ?? 0) < 120) {
    issues.push({
      field: 'safety.plasticThicknessMicrons',
      severity: 'advisory',
      message: 'a plastic carry bag thinner than 120 microns (or with no thickness recorded) cannot be sold at the till',
    });
  }
  if (safety?.bannedSingleUsePlastic === true) {
    issues.push({
      field: 'safety.bannedSingleUsePlastic',
      severity: 'advisory',
      message: 'this item is on the banned single-use-plastic list — the till will refuse to sell it',
    });
  }
  if (regulated.includes('food') && (safety?.storageConditions ?? '') === '') {
    issues.push({
      field: 'safety.storageConditions',
      severity: 'advisory',
      message: 'no storage conditions — worth adding for a food item',
    });
  }

  // B17 (TASMAC · OWNER_DECISIONS D3): liquor is never published, whatever else is right about the record. No override.
  const liquor = liquorReason({ declaredLiquor: safety?.liquor === true, categoryKinds: regulated, hsn: product.taxClass });
  if (liquor !== undefined) {
    issues.push({ field: 'safety.liquor', severity: 'blocks_publish', message: `${LIQUOR_NOT_SOLD} This product cannot be published: ${liquor}` });
  }
  if (safety?.liquor !== undefined && typeof safety.liquor !== 'boolean') {
    issues.push({ field: 'safety.liquor', severity: 'blocks_publish', message: `liquor must be true or false — "${String(safety.liquor)}" cannot be read` });
  }

  // OB-307 (M03-FR-03 · D01-FR-04): nutrition is required only for food SRE packs or labels itself; recorded when known
  // otherwise — and a panel that is given must be readable and add up, whoever packed the product.
  if (safety?.packedBySre !== undefined && typeof safety.packedBySre !== 'boolean') {
    issues.push({ field: 'safety.packedBySre', severity: 'blocks_publish', message: 'packedBySre must be true or false' });
  }
  if (safety?.nutrition !== undefined) {
    for (const message of nutritionProblems(safety.nutrition)) issues.push({ field: 'safety.nutrition', severity: 'blocks_publish', message });
  } else if (nutritionRequired({ food: regulated.includes('food'), packedBySre: safety?.packedBySre === true })) {
    issues.push({
      field: 'safety.nutrition', severity: 'blocks_publish',
      message: 'no nutrition panel — SRE packs or labels this food itself, so its label must carry the nutrition information (energy, protein, carbohydrate and sugars, fat, cholesterol, sodium)',
    });
  }

  // A handling class the pack engine cannot read is no handling class: refused here, never carried as a word nobody judges by.
  if (product.handling !== undefined && !(HANDLING_CLASSES as readonly string[]).includes(product.handling)) {
    issues.push({
      field: 'handling',
      severity: 'blocks_publish',
      message: `handling "${product.handling}" is not one of ${HANDLING_CLASSES.join(', ')} — the packer's crate rules cannot read it`,
    });
  }

  // A cold-chain limit is explicit or it is nothing: whole tenths of a degree, a minimum not above the maximum, and only on
  // a product whose handling class the pack engine judges by temperature. Never coerced, never applied to a warm product.
  const cc = product.coldChain;
  if (cc !== undefined) {
    const whole = (v: number | undefined): boolean => v === undefined || Number.isInteger(v);
    if (!whole(cc.minTenthsC) || !whole(cc.maxTenthsC) || (cc.minTenthsC === undefined && cc.maxTenthsC === undefined)) {
      issues.push({ field: 'coldChain', severity: 'blocks_publish', message: 'a cold-chain limit needs a whole minimum and/or maximum in tenths of a degree (for example maxTenthsC 50 for 5.0 °C)' });
    } else if (cc.minTenthsC !== undefined && cc.maxTenthsC !== undefined && cc.minTenthsC > cc.maxTenthsC) {
      issues.push({ field: 'coldChain', severity: 'blocks_publish', message: `the cold-chain minimum (${cc.minTenthsC}) is above the maximum (${cc.maxTenthsC})` });
    } else if (product.handling === undefined || !(COLD_HANDLING_CLASSES as readonly string[]).includes(product.handling)) {
      issues.push({ field: 'coldChain', severity: 'blocks_publish', message: `a cold-chain limit on a product whose handling is ${product.handling ?? 'not set'} — set handling to chilled, frozen or raw_meat first, or remove the limit` });
    }
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
  // B12: a product in a BIS-controlled category carries the flag itself, so the pack tells the till without the category.
  const category = categories.find((c) => c.categoryId === product.primaryCategoryId);
  const stamped = isBisControlled(product, category) && product.safety?.bisControlled !== true
    ? { ...product, safety: { ...(product.safety ?? {}), bisControlled: true } }
    : product;
  return { ...stamped, lifecycle: product.lifecycle === 'draft' ? 'new' : product.lifecycle };
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
