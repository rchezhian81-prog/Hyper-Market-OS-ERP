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
  /**
   * The order a picker collects the shop's zones in (M04-FR-02 / D05).
   *
   * **Empty by default, and deliberately so.** Which zones a shop has, how far apart they are and
   * how long chilled goods may stand out of temperature are questions about a particular licensed
   * premises. A default here would be this codebase deciding a food-safety matter on behalf of
   * every tenant, and the wrong guess is silent: the pick route looks perfectly sensible and the
   * milk is simply warm by the time it reaches the crate.
   *
   * Unset, the picker's list is sequenced by shelf position alone and every screen **says so**.
   * SRE's own answer is `['ambient', 'secure', 'chilled', 'frozen']` (OB-07, 6 Aug 2026).
   */
  PICK_ZONE_ORDER: {
    key: 'picking.zone_order',
    label: 'Order a picker collects the shop’s zones in',
    defaultValue: [] as readonly string[],
  } as TenantSetting<readonly string[]>,
  /**
   * How long a shelf count stays worth acting on (M04-FR-03 / OB-08: SRE is 120 minutes).
   *
   * A shelf quantity is an observation, not a fact — it was true when somebody looked, and the shop
   * keeps selling. Past this window a facing raises **no** refill task rather than sending somebody
   * on an old reading, because enough wasted walks and the whole list stops being believed.
   *
   * **The conservative direction here is SHORT**, which is why a default is safe where the pick
   * zone order's was not: a window that is too short judges more counts stale and therefore raises
   * *fewer* tasks. A tenant lengthening it is the one making a choice, and they make it knowingly.
   */
  SHELF_COUNT_STALE_AFTER_MINUTES: {
    key: 'merchandising.shelf_count_stale_after_minutes',
    label: 'How long a shelf count stays worth acting on (minutes)',
    defaultValue: 120,
  } as TenantSetting<number>,
  /**
   * How empty a facing must be before it is worth a trip (M04-FR-03 / OB-08: SRE is half).
   *
   * In basis points of the facing's capacity. Refilling at 90% wastes the staff's day; refilling at
   * 0% means the customer already found the gap. A facing at **exactly** this level is treated as
   * properly filled — the task starts below it.
   */
  SHELF_REFILL_AT_BP: {
    key: 'merchandising.shelf_refill_at_bp',
    label: 'How empty a facing must be before it is worth refilling (basis points)',
    defaultValue: 5_000,
  } as TenantSetting<number>,
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
