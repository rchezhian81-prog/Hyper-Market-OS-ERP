// API-07 Serviceability configuration (M18-FR-01 / D08) — the per-tenant, effective-dated policy that says
// which addresses the store delivers to and on what terms (radius, delivery fee, free-delivery threshold,
// minimum order), made durable on the cloud. The product's HSN carried its own rate schedule; this carries
// the store's serviceability, and FROM WHEN. The rule is the tested `resolveServiceabilityPolicy`
// (@sre/storefront): it picks the period in force on a date and, until the owner configures real radii,
// falls back to the D08 default (10 km) — so the store is serviceable from day one and the owner sets his
// real numbers with a start date, no code change ("do not require my final production radii").
//
// Append-only: a change is a new period with a LATER effective date, never an overwrite (hard rule #2);
// a DIFFERENT policy on the SAME effective date is refused as ambiguous, an IDENTICAL re-send is a no-op.
// Setting is gated `delivery.serviceability.manage` (an owner/manager config decision); reads are
// `delivery.serviceability.read`.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  resolveServiceabilityPolicy,
  type ServiceabilityPeriod,
  type ServiceabilityPolicy,
} from '../../../packages/storefront/src/index';

export interface ServiceabilityConfigDeps {
  /** Append a serviceability period (idempotent on the caller's key). Append-only (hard rule #2). */
  readonly setPeriod: (tenantId: string, period: ServiceabilityPeriod, key: string) => Promise<void> | void;
  readonly schedule: (tenantId: string) => Promise<readonly ServiceabilityPeriod[]> | readonly ServiceabilityPeriod[];
}

const isDate = (s: unknown): s is string =>
  typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00.000Z`));
const isWholeNonNeg = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

const POLICY_FIELDS = ['radiusMetres', 'minimumOrderMinor', 'deliveryFeeMinor', 'freeDeliveryAboveMinor'] as const;

/** Read a policy body — every PRESENT field must be a whole, non-negative number; absent fields are omitted. */
function readPolicy(v: unknown): ServiceabilityPolicy | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const b = v as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const f of POLICY_FIELDS) {
    if (b[f] === undefined) continue;
    if (!isWholeNonNeg(b[f])) return undefined;
    out[f] = b[f] as number;
  }
  return out as ServiceabilityPolicy;
}

const samePolicy = (a: ServiceabilityPolicy, b: ServiceabilityPolicy): boolean =>
  POLICY_FIELDS.every((f) => (a as Record<string, unknown>)[f] === (b as Record<string, unknown>)[f]);

export function serviceabilityRoutes(deps: ServiceabilityConfigDeps): readonly Route[] {
  return [
    {
      // Set the serviceability policy effective from a date. Body: the policy (radius/fee/threshold/min).
      api: 'API-07', method: 'POST', path: '/v1/serviceability/periods/:effectiveFrom',
      permission: 'delivery.serviceability.manage', idempotent: true,
      handler: async (ctx) => {
        const effectiveFrom = (ctx.params['effectiveFrom'] ?? '').trim();
        const policy = readPolicy(ctx.body);
        if (!isDate(effectiveFrom) || policy === undefined) {
          throw apiError(400, {
            code: 'not_readable_as_a_serviceability_policy',
            whatHappened: 'Setting serviceability needs a valid YYYY-MM-DD effective date in the path and a policy whose fields (radiusMetres, minimumOrderMinor, deliveryFeeMinor, freeDeliveryAboveMinor) are each a whole, non-negative number.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send e.g. { "radiusMetres": 8000, "deliveryFeeMinor": 3000 } with the effective date in the URL.',
          });
        }
        // A policy already recorded for this exact date: a DIFFERENT one is a genuine ambiguity (an order that
        // day could be judged serviceable two ways) and is refused — a change is a NEW period on a LATER date.
        // An IDENTICAL re-send returns success WITHOUT appending, so the schedule never grows a duplicate date.
        const existing = (await deps.schedule(ctx.tenantId)).find((p) => p.effectiveFrom === effectiveFrom);
        if (existing !== undefined) {
          if (!samePolicy(existing.policy, policy)) {
            throw apiError(409, {
              code: 'serviceability_already_set_on_that_date',
              whatHappened: `A serviceability policy already takes effect on ${effectiveFrom}; a different policy cannot also start that day — an order then could be judged two ways.`,
              wasItSaved: 'not_saved',
              nextSafeAction: 'To change it, set the new policy from a LATER effective date. Nothing was changed.',
            });
          }
          return { status: 201, body: { period: existing } };
        }
        const period: ServiceabilityPeriod = { effectiveFrom, policy };
        await deps.setPeriod(ctx.tenantId, period, ctx.idempotencyKey ?? effectiveFrom);
        return { status: 201, body: { period } };
      },
    },
    {
      // Resolve the policy in force on a date (?on=YYYY-MM-DD). NEVER 404s — until the owner configures a
      // schedule, the D08 default (10 km) applies, so the store is serviceable from day one.
      api: 'API-07', method: 'GET', path: '/v1/serviceability',
      permission: 'delivery.serviceability.read',
      handler: async (ctx) => {
        const on = ctx.query['on'];
        if (!isDate(on)) {
          throw apiError(400, {
            code: 'not_readable_as_a_serviceability_query',
            whatHappened: 'Resolving serviceability needs the date as ?on=YYYY-MM-DD — the policy in force depends on when.',
            wasItSaved: 'unknown',
            nextSafeAction: 'Add ?on=2026-09-24 to the request.',
          });
        }
        // The tested engine resolves the period in force, or the D08 default. Set-time validation guarantees
        // stored periods are well-formed, so this cannot throw on a corrupt schedule in practice.
        const resolved = resolveServiceabilityPolicy({ schedule: await deps.schedule(ctx.tenantId), on });
        return { status: 200, body: resolved };
      },
    },
    {
      // The whole effective-dated schedule — the history a person configuring serviceability reviews.
      api: 'API-07', method: 'GET', path: '/v1/serviceability/periods',
      permission: 'delivery.serviceability.read',
      handler: async (ctx) => {
        const schedule = [...(await deps.schedule(ctx.tenantId))].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
        return { status: 200, body: { schedule, count: schedule.length } };
      },
    },
  ];
}
