// OB-80 "A" (owner, 12 Oct 2026, "Keep cash per store + till"): head office keeps a till — its cash, its shift closes —
// as (store, till), never by the till's id alone, so two stores whose tills are both called "lane-1" never clash and never
// merge.
//
// The store of a till record, in this order:
//   1. the store the record names (`storeId`) — for a store computer's relay head office STAMPS its own credential's store
//      there (`STORE_STAMP_FIELD`), and a store the box or a person names is judged by the binding before it gets here;
//   2. the one store the caller's own grant covers for the route (round 16, verifier LOW: before the registry — a store-2
//      manager's "lane-1" is store-2's lane-1, whichever store registered a till of that name);
//   3. the store head office registered the till at (device registry — only when exactly one store registered that name);
//   4. the business's one store, when head office knows exactly one (the single-store pilot);
//   5. otherwise: with NO store known at all the till is kept as before OB-80 (by its id alone — nothing can clash); with
//      more than one store a till head office cannot place is REFUSED by name (422 `till_store_unknown`), never merged into
//      another store's till of the same name.
// A store outside the caller's own branches is refused (403), as any branch write (PA-01).

import { apiError } from '../../kernel/src/index';
import type { BranchScope } from '../../kernel/src/index';

export interface TillStoreDeps {
  /** The store head office registered a till at (device registry); undefined when it is not registered. */
  readonly storeOfTill?: (tenantId: string, tillId: string) => Promise<string | undefined> | string | undefined;
  /** Every store head office knows (org branches, stores with settings, stores a box is granted for). */
  readonly knownStores?: (tenantId: string) => Promise<readonly string[]> | readonly string[];
  /**
   * OB-82 "A" (owner, 12 Oct 2026, "Fix it once, for good"): the store a till's records kept by its id ALONE (before OB-80)
   * belong to — read ONLY from the append-only one-time placement record, never re-decided from today's stores or the
   * device register. undefined while the till's old records are not placed (they are then shown as unplaced, never folded
   * into a store).
   */
  readonly legacyStoreOfTill?: (tenantId: string, tillId: string) => Promise<string | undefined> | string | undefined;
}

const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined);

/** The store a till record belongs to (see the file header), or undefined for the pre-OB-80 single-store key. */
export async function tillStoreOf(
  deps: TillStoreDeps, ctx: { readonly tenantId: string; readonly scope?: BranchScope }, tillId: string, named: unknown,
): Promise<string | undefined> {
  const known = deps.knownStores === undefined ? undefined : await deps.knownStores(ctx.tenantId);
  const store = text(named)
    ?? (Array.isArray(ctx.scope) && ctx.scope.length === 1 ? ctx.scope[0] : undefined)
    ?? (deps.storeOfTill === undefined ? undefined : await deps.storeOfTill(ctx.tenantId, tillId))
    ?? (known !== undefined && known.length === 1 ? known[0] : undefined);
  if (store !== undefined) {
    if (ctx.scope !== undefined && ctx.scope !== 'all' && !ctx.scope.includes(store)) {
      throw apiError(403, {
        code: 'outside_your_branch_scope',
        whatHappened: `Till ${tillId} at store ${store} is outside the branches this account works for.`,
        wasItSaved: 'not_saved',
        nextSafeAction: 'Work with the tills of your own store; nothing was recorded.',
      });
    }
    return store;
  }
  if (known !== undefined && known.length > 1) {
    throw apiError(422, {
      code: 'till_store_unknown',
      whatHappened: `Head office keeps each till per store (OB-80), and cannot tell which store till ${tillId} belongs to: the record names no store, the till is not registered at one, and this account covers more than one.`,
      wasItSaved: 'not_saved',
      nextSafeAction: 'Send it from the store\'s own computer, or name the store (storeId), or register the till at its store. Nothing was recorded.',
    });
  }
  return undefined;
}
