// Complaints, compensation, SLA and satisfaction (M21-FR-03 / M21-FR-04 / §28 / #5).
//
// A service desk that works is mostly a queue with two controls on it, and both are here
// because both are routinely missing:
//
//   • **COMPENSATION IS A FINANCIAL ACTION, SO IT NEEDS A SECOND PERSON** (§28). Goodwill
//     credit is real money leaving the business, given by the person the customer is
//     currently shouting at. Above the agent's own authority it escalates; below it, it
//     is still recorded with a reason. An agent who can hand out unlimited credit to end
//     a difficult call will, and the shop finds out at the month end.
//
//   • **AI DRAFTS, A HUMAN SENDS** (hard rule #5). A model may write the reply — it is
//     genuinely good at it and it saves an agent ten minutes — but the draft is
//     **never** sent by the system. `approveDraft` requires a named human, and there is
//     deliberately no function anywhere in this module that sends an unapproved draft.
//     A model apologising on the shop's behalf, inventing a refund it has no authority
//     to give, is a liability nobody signed up for.
//
// The SLA half is simpler and just as neglected: a breached SLA must **escalate
// visibly** (P-03/P-08) rather than sitting in a queue turning amber. And the clock is
// **paused while the shop is waiting on the customer** — otherwise every case where a
// customer takes three days to send a photo shows as the shop's failure, and the SLA
// report becomes something nobody trusts or acts on.
//
// Pure and deterministic: the clock is injected, nothing is sent from here.

export type CaseKind = 'complaint' | 'enquiry' | 'warranty' | 'lost_and_found';
export type CasePriority = 'low' | 'normal' | 'high' | 'urgent';
export type CaseState = 'open' | 'waiting_on_customer' | 'resolved' | 'closed';

export interface ServiceCase {
  readonly caseId: string;
  readonly tenantId: string;
  readonly kind: CaseKind;
  readonly customerRef: string;
  readonly openedAt: string;
  readonly assignedTo: string;
  readonly priority: CasePriority;
  readonly state: CaseState;
  readonly summary: string;
  /** Related order or product, so the desk is not working blind. */
  readonly orderRef?: string;
  /** When a human first replied. Absent means nobody has answered yet. */
  readonly firstRespondedAt?: string;
  readonly resolvedAt?: string;
  readonly resolution?: string;
  /** Total minutes the clock was paused waiting on the customer. */
  readonly waitingOnCustomerMinutes?: number;
}

export interface SlaPolicy {
  /** Minutes to first response, by priority. All per-tenant. */
  readonly firstResponseMinutes?: Partial<Record<CasePriority, number>>;
  /** Minutes to resolution, by priority. */
  readonly resolutionMinutes?: Partial<Record<CasePriority, number>>;
}

const DEFAULT_RESPONSE: Record<CasePriority, number> = { urgent: 30, high: 120, normal: 480, low: 1_440 };
const DEFAULT_RESOLUTION: Record<CasePriority, number> = { urgent: 240, high: 1_440, normal: 4_320, low: 10_080 };

export type SlaStatus = 'within' | 'at_risk' | 'breached' | 'met';

export interface SlaView {
  readonly caseId: string;
  readonly status: SlaStatus;
  /** Elapsed working minutes — excludes time waiting on the customer. */
  readonly elapsedMinutes: number;
  readonly targetMinutes: number;
  readonly remainingMinutes: number;
  readonly shouldEscalate: boolean;
  readonly detail: string;
}

/**
 * Assess a case against its **first-response** SLA, which is a different promise from
 * resolution and the one a customer actually feels. A desk that resolves every case
 * inside target while nobody replies for two days is failing in the way people notice,
 * and a single "SLA met" figure hides exactly that.
 */
export function assessFirstResponse(input: {
  readonly serviceCase: ServiceCase;
  readonly now: string;
  readonly policy?: SlaPolicy;
}): SlaView {
  const c = input.serviceCase;
  const targets = { ...DEFAULT_RESPONSE, ...(input.policy?.firstResponseMinutes ?? {}) };
  const targetMinutes = targets[c.priority];
  const end = c.firstRespondedAt ?? input.now;
  const elapsedMinutes = Math.max(0, Math.round((Date.parse(end) - Date.parse(c.openedAt)) / 60_000));
  const remainingMinutes = targetMinutes - elapsedMinutes;

  if (c.firstRespondedAt !== undefined) {
    return {
      caseId: c.caseId,
      status: elapsedMinutes <= targetMinutes ? 'met' : 'breached',
      elapsedMinutes,
      targetMinutes,
      remainingMinutes,
      shouldEscalate: false,
      detail:
        elapsedMinutes <= targetMinutes
          ? `first reply after ${elapsedMinutes} minutes, inside the ${targetMinutes}-minute target`
          : `first reply took ${elapsedMinutes} minutes against a ${targetMinutes}-minute target — the customer waited ${-remainingMinutes} minutes longer than promised`,
    };
  }

  // Nobody has replied yet. The first-response clock does NOT pause for the customer,
  // because the shop has not yet said anything for them to respond to.
  return {
    caseId: c.caseId,
    status: elapsedMinutes > targetMinutes ? 'breached' : elapsedMinutes >= targetMinutes * 0.8 ? 'at_risk' : 'within',
    elapsedMinutes,
    targetMinutes,
    remainingMinutes,
    shouldEscalate: elapsedMinutes > targetMinutes,
    detail:
      elapsedMinutes > targetMinutes
        ? `nobody has replied for ${elapsedMinutes} minutes against a ${targetMinutes}-minute target — this is the wait a customer actually feels`
        : `${remainingMinutes} minutes left to reply`,
  };
}

/**
 * Assess a case against its **resolution** SLA.
 *
 * **The clock pauses while the shop is waiting on the customer.** Without that, every
 * case where a customer takes three days to send a photo reads as the shop's failure,
 * the SLA report fills with breaches nobody caused, and within a month nobody looks at
 * it — which is the real damage, because the genuine breaches are in there too.
 */
export function assessSla(input: {
  readonly serviceCase: ServiceCase;
  readonly now: string;
  readonly policy?: SlaPolicy;
  /** Fraction of the target at which it is flagged at risk. Default 0.8. */
  readonly atRiskAt?: number;
}): SlaView {
  const c = input.serviceCase;
  const targets = { ...DEFAULT_RESOLUTION, ...(input.policy?.resolutionMinutes ?? {}) };
  const targetMinutes = targets[c.priority];
  const end = c.resolvedAt ?? input.now;
  const gross = Math.max(0, Math.round((Date.parse(end) - Date.parse(c.openedAt)) / 60_000));
  const elapsedMinutes = Math.max(0, gross - (c.waitingOnCustomerMinutes ?? 0));
  const remainingMinutes = targetMinutes - elapsedMinutes;

  if (c.state === 'resolved' || c.state === 'closed') {
    return {
      caseId: c.caseId,
      status: elapsedMinutes <= targetMinutes ? 'met' : 'breached',
      elapsedMinutes,
      targetMinutes,
      remainingMinutes,
      shouldEscalate: false,
      detail:
        elapsedMinutes <= targetMinutes
          ? `resolved in ${elapsedMinutes} working minutes against a ${targetMinutes}-minute target`
          : `resolved in ${elapsedMinutes} working minutes — ${-remainingMinutes} minutes over the target`,
    };
  }

  if (elapsedMinutes > targetMinutes) {
    return {
      caseId: c.caseId,
      status: 'breached',
      elapsedMinutes,
      targetMinutes,
      remainingMinutes,
      // Visible, not amber in a queue.
      shouldEscalate: true,
      detail: `${-remainingMinutes} minutes past the ${targetMinutes}-minute target — escalate now; a breach that sits in a queue is a breach nobody owns`,
    };
  }

  const atRisk = elapsedMinutes >= targetMinutes * (input.atRiskAt ?? 0.8);
  return {
    caseId: c.caseId,
    status: atRisk ? 'at_risk' : 'within',
    elapsedMinutes,
    targetMinutes,
    remainingMinutes,
    shouldEscalate: false,
    detail: atRisk
      ? `${remainingMinutes} minutes left of ${targetMinutes} — at risk`
      : `${remainingMinutes} minutes left of ${targetMinutes}`,
  };
}

export type CompensationKind = 'refund' | 'goodwill_credit' | 'loyalty_points' | 'replacement';

export interface CompensationApproval {
  readonly subjectRef: string;
  readonly status: 'approved' | 'rejected' | 'pending';
  readonly decidedBy: string;
  readonly reason: string;
}

export type CompensationOutcome =
  | 'granted'
  | 'needs_approval'
  | 'self_approved'
  | 'no_reason'
  | 'exceeds_policy_cap';

export interface CompensationResult {
  readonly caseId: string;
  readonly granted: boolean;
  readonly outcome: CompensationOutcome;
  readonly amountMinor: number;
  readonly detail: string;
  readonly approvedBy?: string;
}

/**
 * Grant compensation on a case. **Money leaving the business, decided by the person the
 * customer is currently shouting at** — which is why the authority limit and the second
 * signature are not optional.
 *
 * Even within an agent's own authority a **reason is mandatory**: "goodwill" explains
 * nothing three months later when the pattern is being investigated.
 */
export function grantCompensation(input: {
  readonly serviceCase: ServiceCase;
  readonly kind: CompensationKind;
  readonly amountMinor: number;
  readonly grantedBy: string;
  readonly reason: string;
  /** This agent's own authority. Above it, a separate approver is required. */
  readonly agentAuthorityMinor: number;
  /** The tenant's absolute ceiling — above this nobody at the desk may go. */
  readonly policyCapMinor?: number;
  readonly approval?: CompensationApproval;
  readonly at: string;
}): CompensationResult {
  const base = { caseId: input.serviceCase.caseId, amountMinor: input.amountMinor };

  if (input.reason.trim() === '') {
    return {
      ...base,
      granted: false,
      outcome: 'no_reason',
      detail: 'compensation needs a reason — "goodwill" explains nothing three months later',
    };
  }
  if (input.policyCapMinor !== undefined && input.amountMinor > input.policyCapMinor) {
    return {
      ...base,
      granted: false,
      outcome: 'exceeds_policy_cap',
      detail: `${input.amountMinor} is above the service desk's ceiling of ${input.policyCapMinor} — this is a management decision, not a desk one`,
    };
  }

  if (input.amountMinor > input.agentAuthorityMinor) {
    const a = input.approval;
    if (a === undefined || a.status !== 'approved' || a.subjectRef !== input.serviceCase.caseId) {
      return {
        ...base,
        granted: false,
        outcome: 'needs_approval',
        detail: `${input.amountMinor} is above ${input.grantedBy}'s authority of ${input.agentAuthorityMinor} — it needs a separate approver (§28)`,
      };
    }
    if (a.decidedBy === input.grantedBy) {
      return {
        ...base,
        granted: false,
        outcome: 'self_approved',
        detail: 'the agent granting compensation cannot be the one who approves it',
      };
    }
    return {
      ...base,
      granted: true,
      outcome: 'granted',
      approvedBy: a.decidedBy,
      detail: `${input.kind} of ${input.amountMinor} granted by ${input.grantedBy}, approved by ${a.decidedBy}: ${input.reason}`,
    };
  }

  return {
    ...base,
    granted: true,
    outcome: 'granted',
    detail: `${input.kind} of ${input.amountMinor} granted by ${input.grantedBy} within their own authority: ${input.reason}`,
  };
}

export interface AiDraft {
  readonly draftId: string;
  readonly caseId: string;
  readonly text: string;
  readonly modelRef: string;
  readonly generatedAt: string;
  /** Evidence the draft is based on — a reply citing nothing is not reviewable. */
  readonly evidenceRefs: readonly string[];
  /** Always false on creation. Only a named human changes it. */
  readonly approved: false;
}

export type DraftDecision = 'approved' | 'rejected' | 'edited_and_approved';

export interface ApprovedReply {
  readonly draftId: string;
  readonly caseId: string;
  readonly text: string;
  readonly decision: DraftDecision;
  /** The human who takes responsibility for the words. Never a model. */
  readonly approvedBy: string;
  readonly approvedAt: string;
  readonly modelRef: string;
  readonly sendable: true;
}

export interface DraftRefusal {
  readonly draftId: string;
  readonly sendable: false;
  readonly detail: string;
}

/**
 * Approve an AI-drafted reply. **This is the only way a draft becomes sendable**, and it
 * requires a named human — there is deliberately no `sendDraft` in this module, and a
 * test asserts that absence.
 *
 * An edit is recorded as an edit: knowing how often agents rewrite the model is how a
 * shop finds out whether the model is helping or generating work.
 */
export function approveDraft(input: {
  readonly draft: AiDraft;
  readonly decision: DraftDecision;
  readonly finalText?: string;
  readonly approvedBy: string;
  readonly at: string;
}): ApprovedReply | DraftRefusal {
  if (input.approvedBy.trim() === '') {
    return {
      draftId: input.draft.draftId,
      sendable: false,
      detail: 'a reply must be approved by a named person — a model does not answer a customer on the shop\'s behalf',
    };
  }
  if (input.decision === 'rejected') {
    return { draftId: input.draft.draftId, sendable: false, detail: `rejected by ${input.approvedBy}` };
  }
  if (input.draft.evidenceRefs.length === 0) {
    return {
      draftId: input.draft.draftId,
      sendable: false,
      detail: 'this draft cites no case evidence, so there is nothing for the approver to check it against',
    };
  }
  const text = input.decision === 'edited_and_approved' ? (input.finalText ?? '').trim() : input.draft.text;
  if (text === '') {
    return { draftId: input.draft.draftId, sendable: false, detail: 'an edited reply cannot be empty' };
  }

  return {
    draftId: input.draft.draftId,
    caseId: input.draft.caseId,
    text,
    decision: input.decision,
    approvedBy: input.approvedBy,
    approvedAt: input.at,
    modelRef: input.draft.modelRef,
    sendable: true,
  };
}

export interface SatisfactionScore {
  readonly caseId: string;
  readonly customerRef: string;
  /** 1–5. */
  readonly score: number;
  readonly at: string;
  readonly comment?: string;
}

export interface ServiceReport {
  readonly cases: number;
  readonly resolved: number;
  readonly breached: number;
  readonly breachedValue: readonly string[];
  /** Cases where nobody replied in time — counted separately from slow resolution. */
  readonly firstResponseBreached: number;
  /** Average CSAT in hundredths, exact integer arithmetic. */
  readonly csatHundredths: number | 'no_responses';
  readonly responseRateBps: number | 'not_meaningful';
  readonly detail: string;
}

/**
 * The service report a manager acts on.
 *
 * CSAT carries its **response rate** beside it, because 4.8 from six replies out of four
 * hundred cases is not a satisfaction score — it is six people, and the six who reply are
 * rarely the ones who left quietly.
 */
export function serviceReport(input: {
  readonly cases: readonly ServiceCase[];
  readonly slaViews: readonly SlaView[];
  readonly scores: readonly SatisfactionScore[];
  /** First-response views, reported separately — the two failures are different. */
  readonly firstResponseViews?: readonly SlaView[];
}): ServiceReport {
  const resolved = input.cases.filter((c) => c.state === 'resolved' || c.state === 'closed').length;
  const breached = input.slaViews.filter((v) => v.status === 'breached');
  const responses = input.scores.length;
  const firstResponseBreached = (input.firstResponseViews ?? []).filter((v) => v.status === 'breached').length;

  const csatHundredths =
    responses === 0
      ? ('no_responses' as const)
      : Math.round((input.scores.reduce((s, x) => s + x.score, 0) * 100) / responses);
  const responseRateBps =
    input.cases.length === 0 ? ('not_meaningful' as const) : Math.round((responses / input.cases.length) * 10_000);

  return {
    cases: input.cases.length,
    resolved,
    breached: breached.length,
    breachedValue: breached.map((b) => b.caseId),
    firstResponseBreached,
    csatHundredths,
    responseRateBps,
    detail:
      csatHundredths === 'no_responses'
        ? `${input.cases.length} case(s), ${resolved} resolved, ${breached.length} breached (${firstResponseBreached} never answered in time); no satisfaction responses yet`
        : `${input.cases.length} case(s), ${resolved} resolved, ${breached.length} breached (${firstResponseBreached} never answered in time); CSAT ${(csatHundredths / 100).toFixed(2)} from ${responses} response(s) — ${responseRateBps === 'not_meaningful' ? '' : `${(responseRateBps / 100).toFixed(1)}% of cases, and the ones who reply are rarely the ones who left quietly`}`,
  };
}
