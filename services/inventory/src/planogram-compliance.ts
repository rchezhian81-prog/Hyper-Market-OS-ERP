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
  planogramCompliance, latestCounts, ShelfMap, ShelfMappingError,
  type ShelfLocation, type ShelfAssignment, type Planogram, type ShelfState, type ShelfCount,
} from '../../../packages/merchandising/src/index';

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const ZONES = ['ambient', 'chilled', 'frozen', 'secure'] as const;

interface RawLoc { readonly locationId: string; readonly aisle: number; readonly rack: number; readonly bay: number; readonly shelf: number; readonly position: number; readonly zone?: string; readonly label?: string }
const isLoc = (v: unknown): v is RawLoc =>
  isObj(v) && isStr(v['locationId'])
  && isNum(v['aisle']) && isNum(v['rack']) && isNum(v['bay']) && isNum(v['shelf']) && isNum(v['position'])
  && (v['zone'] === undefined || (typeof v['zone'] === 'string' && (ZONES as readonly string[]).includes(v['zone'])))
  && (v['label'] === undefined || typeof v['label'] === 'string');

interface RawAssign { readonly productId: string; readonly locationId: string; readonly capacityMinor: number; readonly primary: boolean }
const isAssign = (v: unknown): v is RawAssign =>
  isObj(v) && isStr(v['productId']) && isStr(v['locationId']) && isNum(v['capacityMinor']) && typeof v['primary'] === 'boolean';

const isBackstock = (v: unknown): v is Record<string, number> =>
  isObj(v) && Object.values(v).every((n) => isInt(n) && (n as number) >= 0);

export interface PlanogramComplianceDeps {
  /** Every shelf count recorded in a store — the observations the plan is judged against. */
  readonly counts: (tenantId: string, storeId: string) => Promise<readonly ShelfCount[]> | readonly ShelfCount[];
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
        const p = b['planogram'];
        const locs = b['locations'];
        const backstock = b['backstock'] ?? {};
        if (!isObj(p) || !isStr(p['planogramId']) || !isStr(p['storeId']) || !isInt(p['version'])
          || !isStr(p['effectiveFrom']) || !isStr(p['createdBy'])
          || !Array.isArray(p['assignments']) || !p['assignments'].every(isAssign)
          || !Array.isArray(locs) || !locs.every(isLoc)
          || !isBackstock(backstock) || !isStr(b['assignedRole'])) {
          throw apiError(400, {
            code: 'not_readable_as_a_compliance_request',
            whatHappened: 'A compliance run needs { planogram:{ planogramId, storeId, version, effectiveFrom, createdBy, assignments[] }, locations[], backstock{}, assignedRole }.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the plan, the shelf map and the stockroom figures. The counts come from what the store has recorded.',
          });
        }
        const refillAtBp = isInt(b['refillAtBp']) && (b['refillAtBp'] as number) >= 0 && (b['refillAtBp'] as number) <= 10_000 ? b['refillAtBp'] as number : undefined;
        const staleAfterMinutes = isInt(b['staleAfterMinutes']) && (b['staleAfterMinutes'] as number) > 0 ? b['staleAfterMinutes'] as number : 240;
        const storeId = p['storeId'] as string;

        // Stamp the store onto every location and assignment so the caller sends it once; the map
        // filters to this store, so a stray cross-store row is dropped rather than trusted.
        const locations: readonly ShelfLocation[] = (locs as RawLoc[]).map((l) => ({
          storeId, locationId: l.locationId, aisle: l.aisle, rack: l.rack, bay: l.bay, shelf: l.shelf,
          position: l.position, ...(l.zone !== undefined ? { zone: l.zone as ShelfLocation['zone'] } : {}), ...(l.label !== undefined ? { label: l.label } : {}),
        }));
        const assignments: readonly ShelfAssignment[] = (p['assignments'] as RawAssign[]).map((a) => ({
          storeId, productId: a.productId, locationId: a.locationId, capacityMinor: a.capacityMinor, primary: a.primary,
        }));

        // The map validates the plan as a whole — an assignment to a shelf the store has not mapped, a
        // facing with no capacity, or two primary homes for one product is a self-inconsistent plan,
        // not a shortage. That is a 422 (nothing was saved either way).
        let map: ShelfMap;
        try {
          map = new ShelfMap(storeId, locations, assignments);
        } catch (err) {
          if (err instanceof ShelfMappingError) {
            throw apiError(422, {
              code: 'the_plan_is_inconsistent',
              whatHappened: err.message,
              wasItSaved: 'not_saved',
              nextSafeAction: 'Fix the shelf map or the planogram so every facing has a real shelf and one home, then run again.',
            });
          }
          throw err;
        }

        const asOf = deps.now();
        // The winning observation per facing comes from the tested engine (append-only, later-wins),
        // never re-derived here — the compliance run judges each against `asOf`/`staleAfterMinutes`.
        const { latest } = latestCounts(await deps.counts(ctx.tenantId, storeId), asOf, staleAfterMinutes);
        const shelfState: readonly ShelfState[] = latest.map((c) => ({
          productId: c.productId, locationId: c.locationId, onShelfMinor: c.countedMinor, observedAt: c.at,
        }));

        const planogram: Planogram = {
          planogramId: p['planogramId'] as string, storeId, version: p['version'] as number,
          effectiveFrom: p['effectiveFrom'] as string, assignments, createdBy: p['createdBy'] as string,
        };

        const result = planogramCompliance({
          planogram, map, shelfState, backstock: backstock as Record<string, number>,
          assignedRole: b['assignedRole'] as string, ...(refillAtBp !== undefined ? { refillAtBp } : {}),
          asOf, staleAfterMinutes,
        });
        return { status: 200, body: { ...result, storeId, asOf, staleAfterMinutes } };
      },
    },
  ];
}
