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

export interface SupportAccessRequest {
  readonly accessId: string;
  readonly tenantId: string;
  readonly engineerId: string;
  readonly approvedBy?: string;
  readonly reason: string;
  readonly grantedAt: string;
  readonly minutes: number;
}

export type SupportRefusal =
  | 'no_reason_given' | 'not_approved' | 'approved_by_the_engineer' | 'longer_than_policy';

export interface SupportGrant {
  readonly ok: boolean;
  readonly expiresAt?: string;
  readonly refusedBecause?: SupportRefusal;
  readonly detail: string;
}

const NOT_A_REASON = /^(support|investigation|debugging|checking|as requested|ticket)\.?$/i;

export function grantSupportAccess(
  request: SupportAccessRequest,
  /** Per-tenant maximum. Default 4 hours (OC-25). */
  maxMinutes = 240,
): SupportGrant {
  if (request.reason.trim().length < 15 || NOT_A_REASON.test(request.reason.trim())) {
    return {
      ok: false, refusedBecause: 'no_reason_given',
      detail: `"${request.reason}" does not say what is being looked at or why. In six months this line is the only record of what somebody saw in a customer's live data`,
    };
  }
  if (request.approvedBy === undefined) {
    return { ok: false, refusedBecause: 'not_approved', detail: 'support access into live tenant data needs a second person (SEC-11)' };
  }
  if (request.approvedBy === request.engineerId) {
    return {
      ok: false, refusedBecause: 'approved_by_the_engineer',
      detail: `${request.engineerId} approved their own access to ${request.tenantId}'s live data`,
    };
  }
  if (request.minutes > maxMinutes) {
    return {
      ok: false, refusedBecause: 'longer_than_policy',
      detail: `${request.minutes} minutes exceeds the ${maxMinutes}-minute limit. Access that outlives the problem becomes access nobody remembers granting`,
    };
  }
  return {
    ok: true,
    expiresAt: new Date(Date.parse(request.grantedAt) + request.minutes * 60_000).toISOString(),
    detail: `${request.engineerId} may see ${request.tenantId} for ${request.minutes} minutes, approved by ${request.approvedBy}: ${request.reason}`,
  };
}

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
        const request = ctx.body as SupportAccessRequest;
        const grant = grantSupportAccess(request);
        if (!grant.ok) {
          throw apiError(422, {
            code: grant.refusedBecause!,
            whatHappened: grant.detail,
            wasItSaved: 'not_saved',
            nextSafeAction: 'No access was granted. Give a real reason, a second approver, and a duration within policy.',
          });
        }
        await deps.recordSupportAccess(request, grant.expiresAt!);
        return { status: 201, body: { expiresAt: grant.expiresAt, detail: grant.detail } };
      },
    },
  ];
}
