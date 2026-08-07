import { describe, it, expect } from 'vitest';
import {
  neutralBranding,
  validateBranding,
  resolveBrand,
  applyTerminology,
  contrastRatioHundredths,
  PROTECTED_TERMS,
  type TenantBranding,
} from '../../packages/platform/src/branding';

// M36-FR-02 acceptance: "two tenants show visibly different branding and receipt templates
// from a single codebase and deployment — no fork."

const SRE: TenantBranding = {
  tenantId: 't-sre',
  productName: 'SRE Hyper',
  legalName: 'SRE Hyper Market Pvt Ltd',
  logoRef: 'assets/sre-logo.svg',
  faviconRef: 'assets/sre-favicon.png',
  colours: { primary: '#1a4d2e', onPrimary: '#ffffff' },
  terminology: { branch: 'store' },
  templateSetId: 'tpl-sre',
  supportEmail: 'help@sre.example',
  supportPhone: '+91 44 0000 0000',
};

const KUMAR: TenantBranding = {
  tenantId: 't-kumar',
  productName: 'Kumar Stores',
  legalName: 'Kumar Retail LLP',
  logoRef: 'assets/kumar-logo.svg',
  colours: { primary: '#5b2333', onPrimary: '#ffffff' },
  terminology: { branch: 'showroom' },
  templateSetId: 'tpl-kumar',
};

describe('two tenants, one deployment, visibly different brands (M36-FR-02)', () => {
  it('renders each tenant\'s own brand from the same code', () => {
    const sre = resolveBrand({ tenantId: 't-sre', branding: SRE });
    const kumar = resolveBrand({ tenantId: 't-kumar', branding: KUMAR });

    expect(sre.productName).toBe('SRE Hyper');
    expect(kumar.productName).toBe('Kumar Stores');
    expect(sre.colours.primary).not.toBe(kumar.colours.primary);
    expect(sre.templateSetId).not.toBe(kumar.templateSetId);
  });

  it('falls back to NEUTRAL when a tenant has set nothing', () => {
    const brand = resolveBrand({ tenantId: 't-new' });
    expect(brand.productName).toBe('Retail OS');
    expect(brand.logoRef).toBe('builtin:neutral-mark');
    expect(brand.fromTenant).toEqual([]);
    expect(brand.detail).toContain("never another tenant's");
  });

  it('IGNORES branding belonging to another tenant rather than applying it', () => {
    // The failure this prevents: a loosely-keyed cache, and a retailer invoicing under a
    // competitor's mark.
    const brand = resolveBrand({ tenantId: 't-sre', branding: KUMAR });
    expect(brand.productName).toBe('Retail OS');
    expect(brand.detail).toContain('was IGNORED');
  });

  it('fills only the gaps a tenant left', () => {
    const brand = resolveBrand({
      tenantId: 't-partial',
      branding: { tenantId: 't-partial', productName: 'Partial Mart' },
    });
    expect(brand.productName).toBe('Partial Mart');
    expect(brand.logoRef).toBe('builtin:neutral-mark');
    expect(brand.fromTenant).toEqual(['productName']);
  });

  it('hands out a FRESH neutral object each time, so nothing can mutate a shared default', () => {
    const a = neutralBranding();
    const b = neutralBranding();
    expect(a).not.toBe(b);
    expect(a.colours).not.toBe(b.colours);
  });
});

describe('branding is validated before it is published', () => {
  it('accepts a well-formed, readable brand', () => {
    const result = validateBranding({ branding: SRE, tenantId: 't-sre' });
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('BLOCKS a colour pair a cashier could not read at 8pm', () => {
    const result = validateBranding({
      branding: { ...SRE, colours: { primary: '#cccccc', onPrimary: '#ffffff' } },
      tenantId: 't-sre',
    });
    expect(result.valid).toBe(false);
    expect(result.issues[0]?.kind).toBe('low_contrast');
    expect(result.issues[0]?.detail).toContain('support call every day for a year');
  });

  it('BLOCKS renaming a word that carries a legal meaning', () => {
    const result = validateBranding({
      branding: { ...SRE, terminology: { 'tax invoice': 'bill' } },
      tenantId: 't-sre',
    });
    expect(result.issues[0]?.kind).toBe('protected_term');
    expect(result.issues[0]?.detail).toContain('is not a tax invoice');
  });

  it('protects the whole statutory vocabulary, case-insensitively', () => {
    for (const term of ['GST', 'Credit Note', 'HSN', 'MRP']) {
      const result = validateBranding({
        branding: { ...SRE, terminology: { [term]: 'thing' } }, tenantId: 't-sre',
      });
      expect(result.valid).toBe(false);
    }
    expect(PROTECTED_TERMS).toContain('tax invoice');
  });

  it('blocks branding aimed at the wrong tenant', () => {
    const result = validateBranding({ branding: KUMAR, tenantId: 't-sre' });
    expect(result.issues[0]?.kind).toBe('wrong_tenant');
    expect(result.issues[0]?.detail).toContain("must never reach another's paperwork");
  });

  it('blocks a malformed colour and an empty rename', () => {
    expect(validateBranding({
      branding: { ...SRE, colours: { primary: 'green', onPrimary: '#ffffff' } }, tenantId: 't-sre',
    }).issues.some((i) => i.kind === 'invalid_colour')).toBe(true);

    expect(validateBranding({
      branding: { ...SRE, terminology: { branch: '  ' } }, tenantId: 't-sre',
    }).issues[0]?.kind).toBe('empty_value');
  });

  it('measures contrast the way WCAG does', () => {
    expect(contrastRatioHundredths('#000000', '#ffffff')).toBe(2_100);
    expect(contrastRatioHundredths('#ffffff', '#ffffff')).toBe(100);
    expect(contrastRatioHundredths('not-a-colour', '#ffffff')).toBeUndefined();
  });
});

describe('terminology is substituted, except where the law names the word', () => {
  it('swaps a tenant\'s own word, preserving case', () => {
    expect(applyTerminology({ phrase: 'Branch closing time', terminology: { branch: 'showroom' } }))
      .toBe('Showroom closing time');
    expect(applyTerminology({ phrase: 'the branch is open', terminology: { branch: 'showroom' } }))
      .toBe('the showroom is open');
  });

  it('matches whole words only', () => {
    expect(applyTerminology({ phrase: 'branching logic', terminology: { branch: 'showroom' } }))
      .toBe('branching logic');
  });

  it('NEVER substitutes a protected term, even if one got into the map', () => {
    // Validation blocks it at publish time; this blocks it again at render time, because
    // the two paths are separated by a database and a year.
    expect(applyTerminology({ phrase: 'Tax invoice enclosed', terminology: { 'tax invoice': 'bill' } }))
      .toBe('Tax invoice enclosed');
  });

  it('leaves the phrase alone when a tenant set no terminology', () => {
    expect(applyTerminology({ phrase: 'Branch closing time' })).toBe('Branch closing time');
  });
});
