// Approval delegation (M02-FR-03 remainder / §28 / P-04 / hard rule #4).
//
// The manager goes on leave and the shop still needs refunds authorised. Every business
// solves this, and most solve it the same way: **they share the login.** That is the single
// most damaging control failure in retail, because it does not merely break separation of
// duties — it erases the audit trail. Once two people use one account, nothing that account
// did can be attributed to anybody, retrospectively, forever.
//
// So delegation exists to make the honest route easier than the dishonest one. It is not a
// convenience; it is the thing that stops the shared password.
//
//   • **A DELEGATE ACTS AS THEMSELVES.** The decision records the delegate's own user id and
//     names whose authority they exercised. Never the absent manager's name (hard rule #4).
//   • **DELEGATION IS TIME-BOXED AND ITS END DATE IS REAL.** "Until further notice" is a
//     permanent privilege escalation that nobody remembers granting. An expired delegation
//     stops working on its own.
//   • **YOU CANNOT DELEGATE MORE THAN YOU HOLD.** A ₹50,000 approver cannot hand somebody
//     ₹2,00,000 of authority, and cannot widen a branch scope beyond their own.
//   • **DELEGATION DOES NOT LAUNDER SEPARATION OF DUTIES.** The maker still cannot approve
//     their own request, and a delegation *to* the maker is refused — that is the loophole
//     this whole control exists to close, and it is the one somebody will try.
//   • **NO CHAINS.** A delegate cannot re-delegate. Two hops in and nobody can say who was
//     actually accountable, which is the state delegation was supposed to prevent.
//
// Pure and deterministic: the clock is injected, no I/O.

import { compare, type Money } from '../../contracts/src/money';
import type { Approver, ApprovalRequest, DecidedRequest, Decision } from './approvals';

export interface Delegation {
  readonly delegationId: string;
  /** Whose authority is being lent. */
  readonly fromUserId: string;
  /** Who may exercise it. Acts as THEMSELVES, under this authority. */
  readonly toUserId: string;
  /** Inclusive first day, YYYY-MM-DD. */
  readonly fromDate: string;
  /** Inclusive last day. Never open-ended. */
  readonly untilDate: string;
  /** Subject types covered, e.g. ["refund", "price_change"]. Empty means none, not all. */
  readonly subjectTypes: readonly string[];
  /** Optional cap below the granter's own limit. Never above it. */
  readonly valueCap?: Money | null;
  /** Optional narrowing of branch scope. Never a widening. */
  readonly branchScope?: readonly string[];
  readonly reason: string;
  /** Somebody senior signed this off. A self-granted delegation is not a delegation. */
  readonly authorisedBy: string;
  readonly revokedOn?: string;
}

export type DelegationRefusal =
  | 'no_reason'
  | 'not_authorised'
  | 'self_delegation'
  | 'open_ended'
  | 'backwards_dates'
  | 'too_long'
  | 'exceeds_granter_authority'
  | 'widens_branch_scope'
  | 'no_subject_types'
  | 'chain_forbidden';

export interface DelegationResult {
  readonly created: boolean;
  readonly refusal?: DelegationRefusal;
  readonly delegation?: Delegation;
  readonly detail: string;
}

/**
 * Grant a delegation — or refuse it.
 *
 * Every refusal here is a route somebody would otherwise take that ends in an unattributable
 * decision. The most important is `chain_forbidden`: a delegate re-delegating is two hops, and
 * two hops in nobody can say who was accountable — which is exactly the state delegation
 * exists to prevent.
 */
export function grantDelegation(input: {
  readonly delegation: Delegation;
  /** The granter's own authority, from the approver register. */
  readonly granter: Approver;
  /** Delegations already in force, to catch a chain. */
  readonly existing?: readonly Delegation[];
  /** Longest a delegation may run. Per-tenant. Default 90 days. */
  readonly maximumDays?: number;
  readonly today: string;
}): DelegationResult {
  const d = input.delegation;
  const refuse = (refusal: DelegationRefusal, detail: string): DelegationResult => ({ created: false, refusal, detail });

  if (d.reason.trim() === '') {
    return refuse('no_reason', 'a delegation with no reason is a privilege grant nobody can review later');
  }
  if (d.authorisedBy.trim() === '' || d.authorisedBy === d.fromUserId) {
    return refuse(
      'not_authorised',
      'a delegation needs a separate person to authorise it — somebody lending their own authority away unsupervised is how a limit quietly stops applying (§28)',
    );
  }
  if (d.fromUserId === d.toUserId) {
    return refuse('self_delegation', 'delegating to yourself changes nothing and hides the fact that it changed nothing');
  }
  if (d.untilDate.trim() === '') {
    return refuse('open_ended', '"until further notice" is a permanent privilege escalation that nobody remembers granting');
  }
  if (d.untilDate < d.fromDate) {
    return refuse('backwards_dates', 'the delegation ends before it starts');
  }
  if (d.subjectTypes.length === 0) {
    return refuse('no_subject_types', 'a delegation covering nothing is not a delegation — and an empty list must never be read as "everything"');
  }

  const days = Math.floor(
    (Date.parse(`${d.untilDate}T00:00:00Z`) - Date.parse(`${d.fromDate}T00:00:00Z`)) / 86_400_000,
  ) + 1;
  const maximum = input.maximumDays ?? 90;
  if (days > maximum) {
    return refuse(
      'too_long',
      `${days} days against a ${maximum}-day maximum — a delegation that outlasts the absence it covers is a permanent change of who holds authority`,
    );
  }

  // You cannot lend more than you hold.
  if (input.granter.authorityLimit !== null && d.valueCap != null) {
    if (compare(d.valueCap, input.granter.authorityLimit) > 0) {
      return refuse(
        'exceeds_granter_authority',
        `the cap exceeds ${d.fromUserId}'s own limit — nobody can hand out authority they do not have`,
      );
    }
  }
  if (input.granter.authorityLimit !== null && d.valueCap == null) {
    return refuse(
      'exceeds_granter_authority',
      `${d.fromUserId} has a value limit, so an uncapped delegation would grant MORE than they hold — set a cap at or below it`,
    );
  }

  if (d.branchScope !== undefined && input.granter.branchScope !== 'all') {
    const widened = d.branchScope.filter((b) => !input.granter.branchScope.includes(b));
    if (widened.length > 0) {
      return refuse(
        'widens_branch_scope',
        `${widened.join(', ')} ${widened.length === 1 ? 'is' : 'are'} outside ${d.fromUserId}'s own scope — a delegation narrows, it never widens`,
      );
    }
  }

  // No chains. Two hops in, nobody can say who was accountable.
  const granterIsThemselvesADelegate = (input.existing ?? []).some(
    (e) => e.toUserId === d.fromUserId && e.revokedOn === undefined && e.untilDate >= input.today,
  );
  if (granterIsThemselvesADelegate) {
    return refuse(
      'chain_forbidden',
      `${d.fromUserId} is currently acting under somebody else's delegation and cannot pass it on — two hops in, nobody can say who was accountable`,
    );
  }

  return {
    created: true,
    delegation: d,
    detail: `${d.toUserId} may decide ${d.subjectTypes.join(', ')} under ${d.fromUserId}'s authority from ${d.fromDate} to ${d.untilDate}, authorised by ${d.authorisedBy}`,
  };
}

export type EffectiveSource = 'own_authority' | 'delegated' | 'none';

export interface EffectiveAuthority {
  readonly userId: string;
  readonly source: EffectiveSource;
  readonly branchScope: readonly string[] | 'all';
  readonly authorityLimit: Money | null;
  /** Set when acting under somebody else's authority. Recorded on every decision. */
  readonly onBehalfOf?: string;
  readonly delegationId?: string;
  readonly detail: string;
}

/**
 * What may this person actually approve today?
 *
 * Their **own** authority wins where they have it; a delegation only adds what they do not
 * already hold. That ordering matters: a manager with their own ₹1,00,000 limit who is also a
 * delegate for a ₹50,000 approver must not be *reduced* to ₹50,000 — and, equally, must not
 * have the delegation quietly used to explain a decision they could have made themselves.
 *
 * The result carries `onBehalfOf` so the decision can record it. **The delegate's own name is
 * always the decider** (hard rule #4).
 */
export function effectiveAuthority(input: {
  readonly userId: string;
  readonly subjectType: string;
  readonly own?: Approver;
  readonly delegations: readonly Delegation[];
  readonly today: string;
}): EffectiveAuthority {
  if (input.own !== undefined) {
    return {
      userId: input.userId,
      source: 'own_authority',
      branchScope: input.own.branchScope,
      authorityLimit: input.own.authorityLimit,
      detail: `${input.userId} decides on their own authority`,
    };
  }

  const live = input.delegations
    .filter(
      (d) =>
        d.toUserId === input.userId &&
        d.revokedOn === undefined &&
        d.fromDate <= input.today &&
        d.untilDate >= input.today &&
        d.subjectTypes.includes(input.subjectType),
    )
    .sort((a, b) => a.delegationId.localeCompare(b.delegationId));

  const active = live[0];
  if (active === undefined) {
    const expired = input.delegations.filter(
      (d) => d.toUserId === input.userId && d.untilDate < input.today && d.subjectTypes.includes(input.subjectType),
    );
    return {
      userId: input.userId,
      source: 'none',
      branchScope: [],
      authorityLimit: null,
      detail:
        expired.length > 0
          ? `${input.userId} held a delegation for ${input.subjectType} until ${expired[0]!.untilDate} and it has expired — it stopped on its own, which is the point of an end date`
          : `${input.userId} has no authority over ${input.subjectType}`,
    };
  }

  return {
    userId: input.userId,
    source: 'delegated',
    branchScope: active.branchScope ?? 'all',
    authorityLimit: active.valueCap ?? null,
    onBehalfOf: active.fromUserId,
    delegationId: active.delegationId,
    detail: `${input.userId} decides on ${active.fromUserId}'s authority until ${active.untilDate}, and the decision is recorded in ${input.userId}'s own name`,
  };
}

export type DelegatedRefusal =
  | 'self_approval_forbidden'
  | 'delegation_to_maker_forbidden'
  | 'no_authority'
  | 'out_of_scope'
  | 'exceeds_authority'
  | 'reason_required';

export interface DelegatedDecision extends DecidedRequest {
  /** Whose authority was exercised. Absent when the decider acted on their own. */
  readonly onBehalfOf?: string;
  readonly delegationId?: string;
}

export type DelegatedOutcome =
  | { readonly ok: true; readonly request: DelegatedDecision }
  | { readonly ok: false; readonly refusal: DelegatedRefusal; readonly detail: string };

/**
 * Decide an approval request, possibly under a delegation.
 *
 * **Delegation never launders separation of duties.** Two refusals enforce that, and the second
 * is the one somebody will actually try: a manager going on leave delegates to the very person
 * whose requests need approving. That is not a delegation, it is a self-approval with an extra
 * step, and it is refused by name so the attempt is visible rather than merely blocked.
 */
export function decideWithDelegation(input: {
  readonly request: ApprovalRequest;
  readonly decidedBy: string;
  readonly decision: Decision;
  readonly reason: string;
  readonly authority: EffectiveAuthority;
  readonly at: string;
}): DelegatedOutcome {
  const r = input.request;

  if (input.decidedBy === r.requestedBy) {
    return {
      ok: false,
      refusal: 'self_approval_forbidden',
      detail: 'the person who raised this cannot decide it (§28)',
    };
  }
  // The loophole this control exists to close.
  if (input.authority.onBehalfOf === r.requestedBy) {
    return {
      ok: false,
      refusal: 'delegation_to_maker_forbidden',
      detail: `${input.decidedBy} is acting on ${r.requestedBy}'s authority to approve ${r.requestedBy}'s own request — that is a self-approval with an extra step`,
    };
  }
  if (input.reason.trim() === '') {
    return { ok: false, refusal: 'reason_required', detail: 'every decision carries a reason (audit)' };
  }
  if (input.authority.source === 'none') {
    return {
      ok: false,
      refusal: 'no_authority',
      detail: input.authority.detail,
    };
  }
  if (
    r.branchId !== null &&
    input.authority.branchScope !== 'all' &&
    !input.authority.branchScope.includes(r.branchId)
  ) {
    return { ok: false, refusal: 'out_of_scope', detail: `${input.decidedBy} may not approve in ${r.branchId}` };
  }
  if (r.value !== null && input.authority.authorityLimit !== null) {
    if (compare(r.value, input.authority.authorityLimit) > 0) {
      return {
        ok: false,
        refusal: 'exceeds_authority',
        detail:
          input.authority.source === 'delegated'
            ? `this exceeds the cap on ${input.authority.onBehalfOf}'s delegation — escalate rather than widen it`
            : `this exceeds ${input.decidedBy}'s own limit — escalate`,
      };
    }
  }

  return {
    ok: true,
    request: {
      id: r.id,
      subjectType: r.subjectType,
      subjectRef: r.subjectRef,
      requestedBy: r.requestedBy,
      branchId: r.branchId,
      value: r.value,
      status: input.decision,
      // ALWAYS the delegate's own name, never the absent manager's (hard rule #4).
      decidedBy: input.decidedBy,
      reason: input.reason,
      decidedAt: input.at,
      onBehalfOf: input.authority.onBehalfOf,
      delegationId: input.authority.delegationId,
    },
  };
}

export interface DelegationReviewRow {
  readonly delegationId: string;
  readonly fromUserId: string;
  readonly toUserId: string;
  readonly untilDate: string;
  readonly daysRemaining: number;
  readonly state: 'active' | 'expiring' | 'expired' | 'revoked';
  readonly detail: string;
}

/**
 * The standing-delegations review.
 *
 * The failure this catches is the quiet one: a delegation granted for a fortnight's leave in
 * March that nobody revoked, still live in August. It has not been *used* wrongly — it has just
 * become a permanent widening of who can authorise refunds, and it will never appear in any
 * incident, only in an audit.
 */
export function reviewDelegations(input: {
  readonly delegations: readonly Delegation[];
  /** Days ahead at which an expiry is flagged. Default 7. */
  readonly warnWithinDays?: number;
  readonly today: string;
}): readonly DelegationReviewRow[] {
  const warn = input.warnWithinDays ?? 7;

  return input.delegations
    .map((d): DelegationReviewRow => {
      const daysRemaining = Math.floor(
        (Date.parse(`${d.untilDate}T00:00:00Z`) - Date.parse(`${input.today}T00:00:00Z`)) / 86_400_000,
      );
      const state: DelegationReviewRow['state'] =
        d.revokedOn !== undefined
          ? 'revoked'
          : daysRemaining < 0
            ? 'expired'
            : daysRemaining <= warn
              ? 'expiring'
              : 'active';

      return {
        delegationId: d.delegationId,
        fromUserId: d.fromUserId,
        toUserId: d.toUserId,
        untilDate: d.untilDate,
        daysRemaining,
        state,
        detail:
          state === 'revoked'
            ? `revoked on ${d.revokedOn}`
            : state === 'expired'
              ? `ended ${-daysRemaining} day(s) ago and grants nothing — it stopped on its own`
              : state === 'expiring'
                ? `${d.toUserId} loses ${d.fromUserId}'s authority in ${daysRemaining} day(s) — renew it or let it lapse, but decide`
                : `${d.toUserId} holds ${d.fromUserId}'s authority for another ${daysRemaining} day(s) (${d.reason})`,
      };
    })
    .sort((a, b) => a.daysRemaining - b.daysRemaining || a.delegationId.localeCompare(b.delegationId));
}
