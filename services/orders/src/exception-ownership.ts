// Delivery-substitution exception OWNERSHIP on the cloud (M19-FR-01 / D09 · owner decision "Item 2" · P-08 · §28 · hard rules #2 #6).
//
// `substitutionExceptions` DERIVES the shop-wide worklist from the recorded swaps — the money and short-pick
// exceptions, worst first. The pure ownership engine (`packages/orders/src/substitution-exception-ownership.ts`)
// answers the owner's question about each one: whose job is it, by when, and what happens if nobody works it.
// This module puts that engine on the API and keeps its state:
//
//   • the worklist read now carries OWNERSHIP — each exception's role queue, state, who holds it, its SLA
//     (age, due, breached) and its full audit history. An exception nobody has touched is routed on the
//     fly from the swap it came from (deterministic, so a read writes nothing); the moment a person acts on
//     it, the owned item is KEPT — append-only, latest per exception, restart-safe;
//   • claim / release / reassign / resolve are the human moves. A picker proposes but never approves: the
//     approval routes are held by the desk, finance and management roles, never by the picker, and a caller
//     may resolve only an exception sitting in a queue THEIR role staffs (the duty manager staffs them all);
//   • the escalation sweep moves every breached, unresolved exception to the next owner and reports which
//     — nowhere to go (the duty manager is terminal) is reported, never dropped.
//
// What is NOT here: no money moves. Resolving an exception records that a person has dealt with it; the
// refund itself is issued on the refund surface (`payments.ts`) by someone holding that permission.
import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import { substitutionExceptions, type SubstitutionRecordView, type SubstitutionException } from '../../../packages/orders/src/substitution-exceptions';
import {
  routeException, slaStatus, claim, release, reassign, sweepEscalations, resolveException, DEFAULT_SLA,
  type OwnedException, type ExceptionOwnerRole, type ExceptionSlaPolicy,
} from '../../../packages/orders/src/substitution-exception-ownership';
import type { OrdersDeps, StoredSubstitution } from './index';

export interface ExceptionOwnershipDeps {
  /** Every owned exception the tenant has acted on — latest per exception id. */
  readonly ownedExceptions: (tenantId: string) => Promise<readonly OwnedException[]> | readonly OwnedException[];
  /** Keep the item after a human move — append-only, keyed on the item's history length so a replay lands once. */
  readonly recordOwnedException: (tenantId: string, owned: OwnedException) => Promise<void> | void;
  /** The catalogue roles the caller holds in this tenant, from the append-only grant history. */
  readonly rolesOf: (tenantId: string, userId: string) => Promise<readonly string[]> | readonly string[];
  /** The SLA policy — the engine's default until a tenant sets its own. */
  readonly exceptionSla?: (tenantId: string) => Promise<ExceptionSlaPolicy> | ExceptionSlaPolicy;
}

export const OWNER_ROLES: readonly ExceptionOwnerRole[] = ['fulfilment_supervisor', 'customer_service_desk', 'finance_recon_queue', 'duty_manager'];

/**
 * Which exception queues a catalogue role STAFFS. The owner's approved model names the queues (Item 2); this is
 * the standing arrangement in a single-store deployment: management works every queue and is the terminal
 * owner; the accountant is the finance / payment-reconciliation queue; the service-desk (cashier) staff are the
 * customer-service desk. Written in one place so the owner can change who staffs what without touching a route.
 */
export const QUEUES_STAFFED_BY: Readonly<Record<string, readonly ExceptionOwnerRole[]>> = Object.freeze({
  owner: OWNER_ROLES,
  store_manager: OWNER_ROLES,
  accountant: ['finance_recon_queue'],
  chartered_accountant: ['finance_recon_queue'],
  cashier: ['customer_service_desk'],
});

export function queuesStaffedBy(roleIds: readonly string[]): readonly ExceptionOwnerRole[] {
  const set = new Set<ExceptionOwnerRole>();
  for (const r of roleIds) for (const q of QUEUES_STAFFED_BY[r] ?? []) set.add(q);
  return OWNER_ROLES.filter((q) => set.has(q));
}

/** The exception's identity — deterministic from the swap it came from, so stored ownership always re-attaches.
 *  Colon-joined so it travels as ONE path segment (a slash would split it into three). */
export const exceptionIdFor = (e: Pick<SubstitutionException, 'orderId' | 'lineId' | 'kind'>): string => `${e.orderId}:${e.lineId}:${e.kind}`;

export interface OwnedExceptionView extends SubstitutionException {
  readonly exceptionId: string;
  readonly owner: ExceptionOwnerRole;
  readonly state: OwnedException['state'];
  readonly assignedTo?: string;
  readonly proposedBy?: string;
  readonly reasonCode: string;
  readonly raisedAt: string;
  readonly sla: ReturnType<typeof slaStatus>;
  readonly history: OwnedException['history'];
}

export interface OwnedWorklist {
  readonly exceptions: readonly OwnedExceptionView[];
  /** The engine's own totals over every derived exception (kept for the read's existing consumers). */
  readonly count: number;
  readonly atRiskMinor: number;
  /** What is still OPEN — the figures a supervisor acts on. */
  readonly open: { readonly count: number; readonly atRiskMinor: number; readonly breached: number };
  readonly queues: Readonly<Record<ExceptionOwnerRole, number>>;
}

const viewOf = (s: StoredSubstitution): SubstitutionRecordView => ({
  orderId: s.orderId,
  lineId: s.lineId,
  outcome: s.outcome,
  refundMinor: s.refundMinor,
  ...(s.eligibility !== undefined ? { eligibility: s.eligibility } : {}),
  ...(s.settlementKind !== undefined ? { settlementKind: s.settlementKind } : {}),
  ...(s.settlementMinor !== undefined ? { settlementMinor: s.settlementMinor } : {}),
  ...(s.aboveCap !== undefined ? { aboveCap: s.aboveCap } : {}),
});

/**
 * Every derived exception as an OWNED item: the kept one when a person has acted on it, otherwise routed on the
 * fly from the swap (raised when the swap was recorded — an exception is as old as the decision that caused it).
 */
export async function ownedWorklist(deps: OrdersDeps & ExceptionOwnershipDeps, tenantId: string, now: string): Promise<{ readonly items: readonly OwnedException[]; readonly derived: ReturnType<typeof substitutionExceptions>; readonly policy: ExceptionSlaPolicy }> {
  const subs = await deps.allSubstitutions(tenantId);
  const derived = substitutionExceptions(subs.map(viewOf));
  const kept = new Map((await deps.ownedExceptions(tenantId)).map((o) => [o.exceptionId, o] as const));
  const policy = deps.exceptionSla === undefined ? DEFAULT_SLA : await deps.exceptionSla(tenantId);
  const items = derived.exceptions.map((e) => {
    const id = exceptionIdFor(e);
    const held = kept.get(id);
    if (held !== undefined) return held;
    const swap = subs.find((s) => s.orderId === e.orderId && s.lineId === e.lineId);
    return routeException({ exception: e, tenantId, exceptionId: id, raisedAt: swap?.at ?? now, by: 'system' });
  });
  return { items, derived, policy };
}

export function presentWorklist(items: readonly OwnedException[], derived: ReturnType<typeof substitutionExceptions>, policy: ExceptionSlaPolicy, now: string): OwnedWorklist {
  const byId = new Map(derived.exceptions.map((e) => [exceptionIdFor(e), e] as const));
  const exceptions: OwnedExceptionView[] = items.map((o) => {
    const e = byId.get(o.exceptionId);
    return {
      orderId: o.orderId, lineId: o.lineId, kind: o.kind, amountMinor: o.amountMinor,
      detail: e?.detail ?? o.history[0]?.detail ?? '',
      exceptionId: o.exceptionId, owner: o.owner, state: o.state,
      ...(o.assignedTo === undefined ? {} : { assignedTo: o.assignedTo }),
      ...(o.proposedBy === undefined ? {} : { proposedBy: o.proposedBy }),
      reasonCode: o.reasonCode, raisedAt: o.raisedAt,
      sla: slaStatus(o, policy, now),
      history: o.history,
    };
  });
  const open = exceptions.filter((x) => x.state !== 'resolved');
  const queues = Object.fromEntries(OWNER_ROLES.map((q) => [q, open.filter((x) => x.owner === q).length])) as Record<ExceptionOwnerRole, number>;
  return {
    exceptions,
    count: derived.count,
    atRiskMinor: derived.atRiskMinor,
    open: { count: open.length, atRiskMinor: open.reduce((s, x) => s + x.amountMinor, 0), breached: open.filter((x) => x.sla.breached).length },
    queues,
  };
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isOwnerRole = (v: unknown): v is ExceptionOwnerRole => typeof v === 'string' && (OWNER_ROLES as readonly string[]).includes(v);

export function exceptionOwnershipRoutes(deps: OrdersDeps & ExceptionOwnershipDeps): readonly Route[] {
  const find = async (tenantId: string, exceptionId: string, now: string): Promise<{ owned: OwnedException; policy: ExceptionSlaPolicy }> => {
    const { items, policy } = await ownedWorklist(deps, tenantId, now);
    const owned = items.find((o) => o.exceptionId === exceptionId);
    if (owned === undefined) {
      throw apiError(404, {
        code: 'exception_unknown',
        whatHappened: `No substitution exception "${exceptionId}" exists in this shop's worklist.`,
        wasItSaved: 'not_saved',
        nextSafeAction: 'Read GET /v1/orders/substitution-exceptions for the current worklist. Nothing was changed.',
      });
    }
    return { owned, policy };
  };
  // A caller may work an item only from a queue their role staffs — the duty manager staffs them all.
  const mustStaff = async (tenantId: string, userId: string, owned: OwnedException): Promise<ExceptionOwnerRole> => {
    const queues = queuesStaffedBy(await deps.rolesOf(tenantId, userId));
    if (queues.includes(owned.owner)) return owned.owner;
    if (queues.includes('duty_manager')) return 'duty_manager';
    throw apiError(422, {
      code: 'not_your_queue',
      whatHappened: `This exception sits in the ${owned.owner.replace(/_/g, ' ')} queue, which your role does not staff${queues.length === 0 ? ' (your role staffs no exception queue)' : ` (you staff: ${queues.join(', ')})`}.`,
      wasItSaved: 'not_saved',
      nextSafeAction: 'Ask a manager to reassign it to your queue, or leave it for the queue that owns it. Nothing was changed.',
    });
  };
  const keepAndPresent = async (tenantId: string, owned: OwnedException, policy: ExceptionSlaPolicy, now: string, status = 200): Promise<{ status: number; body: unknown }> => {
    await deps.recordOwnedException(tenantId, owned);
    return { status, body: { exception: { ...owned, sla: slaStatus(owned, policy, now) } } };
  };

  return [
    // The tenant-wide worklist WITH ownership (M19-FR-01, P-08): every swap that owes money, needs a COD
    // adjustment, was charged above cap or was left short — worst first — each with its queue, holder, SLA and
    // history. Gated `order.read` as before (a management view of money-at-risk). Registered BEFORE
    // `/v1/orders/:orderId` so the literal path is never captured as an order id.
    {
      api: 'API-07', method: 'GET', path: '/v1/orders/substitution-exceptions',
      permission: 'order.read',
      handler: async (ctx) => {
        const now = deps.now();
        const { items, derived, policy } = await ownedWorklist(deps, ctx.tenantId, now);
        return { status: 200, body: presentWorklist(items, derived, policy, now) };
      },
    },
    // One role's open queue, worst first — what a desk or the finance recon queue works from.
    {
      api: 'API-07', method: 'GET', path: '/v1/orders/substitution-exceptions/queue/:owner',
      permission: 'order.exception.work',
      handler: async (ctx) => {
        const owner = ctx.params['owner'];
        if (!isOwnerRole(owner)) {
          throw apiError(400, {
            code: 'unknown_queue',
            whatHappened: `"${String(owner)}" is not an exception queue. The queues are: ${OWNER_ROLES.join(', ')}.`,
            wasItSaved: 'not_saved', nextSafeAction: 'Use one of the named queues. Nothing was changed.',
          });
        }
        const now = deps.now();
        const { items, derived, policy } = await ownedWorklist(deps, ctx.tenantId, now);
        const all = presentWorklist(items, derived, policy, now);
        const queue = all.exceptions.filter((x) => x.owner === owner && x.state !== 'resolved');
        return { status: 200, body: { owner, exceptions: queue, count: queue.length, atRiskMinor: queue.reduce((s, x) => s + x.amountMinor, 0), breached: queue.filter((x) => x.sla.breached).length } };
      },
    },
    // Claim: a named person takes the item off the queue — it stays visible, now as in_progress under their name.
    {
      api: 'API-07', method: 'POST', path: '/v1/orders/substitution-exceptions/:exceptionId/claim',
      permission: 'order.exception.work', idempotent: true,
      handler: async (ctx) => {
        const now = deps.now();
        const { owned, policy } = await find(ctx.tenantId, ctx.params['exceptionId'] ?? '', now);
        await mustStaff(ctx.tenantId, ctx.userId, owned);
        if (owned.state === 'resolved') {
          throw apiError(409, { code: 'already_resolved', whatHappened: 'This exception has already been resolved; there is nothing to claim.', wasItSaved: 'not_saved', nextSafeAction: 'Nothing to do.' });
        }
        return keepAndPresent(ctx.tenantId, claim(owned, ctx.userId, now), policy, now);
      },
    },
    // Release: back to the role queue — the move that makes a shift end or a lost login harmless.
    {
      api: 'API-07', method: 'POST', path: '/v1/orders/substitution-exceptions/:exceptionId/release',
      permission: 'order.exception.work', idempotent: true,
      handler: async (ctx) => {
        const now = deps.now();
        const { owned, policy } = await find(ctx.tenantId, ctx.params['exceptionId'] ?? '', now);
        await mustStaff(ctx.tenantId, ctx.userId, owned);
        const reason = isObj(ctx.body) && isStr(ctx.body['reasonCode']) ? ctx.body['reasonCode'] : undefined;
        return keepAndPresent(ctx.tenantId, release(owned, ctx.userId, now, reason), policy, now);
      },
    },
    // Reassign to another queue — a management move, with a written reason.
    {
      api: 'API-07', method: 'POST', path: '/v1/orders/substitution-exceptions/:exceptionId/reassign',
      permission: 'order.exception.manage', idempotent: true,
      handler: async (ctx) => {
        const b = ctx.body;
        if (!isObj(b) || !isOwnerRole(b['toOwner']) || !isStr(b['reasonCode'])) {
          throw apiError(400, {
            code: 'not_readable_as_a_reassignment',
            whatHappened: `A reassignment needs { toOwner: one of ${OWNER_ROLES.join(' | ')}, reasonCode }.`,
            wasItSaved: 'not_saved', nextSafeAction: 'Send the queue to move it to and why. Nothing was changed.',
          });
        }
        const now = deps.now();
        const { owned, policy } = await find(ctx.tenantId, ctx.params['exceptionId'] ?? '', now);
        if (owned.state === 'resolved') {
          throw apiError(409, { code: 'already_resolved', whatHappened: 'This exception has already been resolved; it cannot be reassigned.', wasItSaved: 'not_saved', nextSafeAction: 'Nothing to do.' });
        }
        return keepAndPresent(ctx.tenantId, reassign(owned, b['toOwner'], ctx.userId, now, b['reasonCode']), policy, now);
      },
    },
    // Resolve: a person from the owning queue records that it has been dealt with. SoD: the engine refuses a
    // picker and RECORDS the refusal; the route refuses a caller from the wrong queue before that (422).
    {
      api: 'API-07', method: 'POST', path: '/v1/orders/substitution-exceptions/:exceptionId/resolve',
      permission: 'order.exception.work', idempotent: true,
      handler: async (ctx) => {
        const now = deps.now();
        const { owned, policy } = await find(ctx.tenantId, ctx.params['exceptionId'] ?? '', now);
        const byRole = await mustStaff(ctx.tenantId, ctx.userId, owned);
        const b = isObj(ctx.body) ? ctx.body : {};
        const result = resolveException({
          owned, by: ctx.userId, byRole, now,
          ...(isStr(b['reasonCode']) ? { reasonCode: b['reasonCode'] } : {}),
          ...(isStr(b['detail']) ? { detail: b['detail'] } : {}),
        });
        if (!result.resolved) {
          if (result.refusal === 'picker_may_not_approve') await deps.recordOwnedException(ctx.tenantId, result.owned); // the refusal is on the record
          throw apiError(result.refusal === 'already_resolved' ? 409 : 403, {
            code: result.refusal ?? 'not_resolved',
            whatHappened: result.refusal === 'already_resolved' ? 'This exception was already resolved.' : 'A picker proposes a substitute but never approves the exception it raised (§28). This attempt was recorded on the item.',
            wasItSaved: result.refusal === 'already_resolved' ? 'not_saved' : 'saved',
            nextSafeAction: 'Nothing else changed.',
          });
        }
        return keepAndPresent(ctx.tenantId, result.owned, policy, now);
      },
    },
    // The escalation sweep: every breached, unresolved exception moves to the next owner; which ones are named.
    {
      api: 'API-07', method: 'POST', path: '/v1/orders/substitution-exceptions/escalate',
      permission: 'order.exception.manage', idempotent: true,
      handler: async (ctx) => {
        const now = deps.now();
        const { items, policy } = await ownedWorklist(deps, ctx.tenantId, now);
        const swept = sweepEscalations(items, policy, now, ctx.userId);
        const moved = swept.owneds.filter((o) => swept.escalatedIds.includes(o.exceptionId));
        for (const o of moved) await deps.recordOwnedException(ctx.tenantId, o);
        const stuck = items.filter((o) => o.state !== 'resolved' && o.owner === 'duty_manager' && slaStatus(o, policy, now).breached).map((o) => o.exceptionId);
        return {
          status: 200,
          body: {
            escalatedIds: swept.escalatedIds,
            escalated: moved.map((o) => ({ exceptionId: o.exceptionId, toOwner: o.owner, amountMinor: o.amountMinor })),
            /** Breached at the terminal owner — nowhere further to go; reported, never dropped (P-08). */
            breachedAtDutyManager: stuck,
            detail: swept.escalatedIds.length === 0 ? 'nothing is past its SLA' : `${swept.escalatedIds.length} exception(s) moved to the next owner`,
          },
        };
      },
    },
  ];
}
