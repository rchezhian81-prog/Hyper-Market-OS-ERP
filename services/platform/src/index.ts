// API-11 Platform — feature flags, jobs, devices, support access, audit, backup/health.
//
// Two things here are worth more than the rest of the surface.
//
// **Health distinguishes "I am running" from "I can do my job."** A health check that returns OK
// because the process is alive is the check that stays green while the database is unreachable and
// every request is failing — it is the most common lie in operations. So a dependency that cannot
// be reached makes the service `degraded`, and a dependency the *shop* needs makes it `unhealthy`,
// separately from whether this process is fine.
//
// **Support access is time-bound, reason-bound and recorded** (SEC-11, M33). Somebody looking at a
// tenant's live data needs a named reason, an expiry, and an entry that cannot be removed — and
// nobody grants it to themselves.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';

export type DependencyCriticality = 'shop_cannot_trade_without_it' | 'degrades_service' | 'background_only';

export interface DependencyProbe {
  readonly name: string;
  readonly criticality: DependencyCriticality;
  readonly reachable: boolean;
  readonly detail?: string;
}

/**
 * `unknown` is the one that was missing, and it is not a nicety.
 *
 * With no probes at all `assessHealth` returned **healthy** — "all 0 dependencies reachable" — for
 * the same reason an empty control-total list closed a month: `filter` over nothing finds nothing,
 * and nothing found reads as nothing wrong. A monitoring gap and a working system are not the same
 * state, and the whole point of this module is that the process being alive is not the same as it
 * working. Green-because-unchecked is that fault one level up.
 *
 * It is deliberately *not* `unhealthy`: that means the shop cannot trade and would trigger a
 * failover for what is a gap in monitoring. It is its own answer, the way `unknown` is its own
 * answer to "was it saved?" in the kernel.
 */
export type HealthState = 'healthy' | 'degraded' | 'unhealthy' | 'unknown';

export interface Health {
  readonly state: HealthState;
  /** True whenever the process is up — which is not the same as being able to serve (P-08). */
  readonly processAlive: true;
  readonly dependencies: readonly DependencyProbe[];
  readonly detail: string;
}

/**
 * A health verdict that cannot be green while the service is useless.
 *
 * `processAlive` is typed as the literal `true` and reported *separately* from `state`, so nothing
 * downstream can read "the process answered" as "the service works".
 */
export function assessHealth(probes: readonly DependencyProbe[]): Health {
  const down = probes.filter((p) => !p.reachable);
  const fatal = down.filter((p) => p.criticality === 'shop_cannot_trade_without_it');
  const degrading = down.filter((p) => p.criticality === 'degrades_service');

  const state: HealthState = probes.length === 0 ? 'unknown'
    : fatal.length > 0 ? 'unhealthy'
      : degrading.length > 0 ? 'degraded' : 'healthy';

  return {
    state,
    processAlive: true,
    dependencies: probes,
    detail: state === 'unknown'
      ? 'nothing was checked. This is not a healthy system, it is an unmonitored one — and the two look identical on a dashboard until the day they do not'
      : state === 'healthy'
        ? `all ${probes.length} dependencies reachable`
        : `${down.map((p) => p.name).join(', ')} unreachable — the process is running and that is not the same as working`,
  };
}

/**
 * **Support access has one implementation, and this is not it.**
 *
 * This service used to carry its own `grantSupportAccess`, and the two enforced *different rules*.
 * The one wired to the API was the weaker: its request had **no `scopes` field at all**, so access
 * granted over the wire could not express least privilege, could not be refused for holding a scope
 * support may never hold, and had no rule stopping an approval lengthening the requested window.
 *
 * A second, simpler copy of a security control is the one that drifts, and it drifts in the
 * direction of letting more through. So the request, the refusal and the grant all come from
 * `packages/platform-admin`, and this service maps HTTP to it and nothing else.
 */
export type { SupportAccessRequest, OwnerApproval, SupportSession } from '../../../packages/platform-admin/src/index';
import {
  grantSupportAccess,
  type SupportAccessRequest, type OwnerApproval, type SupportSession,
} from '../../../packages/platform-admin/src/index';
import {
  DurableTenantSettings, setupItem, storePolicyFrom,
  InvalidSetupAnswerError, SetupVersionConflictError,
} from '../../../packages/tenant/src/index';
import { InMemoryConfigVersionStore } from '../../../packages/persistence/src/config-store';
import type { TenantExport } from '../../../packages/platform/src/lifecycle';

/**
 * Durable per-tenant settings for the setup surface, backed by the in-memory version store.
 *
 * Used for the `store === undefined` dev stub and in tests. Production wires a
 * `SqlConfigVersionStore`-backed `DurableTenantSettings` (see `services/api/src/main.ts`), so a
 * store's setup answers are written to the append-only `config_versions` table and survive a
 * process restart.
 */
export function inMemorySettings(): DurableTenantSettings {
  return new DurableTenantSettings(new InMemoryConfigVersionStore());
}

export interface FeatureFlagChange {
  readonly key: string;
  readonly enabled: boolean;
  readonly changedBy: string;
  readonly changedAt: string;
}

/**
 * One event in a tenant-data export (M36-FR-03) — the domain event plus where it sits in the
 * ledger. A portable, self-describing record: no database internals, so a tenant (or an auditor)
 * can read and re-import it elsewhere (P-06 / OD-09).
 */
export interface ExportedEvent {
  readonly seq: number;
  readonly stream: string;
  readonly id: string;
  readonly type: string;
  readonly occurredAt: string;
  readonly idempotencyKey: string;
  readonly source: string;
  readonly version: number;
  readonly payload: unknown;
}

/**
 * A tenant's export: the certified manifest (M36-FR-03 `buildTenantExport` — complete or refused,
 * every domain checksummed) AND the data itself, grouped by domain. The manifest without the data
 * is a promise; the data without the manifest is a file nobody can verify. Both, or it is not an
 * export.
 */
export interface TenantExportBundle {
  readonly manifest: TenantExport;
  readonly data: Readonly<Record<string, readonly ExportedEvent[]>>;
}

/** An empty bundle for the dev stub and tests — no data means no manifest to certify. */
export function emptyExportBundle(): TenantExportBundle {
  return {
    manifest: {
      exportId: 'none', tenantId: '', requestedBy: '', at: '1970-01-01T00:00:00.000Z',
      outcome: 'no_manifest', complete: false, domains: [], missing: [],
      totalRows: 0, totalBytes: 0, detail: 'no export taken',
    },
    data: {},
  };
}

export interface PlatformDeps {
  readonly probe: () => Promise<readonly DependencyProbe[]> | readonly DependencyProbe[];
  readonly flags: (tenantId: string) => Promise<Readonly<Record<string, boolean>>> | Readonly<Record<string, boolean>>;
  readonly setFlag: (tenantId: string, change: FeatureFlagChange) => Promise<void> | void;
  readonly recordSupportAccess: (r: SupportAccessRequest, expiresAt: string) => Promise<void> | void;
  /** Durable per-tenant settings backing the self-service store-setup surface (M33-FR-01). */
  readonly settings: DurableTenantSettings;
  /**
   * A tenant's whole dataset, certified complete (M36-FR-03) — this tenant only, never another
   * (§35). `requestedBy` names who took it, so the export is attributable.
   */
  readonly exportTenant: (tenantId: string, requestedBy: string) => Promise<TenantExportBundle> | TenantExportBundle;
  readonly now: () => string;
}

export function platformRoutes(deps: PlatformDeps): readonly Route[] {
  return [
    {
      api: 'API-11', method: 'GET', path: '/v1/platform/health',
      permission: 'platform.health.read',
      handler: async () => {
        const health = assessHealth(await deps.probe());
        // A degraded service still answers 200 with its state in the body: an unreachable
        // dependency is not a reason for the health endpoint itself to become unreadable.
        return { status: health.state === 'unhealthy' ? 503 : 200, body: health };
      },
    },
    {
      api: 'API-11', method: 'GET', path: '/v1/platform/flags',
      permission: 'platform.flag.read',
      handler: async (ctx) => ({ status: 200, body: { flags: await deps.flags(ctx.tenantId) } }),
    },
    {
      api: 'API-11', method: 'PUT', path: '/v1/platform/flags/:key',
      permission: 'platform.flag.write', idempotent: true,
      handler: async (ctx) => {
        const body = (ctx.body ?? {}) as { enabled?: boolean };
        if (typeof body.enabled !== 'boolean') {
          throw apiError(400, {
            code: 'flag_state_not_given',
            whatHappened: 'A feature flag change must say true or false.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the intended state. Nothing changed.',
          });
        }
        const change: FeatureFlagChange = {
          key: ctx.params['key'] ?? '', enabled: body.enabled,
          changedBy: ctx.userId, changedAt: deps.now(),
        };
        await deps.setFlag(ctx.tenantId, change);
        return { status: 200, body: change };
      },
    },
    {
      api: 'API-11', method: 'POST', path: '/v1/platform/support-access',
      permission: 'platform.support.grant', idempotent: true,
      handler: async (ctx) => {
        // The ONE implementation. It refuses an empty scope list, a scope support may never
        // hold, an approval that tries to lengthen the requested window, and a self-approval —
        // none of which the copy that used to live in this file could even express.
        const body = ctx.body as { readonly request: SupportAccessRequest; readonly approval?: OwnerApproval };
        let session: SupportSession;
        try {
          session = grantSupportAccess(body.request, body.approval);
        } catch (e) {
          throw apiError(422, {
            code: 'support_access_refused',
            whatHappened: e instanceof Error ? e.message : 'support access was refused',
            wasItSaved: 'not_saved',
            nextSafeAction: 'No access was granted. State the scopes actually needed, give a real reason, and have somebody else approve it for a window inside policy.',
          });
        }
        await deps.recordSupportAccess(body.request, session.expiresAt);
        return { status: 201, body: session };
      },
    },
    {
      // The self-service store-setup surface (ADR-0003 §4 / M01-FR-02/03 / M33-FR-01): a tenant
      // reads its own setup state — what is answered, on a default, or still blocking.
      api: 'API-11', method: 'GET', path: '/v1/platform/setup',
      permission: 'platform.setup.read',
      handler: async (ctx) => ({ status: 200, body: await deps.settings.status(ctx.tenantId) }),
    },
    {
      // The settings-derived operating policy the store box needs (M01-FR-02): the tenant's configured
      // trading-day cut-off, read from the durable settings. This is what lets a box (and the pack
      // delivered to it) date the trading day from the tenant's chosen rule instead of a "00:00"
      // fallback — the store-specific fields (storeId, thresholds) are merged in by pack assembly.
      api: 'API-11', method: 'GET', path: '/v1/platform/store-pack/policies',
      permission: 'platform.setup.read',
      handler: async (ctx) => ({ status: 200, body: storePolicyFrom(await deps.settings.status(ctx.tenantId)) }),
    },
    {
      // A tenant answers one setup item. Validated first (an invalid value is refused, by name,
      // and nothing is stored), then written through the versioned config engine — audited,
      // reversible and isolated to this tenant.
      api: 'API-11', method: 'PUT', path: '/v1/platform/setup/:key',
      permission: 'platform.setup.write', idempotent: true,
      handler: async (ctx) => {
        const key = ctx.params['key'] ?? '';
        const item = setupItem(key);
        if (item === undefined) {
          throw apiError(404, {
            code: 'unknown_setting',
            whatHappened: `There is no store-setup setting called '${key}'.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Check the key against GET /v1/platform/setup. Nothing changed.',
          });
        }
        const body = (ctx.body ?? {}) as { value?: unknown; ifVersion?: number };
        if (body.value === undefined) {
          throw apiError(400, {
            code: 'setup_value_not_given',
            whatHappened: 'A setup answer must carry the value to store.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send { "value": … }. Nothing changed.',
          });
        }
        try {
          await deps.settings.apply(ctx.tenantId, item, body.value, ctx.userId, deps.now(), body.ifVersion);
        } catch (e) {
          if (e instanceof InvalidSetupAnswerError) {
            throw apiError(422, {
              code: 'setup_answer_refused',
              whatHappened: e.message,
              wasItSaved: 'not_saved',
              nextSafeAction: 'Send a value that fits the setting. Nothing was stored.',
            });
          }
          if (e instanceof SetupVersionConflictError) {
            // Somebody changed this setting since the screen loaded it. Refuse rather than clobber,
            // and hand back the current state so the screen can show the conflict and let a person choose.
            throw apiError(409, {
              code: 'setup_version_conflict',
              whatHappened: e.message,
              wasItSaved: 'not_saved',
              nextSafeAction: 'Reload the setting, look at the newer value, and re-enter your change if you still want it.',
            });
          }
          throw e;
        }
        return { status: 200, body: await deps.settings.status(ctx.tenantId) };
      },
    },
    {
      // A tenant exports its whole dataset (M36-FR-03) — a tenant owns and can export its data
      // (P-06 / OD-09). The export is strictly the CALLER's tenant, scoped at the store by
      // `ctx.tenantId`, so no request can reach across the isolation boundary (§35). It is a read:
      // nothing is removed, and audit evidence is exported, not deleted (hard rule #6).
      api: 'API-11', method: 'GET', path: '/v1/platform/export',
      permission: 'platform.tenant.export',
      handler: async (ctx) => {
        const bundle = await deps.exportTenant(ctx.tenantId, ctx.userId);
        // 200 even when the manifest reports the export incomplete: the truthful state of the
        // export IS the answer (M36-FR-03). A caller must be TOLD an export is not whole rather
        // than handed a smaller file and left to discover the gap months later.
        return { status: 200, body: { export: bundle.manifest, data: bundle.data } };
      },
    },
  ];
}
