// Each stock role posts only its own kinds of stock movement — OB-623 (owner, 1 Nov 2026, in writing: "narrow it before
// the pilot") · roadmap §28 · M07-FR-01/02 · M08-FR-01 · M09-FR-01/03/04 · P-04 · hard rule #10.
//
// The Receiver/QC and the Warehouse user (OB-622) hold the stock-movement word `inventory.movement.append`, the one word
// thirty-odd head-office routes ask for — a goods receipt, a count, a bin move, a transfer, but also a write-off, a waste
// record, a free sample, an expiry sweep. §28 gives each role its own work only:
//
//   Receiver/QC     "Receive/count/QC/quarantine"   → book the receiving door, record and complete a goods receipt, count;
//   Warehouse user  "Put-away/pick/transfer/count"  → put away, move between bins, pick and put back, issue to the floor and
//                                                      take its returns back, send and receive a transfer, count.
//
// So head office judges EVERY route that word opens, and every relayed record that names a person as its mover, against
// the roles through which that person holds the word. A person who holds it through any OTHER role (the owner, the store
// manager) keeps exactly what they had. A person who holds it ONLY through the narrowed roles may post only those roles'
// kinds; anything else is refused by name, before anything is written — and a relayed record so refused stays at the store
// as a visible dead letter for a person (never lost, never silently re-stamped).
//
// A kind not clearly in a role's §28 line is LEFT OUT and asked of the owner (the report of OB-623): returning goods to the
// supplier, a typed `received`/`transferred_*`/`returned_to_supplier` movement, a warehouse `pack` or `dispatch` move,
// cancelling a transfer, setting up a bin, and the expiry sweep. A new route that asks for the word and is not classified
// here is refused to the narrowed roles (fails closed), and tests/integration/w2-each-stock-role-posts-only-its-own-moves
// fails until it is classified.

import type { Route, RequestContext, HandlerResult } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import { InMemoryEventStore, type EventStore } from '../../../packages/persistence/src/event-store';
import { effectiveGrants } from './adapters';
import { ROLE_CATALOGUE, RECEIVER_QC_ROLE_ID, WAREHOUSE_USER_ROLE_ID } from './roles';

export const MOVE_WORD = 'inventory.movement.append';

/** The kinds of stock work a narrowed role may do. */
export type MovementJob = 'count' | 'receive' | 'move_in_store' | 'transfer';

/** Each kind in the words a person reads. */
export const JOB_WORDS: Readonly<Record<MovementJob, string>> = Object.freeze({
  count: 'enter a count',
  receive: 'book a delivery at the receiving door and record or complete a goods receipt',
  move_in_store: 'put away, move between bins, pick and put back, issue stock to the floor and take its returns back',
  transfer: 'send and receive a transfer',
});

/** OB-623: the roles narrowed, and the kinds each may post. Every other role holding the word is not narrowed. */
export const NARROWED_MOVEMENT_ROLES: Readonly<Record<string, readonly MovementJob[]>> = Object.freeze({
  [RECEIVER_QC_ROLE_ID]: Object.freeze(['count', 'receive'] as const),
  [WAREHOUSE_USER_ROLE_ID]: Object.freeze(['count', 'move_in_store', 'transfer'] as const),
});

/** What a request is: its kind of work (null = not a narrowed role's work at all) and what to call it. */
export interface MovementKind {
  readonly job: MovementJob | null;
  readonly what: string;
}
type Classify = (body: Record<string, unknown>) => MovementKind;

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);
const fixed = (job: MovementJob | null, what: string): Classify => () => ({ job, what });

/** The warehouse moves a Warehouse user makes (services/inventory/src/warehouse.ts MOVEMENT_KINDS); `pack`/`dispatch` asked. */
const IN_STORE_MOVES: readonly string[] = ['put_away', 'bin_to_bin', 'pick', 'return_to_bin'];
const warehouseMove: Classify = (b) => {
  const kind = str(b['kind']);
  return kind !== undefined && IN_STORE_MOVES.includes(kind)
    ? { job: 'move_in_store', what: `a "${kind}" warehouse move` }
    : { job: null, what: `a "${kind ?? 'unnamed'}" warehouse move` };
};

/**
 * Every head-office route the stock-movement word opens, classified. `null` = no narrowed role's work (the owner and the
 * store manager still do it). The table is the whole list: a route missing from it is refused to the narrowed roles.
 */
export const DIRECT_MOVEMENT_KINDS: Readonly<Record<string, Classify>> = Object.freeze({
  // The plain movements form: only a count is a narrowed role's; every other kind has its own governed route, or is asked.
  'POST /v1/inventory/movements': (b) => {
    const kind = str(b['kind']);
    return kind === 'counted' ? { job: 'count', what: 'a count' } : { job: null, what: `a "${kind ?? 'unnamed'}" stock movement typed on the movements form` };
  },
  // Counting (both roles).
  'POST /v1/inventory/counts/:countId': fixed('count', 'a count'),
  'POST /v1/inventory/count-plans/:planId/counts/:countId': fixed('count', 'a count on a count sheet'),
  'GET /v1/inventory/count-plans/:planId/sheet': fixed('count', 'opening a count sheet'),
  // Receiving (Receiver/QC) — M07-FR-01: "book dock slot → scan PO/ASN → scan items → capture quantities → create GRN".
  'POST /v1/inventory/goods-receipt/:grnId': fixed('receive', 'a goods receipt'),
  'POST /v1/inventory/goods-receipt/:grnId/assemble': fixed('receive', 'completing a goods receipt from its scans'),
  'POST /v1/inventory/dock-slots/book': fixed('receive', 'booking a delivery at the receiving door'),
  'POST /v1/inventory/dock-diary/:slotId': fixed('receive', 'booking a delivery at the receiving door'),
  'POST /v1/inventory/dock-diary/:slotId/status': fixed('receive', 'marking a delivery at the receiving door'),
  // Goods going BACK to the supplier after another person's disposition — not in §28's Receiver line; asked of the owner.
  'POST /v1/inventory/goods-receipt/:grnId/excess/dispatch': fixed(null, 'sending rejected goods back to the supplier'),
  'POST /v1/inventory/goods-receipt/:grnId/lines/:lineId/dispatch': fixed(null, 'sending rejected goods back to the supplier'),
  'POST /v1/inventory/goods-receipt/:grnId/excess/returned': fixed(null, 'recording goods returned to the supplier'),
  'POST /v1/inventory/goods-receipt/:grnId/lines/:lineId/returned': fixed(null, 'recording goods returned to the supplier'),
  // Inside the store or warehouse (Warehouse user).
  'POST /v1/warehouse/movements/:commandId': warehouseMove,
  'POST /v1/floor/indents/:indentId/issues/:issueId': fixed('move_in_store', 'issuing stock from the back store to the floor'),
  'POST /v1/floor/indents/:indentId/returns/:returnId/accepted': fixed('move_in_store', 'taking stock back from the floor'),
  // Transfers (Warehouse user) — the floor's count-in of an issue is the receiving end of the same transfer.
  'POST /v1/warehouse/transfers/:transferId': fixed('transfer', 'a transfer'),
  'POST /v1/warehouse/transfers/:transferId/dispatch': fixed('transfer', 'sending a transfer'),
  'POST /v1/warehouse/transfers/:transferId/receive': fixed('transfer', 'receiving a transfer'),
  'POST /v1/floor/indents/:indentId/issues/:issueId/receipt': fixed('transfer', 'counting in stock issued to the floor'),
  'POST /v1/warehouse/transfers/:transferId/cancel': fixed(null, 'cancelling a transfer'),
  // Setting up a bin is the place's set-up, not a movement — asked.
  'POST /v1/warehouse/bins/:binId': fixed(null, 'setting up a warehouse bin'),
  // Losses, waste, samples, packaging and the expiry sweep — no narrowed role's work.
  'POST /v1/inventory/write-off/:writeOffId': fixed(null, 'a stock write-off'),
  'GET /v1/inventory/write-off-value': fixed(null, 'valuing a stock write-off'),
  'POST /v1/inventory/write-off-captures/:writeOffId/decide': fixed(null, 'deciding a captured stock loss'),
  'POST /v1/waste/records/:wasteId': fixed(null, 'a waste record'),
  'POST /v1/waste/coverage': fixed(null, 'a waste-coverage record'),
  'POST /v1/inventory/free-samples/:issueId': fixed(null, 'issuing a free sample'),
  'POST /v1/packaging/items/:packagingId': fixed(null, 'a packaging item'),
  'POST /v1/packaging/items/:packagingId/movements/:movementId': fixed(null, 'a packaging movement'),
  'POST /v1/inventory/expiry-sweep': fixed(null, 'running the expiry sweep'),
});

/**
 * The records a store computer relays that NAME the person who moved the stock, and the field that names them. Head office
 * re-checks that person's own word on each; here it also judges the kind. (An adjustment REQUEST is not here: it posts no
 * movement — it waits for a second person, who posts it.)
 */
export const RELAYED_MOVEMENT_KINDS: Readonly<Record<string, { readonly person: string; readonly classify: Classify }>> = Object.freeze({
  'POST /v1/warehouse/movements/:commandId/synced': { person: 'movedBy', classify: warehouseMove },
  'POST /v1/inventory/receiving-scans/:commandId/synced': { person: 'receivedBy', classify: fixed('receive', 'a receiving scan') },
  'POST /v1/inventory/goods-receipt/:grnId/assembled': { person: 'completedBy', classify: fixed('receive', 'completing a delivery') },
  'POST /v1/inventory/goods-receipt/:grnId/synced': { person: 'receivedBy', classify: fixed('receive', 'a goods receipt') },
  'POST /v1/inventory/counts/:countId/synced': { person: 'counterId', classify: fixed('count', 'a count') },
  'POST /v1/floor/indents/:indentId/issues/:issueId/synced': { person: 'issuedBy', classify: fixed('move_in_store', 'issuing stock from the back store to the floor') },
  'POST /v1/floor/indents/:indentId/issues/:issueId/receipt/synced': { person: 'receivedBy', classify: fixed('transfer', 'counting in stock issued to the floor') },
  'POST /v1/warehouse/transfers/:transferId/dispatch/synced': { person: 'dispatchedBy', classify: fixed('transfer', 'sending a transfer') },
  'POST /v1/warehouse/transfers/:transferId/receive/synced': { person: 'receivedBy', classify: fixed('transfer', 'receiving a transfer') },
  'POST /v1/inventory/write-off/:writeOffId/synced': { person: 'raisedBy', classify: fixed(null, 'a stock loss') },
});

/** How a person holds the stock-movement word: not at all, without limit, or only through the narrowed roles. */
export type MovementReach =
  | { readonly kind: 'none' }
  | { readonly kind: 'any' }
  | { readonly kind: 'narrowed'; readonly roles: readonly string[]; readonly jobs: readonly MovementJob[] };

/** Judge a person's reach from their grants (the branch's when one is named). Pure, so it is tested on its own. */
export function movementReachOf(
  grants: readonly { readonly userId: string; readonly roleId: string; readonly branchScope: readonly string[] | 'all' }[],
  userId: string, branchId: string | null,
): MovementReach {
  const roles = new Set<string>();
  for (const g of grants) {
    if (g.userId !== userId) continue;
    if (branchId !== null && g.branchScope !== 'all' && !g.branchScope.includes(branchId)) continue;
    if ((ROLE_CATALOGUE.find((r) => r.id === g.roleId)?.permissions ?? []).includes(MOVE_WORD)) roles.add(g.roleId);
  }
  if (roles.size === 0) return { kind: 'none' };
  if ([...roles].some((r) => NARROWED_MOVEMENT_ROLES[r] === undefined)) return { kind: 'any' };
  const jobs = [...new Set([...roles].flatMap((r) => NARROWED_MOVEMENT_ROLES[r] ?? []))];
  return { kind: 'narrowed', roles: [...roles].sort(), jobs };
}

/** The refusal, in plain words: who, what their role may do, what this was, and what to do next. Undefined = go on. */
export function movementKindRefusal(reach: MovementReach, userId: string, kind: MovementKind, relayed: boolean): Error | undefined {
  if (reach.kind !== 'narrowed') return undefined;
  if (kind.job !== null && reach.jobs.includes(kind.job)) return undefined;
  const names = reach.roles.map((r) => ROLE_CATALOGUE.find((x) => x.id === r)?.name ?? r).join(' and ');
  const may = reach.jobs.map((j) => JOB_WORDS[j]).join('; ');
  return apiError(403, {
    code: 'not_your_kind_of_stock_movement',
    whatHappened: `${userId} holds stock work through the ${names} role${reach.roles.length === 1 ? '' : 's'}, which may only ${may}. ${kind.what[0]!.toUpperCase()}${kind.what.slice(1)} is not one of those (owner decision OB-623).`,
    wasItSaved: 'not_saved',
    nextSafeAction: relayed
      ? 'Do not discard it at the store: it stays in the queue for a person. The store manager, or someone whose role covers this work, records it. Nothing was changed.'
      : 'Ask the store manager, or someone whose role covers this work, to record it. Nothing was changed.',
  });
}

const keyOf = (r: Pick<Route, 'method' | 'path'>): string => `${r.method} ${r.path}`;
const bodyOf = (ctx: RequestContext): Record<string, unknown> =>
  (ctx.body !== null && typeof ctx.body === 'object' && !Array.isArray(ctx.body) ? ctx.body as Record<string, unknown> : {});

/**
 * Wrap every route the stock-movement word opens, and every relayed movement record, with the OB-623 judgement. Run LAST
 * among the surface's wrappers so it speaks before anything else is read or written.
 */
export function movementJobsSurface(surface: Route[], input: { readonly store?: EventStore }): void {
  // A bare composition (no store: the API-surface document, a stub) judges over a store that holds no grants — nobody narrowed.
  const store = input.store ?? new InMemoryEventStore();
  const reach = async (ctx: RequestContext, userId: string): Promise<MovementReach> =>
    movementReachOf(await effectiveGrants(store, ctx.tenantId), userId, ctx.branchId ?? null);
  for (let i = 0; i < surface.length; i += 1) {
    const route = surface[i]!;
    const key = keyOf(route);
    const relayed = RELAYED_MOVEMENT_KINDS[key];
    if (relayed !== undefined) {
      const inner = route.handler;
      surface[i] = {
        ...route,
        handler: async (ctx): Promise<HandlerResult> => {
          const person = str(bodyOf(ctx)[relayed.person]);
          if (person !== undefined) {
            const refused = movementKindRefusal(await reach(ctx, person), person, relayed.classify(bodyOf(ctx)), true);
            if (refused !== undefined) throw refused;
          }
          return inner(ctx);
        },
      };
      continue;
    }
    if (route.permission !== MOVE_WORD) continue;
    const classify = DIRECT_MOVEMENT_KINDS[key] ?? fixed(null, 'this kind of stock work');
    const inner = route.handler;
    surface[i] = {
      ...route,
      handler: async (ctx): Promise<HandlerResult> => {
        const refused = movementKindRefusal(await reach(ctx, ctx.userId), ctx.userId, classify(bodyOf(ctx)), false);
        if (refused !== undefined) throw refused;
        return inner(ctx);
      },
    };
  }
}
