// Substitution POLICY — eligibility (M19-FR-01, A04, hard rule #5 spirit).
//
// `amendments.ts` already answers the MONEY question of a substitution: once a swap is
// confirmed, a dearer substitute is capped at the original price and a cheaper one refunds
// the difference. This answers the question BEFORE that: given a customer's standing
// preference and their restrictions, MAY this substitute be offered at all — and if so, can
// the shop pick it on the customer's behalf, or must it ask first?
//
// The owner-approved policy has three customer preference modes and four restriction kinds:
//
//   • `no_substitution` — never swap; short-pick the line instead (the honest outcome).
//   • `best_match`      — the shop MAY pick the best matching substitute WITHIN the
//                         restrictions, on the customer's behalf (standing consent). The
//                         money is then capped so a swap is never a price increase.
//   • `contact_me`      — the shop must ASK the customer before swapping (A04): the decision
//                         goes back to `applySubstitution`, where silence is not consent.
//
// Restrictions (all safety- or preference-driven, checked regardless of preference so a
// controlled or unsafe swap is never even offered under `contact_me`):
//
//   • controlled item  — an age-/licence-restricted line (alcohol, tobacco, some pharma) is
//                         NEVER auto-substituted; the store cannot swap a restricted item on
//                         someone's behalf. Refused.
//   • allergen         — a substitute that introduces an allergen the customer avoids is
//                         refused; and where the substitute's allergen data is UNKNOWN and the
//                         customer avoids allergens, it is never auto-accepted — a person must
//                         confirm, because we cannot prove it is safe (P-04).
//   • blocked brand    — a substitute of a brand the customer refuses is refused.
//   • blocked category — a substitute in a category the customer refuses is refused.
//   • weight tolerance — for a weighed/measured line, a substitute whose net size deviates
//                         beyond the customer's tolerance is refused (a "1kg" order should not
//                         silently become 500g).
//
// Pure and deterministic — attributes are passed in, nothing is read or written here. The
// customer-facing message is English; the Tamil rendering is added with the notification
// slice (M19 B5). This engine decides eligibility only; the money is `applySubstitution`.

export type SubstitutionPreference = 'no_substitution' | 'best_match' | 'contact_me';

export interface ProductAttributes {
  readonly productId: string;
  readonly name: string;
  readonly brand?: string;
  readonly categoryId?: string;
  /** Net content in a comparable base unit (grams / ml / each-count), for the weight tolerance. */
  readonly sizeMinor?: number;
  /** Allergens PRESENT in the product, as normalised lowercase tokens (e.g. `['milk','nuts']`).
   *  `undefined` means the data is not known (which is treated as unsafe to auto-accept, not as "none"). */
  readonly allergens?: readonly string[];
  /** An age-/licence-restricted item (alcohol, tobacco, some pharma) — never auto-substituted. */
  readonly ageRestricted?: boolean;
}

export interface CustomerSubstitutionRules {
  readonly preference: SubstitutionPreference;
  /** Brands the customer will not accept as a substitute (normalised lowercase). */
  readonly blockedBrands?: readonly string[];
  /** Categories the customer will not accept a substitute from (category ids). */
  readonly blockedCategories?: readonly string[];
  /** Allergens the customer must avoid (normalised lowercase). */
  readonly avoidAllergens?: readonly string[];
  /** Max size deviation for a weighed/measured line, in basis points of the ordered size
   *  (e.g. 1000 = 10%). Omit for a countable line where size does not vary. */
  readonly weightToleranceBps?: number;
}

export interface SubstitutionCandidate {
  readonly lineId: string;
  readonly ordered: ProductAttributes;
  readonly substitute: ProductAttributes;
  readonly rules: CustomerSubstitutionRules;
}

export type SubstitutionEligibility = 'auto_accept' | 'needs_confirmation' | 'refused';

export type SubstitutionRefusalReason =
  | 'customer_declines_substitution'
  | 'controlled_item'
  | 'allergen_introduced'
  | 'brand_blocked'
  | 'category_blocked'
  | 'size_out_of_tolerance';

export interface SubstitutionPolicyDecision {
  readonly lineId: string;
  readonly eligibility: SubstitutionEligibility;
  /** Present only when refused, or as the reason a decision was downgraded to needs_confirmation. */
  readonly reason?: SubstitutionRefusalReason | 'allergen_data_unknown';
  readonly detail: string;
  /** Plain-English message for the customer (Tamil rendering added in the notification slice). */
  readonly tellTheCustomer: string;
}

const norm = (s: string | undefined): string => (s ?? '').trim().toLowerCase();
const normSet = (xs: readonly string[] | undefined): ReadonlySet<string> =>
  new Set((xs ?? []).map((x) => norm(x)).filter((x) => x !== ''));

/**
 * Decide whether a substitute may be offered for a short-picked line, and how.
 *
 * Order of checks: the safety- and consent-critical refusals FIRST (a controlled item, an
 * introduced allergen), so they hold under every preference — then the customer's explicit
 * "no substitution", then brand/category/size restrictions, and only then the preference
 * decides between the shop picking it (`best_match`) and asking first (`contact_me`).
 */
export function assessSubstitution(candidate: SubstitutionCandidate): SubstitutionPolicyDecision {
  const { lineId, ordered, substitute, rules } = candidate;
  const orderedName = ordered.name;
  const subName = substitute.name;

  const refused = (reason: SubstitutionRefusalReason, detail: string, tellTheCustomer: string): SubstitutionPolicyDecision =>
    ({ lineId, eligibility: 'refused', reason, detail, tellTheCustomer });

  // 1. Controlled item — never auto-substituted, and not offered on the customer's behalf.
  if (ordered.ageRestricted === true || substitute.ageRestricted === true) {
    return refused(
      'controlled_item',
      `${orderedName}: a restricted item cannot be substituted automatically`,
      `We could not supply ${orderedName}. As a restricted item we cannot swap it for you, so it has been left out and you have not been charged for it.`,
    );
  }

  // 2. Allergen introduced — a substitute carrying an allergen the customer avoids is refused.
  const avoid = normSet(rules.avoidAllergens);
  if (avoid.size > 0) {
    if (substitute.allergens !== undefined) {
      const clash = [...normSet(substitute.allergens)].filter((a) => avoid.has(a));
      if (clash.length > 0) {
        return refused(
          'allergen_introduced',
          `${subName}: introduces allergen(s) the customer avoids (${clash.join(', ')})`,
          `We could not supply ${orderedName}. The alternative contains ${clash.join(', ')}, which you asked us to avoid, so we have left it out rather than risk it. You have not been charged for it.`,
        );
      }
    }
    // else: allergen data unknown → handled below as a no-auto-accept downgrade (safety).
  }

  // 3. Customer's explicit standing choice to never substitute.
  if (rules.preference === 'no_substitution') {
    return refused(
      'customer_declines_substitution',
      `${orderedName}: the customer's preference is no substitution`,
      `We could not supply ${orderedName}. As you asked, we do not substitute, so it has been left out and you have not been charged for it.`,
    );
  }

  // 4. Blocked brand.
  if (normSet(rules.blockedBrands).has(norm(substitute.brand)) && norm(substitute.brand) !== '') {
    return refused(
      'brand_blocked',
      `${subName}: brand "${substitute.brand}" is on the customer's blocked list`,
      `We could not supply ${orderedName}. The alternative was a brand you asked us not to substitute, so it has been left out and you have not been charged for it.`,
    );
  }

  // 5. Blocked category.
  if (normSet(rules.blockedCategories).has(norm(substitute.categoryId)) && norm(substitute.categoryId) !== '') {
    return refused(
      'category_blocked',
      `${subName}: category "${substitute.categoryId}" is on the customer's blocked list`,
      `We could not supply ${orderedName}. The alternative was from a category you asked us not to substitute, so it has been left out and you have not been charged for it.`,
    );
  }

  // 6. Weight/size tolerance — a weighed line's substitute must be within tolerance.
  if (
    rules.weightToleranceBps !== undefined &&
    ordered.sizeMinor !== undefined && ordered.sizeMinor > 0 &&
    substitute.sizeMinor !== undefined
  ) {
    const deviationBps = Math.round((Math.abs(substitute.sizeMinor - ordered.sizeMinor) * 10000) / ordered.sizeMinor);
    if (deviationBps > rules.weightToleranceBps) {
      return refused(
        'size_out_of_tolerance',
        `${subName}: size ${substitute.sizeMinor} deviates ${(deviationBps / 100).toFixed(1)}% from ordered ${ordered.sizeMinor} (tolerance ${(rules.weightToleranceBps / 100).toFixed(1)}%)`,
        `We could not supply ${orderedName}. The nearest alternative was a different size than you ordered, so we have left it out rather than guess. You have not been charged for it.`,
      );
    }
  }

  // 7. Passed every restriction. If the customer's allergen data could not be verified, never
  //    auto-accept — a person must confirm it is safe (P-04) even under best_match.
  const allergenDataUnknown = avoid.size > 0 && substitute.allergens === undefined;
  if (rules.preference === 'best_match' && !allergenDataUnknown) {
    return {
      lineId,
      eligibility: 'auto_accept',
      detail: `${subName}: eligible as a best-match substitute for ${orderedName}`,
      tellTheCustomer: `We did not have ${orderedName}, so we picked ${subName} as the closest match, as you asked. You will not pay more than the original price.`,
    };
  }

  return {
    lineId,
    eligibility: 'needs_confirmation',
    ...(allergenDataUnknown ? { reason: 'allergen_data_unknown' as const } : {}),
    detail: allergenDataUnknown
      ? `${subName}: allergen data unknown — confirm with the customer before substituting`
      : `${subName}: the customer asked to be contacted before any substitution`,
    tellTheCustomer: `We did not have ${orderedName}. Can we substitute ${subName}? We will only swap it if you say yes, and you will not pay more than the original price.`,
  };
}
