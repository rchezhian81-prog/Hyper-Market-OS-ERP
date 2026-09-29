// M04-FR-02 / FR-03 — the shelf map and the planogram as things the cloud KEEPS (un-parks CH-02).
//
// Until now the compliance route worked only by taking the planogram AND the whole shelf map in the
// request body every time (CH-02 deferred the durable store). That is fine for one run and useless for a
// shop: the plan in force has to be the same plan for the merchandiser who published it, the handheld that
// walks the aisles and the manager who reads the gaps. So:
//
//   • the SHELF MAP (aisle / rack / bay / shelf / position per location) is published per store,
//     versioned, append-only — a change is a new version, never an edit;
//   • a PLANOGRAM is published per store and plan id, versioned the same way (M04-FR-03: "a planogram
//     change is versioned"), and is validated against the STORED shelf map by the same engine the compliance
//     run uses — an assignment to a shelf the store has not mapped, two primary homes for one product, a
//     facing with no capacity: refused, not stored;
//   • the plan IN FORCE for a store is the newest version of the plan whose effective date is the latest
//     one already reached — read by the compliance route when the caller sends no plan (`planogram-compliance.ts`).
//
// Merchandising publishes (`planogram.publish`); store staff read (`planogram.compliance.read`). Nothing here
// changes stock or tasks; it changes what the shop is measured against, which is why it is versioned.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import {
  ShelfMap, ShelfMappingError,
  type Planogram, type ShelfAssignment, type ShelfLocation,
} from '../../../packages/merchandising/src/index';

// ── Shared validators (the compliance route reads the same shapes) ───────────────────────────────────

export const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
export const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
export const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
export const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const ZONES = ['ambient', 'chilled', 'frozen', 'secure'] as const;

export interface RawLoc { readonly locationId: string; readonly aisle: number; readonly rack: number; readonly bay: number; readonly shelf: number; readonly position: number; readonly zone?: string; readonly label?: string }
export const isLoc = (v: unknown): v is RawLoc =>
  isObj(v) && isStr(v['locationId'])
  && isNum(v['aisle']) && isNum(v['rack']) && isNum(v['bay']) && isNum(v['shelf']) && isNum(v['position'])
  && (v['zone'] === undefined || (typeof v['zone'] === 'string' && (ZONES as readonly string[]).includes(v['zone'])))
  && (v['label'] === undefined || typeof v['label'] === 'string');

export interface RawAssign { readonly productId: string; readonly locationId: string; readonly capacityMinor: number; readonly primary: boolean }
export const isAssign = (v: unknown): v is RawAssign =>
  isObj(v) && isStr(v['productId']) && isStr(v['locationId']) && isNum(v['capacityMinor']) && typeof v['primary'] === 'boolean';

export const isBackstock = (v: unknown): v is Record<string, number> =>
  isObj(v) && Object.values(v).every((n) => isInt(n) && (n as number) >= 0);

/** Stamp the store onto raw locations so the caller sends it once; the map filters to this store anyway. */
export const toLocations = (storeId: string, locs: readonly RawLoc[]): readonly ShelfLocation[] => locs.map((l) => ({
  storeId, locationId: l.locationId, aisle: l.aisle, rack: l.rack, bay: l.bay, shelf: l.shelf, position: l.position,
  ...(l.zone !== undefined ? { zone: l.zone as ShelfLocation['zone'] } : {}), ...(l.label !== undefined ? { label: l.label } : {}),
}));
export const toAssignments = (storeId: string, raw: readonly RawAssign[]): readonly ShelfAssignment[] => raw.map((a) => ({
  storeId, productId: a.productId, locationId: a.locationId, capacityMinor: a.capacityMinor, primary: a.primary,
}));

// ── What gets stored ─────────────────────────────────────────────────────────────────────────────────

export interface StoredShelfMap {
  readonly storeId: string;
  /** A change is a new version, never an edit. */
  readonly version: number;
  readonly locations: readonly ShelfLocation[];
  readonly publishedBy: string;
  readonly publishedAt: string;
}

export interface StoredPlanogram extends Planogram {
  readonly publishedAt: string;
  /** The shelf-map version this plan was validated against — so a later map change is visible, not silent. */
  readonly shelfMapVersion: number;
}

export interface PlanogramStoreDeps {
  /** The newest shelf map for a store, or undefined when none was ever published. */
  readonly shelfMap: (tenantId: string, storeId: string) => Promise<StoredShelfMap | undefined> | StoredShelfMap | undefined;
  /** Every planogram version ever published for a store — append-only history. */
  readonly planograms: (tenantId: string, storeId: string) => Promise<readonly StoredPlanogram[]> | readonly StoredPlanogram[];
  readonly recordShelfMap: (tenantId: string, map: StoredShelfMap) => Promise<void> | void;
  readonly recordPlanogram: (tenantId: string, planogram: StoredPlanogram) => Promise<void> | void;
  readonly now: () => string;
}

/** Newest version per plan id. */
export function latestPlanograms(all: readonly StoredPlanogram[]): readonly StoredPlanogram[] {
  const byId = new Map<string, StoredPlanogram>();
  for (const p of all) {
    const cur = byId.get(p.planogramId);
    if (cur === undefined || p.version > cur.version) byId.set(p.planogramId, p);
  }
  return [...byId.values()].sort((a, b) => (a.planogramId < b.planogramId ? -1 : 1));
}

/**
 * The plan in force at `asOf`: of the newest version of each plan whose effective date has been reached,
 * the one with the latest effective date (ties: the most recently published). A plan dated in the future
 * is coming, not in force — and a store with none is told so, never handed an empty plan.
 */
export function inForcePlanogram(all: readonly StoredPlanogram[], asOf: string): StoredPlanogram | undefined {
  const day = asOf.slice(0, 10);
  return latestPlanograms(all)
    .filter((p) => p.effectiveFrom <= day)
    .sort((a, b) => (a.effectiveFrom !== b.effectiveFrom ? (a.effectiveFrom < b.effectiveFrom ? 1 : -1) : (a.publishedAt < b.publishedAt ? 1 : -1)))[0];
}

/** Build the engine's map from a stored shelf map and a planogram's assignments — or say exactly why not. */
export function shelfMapFor(map: StoredShelfMap, assignments: readonly ShelfAssignment[]): ShelfMap {
  try {
    return new ShelfMap(map.storeId, map.locations, assignments);
  } catch (err) {
    if (err instanceof ShelfMappingError) {
      throw apiError(422, {
        code: 'the_plan_is_inconsistent',
        whatHappened: err.message,
        wasItSaved: 'not_saved',
        nextSafeAction: 'Fix the shelf map or the planogram so every facing has a real shelf and one home, then publish again.',
      });
    }
    throw err;
  }
}

export const noShelfMap = (storeId: string): never => {
  throw apiError(409, {
    code: 'this_store_has_no_shelf_map',
    whatHappened: `Store ${storeId} has never published a shelf map, so there is nothing a planogram could be laid onto.`,
    wasItSaved: 'not_saved',
    nextSafeAction: 'Publish the shelf map first (PUT /v1/merchandising/stores/:storeId/shelf-map), then the planogram.',
  });
};

export const noPlanogram = (storeId: string): never => {
  throw apiError(409, {
    code: 'this_store_has_never_published_a_planogram',
    whatHappened: `Store ${storeId} has no planogram in force — none published, or none whose effective date has been reached.`,
    wasItSaved: 'not_saved',
    nextSafeAction: 'Publish a planogram (PUT /v1/merchandising/stores/:storeId/planograms/:planogramId) with an effective date that has arrived, or send the plan in the request body.',
  });
};

// ── The routes ────────────────────────────────────────────────────────────────────────────────────────

export function planogramRoutes(deps: PlanogramStoreDeps): readonly Route[] {
  return [
    {
      // Publish the store's shelf map. Body: { locations: RawLoc[] }. Each publish is the next version.
      api: 'API-04', method: 'PUT', path: '/v1/merchandising/stores/:storeId/shelf-map',
      permission: 'planogram.publish', idempotent: true,
      handler: async (ctx) => {
        const storeId = (ctx.params['storeId'] ?? '').trim();
        const b = isObj(ctx.body) ? ctx.body : {};
        const locs = b['locations'];
        if (storeId === '' || !Array.isArray(locs) || locs.length === 0 || !locs.every(isLoc)) {
          throw apiError(400, {
            code: 'not_readable_as_a_shelf_map',
            whatHappened: 'A shelf map needs the store in the path and locations[] each with locationId, aisle, rack, bay, shelf, position (zone and label optional).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was published. Send every shelf location the store has.',
          });
        }
        const locations = toLocations(storeId, locs as RawLoc[]);
        const ids = new Set<string>();
        for (const l of locations) {
          if (ids.has(l.locationId)) {
            throw apiError(422, {
              code: 'duplicate_shelf_location',
              whatHappened: `Location "${l.locationId}" appears twice in the map — one id names one shelf facing.`,
              wasItSaved: 'not_saved',
              nextSafeAction: 'Nothing was published. Give every facing its own id.',
            });
          }
          ids.add(l.locationId);
        }
        const previous = await deps.shelfMap(ctx.tenantId, storeId);
        const map: StoredShelfMap = { storeId, version: (previous?.version ?? 0) + 1, locations, publishedBy: ctx.userId, publishedAt: deps.now() };
        await deps.recordShelfMap(ctx.tenantId, map);
        return { status: 201, body: { shelfMap: map } };
      },
    },
    {
      api: 'API-04', method: 'GET', path: '/v1/merchandising/stores/:storeId/shelf-map',
      permission: 'planogram.compliance.read',
      handler: async (ctx) => {
        const storeId = ctx.params['storeId'] ?? '';
        const map = await deps.shelfMap(ctx.tenantId, storeId);
        if (map === undefined) throw notFound(`shelf map for store ${storeId}`);
        return { status: 200, body: { shelfMap: map } };
      },
    },
    {
      // Publish a planogram (a new version of it). Body: { effectiveFrom: YYYY-MM-DD, assignments: RawAssign[] }.
      // Validated against the STORED shelf map by the engine; the publisher is the authenticated caller.
      api: 'API-04', method: 'PUT', path: '/v1/merchandising/stores/:storeId/planograms/:planogramId',
      permission: 'planogram.publish', idempotent: true,
      handler: async (ctx) => {
        const storeId = (ctx.params['storeId'] ?? '').trim();
        const planogramId = (ctx.params['planogramId'] ?? '').trim();
        const b = isObj(ctx.body) ? ctx.body : {};
        const raw = b['assignments'];
        if (storeId === '' || planogramId === '' || !isStr(b['effectiveFrom']) || !/^\d{4}-\d{2}-\d{2}$/.test(b['effectiveFrom'] as string)
          || !Array.isArray(raw) || raw.length === 0 || !raw.every(isAssign)) {
          throw apiError(400, {
            code: 'not_readable_as_a_planogram',
            whatHappened: 'A planogram needs the store and plan id in the path, an effectiveFrom date (YYYY-MM-DD) and assignments[] each with productId, locationId, capacityMinor and primary.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was published. Send every facing the plan assigns.',
          });
        }
        const map = await deps.shelfMap(ctx.tenantId, storeId);
        if (map === undefined) noShelfMap(storeId);
        const assignments = toAssignments(storeId, raw as RawAssign[]);
        shelfMapFor(map!, assignments); // refuses an inconsistent plan; nothing stored
        const history = (await deps.planograms(ctx.tenantId, storeId)).filter((p) => p.planogramId === planogramId);
        const version = history.reduce((v, p) => Math.max(v, p.version), 0) + 1;
        const planogram: StoredPlanogram = {
          planogramId, storeId, version, effectiveFrom: b['effectiveFrom'] as string, assignments,
          createdBy: ctx.userId, publishedAt: deps.now(), shelfMapVersion: map!.version,
        };
        await deps.recordPlanogram(ctx.tenantId, planogram);
        return { status: 201, body: { planogram, previousVersions: history.length } };
      },
    },
    {
      // The store's plans: the one in force, the newest version of each, and how many versions each has.
      api: 'API-04', method: 'GET', path: '/v1/merchandising/stores/:storeId/planograms',
      permission: 'planogram.compliance.read',
      handler: async (ctx) => {
        const storeId = ctx.params['storeId'] ?? '';
        const all = await deps.planograms(ctx.tenantId, storeId);
        const latest = latestPlanograms(all);
        const inForce = inForcePlanogram(all, deps.now());
        const map = await deps.shelfMap(ctx.tenantId, storeId);
        return {
          status: 200,
          body: {
            storeId, inForce: inForce ?? null, plans: latest.map((p) => ({ ...p, versions: all.filter((x) => x.planogramId === p.planogramId).length })),
            shelfMapVersion: map?.version ?? null,
            // A plan validated against an older map than the one now published is flagged, not hidden (P-08).
            staleAgainstShelfMap: map === undefined ? [] : latest.filter((p) => p.shelfMapVersion !== map.version).map((p) => p.planogramId),
          },
        };
      },
    },
    {
      // One plan's full version history — every version ever published, oldest first.
      api: 'API-04', method: 'GET', path: '/v1/merchandising/stores/:storeId/planograms/:planogramId',
      permission: 'planogram.compliance.read',
      handler: async (ctx) => {
        const storeId = ctx.params['storeId'] ?? '';
        const planogramId = ctx.params['planogramId'] ?? '';
        const versions = (await deps.planograms(ctx.tenantId, storeId)).filter((p) => p.planogramId === planogramId).sort((a, b) => a.version - b.version);
        if (versions.length === 0) throw notFound(`planogram ${planogramId} in store ${storeId}`);
        return { status: 200, body: { planogramId, storeId, versions } };
      },
    },
  ];
}
