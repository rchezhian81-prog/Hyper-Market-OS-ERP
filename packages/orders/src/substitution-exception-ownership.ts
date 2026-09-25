// Ownership, SLA and escalation for delivery-substitution exceptions (M19 / D09, owner decision).
//
// `substitution-exceptions.ts` DERIVES the worklist — the money and short-pick exceptions a batch of
// substitutions produced. This layer answers the owner's question: **whose job is each one, by when,
// and what happens if nobody works it?** The owner's approved model:
//
//   • the PICKER proposes a substitute but never OWNS the approval of a restricted exception;
//   • the primary owner is the FULFILMENT / online-order SUPERVISOR;
//   • a customer-contact exception (the customer got less than they ordered) belongs to the
//     CUSTOMER-SERVICE / online-order desk;
//   • a financial exception (money owed, collected, or charged above the original) belongs to the
//     FINANCE / payment-reconciliation queue;
//   • the final escalation is the STORE / duty manager.
//
// The rules this engine keeps:
//   • every exception is routed to a ROLE QUEUE, never to a person — so **nothing disappears when a
//     shift ends or an employee loses access**; a claimed item can always be released back to its
//     queue and reassigned;
//   • SLA timers make a stale exception VISIBLE (age vs the owner's policy → breached), and a breach
//     escalates to the next owner — surfaced, never dropped (P-08);
//   • a picker cannot approve a restricted exception (SoD, §28);
//   • every routing, claim, reassignment, escalation and resolution is an APPEND-ONLY audit event on
//     the item (hard rule #2 / #6) — the trail of who did what, and who it waited on.
//
// Pure and deterministic: the clock is injected, there is no I/O; the caller persists the items.

import type { SubstitutionException, SubstitutionExceptionKind } from './substitution-exceptions';

/** The role queues an exception can sit in. */
export type ExceptionOwnerRole =
  | 'fulfilment_supervisor'
  | 'customer_service_desk'
  | 'finance_recon_queue'
  | 'duty_manager';

/** The picker proposes; they are never an owner of an exception's approval. */
export type ProposerRole = 'picker';

/** Where each owner escalates on an SLA breach; `duty_manager` is terminal. */
const ESCALATES_TO: Readonly<Record<ExceptionOwnerRole, ExceptionOwnerRole | undefined>> = Object.freeze({
  customer_service_desk: 'fulfilment_supervisor',
  finance_recon_queue: 'duty_manager',
  fulfilment_supervisor: 'duty_manager',
  duty_manager: undefined,
});

/** Which queue a kind belongs to. Money → finance; a short-picked line (customer got less) → the
 *  customer desk; anything else is the supervisor's, the primary owner. */
export function ownerForKind(kind: SubstitutionExceptionKind): ExceptionOwnerRole {
  switch (kind) {
    case 'refund_due':
    case 'collect_adjustment':
    case 'above_cap_charge':
      return 'finance_recon_queue';
    case 'policy_short_pick':
      return 'customer_service_desk';
    default:
      return 'fulfilment_supervisor';
  }
}

const DEFAULT_REASON_CODE: Readonly<Record<SubstitutionExceptionKind, string>> = Object.freeze({
  refund_due: 'SUB-REFUND-DUE',
  collect_adjustment: 'SUB-COLLECT-ADJUST',
  above_cap_charge: 'SUB-ABOVE-CAP',
  policy_short_pick: 'SUB-SHORT-PICK',
});

/** Per-owner SLA in minutes — a customer waiting to be told is the most urgent. */
export interface ExceptionSlaPolicy {
  readonly slaMinutesByOwner: Readonly<Record<ExceptionOwnerRole, number>>;
}

export const DEFAULT_SLA: ExceptionSlaPolicy = Object.freeze({
  slaMinutesByOwner: Object.freeze({
    customer_service_desk: 30,
    fulfilment_supervisor: 60,
    finance_recon_queue: 120,
    duty_manager: 240,
  }),
});

export type ExceptionOp = 'routed' | 'claimed' | 'reassigned' | 'escalated' | 'released' | 'resolved' | 'resolve_refused';

export interface ExceptionAuditEvent {
  readonly op: ExceptionOp;
  readonly at: string;
  readonly by: string;
  readonly toOwner?: ExceptionOwnerRole;
  readonly assignedTo?: string;
  readonly reasonCode?: string;
  readonly detail?: string;
}

export type ExceptionState = 'open' | 'in_progress' | 'resolved';

export interface OwnedException {
  readonly exceptionId: string;
  readonly tenantId: string;
  readonly orderId: string;
  readonly lineId: string;
  readonly kind: SubstitutionExceptionKind;
  readonly amountMinor: number;
  readonly reasonCode: string;
  readonly owner: ExceptionOwnerRole;
  readonly state: ExceptionState;
  readonly raisedAt: string;
  /** The named person currently working it, if any. Absent = sitting in the role queue. */
  readonly assignedTo?: string;
  /** The picker who proposed the substitution that raised this — recorded, never the approver. */
  readonly proposedBy?: string;
  readonly history: readonly ExceptionAuditEvent[];
}

const append = (owned: OwnedException, event: ExceptionAuditEvent): OwnedException =>
  ({ ...owned, history: [...owned.history, event] });

/** Route a derived exception into its owner's queue as a durable, owned item. */
export function routeException(input: {
  readonly exception: SubstitutionException;
  readonly tenantId: string;
  readonly exceptionId: string;
  readonly raisedAt: string;
  readonly by: string;
  readonly proposedBy?: string;
  readonly reasonCode?: string;
}): OwnedException {
  const owner = ownerForKind(input.exception.kind);
  const reasonCode = input.reasonCode ?? DEFAULT_REASON_CODE[input.exception.kind];
  return {
    exceptionId: input.exceptionId,
    tenantId: input.tenantId,
    orderId: input.exception.orderId,
    lineId: input.exception.lineId,
    kind: input.exception.kind,
    amountMinor: input.exception.amountMinor,
    reasonCode,
    owner,
    state: 'open',
    raisedAt: input.raisedAt,
    ...(input.proposedBy === undefined ? {} : { proposedBy: input.proposedBy }),
    history: [{ op: 'routed', at: input.raisedAt, by: input.by, toOwner: owner, reasonCode, detail: input.exception.detail }],
  };
}

export interface SlaStatus {
  readonly ageMinutes: number;
  readonly dueAt: string;
  readonly breached: boolean;
}

/** Age against the owner's SLA. A resolved item never reads as breached — its clock has stopped. */
export function slaStatus(owned: OwnedException, policy: ExceptionSlaPolicy, now: string): SlaStatus {
  const sla = policy.slaMinutesByOwner[owned.owner];
  const ageMinutes = (Date.parse(now) - Date.parse(owned.raisedAt)) / 60_000;
  const dueAt = new Date(Date.parse(owned.raisedAt) + sla * 60_000).toISOString();
  return { ageMinutes, dueAt, breached: owned.state !== 'resolved' && ageMinutes > sla };
}

/** A named person claims an item from the queue to work it. */
export function claim(owned: OwnedException, person: string, now: string): OwnedException {
  const claimed: OwnedException = { ...owned, assignedTo: person, state: owned.state === 'open' ? 'in_progress' : owned.state };
  return append(claimed, { op: 'claimed', at: now, by: person, assignedTo: person });
}

/** Release a claimed item back to its role queue — e.g. a shift ended or access was lost. It never
 *  vanishes: it returns to `open` under the same owner, workable by anyone in that role. */
export function release(owned: OwnedException, by: string, now: string, reasonCode?: string): OwnedException {
  const released: OwnedException = { ...owned, assignedTo: undefined, state: owned.state === 'resolved' ? owned.state : 'open' };
  return append(released, { op: 'released', at: now, by, ...(reasonCode === undefined ? {} : { reasonCode }) });
}

/** Reassign to a different owner queue (a deliberate move, with a reason). Clears any personal claim. */
export function reassign(owned: OwnedException, toOwner: ExceptionOwnerRole, by: string, now: string, reasonCode: string): OwnedException {
  const moved: OwnedException = { ...owned, owner: toOwner, assignedTo: undefined, state: 'open' };
  return append(moved, { op: 'reassigned', at: now, by, toOwner, reasonCode });
}

export interface EscalationResult {
  readonly escalated: boolean;
  readonly owned: OwnedException;
}

/** Escalate a BREACHED item to the next owner. A within-SLA item is left alone; a duty-manager item
 *  has nowhere higher to go, so it stays (and remains visible) rather than being dropped. */
export function escalate(owned: OwnedException, policy: ExceptionSlaPolicy, now: string, by: string): EscalationResult {
  if (owned.state === 'resolved') return { escalated: false, owned };
  if (!slaStatus(owned, policy, now).breached) return { escalated: false, owned };
  const next = ESCALATES_TO[owned.owner];
  if (next === undefined) return { escalated: false, owned };
  const breachedSla = policy.slaMinutesByOwner[owned.owner];
  const moved: OwnedException = { ...owned, owner: next, assignedTo: undefined, state: 'open' };
  return { escalated: true, owned: append(moved, { op: 'escalated', at: now, by, toOwner: next, detail: `past ${breachedSla}m SLA` }) };
}

/** Sweep a set of items, escalating every breached one. Returns the updated set + the ids escalated. */
export function sweepEscalations(
  owneds: readonly OwnedException[],
  policy: ExceptionSlaPolicy,
  now: string,
  by: string,
): { readonly owneds: readonly OwnedException[]; readonly escalatedIds: readonly string[] } {
  const escalatedIds: string[] = [];
  const updated = owneds.map((o) => {
    const r = escalate(o, policy, now, by);
    if (r.escalated) escalatedIds.push(o.exceptionId);
    return r.owned;
  });
  return { owneds: updated, escalatedIds };
}

/** A picker can propose but never approve a restricted exception (SoD, §28). Any owner role may. */
export function mayApprove(role: ExceptionOwnerRole | ProposerRole): boolean {
  return role !== 'picker';
}

export type ResolveRefusal = 'picker_may_not_approve' | 'already_resolved';

export interface ResolveResult {
  readonly resolved: boolean;
  readonly owned: OwnedException;
  readonly refusal?: ResolveRefusal;
}

/** Resolve (approve/close) an exception. A picker is refused (the refusal is recorded — P-08). */
export function resolveException(input: {
  readonly owned: OwnedException;
  readonly by: string;
  readonly byRole: ExceptionOwnerRole | ProposerRole;
  readonly now: string;
  readonly reasonCode?: string;
  readonly detail?: string;
}): ResolveResult {
  if (!mayApprove(input.byRole)) {
    return {
      resolved: false,
      refusal: 'picker_may_not_approve',
      owned: append(input.owned, { op: 'resolve_refused', at: input.now, by: input.by, detail: 'a picker may not approve a restricted exception' }),
    };
  }
  if (input.owned.state === 'resolved') return { resolved: false, refusal: 'already_resolved', owned: input.owned };
  const resolved: OwnedException = { ...input.owned, state: 'resolved' };
  return {
    resolved: true,
    owned: append(resolved, { op: 'resolved', at: input.now, by: input.by, toOwner: input.owned.owner, ...(input.reasonCode === undefined ? {} : { reasonCode: input.reasonCode }), ...(input.detail === undefined ? {} : { detail: input.detail }) }),
  };
}

/**
 * The open worklist for one owner queue, within one tenant — worst (largest money) first, then oldest,
 * so the most valuable and the most stale rise to the top. Resolved items never appear.
 */
export function queueFor(
  owneds: readonly OwnedException[],
  tenantId: string,
  ownerRole: ExceptionOwnerRole,
): readonly OwnedException[] {
  return owneds
    .filter((o) => o.tenantId === tenantId && o.owner === ownerRole && o.state !== 'resolved')
    .slice()
    .sort((a, b) => (b.amountMinor - a.amountMinor) || (Date.parse(a.raisedAt) - Date.parse(b.raisedAt)) || a.exceptionId.localeCompare(b.exceptionId));
}
