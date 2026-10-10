// Stock locations inside the caller's branches (PA-01-r1 · audit PA-01 · M01-FR-01 · M02-FR-02 · M08 · SEC-02 · P-08).
//
// Wave 2b-ii put the caller's branch scope on every request (`ctx.scope`, derived on the server from their grants),
// but a stock route speaks in LOCATIONS, not branches. This file is the one rule that joins the two:
//
//   - a location belongs to the branch the org hierarchy puts it under — a branch is its own location (the store
//     computer sends its store id), a warehouse or department belongs to the nearest branch above it;
//   - a location the hierarchy does not place under any branch is its own key: a grant reaches it only by naming it.
//     So an unknown or company-level location is OUTSIDE every branch-limited grant (fail closed) and inside 'all'.
//
// Reads: what the caller holds, narrowed to the `branchId` they asked for (a branch not held → 403 `scope_not_held`).
// Writes: a location outside the caller's branches → 403 `outside_your_branch_scope`, nothing appended.

import { assertBranchInScope, narrowScope, type BranchScope, type RequestContext } from '../../kernel/src/index';

/** Which branch a stock location belongs to, for one tenant — resolved once per request, then synchronous. */
export type LocationBranches = (tenantId: string) => Promise<(locationId: string) => string> | ((locationId: string) => string);

/** With no hierarchy to consult, a location is its own branch key (the store computer's location IS its store id). */
export const locationIsItsOwnBranch: LocationBranches = () => (locationId) => locationId;

/** The org nodes needed to place a location: id, kind and parent. */
export interface PlaceableNode { readonly nodeId: string; readonly kind: string; readonly parentId: string | null }

/** Place a location under its nearest branch in the hierarchy; a location no branch is above is its own key. */
export function branchOfLocationIn(nodes: readonly PlaceableNode[]): (locationId: string) => string {
  const byId = new Map(nodes.map((n) => [n.nodeId, n] as const));
  return (locationId) => {
    const seen = new Set<string>();
    let at = byId.get(locationId);
    while (at !== undefined && !seen.has(at.nodeId)) {
      if (at.kind === 'branch') return at.nodeId;
      seen.add(at.nodeId);
      at = at.parentId === null ? undefined : byId.get(at.parentId);
    }
    return locationId;
  };
}

/** A filter over locations for this request's read: undefined when the scope is everything (nothing to filter). */
export interface LocationFilter {
  readonly scope: BranchScope;
  /** True when the location's branch is inside the read's scope. */
  readonly covers: (locationId: string) => boolean;
  /** True when nothing needs filtering (the read is for every branch). */
  readonly everything: boolean;
}

type Scoped = Pick<RequestContext, 'scope' | 'tenantId' | 'query'>;

/**
 * The scope a stock READ runs under: what the caller holds, narrowed to `?branchId=` when one is asked for. Asking for
 * a branch not held is refused by name (never silently widened, never silently shrunk into a total that looks whole).
 */
export async function stockReadScope(ctx: Scoped, branches: LocationBranches = locationIsItsOwnBranch): Promise<LocationFilter> {
  const asked = ctx.query['branchId'];
  const scope = narrowScope(ctx, asked === undefined || asked === '' ? undefined : [asked]);
  if (scope === 'all') return { scope, everything: true, covers: () => true };
  const branchOf = await branches(ctx.tenantId);
  return { scope, everything: false, covers: (locationId) => scope.includes(branchOf(locationId)) };
}

/** Is this location inside the caller's branches? (Outside the pipeline nothing is held: false.) */
export async function locationInScope(
  ctx: Pick<RequestContext, 'scope' | 'tenantId'>, locationId: string, branches: LocationBranches = locationIsItsOwnBranch,
): Promise<boolean> {
  if (ctx.scope === 'all') return true;
  const held = ctx.scope ?? [];
  return held.includes((await branches(ctx.tenantId))(locationId));
}

/** Refuse, by name, a stock write at a location outside the caller's branches. */
export async function assertLocationInScope(
  ctx: Pick<RequestContext, 'scope' | 'tenantId'>, locationId: string, branches: LocationBranches = locationIsItsOwnBranch,
): Promise<void> {
  if (ctx.scope === 'all') return;
  const branchOf = await branches(ctx.tenantId);
  assertBranchInScope(ctx, branchOf(locationId));
}
