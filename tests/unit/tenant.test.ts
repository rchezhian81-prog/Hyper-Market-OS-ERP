import { describe, it, expect } from 'vitest';
import {
  Entitlements,
  isOptionalFeature,
  OPTIONAL_FEATURES,
  type Tenant,
} from '../../packages/tenant/src/index';

// A commercial multi-tenant product: each tenant chooses its optional modules and
// departments (ADR-0003). Optional features are default-off and tenants are isolated.

describe('optional feature catalogue', () => {
  it('recognises optional features and rejects unknowns', () => {
    expect(isOptionalFeature('dept.pharmacy')).toBe(true);
    expect(isOptionalFeature('delivery')).toBe(true);
    expect(isOptionalFeature('dept.spaceport')).toBe(false);
    expect(OPTIONAL_FEATURES).toContain('dept.bakery');
  });
});

describe('per-tenant entitlements', () => {
  it('defaults every optional feature to OFF', () => {
    const ent = new Entitlements();
    expect(ent.isEnabled('sre', 'dept.pharmacy')).toBe(false);
    expect(ent.enabled('sre')).toEqual([]);
  });

  it('enables and revokes a feature for a tenant', () => {
    const ent = new Entitlements();
    ent.enable('sre', 'dept.bakery');
    expect(ent.isEnabled('sre', 'dept.bakery')).toBe(true);
    ent.revoke('sre', 'dept.bakery');
    expect(ent.isEnabled('sre', 'dept.bakery')).toBe(false);
  });

  it('keeps tenants isolated from one another', () => {
    const ent = new Entitlements();
    ent.enable('sre', 'delivery');
    // a different tenant does not inherit SRE's choices
    expect(ent.isEnabled('other-store', 'delivery')).toBe(false);
    ent.enable('other-store', 'dept.pharmacy');
    expect(ent.isEnabled('sre', 'dept.pharmacy')).toBe(false);
  });

  it('models the AVR-12 conditional departments as per-tenant toggles', () => {
    const ent = new Entitlements();
    // SRE runs a bakery but no pharmacy; another tenant is the reverse
    ent.enable('sre', 'dept.bakery');
    ent.enable('pharmacy-chain', 'dept.pharmacy');
    expect(ent.isEnabled('sre', 'dept.bakery')).toBe(true);
    expect(ent.isEnabled('sre', 'dept.pharmacy')).toBe(false);
    expect(ent.isEnabled('pharmacy-chain', 'dept.pharmacy')).toBe(true);
    expect(ent.enabled('sre')).toEqual(['dept.bakery']);
  });

  it('the Tenant shape carries a status', () => {
    const sre: Tenant = { id: 'sre', name: 'SRE Hyper Market', status: 'active' };
    expect(sre.status).toBe('active');
  });
});
