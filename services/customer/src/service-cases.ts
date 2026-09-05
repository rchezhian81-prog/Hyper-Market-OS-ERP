// API-06 Service desk — cases & SLA clocks (M21-FR-04). Control by exception (P-03): a case breaching its
// SLA is the one that must surface, loudly, not sit amber in a queue. Two clocks matter, and a single
// "SLA met" number hides the one customers actually feel:
//
//   • FIRST RESPONSE — how long before a human first replied. It does NOT pause for the customer (the shop
//     has said nothing for them to respond to yet). A desk that resolves everything on time while nobody
//     answers for two days is failing in the way people notice.
//   • RESOLUTION — how long to resolve, and this clock PAUSES while the shop is waiting on the customer,
//     so a customer who takes three days to send a photo is not recorded as the shop's breach (else the
//     report fills with breaches nobody caused and within a month nobody reads it).
//
// The rules are the tested `assessFirstResponse` / `assessSla` in `@sre/service-desk` (the
// services-run-on-their-tested-engine guardrail). Append-only and event-sourced. Gated `service.case.manage`
// to act, `service.case.read` to see the SLA and the breached queue.
//
// Held as a named follow-on: compensation as a §28 financial action (`grantCompensation`), AI-drafts a
// named human sends (`approveDraft`, P-05), CSAT reporting (`serviceReport`), the per-tenant SLA-policy
// store (this uses the engine's per-priority defaults), and the waiting-on-customer state machine (the
// paused minutes are supplied at resolution here rather than accrued across transitions).

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import {
  assessFirstResponse, assessSla, grantCompensation, approveDraft, serviceReport,
  DEFAULT_COMPENSATION_POLICY, readCompensationPolicy,
  type ServiceCase, type CaseKind, type CasePriority,
  type CompensationKind, type CompensationApproval, type CompensationOutcome, type CompensationPolicy,
  type AiDraft, type DraftDecision, type SatisfactionScore,
} from '../../../packages/service-desk/src/index';

export type { ServiceCase } from '../../../packages/service-desk/src/index';

/** The recorded outcome of a human's decision on an AI draft — the trail that shows whether the model
 *  is helping or generating work (how often a draft is edited or rejected). */
export interface DraftDecisionRecord {
  readonly draftId: string;
  readonly caseId: string;
  readonly decision: DraftDecision;
  readonly approvedBy: string;
  readonly at: string;
  readonly sendable: boolean;
  readonly text?: string;
  readonly detail?: string;
}

/** A compensation actually granted on a case — money leaving the business, recorded append-only. */
export interface CompensationRecord {
  readonly caseId: string;
  readonly kind: CompensationKind;
  readonly amountMinor: number;
  readonly grantedBy: string;
  readonly approvedBy?: string;
  readonly reason: string;
  readonly at: string;
}

const KINDS: readonly CaseKind[] = ['complaint', 'enquiry', 'warranty', 'lost_and_found'];
const PRIORITIES: readonly CasePriority[] = ['low', 'normal', 'high', 'urgent'];
const COMPENSATION_KINDS: readonly CompensationKind[] = ['refund', 'goodwill_credit', 'loyalty_points', 'replacement'];
const APPROVAL_STATUSES = ['approved', 'rejected', 'pending'] as const;
const DRAFT_DECISIONS: readonly DraftDecision[] = ['approved', 'rejected', 'edited_and_approved'];
const strArray = (v: unknown): readonly string[] | undefined =>
  Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined;
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

// Every non-grant outcome is a 422 — nothing was saved, and the money did not leave.
const COMPENSATION_REFUSAL: Readonly<Record<Exclude<CompensationOutcome, 'granted'>, number>> = {
  no_reason: 422, exceeds_policy_cap: 422, needs_approval: 422, self_approved: 422,
};

function readApproval(v: unknown): CompensationApproval | undefined | 'invalid' {
  if (v === undefined) return undefined;
  if (!isObj(v) || !isStr(v['subjectRef']) || !(APPROVAL_STATUSES as readonly string[]).includes(v['status'] as string)
    || !isStr(v['decidedBy']) || typeof v['reason'] !== 'string') {
    return 'invalid';
  }
  return { subjectRef: v['subjectRef'] as string, status: v['status'] as CompensationApproval['status'], decidedBy: v['decidedBy'] as string, reason: v['reason'] as string };
}

export interface ServiceCaseDeps {
  readonly serviceCase: (tenantId: string, caseId: string) => Promise<ServiceCase | undefined> | ServiceCase | undefined;
  /** Every case for the tenant — the breached-queue read folds over these. */
  readonly serviceCases: (tenantId: string) => Promise<readonly ServiceCase[]> | readonly ServiceCase[];
  /** Append one state of a case — append-only (open → first reply → resolved is the trail). */
  readonly recordCase: (tenantId: string, caseId: string, c: ServiceCase, key: string) => Promise<void> | void;
  /** Compensations granted on a case — append-only (money leaving the business is a ledger, hard rule #2). */
  readonly compensations: (tenantId: string, caseId: string) => Promise<readonly CompensationRecord[]> | readonly CompensationRecord[];
  readonly recordCompensation: (tenantId: string, caseId: string, rec: CompensationRecord, key: string) => Promise<void> | void;
  /** The tenant's compensation authority limits (M21-FR-03) — `undefined` means none set, so the default
   *  applies. Sourced SERVER-SIDE: the caller never declares their own authority in the request body. */
  readonly compensationPolicy: (tenantId: string) => Promise<CompensationPolicy | undefined> | CompensationPolicy | undefined;
  /** Set the tenant's compensation limits — append-only config (latest wins), owner-only. */
  readonly recordCompensationPolicy: (tenantId: string, policy: CompensationPolicy, key: string) => Promise<void> | void;
  /** Whether a user holds `service.compensation.approve` — the §28 authority to approve an over-limit
   *  grant (owner-only by default). A named approver who does not hold it does not count. */
  readonly canApproveCompensation: (tenantId: string, userId: string) => Promise<boolean> | boolean;
  /** AI drafts on a case, and the human decisions on them (P-05) — an AI drafts, a NAMED HUMAN approves. */
  readonly drafts: (tenantId: string, caseId: string) => Promise<readonly AiDraft[]> | readonly AiDraft[];
  readonly draft: (tenantId: string, caseId: string, draftId: string) => Promise<AiDraft | undefined> | AiDraft | undefined;
  readonly recordDraft: (tenantId: string, caseId: string, draft: AiDraft, key: string) => Promise<void> | void;
  readonly draftDecisions: (tenantId: string, caseId: string) => Promise<readonly DraftDecisionRecord[]> | readonly DraftDecisionRecord[];
  readonly recordDraftDecision: (tenantId: string, caseId: string, rec: DraftDecisionRecord, key: string) => Promise<void> | void;
  /** CSAT scores across the tenant (M21-FR-04) — a customer rates a resolved case; the report folds them. */
  readonly scores: (tenantId: string) => Promise<readonly SatisfactionScore[]> | readonly SatisfactionScore[];
  readonly recordScore: (tenantId: string, caseId: string, score: SatisfactionScore, key: string) => Promise<void> | void;
  readonly now: () => string;
}

const digestOf = (c: ServiceCase): string =>
  [c.state, c.firstRespondedAt ?? '', c.resolvedAt ?? '', c.priority, c.assignedTo, String(c.waitingOnCustomerMinutes ?? 0)].join('|');

const slaOf = (c: ServiceCase, now: string) => ({
  firstResponse: assessFirstResponse({ serviceCase: c, now }),
  resolution: assessSla({ serviceCase: c, now }),
});

export function serviceCaseRoutes(deps: ServiceCaseDeps): readonly Route[] {
  return [
    {
      // Open a case. Body: { kind, customerRef, priority, summary, assignedTo, orderRef? }.
      api: 'API-06', method: 'POST', path: '/v1/service/cases/:caseId',
      permission: 'service.case.manage', idempotent: true,
      handler: async (ctx) => {
        const caseId = (ctx.params['caseId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (caseId === '' || !KINDS.includes(b['kind'] as CaseKind) || !isStr(b['customerRef'])
          || !PRIORITIES.includes(b['priority'] as CasePriority) || !isStr(b['summary']) || !isStr(b['assignedTo'])
          || (b['orderRef'] !== undefined && !isStr(b['orderRef']))) {
          throw apiError(400, {
            code: 'not_readable_as_a_case',
            whatHappened: 'A case needs a caseId in the path and { kind (complaint/enquiry/warranty/lost_and_found), customerRef, priority (low/normal/high/urgent), summary, assignedTo, orderRef? }.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send who it is for, what it is about, and who owns it.',
          });
        }
        if (await deps.serviceCase(ctx.tenantId, caseId) !== undefined) {
          throw apiError(409, { code: 'case_already_open', whatHappened: `A case "${caseId}" already exists.`, wasItSaved: 'not_saved', nextSafeAction: 'Use a new case id, or act on the existing one.' });
        }
        const c: ServiceCase = {
          caseId, tenantId: ctx.tenantId, kind: b['kind'] as CaseKind, customerRef: b['customerRef'] as string,
          openedAt: deps.now(), assignedTo: b['assignedTo'] as string, priority: b['priority'] as CasePriority,
          state: 'open', summary: b['summary'] as string, ...(isStr(b['orderRef']) ? { orderRef: b['orderRef'] } : {}),
        };
        await deps.recordCase(ctx.tenantId, caseId, c, digestOf(c));
        return { status: 201, body: { caseId, state: c.state, priority: c.priority, openedAt: c.openedAt } };
      },
    },
    {
      // Record the FIRST human reply — the clock the customer feels. Once only.
      api: 'API-06', method: 'POST', path: '/v1/service/cases/:caseId/first-response',
      permission: 'service.case.manage', idempotent: true,
      handler: async (ctx) => {
        const caseId = ctx.params['caseId'] ?? '';
        const existing = await deps.serviceCase(ctx.tenantId, caseId);
        if (existing === undefined) throw notFound(`service case ${caseId}`);
        if (existing.firstRespondedAt !== undefined) throw apiError(409, { code: 'already_responded', whatHappened: 'A first response is already recorded for this case.', wasItSaved: 'not_saved', nextSafeAction: 'The first-response clock is stamped once.' });
        const updated: ServiceCase = { ...existing, firstRespondedAt: deps.now() };
        await deps.recordCase(ctx.tenantId, caseId, updated, digestOf(updated));
        return { status: 200, body: { caseId, firstRespondedAt: updated.firstRespondedAt, sla: slaOf(updated, deps.now()) } };
      },
    },
    {
      // Resolve the case. Body: { resolution, waitingOnCustomerMinutes? } — the paused minutes the
      // resolution clock does not count against the shop.
      api: 'API-06', method: 'POST', path: '/v1/service/cases/:caseId/resolution',
      permission: 'service.case.manage', idempotent: true,
      handler: async (ctx) => {
        const caseId = ctx.params['caseId'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const waiting = b['waitingOnCustomerMinutes'];
        if (!isStr(b['resolution']) || (waiting !== undefined && (!isInt(waiting) || (waiting as number) < 0))) {
          throw apiError(400, { code: 'not_readable_as_a_resolution', whatHappened: 'Resolving a case needs { resolution } and an optional { waitingOnCustomerMinutes } (a whole number ≥ 0).', wasItSaved: 'not_saved', nextSafeAction: 'Say how it was resolved.' });
        }
        const existing = await deps.serviceCase(ctx.tenantId, caseId);
        if (existing === undefined) throw notFound(`service case ${caseId}`);
        if (existing.state === 'resolved' || existing.state === 'closed') throw apiError(409, { code: 'already_resolved', whatHappened: `This case is already ${existing.state}.`, wasItSaved: 'not_saved', nextSafeAction: 'A resolved case is not resolved again.' });
        const updated: ServiceCase = {
          ...existing, state: 'resolved', resolvedAt: deps.now(), resolution: b['resolution'] as string,
          ...(isInt(waiting) ? { waitingOnCustomerMinutes: waiting } : {}),
        };
        await deps.recordCase(ctx.tenantId, caseId, updated, digestOf(updated));
        return { status: 200, body: { caseId, state: updated.state, resolvedAt: updated.resolvedAt, sla: slaOf(updated, deps.now()) } };
      },
    },
    {
      // Both SLA clocks for one case, right now.
      api: 'API-06', method: 'GET', path: '/v1/service/cases/:caseId/sla',
      permission: 'service.case.read',
      handler: async (ctx) => {
        const existing = await deps.serviceCase(ctx.tenantId, ctx.params['caseId'] ?? '');
        if (existing === undefined) throw notFound(`service case ${ctx.params['caseId']}`);
        return { status: 200, body: { caseId: existing.caseId, state: existing.state, ...slaOf(existing, deps.now()) } };
      },
    },
    {
      // The cases, and — with `?breached=true` — only the ones breaching a clock right now: the exceptions
      // that must be escalated rather than left to age in a queue (P-03/P-08).
      api: 'API-06', method: 'GET', path: '/v1/service/cases',
      permission: 'service.case.read',
      handler: async (ctx) => {
        const now = deps.now();
        const all = await deps.serviceCases(ctx.tenantId);
        const withSla = all.map((c) => ({ caseId: c.caseId, kind: c.kind, priority: c.priority, state: c.state, assignedTo: c.assignedTo, ...slaOf(c, now) }));
        const rows = ctx.query['breached'] === 'true'
          ? withSla.filter((r) => r.firstResponse.status === 'breached' || r.resolution.status === 'breached')
          : withSla;
        return { status: 200, body: { cases: rows, count: rows.length, asAt: now } };
      },
    },
    {
      // Grant compensation on a case — MONEY LEAVING THE BUSINESS, decided by the person the customer is
      // shouting at, which is why the reason and the second signature are not optional (§28). Body:
      // { kind, amountMinor, reason, approval? }. The AUTHORITY LIMITS are the tenant's policy, sourced
      // server-side — the caller can no longer declare their own limit — and the caller's own authority is
      // set by their role: someone holding service.compensation.approve (the owner) may grant up to the
      // desk ceiling alone, everyone else up to the agent authority. grantedBy is the authenticated caller.
      // On grant, an append-only CompensationGranted is recorded.
      api: 'API-06', method: 'POST', path: '/v1/service/cases/:caseId/compensation',
      permission: 'service.case.manage', idempotent: true,
      handler: async (ctx) => {
        const caseId = ctx.params['caseId'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const approval = readApproval(b['approval']);
        if (!COMPENSATION_KINDS.includes(b['kind'] as CompensationKind) || !isInt(b['amountMinor']) || (b['amountMinor'] as number) < 0
          || typeof b['reason'] !== 'string' || approval === 'invalid') {
          throw apiError(400, {
            code: 'not_readable_as_compensation',
            whatHappened: 'Compensation needs { kind (refund/goodwill_credit/loyalty_points/replacement), amountMinor, reason, approval? }. The authority limits are the tenant\'s policy, not sent by the caller.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the amount, a real reason, and (for an over-limit grant) an approval by someone who may approve it. The agent is taken from your login.',
          });
        }
        const existing = await deps.serviceCase(ctx.tenantId, caseId);
        if (existing === undefined) throw notFound(`service case ${caseId}`);

        // The limits come from the tenant's policy (or the default), NEVER the body. The caller's own
        // authority is their role's: an owner-authority holder may grant up to the desk ceiling alone.
        const policy = (await deps.compensationPolicy(ctx.tenantId)) ?? DEFAULT_COMPENSATION_POLICY;
        const callerMayApprove = await deps.canApproveCompensation(ctx.tenantId, ctx.userId);
        const ownAuthorityMinor = callerMayApprove ? policy.deskCeilingMinor : policy.agentAuthorityMinor;

        const now = deps.now();
        const result = grantCompensation({
          serviceCase: existing, kind: b['kind'] as CompensationKind, amountMinor: b['amountMinor'] as number,
          grantedBy: ctx.userId, reason: b['reason'] as string, agentAuthorityMinor: ownAuthorityMinor,
          policyCapMinor: policy.deskCeilingMinor,
          ...(approval !== undefined ? { approval } : {}),
          at: now,
        });
        if (!result.granted) {
          throw apiError(COMPENSATION_REFUSAL[result.outcome as Exclude<CompensationOutcome, 'granted'>], {
            code: result.outcome, whatHappened: result.detail, wasItSaved: 'not_saved',
            nextSafeAction: result.outcome === 'needs_approval' || result.outcome === 'self_approved'
              ? 'A grant above the agent\'s authority needs a DIFFERENT person who may approve compensation to approve it.'
              : 'Correct the amount or the reason and grant again. Nothing was paid.',
          });
        }
        // §28 authority gate: the engine grants an over-limit amount on a self-checked approval (decidedBy
        // ≠ grantedBy), but a name in a box is not an approval. When the grant was carried by an approval
        // (result.approvedBy set), the approver must GENUINELY hold service.compensation.approve, else it
        // does not count — the same shape as the price-change and promotion approvals. Nothing is recorded.
        if (result.approvedBy !== undefined && !(await deps.canApproveCompensation(ctx.tenantId, result.approvedBy))) {
          throw apiError(422, {
            code: 'approver_may_not_approve',
            whatHappened: `${result.approvedBy} does not hold the authority to approve compensation, so their approval of this over-limit grant does not count.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Have someone who may approve compensation (the owner) approve it with a reason. Nothing was paid.',
          });
        }
        const rec: CompensationRecord = {
          caseId, kind: b['kind'] as CompensationKind, amountMinor: b['amountMinor'] as number,
          grantedBy: ctx.userId, ...(result.approvedBy !== undefined ? { approvedBy: result.approvedBy } : {}),
          reason: b['reason'] as string, at: now,
        };
        // Keyed on the case + the money + who granted it + when — a re-sync is one payment, not two.
        await deps.recordCompensation(ctx.tenantId, caseId, rec, `${caseId}-${rec.grantedBy}-${rec.amountMinor}-${now}`);
        return { status: 201, body: { caseId, granted: true, outcome: result.outcome, amountMinor: result.amountMinor, ...(result.approvedBy !== undefined ? { approvedBy: result.approvedBy } : {}), detail: result.detail } };
      },
    },
    {
      // The tenant's compensation authority limits (M21-FR-03) — what a desk agent may grant alone, and the
      // absolute desk ceiling. READ, so the desk can see the limits it is working to (a manager reads it).
      api: 'API-06', method: 'GET', path: '/v1/service/compensation-policy',
      permission: 'service.case.read',
      handler: async (ctx) => {
        const stored = await deps.compensationPolicy(ctx.tenantId);
        const policy = stored ?? DEFAULT_COMPENSATION_POLICY;
        return { status: 200, body: { ...policy, isDefault: stored === undefined } };
      },
    },
    {
      // Set the tenant's compensation authority limits (M21-FR-03) — a §28 decision, owner-only. Recorded
      // append-only (latest wins). Body: { agentAuthorityMinor, deskCeilingMinor }. An agent's own authority
      // can never exceed the desk ceiling. The limits are configuration, so no user can set their own here.
      api: 'API-06', method: 'POST', path: '/v1/service/compensation-policy',
      permission: 'service.compensation.approve', idempotent: true,
      handler: async (ctx) => {
        const policy = readCompensationPolicy(ctx.body);
        if (policy === 'invalid') {
          throw apiError(400, {
            code: 'not_readable_as_a_policy',
            whatHappened: 'A compensation policy needs { agentAuthorityMinor, deskCeilingMinor } — whole amounts in paise, ≥ 0, and the agent authority no higher than the desk ceiling.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the desk agent\'s own limit and the absolute desk ceiling.',
          });
        }
        const now = deps.now();
        await deps.recordCompensationPolicy(ctx.tenantId, policy, `${policy.agentAuthorityMinor}-${policy.deskCeilingMinor}-${now}`);
        return { status: 200, body: { ...policy, setAt: now } };
      },
    },
    {
      // Every compensation granted on a case — the record that explains, three months later, why money left.
      api: 'API-06', method: 'GET', path: '/v1/service/cases/:caseId/compensations',
      permission: 'service.case.read',
      handler: async (ctx) => {
        const caseId = ctx.params['caseId'] ?? '';
        const rows = await deps.compensations(ctx.tenantId, caseId);
        return { status: 200, body: { caseId, compensations: rows, count: rows.length, totalMinor: rows.reduce((s, r) => s + r.amountMinor, 0) } };
      },
    },
    {
      // Record an AI-drafted reply. It is ALWAYS unapproved on creation — a model does not answer a
      // customer on the shop's behalf (P-05, hard rule #5); it becomes sendable only when a named human
      // approves it below. A draft must CITE evidence, so the approver has something to check it against.
      // Body: { text, modelRef, evidenceRefs[] }.
      api: 'API-06', method: 'POST', path: '/v1/service/cases/:caseId/drafts/:draftId',
      permission: 'service.case.manage', idempotent: true,
      handler: async (ctx) => {
        const caseId = ctx.params['caseId'] ?? '';
        const draftId = (ctx.params['draftId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const evidenceRefs = strArray(b['evidenceRefs']);
        if (draftId === '' || !isStr(b['text']) || !isStr(b['modelRef']) || evidenceRefs === undefined) {
          throw apiError(400, { code: 'not_readable_as_a_draft', whatHappened: 'An AI draft needs a draftId in the path and { text, modelRef, evidenceRefs[] } in the body.', wasItSaved: 'not_saved', nextSafeAction: 'Send the drafted text, the model reference and the case evidence it is based on.' });
        }
        if (await deps.serviceCase(ctx.tenantId, caseId) === undefined) throw notFound(`service case ${caseId}`);
        if (await deps.draft(ctx.tenantId, caseId, draftId) !== undefined) throw apiError(409, { code: 'draft_already_recorded', whatHappened: `A draft "${draftId}" already exists on this case.`, wasItSaved: 'not_saved', nextSafeAction: 'Use a new draft id, or decide on the existing one.' });
        const draft: AiDraft = { draftId, caseId, text: b['text'] as string, modelRef: b['modelRef'] as string, generatedAt: deps.now(), evidenceRefs, approved: false };
        await deps.recordDraft(ctx.tenantId, caseId, draft, `${caseId}-${draftId}`);
        return { status: 201, body: { draftId, caseId, approved: false, evidenceCount: evidenceRefs.length } };
      },
    },
    {
      // A NAMED HUMAN decides on an AI draft — the ONLY way it becomes sendable (there is deliberately no
      // send route in this module). Body: { decision (approved/rejected/edited_and_approved), finalText? }.
      // A rejection is a recorded decision (200, not sendable); a draft with no evidence or an empty edit
      // cannot be approved (422). The decision is attributed to the caller, never a model.
      api: 'API-06', method: 'POST', path: '/v1/service/cases/:caseId/drafts/:draftId/decision',
      permission: 'service.case.manage', idempotent: true,
      handler: async (ctx) => {
        const caseId = ctx.params['caseId'] ?? '';
        const draftId = ctx.params['draftId'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const decision = b['decision'] as DraftDecision;
        if (!DRAFT_DECISIONS.includes(decision) || (b['finalText'] !== undefined && typeof b['finalText'] !== 'string')) {
          throw apiError(400, { code: 'not_readable_as_a_decision', whatHappened: 'A decision needs { decision (approved/rejected/edited_and_approved), finalText? }.', wasItSaved: 'not_saved', nextSafeAction: 'Say whether the drafted reply is approved, rejected, or edited and approved.' });
        }
        const existing = await deps.draft(ctx.tenantId, caseId, draftId);
        if (existing === undefined) throw notFound(`AI draft ${draftId}`);

        const now = deps.now();
        const result = approveDraft({ draft: existing, decision, ...(typeof b['finalText'] === 'string' ? { finalText: b['finalText'] } : {}), approvedBy: ctx.userId, at: now });
        // A deficiency (no evidence to check, or an empty edit) cannot be approved — 422, nothing recorded.
        // A rejection is a real, recorded human decision, not an error.
        if (!result.sendable && decision !== 'rejected') {
          throw apiError(422, { code: 'draft_not_approvable', whatHappened: result.detail, wasItSaved: 'not_saved', nextSafeAction: 'A draft needs case evidence and non-empty text before a person can approve it.' });
        }
        const rec: DraftDecisionRecord = {
          draftId, caseId, decision, approvedBy: ctx.userId, at: now, sendable: result.sendable,
          ...(result.sendable ? { text: result.text } : { detail: result.detail }),
        };
        await deps.recordDraftDecision(ctx.tenantId, caseId, rec, `${caseId}-${draftId}-${decision}`);
        return { status: result.sendable ? 201 : 200, body: rec };
      },
    },
    {
      // The AI drafts on a case and how the humans decided on them — how often the model is rewritten or
      // rejected is how a shop finds out whether it is helping or generating work.
      api: 'API-06', method: 'GET', path: '/v1/service/cases/:caseId/drafts',
      permission: 'service.case.read',
      handler: async (ctx) => {
        const caseId = ctx.params['caseId'] ?? '';
        const [drafts, decisions] = await Promise.all([deps.drafts(ctx.tenantId, caseId), deps.draftDecisions(ctx.tenantId, caseId)]);
        const byDraft = new Map(decisions.map((d) => [d.draftId, d]));
        return {
          status: 200,
          body: {
            caseId,
            drafts: drafts.map((d) => ({ draftId: d.draftId, modelRef: d.modelRef, evidenceCount: d.evidenceRefs.length, generatedAt: d.generatedAt, decision: byDraft.get(d.draftId) ?? null })),
            count: drafts.length,
          },
        };
      },
    },
    {
      // A customer rates a RESOLVED case (M21-FR-04 · CSAT). You rate a case that has been dealt with —
      // a score on an open case is a complaint in another field, not satisfaction. Append-only. Body:
      // { customerRef, score (a whole number 1–5), comment? }.
      api: 'API-06', method: 'POST', path: '/v1/service/cases/:caseId/satisfaction',
      permission: 'service.case.manage', idempotent: true,
      handler: async (ctx) => {
        const caseId = ctx.params['caseId'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const score = b['score'];
        if (!isStr(b['customerRef']) || !isInt(score) || (score as number) < 1 || (score as number) > 5
          || (b['comment'] !== undefined && typeof b['comment'] !== 'string')) {
          throw apiError(400, { code: 'not_readable_as_a_score', whatHappened: 'A satisfaction score needs { customerRef, score (a whole number 1–5), comment? }.', wasItSaved: 'not_saved', nextSafeAction: 'Send who is rating it and a score from 1 to 5.' });
        }
        const existing = await deps.serviceCase(ctx.tenantId, caseId);
        if (existing === undefined) throw notFound(`service case ${caseId}`);
        if (existing.state !== 'resolved' && existing.state !== 'closed') {
          throw apiError(409, { code: 'case_not_resolved', whatHappened: `Case ${caseId} is ${existing.state} — a satisfaction score is for a case that has been dealt with.`, wasItSaved: 'not_saved', nextSafeAction: 'Resolve the case first, then record how the customer felt about it.' });
        }
        const rec: SatisfactionScore = {
          caseId, customerRef: b['customerRef'] as string, score: score as number, at: deps.now(),
          ...(typeof b['comment'] === 'string' ? { comment: b['comment'] } : {}),
        };
        await deps.recordScore(ctx.tenantId, caseId, rec, `${caseId}-${rec.customerRef}-${rec.at}`);
        return { status: 201, body: { caseId, score: rec.score, at: rec.at } };
      },
    },
    {
      // The service report a manager acts on (M21-FR-04): cases, resolved, breached on BOTH clocks, and
      // CSAT carrying its RESPONSE RATE — because 4.8 from six replies out of four hundred cases is six
      // people, not a satisfaction score, and the six who reply are rarely the ones who left quietly.
      // Runs the tested `serviceReport` over the real cases + recorded scores.
      api: 'API-06', method: 'GET', path: '/v1/service/report',
      permission: 'service.case.read',
      handler: async (ctx) => {
        const now = deps.now();
        const [cases, scores] = await Promise.all([deps.serviceCases(ctx.tenantId), deps.scores(ctx.tenantId)]);
        const report = serviceReport({
          cases,
          slaViews: cases.map((c) => assessSla({ serviceCase: c, now })),
          firstResponseViews: cases.map((c) => assessFirstResponse({ serviceCase: c, now })),
          scores,
        });
        return { status: 200, body: report };
      },
    },
  ];
}
