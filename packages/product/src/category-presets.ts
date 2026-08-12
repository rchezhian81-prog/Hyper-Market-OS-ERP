// Category presets (owner continuation directive, 12 Aug 2026 — categories A–G) built on the WP1
// category-policy engine. Each preset is a **sensible default** `CategoryPolicyRules` for a kind of
// merchandise, expressed as data the owner can date and override — NEVER a hard-coded law. The directive
// is explicit that category rules are effective-dated configuration; a preset is just the starting point
// a store adopts and then adjusts (a return window, a KYC threshold, switching a vertical on).
//
// The two controlled verticals — gold/jewellery and pharmacy-lite — ship `enabledByDefault: false`: they
// will not sell until the store switches them on (with the CA/legal sign-off the directive requires).
// Prescription / Schedule-H·H1·X medicines are represented by a `prescription_blocked` preset whose
// `controlledSale.blocked` is true, so such items are refused outright in a general hypermarket unless a
// separately-approved regulated-pharmacy extension replaces it. This module gives a store a correct,
// explainable place to start for each aisle; `presetPolicy` wraps a preset in an effective-dated
// `CategoryPolicy` so it drops straight into `resolvePolicy`.

import type { CategoryPolicy, CategoryPolicyRules } from './category-policy';

/** The kinds of merchandise this hypermarket recognises (directive categories A–G). */
export type CategoryKind =
  | 'grocery_fmcg' // A — ambient packaged grocery / FMCG
  | 'fresh_produce' // B — loose fruit & veg, weighed
  | 'perishable_packaged' // B — dairy/chilled/frozen: batch + expiry, blocked past use-by
  | 'gold_jewellery' // C — optional controlled vertical, OFF by default
  | 'otc_pharma_lite' // D — configurable OTC pharmacy-lite, OFF by default
  | 'prescription_blocked' // D — Rx / Schedule-H·H1·X: blocked from sale here
  | 'cosmetics' // E
  | 'electronics' // F
  | 'apparel_footwear'; // G

// A — ambient grocery / FMCG: barcode-scanned units, MRP/tax from the master, promotions and a normal
// return window. Batch/expiry are captured per product where the supplier gives them, not forced on the
// whole aisle, so traceability is 'none' at the category level.
const GROCERY_FMCG: CategoryPolicyRules = {
  traceability: 'none',
  quantityMode: 'each',
  valuation: 'retail_mrp',
  shelfLife: { perishable: false, blockSaleAfterExpiry: false },
  returns: { returnable: true, windowDays: 7 },
  controlledSale: {},
  approvals: [],
  enabledByDefault: true,
};

// B — fresh produce sold by weight off a verified scale, priced per kg, perishable and marked down as it
// ages. Not returnable once weighed and sold; a markdown needs approval (the expiry-ladder control).
const FRESH_PRODUCE: CategoryPolicyRules = {
  traceability: 'batch',
  quantityMode: 'weighed',
  valuation: 'rate_per_unit_weight',
  shelfLife: { perishable: true, blockSaleAfterExpiry: true, nearExpiryAlertDays: 1 },
  returns: { returnable: false },
  controlledSale: {},
  approvals: ['markdown'],
  enabledByDefault: true,
};

// B — packaged perishables (dairy, chilled, frozen): batch-tracked, rotated FEFO, and BLOCKED past their
// use-by at the till. Short return window with approval (a spoiled-on-arrival claim).
const PERISHABLE_PACKAGED: CategoryPolicyRules = {
  traceability: 'batch',
  quantityMode: 'each',
  valuation: 'retail_mrp',
  shelfLife: { perishable: true, blockSaleAfterExpiry: true, nearExpiryAlertDays: 3 },
  returns: { returnable: true, windowDays: 1, approvalRequired: true },
  approvals: ['markdown'],
  controlledSale: {},
  enabledByDefault: true,
};

// C — gold / jewellery: an OPTIONAL controlled vertical, OFF until switched on. Every piece is serial/tag
// identified, sold as a unit with its net weight reconciled (catch-weight), and valued at a rate per gram
// the manager must approve to override. KYC and the piece's serial are captured at the till; PAN above the
// statutory cash threshold is layered by the till as a per-sale control. Not returnable — an exchange /
// old-gold workflow (approval-gated) is the route. Making/wastage/stone charges are product attributes.
const GOLD_JEWELLERY: CategoryPolicyRules = {
  traceability: 'serial',
  quantityMode: 'catch_weight',
  valuation: 'rate_per_unit_weight',
  shelfLife: { perishable: false, blockSaleAfterExpiry: false },
  returns: { returnable: false },
  controlledSale: { requires: ['kyc', 'serial_capture'] },
  approvals: ['rate_override', 'price_override', 'exchange'],
  enabledByDefault: false,
};

// D — OTC pharmacy-lite: a CONFIGURABLE category, OFF by default, for over-the-counter medicines only.
// Batch, manufacturer, mfg/expiry are captured; rotated FEFO; near-expiry alerted; and — the hard one —
// a unit past its expiry cannot be sold. Controlled return / destruction, so returns need approval. This
// is NOT a licensed-pharmacy system: prescription items use `PRESCRIPTION_BLOCKED`.
const OTC_PHARMA_LITE: CategoryPolicyRules = {
  traceability: 'batch',
  quantityMode: 'each',
  valuation: 'retail_mrp',
  shelfLife: { perishable: true, blockSaleAfterExpiry: true, nearExpiryAlertDays: 30 },
  returns: { returnable: true, windowDays: 7, approvalRequired: true },
  controlledSale: {},
  approvals: ['return'],
  enabledByDefault: false,
};

// D — prescription / Schedule-H·H1·X / narcotics: BLOCKED from sale in a general hypermarket. Selling
// these lawfully needs a registered pharmacist, prescription capture and pharmacy licensing — a separate,
// separately-approved regulated-pharmacy extension. Until then the answer at the till is "no".
const PRESCRIPTION_BLOCKED: CategoryPolicyRules = {
  traceability: 'batch',
  quantityMode: 'each',
  valuation: 'retail_mrp',
  shelfLife: { perishable: true, blockSaleAfterExpiry: true, nearExpiryAlertDays: 30 },
  returns: { returnable: false },
  controlledSale: { blocked: true, requires: ['prescription'] },
  approvals: [],
  enabledByDefault: false,
};

// E — cosmetics: batch/lot with a use-before date, blocked past it. Testers are non-sale stock (a product
// attribute). Return-restricted for hygiene reasons: a return is allowed only with approval.
const COSMETICS: CategoryPolicyRules = {
  traceability: 'batch',
  quantityMode: 'each',
  valuation: 'retail_mrp',
  shelfLife: { perishable: true, blockSaleAfterExpiry: true, nearExpiryAlertDays: 30 },
  returns: { returnable: true, windowDays: 7, approvalRequired: true },
  controlledSale: {},
  approvals: ['return'],
  enabledByDefault: true,
};

// F — electronics / appliances: every unit carries a serial / IMEI that must be recorded at the till;
// warranty, installation and bundled accessories are product attributes. Return / replacement eligibility
// is approval-gated within a window.
const ELECTRONICS: CategoryPolicyRules = {
  traceability: 'serial',
  quantityMode: 'each',
  valuation: 'retail_mrp',
  shelfLife: { perishable: false, blockSaleAfterExpiry: false },
  returns: { returnable: true, windowDays: 7, approvalRequired: true },
  controlledSale: { requires: ['serial_capture'] },
  approvals: ['exchange'],
  enabledByDefault: true,
};

// G — apparel / footwear: size/colour/style is a variant matrix (product attributes and barcodes); a
// generous exchange window; markdowns for season-end are approval-gated.
const APPAREL_FOOTWEAR: CategoryPolicyRules = {
  traceability: 'none',
  quantityMode: 'each',
  valuation: 'retail_mrp',
  shelfLife: { perishable: false, blockSaleAfterExpiry: false },
  returns: { returnable: true, windowDays: 15 },
  controlledSale: {},
  approvals: ['markdown', 'exchange'],
  enabledByDefault: true,
};

const PRESETS: Readonly<Record<CategoryKind, CategoryPolicyRules>> = {
  grocery_fmcg: GROCERY_FMCG,
  fresh_produce: FRESH_PRODUCE,
  perishable_packaged: PERISHABLE_PACKAGED,
  gold_jewellery: GOLD_JEWELLERY,
  otc_pharma_lite: OTC_PHARMA_LITE,
  prescription_blocked: PRESCRIPTION_BLOCKED,
  cosmetics: COSMETICS,
  electronics: ELECTRONICS,
  apparel_footwear: APPAREL_FOOTWEAR,
};

/** Every category kind this module ships a preset for. */
export const CATEGORY_KINDS: readonly CategoryKind[] = Object.keys(PRESETS) as CategoryKind[];

/**
 * The default rules for a kind of merchandise — a starting point the store dates and overrides, not a law.
 * Returns a fresh object each call so a caller can safely spread-and-tweak before saving.
 */
export function presetFor(kind: CategoryKind): CategoryPolicyRules {
  return structuredClone(PRESETS[kind]);
}

/**
 * Wrap a preset in an effective-dated `CategoryPolicy` for a specific category, so it drops straight into
 * `resolvePolicy`. `effectiveFrom` is when the store adopts it (a `YYYY-MM-DD` date).
 */
export function presetPolicy(categoryId: string, kind: CategoryKind, effectiveFrom: string): CategoryPolicy {
  return { categoryId, history: [{ effectiveFrom, value: presetFor(kind) }] };
}
