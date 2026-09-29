// API-04 Planogram compliance (M04-FR-03 · D02/D05) — the CONSUMER of the shelf-count producer.
//
// The blind-count producer (`shelf-count.ts`) records how many of an item are on a facing right now.
// This route reads those recorded counts and does the thing the whole exercise was for: compare the
// shelf with the plan and raise the right task —
//
//   • an EMPTY facing WITH stock in the stockroom → the most expensive out-of-stock there is (refill,
//     urgent), told apart from an empty facing with none in the building (a reorder, not a refill);
//   • an UNCOUNTED facing is not an empty one — it is reported `never_counted`, never as a breach and
//     never as compliant, and the compliance percentage is taken over the OBSERVED facings only, so a
//     figure nobody has earned is never quoted (P-08);
//   • a count too old to act on is `last_counted_too_long_ago`, against the tenant's freshness window.
//
// The engine is the tested `planogramCompliance` in `@sre/merchandising` (the
// `services-run-on-their-tested-engine` guardrail). This is a **pure read/compute**: it writes
// nothing. The plan itself — the planogram, the shelf map and the stockroom figures — is supplied by
// the caller (the ERP that holds it); only the OBSERVATIONS come from what the store has recorded.
// A persisted planogram/shelf-map store on the cloud is the named follow-on. Gated
// `planogram.compliance.read`.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  planogramCompliance, latestCounts, ShelfMap,
  type Planogram, type ShelfState, type ShelfCount,
} from '../../../packages/merchandising/src/index';

import {
  isStr, isObj, isInt, isLoc, isAssign, isBackstock, toLocations, toAssignments, shelfMapFor, noShelfMap, noPlanogram, inForcePlanogram, latestPlanograms,
  type RawLoc, type RawAssign, type StoredShelfMap, type StoredPlanogram,
} from './planograms';

export interface PlanogramComplianceDeps {
  /** Every shelf count recorded in a store — the observations the plan is judged against. */
  readonly counts: (tenantId: string, storeId: string) => Promise<readonly ShelfCount[]> | readonly ShelfCount[];
  /** The STORED shelf map and planograms (un-parks CH-02). Optional: without them only the plan-in-body path works. */
  readonly shelfMap?: (tenantId: string, storeId: string) => Promise<StoredShelfMap | undefined> | StoredShelfMap | undefined;
  readonly planograms?: (tenantId: string, storeId: string) => Promise<readonly StoredPlanogram[]> | readonly StoredPlanogram[];
  readonly now: () => string;
}

export function planogramComplianceRoutes(deps: PlanogramComplianceDeps): readonly Route[] {
  return [
    {
      // Compare the plan against what the store has actually counted, and raise the refill/reorder
      // tasks. Body: { planogram:{ planogramId, storeId, version, effectiveFrom, createdBy,
      // assignments[] }, locations[], backstock{}, assignedRole, refillAtBp?, staleAfterMinutes? }.
      // A pure compute — it writes nothing, but it is a POST because the plan is a body, not a query.
      api: 'API-04', method: 'POST', path: '/v1/merchandising/planogram-compliance',
      permission: 'planogram.compliance.read', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const backstock = b['backstock'] ?? {};
        if (!isBackstock(backstock) || !isStr(b['assignedRole'])) {
          throw apiError(400, {
            code: 'not_readable_as_a_compliance_request',
            whatHappened: 'A compliance run needs backstock{} and assignedRole, plus EITHER the plan in the body ({ planogram, locations }) OR a storeId whose published shelf map and planogram the store keeps.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the stockroom figures and the role; then either the plan and shelf map, or just the store. The counts come from what the store has recorded.',
          });
        }
        const refillAtBp = isInt(b['refillAtBp']) && (b['refillAtBp'] as number) >= 0 && (b['refillAtBp'] as number) <= 10_000 ? b['refillAtBp'] as number : undefined;
        const staleAfterMinutes = isInt(b['staleAfterMinutes']) && (b['staleAfterMinutes'] as number) > 0 ? b['staleAfterMinutes'] as number : 240;

        let planogram: Planogram;
        let map: ShelfMap;
        let storeId: string;
        let source: 'request_body' | 'stored';
        const p = b['planogram'];
        if (p !== undefined || b['locations'] !== undefined) {
          // The plan-in-body path (as before CH-02 was un-parked): the caller supplies plan AND shelf map.
          const locs = b['locations'];
          if (!isObj(p) || !isStr(p['planogramId']) || !isStr(p['storeId']) || !isInt(p['version'])
            || !isStr(p['effectiveFrom']) || !isStr(p['createdBy'])
            || !Array.isArray(p['assignments']) || !p['assignments'].every(isAssign)
            || !Array.isArray(locs) || !locs.every(isLoc)) {
            throw apiError(400, {
              code: 'not_readable_as_a_compliance_request',
              whatHappened: 'A compliance run with the plan in the body needs { planogram:{ planogramId, storeId, version, effectiveFrom, createdBy, assignments[] }, locations[] }.',
              wasItSaved: 'not_saved',
              nextSafeAction: 'Send the plan and the shelf map together, or omit both and name the store whose published plan should be used.',
            });
          }
          storeId = p['storeId'] as string;
          const assignments = toAssignments(storeId, p['assignments'] as RawAssign[]);
          // The map validates the plan as a whole — an assignment to a shelf the store has not mapped, a
          // facing with no capacity, or two primary homes for one product is a self-inconsistent plan,
          // not a shortage. That is a 422 (nothing was saved either way).
          map = shelfMapFor({ storeId, version: 0, locations: toLocations(storeId, locs as RawLoc[]), publishedBy: '', publishedAt: '' }, assignments);
          planogram = {
            planogramId: p['planogramId'] as string, storeId, version: p['version'] as number,
            effectiveFrom: p['effectiveFrom'] as string, assignments, createdBy: p['createdBy'] as string,
          };
          source = 'request_body';
        } else {
          // The STORED path (CH-02 un-parked): the plan in force — or the named plan's newest version — laid on
          // the store's published shelf map. A store with neither is told so, never handed an empty plan.
          if (!isStr(b['storeId'])) {
            throw apiError(400, {
              code: 'not_readable_as_a_compliance_request',
              whatHappened: 'Without a plan in the body, a compliance run needs the storeId whose published planogram and shelf map to use (and optionally planogramId).',
              wasItSaved: 'not_saved',
              nextSafeAction: 'Name the store, or send the plan and shelf map in the body.',
            });
          }
          storeId = b['storeId'] as string;
          const stored = deps.shelfMap === undefined ? undefined : await deps.shelfMap(ctx.tenantId, storeId);
          if (stored === undefined) noShelfMap(storeId);
          const all = deps.planograms === undefined ? [] : await deps.planograms(ctx.tenantId, storeId);
          const chosen = isStr(b['planogramId'])
            ? latestPlanograms(all).find((x) => x.planogramId === b['planogramId'])
            : inForcePlanogram(all, deps.now());
          if (chosen === undefined) noPlanogram(storeId);
          map = shelfMapFor(stored!, chosen!.assignments);
          planogram = chosen!;
          source = 'stored';
        }

        const asOf = deps.now();
        // The winning observation per facing comes from the tested engine (append-only, later-wins),
        // never re-derived here — the compliance run judges each against `asOf`/`staleAfterMinutes`.
        const { latest } = latestCounts(await deps.counts(ctx.tenantId, storeId), asOf, staleAfterMinutes);
        const shelfState: readonly ShelfState[] = latest.map((c) => ({
          productId: c.productId, locationId: c.locationId, onShelfMinor: c.countedMinor, observedAt: c.at,
        }));

        const result = planogramCompliance({
          planogram, map, shelfState, backstock: backstock as Record<string, number>,
          assignedRole: b['assignedRole'] as string, ...(refillAtBp !== undefined ? { refillAtBp } : {}),
          asOf, staleAfterMinutes,
        });
        return { status: 200, body: { ...result, storeId, asOf, staleAfterMinutes, planogramId: planogram.planogramId, planogramVersion: planogram.version, planSource: source } };
      },
    },
  ];
}
