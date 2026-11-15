// Each stock role posts only its own kinds of stock movement — OB-623 (owner, 1 Nov 2026, in writing: "narrow it before
// the pilot") · roadmap §28 · M07-FR-01 · M09-FR-01/03 · P-04.
//
// The ONE rule, shared by head office (services/api/src/w2-movement-jobs.ts judges every route and relayed record the
// stock-movement word opens) and the store computer (edge/store-edge/src/handheld-sign-in.ts tells the warehouse handheld,
// offline, whether the person signed in may receive a delivery). OB-740 (pilot audit B-3): the handheld used to let a
// Warehouse user scan a delivery that head office then refused every time — a dead end at the store. Both sides now read
// the same table, so the phone refuses BEFORE the first scan exactly what head office would refuse after it.
//
// The Receiver/QC and the Warehouse user (OB-622) hold the stock-movement word `inventory.movement.append`. §28 gives each
// its own work only:
//   Receiver/QC     "Receive/count/QC/quarantine"   → book the receiving door, record and complete a goods receipt, count;
//   Warehouse user  "Put-away/pick/transfer/count"  → put away, move between bins, pick and put back, issue to the floor and
//                                                      take its returns back, send and receive a transfer, count.
// A person who holds the word through any OTHER role (the owner, the store manager) is not narrowed. Pure.

/** The stock-movement word every head-office stock route asks for (and the warehouse handheld's sign-in job). */
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

/** OB-622 role ids (services/api/src/roles.ts RECEIVER_QC_ROLE_ID / WAREHOUSE_USER_ROLE_ID — a test binds the two). */
export const RECEIVER_QC_ROLE = 'receiver_qc';
export const WAREHOUSE_USER_ROLE = 'warehouse_user';

/** OB-623: the roles narrowed, and the kinds each may post. Every other role holding the word is not narrowed. */
export const NARROWED_MOVEMENT_ROLES: Readonly<Record<string, readonly MovementJob[]>> = Object.freeze({
  [RECEIVER_QC_ROLE]: Object.freeze(['count', 'receive'] as const),
  [WAREHOUSE_USER_ROLE]: Object.freeze(['count', 'move_in_store', 'transfer'] as const),
});

/** How a person holds the stock-movement word: not at all, without limit, or only through the narrowed roles. */
export type MovementReach =
  | { readonly kind: 'none' }
  | { readonly kind: 'any' }
  | { readonly kind: 'narrowed'; readonly roles: readonly string[]; readonly jobs: readonly MovementJob[] };

/**
 * A person's reach from the roles they hold HERE (already filtered to this branch), each with the permissions its
 * catalogue gives it. Only roles carrying the stock-movement word count.
 */
export function movementReachOfRoles(roles: readonly { readonly roleId: string; readonly permissions: readonly string[] }[]): MovementReach {
  const moving = new Set<string>();
  for (const r of roles) if (r.permissions.includes(MOVE_WORD)) moving.add(r.roleId);
  if (moving.size === 0) return { kind: 'none' };
  if ([...moving].some((r) => NARROWED_MOVEMENT_ROLES[r] === undefined)) return { kind: 'any' };
  const jobs = [...new Set([...moving].flatMap((r) => NARROWED_MOVEMENT_ROLES[r] ?? []))];
  return { kind: 'narrowed', roles: [...moving].sort(), jobs };
}

/** May a person with this reach do this kind of stock work? (`none` never; `any` always; narrowed: only their kinds.) */
export function reachAllows(reach: MovementReach, job: MovementJob): boolean {
  if (reach.kind === 'none') return false;
  if (reach.kind === 'any') return true;
  return reach.jobs.includes(job);
}
