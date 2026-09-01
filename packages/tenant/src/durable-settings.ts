// Durable tenant settings (M01-FR-03 / M33-FR-01 / ADR-0003 §4).
//
// The store-setup surface must survive a process restart. `TenantSettings` is backed by the
// in-memory `ConfigStore`; this reads and writes the SAME configuration through the durable,
// append-only `config_versions` store (packages/persistence), so a store's setup answers are still
// there after a redeploy. It applies the SAME validation and optimistic-concurrency rules as the
// in-memory path — they are the engine's rules (`validateSetupAnswer`, `SetupVersionConflictError`),
// not a second copy that could drift.

import type { ConfigVersionStore } from '../../persistence/src/config-store';
import {
  SETUP_CATALOGUE, assembleSetupStatus, setupItemStatus, validateSetupAnswer, SetupVersionConflictError,
  type SetupItem, type SetupStatus,
} from './setup';

export class DurableTenantSettings {
  constructor(
    private readonly store: ConfigVersionStore,
    private readonly catalogue: readonly SetupItem[] = SETUP_CATALOGUE,
  ) {}

  /**
   * The versioned config store behind these settings. Exposed read-only so the config-history / rollback
   * routes operate on the SAME append-only store the setup answers write to — a setting change and its
   * rollback share one history.
   */
  get configVersions(): ConfigVersionStore {
    return this.store;
  }

  /** The tenant's setup status, read from the durable store — defaults where a key is unset. */
  async status(tenantId: string): Promise<SetupStatus> {
    const items = await Promise.all(this.catalogue.map(async (item) => {
      const record = await this.store.current(tenantId, item.setting.key);
      return setupItemStatus(item, {
        answered: record !== undefined,
        value: record !== undefined ? record.value : item.setting.defaultValue,
        version: record?.version ?? 0,
        changedBy: record?.author,
        changedAt: record?.effectiveAt,
      });
    }));
    return assembleSetupStatus(items, this.catalogue);
  }

  /**
   * Record a tenant's answer durably. Validated first (invalid → refused, nothing stored), then the
   * optional version check (a stale save → `SetupVersionConflictError`), then appended as a new,
   * durable version — audited, reversible, and isolated to this tenant.
   */
  async apply(
    tenantId: string,
    item: SetupItem,
    value: unknown,
    author: string,
    effectiveAt: string,
    ifVersion?: number,
  ): Promise<void> {
    validateSetupAnswer(item, value);
    if (ifVersion !== undefined) {
      const current = await this.store.current(tenantId, item.setting.key);
      const actual = current?.version ?? 0;
      if (actual !== ifVersion) throw new SetupVersionConflictError(item.setting.key, ifVersion, actual);
    }
    await this.store.set(tenantId, item.setting.key, value, author, 'store setup', effectiveAt);
  }
}
