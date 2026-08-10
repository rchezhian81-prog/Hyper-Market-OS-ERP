// Statutory pre-packed-commodity declarations (roadmap v2.1 B4 — Legal Metrology / Packaged Commodities
// Rules, Rule 6). Independently of any department's own attribute list, EVERY pre-packed commodity a
// shop sells must carry a fixed set of declarations, and four of them gate whether the pack may go on
// sale at all: the net quantity, the month-and-year of manufacture/packing/import, a consumer-care
// contact for complaints, and the country of origin. A pack missing any of these is not sellable — its
// activation is BLOCKED until the gap is filled, rather than a non-compliant pack reaching the shelf.
//
// This is a harder gate than the per-tenant completeness worklist (which measures how close a record
// is to finished, per the tenant's own category rules): these four are a legal floor under every pack,
// so they are checked here as a distinct, always-on requirement. Pure and deterministic.

export interface PackDeclarations {
  /** The net quantity as declared, e.g. "500 g", "1 L", "6 U". */
  readonly netQuantity?: string;
  /** Month and year (YYYY-MM) or full date (YYYY-MM-DD) of manufacture / packing / import. */
  readonly manufactureOrPackDate?: string;
  /** Consumer-care details for complaints — a name with a phone or email. */
  readonly consumerCareContact?: string;
  /** Country of origin (e.g. "India"). */
  readonly countryOfOrigin?: string;
}

export interface PackDeclarationCheck {
  /** True only when every mandatory declaration is present and well-formed. */
  readonly sellable: boolean;
  /** Each mandatory declaration missing or malformed, named so it can be fixed. */
  readonly missing: readonly string[];
  readonly detail: string;
}

const blank = (s: unknown): boolean => typeof s !== 'string' || s.trim() === '';
const DATE = /^\d{4}-\d{2}(-\d{2})?$/;

/**
 * Check a pre-packed commodity's statutory declarations (B4). A pack is sellable only when all four
 * mandatory declarations are present and well-formed; otherwise activation is blocked and the missing
 * declarations are named.
 */
export function checkPackDeclarations(d: PackDeclarations): PackDeclarationCheck {
  const missing: string[] = [];

  if (blank(d.netQuantity)) missing.push('netQuantity (e.g. "500 g")');
  if (blank(d.manufactureOrPackDate)) missing.push('manufactureOrPackDate (month and year of manufacture/packing)');
  else if (!DATE.test(d.manufactureOrPackDate as string)) missing.push('manufactureOrPackDate (must be YYYY-MM or YYYY-MM-DD)');
  if (blank(d.consumerCareContact)) missing.push('consumerCareContact (a name with a phone or email for complaints)');
  if (blank(d.countryOfOrigin)) missing.push('countryOfOrigin');

  return {
    sellable: missing.length === 0,
    missing,
    detail: missing.length === 0
      ? 'the pack carries every mandatory declaration — it may be activated for sale'
      : `the pack may not be activated — ${missing.length} mandatory declaration(s) missing or malformed`,
  };
}
