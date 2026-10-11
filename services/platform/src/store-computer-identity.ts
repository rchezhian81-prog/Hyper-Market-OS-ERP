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

// ── OB-54 "A" (owner, 11 Oct 2026): each store computer's credential is LOCKED to its own store ─────────────────────
//
//   • the box's credential names its store (the signed `branch_id` claim, set by the administrator when the credential
//     is issued with scripts/issue-store-token.mjs);
//   • its `store_computer` grant names exactly that store — a tenant-wide or multi-store grant is refused at grant time;
//   • EVERY request it makes is judged here: a credential naming no store, a store its grant does not name, or a record
//     that names ANOTHER store (anywhere in the path, the query or the body — sale, return, day close, transfer, phone
//     work, held versions, watermarks) is refused by name and kept as a visible exception, never silently accepted.

/** The role id of the store computer's own machine identity (mirrors `services/api/src/roles.ts`). */
export const STORE_COMPUTER_ROLE = 'store_computer';

/**
 * Grant-time rule: a store computer's grant names ONE store. undefined = acceptable; otherwise the plain-English reason.
 * Other roles are never judged here.
 */
export function storeComputerGrantRefusal(roleId: string, branchScope: readonly string[] | 'all'): string | undefined {
  if (roleId !== STORE_COMPUTER_ROLE) return undefined;
  if (branchScope === 'all') {
    return 'A store computer\'s role must name its one store. A tenant-wide store computer grant would let one machine speak for every store, so it is refused (OB-54).';
  }
  const stores = [...new Set(branchScope.filter((s) => s.trim() !== ''))];
  if (stores.length !== 1) {
    return `A store computer's role must name exactly one store; this request names ${stores.length === 0 ? 'none' : stores.join(', ')}. Each store's computer gets its own sign-in for its own store (OB-54).`;
  }
  return undefined;
}

/** Where a record names the store it is about. Counterpart stores (a transfer's other end) use other names and are not read. */
const PARAM_STORE_KEYS = ['storeId', 'branchId'] as const;
const BODY_STORE_KEYS = new Set([
  'storeId', 'branchId', 'locationId', 'warehouseId', 'fromLocationId', 'toLocationId', 'foundAtLocationId', 'backStoreId',
]);

/** One store reference found in a request: where, and the value (a store, or a location to be placed in one). */
export interface StoreReference { readonly field: string; readonly value: string }

/** Every store or location a request names — path params, query, and the body at any depth (lines included). */
export function storeReferencesIn(input: {
  readonly params: Readonly<Record<string, string>>; readonly query: Readonly<Record<string, string>>; readonly body: unknown;
}): readonly StoreReference[] {
  const out: StoreReference[] = [];
  for (const k of PARAM_STORE_KEYS) {
    const p = input.params[k]; if (typeof p === 'string' && p !== '') out.push({ field: `path.${k}`, value: p });
    const q = input.query[k]; if (typeof q === 'string' && q !== '') out.push({ field: `query.${k}`, value: q });
  }
  const walk = (v: unknown, at: string, depth: number): void => {
    if (depth > 8 || v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${at}[${i}]`, depth + 1)); return; }
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const here = at === '' ? k : `${at}.${k}`;
      if (BODY_STORE_KEYS.has(k) && typeof x === 'string' && x.trim() !== '') out.push({ field: `body.${here}`, value: x.trim() });
      else walk(x, here, depth + 1);
    }
  };
  walk(input.body, '', 0);
  return out;
}

/** The binding's verdict on one request from a store computer. */
export type BoxRequestVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'credential_names_no_store' | 'credential_store_not_granted' | 'record_names_another_store'; readonly why: string; readonly field?: string; readonly namedStore?: string };

/**
 * Judge one request from a caller holding `store_computer` grants (`grantedStores`: the stores those grants name — a
 * tenant-wide grant names none). `credentialStore` is the signed `branch_id` claim. `storeOf` places a location in its
 * store; `knownStores` is every store head office knows (org branches, stores with settings, stores a box is granted for).
 * A reference that places in ANOTHER known store is refused. A code that places in no known store (an unplaced shelf or
 * bin code) names no store at all — it is left to the route's own location rules, never read as "another store".
 */
export function judgeBoxRequest(input: {
  readonly credentialStore: string | null; readonly grantedStores: readonly string[];
  readonly references: readonly StoreReference[]; readonly storeOf: (locationOrStore: string) => string;
  readonly knownStores: ReadonlySet<string>;
}): BoxRequestVerdict {
  const { credentialStore } = input;
  if (credentialStore === null) {
    return { ok: false, reason: 'credential_names_no_store', why: 'This store computer\'s sign-in names no store. Since OB-54 every store computer\'s credential is locked to its own store, so a credential without one is refused.' };
  }
  if (!input.grantedStores.includes(credentialStore)) {
    return { ok: false, reason: 'credential_store_not_granted', why: `This store computer's sign-in names store ${credentialStore}, but its store computer role is not granted for that store (one store per box, OB-54).` };
  }
  for (const r of input.references) {
    const store = input.storeOf(r.value);
    if (store !== credentialStore && input.knownStores.has(store)) {
      return {
        ok: false, reason: 'record_names_another_store', field: r.field, namedStore: store,
        why: `Store ${credentialStore}'s computer sent a record that names ${store === r.value ? `store ${store}` : `${r.value} (store ${store})`} at ${r.field}. A store computer relays and reports only for its own store (OB-54), so it was refused and kept as an exception.`,
      };
    }
  }
  return { ok: true };
}

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
