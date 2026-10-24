// The floor plan and its heat map (M04-FR-04 "heat-map readiness and sales per square foot" · D02-FR-05 · OB-308, owner,
// 23 Oct 2026, in writing: "full floor-plan heat-map screen — coordinates per area, coloured by sales or margin per sq ft").
//
// A floor plan places each shelf AREA of a store on the floor: a rectangle in feet from the front-left corner of the shop
// (x across, y deep), the selling space it counts as, and the shelf locations (from the store's published shelf map) it
// holds. A plan is versioned: a change is a new version, never an edit (hard rule #2).
//
// The heat map folds what each area EARNED — the sales and the margin of the products whose PRIMARY shelf place (the
// planogram) is in it — per square foot, and gives each area a heat from 0 to 100 against the best area on the chosen
// measure. Nothing is invented (P-08):
//   • a product sold with no primary shelf place in any area is reported under "not on the floor plan", never spread;
//   • an area holding a product sold with no known cost has its margin NOT KNOWN (and no margin heat), with the products
//     named — never a margin costed at zero;
//   • an area with no floor space has no per-square-foot figure, said.
//
// Pure and deterministic.

import type { Money, CurrencyCode } from '../../contracts/src/money';
import { spacePerformance, type SpaceRatio } from './space';

export interface FloorArea {
  readonly areaId: string;
  readonly name: string;
  /** The Tamil name shown on the screen beside the English one, when given. */
  readonly nameTa?: string;
  /** The rectangle on the floor, in whole feet from the front-left corner: x across, y deep. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly depth: number;
  /** The selling space it counts as. Absent → its footprint (width × depth). Never more than the footprint. */
  readonly squareFeet: number;
  /** The shelf-map locations in this area — each in exactly one area. */
  readonly locationIds: readonly string[];
}

export interface FloorPlan {
  readonly storeId: string;
  readonly version: number;
  readonly widthFt: number;
  readonly depthFt: number;
  readonly areas: readonly FloorArea[];
  readonly publishedBy: string;
  readonly publishedAt: string;
}

const whole = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/** Read a floor plan's areas from a request body, judging each. `knownLocations` is the store's shelf map (undefined: none). */
export function readFloorPlan(body: unknown, knownLocations: ReadonlySet<string> | undefined): {
  readonly plan?: { readonly widthFt: number; readonly depthFt: number; readonly areas: readonly FloorArea[] };
  readonly problems: readonly string[];
} {
  const problems: string[] = [];
  if (body === null || typeof body !== 'object') return { problems: ['send { widthFt, depthFt, areas: [...] }'] };
  const b = body as Record<string, unknown>;
  const widthFt = b['widthFt'];
  const depthFt = b['depthFt'];
  if (!whole(widthFt) || widthFt <= 0 || !whole(depthFt) || depthFt <= 0) problems.push('the floor needs its width and depth in whole feet, each above 0');
  if (!Array.isArray(b['areas']) || b['areas'].length === 0) problems.push('a floor plan needs at least one area');
  if (problems.length > 0) return { problems };
  const areas: FloorArea[] = [];
  const ids = new Set<string>();
  const placed = new Map<string, string>();
  for (const [i, raw] of (b['areas'] as unknown[]).entries()) {
    const a = (raw ?? {}) as Record<string, unknown>;
    const label = isStr(a['areaId']) ? a['areaId'] : `area ${i + 1}`;
    if (!isStr(a['areaId']) || !isStr(a['name'])) { problems.push(`${label}: needs an areaId and a name`); continue; }
    if (ids.has(a['areaId'])) { problems.push(`${label}: the area id is used twice`); continue; }
    ids.add(a['areaId']);
    if (![a['x'], a['y'], a['width'], a['depth']].every(whole) || (a['width'] as number) <= 0 || (a['depth'] as number) <= 0 || (a['x'] as number) < 0 || (a['y'] as number) < 0) {
      problems.push(`${label}: x, y, width and depth must be whole feet (x and y from 0, width and depth above 0)`); continue;
    }
    const [x, y, w, d] = [a['x'], a['y'], a['width'], a['depth']] as number[];
    if (x! + w! > (widthFt as number) || y! + d! > (depthFt as number)) problems.push(`${label}: the area runs off the floor (${widthFt} × ${depthFt} ft)`);
    const footprint = w! * d!;
    const sq = a['squareFeet'] === undefined ? footprint : a['squareFeet'];
    if (typeof sq !== 'number' || !Number.isFinite(sq) || sq <= 0 || sq > footprint) problems.push(`${label}: its selling space must be above 0 and no more than its footprint (${footprint} sq ft)`);
    const locs = a['locationIds'];
    if (!Array.isArray(locs) || !locs.every(isStr)) { problems.push(`${label}: locationIds must be a list of shelf locations`); continue; }
    for (const loc of locs as string[]) {
      if (placed.has(loc)) problems.push(`${label}: shelf location ${loc} is already in ${placed.get(loc)} — a location is in one area only`);
      placed.set(loc, a['areaId']);
      if (knownLocations === undefined) problems.push(`${label}: shelf location ${loc} cannot be checked — the store has no published shelf map yet`);
      else if (!knownLocations.has(loc)) problems.push(`${label}: shelf location ${loc} is not on the store's shelf map`);
    }
    if (a['nameTa'] !== undefined && !isStr(a['nameTa'])) problems.push(`${label}: the Tamil name must be words`);
    areas.push({
      areaId: a['areaId'], name: a['name'].trim(), ...(isStr(a['nameTa']) ? { nameTa: a['nameTa'].trim() } : {}),
      x: x!, y: y!, width: w!, depth: d!, squareFeet: typeof sq === 'number' ? sq : footprint, locationIds: [...(locs as string[])],
    });
  }
  // Two areas may not cover the same floor.
  for (let i = 0; i < areas.length; i += 1) {
    for (let j = i + 1; j < areas.length; j += 1) {
      const p = areas[i]!, q = areas[j]!;
      if (p.x < q.x + q.width && q.x < p.x + p.width && p.y < q.y + q.depth && q.y < p.y + p.depth) problems.push(`${p.areaId} and ${q.areaId} overlap on the floor`);
    }
  }
  return problems.length > 0 ? { problems } : { plan: { widthFt: widthFt as number, depthFt: depthFt as number, areas }, problems };
}

/** What one product earned in the window, as head office folded it. `costMinor` undefined = its cost is not known. */
export interface ProductTakings {
  readonly productId: string;
  readonly salesMinor: number;
  readonly netSalesMinor: number;
  readonly costMinor: number | undefined;
}

export type HeatMeasure = 'sales' | 'margin';

export interface HeatArea {
  readonly areaId: string;
  readonly name: string;
  readonly nameTa: string | null;
  readonly x: number; readonly y: number; readonly width: number; readonly depth: number;
  readonly squareFeet: number;
  readonly products: readonly string[];
  readonly salesMinor: number;
  /** Null when some product sold here has no known cost — then `marginNotKnownFor` names them. */
  readonly marginMinor: number | null;
  readonly marginNotKnownFor: readonly string[];
  readonly salesPerSqFt: SpaceRatio;
  readonly marginPerSqFt: SpaceRatio;
  /** 0–100 against the best area on the chosen measure; null when this area's figure is not known. */
  readonly heat: number | null;
  readonly underperforming: boolean;
}

export interface HeatMap {
  readonly measure: HeatMeasure;
  readonly areas: readonly HeatArea[];
  /** Products sold with no primary shelf place in any area, and what they sold — never spread over the map. */
  readonly notOnFloorPlan: { readonly products: readonly string[]; readonly salesMinor: number };
}

/**
 * Fold the heat map: each area's products (by primary shelf place), what they sold, their margin, per square foot, and a
 * heat against the best area on `measure`.
 */
export function floorHeatMap(input: {
  readonly plan: Pick<FloorPlan, 'areas'>;
  /** Product → its PRIMARY shelf location (from the planograms in force). */
  readonly primaryLocationOf: ReadonlyMap<string, string>;
  readonly takings: readonly ProductTakings[];
  readonly measure: HeatMeasure;
  readonly currency: CurrencyCode;
}): HeatMap {
  const areaOfLocation = new Map<string, string>();
  for (const a of input.plan.areas) for (const l of a.locationIds) areaOfLocation.set(l, a.areaId);
  const byArea = new Map<string, ProductTakings[]>(input.plan.areas.map((a) => [a.areaId, []]));
  const off: ProductTakings[] = [];
  for (const t of input.takings) {
    const loc = input.primaryLocationOf.get(t.productId);
    const area = loc === undefined ? undefined : areaOfLocation.get(loc);
    if (area === undefined) off.push(t); else byArea.get(area)!.push(t);
  }
  // Products placed in an area that sold nothing still belong to it.
  const placedIn = new Map<string, Set<string>>(input.plan.areas.map((a) => [a.areaId, new Set<string>()]));
  for (const [productId, loc] of input.primaryLocationOf) {
    const area = areaOfLocation.get(loc);
    if (area !== undefined) placedIn.get(area)!.add(productId);
  }
  const m = (minor: number): Money => ({ minor, currency: input.currency });
  const sums = input.plan.areas.map((a) => {
    const ts = byArea.get(a.areaId)!;
    const unknown = ts.filter((t) => t.costMinor === undefined).map((t) => t.productId).sort();
    const sales = ts.reduce((s, t) => s + t.salesMinor, 0);
    const margin = unknown.length > 0 ? null : ts.reduce((s, t) => s + t.netSalesMinor - (t.costMinor ?? 0), 0);
    return { a, sales, margin, unknown, products: [...new Set([...placedIn.get(a.areaId)!, ...ts.map((t) => t.productId)])].sort() };
  });
  const perf = spacePerformance({
    areas: input.plan.areas.map((a) => ({ areaId: a.areaId, storeId: '', name: a.name, squareFeet: a.squareFeet })),
    sales: Object.fromEntries(sums.map((s) => [s.a.areaId, m(s.sales)])),
    grossMargin: Object.fromEntries(sums.filter((s) => s.margin !== null).map((s) => [s.a.areaId, m(s.margin!)])),
    currency: input.currency,
  });
  const perfOf = new Map(perf.map((r) => [r.areaId, r] as const));
  const figureOf = (s: (typeof sums)[number]): number | null => {
    const r = perfOf.get(s.a.areaId)!;
    const ratio = input.measure === 'sales' ? r.salesPerSqFt : s.margin === null ? undefined : r.marginPerSqFt;
    return ratio === undefined || ratio.kind !== 'per_sq_ft' ? null : ratio.minorPerSqFt;
  };
  const known = sums.map(figureOf).filter((v): v is number => v !== null);
  const best = known.length === 0 ? 0 : Math.max(...known);
  const areas: HeatArea[] = sums.map((s) => {
    const r = perfOf.get(s.a.areaId)!;
    const f = figureOf(s);
    return {
      areaId: s.a.areaId, name: s.a.name, nameTa: s.a.nameTa ?? null, x: s.a.x, y: s.a.y, width: s.a.width, depth: s.a.depth,
      squareFeet: s.a.squareFeet, products: s.products, salesMinor: s.sales, marginMinor: s.margin, marginNotKnownFor: s.unknown,
      salesPerSqFt: r.salesPerSqFt,
      marginPerSqFt: s.margin === null ? { kind: 'not_meaningful', because: `margin not known: no cost for ${s.unknown.join(', ')}` } : r.marginPerSqFt,
      heat: f === null ? null : best <= 0 ? 0 : Math.max(0, Math.round((f * 100) / best)),
      underperforming: s.margin !== null && r.underperforming,
    };
  });
  return {
    measure: input.measure, areas,
    notOnFloorPlan: { products: off.map((t) => t.productId).sort(), salesMinor: off.reduce((s, t) => s + t.salesMinor, 0) },
  };
}
