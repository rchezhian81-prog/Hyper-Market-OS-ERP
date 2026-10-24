// The AI control read and three deterministic agent surfaces (OB-288 lane 4 · P1).
//
//   • `GET /v1/ai/control` — everything roadmap §27's "AI control" screen shows, in ONE server read in the person's own
//     session: the agent registry with tools and authority, which are enabled and which stopped (and by what), each one's
//     budget and spend, the approved-model register and whether a provider is configured, the free-text setting, the
//     evaluations, the AI incidents, the proposals waiting for a person (with confidence and decisions), and the model-call
//     audit (prompts and retrieval sources, hash chain). The screen holds no rule and no figure of its own (P-08).
//   • A01 — the owner's deterministic ACTION LIST: what needs a person today, each item with its evidence and the place
//     to act. Read-only; free-text questions stay off (OB-296).
//   • A05 (staff side) — deterministic answers to a service agent's ORDER and POLICY questions from the shop's own
//     records, each cited; anything the records cannot answer ESCALATES to a person. No free text (OB-296).
//   • AI-NFR-11 (OB-314) — the customer-facing suggestion read: every suggestion carries a plain "Suggested by AI" notice
//     in English and Tamil, and purchase-based personalisation runs ONLY after the customer's explicit opt-in on the
//     consent ledger. The customer app's notice UI belongs to the customer-app lane; this is what it reads.

import type { Route, RequestContext } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import { AGENTS, FORBIDDEN_TOOLS, grantTools, type AgentId } from '../../../packages/ai/src/index';
import { FACT_CONFIDENCE, RULE_CONFIDENCE, D3_PLATFORM_CEILING_MINOR, type Budget, type Confidence, type Proposal } from './index';
import { ALL_AGENTS, latestLimits, stoppedByScopedSwitches, type AiGovernanceStore } from './governance';
import { incidentsOf, type AiIncidentStore } from './ai-incidents';
import { registeredModels, type ModelRegistryStore } from './model-registry';
import type { EvaluationStore } from './evaluations';
import { EVALUATION_SET, EVALUATION_SET_VERSION } from './evaluation-set';
import { auditChainHolds, type ModelCallAudit } from './model-gateway';

export interface AiControlDeps {
  readonly masterOn: (tenantId: string) => Promise<boolean> | boolean;
  readonly enabledAgents: (tenantId: string) => Promise<readonly AgentId[]> | readonly AgentId[];
  readonly budget: (tenantId: string) => Promise<Budget> | Budget;
  readonly governance: AiGovernanceStore;
  readonly incidents: AiIncidentStore;
  readonly registry: ModelRegistryStore;
  readonly evaluations: EvaluationStore;
  readonly openProposals: (tenantId: string) => Promise<readonly Proposal[]> | readonly Proposal[];
  readonly modelCalls: (tenantId: string) => Promise<readonly ModelCallAudit[]> | readonly ModelCallAudit[];
  readonly providerConfigured: () => boolean;
  /** The agents' deterministic run (the same one `POST /v1/ai/agents/:agent/runs` makes) — read-only. */
  readonly run: (tenantId: string, agent: AgentId) => Promise<readonly Omit<Proposal, 'committed'>[]> | readonly Omit<Proposal, 'committed'>[];
  /** A05: the order a question is about, in words, from the order register; undefined when there is no such order. */
  readonly orderFacts: (tenantId: string, orderId: string) => Promise<string | undefined> | string | undefined;
  /** A05: the shop's service policy, in words, from its own settings. */
  readonly servicePolicy: (tenantId: string) => Promise<readonly string[]> | readonly string[];
  /** AI-NFR-11: the customer's consent ledger, and the products they bought before (their own orders only). */
  readonly consentRecords: (tenantId: string, customerId: string) => Promise<readonly { readonly purpose: string; readonly given: boolean; readonly recordedAt: string }[]>;
  readonly boughtBefore: (tenantId: string, customerId: string) => Promise<readonly string[]>;
  /** AI-NFR-11: which products are in stock at a place now. */
  readonly inStockAt: (tenantId: string, locationId: string) => Promise<ReadonlyMap<string, number>>;
  readonly now: () => string;
}

/** OB-314: the plain notice on EVERY AI suggestion a customer sees — both languages, never optional. */
export const AI_SUGGESTION_NOTICE = {
  en: 'Suggested by AI. You choose — nothing is added or changed unless you say so.',
  ta: 'AI பரிந்துரைத்தது. நீங்களே தேர்வு செய்யுங்கள் — நீங்கள் சொல்லாமல் எதுவும் சேர்க்கப்படாது, மாற்றப்படாது.',
} as const;
/** The consent purpose purchase-based personalisation needs (OB-314: explicit opt-in). */
export const AI_PERSONALISATION_PURPOSE = 'ai_personalisation';

function refuse(status: number, code: string, whatHappened: string, nextSafeAction: string): never {
  throw apiError(status, { code, whatHappened, wasItSaved: 'not_saved', nextSafeAction });
}

async function agentStopped(deps: AiControlDeps, tenantId: string, agent: AgentId): Promise<{ readonly stopped: boolean; readonly enabled: boolean; readonly why?: string }> {
  const enabled = (await deps.enabledAgents(tenantId)).includes(agent);
  if (await deps.masterOn(tenantId)) return { stopped: true, enabled, why: 'the shop-wide AI switch is on' };
  const scoped = stoppedByScopedSwitches(tenantId, await deps.governance.killSwitches(tenantId));
  if (scoped.includes(agent)) return { stopped: true, enabled, why: `${agent} is stopped by a kill switch` };
  if (!enabled) return { stopped: true, enabled, why: `${agent} is not switched on for this shop` };
  return { stopped: false, enabled };
}

/** OB-314: a customer's explicit opt-in to personalisation — the latest record for the purpose, on any channel. */
export function personalisationConsented(records: readonly { readonly purpose: string; readonly given: boolean; readonly recordedAt: string }[]): boolean {
  let latest: { readonly given: boolean; readonly recordedAt: string } | undefined;
  for (const r of records) if (r.purpose === AI_PERSONALISATION_PURPOSE && (latest === undefined || r.recordedAt >= latest.recordedAt)) latest = r;
  return latest?.given === true;
}

export interface ActionItem {
  readonly actionId: string;
  readonly says: string;
  readonly where: string;
  readonly evidence: readonly { readonly source: string; readonly reference: string; readonly summary: string }[];
  readonly confidence: Confidence;
}

export function aiControlRoutes(deps: AiControlDeps): readonly Route[] {
  return [
    {
      api: 'API-13', method: 'GET', path: '/v1/ai/control',
      permission: 'ai.proposal.read',
      handler: async (ctx) => {
        const t = ctx.tenantId;
        const [masterOn, enabled, budget, switches, limitsAll, spend, freeText, incidents, models, runs, proposals, outcomes, calls] = await Promise.all([
          deps.masterOn(t), deps.enabledAgents(t), deps.budget(t), deps.governance.killSwitches(t), deps.governance.agentLimits(t),
          deps.governance.spendByAgent(t), deps.governance.freeText(t), incidentsOf(deps.incidents, t), registeredModels(deps.registry, t),
          deps.evaluations.runs(t), deps.openProposals(t), deps.governance.proposalOutcomes(t), deps.modelCalls(t),
        ]);
        const limits = latestLimits(limitsAll);
        const scoped = stoppedByScopedSwitches(t, switches);
        const latestRun = new Map(runs.map((r) => [r.agent, r]));
        const outcomeOf = new Map(outcomes.map((o) => [o.proposalId, o]));
        const shaped = proposals.map((p) => ({ ...p, confidence: p.confidence ?? RULE_CONFIDENCE, outcome: outcomeOf.get(p.proposalId) ?? null }));
        const agents = ALL_AGENTS.map((agentId) => {
          const d = AGENTS[agentId];
          const l = limits.get(agentId);
          const run = latestRun.get(agentId);
          return {
            agentId, name: d.name, purpose: d.purpose, approver: d.approver, readOnly: d.readOnly, customerFacing: d.customerFacing,
            tools: grantTools({ agentId, tenantEnabled: true, agentEnabled: true }).tools,
            enabled: enabled.includes(agentId),
            stopped: masterOn || scoped.includes(agentId) || !enabled.includes(agentId),
            stoppedBecause: masterOn ? 'master' : scoped.includes(agentId) ? 'kill_switch' : !enabled.includes(agentId) ? 'not_enabled' : null,
            spentMinor: spend[agentId] ?? 0,
            ceilingMinor: l?.ceilingMinor ?? null,
            callsPerHour: l?.callsPerHour ?? null,
            evaluationCases: EVALUATION_SET.filter((c) => c.agentId === agentId).length,
            lastEvaluation: run === undefined ? null : { runId: run.runId, at: run.at, passed: run.passed, total: run.total, unsafe: run.unsafe, complete: run.complete, fitToFacePeople: run.fitToFacePeople, detail: run.detail },
            awaitingDecision: shaped.filter((p) => p.agent === agentId && p.outcome === null).length,
          };
        });
        return {
          status: 200,
          body: {
            agents, forbidden: FORBIDDEN_TOOLS,
            killSwitch: { masterOn, active: switches.filter((s) => s.liftedAt === undefined), history: switches },
            budget: {
              capMinor: budget.capMinor, spentMinor: budget.spentMinor, periodEnds: budget.periodEnds, platformCeilingMinor: D3_PLATFORM_CEILING_MINOR,
              ceilingsTotalMinor: [...limits.values()].reduce((s, x) => s + x.ceilingMinor, 0),
            },
            provider: {
              configured: deps.providerConfigured(),
              said: deps.providerConfigured()
                ? 'A model provider is connected behind the governed call. Only an approved model may be called.'
                : 'No model provider is connected (OB-296): every assistant works on tested rules over the shop\'s own records, and nothing costs anything.',
            },
            models, freeText,
            evaluations: { setVersion: EVALUATION_SET_VERSION, runs: runs.slice(-50) },
            incidents: { open: incidents.filter((i) => i.state !== 'closed').length, list: incidents.slice(0, 50) },
            proposals: {
              awaitingDecision: shaped.filter((p) => p.outcome === null).length,
              list: [...shaped].sort((a, b) => Number(a.outcome !== null) - Number(b.outcome !== null) || (a.createdAt < b.createdAt ? 1 : -1)).slice(0, 100),
            },
            modelCalls: {
              count: calls.length, chain: auditChainHolds(calls),
              recent: calls.slice(-20).reverse().map((a) => ({
                callId: a.callId, agent: a.agent, at: a.at, outcome: a.admission.allowed ? a.result.outcome : a.admission.outcome,
                calledAModel: a.calledAModel, instruction: a.request.instruction, evidenceFrom: a.request.evidenceFrom ?? null,
                evidenceCount: a.request.evidenceIds.length, modelId: a.modelId ?? null, costMinor: a.actualCostMinor,
                piiRemoved: a.request.minimisation?.piiRemoved ?? [], blockedTools: a.blockedTools ?? [],
              })),
            },
            decisions: {
              'OB-296': 'The assistants stay rule-based. The model gateway is built and tested against a stand-in, and switched off: no live provider, no AI cost. Free-text questions (A01) and answers (A05) stay off.',
              'OB-314': 'Every AI suggestion a customer sees says "Suggested by AI". Personalisation from what a customer bought runs only after they opt in.',
            },
            committedAnything: false, asAt: deps.now(),
          },
        };
      },
    },
    {
      // A01 — the owner's deterministic action list (read-only; proposes nothing it could commit).
      api: 'API-13', method: 'GET', path: '/v1/ai/owner/action-list',
      permission: 'ai.proposal.read',
      handler: async (ctx) => {
        const t = ctx.tenantId;
        const state = await agentStopped(deps, t, 'A01');
        if (state.stopped) {
          return { status: 200, body: { agentActive: false, items: [], said: `The owner's assistant (A01) is not running: ${state.why}. The figures themselves are on the dashboard as always.`, committedAnything: false } };
        }
        const items: ActionItem[] = [];
        for (const insight of await deps.run(t, 'A01')) {
          if (insight.proposalId.startsWith('a01-stale-') || insight.proposalId.startsWith('a01-nothing-')) {
            items.push({ actionId: `act-${insight.proposalId}`, says: `Check the store computer's sync before deciding on today's figures: ${insight.summary}`, where: 'the store computer status (Admin → devices)', evidence: insight.evidence, confidence: insight.confidence ?? FACT_CONFIDENCE });
          }
        }
        const outcomes = new Set((await deps.governance.proposalOutcomes(t)).map((o) => o.proposalId));
        const waiting = new Map<AgentId, number>();
        for (const p of await deps.openProposals(t)) if (!outcomes.has(p.proposalId) && p.agent !== 'A01') waiting.set(p.agent, (waiting.get(p.agent) ?? 0) + 1);
        for (const [agent, n] of [...waiting].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
          items.push({
            actionId: `act-waiting-${agent}`, says: `${n} draft(s) from ${AGENTS[agent].name} (${agent}) wait for a ${AGENTS[agent].approver.replace(/_/g, ' ')} to decide`,
            where: 'AI control → Waiting for you', evidence: [{ source: 'AI proposal register', reference: `/v1/ai/proposals?agent=${agent}`, summary: `${n} without a decision` }], confidence: FACT_CONFIDENCE,
          });
        }
        const unowned = (await incidentsOf(deps.incidents, t)).filter((i) => i.state === 'open');
        if (unowned.length > 0) {
          items.push({ actionId: 'act-ai-incidents', says: `${unowned.length} AI incident(s) have nobody looking after them — name an owner`, where: 'AI control → Incidents', evidence: unowned.slice(0, 5).map((i) => ({ source: 'AI incidents', reference: i.incidentId, summary: i.summary })), confidence: FACT_CONFIDENCE });
        }
        const active = (await deps.governance.killSwitches(t)).filter((s) => s.liftedAt === undefined);
        for (const s of active) {
          items.push({ actionId: `act-stopped-${s.switchId}`, says: `${s.scope === 'single_agent' ? s.agentId : s.scope === 'all_ai' ? 'Every assistant' : 'The customer-facing assistants'} stopped by ${s.activatedBy}: "${s.reason}". Decide whether it can start again (a different person lifts it)`, where: 'AI control → Stop the AI', evidence: [{ source: 'kill switches', reference: s.switchId, summary: `pulled ${s.activatedAt}` }], confidence: FACT_CONFIDENCE });
        }
        return { status: 200, body: { agentActive: true, items, count: items.length, said: items.length === 0 ? 'Nothing needs you from the assistants today.' : `${items.length} thing(s) need a person.`, freeText: 'off (OB-296)', committedAnything: false, asAt: deps.now() } };
      },
    },
    {
      // A05 (staff side) — a deterministic answer to an order or policy question, cited, or an escalation.
      // Body: { topic: order_status | compensation_policy, orderId? }. No free text (OB-296).
      api: 'API-13', method: 'POST', path: '/v1/ai/service/answers',
      permission: 'service.case.read', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const topic = b['topic'];
        if ((topic !== 'order_status' && topic !== 'compensation_policy') || (topic === 'order_status' && !(typeof b['orderId'] === 'string' && b['orderId'].trim() !== ''))
          || b['question'] !== undefined) {
          refuse(400, 'not_readable_as_a_service_question', 'A service question names its topic: { topic: "order_status", orderId } or { topic: "compensation_policy" }. Free-text questions are switched off (OB-296).', 'Nothing was asked.');
        }
        const state = await agentStopped(deps, ctx.tenantId, 'A05');
        if (state.stopped) {
          return { status: 200, body: { answered: false, escalate: true, agentActive: false, said: `The service assistant (A05) is not running: ${state.why}. Look the order up yourself or ask a supervisor.`, committedAnything: false } };
        }
        if (topic === 'order_status') {
          const orderId = (b['orderId'] as string).trim();
          const facts = await deps.orderFacts(ctx.tenantId, orderId);
          if (facts === undefined) {
            return { status: 200, body: { answered: false, escalate: true, agentActive: true, said: `There is no order ${orderId} on the order register, so the assistant cannot answer. Escalate to a supervisor — do not guess for the customer.`, committedAnything: false } };
          }
          return { status: 200, body: { answered: true, escalate: false, agentActive: true, text: facts, evidence: [{ source: 'order register', reference: orderId, summary: facts }], confidence: FACT_CONFIDENCE, draftFor: 'you — check it and tell the customer in your own words; the assistant sends nothing', committedAnything: false } };
        }
        const policy = await deps.servicePolicy(ctx.tenantId);
        return { status: 200, body: { answered: true, escalate: false, agentActive: true, text: policy.join(' '), evidence: policy.map((p, i) => ({ source: 'service policy (shop settings)', reference: `policy#${i + 1}`, summary: p })), confidence: FACT_CONFIDENCE, draftFor: 'you — any compensation above your own limit needs a second person (§28)', committedAnything: false } };
      },
    },
    {
      // AI-NFR-11 (OB-314) — what the customer app shows: in-stock alternatives for a product, each with the plain AI
      // notice; and "you bought before" suggestions ONLY when the customer opted in. Query: productId?, locationId.
      api: 'API-13', method: 'GET', path: '/v1/me/ai-suggestions',
      permission: 'storefront.order.read',
      handler: async (ctx: RequestContext) => {
        const locationId = typeof ctx.query['locationId'] === 'string' ? ctx.query['locationId'].trim() : '';
        const productId = typeof ctx.query['productId'] === 'string' ? ctx.query['productId'].trim() : '';
        if (locationId === '') refuse(400, 'location_not_given', 'Suggestions are for one store: send ?locationId=… (and ?productId=… for alternatives).', 'Nothing was read.');
        const state = await agentStopped(deps, ctx.tenantId, 'A04');
        const consented = personalisationConsented(await deps.consentRecords(ctx.tenantId, ctx.userId));
        const base = { notice: AI_SUGGESTION_NOTICE, personalisation: { consentPurpose: AI_PERSONALISATION_PURPOSE, optedIn: consented }, committedAnything: false };
        if (state.stopped) {
          return { status: 200, body: { ...base, aiActive: false, alternatives: [], boughtBefore: [], said: 'Suggestions are switched off just now. Search and your lists work as always.' } };
        }
        const alternatives = productId === '' ? [] : (await deps.run(ctx.tenantId, 'A04'))
          .filter((p) => p.proposalId.startsWith(`a04-alternatives-${productId}-${locationId}-`))
          .map((p) => ({ forProductId: productId, summary: p.summary, suggestedByAi: true as const, notice: AI_SUGGESTION_NOTICE, confidence: p.confidence ?? RULE_CONFIDENCE }));
        // Purchase-based personalisation: ONLY with the explicit opt-in; otherwise nothing of their history is read.
        let boughtBefore: readonly { readonly productId: string; readonly inStock: number; readonly suggestedByAi: true; readonly notice: typeof AI_SUGGESTION_NOTICE }[] = [];
        if (consented) {
          const stock = await deps.inStockAt(ctx.tenantId, locationId);
          boughtBefore = [...new Set(await deps.boughtBefore(ctx.tenantId, ctx.userId))].sort()
            .filter((id) => (stock.get(id) ?? 0) > 0)
            .slice(0, 10)
            .map((id) => ({ productId: id, inStock: stock.get(id) ?? 0, suggestedByAi: true as const, notice: AI_SUGGESTION_NOTICE }));
        }
        return {
          status: 200,
          body: {
            ...base, aiActive: true, alternatives, boughtBefore,
            said: consented ? 'Suggestions include things you bought before, because you said yes to that.' : 'Suggestions use only what is in stock — not what you bought before, because you have not said yes to that.',
          },
        };
      },
    },
  ];
}
