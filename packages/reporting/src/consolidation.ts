// Company-wide consolidation — org roll-ups + drill-down (M01 / M29 / D13, owner decision).
//
// The single-scope KPI engine (`sales-summary.ts`) answers "how did THIS branch do?"; the drill-through
// (`@sre/owner-control`) answers "show me the transactions behind THIS number." What the owner asked for is
// the layer between: **take every branch's numbers and roll them UP the organisation** — company → branch →
// department, across sales, returns, margin, stock/wastage, purchases/payables, cash reconciliation, tax,
// workforce, delivery and exceptions — so the owner sees the whole business and can drill from the group
// total down to the branch that moved it. The traps this engine exists to avoid are the ones that make a
// consolidated report quietly wrong:
//
//   • **THE HIERARCHY IS EFFECTIVE-DATED.** A branch that opened in March is not in February's company
//     total, and one that moved companies mid-year is attributed to whichever it belonged to at the time.
//     `resolveHierarchyAsOf` reads the membership valid AT the period, never today's structure applied to
//     old numbers — that is how a report double-counts a closed branch or loses a new one.
//   • **INGESTION IS IDEMPOTENT, AND A CORRECTION SUPERSEDES.** A branch re-sends its month (a retry, a
//     late sync) and the total must not double. Each contribution is keyed on (branch, period, family) and
//     carries a `revision`; a repeat at the same revision is IGNORED, a higher revision REPLACES (late or
//     corrected data), a lower one is refused as stale — never added (hard rule #10: a conflict is visible,
//     never silent last-write-wins).
//   • **PROVENANCE AND LAST-REFRESH TRAVEL WITH THE NUMBER.** A roll-up carries the WORST freshness of its
//     contributors and NAMES the branches that did not report or reported stale — a group total that looks
//     complete while a branch is offline is the most dangerous number on the screen (P-08 / §31).
//   • **IT RECONCILES.** The parent equals the sum of the children that reported; the report says which
//     branches were expected and which are missing, so the gap is explained, never buried.
//   • **SCOPE IS ENFORCED AND THE TOTAL CHANGES WITH IT** (§28). A branch manager rolling up the company
//     sees only their branch(es) and the total is recomputed to match, with what was withheld named — the
//     same rule the drill-through keeps, applied to the roll-up.
//
// Exact integer money throughout (§29.1). Pure and deterministic: the caller passes `asOf`; no clock, no I/O.

import { freshness, type Freshness } from './freshness';

/** The report families the owner named. Generic measures keep one engine over all of them. */
export type MetricFamily =
  | 'sales'
  | 'returns'
  | 'margin'
  | 'stock'
  | 'wastage'
  | 'purchases'
  | 'payables'
  | 'cash_recon'
  | 'tax'
  | 'workforce'
  | 'delivery'
  | 'exceptions';

/** What a viewer may see (§28). `'all'` is company-wide authority; otherwise the branch ids they hold. */
export interface ReportScope {
  readonly userId: string;
  readonly branchScope: readonly string[] | 'all';
}

/** One branch's numbers for one family in one period. Measures are exact integer (minor units or counts). */
export interface BranchContribution {
  readonly branchId: string;
  readonly period: string; // e.g. '2026-09' or '2026-09-25'
  readonly family: MetricFamily;
  readonly measures: Readonly<Record<string, number>>;
  /** When the branch's data was last synced (null = never). Drives freshness. */
  readonly lastRefreshAt: string | null;
  /** Monotonic per (branch, period, family). A re-send at the same revision is idempotent; higher supersedes. */
  readonly revision: number;
}

const key = (c: Pick<BranchContribution, 'branchId' | 'period' | 'family'>): string => `${c.branchId}\u001f${c.period}\u001f${c.family}`;

export type IngestOutcome = 'ingested' | 'replaced_by_correction' | 'ignored_duplicate' | 'refused_stale_revision';

export interface IngestResult {
  readonly store: readonly BranchContribution[];
  readonly outcome: IngestOutcome;
  readonly detail: string;
}

/**
 * Ingest one branch contribution idempotently. Keyed on (branch, period, family):
 *   • no prior → `ingested`;
 *   • same revision as the held one → `ignored_duplicate` (a retry/re-sync must not double the total);
 *   • higher revision → `replaced_by_correction` (late or corrected data supersedes);
 *   • lower revision → `refused_stale_revision` (an out-of-order arrival never overwrites newer data).
 * The store is the caller's durable append/replace target; this returns the next store, never mutating.
 */
export function ingestContribution(existing: readonly BranchContribution[], incoming: BranchContribution): IngestResult {
  const k = key(incoming);
  const held = existing.find((c) => key(c) === k);
  if (held === undefined) {
    return { store: [...existing, incoming], outcome: 'ingested', detail: `first ${incoming.family} for ${incoming.branchId} ${incoming.period}` };
  }
  if (incoming.revision === held.revision) {
    return { store: existing, outcome: 'ignored_duplicate', detail: `revision ${incoming.revision} already held — not counted twice` };
  }
  if (incoming.revision < held.revision) {
    return { store: existing, outcome: 'refused_stale_revision', detail: `revision ${incoming.revision} is older than the held ${held.revision} — refused, not applied` };
  }
  const store = existing.map((c) => (key(c) === k ? incoming : c));
  return { store, outcome: 'replaced_by_correction', detail: `revision ${incoming.revision} supersedes ${held.revision} (late/corrected data)` };
}

// ---- Effective-dated hierarchy -------------------------------------------------------------------------

/** A branch's membership under a parent for a validity window (YYYY-MM-DD, `to` exclusive; null = open). */
export interface BranchMembership {
  readonly branchId: string;
  readonly parentId: string;
  readonly from: string;
  readonly to: string | null;
}

/** The (branch → parent) map that was in force AT `asOf` — never today's structure applied to old numbers. */
export function resolveHierarchyAsOf(memberships: readonly BranchMembership[], asOf: string): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const m of memberships) {
    if (m.from <= asOf && (m.to === null || asOf < m.to)) {
      map.set(m.branchId, m.parentId);
    }
  }
  return map;
}

/** The branches whose in-force parent chain reaches `rootNodeId` at `asOf` (the roll-up's population). */
export function branchesUnder(rootNodeId: string, parentAsOf: ReadonlyMap<string, string>): readonly string[] {
  const out: string[] = [];
  for (const branchId of parentAsOf.keys()) {
    let cur: string | undefined = branchId;
    const seen = new Set<string>();
    while (cur !== undefined && !seen.has(cur)) {
      if (cur === rootNodeId) { out.push(branchId); break; }
      seen.add(cur);
      cur = parentAsOf.get(cur);
    }
  }
  return out.sort();
}

/** Branches under a node that this viewer may see (§28): the roll-up population ∩ their scope. */
export function visibleBranches(scope: ReportScope, population: readonly string[]): readonly string[] {
  if (scope.branchScope === 'all') return [...population];
  const allowed = new Set(scope.branchScope);
  return population.filter((b) => allowed.has(b));
}

// ---- Consolidation -------------------------------------------------------------------------------------

export interface ConsolidatedReport {
  readonly nodeId: string;
  readonly family: MetricFamily;
  readonly period: string;
  /** Summed measures across the contributing branches, exact integer. */
  readonly measures: Readonly<Record<string, number>>;
  /** The branches expected under the node (in scope). */
  readonly expectedBranches: readonly string[];
  /** Those that actually contributed. */
  readonly reportedBranches: readonly string[];
  /** Expected-but-not-reported — the gap, named (never buried). */
  readonly missingBranches: readonly string[];
  /** Reported but stale — counted, but flagged, never shown as fresh. */
  readonly staleBranches: readonly string[];
  /** The WORST freshness across contributors (missing when a branch never synced). */
  readonly freshness: Freshness;
  /** True when every expected branch reported. */
  readonly reconciles: boolean;
  /** Branches hidden from this viewer by scope (§28) — named so the total is explainable. */
  readonly withheldByScope: readonly string[];
  /** Per-branch breakdown for the drill-down (worst money first, then branch id). */
  readonly contributors: readonly { readonly branchId: string; readonly measures: Readonly<Record<string, number>>; readonly lastRefreshAt: string | null }[];
  readonly detail: string;
}

const sumMeasures = (rows: readonly Readonly<Record<string, number>>[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const m of rows) for (const [k, v] of Object.entries(m)) out[k] = (out[k] ?? 0) + v;
  return out;
};

/** The measure a branch is ranked by in the drill-down — the first key, or 0. Deterministic. */
const rankOf = (m: Readonly<Record<string, number>>): number => {
  const first = Object.keys(m).sort()[0];
  return first === undefined ? 0 : Math.abs(m[first] ?? 0);
};

/**
 * Roll a family up to one node for one period, over the hierarchy in force at `asOf`.
 *
 * Applies the viewer's scope (§28), sums exact-integer measures across the contributing branches, carries
 * the worst freshness and names missing/stale branches, and reconciles the node total to the branches that
 * reported. The drill-down is the per-branch `contributors` list.
 */
export function consolidate(input: {
  readonly nodeId: string;
  readonly family: MetricFamily;
  readonly period: string;
  readonly contributions: readonly BranchContribution[];
  readonly memberships: readonly BranchMembership[];
  readonly scope: ReportScope;
  readonly asOf: string;
  readonly staleAfterSeconds: number;
}): ConsolidatedReport {
  const parentAsOf = resolveHierarchyAsOf(input.memberships, input.asOf);
  const population = branchesUnder(input.nodeId, parentAsOf);
  const expected = visibleBranches(input.scope, population);
  const withheldByScope = population.filter((b) => !expected.includes(b));

  const relevant = input.contributions.filter(
    (c) => c.family === input.family && c.period === input.period && expected.includes(c.branchId),
  );
  const reported = [...new Set(relevant.map((c) => c.branchId))].sort();
  const missing = expected.filter((b) => !reported.includes(b));

  // Freshness: the WORST across contributors. A branch that never synced makes the whole roll-up 'missing'.
  const worst = relevant.reduce<{ at: string | null; everNull: boolean }>(
    (acc, c) => ({
      at: c.lastRefreshAt === null ? acc.at : acc.at === null ? c.lastRefreshAt : (c.lastRefreshAt < acc.at ? c.lastRefreshAt : acc.at),
      everNull: acc.everNull || c.lastRefreshAt === null,
    }),
    { at: null, everNull: relevant.length === 0 },
  );
  const roll = freshness(worst.everNull ? null : worst.at, input.asOf, input.staleAfterSeconds);
  const staleBranches = relevant
    .filter((c) => freshness(c.lastRefreshAt, input.asOf, input.staleAfterSeconds).state !== 'fresh')
    .map((c) => c.branchId)
    .sort();

  const measures = sumMeasures(relevant.map((c) => c.measures));
  const contributors = relevant
    .map((c) => ({ branchId: c.branchId, measures: c.measures, lastRefreshAt: c.lastRefreshAt }))
    .sort((a, b) => (rankOf(b.measures) - rankOf(a.measures)) || a.branchId.localeCompare(b.branchId));

  const reconciles = missing.length === 0;
  return {
    nodeId: input.nodeId,
    family: input.family,
    period: input.period,
    measures,
    expectedBranches: expected,
    reportedBranches: reported,
    missingBranches: missing,
    staleBranches,
    freshness: roll,
    reconciles,
    withheldByScope,
    contributors,
    detail:
      (reconciles ? `${reported.length}/${expected.length} branches reported` : `${missing.length} branch(es) MISSING (${missing.join(', ')}) — total is incomplete`) +
      (withheldByScope.length > 0 ? `; ${withheldByScope.length} branch(es) withheld by scope` : '') +
      (roll.state !== 'fresh' ? `; data is ${roll.state}` : ''),
  };
}
