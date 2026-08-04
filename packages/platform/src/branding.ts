// White-label branding and terminology (M36-FR-02 / P-06 / OD-09 / M31).
//
// **One codebase, one deployment, many brands.** The moment a customer gets their branding
// through a code fork, the product is finished: every fix has to be applied N times, one
// tenant's urgent patch waits behind another's release, and within eighteen months nobody
// can say which customer is running which version. Branding is configuration or it is a
// business model that does not work.
//
// Three things this module refuses, all of them learned from white-label products that went
// wrong in exactly these ways:
//
//   • **BRANDING NEVER CROSSES A TENANT.** A rebrand at one retailer cannot reach another's
//     paperwork. Obvious, and yet the classic failure is a shared "default" object that one
//     tenant mutates.
//   • **AN UNSET BRAND FALLS BACK TO NEUTRAL, NEVER TO ANOTHER TENANT'S.** A missing logo
//     shows a neutral mark. A missing logo that shows the *previous* tenant's logo is a
//     customer sending out invoices under a competitor's name.
//   • **TERMINOLOGY IS CONFIGURABLE, BUT NOT EVERY WORD IS.** A tenant may call a branch a
//     "store", a "unit" or a "showroom". A tenant may **not** rename "tax invoice", "GST" or
//     "credit note", because those words have legal meanings and a document that calls a tax
//     invoice something else is not a tax invoice.
//
// Contrast is checked because an unreadable brand is a support call, not a design opinion.
//
// Pure and deterministic: no I/O, no shared mutable default.

import { contrastRatio, parseHex } from '../../a11y/src/contrast';

export interface BrandColours {
  /** Hex, e.g. "#1a4d2e". */
  readonly primary: string;
  readonly onPrimary: string;
  readonly accent?: string;
}

export interface TenantBranding {
  readonly tenantId: string;
  /** What the product calls itself for this tenant. */
  readonly productName?: string;
  readonly legalName?: string;
  readonly logoRef?: string;
  readonly faviconRef?: string;
  readonly colours?: BrandColours;
  /** Per-tenant word substitutions, e.g. { branch: "showroom" }. */
  readonly terminology?: Readonly<Record<string, string>>;
  /** Document/receipt template set this tenant uses (M31). */
  readonly templateSetId?: string;
  readonly supportEmail?: string;
  readonly supportPhone?: string;
}

/** Every field a rendered brand needs, with no optionals left to guess at. */
export interface BrandDefaults {
  readonly productName: string;
  readonly legalName: string;
  readonly logoRef: string;
  readonly faviconRef: string;
  readonly colours: BrandColours;
  readonly templateSetId: string;
  readonly supportEmail: string;
  readonly supportPhone: string;
}

/** The neutral fallback. Deliberately a function so nothing can mutate a shared object. */
export function neutralBranding(): BrandDefaults {
  return {
    productName: 'Retail OS',
    legalName: 'Retail OS',
    logoRef: 'builtin:neutral-mark',
    faviconRef: 'builtin:neutral-favicon',
    colours: { primary: '#1f2933', onPrimary: '#ffffff' },
    templateSetId: 'builtin:default',
    supportEmail: 'support@retail-os.invalid',
    supportPhone: '',
  };
}

/**
 * Words that carry a legal meaning and **cannot** be renamed by a tenant.
 *
 * Letting a retailer relabel "tax invoice" as "bill" is not a customisation, it is producing
 * a document that is no longer the document the law names.
 */
export const PROTECTED_TERMS: readonly string[] = [
  'tax invoice',
  'gst',
  'cgst',
  'sgst',
  'igst',
  'hsn',
  'credit note',
  'debit note',
  'delivery challan',
  'mrp',
  'gstin',
];

export type BrandingIssueKind =
  | 'protected_term'
  | 'low_contrast'
  | 'invalid_colour'
  | 'empty_value'
  | 'wrong_tenant';

export interface BrandingIssue {
  readonly kind: BrandingIssueKind;
  readonly field: string;
  readonly detail: string;
  /** True when the branding cannot be published at all. */
  readonly blocking: boolean;
}

export interface BrandingValidation {
  readonly tenantId: string;
  readonly valid: boolean;
  readonly issues: readonly BrandingIssue[];
  readonly detail: string;
}

/**
 * Contrast ratio ×100 — 450 is 4.5:1.
 *
 * Delegates to `packages/a11y`, which owns the WCAG maths for the whole product. It used to be
 * computed here, privately, which meant the tenant-branding screen could disagree with every
 * other surface about whether a colour pair was readable — and it did: luminance was rounded to
 * hundredths before the ratio, so white on #777777 came out at 4.57:1 and PASSED, against a true
 * 4.48:1 that fails AA. Mid-grey on white is not an exotic edge case.
 */
export function contrastRatioHundredths(a: string, b: string): number | undefined {
  return contrastRatio(a, b);
}

/**
 * Validate a tenant's branding before it is published.
 *
 * Contrast is a **blocking** issue, not a note. A cashier who cannot read the total under the
 * fluorescent lights of a checkout at 8pm is a support call every day for a year, and by then
 * the brand colours have been signed off by somebody senior and are politically difficult to
 * change. Catch it at the point of setting it.
 */
export function validateBranding(input: {
  readonly branding: TenantBranding;
  readonly tenantId: string;
  /** Minimum contrast × 100. Default 450 = WCAG AA for normal text. */
  readonly minimumContrastHundredths?: number;
}): BrandingValidation {
  const minimum = input.minimumContrastHundredths ?? 450;
  const issues: BrandingIssue[] = [];
  const b = input.branding;

  if (b.tenantId !== input.tenantId) {
    issues.push({
      kind: 'wrong_tenant',
      field: 'tenantId',
      blocking: true,
      detail: `this branding belongs to ${b.tenantId} and is being applied to ${input.tenantId} — a rebrand at one retailer must never reach another's paperwork`,
    });
  }

  for (const [key, value] of Object.entries(b.terminology ?? {})) {
    if (value.trim() === '') {
      issues.push({ kind: 'empty_value', field: `terminology.${key}`, blocking: true, detail: `"${key}" was renamed to nothing` });
      continue;
    }
    if (PROTECTED_TERMS.includes(key.trim().toLowerCase())) {
      issues.push({
        kind: 'protected_term',
        field: `terminology.${key}`,
        blocking: true,
        detail: `"${key}" carries a legal meaning and cannot be renamed — a document that calls a tax invoice something else is not a tax invoice`,
      });
    }
  }

  if (b.colours !== undefined) {
    for (const [field, value] of [['primary', b.colours.primary], ['onPrimary', b.colours.onPrimary], ['accent', b.colours.accent]] as const) {
      if (value === undefined) continue;
      if (parseHex(value) === undefined) {
        issues.push({ kind: 'invalid_colour', field: `colours.${field}`, blocking: true, detail: `"${value}" is not a six-digit hex colour` });
      }
    }
    const ratio = contrastRatioHundredths(b.colours.primary, b.colours.onPrimary);
    if (ratio !== undefined && ratio < minimum) {
      issues.push({
        kind: 'low_contrast',
        field: 'colours',
        blocking: true,
        detail: `${(ratio / 100).toFixed(2)}:1 against a ${(minimum / 100).toFixed(1)}:1 minimum — a cashier who cannot read the total at 8pm is a support call every day for a year`,
      });
    }
  }

  const blocking = issues.filter((i) => i.blocking);

  return {
    tenantId: input.tenantId,
    valid: blocking.length === 0,
    issues,
    detail:
      blocking.length === 0
        ? issues.length === 0
          ? 'branding is publishable'
          : `publishable with ${issues.length} note(s)`
        : `${blocking.length} issue(s) block this branding: ${blocking.map((i) => i.field).join(', ')}`,
  };
}

export interface ResolvedBrand {
  readonly tenantId: string;
  readonly productName: string;
  readonly legalName: string;
  readonly logoRef: string;
  readonly faviconRef: string;
  readonly colours: BrandColours;
  readonly templateSetId: string;
  readonly supportEmail: string;
  readonly supportPhone: string;
  /** Which fields came from the tenant rather than the neutral fallback. */
  readonly fromTenant: readonly string[];
  readonly detail: string;
}

/**
 * Resolve the brand to render for a tenant.
 *
 * **A missing value falls back to neutral, never to another tenant's.** The failure this
 * prevents is not hypothetical: a shared cache keyed loosely, a tenant whose logo has not
 * loaded, and a retailer sending invoices out under a competitor's mark. The fallback is
 * built fresh each call from `neutralBranding()` so there is no shared object for anything to
 * leak through.
 */
export function resolveBrand(input: {
  readonly tenantId: string;
  readonly branding?: TenantBranding;
}): ResolvedBrand {
  const fallback = neutralBranding();
  // Branding belonging to another tenant is treated as ABSENT, not applied.
  const b = input.branding?.tenantId === input.tenantId ? input.branding : undefined;

  const fromTenant: string[] = [];
  const text = (field: keyof BrandDefaults & string, value: string | undefined): string => {
    if (value === undefined || value.trim() === '') return fallback[field] as string;
    fromTenant.push(field);
    return value;
  };

  let colours = fallback.colours;
  if (b?.colours !== undefined) {
    colours = b.colours;
    fromTenant.push('colours');
  }

  return {
    tenantId: input.tenantId,
    productName: text('productName', b?.productName),
    legalName: text('legalName', b?.legalName),
    logoRef: text('logoRef', b?.logoRef),
    faviconRef: text('faviconRef', b?.faviconRef),
    colours,
    templateSetId: text('templateSetId', b?.templateSetId),
    supportEmail: text('supportEmail', b?.supportEmail),
    supportPhone: text('supportPhone', b?.supportPhone),
    fromTenant: fromTenant.sort(),
    detail:
      b === undefined
        ? input.branding === undefined
          ? 'no branding set for this tenant — neutral defaults, never another tenant\'s'
          : `the branding offered belongs to ${input.branding.tenantId} and was IGNORED — neutral defaults used instead`
        : `${fromTenant.length} field(s) from the tenant, the rest neutral`,
  };
}

/**
 * Apply a tenant's terminology to a phrase.
 *
 * Whole-word, case-preserving, and **protected terms are never substituted** even if somebody
 * managed to get one into the map — validation blocks it at publish time and this blocks it
 * again at render time, because the two paths are separated by a database and a year.
 */
export function applyTerminology(input: {
  readonly phrase: string;
  readonly terminology?: Readonly<Record<string, string>>;
}): string {
  const map = input.terminology;
  if (map === undefined) return input.phrase;

  let out = input.phrase;
  for (const [from, to] of Object.entries(map)) {
    if (PROTECTED_TERMS.includes(from.trim().toLowerCase())) continue;
    const pattern = new RegExp(`\\b${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
    out = out.replace(pattern, (match) =>
      match[0] === match[0]?.toUpperCase() ? to.charAt(0).toUpperCase() + to.slice(1) : to,
    );
  }
  return out;
}
