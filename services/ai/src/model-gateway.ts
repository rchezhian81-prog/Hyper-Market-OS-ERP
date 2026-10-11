// API-13 The GOVERNED model call (audit EA-08 · AI-NFR-01/08/10 · hard rule #5) — what must exist BEFORE any model
// provider is enabled: the server admits the cost before the call, reserves it, meters what the call actually used,
// and keeps an immutable, hash-chained record of the request and the result.
//
//   • ADMISSION — kill switch, the agent's enabled state and the tenant's budget are decided by `admitCall` (the tested
//     engine) on the SERVER's estimate: the instruction and evidence size and the call's maximum output, priced by the
//     tenant's tier pricing. Over budget → refused (or downgraded to a permitted cheaper tier) BEFORE the transport is
//     touched. No pricing configured → refused: an unknown cost cannot be admitted.
//   • RESERVATION + METERING — an admitted call reserves its estimate (`AiCostReserved`), then settles at the ACTUAL
//     cost from the tokens the provider reported (`AiRunCosted`, the same fact the budget sums). A reservation never
//     settled still counts against the budget, so two calls racing cannot both spend the last of it.
//   • AUDIT — every call, admitted or not, appends one `AiModelCallAudited` record: who, which agent, the admission, the
//     request (instruction after secret redaction, evidence ids, offered tools, tier, limits) and the result (outcome,
//     text, proposals that survived the gateway, citations, tokens) — each with a SHA-256, chained to the tenant's
//     previous record, so an edited or removed record is detectable. Append-only (hard rules #2, #6).
//   • NOTHING IS EXECUTED — the result's proposals are proposals; tools the agent was never granted are dropped by the
//     gateway (`callModel`). No provider is configured in production (OB-02 / the live model is an external gate): the
//     call is admitted, audited and answered `no_provider`, spending nothing.

import { createHash } from 'node:crypto';
import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  AGENTS, admitCall, callModel, costOf, redactSecrets,
  type AgentId, type ModelTier, type ModelTransport, type TierPricing, type EvidenceItem, type ModelResponse, type ToolProposal,
} from '../../../packages/ai/src/index';
import type { Budget, Proposal } from './index';
import { EVALUATION_EVIDENCE, EVALUATION_SET, EVALUATION_SET_VERSION } from './evaluation-set';

export interface ModelCallAudit {
  readonly callId: string;
  readonly agent: AgentId;
  readonly requestedBy: string;
  readonly at: string;
  readonly admission: { readonly allowed: boolean; readonly outcome: string; readonly tier: ModelTier; readonly reservedMinor: number; readonly detail: string };
  readonly request: {
    readonly instruction: string; readonly redactions: number; readonly evidenceIds: readonly string[]; readonly offeredTools: readonly string[];
    /** EA-08: where the evidence came from — the agent's own governed records ('domain_readers'), or the fixed, versioned
     *  evaluation set. Never the caller. */
    readonly evidenceFrom?: string;
    /** EA-08: the caller's own free text, if any — handed to the model FENCED as untrusted input and recorded here, never
     *  as evidence (its id is not in `evidenceIds`, and a citation of it does not count). */
    readonly untrustedInput?: { readonly id: string; readonly chars: number; readonly hash: string };
    readonly tier: ModelTier; readonly maxOutputTokens: number; readonly timeoutMs: number; readonly hash: string;
  };
  readonly result: {
    readonly outcome: string; readonly text?: string; readonly proposals: readonly ToolProposal[]; readonly citedEvidenceIds: readonly string[];
    readonly inputTokens: number; readonly outputTokens: number; readonly detail: string; readonly hash: string;
  };
  readonly actualCostMinor: number;
  readonly calledAModel: boolean;
  /** The previous record's hash for this tenant ('genesis' for the first) and this record's own — the chain. */
  readonly prevHash: string;
  readonly hash: string;
  readonly committedAnything: false;
}

export interface ModelGatewayDeps {
  readonly killSwitchOn: (tenantId: string) => Promise<boolean> | boolean;
  readonly enabledAgents: (tenantId: string) => Promise<readonly AgentId[]> | readonly AgentId[];
  /** The tenant budget; `spentMinor` is the sum of settled costs. */
  readonly budget: (tenantId: string) => Promise<Budget> | Budget;
  /** Reserved minus settled — what in-flight calls may still spend. */
  readonly openReservedMinor: (tenantId: string) => Promise<number> | number;
  readonly reserve: (tenantId: string, r: { readonly callId: string; readonly agent: AgentId; readonly amountMinor: number; readonly at: string }) => Promise<void> | void;
  /** Settle the reservation at the actual, metered cost (an `AiRunCosted` fact the budget sums). */
  readonly settle: (tenantId: string, s: { readonly callId: string; readonly agent: AgentId; readonly reservedMinor: number; readonly actualMinor: number; readonly at: string }) => Promise<void> | void;
  readonly audits: (tenantId: string) => Promise<readonly ModelCallAudit[]> | readonly ModelCallAudit[];
  readonly appendAudit: (tenantId: string, a: ModelCallAudit) => Promise<void> | void;
  /** The tenant's tier pricing (per million tokens). Absent → nothing can be admitted. */
  readonly pricing?: (tenantId: string) => Promise<Readonly<Record<ModelTier, TierPricing>> | undefined> | Readonly<Record<ModelTier, TierPricing>> | undefined;
  /** The provider adapter. Absent in production until a provider is chosen and certified (an external gate). */
  readonly transport?: ModelTransport;
  /**
   * EA-08: the evidence a call for this agent is asked over — read SERVER-SIDE from the agent's own governed records (the
   * same domain readers its deterministic run reads). Absent → the call is asked over no evidence (and a grounded model
   * says it does not know).
   */
  readonly evidenceFor?: (tenantId: string, agent: AgentId) => Promise<readonly EvidenceItem[]> | readonly EvidenceItem[];
  readonly now: () => string;
}

/** Canonical JSON (keys sorted at every level) — so a record hashes the same after a database round-trip reorders it. */
const canon = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => (x !== null && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  : x));
const sha = (v: unknown): string => createHash('sha256').update(canon(v)).digest('hex');
const TIERS: readonly ModelTier[] = ['small', 'standard', 'complex'];

/** The id the caller's own free text travels under — fenced as untrusted, never evidence. */
export const CALLER_TEXT_ID = 'caller-text';

/**
 * EA-08: an agent's governed findings as the evidence a model may cite — each finding, and each governed record it rests
 * on, with its source. All of it comes from the shop's own records (`untrusted: false`).
 */
export function governedEvidence(proposals: readonly Omit<Proposal, 'committed'>[]): readonly EvidenceItem[] {
  return proposals.flatMap((p) => [
    { evidenceId: p.proposalId, source: `${p.agent} finding (deterministic, over governed records)`, content: p.summary, untrusted: false },
    ...p.evidence.map((e, i) => ({ evidenceId: `${p.proposalId}#${i + 1}`, source: e.source, content: `${e.reference}: ${e.summary}`, untrusted: false })),
  ]);
}

/** Recompute a tenant's chain — true when every record's hash and link still hold. */
export function auditChainHolds(audits: readonly ModelCallAudit[]): { readonly ok: boolean; readonly brokenAt?: string } {
  let prev = 'genesis';
  for (const a of audits) {
    const { hash, ...rest } = a;
    if (a.prevHash !== prev || sha(rest) !== hash) return { ok: false, brokenAt: a.callId };
    prev = hash;
  }
  return { ok: true };
}

export async function governedModelCall(deps: ModelGatewayDeps, input: {
  readonly tenantId: string; readonly agent: AgentId; readonly requestedBy: string; readonly callId: string;
  readonly instruction: string; readonly evidence: readonly EvidenceItem[]; readonly tier: ModelTier;
  readonly maxOutputTokens: number; readonly timeoutMs: number;
  /** Where `evidence` came from (server-side): 'domain_readers' or the evaluation set's version. */
  readonly evidenceFrom?: string;
  /** The caller's own free text — fenced as untrusted input, recorded, never evidence. */
  readonly callerText?: string;
}): Promise<{ readonly response: ModelResponse; readonly audit: ModelCallAudit }> {
  const at = deps.now();
  const definition = AGENTS[input.agent];
  const redacted = redactSecrets(input.instruction, 'outbound');
  const offeredTools = definition.allowedTools;
  // Evidence is the server's; whatever the caller wrote goes to the model FENCED as untrusted input, under its own id.
  const caller = input.callerText === undefined || input.callerText.trim() === '' ? undefined : redactSecrets(input.callerText, 'outbound').text;
  const modelEvidence: readonly EvidenceItem[] = caller === undefined
    ? input.evidence.filter((e) => e.evidenceId !== CALLER_TEXT_ID)
    : [...input.evidence.filter((e) => e.evidenceId !== CALLER_TEXT_ID), { evidenceId: CALLER_TEXT_ID, source: 'the caller\'s own text (untrusted input, not evidence)', content: caller, untrusted: true }];
  const evidenceIds = new Set(input.evidence.filter((e) => e.evidenceId !== CALLER_TEXT_ID).map((e) => e.evidenceId));
  const requestFacts = {
    instruction: redacted.text, redactions: redacted.findings.length, evidenceIds: [...evidenceIds], offeredTools,
    tier: input.tier, maxOutputTokens: input.maxOutputTokens, timeoutMs: input.timeoutMs,
    ...(input.evidenceFrom === undefined ? {} : { evidenceFrom: input.evidenceFrom }),
    ...(caller === undefined ? {} : { untrustedInput: { id: CALLER_TEXT_ID, chars: caller.length, hash: createHash('sha256').update(caller).digest('hex') } }),
  };

  // ADMISSION — before anything is reserved or any transport touched.
  const pricing = await deps.pricing?.(input.tenantId);
  const budget = await deps.budget(input.tenantId);
  const inFlight = await deps.openReservedMinor(input.tenantId);
  const estimatedInputTokens = Math.ceil((redacted.text.length + modelEvidence.reduce((n, e) => n + e.content.length, 0)) / 4);
  const admission = pricing === undefined
    ? { allowed: false, outcome: 'no_pricing', tier: input.tier, estimatedCostMinor: 0, detail: 'no model pricing is configured for this shop, so no call can be admitted — an unknown cost is not admitted' }
    : admitCall({
      budget: { agentId: input.agent, tenantId: input.tenantId, monthlyCeilingMinor: budget.capMinor, defaultTier: 'small', permittedTiers: TIERS, enabled: (await deps.enabledAgents(input.tenantId)).includes(input.agent) },
      requestedTier: input.tier, estimatedInputTokens, estimatedOutputTokens: input.maxOutputTokens, pricing,
      spentThisPeriodMinor: budget.spentMinor + inFlight, killed: await deps.killSwitchOn(input.tenantId),
      fallback: 'the agent carries on with its deterministic leg; no part of the shop depends on a model',
    });

  let response: ModelResponse;
  // A citation counts only when it names the shop's own evidence — the caller's text is never a source.
  const onlyEvidence = (r: ModelResponse): ModelResponse => ({ ...r, citedEvidenceIds: r.citedEvidenceIds.filter((id) => evidenceIds.has(id)) });
  let actual = 0;
  const reservedMinor = admission.allowed ? admission.estimatedCostMinor : 0;
  if (admission.allowed && deps.transport !== undefined) {
    await deps.reserve(input.tenantId, { callId: input.callId, agent: input.agent, amountMinor: reservedMinor, at });
    response = callModel({
      request: {
        requestId: input.callId,
        context: { tenantId: input.tenantId, agentId: input.agent, requestedBy: input.requestedBy, correlationId: input.callId, at },
        instruction: redacted.text, evidence: modelEvidence, offeredTools, maxOutputTokens: input.maxOutputTokens, timeoutMs: input.timeoutMs, tier: admission.tier,
      },
      transport: deps.transport,
      admission: { allowed: true, detail: admission.detail },
    });
    response = onlyEvidence(response);
    actual = costOf({ inputTokens: response.inputTokens, outputTokens: response.outputTokens, pricing: pricing![admission.tier] });
    await deps.settle(input.tenantId, { callId: input.callId, agent: input.agent, reservedMinor, actualMinor: actual, at });
  } else {
    // Not admitted, or no provider: callModel answers the named outcome without touching any transport.
    response = callModel({
      request: {
        requestId: input.callId,
        context: { tenantId: input.tenantId, agentId: input.agent, requestedBy: input.requestedBy, correlationId: input.callId, at },
        instruction: redacted.text, evidence: modelEvidence, offeredTools, maxOutputTokens: input.maxOutputTokens, timeoutMs: input.timeoutMs, tier: admission.tier,
      },
      admission: { allowed: admission.allowed, detail: admission.detail },
    });
  }

  const previous = await deps.audits(input.tenantId);
  const body: Omit<ModelCallAudit, 'hash'> = {
    callId: input.callId, agent: input.agent, requestedBy: input.requestedBy, at,
    admission: { allowed: admission.allowed, outcome: admission.outcome, tier: admission.tier, reservedMinor, detail: admission.detail },
    request: { ...requestFacts, hash: sha(requestFacts) },
    result: (() => {
      const r = {
        outcome: response.outcome, ...(response.text === undefined ? {} : { text: response.text }), proposals: response.proposals,
        citedEvidenceIds: response.citedEvidenceIds, inputTokens: response.inputTokens, outputTokens: response.outputTokens, detail: response.detail,
      };
      return { ...r, hash: sha(r) };
    })(),
    actualCostMinor: actual,
    calledAModel: admission.allowed && deps.transport !== undefined,
    prevHash: previous.at(-1)?.hash ?? 'genesis',
    committedAnything: false,
  };
  const audit: ModelCallAudit = { ...body, hash: sha(body) };
  await deps.appendAudit(input.tenantId, audit);
  return { response, audit };
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

export function modelGatewayRoutes(deps: ModelGatewayDeps): readonly Route[] {
  return [
    {
      // One governed model call for an agent. Body: { instruction, callerText?, scope?: { focus?, evaluationCase? }, tier? }.
      // The caller names the QUESTION and its scope; the EVIDENCE is read here, from the agent's own governed records
      // (EA-08) — a caller-supplied `evidence` is refused. `focus` narrows the agent's evidence to what mentions it; an
      // `evaluationCase` asks over the fixed, versioned evaluation evidence (the CI evaluation run). The caller's own
      // free text (`callerText`) reaches the model fenced as untrusted input and is recorded as such — never as evidence.
      // Answered with the gateway's outcome and the audit record. Commits nothing, ever.
      api: 'API-13', method: 'POST', path: '/v1/ai/agents/:agent/model-calls',
      permission: 'ai.agent.run', idempotent: true,
      handler: async (ctx) => {
        const agent = (ctx.params['agent'] ?? '') as AgentId;
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (b['evidence'] !== undefined) {
          throw apiError(400, { code: 'evidence_is_read_by_the_server', whatHappened: 'Evidence for a model call is read by head office from the agent\'s own governed records; a caller cannot supply it (EA-08).', wasItSaved: 'not_saved', nextSafeAction: 'Ask the question (and, if you like, a scope); put any text of your own in callerText — it is passed on as untrusted input, never as evidence. Nothing was called or spent.' });
        }
        const scope = b['scope'] === undefined ? {} : b['scope'];
        if (!(agent in AGENTS) || !isStr(b['instruction']) || (b['tier'] !== undefined && !TIERS.includes(b['tier'] as ModelTier))
          || (b['callerText'] !== undefined && (typeof b['callerText'] !== 'string' || b['callerText'].length > 2_000))
          || !isObj(scope) || (scope['focus'] !== undefined && !(isStr(scope['focus']) && scope['focus'].length <= 100))
          || (scope['evaluationCase'] !== undefined && !isStr(scope['evaluationCase']))) {
          throw apiError(400, { code: 'not_readable_as_a_model_call', whatHappened: 'A model call needs a known agent and { instruction, callerText? (≤ 2,000 characters), scope?: { focus?, evaluationCase? }, tier? }.', wasItSaved: 'not_saved', nextSafeAction: 'Nothing was called or spent.' });
        }
        // The evidence — the server's, never the caller's.
        let evidence: readonly EvidenceItem[];
        let evidenceFrom: string;
        const evalCase = scope['evaluationCase'] as string | undefined;
        if (evalCase !== undefined) {
          const c = EVALUATION_SET.find((x) => x.caseId === evalCase);
          if (c === undefined || c.agentId !== agent) {
            throw apiError(404, { code: 'no_such_evaluation_case', whatHappened: `${evalCase} is not a case of ${agent} in evaluation set v${EVALUATION_SET_VERSION}.`, wasItSaved: 'not_saved', nextSafeAction: 'Name a case from the fixed evaluation set. Nothing was called or spent.' });
          }
          evidence = EVALUATION_EVIDENCE[evalCase] ?? [];
          evidenceFrom = `evaluation_set_v${EVALUATION_SET_VERSION}`;
        } else {
          const all = deps.evidenceFor === undefined ? [] : await deps.evidenceFor(ctx.tenantId, agent);
          const focus = (scope['focus'] as string | undefined)?.trim().toLowerCase();
          evidence = focus === undefined ? all : all.filter((e) => `${e.evidenceId} ${e.content}`.toLowerCase().includes(focus));
          evidenceFrom = 'domain_readers';
        }
        const callId = `call-${agent}-${ctx.idempotencyKey ?? deps.now()}`;
        const { response, audit } = await governedModelCall(deps, {
          tenantId: ctx.tenantId, agent, requestedBy: ctx.userId, callId, instruction: b['instruction'] as string,
          evidence, evidenceFrom, ...(b['callerText'] === undefined ? {} : { callerText: b['callerText'] as string }),
          tier: (b['tier'] as ModelTier | undefined) ?? 'small', maxOutputTokens: 1_200, timeoutMs: 4_000,
        });
        if (!audit.admission.allowed) {
          throw apiError(audit.admission.outcome === 'killed' ? 503 : 429, {
            code: audit.admission.outcome, whatHappened: audit.admission.detail, wasItSaved: 'saved',
            nextSafeAction: 'Nothing was called and nothing was spent; the refusal itself is on the audit record.',
          });
        }
        return { status: 200, body: { callId, evidenceFrom, evidenceIds: audit.request.evidenceIds, outcome: response.outcome, text: response.text ?? null, proposals: response.proposals, citedEvidenceIds: response.citedEvidenceIds, costMinor: audit.actualCostMinor, auditHash: audit.hash, committedAnything: false } };
      },
    },
    {
      // The immutable request/result audit, oldest first, with whether its hash chain still holds.
      api: 'API-13', method: 'GET', path: '/v1/ai/model-calls',
      permission: 'ai.budget.read',
      handler: async (ctx) => {
        const audits = await deps.audits(ctx.tenantId);
        return { status: 200, body: { audits, count: audits.length, chain: auditChainHolds(audits) } };
      },
    },
  ];
}
