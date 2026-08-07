// The operating policy the cloud derives from a tenant's durable settings and hands to the store box
// (M01-FR-02). The store edge dates every trading day from `pack.policies.tradingDayCutoff`
// (edge/store-edge packCutoff → calendar tradingDate); until now that value was never populated from
// the tenant's chosen cut-off, so every box, screen and report fell back to "00:00". This reads the
// durable setting so the tenant's configured cut-off actually drives trading-day dating.
//
// It returns the settings-DERIVED slice of the box's policy only — the store-specific fields
// (storeId, thresholds, warehouse) belong to the box/provisioning, not to a tenant setting, and are
// merged in by whoever assembles the delivered pack. Keeping this slice separate is what lets the
// tenant layer stay unaware of the edge's full PackPolicies shape.

import type { SetupStatus } from './setup';
import { SETTINGS } from './settings';

export interface TenantStorePolicy {
  /** Where the trading day ends, "HH:MM" local (M01-FR-02). Drives daily close and the GST day. */
  readonly tradingDayCutoff: string;
}

/** Read the settings-derived store policy from a tenant's setup status (defaults where unset). */
export function storePolicyFrom(status: SetupStatus): TenantStorePolicy {
  const cutoff = status.items.find((i) => i.key === SETTINGS.TRADING_DAY_CUTOFF.key)?.value;
  return {
    tradingDayCutoff: typeof cutoff === 'string' ? cutoff : SETTINGS.TRADING_DAY_CUTOFF.defaultValue,
  };
}
