// Owner-set auto-approve limits — the head-office routes (CR-01 OI-12 · OB-712 option A · P-05 · hard rule 5 · §28).
//
// The tested engine (packages/ai/src/auto-approve.ts) decides everything; these routes only read the append-only facts,
// ask the engine, and record what it allowed:
//
//   GET  /v1/ai/auto-approve                                  the rules in force, the requests waiting for a second person,
//                                                            the switch, every past change and the recent rule decisions
//   POST /v1/ai/auto-approve/requests                         ONE person asks for a change (set or remove a limit, or start
//                                                            auto-approval). It changes nothing yet.
//   POST /v1/ai/auto-approve/requests/:requestId/decision     a DIFFERENT person confirms or refuses it
//   POST /v1/ai/auto-approve/stop                             one person stops ALL auto-approval at once, with a reason
//   POST /v1/ai/auto-approve/sweep                            the rule decides every open draft not yet decided
//
// What a rule's approval DOES is recorded here as `AIDraftAutoApproved` on the proposal-decision register — the rule is the
// approver, named with its version and the two people who set it; the assistant is only the drafter. Step 6b (OB-760 A): the
// act itself is placed through the ordinary route the kind names, with that route's own checks, by an injected placer that
// lives in the composition layer (services/api) — the approval is recorded only once the route placed it; a refusal makes the
// draft wait for a person with the route's reason.
// Nothing here calls a model, and nothing here imports a domain service (tests/guardrails/an-ai-agent-only-drafts.test.ts).

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  AGENTS, AUTO_APPROVE_KINDS, NEVER_AUTO_APPROVE, SHORT_DATED_DAYS,
  foldAutoApprove, checkChangeRequest, confirmChange, decideDraft,
  type AgentId, type AutoApproveRequest, type AutoApproveConfirmation, type AutoApproveStop, type AutoApproveDecision,
  type AutoApproveState, type ChangeAction, type DraftAct,
} from '../../../packages/ai/src/index';

export interface AutoApproveStore {
  readonly requests: (tenantId: string) => Promise<readonly AutoApproveRequest[]>;
  readonly confirmations: (tenantId: string) => Promise<readonly AutoApproveConfirmation[]>;
  readonly stops: (tenantId: string) => Promise<readonly AutoApproveStop[]>;
  readonly recordRequest: (tenantId: string, r: AutoApproveRequest) => Promise<void>;
  readonly recordConfirmation: (tenantId: string, c: AutoApproveConfirmation) => Promise<void>;
  readonly recordStop: (tenantId: string, s: AutoApproveStop) => Promise<void>;
  /** Every rule decision recorded (auto-approvals, and the waits of drafts that said exactly what they would do). */
  readonly decisions: (tenantId: string) => Promise<readonly AutoApproveDecision[]>;
  /** Record a rule decision. An auto-approval lands on the proposal-decision register under the SAME key a person's decision
   *  would, so a person's decision and the rule's cannot both land on one draft — the second collapses on the first. */
  readonly recordDecision: (tenantId: string, d: AutoApproveDecision) => Promise<void>;
}

/** A draft as the proposal register holds it — the fields the rule reads. */
export interface OpenDraft {
  readonly proposalId: string;
  readonly agent: AgentId;
  readonly act?: DraftAct;
  readonly evidence: readonly unknown[];
  readonly createdAt: string;
}

/**
 * CR-01 step 6b (OB-760 A): what placing an approved act through its ORDINARY route came to. The placer is injected from the
 * composition layer (services/api) — this service never imports a domain service and never writes to one itself.
 */
export type PlaceResult =
  | { readonly placed: true; readonly route: string; readonly reference: string; readonly by: string; readonly detail: string }
  | { readonly placed: false; readonly route: string; readonly code: string; readonly reason: string; readonly reference?: string };

export type AutoApprovedDecision = Extract<AutoApproveDecision, { readonly outcome: 'auto_approved' }>;

export interface AutoApproveDeps {
  readonly store: AutoApproveStore;
  /**
   * CR-01 step 6b (OB-760 A): place a rule-approved act through its ordinary route, at most once per draft. Absent → the
   * approval is only recorded (step 6a). Present → the approval is recorded only once the route has placed the act; a refusal
   * makes the draft wait for a person with the route's reason, and it is never tried again by the rule.
   */
  readonly place?: (tenantId: string, decision: AutoApprovedDecision, act: DraftAct) => Promise<PlaceResult>;
  readonly openProposals: (tenantId: string) => Promise<readonly OpenDraft[]> | readonly OpenDraft[];
  /** The proposals a person (or a rule) already decided — never decided again. */
  readonly decidedProposalIds: (tenantId: string) => Promise<ReadonlySet<string>>;
  /** Is the AI stopped for this assistant (the shop-wide kill switch or a scoped one)? */
  readonly aiStopped: (tenantId: string, agent: AgentId) => Promise<boolean> | boolean;
  readonly now: () => string;
  readonly newId: () => string;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
/** An identity that belongs to an assistant can neither ask for nor confirm a limit. */
export const isAgentIdentity = (userId: string): boolean => userId.startsWith('agent:') || userId in AGENTS;

function refuse(status: number, code: string, whatHappened: string, nextSafeAction: string): never {
  throw apiError(status, { code, whatHappened, wasItSaved: 'not_saved', nextSafeAction });
}

export async function autoApproveState(store: AutoApproveStore, tenantId: string): Promise<AutoApproveState> {
  const [requests, confirmations, stops] = await Promise.all([store.requests(tenantId), store.confirmations(tenantId), store.stops(tenantId)]);
  return foldAutoApprove({ requests, confirmations, stops });
}

/**
 * The rule decides every open draft nobody has decided yet. Records each auto-approval, and each wait of a draft that said
 * exactly what it would do (a draft with no exact act is the normal case today and is not recorded — P-03, no noise).
 */
export async function sweepDrafts(deps: AutoApproveDeps, tenantId: string, drafts?: readonly OpenDraft[]): Promise<readonly AutoApproveDecision[]> {
  const state = await autoApproveState(deps.store, tenantId);
  const decided = await deps.decidedProposalIds(tenantId);
  const recorded = new Set((await deps.store.decisions(tenantId)).map((d) => `${d.proposalId}|${d.outcome}|${d.outcome === 'waits_for_a_person' ? d.because : ''}`));
  const now = deps.now();
  const out: AutoApproveDecision[] = [];
  for (const p of drafts ?? await deps.openProposals(tenantId)) {
    if (decided.has(p.proposalId)) continue;
    const d = decideDraft({
      draft: { proposalId: p.proposalId, agent: p.agent, ...(p.act === undefined ? {} : { act: p.act }), evidenceCount: p.evidence.length, createdAt: p.createdAt },
      state, aiStopped: await deps.aiStopped(tenantId, p.agent), now,
    });
    const final = d.outcome === 'auto_approved' && deps.place !== undefined && p.act !== undefined ? await placeOnce(deps, tenantId, p, d) : d;
    out.push(final);
    const key = `${final.proposalId}|${final.outcome}|${final.outcome === 'waits_for_a_person' ? final.because : ''}`;
    if (final.outcome === 'auto_approved' || (p.act !== undefined && !recorded.has(key))) {
      await deps.store.recordDecision(tenantId, final);
      recorded.add(key);
    }
  }
  return out;
}

/**
 * CR-01 step 6b: just before placing, the switch, the AI kill switch and the rule are read AGAIN — a stop pulled while the
 * sweep ran stops this draft too. Then the act goes through its ordinary route (the injected placer); the rule's approval is
 * the outcome only if the route placed it. A refusal is a wait for a person with the route's own reason (never retried).
 */
async function placeOnce(deps: AutoApproveDeps, tenantId: string, p: OpenDraft, first: AutoApprovedDecision): Promise<AutoApproveDecision> {
  const fresh = decideDraft({
    draft: { proposalId: p.proposalId, agent: p.agent, act: p.act!, evidenceCount: p.evidence.length, createdAt: p.createdAt },
    state: await autoApproveState(deps.store, tenantId), aiStopped: await deps.aiStopped(tenantId, p.agent), now: first.at,
  });
  if (fresh.outcome !== 'auto_approved') return fresh;
  const r = await deps.place!(tenantId, fresh, p.act!);
  if (r.placed) {
    return { ...fresh, placed: { route: r.route, reference: r.reference, by: r.by }, detail: `${fresh.detail} Placed through ${r.route}: ${r.detail}` };
  }
  return {
    outcome: 'waits_for_a_person', proposalId: fresh.proposalId, kind: fresh.kind, because: 'refused_by_route', draftedBy: fresh.draftedBy, at: fresh.at,
    refusedBy: { route: r.route, code: r.code, ruleId: fresh.ruleId, ...(r.reference === undefined ? {} : { reference: r.reference }) },
    detail: `Inside the limit of rule ${fresh.ruleId}, but ${r.route} refused it (${r.code}): ${r.reason} Nothing was placed by the rule. A person decides.`,
  };
}

const ACTIONS: readonly ChangeAction[] = ['set_limit', 'remove_limit', 'resume'];

export function autoApproveRoutes(deps: AutoApproveDeps): readonly Route[] {
  return [
    {
      api: 'API-13', method: 'GET', path: '/v1/ai/auto-approve',
      permission: 'ai.autoapprove.read',
      handler: async (ctx) => {
        const state = await autoApproveState(deps.store, ctx.tenantId);
        const decisions = [...await deps.store.decisions(ctx.tenantId)].sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 100);
        return {
          status: 200,
          body: {
            ...state,
            kinds: Object.values(AUTO_APPROVE_KINDS),
            neverAutoApproved: NEVER_AUTO_APPROVE,
            shortDatedDays: SHORT_DATED_DAYS,
            decisions,
            said: state.running
              ? 'Auto-approval is running: a draft inside a limit two people set is approved by that rule; anything else waits for a person.'
              : 'Auto-approval is stopped: every draft waits for a person. Starting it needs two people.',
            asAt: deps.now(),
          },
        };
      },
    },
    {
      // ONE person asks. Body: { action: set_limit | remove_limit | resume, kind?, limit?, basedOnVersion, reason }.
      api: 'API-13', method: 'POST', path: '/v1/ai/auto-approve/requests',
      permission: 'ai.autoapprove.propose', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!ACTIONS.includes(b['action'] as ChangeAction) || !Number.isInteger(b['basedOnVersion']) || !isStr(b['reason'])
          || (b['action'] !== 'resume' && typeof b['kind'] !== 'string')) {
          refuse(400, 'not_readable_as_a_request', 'A request needs { action: set_limit | remove_limit | resume, kind (not for resume), limit (for set_limit), basedOnVersion (the version you read), reason }.', 'Nothing was recorded.');
        }
        const state = await autoApproveState(deps.store, ctx.tenantId);
        const request: AutoApproveRequest = {
          requestId: `aar-${deps.newId()}`, action: b['action'] as ChangeAction,
          ...(b['action'] === 'resume' ? {} : { kind: b['kind'] as AutoApproveRequest['kind'] }),
          ...(b['action'] === 'set_limit' ? { limit: b['limit'] as number } : {}),
          basedOnVersion: b['basedOnVersion'] as number, reason: (b['reason'] as string).trim(),
          requestedBy: ctx.userId, requestedAt: deps.now(),
        };
        const check = checkChangeRequest(request, state, isAgentIdentity(ctx.userId) ? [ctx.userId] : []);
        if (!check.ok) {
          refuse(check.code === 'never_auto_approvable' || check.code === 'agent_cannot_ask' ? 403 : check.code === 'rule_changed_since_asked' || check.code === 'already_running' ? 409 : 422,
            check.code, check.detail, 'Nothing was recorded.');
        }
        await deps.store.recordRequest(ctx.tenantId, request);
        return { status: 201, body: { request, changedAnything: false, nextStep: 'A different person must confirm this before it takes effect.' } };
      },
    },
    {
      // A DIFFERENT person confirms or refuses. Body: { decision: confirmed | refused, reason? (required to refuse) }.
      api: 'API-13', method: 'POST', path: '/v1/ai/auto-approve/requests/:requestId/decision',
      permission: 'ai.autoapprove.confirm', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const decision = b['decision'];
        if ((decision !== 'confirmed' && decision !== 'refused') || (decision === 'refused' && !isStr(b['reason']))) {
          refuse(400, 'not_readable_as_a_decision', 'A decision needs { decision: "confirmed" | "refused" } — and a reason to refuse.', 'Nothing was recorded.');
        }
        const state = await autoApproveState(deps.store, ctx.tenantId);
        const requestId = ctx.params['requestId'] ?? '';
        const request = state.pending.find((r) => r.requestId === requestId);
        if (request === undefined) {
          const settled = state.history.find((h) => h.requestId === requestId);
          if (settled !== undefined) refuse(409, 'already_decided', `${requestId} was already ${settled.decision} by ${settled.decidedBy}.`, 'The first decision stands. Nothing was recorded.');
          refuse(404, 'no_such_request', `There is no request "${requestId}" waiting.`, 'Read the page again. Nothing was recorded.');
        }
        if (decision === 'confirmed') {
          const check = confirmChange({ request, by: ctx.userId, state, agentIdentities: isAgentIdentity(ctx.userId) ? [ctx.userId] : [] });
          if (!check.ok) refuse(check.code === 'same_person' || check.code === 'agent_cannot_confirm' || check.code === 'never_auto_approvable' ? 403 : 409, check.code, check.detail, 'Nothing was recorded.');
        }
        // Refusing (or withdrawing your own request) is allowed for anyone holding the permission — it widens nothing.
        const c: AutoApproveConfirmation = { requestId, decision: decision as 'confirmed' | 'refused', by: ctx.userId, at: deps.now(), ...(isStr(b['reason']) ? { reason: (b['reason'] as string).trim() } : {}) };
        await deps.store.recordConfirmation(ctx.tenantId, c);
        const after = await autoApproveState(deps.store, ctx.tenantId);
        return { status: 200, body: { decision: c, rules: after.rules, running: after.running } };
      },
    },
    {
      // One person, at once, with a reason. A control that needs two people does not work at 8pm.
      api: 'API-13', method: 'POST', path: '/v1/ai/auto-approve/stop',
      permission: 'ai.autoapprove.stop', idempotent: true,
      handler: async (ctx) => {
        const reason = (ctx.body as { reason?: unknown } | undefined)?.reason;
        if (!isStr(reason)) refuse(400, 'stop_needs_a_reason', 'Stopping auto-approval needs a short reason, so whoever reviews it knows why.', 'Send { "reason": "…" }. Nothing was changed.');
        const state = await autoApproveState(deps.store, ctx.tenantId);
        if (!state.running) return { status: 200, body: { running: false, unchanged: true, said: 'Auto-approval was already stopped.' } };
        const stop: AutoApproveStop = { stopId: `aas-${deps.newId()}`, by: ctx.userId, at: deps.now(), reason: reason.trim() };
        await deps.store.recordStop(ctx.tenantId, stop);
        return { status: 200, body: { running: false, stop, said: 'Auto-approval is stopped. Every draft now waits for a person. Starting it again needs two people.' } };
      },
    },
    {
      // The rule decides every open draft not yet decided. Deterministic; calls no model; spends nothing.
      api: 'API-13', method: 'POST', path: '/v1/ai/auto-approve/sweep',
      permission: 'ai.agent.run', idempotent: true,
      handler: async (ctx) => {
        const decisions = await sweepDrafts(deps, ctx.tenantId);
        return {
          status: 200,
          body: {
            decisions,
            autoApproved: decisions.filter((d) => d.outcome === 'auto_approved').length,
            waiting: decisions.filter((d) => d.outcome === 'waits_for_a_person').length,
          },
        };
      },
    },
  ];
}
