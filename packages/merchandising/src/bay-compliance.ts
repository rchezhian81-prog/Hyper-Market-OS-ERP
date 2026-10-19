// D-13 (R4, OB-219) — the planogram compliance score PER BAY, every gap named.
//
// `planogramCompliance` (shelf.ts) judges each planned facing against what staff counted. This groups its findings by
// bay — aisle, rack and bay of the shop's shelf map — and gives each bay a score over the facings that were OBSERVED, with
// every gap named in the shop's own words:
//
//   "empty, stock in back"      the facing was counted empty and head office holds stock of it in the building;
//   "empty, none in building"   counted empty, and there is none — a reorder, not a refill;
//   "never counted"             nobody has counted the facing — not an empty shelf, an unchecked one;
//   "counted too long ago"      the last count is older than the freshness window;
//   "below the refill level"    counted, but under the refill line;
//   "more than the facing holds" counted above the facing's capacity.
//
// A bay nobody counted is "not scored", never 0% and never 100% (P-08). The score is the STAFF count's: image recognition,
// when it exists, is only ever a suggestion beside it (OB-219), so every bay says `measuredBy: 'counted by staff'`.
// Pure and deterministic: no clock, no I/O.

import type { ComplianceIssue, Planogram, ShelfLocation } from './shelf';

export type BayGap = 'empty_stock_in_back' | 'empty_none_in_building' | 'never_counted' | 'counted_too_long_ago' | 'below_refill_level' | 'over_capacity' | 'missing_from_shelf' | 'not_on_plan';

export const BAY_GAP_WORDS: Readonly<Record<BayGap, string>> = Object.freeze({
  empty_stock_in_back: 'empty, stock in back',
  empty_none_in_building: 'empty, none in building',
  never_counted: 'never counted',
  counted_too_long_ago: 'counted too long ago',
  below_refill_level: 'below the refill level',
  over_capacity: 'more than the facing holds',
  missing_from_shelf: 'missing from the shelf',
  not_on_plan: 'not on the plan',
});

export interface BayKey { readonly aisle: number; readonly rack: number; readonly bay: number }
export const bayKeyOf = (b: BayKey): string => `A${b.aisle}-R${b.rack}-B${b.bay}`;

export interface BayGapLine {
  readonly productId: string;
  readonly locationId: string;
  readonly gap: BayGap;
  readonly words: string;
  readonly onShelfMinor: number;
  readonly capacityMinor: number;
}

export interface BayScore {
  readonly bayKey: string;
  readonly aisle: number;
  readonly rack: number;
  readonly bay: number;
  readonly planned: number;
  readonly observed: number;
  readonly compliant: number;
  /** Over the observed facings; `not_scored` when none was observed. */
  readonly score: { readonly kind: 'scored'; readonly bp: number } | { readonly kind: 'not_scored'; readonly because: string };
  readonly gaps: readonly BayGapLine[];
  readonly measuredBy: 'counted by staff';
}

/** Map one finding to its gap name — the backstock decides between "stock in back" and "none in building". */
export function gapOf(issue: ComplianceIssue, backstock: Readonly<Record<string, number>>): BayGap | undefined {
  switch (issue.finding) {
    case 'empty_shelf': return (backstock[issue.productId] ?? 0) > 0 ? 'empty_stock_in_back' : 'empty_none_in_building';
    case 'never_counted': return 'never_counted';
    case 'last_counted_too_long_ago': return 'counted_too_long_ago';
    case 'below_minimum': return 'below_refill_level';
    case 'over_capacity': return 'over_capacity';
    case 'missing_from_shelf': return 'missing_from_shelf';
    case 'not_on_plan': return 'not_on_plan';
    default: return undefined;
  }
}

/** Score each bay of the plan from the compliance run's findings. */
export function scoreByBay(input: {
  readonly planogram: Planogram;
  readonly locations: readonly ShelfLocation[];
  readonly issues: readonly ComplianceIssue[];
  readonly backstock: Readonly<Record<string, number>>;
}): readonly BayScore[] {
  const where = new Map(input.locations.map((l) => [l.locationId, l] as const));
  const issueOf = new Map(input.issues.map((i) => [`${i.productId}|${i.locationId ?? ''}`, i] as const));
  const bays = new Map<string, { key: BayKey; planned: number; observed: number; compliant: number; gaps: BayGapLine[] }>();
  for (const a of input.planogram.assignments) {
    const loc = where.get(a.locationId);
    const key: BayKey = loc === undefined ? { aisle: 0, rack: 0, bay: 0 } : { aisle: loc.aisle, rack: loc.rack, bay: loc.bay };
    const k = bayKeyOf(key);
    const b = bays.get(k) ?? { key, planned: 0, observed: 0, compliant: 0, gaps: [] };
    b.planned += 1;
    const issue = issueOf.get(`${a.productId}|${a.locationId}`);
    const gap = issue === undefined ? undefined : gapOf(issue, input.backstock);
    const unobserved = gap === 'never_counted' || gap === 'counted_too_long_ago';
    if (!unobserved) b.observed += 1;
    if (gap === undefined) b.compliant += 1;
    else b.gaps.push({ productId: a.productId, locationId: a.locationId, gap, words: BAY_GAP_WORDS[gap], onShelfMinor: issue!.onShelfMinor, capacityMinor: issue!.capacityMinor });
    bays.set(k, b);
  }
  return [...bays.entries()].sort((x, y) => x[1].key.aisle - y[1].key.aisle || x[1].key.rack - y[1].key.rack || x[1].key.bay - y[1].key.bay).map(([bayKey, b]) => ({
    bayKey, ...b.key, planned: b.planned, observed: b.observed, compliant: b.compliant,
    score: b.observed === 0 ? { kind: 'not_scored', because: 'no facing in this bay was counted recently enough' } : { kind: 'scored', bp: Math.round((b.compliant * 10_000) / b.observed) },
    gaps: b.gaps, measuredBy: 'counted by staff',
  }));
}
