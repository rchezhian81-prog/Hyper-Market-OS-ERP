// Branch scope on the server (Wave 2b · audit PA-01 / EA-03 · M01-FR-01 · M02-FR-02 · M25-FR-01 · M29-FR-01 · SEC-02 · §28).
//
// The audit executed the real pipeline: a manager signed in for br-1 with a grant for [br-1] read both branches'
// consolidation with no `?scope=`, read br-2 with `?scope=br-2`, and wrote another branch's pay rate — every route
// trusted the request's idea of scope, or had none. The pipeline now puts the caller's scope for THIS route's
// permission on the context, derived from their grants; a handler that reads or writes by branch goes through these
// helpers: what the caller asked for is narrowed to what they hold, a branch they do not hold is refused BY NAME —
// never silently widened to the tenant, never silently narrowed into a 200 that looks complete (P-08).

import { apiError, type ApiError } from './errors';
import type { BranchScope, RequestContext } from './router';

type Scoped = Pick<RequestContext, 'scope'>;

/** The caller's scope for this route — nothing at all when a handler runs outside the pipeline (fail closed). */
export const scopeOf = (ctx: Scoped): BranchScope => ctx.scope ?? [];

export const branchInScope = (ctx: Scoped, branchId: string): boolean => {
  const held = scopeOf(ctx);
  return held === 'all' || held.includes(branchId);
};

export const outsideBranchScope = (branchId: string): ApiError => apiError(403, {
  code: 'outside_your_branch_scope',
  whatHappened: `This account's authority does not reach branch "${branchId}".`,
  wasItSaved: 'not_saved',
  nextSafeAction: 'Work within the branches your role covers, or have the branch added to your grant by a second person. Nothing was changed.',
});

export const scopeNotHeld = (beyond: readonly string[]): ApiError => apiError(403, {
  code: 'scope_not_held',
  whatHappened: `This account's authority does not reach ${beyond.map((b) => `"${b}"`).join(', ')}.`,
  wasItSaved: 'not_saved',
  nextSafeAction: 'Ask within the branches your role covers (or leave the scope out to get exactly those). Nothing was changed.',
});

/** Refuse, by name, a write or read that names a branch the caller does not hold. */
export function assertBranchInScope(ctx: Scoped, branchId: string): void {
  if (!branchInScope(ctx, branchId)) throw outsideBranchScope(branchId);
}

/**
 * The scope a read runs under: what the caller HOLDS, narrowed to what they ASKED for. Asking for nothing in
 * particular gives exactly what they hold; asking for a branch (or for everything) they do not hold is refused by
 * name — the answer is never widened by a request, and never quietly shrunk into a total that looks whole.
 */
export function narrowScope(ctx: Scoped, requested?: BranchScope): BranchScope {
  const held = scopeOf(ctx);
  if (requested === undefined) return held;
  if (requested === 'all') {
    if (held === 'all') return 'all';
    throw scopeNotHeld(['all branches']);
  }
  if (held === 'all') return [...requested];
  const beyond = requested.filter((b) => !held.includes(b));
  if (beyond.length > 0) throw scopeNotHeld(beyond);
  return [...requested];
}

/** Keep only the rows whose branch the scope covers. */
export function withinScope<T extends { readonly branchId: string }>(scope: BranchScope, rows: readonly T[]): readonly T[] {
  return scope === 'all' ? rows : rows.filter((r) => scope.includes(r.branchId));
}

// ── Who acts is the sign-in's answer (Wave 2b · audit PA-03 · §28 · hard rule #4) ──────────────────────────────
// The audit executed routes that accepted two typed names as evidence of two people: an unprovisioned "completedBy"
// and "verifiedBy", a grant "requestedBy" a nonexistent person and "approvedBy" whoever the body said. A name in a
// body is a claim; a sign-in is a fact. These helpers make the rule one sentence: the person acting is the caller,
// and a second person's act is their own call, under their own sign-in.

export const actorIsTheCaller = (field: string, named: string, caller: string): ApiError => apiError(400, {
  code: 'actor_is_the_caller',
  whatHappened: `"${field}" names ${named}, but the person doing this is ${caller} — who acts is taken from the sign-in, never from the request (§28).`,
  wasItSaved: 'not_saved',
  nextSafeAction: `Leave ${field} out, or name yourself. A second person's part is their own call, under their own sign-in. Nothing was changed.`,
});

/** A body field that names the ACTING person must name the caller, or be absent. */
export function requireActorIsCaller(ctx: Pick<RequestContext, 'userId'>, body: Record<string, unknown>, field: string): void {
  const v = body[field];
  if (v !== undefined && v !== ctx.userId) throw actorIsTheCaller(field, String(v), ctx.userId);
}

/** A body field that names the SECOND person is refused outright: that person acts through their own route. */
export const secondPersonIsASeparateAct = (field: string, route: string): ApiError => apiError(400, {
  code: 'second_person_is_a_separate_act',
  whatHappened: `"${field}" cannot be named here: the second person acts under their own sign-in, through ${route}.`,
  wasItSaved: 'not_saved',
  nextSafeAction: `Send this without ${field}; then have the second person call ${route}. Nothing was changed.`,
});
