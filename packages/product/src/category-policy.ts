// Category-policy engine (M03 category management — owner continuation directive, 12 Aug 2026).
//
// A hypermarket is not one shop. A milk carton, a ring of gold, a strip of paracetamol and a phone
// obey different rules for how each unit is traced, how it is valued, whether it may be sold at all,
// how it is returned, and who must approve a price. The owner's directive is explicit: those rules are
// **effective-dated CONFIGURATION, not code**. A category's behaviour must be describable as data the
// owner can change, dated, without a programmer — and a rule that changes (a new return window, a raised
// making-charge cap, a category switched on) must be historised, never overwritten, so a decision made
// last month can still be explained.
//
// This module gives every category a `CategoryPolicy`: a dated history of `CategoryPolicyRules`. The
// resolver `resolvePolicy(history, onDate)` returns the rules in force on a date — the SAME shape as the
// product master's `mrpOn` (P-02, one way to read a dated value). The decision helpers are pure and
// deterministic: they take the resolved rules plus a small context and return a structured verdict with
// plain-English reasons a cashier or manager can act on. They never look at a clock or the network.
//
// What this engine deliberately does NOT do:
//   • It does not duplicate the till's age gate — `checkRestrictedSale` (packages/restricted-sales) owns
//     the age-verification mechanics. This policy declares the CONFIGURATION (minimum age, KYC/PAN, a
//     hard block) that such a gate consumes.
//   • It does not enable a controlled vertical on its own. A category whose rules carry
//     `enabledByDefault: false` (gold, pharmacy-lite) is refused for sale until the store's own
//     configuration passes `categoryEnabled: true` — the owner's "off until switched on" rule, enforced.
//   • It commits nothing. Every function here is a pure decision; the caller commits.

import type { EffectiveValue } from './product';

/** How tightly each unit in the category is traced (drives batch/serial capture at receiving and sale). */
export type TraceabilityLevel =
  | 'none' // fast-moving grocery: no per-unit identity
  | 'batch' // food, medicine, cosmetics: a lot/expiry is captured
  | 'serial'; // electronics, jewellery: every unit has its own identity (IMEI, tag)

/** How a sale line's quantity behaves. */
export type QuantityMode =
  | 'each' // discrete units
  | 'weighed' // priced by weight read from a scale (fresh produce, deli)
  | 'catch_weight'; // sold as a unit but the exact weight varies and is reconciled (a whole fish, a gold ring)

/** How the line's value is derived. */
export type ValuationMethod =
  | 'retail_mrp' // price from the MRP/price list (most grocery)
  | 'rate_per_unit_weight' // rate × net weight (gold per gram, loose produce per kg)
  | 'weighted_average_cost' // valued at moving-average cost (inventory valuation)
  | 'cost_plus_markup'; // cost plus a configured margin

/** Shelf-life behaviour for the category. */
export interface ShelfLifePolicy {
  /** The category's stock perishes and must be rotated (FEFO). */
  readonly perishable: boolean;
  /** A unit past its use-by may NOT be sold — enforced at the till (food, medicine, cosmetics). */
  readonly blockSaleAfterExpiry: boolean;
  /** Days before expiry that near-expiry alerts begin (0 or absent = no alert). */
  readonly nearExpiryAlertDays?: number;
}

/** Return behaviour for the category. */
export interface ReturnPolicy {
  /** May a sold item be returned at all? (Some categories — cut jewellery, opened cosmetics — may not.) */
  readonly returnable: boolean;
  /** Days after the sale within which a return is accepted. Absent = no time limit. */
  readonly windowDays?: number;
  /** A return in this category always needs a named human approval, regardless of the window. */
  readonly approvalRequired?: boolean;
}

/** A control the till must satisfy before a line in this category may be sold. */
export type ControlledSaleControl =
  | 'age' // confirm the customer's age (tobacco, liquor)
  | 'kyc' // customer identity on file (high-value gold)
  | 'pan' // PAN captured (cash sales above the statutory threshold)
  | 'prescription' // a valid prescription (NOT in default hypermarket scope — see `blocked`)
  | 'serial_capture'; // the specific serial/IMEI/tag sold must be recorded

/** Controlled-sale configuration. */
export interface ControlledSalePolicy {
  /** The category is entirely blocked from sale here (e.g. prescription/Schedule-H drugs in a hypermarket). */
  readonly blocked?: boolean;
  /** Minimum age in whole years, where age-restricted. */
  readonly minimumAge?: number;
  /** Controls the till must satisfy before the line commits. */
  readonly requires?: readonly ControlledSaleControl[];
}

/** An action in this category that needs a named human approval before it commits (P-05 / hard rule #5). */
export type ApprovalAction =
  | 'price_override'
  | 'rate_override' // e.g. overriding the day's gold rate per gram
  | 'discount'
  | 'return'
  | 'markdown'
  | 'exchange';

/** The complete, effective-dated rule set for a category. */
export interface CategoryPolicyRules {
  readonly traceability: TraceabilityLevel;
  readonly quantityMode: QuantityMode;
  readonly valuation: ValuationMethod;
  readonly shelfLife: ShelfLifePolicy;
  readonly returns: ReturnPolicy;
  readonly controlledSale: ControlledSalePolicy;
  /** Actions that require approval in this category. */
  readonly approvals: readonly ApprovalAction[];
  /**
   * A controlled vertical (gold, pharmacy-lite) ships OFF: it will not sell until the store's own
   * configuration explicitly enables it (and, for such verticals, CA/legal sign-off is obtained). A
   * general grocery category ships `true`.
   */
  readonly enabledByDefault: boolean;
}

/** A category's dated policy history — newest last. Nothing is overwritten; a change is a new entry. */
export interface CategoryPolicy {
  readonly categoryId: string;
  readonly history: readonly EffectiveValue<CategoryPolicyRules>[];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export class InvalidCategoryPolicy extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidCategoryPolicy';
  }
}

export class NoPolicyInForceError extends Error {
  constructor(
    public readonly categoryId: string,
    public readonly onDate: string,
  ) {
    super(`No category policy is in force for "${categoryId}" on ${onDate} — every sellable category needs one`);
    this.name = 'NoPolicyInForceError';
  }
}

function assertDate(label: string, value: string): void {
  if (!ISO_DATE.test(value) || Number.isNaN(Date.parse(value))) {
    throw new InvalidCategoryPolicy(`${label} must be a date like 2026-08-01, but reads "${value}"`);
  }
}

/**
 * The rules in force on a date — filter to entries effective on or before `onDate`, take the latest.
 * Mirrors the product master's `mrpOn`: same dated-value semantics, one way to read history. Returns
 * `undefined` when no entry has taken effect yet (a category configured to start next month). Pure.
 */
export function resolvePolicy(
  history: readonly EffectiveValue<CategoryPolicyRules>[],
  onDate: string,
): CategoryPolicyRules | undefined {
  assertDate('onDate', onDate);
  for (const entry of history) assertDate('a policy entry effectiveFrom', entry.effectiveFrom);
  const applicable = history
    .filter((entry) => entry.effectiveFrom <= onDate)
    .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  return applicable[applicable.length - 1]?.value;
}

/** Like `resolvePolicy`, but throws `NoPolicyInForceError` — for callers that must have a policy. */
export function requirePolicy(policy: CategoryPolicy, onDate: string): CategoryPolicyRules {
  const rules = resolvePolicy(policy.history, onDate);
  if (rules === undefined) throw new NoPolicyInForceError(policy.categoryId, onDate);
  return rules;
}

// --- sale decision -----------------------------------------------------------------------------------

export type SaleRefusalReason =
  | 'category_blocked' // the category may not be sold here at all (e.g. prescription drugs)
  | 'category_not_enabled' // a controlled vertical the store has not switched on
  | 'expired' // a perishable unit past its use-by, where the category blocks that
  | 'age_not_confirmed'
  | 'underage'
  | 'kyc_required'
  | 'pan_required'
  | 'serial_not_captured';

export interface SaleContext {
  /** Has the store enabled this (controlled) category? Grocery categories are `enabledByDefault: true`. */
  readonly categoryEnabled?: boolean;
  /** The unit being sold is past its use-by (from batch/expiry data). */
  readonly expired?: boolean;
  /** The customer's age is confirmed at the till. */
  readonly ageConfirmed?: boolean;
  /** The confirmed age in whole years, where an ID gave one. */
  readonly ageYears?: number;
  /** Customer KYC is on file. */
  readonly kycOnFile?: boolean;
  /** The customer's PAN is captured. */
  readonly panOnFile?: boolean;
  /** The specific serial/IMEI/tag has been recorded on the line. */
  readonly serialCaptured?: boolean;
}

export interface SaleRefusal {
  readonly reason: SaleRefusalReason;
  readonly detail: string;
}

export interface CategorySaleDecision {
  readonly allowed: boolean;
  readonly refusals: readonly SaleRefusal[];
}

/**
 * May a line in this category be sold, given its resolved rules and the till context? Every failing
 * condition is named at once (a cashier fixes the basket in one pass), each with a plain-English reason.
 * `allowed` is true only when nothing refuses. Pure — the age mechanics still live in the restricted-sale
 * gate; this enforces the category's *configuration*. `categoryEnabled` defaults to the rule's
 * `enabledByDefault`, so a grocery line sells with no context while a controlled vertical stays off.
 */
export function categorySaleDecision(rules: CategoryPolicyRules, ctx: SaleContext = {}): CategorySaleDecision {
  const refusals: SaleRefusal[] = [];

  if (rules.controlledSale.blocked === true) {
    refusals.push({ reason: 'category_blocked', detail: 'this category may not be sold here — it is blocked by policy (for example a prescription or Schedule-H medicine in a general hypermarket)' });
    // A blocked category cannot be rescued by any context — stop here.
    return { allowed: false, refusals };
  }

  const enabled = ctx.categoryEnabled ?? rules.enabledByDefault;
  if (!enabled) {
    refusals.push({ reason: 'category_not_enabled', detail: 'this is a controlled category the store has not switched on yet — enable it in category settings (with the required sign-off) before selling' });
  }

  if (rules.shelfLife.blockSaleAfterExpiry && ctx.expired === true) {
    refusals.push({ reason: 'expired', detail: 'this unit is past its use-by date and cannot be sold — remove it from the basket and quarantine the stock' });
  }

  const requires = rules.controlledSale.requires ?? [];
  if (requires.includes('age')) {
    const minAge = rules.controlledSale.minimumAge ?? 18;
    if (ctx.ageConfirmed !== true) {
      refusals.push({ reason: 'age_not_confirmed', detail: `this category is age-restricted — confirm the customer is ${minAge} or over before selling` });
    } else if (ctx.ageYears !== undefined && ctx.ageYears < minAge) {
      refusals.push({ reason: 'underage', detail: `the customer is ${ctx.ageYears}, below the minimum age of ${minAge} for this category` });
    }
  }
  if (requires.includes('kyc') && ctx.kycOnFile !== true) {
    refusals.push({ reason: 'kyc_required', detail: 'this sale needs the customer’s identity (KYC) on file before it can complete' });
  }
  if (requires.includes('pan') && ctx.panOnFile !== true) {
    refusals.push({ reason: 'pan_required', detail: 'this sale needs the customer’s PAN captured (a cash sale above the statutory threshold)' });
  }
  if (requires.includes('serial_capture') && ctx.serialCaptured !== true) {
    refusals.push({ reason: 'serial_not_captured', detail: 'record the specific serial number / IMEI / tag of the unit being sold before completing' });
  }

  return { allowed: refusals.length === 0, refusals };
}

// --- return decision ---------------------------------------------------------------------------------

export type ReturnRefusalReason = 'not_returnable' | 'outside_window';

export interface CategoryReturnDecision {
  readonly allowed: boolean;
  readonly approvalRequired: boolean;
  readonly reason?: ReturnRefusalReason;
  readonly detail: string;
}

/**
 * May a sold item in this category be returned `daysSinceSale` days after the sale? Applies the
 * category's returnable flag and window, and reports whether a named approval is required. Pure.
 */
export function categoryReturnDecision(
  rules: CategoryPolicyRules,
  daysSinceSale: number,
): CategoryReturnDecision {
  const { returns } = rules;
  const approvalRequired = returns.approvalRequired === true;
  if (!returns.returnable) {
    return { allowed: false, approvalRequired, reason: 'not_returnable', detail: 'items in this category cannot be returned once sold' };
  }
  if (returns.windowDays !== undefined && daysSinceSale > returns.windowDays) {
    return { allowed: false, approvalRequired, reason: 'outside_window', detail: `the ${returns.windowDays}-day return window has passed (this is day ${daysSinceSale})` };
  }
  return {
    allowed: true,
    approvalRequired,
    detail: approvalRequired ? 'return is within policy but needs a supervisor’s approval' : 'return is within policy',
  };
}

/** Does an action need a named human approval in this category? (P-05 — humans commit critical actions.) */
export function needsApproval(rules: CategoryPolicyRules, action: ApprovalAction): boolean {
  return rules.approvals.includes(action);
}

/** A one-line, owner-readable summary of what a category's rules mean in plain English. */
export function describePolicy(rules: CategoryPolicyRules): string {
  const parts: string[] = [];
  parts.push(
    rules.traceability === 'serial' ? 'each unit tracked individually'
      : rules.traceability === 'batch' ? 'tracked by batch/expiry'
      : 'no per-unit tracking',
  );
  parts.push(
    rules.quantityMode === 'weighed' ? 'sold by weight'
      : rules.quantityMode === 'catch_weight' ? 'sold as a unit with a reconciled weight'
      : 'sold in units',
  );
  if (rules.shelfLife.perishable) parts.push(rules.shelfLife.blockSaleAfterExpiry ? 'perishable, no sale past use-by' : 'perishable');
  if (rules.controlledSale.blocked === true) parts.push('BLOCKED from sale here');
  else if (!rules.enabledByDefault) parts.push('controlled — off until switched on');
  if ((rules.controlledSale.requires ?? []).length > 0) parts.push(`needs ${(rules.controlledSale.requires ?? []).join(' + ')} at the till`);
  parts.push(rules.returns.returnable ? (rules.returns.windowDays !== undefined ? `returnable within ${rules.returns.windowDays} days` : 'returnable') : 'not returnable');
  return parts.join('; ');
}
