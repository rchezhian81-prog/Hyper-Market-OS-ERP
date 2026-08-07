// Tenants and feature entitlements (ADR-0003; M33/D12/M36) — SRE Retail OS is a
// commercial, multi-tenant product, so each tenant (a retail business) CHOOSES
// which optional modules and departments it runs. Optional features are DEFAULT
// OFF — a tenant gets only what it enables (so the "conditional departments" like
// bakery/pharmacy/concession, AVR-12, become per-tenant toggles, not build-time
// choices). Core features are always on and are not listed here. Pure, in-memory.

export type TenantStatus = 'active' | 'suspended' | 'closed';

export interface Tenant {
  readonly id: string;
  readonly name: string;
  readonly status: TenantStatus;
}

/** A feature / module / department a tenant may optionally enable. */
export type FeatureKey = string;

/** The catalogue of optional features a tenant can choose (extend as modules land). */
export const OPTIONAL_FEATURES = [
  'dept.bakery',
  'dept.central_kitchen',
  'dept.deli',
  'dept.meat_fish',
  'dept.food_court',
  'dept.pharmacy',
  'dept.concession',
  'delivery',
  'customer_app',
  'loyalty',
  'b2b',
] as const;
export type OptionalFeature = (typeof OPTIONAL_FEATURES)[number];

export function isOptionalFeature(value: string): value is OptionalFeature {
  return (OPTIONAL_FEATURES as readonly string[]).includes(value);
}

/**
 * Per-tenant feature entitlements. Default DENY for optional features: a feature
 * is off for a tenant until explicitly enabled. Tenants are isolated — enabling a
 * feature for one tenant never affects another.
 */
export class Entitlements {
  private readonly byTenant = new Map<string, ReadonlySet<FeatureKey>>();

  /** Turn a feature on for a tenant. */
  enable(tenantId: string, feature: FeatureKey): void {
    const current = this.byTenant.get(tenantId);
    this.byTenant.set(tenantId, new Set([...(current ?? []), feature]));
  }

  /** Turn a feature off for a tenant (no-op if it was already off). */
  revoke(tenantId: string, feature: FeatureKey): void {
    const current = this.byTenant.get(tenantId);
    if (!current) return;
    this.byTenant.set(tenantId, new Set([...current].filter((f) => f !== feature)));
  }

  /** Whether a feature is enabled for a tenant (default false). */
  isEnabled(tenantId: string, feature: FeatureKey): boolean {
    return this.byTenant.get(tenantId)?.has(feature) ?? false;
  }

  /** The features currently enabled for a tenant. */
  enabled(tenantId: string): readonly FeatureKey[] {
    return [...(this.byTenant.get(tenantId) ?? [])];
  }
}
