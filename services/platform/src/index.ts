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

export interface FeatureFlagChange {
  readonly key: string;
  readonly enabled: boolean;
  readonly changedBy: string;
  readonly changedAt: string;
}

export interface PlatformDeps {
  readonly probe: () => Promise<readonly DependencyProbe[]> | readonly DependencyProbe[];
  readonly flags: (tenantId: string) => Promise<Readonly<Record<string, boolean>>> | Readonly<Record<string, boolean>>;
  readonly setFlag: (tenantId: string, change: FeatureFlagChange) => Promise<void> | void;
  readonly recordSupportAccess: (r: SupportAccessRequest, expiresAt: string) => Promise<void> | void;
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
  ];
}
