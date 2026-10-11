// Only the store computer itself may tell head office what is true at its store (EA-01 · OB-36 "A" · P-04 · P-08).
//
// The box reports facts head office cannot see for itself: how far each of its queues has synced (the owner's "How
// current" figure) and how many records it still holds unsent (the owner's "Anything not sent", a branch close). Before
// round 6 these reports were gated by `store.pack.read` — which a cashier and a store manager also hold, so any of them
// could report "complete through now, nothing unsent" and make a stale store look live.
//
// Now a report needs BOTH:
//   • the permission `store.computer.report` — in the store computer's role (and the owner's, only so the owner can
//     approve granting the box its role under the no-escalation rule; a person never reports with it), and
//   • a grant of the `store_computer` ROLE itself at that store — so neither the owner, a manager nor a cashier can
//     report, however wide their own grants are: the report must come from that store's machine identity.
//   • round 7: the grant must NAME that store. A tenant-wide store_computer grant names none and reports for none — one
//     machine never speaks for every store.

import type { RequestContext } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';

/** The permission a store computer reports its own store's facts under. */
export const STORE_COMPUTER_REPORT = 'store.computer.report';

/**
 * Where the caller is a STORE COMPUTER: the branch scope of their `store_computer` role grants only (other roles they
 * hold do not count). undefined when the caller holds no such grant.
 */
export type StoreComputerScopeOf = (tenantId: string, userId: string) => Promise<readonly string[] | 'all' | undefined>;

/** Refuses (403) unless the caller is store `storeId`'s own computer. */
export async function assertStoreComputerOf(
  scopeOf: StoreComputerScopeOf | undefined, ctx: RequestContext, storeId: string, what: string,
): Promise<void> {
  const scope = scopeOf === undefined ? undefined : await scopeOf(ctx.tenantId, ctx.userId);
  // Round 7: a store computer reports only for a store its grant NAMES — a tenant-wide ('all') scope speaks for none.
  if (scope === undefined || scope === 'all' || !scope.includes(storeId)) {
    throw apiError(403, {
      code: 'not_this_stores_computer',
      whatHappened: `Only store ${storeId}'s own computer reports ${what}. A person's sign-in — a cashier's, a manager's or the owner's — cannot, so nobody can make a store look more up to date than its computer says.`,
      wasItSaved: 'not_saved',
      nextSafeAction: 'Let the store computer report for its own store; nothing was recorded.',
    });
  }
}
