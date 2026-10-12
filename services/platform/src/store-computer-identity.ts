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

/**
 * One store reference found in a request: where, and the value (a store, or a location to be placed in one). `names`:
 * 'store' when the field names a STORE outright (storeId, branchId, warehouseId, backStoreId, or the field a family is
 * placed by — `STORE_STAMP_FIELD`); 'location' when it names a place that may be a shelf or bin inside a store.
 */
export interface StoreReference { readonly field: string; readonly value: string; readonly names?: 'store' | 'location' }

/** Body keys that name a store outright (the rest of BODY_STORE_KEYS name a location that may be a shelf or a bin). */
const STORE_NAMING_KEYS = new Set(['storeId', 'branchId', 'warehouseId', 'backStoreId']);

/** Mark each reference as naming a store or a location, for this route (its own store field names a store). */
export function classifyReferences(routePath: string, references: readonly StoreReference[]): readonly StoreReference[] {
  const own = STORE_STAMP_FIELD[routePath];
  return references.map((r) => {
    const key = r.field.split('.').pop()!.replace(/\[\d+\]$/, '');
    const isStore = r.field.startsWith('path.') || r.field.startsWith('query.') || STORE_NAMING_KEYS.has(key) || (own !== undefined && r.field === `body.${own}`);
    return { ...r, names: isStore ? 'store' as const : 'location' as const };
  });
}

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
  | { readonly ok: false; readonly reason: 'credential_names_no_store' | 'credential_store_not_canonical' | 'credential_store_not_granted' | 'record_names_another_store' | 'record_names_unknown_store' | 'record_store_unresolved'; readonly why: string; readonly field?: string; readonly namedStore?: string };

/**
 * Judge one request from a caller holding `store_computer` grants (`grantedStores`: the stores those grants name — a
 * tenant-wide grant names none). `credentialStore` is the signed `branch_id` claim. `storeOf` places a location in its
 * store; `knownStores` is every store head office knows (org branches, stores with settings, stores a box is granted for).
 * A reference that places in ANOTHER known store is refused. Round 10 (OB-54 · hard rule #10): a STORE code (a field that
 * names a store — `classifyReferences`) that places in NO known store is refused too — never guessed into the box's own
 * store, nor left for a route to read as "no store"; it is refused by name and listed. An unplaced code in a LOCATION
 * field (a shelf or bin code) names no store and is left to the route's own location rules.
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
  // Verifier r18 (residual C-2): a credential — and so a grant — naming a store that is not canonical text (padding, an
  // invisible character such as a zero-width space, a non-NFKC form) is refused on EVERY relay, so a grant put on the ledger
  // before round 18's request check can never book records at a phantom store that only looks like a real one.
  if (notCanonical(credentialStore)) {
    return { ok: false, reason: 'credential_store_not_canonical', why: `This store computer's sign-in names a store whose name is not plain text (${JSON.stringify(credentialStore)} — it carries spaces or invisible characters), so it cannot be one of head office's stores. Its records are refused and kept as exceptions until its credential and its store computer role are re-issued for its real store.` };
  }
  if (!input.grantedStores.includes(credentialStore)) {
    return { ok: false, reason: 'credential_store_not_granted', why: `This store computer's sign-in names store ${credentialStore}, but its store computer role is not granted for that store (one store per box, OB-54).` };
  }
  for (const r of input.references) {
    const store = input.storeOf(r.value);
    // An unplaceable SHELF or BIN code (a location field) is the route's own business; an unplaceable STORE code is not.
    if (store !== credentialStore && !input.knownStores.has(store) && r.names !== 'location') {
      return {
        ok: false, reason: 'record_names_unknown_store', field: r.field, namedStore: r.value,
        why: `Store ${credentialStore}'s computer sent a record that names ${r.value} at ${r.field}, which head office cannot place in any store it knows. A record is never guessed into a store (OB-54), so it was refused and kept as an exception.`,
      };
    }
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

// ── OB-54 round 10: head office STAMPS the credential's store onto a relayed record that names none ─────────────────
//
// A box-relayed record that names no store used to be placed later by a guess (the sale's pack, the lane, or "no branch
// named"). Now head office writes the store the box's SIGNED credential names onto the record before any handler reads
// it — server-side, never trusted from the box — and keeps a stamp record of what it did (`GET /v1/store-computers/stamps`).
// Each family is stamped at the field its own handler places the record by. A write from a box on a route outside this
// table that names no store is still recorded as ATTRIBUTED to the credential's store (`field: null`); its body is left
// exactly as the box sealed it (a decider's seal covers every word, ADR-0023).

/** Route path → the body field (dot path) the record's store is read from. POST relays only. */
export const STORE_STAMP_FIELD: Readonly<Record<string, string>> = Object.freeze({
  '/v1/sales': 'locationId',
  '/v1/sales/:saleId/returns/synced': 'locationId',
  '/v1/returns/no-receipt/synced': 'locationId',
  '/v1/pos/day-close/:dayCloseId/synced': 'storeId',
  '/v1/inventory/receiving-scans/:commandId/synced': 'storeId',
  '/v1/inventory/goods-receipt/:grnId/synced': 'storeId',
  '/v1/inventory/counts/:countId/synced': 'storeId',
  '/v1/inventory/adjustment-requests/:requestId/synced': 'storeId',
  '/v1/merchandising/shelf-counts/:countId/synced': 'storeId',
  '/v1/warehouse/movements/:commandId/synced': 'command.storeId',
  '/v1/hr/workforce/tasks/:taskId/complete/synced': 'branchId',
  // OB-54 round 12: the card/UPI no-answer and late-answer relays (OB-69 · PF-06) are placed by their storeId.
  '/v1/finance/payment-exceptions/:attemptId/no-answer/synced': 'storeId',
  '/v1/finance/payment-exceptions/:attemptId/late-answer/synced': 'storeId',
  // M35-FR-03: the box's own health report (disk, queue, till devices) names no store — it is the credential's.
  '/v1/store-computers/health-reports': 'storeId',
  // OB-80 "A" (owner, 12 Oct 2026): head office keeps a till as (store, till) — the till's cash, its shift closes and its
  // till actions carry the store of the box that relays them, so two stores' "lane-1" never clash and never merge.
  '/v1/tills/:tillId/cash-movements/synced': 'storeId',
  '/v1/shifts/:shiftId/close/synced': 'storeId',
  '/v1/loss-prevention/activity/:activityId/synced': 'storeId',
});

/**
 * Round 14 (verifier G1): EVERY relay route whose id names a record head office may already hold — the path parameter
 * (or, for a sale, the body field) naming it, and the record FAMILY it belongs to (one family is one record whatever
 * route acts on it: a day close and its reopen, a sale and the returns on it, a delivery route's stops, settlement and
 * hand-over). Head office judges the store of the record AS IT HOLDS IT exactly like a store the request names
 * (`record.<param>`) — for a person against their branch scope, for a store computer against its own store — so a caller
 * can never act on another store's record by naming its id (`services/api/src/relay-record-store.ts` resolves each family).
 * `tenantWide`: the record belongs to the whole business (the migration cut-over), never to one store.
 */
export interface RelayRecordKey { readonly family: string; readonly param?: string; readonly bodyKey?: string; readonly tenantWide?: true }
export const RELAY_RECORD_KEY: Readonly<Record<string, RelayRecordKey>> = Object.freeze({
  '/v1/sales': { family: 'sale', bodyKey: 'saleId' },
  '/v1/sales/:saleId/returns/synced': { family: 'sale', param: 'saleId' },
  '/v1/returns/no-receipt/synced': { family: 'no-receipt-return', bodyKey: 'returnId' },
  '/v1/pos/day-close/:dayCloseId/synced': { family: 'day-close', param: 'dayCloseId' },
  '/v1/pos/day-close/:dayCloseId/reopen/synced': { family: 'day-close', param: 'dayCloseId' },
  '/v1/shifts/:shiftId/close/synced': { family: 'shift', param: 'shiftId' },
  '/v1/tills/:tillId/cash-movements/synced': { family: 'till', param: 'tillId' },
  '/v1/approvals/decisions/:id/synced': { family: 'approval', param: 'id' },
  '/v1/finance/payment-exceptions/:attemptId/no-answer/synced': { family: 'payment-attempt', param: 'attemptId' },
  '/v1/finance/payment-exceptions/:attemptId/late-answer/synced': { family: 'payment-attempt', param: 'attemptId' },
  '/v1/finance/payment-exceptions/:attemptId/resolved/synced': { family: 'payment-attempt', param: 'attemptId' },
  '/v1/hr/workforce/tasks/:taskId/complete/synced': { family: 'task', param: 'taskId' },
  '/v1/hr/workforce/checklists/:checklistId/synced': { family: 'checklist', param: 'checklistId' },
  '/v1/delivery/routes/:routeId/stops/:stopId/synced': { family: 'delivery-route', param: 'routeId' },
  '/v1/delivery/routes/:routeId/settled/synced': { family: 'delivery-route', param: 'routeId' },
  '/v1/delivery/routes/:routeId/handover/synced': { family: 'delivery-route', param: 'routeId' },
  '/v1/fulfilment/waves/:waveId/lines/:lineId/synced': { family: 'wave', param: 'waveId' },
  '/v1/fulfilment/waves/:waveId/packed/synced': { family: 'wave', param: 'waveId' },
  '/v1/inventory/counts/:countId/synced': { family: 'count', param: 'countId' },
  '/v1/warehouse/movements/:commandId/synced': { family: 'warehouse-command', param: 'commandId' },
  '/v1/inventory/receiving-scans/:commandId/synced': { family: 'receiving-scan', param: 'commandId' },
  '/v1/inventory/goods-receipt/:grnId/synced': { family: 'goods-receipt', param: 'grnId' },
  '/v1/merchandising/shelf-counts/:countId/synced': { family: 'shelf-count', param: 'countId' },
  '/v1/inventory/adjustment-requests/:requestId/synced': { family: 'adjustment-request', param: 'requestId' },
  '/v1/floor/indents/:indentId/synced': { family: 'floor-indent', param: 'indentId' },
  '/v1/floor/indents/:indentId/issues/:issueId/synced': { family: 'floor-indent', param: 'indentId' },
  '/v1/floor/indents/:indentId/issues/:issueId/receipt/synced': { family: 'floor-indent', param: 'indentId' },
  '/v1/purchase/invoices/:invoiceId/synced': { family: 'supplier-invoice', param: 'invoiceId' },
  '/v1/loss-prevention/activity/:activityId/synced': { family: 'till-activity', param: 'activityId' },
  '/v1/migration/exceptions/:exceptionId/resolution/synced': { family: 'migration-exception', param: 'exceptionId', tenantWide: true },
  '/v1/migration/control-totals/:totalId/signature/synced': { family: 'migration-total', param: 'totalId', tenantWide: true },
});

/**
 * OB-54 round 12 (kept for its readers): routes that act on a record head office ALREADY holds, by its path id — now every
 * keyed relay route in `RELAY_RECORD_KEY` (round 14). Route path → the path parameter naming the record.
 */
export const RECORD_STORE_PARAM: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries(
  Object.entries(RELAY_RECORD_KEY).flatMap(([route, k]) => (k.param === undefined ? [] : [[route, k.param] as const])),
));

/**
 * Round 14 (verifier G2): the first store or location field that is present but NOT a piece of text (a list, a number, an
 * object). Head office never reads such a value as "no store" — the request is refused as unreadable (400) instead, so a
 * `locationId: ["store-2"]` can never slip past the judge and be placed by a fallback. `null` reads as absent.
 * Round 15 (verifier GAP C): text that is not CANONICAL — spaces (or any white space) around it, or nothing but white
 * space — is unreadable too. The judge used to trim " store-1 " to store-1 while the handler booked stock at the phantom
 * place " store-1 "; now one value reaches both, or none does. The empty string still reads as absent (stamped / no store).
 */
// Round 16 (verifier C-1): also any control character or invisible (zero-width / BOM) character anywhere in it — text a
// person cannot see the difference of is never a second store.
// Round 18 (verifier r17 C-2 a): by Unicode CLASS, not by a list \u2014 every control (Cc), format (Cf: soft hyphen, invisible
// operators, zero-width marks, bidi controls), surrogate (Cs), private-use (Co), line/paragraph separator (Zl, Zp),
// Default_Ignorable_Code_Point (variation selectors, the combining grapheme joiner, fillers\u2026), every space other than the
// plain space, and the Hangul fillers spelled out (U+115F, U+1160, U+3164, U+FFA0). And text that Unicode compatibility
// normalisation changes (a full-width letter, a decomposed accent) is a look-alike of another id, never a second store.
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\u115f\u1160\u3164\uffa0]/u;
/** Whether a store, branch or location id is NOT canonical (exported for the routes' and the tests' one shared rule). */
export const notCanonical = (x: string): boolean => x !== '' && (x !== x.trim() || INVISIBLE.test(x) || x !== x.normalize('NFKC'));

/**
 * Round 18 (verifier r17 C-2 b): ONE schema-level rule for which body keys name a store, a branch or a location \u2014 not a
 * list a new route can fall outside of. A key is one when it IS `store|branch|location|warehouse|bin` + `Id|Ids|Scope`, or
 * ENDS in the capitalised form (`toStoreId`, `fromStoreId`, `homeStoreId`, `locationIds`, `branchScope`, `storeIds`,
 * `foundAtLocationId`\u2026). Its value must be canonical text, or a list of canonical text (`branchScope` may be "all").
 */
const STORE_NAMING_KEY = /^(?:store|branch|location|warehouse|bin)(?:Id|Ids|Scope)$|(?:Store|Branch|Location|Warehouse|Bin)(?:Id|Ids|Scope)$/;
export const namesAStore = (key: string): boolean => BODY_STORE_KEYS.has(key) || STORE_NAMING_KEY.test(key);
/**
 * Round 16 (verifier C-1): on EVERY write, by anyone (head office included), a PATH parameter that names a store, a branch,
 * an org node or a location is refused the same way when it is not canonical — one shared edge, never route by route.
 */
const WRITE_PATH_STORE_KEYS = ['storeId', 'branchId', 'nodeId', 'locationId', 'warehouseId', 'binId'] as const;
export function paddedWritePathParam(params: Readonly<Record<string, string>>): string | undefined {
  for (const k of WRITE_PATH_STORE_KEYS) { const p = params[k]; if (typeof p === 'string' && notCanonical(p)) return `path.${k}`; }
  return undefined;
}
/** Round 15 (verifier GAP C): a store named in the PATH or QUERY with white space around it — the same refusal. */
export function paddedStoreParam(params: Readonly<Record<string, string>>, query: Readonly<Record<string, string>>): string | undefined {
  for (const k of PARAM_STORE_KEYS) {
    const p = params[k]; if (typeof p === 'string' && notCanonical(p)) return `path.${k}`;
    const q = query[k]; if (typeof q === 'string' && notCanonical(q)) return `query.${k}`;
  }
  return undefined;
}

export function malformedStoreField(body: unknown): string | undefined {
  let found: string | undefined;
  const walk = (v: unknown, at: string, depth: number): void => {
    if (found !== undefined || depth > 8 || v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${at}[${i}]`, depth + 1)); return; }
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const here = at === '' ? k : `${at}.${k}`;
      if (BODY_STORE_KEYS.has(k) && x !== null && x !== undefined && (typeof x !== 'string' || notCanonical(x))) { found = `body.${here}`; return; }
      // Round 18 (verifier r17 C-2 b): every other key that names a store, branch or location — text or a list of text.
      if (!BODY_STORE_KEYS.has(k) && STORE_NAMING_KEY.test(k) && x !== null && x !== undefined) {
        if (typeof x === 'string') { if (notCanonical(x)) { found = `body.${here}`; return; } continue; }
        if (Array.isArray(x)) {
          const i = x.findIndex((e) => typeof e !== 'string' || notCanonical(e) || e === '');
          if (i >= 0) { found = `body.${here}[${i}]`; return; }
          continue;
        }
        found = `body.${here}`; return;
      }
      walk(x, here, depth + 1);
    }
  };
  walk(body, '', 0);
  return found;
}

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH']);

/**
 * Round 13 (verifier D1 · PA-01 · OB-54): a RELAY write — a `/synced` route, or a route a store computer's records are
 * placed or judged by (`STORE_STAMP_FIELD`, `RECORD_STORE_PARAM`). A PERSON who holds the relay permission (a manager or
 * a cashier signing in at a till) acts here only within their own server-derived branch scope, like any branch write.
 */
/** A write: POST, PUT or PATCH. */
export const isWrite = (method: string): boolean => WRITE_METHODS.has(method);

export function isRelayWrite(method: string, routePath: string): boolean {
  if (!WRITE_METHODS.has(method)) return false;
  return routePath.endsWith('/synced') || STORE_STAMP_FIELD[routePath] !== undefined || RECORD_STORE_PARAM[routePath] !== undefined;
}

/** A person's relay verdict: the first store reference outside their scope, or ok. */
export type PersonRelayVerdict = { readonly ok: true } | { readonly ok: false; readonly field: string; readonly namedStore: string };

/**
 * Round 13 (verifier D1 · PA-01): judge a PERSON's relay write against the branches their grants give them for the
 * route's permission (`scope`, the server's answer — never the request's). Every store the request names (path, query,
 * body at any depth) AND the store of the record it acts on (`record.<param>`) must be one of them; a location is placed in
 * its store first. A shelf or bin code that places in no known store is the route's own business (as for a store
 * computer). A company-wide caller ('all') is not limited.
 */
export function judgePersonRelay(input: {
  readonly scope: readonly string[] | 'all'; readonly references: readonly StoreReference[];
  readonly storeOf: (locationOrStore: string) => string; readonly knownStores: ReadonlySet<string>;
}): PersonRelayVerdict {
  if (input.scope === 'all') return { ok: true };
  const held = new Set(input.scope);
  for (const r of input.references) {
    if (held.has(r.value)) continue;
    const store = input.storeOf(r.value);
    if (held.has(store)) continue;
    if (r.names === 'location' && !input.knownStores.has(store)) continue;
    return { ok: false, field: r.field, namedStore: store };
  }
  return { ok: true };
}

/** What head office does with a store computer's accepted write. */
export type StoreStamp =
  | { readonly kind: 'none' }
  /** The record's store field was empty: the credential's store is written at `field`; `body` is what the handler reads. */
  | { readonly kind: 'stamped'; readonly field: string; readonly body: Readonly<Record<string, unknown>> }
  /** A write that names no store on a route that carries no store field: attributed to the credential's store, body untouched. */
  | { readonly kind: 'attributed' };

/**
 * Decide the stamp for one ACCEPTED request from a store computer whose credential names `credentialStore`. Pure: the
 * caller's body is never mutated (a copy is returned), so the idempotency hash stays the box's own request.
 */
export function storeStampFor(input: {
  readonly method: string; readonly routePath: string; readonly body: unknown;
  readonly credentialStore: string; readonly references: readonly StoreReference[];
}): StoreStamp {
  if (!WRITE_METHODS.has(input.method)) return { kind: 'none' };
  const field = STORE_STAMP_FIELD[input.routePath];
  const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (field !== undefined && isObj(input.body)) {
    const parts = field.split('.');
    let at: unknown = input.body;
    for (const p of parts.slice(0, -1)) at = isObj(at) ? at[p] : undefined;
    const leaf = parts[parts.length - 1]!;
    // A nested field whose parent is absent is the route's malformed record — not head office's to invent.
    if (!isObj(at)) return { kind: 'none' };
    const held = at[leaf];
    if (typeof held === 'string' && held.trim() !== '') return { kind: 'none' }; // the record names its own store
    const copy = structuredClone(input.body);
    let into: Record<string, unknown> = copy;
    for (const p of parts.slice(0, -1)) into = into[p] as Record<string, unknown>;
    into[leaf] = input.credentialStore;
    return { kind: 'stamped', field, body: copy };
  }
  return input.references.length === 0 ? { kind: 'attributed' } : { kind: 'none' };
}

/**
 * Round 18 (verifier r17 C-2 c): a write that puts something AT a store — a role's branch scope, a fixed asset or its
 * transfer, a display contract — names a store head office KNOWS (`known`: its organisation tree, or a store set up with
 * its settings). The first named store it does not know, or undefined. 'all' is a scope, not a store.
 */
export function firstUnknownStore(named: readonly unknown[], known: ReadonlySet<string>): string | undefined {
  for (const n of named) if (typeof n === 'string' && n !== '' && n !== 'all' && !known.has(n)) return n;
  return undefined;
}

/** The plain-English refusal for an unknown store (422 `unknown_store`), shared by every route that checks it. */
export const unknownStoreWords = (store: string, field: string): { readonly code: 'unknown_store'; readonly whatHappened: string; readonly wasItSaved: 'not_saved'; readonly nextSafeAction: string } => ({
  code: 'unknown_store',
  whatHappened: `${field} names store "${store}", which is not a store head office knows (its organisation tree, or a store set up with its settings). Head office never records anything at a store that does not exist.`,
  wasItSaved: 'not_saved',
  nextSafeAction: 'Pick the store from the list exactly as it is set up (do not paste it), or set the store up first. Nothing was saved.',
});
