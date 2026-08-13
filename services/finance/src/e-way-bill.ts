// API-09 GST e-way bill (A23, CGST Rules 2017 Rule 138), on the tested `packages/e-way-bill` engine.
// Before goods move — a delivery, a branch transfer, a supplier return — an e-way bill is required above
// the route threshold (inter-State ₹50k, intra-TN ₹1L). Three read/preview steps plus a sandbox generate:
//
//   • `POST /v1/finance/e-way-bill/eligibility` — is one required for this movement?
//   • `POST /v1/finance/e-way-bill/validity`    — how long is a bill valid for a given road distance?
//   • `POST /v1/finance/e-way-bill/sandbox/generate` — run the whole build → generate → apply loop through
//     the deterministic sandbox portal (no live credentials); its number is SANDBOX-derived and never
//     valid to travel with real goods.
//
// Stateless over the tested engine (the services-run-on-their-tested-engine guardrail). Gated on the same
// GST-portal permissions as e-invoicing — the same operator function — `finance.einvoice.read` to preview,
// `finance.einvoice.generate` to run the sandbox. Writes nothing (idempotent).

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  assessEwayBillRequirement, buildEwayBillRequest, ewayBillValidity,
  sandboxEwbProvider, generateViaProvider, InvalidEwayBillInput,
  type SupplyRoute, type EwayBillRequest, type SandboxEwbOptions,
} from '../../../packages/e-way-bill/src/index';

const ROUTES: readonly SupplyRoute[] = ['intra_state', 'inter_state'];
const FORCE: readonly NonNullable<SandboxEwbOptions['forceOutcome']>[] = ['generated', 'unknown', 'rejected'];
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

export function eWayBillRoutes(): readonly Route[] {
  return [
    {
      api: 'API-09', method: 'POST', path: '/v1/finance/e-way-bill/eligibility',
      permission: 'finance.einvoice.read', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!Number.isInteger(b['consignmentValueMinor']) || !ROUTES.includes(b['supplyRoute'] as SupplyRoute)) {
          throw apiError(400, { code: 'ewb_eligibility_needs_value_and_route', whatHappened: 'E-way-bill eligibility needs consignmentValueMinor (integer) and supplyRoute (intra_state/inter_state).', wasItSaved: 'not_saved', nextSafeAction: 'Send the consignment value and whether the movement is intra- or inter-State.' });
        }
        return { status: 200, body: assessEwayBillRequirement({
          consignmentValueMinor: b['consignmentValueMinor'] as number,
          supplyRoute: b['supplyRoute'] as SupplyRoute,
          ...(typeof b['exemptGoods'] === 'boolean' ? { exemptGoods: b['exemptGoods'] } : {}),
        }) };
      },
    },
    {
      api: 'API-09', method: 'POST', path: '/v1/finance/e-way-bill/validity',
      permission: 'finance.einvoice.read', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (typeof b['distanceKm'] !== 'number' || typeof b['generatedOn'] !== 'string') {
          throw apiError(400, { code: 'ewb_validity_needs_distance_and_date', whatHappened: 'E-way-bill validity needs distanceKm (number) and generatedOn (YYYY-MM-DD).', wasItSaved: 'not_saved', nextSafeAction: 'Send the road distance in km and the generation date.' });
        }
        try {
          return { status: 200, body: ewayBillValidity({
            distanceKm: b['distanceKm'] as number,
            generatedOn: b['generatedOn'] as string,
            ...(typeof b['overDimensional'] === 'boolean' ? { overDimensional: b['overDimensional'] } : {}),
          }) };
        } catch (err) {
          if (err instanceof InvalidEwayBillInput) throw apiError(400, { code: 'ewb_validity_invalid', whatHappened: err.message, wasItSaved: 'not_saved', nextSafeAction: 'Correct the distance and date and try again.' });
          throw err;
        }
      },
    },
    {
      api: 'API-09', method: 'POST', path: '/v1/finance/e-way-bill/sandbox/generate',
      permission: 'finance.einvoice.generate', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const r = b['request'];
        if (typeof b['movementId'] !== 'string' || !isObj(r) || !Number.isInteger(r['consignmentValueMinor']) || !ROUTES.includes(r['supplyRoute'] as SupplyRoute)) {
          throw apiError(400, { code: 'ewb_sandbox_needs_movement_and_request', whatHappened: 'The sandbox generate needs movementId and a request carrying at least consignmentValueMinor and supplyRoute.', wasItSaved: 'not_saved', nextSafeAction: 'Send the movement id and the e-way-bill request fields.' });
        }
        const force = b['force'];
        if (force !== undefined && !FORCE.includes(force as NonNullable<SandboxEwbOptions['forceOutcome']>)) {
          throw apiError(400, { code: 'ewb_sandbox_bad_force', whatHappened: `force must be one of: ${FORCE.join(', ')}.`, wasItSaved: 'not_saved', nextSafeAction: 'Omit force for the natural outcome, or send a valid value.' });
        }
        const eligibility = assessEwayBillRequirement({
          consignmentValueMinor: r['consignmentValueMinor'] as number,
          supplyRoute: r['supplyRoute'] as SupplyRoute,
          ...(typeof r['exemptGoods'] === 'boolean' ? { exemptGoods: r['exemptGoods'] } : {}),
        });
        if (!eligibility.required) {
          return { status: 200, body: { sandbox: true, eligibility, required: false } };
        }
        const build = buildEwayBillRequest({ request: r as unknown as Omit<EwayBillRequest, 'financialYear'>, eligibility });
        if (build.outcome === 'invalid_request' || build.request === undefined) {
          throw apiError(422, { code: 'ewb_invalid_request', whatHappened: build.detail, wasItSaved: 'not_saved', nextSafeAction: 'Fix the named fields and try again — a malformed request must not be sent to the portal.' });
        }
        const distanceKm = typeof b['distanceKm'] === 'number' ? (b['distanceKm'] as number) : undefined;
        const provider = sandboxEwbProvider({
          ...(force !== undefined ? { forceOutcome: force as NonNullable<SandboxEwbOptions['forceOutcome']> } : {}),
          ...(distanceKm !== undefined ? { distanceKm } : {}),
        });
        const outcome = await generateViaProvider({ movementId: b['movementId'], request: build.request, provider });
        const validity = ewayBillValidity({ distanceKm: distanceKm ?? 100, generatedOn: build.request.documentDate });
        return { status: 200, body: { sandbox: true, eligibility, ...outcome, validity } };
      },
    },
  ];
}
