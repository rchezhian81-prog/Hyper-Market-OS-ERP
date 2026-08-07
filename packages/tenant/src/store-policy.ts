// The operating policy the cloud derives from a tenant's durable settings and hands to the store box
// (M01-FR-02 / M33-FR-01). The box, POS, receipt, finance and delivery all need tenant-chosen
// parameters — the trading-day cut-off, currency, languages, default tax, the age it asks about on a
// restricted item, whether licensed selling hours apply, the delivery radius, and the receipt paper.
// Until now those lived as scattered defaults; this reads them from the ONE durable source
// (`DurableTenantSettings` over the append-only config store) so a tenant configures them once and
// every surface reads the same answer.
//
// It returns the settings-DERIVED slice only — store-specific facts (storeId, thresholds, warehouse)
// belong to the box/provisioning and are merged in by whoever assembles the delivered pack. Keeping
// this slice separate is what lets the tenant layer stay unaware of the edge's full PackPolicies shape.

import type { SetupStatus } from './setup';
import { SETTINGS, type TenantSetting } from './settings';

export interface TenantStorePolicy {
  /** Where the trading day ends, "HH:MM" local (M01-FR-02). Drives daily close and the GST day. */
  readonly tradingDayCutoff: string;
  /** Base currency, ISO 4217 (M01-FR-02). */
  readonly baseCurrency: string;
  /** Languages the tills and app offer. */
  readonly languages: readonly string[];
  /** Default GST rate in basis points, applied until a category sets its own. */
  readonly defaultTaxBps: number;
  /** The age the till asks about on a flagged item (OB-03). */
  readonly ageRestrictedMinimumAge: number;
  /** Whether a licence restricts the hours certain items may be sold in (M12-FR-04). */
  readonly licenceHoursEnabled: boolean;
  /** Delivery serviceability radius, km. */
  readonly deliveryRadiusKm: number;
  /** The thermal paper the store's receipts print on (OC-15). */
  readonly receiptPaperFormat: string;
}

/**
 * The effective value of a setting from a tenant's setup status. `status.items[].value` is already
 * the answered-or-default value, so an unset key reads as its documented default; the fallback to
 * the setting's own default covers only a setting absent from the catalogue entirely.
 */
function valueOf<T>(status: SetupStatus, setting: TenantSetting<T>): T {
  const item = status.items.find((i) => i.key === setting.key);
  return (item?.value ?? setting.defaultValue) as T;
}

/** Read the settings-derived store policy from a tenant's setup status (defaults where unset). */
export function storePolicyFrom(status: SetupStatus): TenantStorePolicy {
  return {
    tradingDayCutoff: valueOf(status, SETTINGS.TRADING_DAY_CUTOFF),
    baseCurrency: valueOf(status, SETTINGS.BASE_CURRENCY),
    languages: valueOf(status, SETTINGS.LANGUAGES),
    defaultTaxBps: valueOf(status, SETTINGS.DEFAULT_TAX_BPS),
    ageRestrictedMinimumAge: valueOf(status, SETTINGS.AGE_RESTRICTED_MINIMUM_AGE),
    licenceHoursEnabled: valueOf(status, SETTINGS.LICENCE_HOURS_ENABLED),
    deliveryRadiusKm: valueOf(status, SETTINGS.DELIVERY_RADIUS_KM),
    receiptPaperFormat: valueOf(status, SETTINGS.RECEIPT_PAPER_FORMAT),
  };
}
