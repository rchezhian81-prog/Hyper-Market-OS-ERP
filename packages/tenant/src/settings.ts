// Per-tenant settings (ADR-0003) — the choose-able configuration each tenant sets
// at onboarding: trading-day cut-off, base currency, languages, default tax,
// delivery radius, and so on. Every setting has a stable key, a human label and a
// sensible DEFAULT; a tenant overrides only what it wants. Backed by the versioned
// config engine (packages/config), keyed per tenant — so every change is audited
// and reversible, and one tenant's settings never touch another's.

import type { ConfigStore } from '../../config/src/config';

/** A single choose-able setting: its key, a human label, and a default value. */
export interface TenantSetting<T> {
  readonly key: string;
  readonly label: string;
  readonly defaultValue: T;
}

/** The catalogue of tenant settings (grows as modules land). */
export const SETTINGS = {
  TRADING_DAY_CUTOFF: {
    key: 'trading_day.cutoff',
    label: 'Trading-day cut-off (HH:MM)',
    defaultValue: '00:00',
  } as TenantSetting<string>,
  BASE_CURRENCY: {
    key: 'locale.currency',
    label: 'Base currency (ISO 4217)',
    defaultValue: 'INR',
  } as TenantSetting<string>,
  LANGUAGES: {
    key: 'locale.languages',
    label: 'Languages offered',
    defaultValue: ['en', 'ta'] as readonly string[],
  } as TenantSetting<readonly string[]>,
  DEFAULT_TAX_BPS: {
    key: 'tax.default_bps',
    label: 'Default GST rate (basis points)',
    defaultValue: 0,
  } as TenantSetting<number>,
  DELIVERY_RADIUS_KM: {
    key: 'delivery.radius_km',
    label: 'Delivery serviceability radius (km)',
    defaultValue: 0,
  } as TenantSetting<number>,
  /**
   * The age the till asks about on a flagged item (OB-03: SRE is 18). It is a
   * setting because the number differs by state and by country — a tenant
   * elsewhere changes this, not our code.
   */
  AGE_RESTRICTED_MINIMUM_AGE: {
    key: 'pos.age_restricted.minimum_age',
    label: 'Minimum age for age-restricted items (years)',
    defaultValue: 18,
  } as TenantSetting<number>,
  /**
   * Whether a licence restricts the HOURS certain items may be sold in. Off for
   * SRE (OB-03); a tenant under a licence-hours rule turns it on and sets the
   * window on the product's restriction (M12-FR-04).
   */
  LICENCE_HOURS_ENABLED: {
    key: 'pos.licence_hours.enabled',
    label: 'Restrict certain items to licensed selling hours',
    defaultValue: false,
  } as TenantSetting<boolean>,
  /**
   * The in-store production departments this tenant actually operates
   * (OB-04 / AVR-12). Empty by default: the roadmap's rule is that a module is
   * never built or enabled for a department the store does not have (§2.2).
   */
  PRODUCTION_DEPARTMENTS: {
    key: 'production.departments',
    label: 'In-store production departments operated',
    defaultValue: [] as readonly string[],
  } as TenantSetting<readonly string[]>,
};

/**
 * Typed, defaulted, per-tenant settings backed by the versioned config engine.
 * `get` returns the tenant's chosen value, or the setting's default if unset;
 * `set` records a new version (audited, reversible). Keyed per tenant, so tenants
 * are isolated.
 */
export class TenantSettings {
  constructor(private readonly store: ConfigStore<unknown>) {}

  private scopedKey(tenantId: string, setting: TenantSetting<unknown>): string {
    return `tenant:${tenantId}:${setting.key}`;
  }

  set<T>(
    tenantId: string,
    setting: TenantSetting<T>,
    value: T,
    author: string,
    reason: string,
    effectiveAt: string,
  ): void {
    this.store.set(this.scopedKey(tenantId, setting), value, author, reason, effectiveAt);
  }

  get<T>(tenantId: string, setting: TenantSetting<T>): T {
    const current = this.store.current(this.scopedKey(tenantId, setting));
    // A stored value is returned even if falsy (0, "", []); only an unset key defaults.
    return current === undefined ? setting.defaultValue : (current.value as T);
  }
}
