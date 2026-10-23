// AI governance controls a person uses (OB-288 lane 4 · P1 · AI-NFR-07/10 · roadmap §27 "AI control", §30.2 events).
//
//   • SCOPED KILL SWITCHES (AI-NFR-10, `AIKillSwitchActivated`): stop all AI, only the customer-facing agents, or one
//     agent — instantly, with no approval, but with a NAME and a REASON so it can be reviewed afterwards. Lifting one is
//     a separate, named act by a DIFFERENT person (§28): the tested engine (`activateKillSwitch` / `liftKillSwitch`,
//     packages/ai/src/budget.ts) decides both, never a copy here. The shop-wide switch (`PUT /v1/ai/kill-switch`) stays
//     the owner's master setting — OB-296 keeps it ON (AI stopped) until he decides otherwise.
//   • PER-AGENT CEILINGS (AI-NFR-10 · D3): every agent its own monthly ceiling, all of them inside the shop's AI cap,
//     which is itself inside the ₹15,000-a-month platform ceiling. A per-agent CALL-RATE limit, which the owner sets; it
//     is "not set" until he does — never a number invented here.
//   • FREE TEXT (OB-296): free-text questions to A01 and free-text answers from A05 stay OFF. The switch is built and
//     tested, and it is off.
//   • A PERSON'S DECISION ON A PROPOSAL (`AIRecommendationApproved` / `AIRecommendationRejected`): approved means the
//     person agrees and will act through the ordinary route the proposal names; rejected needs a reason. Neither commits
//     anything — there is still no `applyProposal` anywhere (hard rule #5).
//
// Every write is an append-only fact; a lift or a decision is a new fact, never an edit of an old one (hard rules #2, #6).

import type { Route, RequestContext } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  AGENTS, activateKillSwitch, liftKillSwitch, killSwitchState,
  type AgentId, type KillScope, type KillSwitch,
} from '../../../packages/ai/src/index';
import { D3_PLATFORM_CEILING_MINOR, type Budget, type Proposal } from './index';

export const ALL_AGENTS: readonly AgentId[] = Object.keys(AGENTS) as AgentId[];
export const CUSTOMER_FACING_AGENTS: readonly AgentId[] = ALL_AGENTS.filter((a) => AGENTS[a].customerFacing);
/** OB-296: the agents whose FREE-TEXT path stays off — A01 question answering, A05 free-text answers. */
export const FREE_TEXT_AGENTS: readonly AgentId[] = ['A01', 'A05'];

/** An agent's own limits, as the owner set them. `callsPerHour` absent = not set (no rate limit is invented). */
export interface AgentLimit {
  readonly agentId: AgentId;
  readonly ceilingMinor: number;
  readonly callsPerHour?: number;
  readonly setBy: string;
  readonly setAt: string;
}

export interface FreeTextSetting {
  readonly enabled: boolean;
  readonly by?: string;
  readonly at?: string;
  readonly reason?: string;
}

export interface ProposalOutcome {
  readonly proposalId: string;
  readonly agent: AgentId;
  readonly decision: 'approved' | 'rejected';
  readonly reason?: string;
  readonly by: string;
  readonly at: string;
  /** The route the person acts through — named, never called from here. */
  readonly wouldRequire: string;
  readonly committedAnything: false;
}

/** A lift, recorded as its own fact beside the switch it lifts (the switch itself is never edited). */
export interface KillSwitchLift {
  readonly switchId: string;
  readonly liftedBy: string;
  readonly liftedAt: string;
  readonly reason: string;
}

export interface AiGovernanceStore {
  /** Every scoped switch ever pulled, with its lift folded in when there is one. Never pruned. */
  readonly killSwitches: (tenantId: string) => Promise<readonly KillSwitch[]> | readonly KillSwitch[];
  readonly recordKillSwitch: (tenantId: string, killSwitch: KillSwitch) => Promise<void> | void;
  readonly recordKillSwitchLift: (tenantId: string, lift: KillSwitchLift) => Promise<void> | void;
  readonly agentLimits: (tenantId: string) => Promise<readonly AgentLimit[]> | readonly AgentLimit[];
  readonly recordAgentLimit: (tenantId: string, limit: AgentLimit) => Promise<void> | void;
  /** What each agent has spent — the server's metered `AiRunCosted` facts, summed per agent. */
  readonly spendByAgent: (tenantId: string) => Promise<Readonly<Partial<Record<AgentId, number>>>> | Readonly<Partial<Record<AgentId, number>>>;
  readonly freeText: (tenantId: string) => Promise<FreeTextSetting> | FreeTextSetting;
  readonly recordFreeText: (tenantId: string, setting: FreeTextSetting & { readonly by: string; readonly at: string }) => Promise<void> | void;
  readonly proposalOutcomes: (tenantId: string) => Promise<readonly ProposalOutcome[]> | readonly ProposalOutcome[];
  readonly recordProposalOutcome: (tenantId: string, outcome: ProposalOutcome) => Promise<void> | void;
}

/** Which agents the scoped switches stop right now — the engine's own answer. */
export function stoppedByScopedSwitches(tenantId: string, switches: readonly KillSwitch[]): readonly AgentId[] {
  return killSwitchState({ tenantId, switches, customerFacingAgents: CUSTOMER_FACING_AGENTS, allAgents: ALL_AGENTS }).stoppedAgents;
}

/** Fold switches with their lifts (a lift is its own fact). */
export function foldKillSwitches(pulled: readonly KillSwitch[], lifts: readonly KillSwitchLift[]): readonly KillSwitch[] {
  const liftOf = new Map(lifts.map((l) => [l.switchId, l]));
  return pulled.map((s) => {
    const l = liftOf.get(s.switchId);
    return l === undefined ? s : { ...s, liftedBy: l.liftedBy, liftedAt: l.liftedAt };
  });
}

/** Latest limit per agent (a later setting is the owner changing it). */
export function latestLimits(all: readonly AgentLimit[]): ReadonlyMap<AgentId, AgentLimit> {
  const m = new Map<AgentId, AgentLimit>();
  for (const l of all) m.set(l.agentId, l);
  return m;
}

export interface AiGovernanceDeps {
  readonly governance: AiGovernanceStore;
  /** The shop-wide master switch (`PUT /v1/ai/kill-switch`). Default ON when nothing was ever set. */
  readonly masterOn: (tenantId: string) => Promise<boolean> | boolean;
  readonly budget: (tenantId: string) => Promise<Budget> | Budget;
  readonly openProposals: (tenantId: string) => Promise<readonly Proposal[]> | readonly Proposal[];
  readonly now: () => string;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isAgent = (v: unknown): v is AgentId => typeof v === 'string' && v in AGENTS;
const SCOPES: readonly KillScope[] = ['all_ai', 'customer_facing', 'single_agent'];

function refuse(status: number, code: string, whatHappened: string, nextSafeAction: string): never {
  throw apiError(status, { code, whatHappened, wasItSaved: 'not_saved', nextSafeAction });
}

async function killView(deps: AiGovernanceDeps, ctx: Pick<RequestContext, 'tenantId'>) {
  const switches = await deps.governance.killSwitches(ctx.tenantId);
  const masterOn = await deps.masterOn(ctx.tenantId);
  const scoped = stoppedByScopedSwitches(ctx.tenantId, switches);
  return {
    masterOn,
    stoppedAgents: masterOn ? ALL_AGENTS : scoped,
    active: switches.filter((s) => s.liftedAt === undefined),
    history: switches,
    said: masterOn
      ? 'The shop-wide AI switch is ON: every assistant is stopped (OB-296 keeps it so until the owner decides). The shop trades exactly as before.'
      : scoped.length === 0 ? 'No assistant is stopped.' : `${scoped.join(', ')} stopped by a scoped switch; the others run within their budgets.`,
  };
}

export function aiGovernanceRoutes(deps: AiGovernanceDeps): readonly Route[] {
  return [
    {
      // The kill switches as they stand: the master, every scoped switch (active and lifted — the record of decisions).
      api: 'API-13', method: 'GET', path: '/v1/ai/kill-switches',
      permission: 'ai.proposal.read',
      handler: async (ctx) => ({ status: 200, body: { ...(await killView(deps, ctx)), asAt: deps.now() } }),
    },
    {
      // AIKillSwitchActivated — instant, no approval, a name and a reason. Body: { scope, agentId?, reason }.
      api: 'API-13', method: 'POST', path: '/v1/ai/kill-switches',
      permission: 'ai.killswitch.set', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const scope = b['scope'] as KillScope;
        if (!SCOPES.includes(scope) || (b['agentId'] !== undefined && !isAgent(b['agentId'])) || (b['reason'] !== undefined && typeof b['reason'] !== 'string')) {
          refuse(400, 'not_readable_as_a_kill_switch', 'A kill switch needs { scope: all_ai | customer_facing | single_agent, agentId? (A01…A10), reason }.', 'Nothing was stopped. Send it again with the scope and a reason.');
        }
        const at = deps.now();
        const agentId = b['agentId'] as AgentId | undefined;
        const existing = await deps.governance.killSwitches(ctx.tenantId);
        const result = activateKillSwitch({
          switchId: `ks-${scope}-${agentId ?? 'all'}-${ctx.idempotencyKey ?? at}`,
          tenantId: ctx.tenantId, scope, ...(agentId === undefined ? {} : { agentId }),
          reason: typeof b['reason'] === 'string' ? b['reason'].trim() : '', activatedBy: ctx.userId,
          existing, customerFacingAgents: CUSTOMER_FACING_AGENTS, allAgents: ALL_AGENTS, at,
        });
        if (!result.activated || result.killSwitch === undefined) {
          const status = result.outcome === 'already_active' ? 409 : 400;
          refuse(status, `kill_switch_${result.outcome}`, `The switch was not pulled: ${result.detail}.`, result.outcome === 'already_active' ? 'It is already stopping what you asked. Nothing changed.' : 'Nothing was stopped. Correct it and send again.');
        }
        await deps.governance.recordKillSwitch(ctx.tenantId, result.killSwitch);
        return {
          status: 201,
          body: {
            killSwitch: result.killSwitch, stops: result.stops, detail: result.detail,
            effect: 'Stopped now. Nothing else in the shop changes — no part of it depends on an assistant running.',
          },
        };
      },
    },
    {
      // Lifting a switch: a separate, named act with a reason, by a DIFFERENT person from the one who pulled it (§28).
      api: 'API-13', method: 'POST', path: '/v1/ai/kill-switches/:switchId/lift',
      permission: 'ai.killswitch.set', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const reason = isStr(b['reason']) ? b['reason'].trim() : '';
        if (reason === '') refuse(400, 'lift_needs_a_reason', 'Starting an assistant again needs a short reason — what was wrong, and why it is safe now.', 'Nothing changed; the switch is still pulled.');
        const switchId = ctx.params['switchId'] ?? '';
        const found = (await deps.governance.killSwitches(ctx.tenantId)).find((s) => s.switchId === switchId);
        if (found === undefined) refuse(404, 'no_such_kill_switch', `There is no kill switch "${switchId}".`, 'Read GET /v1/ai/kill-switches and choose one. Nothing changed.');
        if (found.liftedAt !== undefined) refuse(409, 'kill_switch_already_lifted', `${switchId} was already lifted by ${found.liftedBy ?? 'someone'} at ${found.liftedAt}.`, 'Nothing changed.');
        const at = deps.now();
        const out = liftKillSwitch({ killSwitch: found, liftedBy: ctx.userId, at });
        if (!out.lifted) refuse(409, 'same_person_cannot_lift', `Not lifted: ${out.detail}.`, 'Ask a different person who holds the AI switch to lift it. Nothing changed; the switch is still pulled.');
        await deps.governance.recordKillSwitchLift(ctx.tenantId, { switchId, liftedBy: ctx.userId, liftedAt: at, reason });
        return { status: 200, body: { killSwitch: out.killSwitch, reason, detail: out.detail } };
      },
    },
    {
      // Every agent's own ceiling and call-rate limit against what it has spent, inside the shop cap inside D3.
      api: 'API-13', method: 'GET', path: '/v1/ai/agent-budgets',
      permission: 'ai.budget.read',
      handler: async (ctx) => {
        const budget = await deps.budget(ctx.tenantId);
        const limits = latestLimits(await deps.governance.agentLimits(ctx.tenantId));
        const spend = await deps.governance.spendByAgent(ctx.tenantId);
        const agents = ALL_AGENTS.map((agentId) => {
          const l = limits.get(agentId);
          const spentMinor = spend[agentId] ?? 0;
          return {
            agentId, name: AGENTS[agentId].name, spentMinor,
            ceiling: l === undefined
              ? { set: false as const, said: 'No ceiling of its own is set: only the shop-wide AI cap applies to it.' }
              : { set: true as const, ceilingMinor: l.ceilingMinor, remainingMinor: Math.max(0, l.ceilingMinor - spentMinor), setBy: l.setBy, setAt: l.setAt },
            callsPerHour: l?.callsPerHour === undefined ? { set: false as const, said: 'not set' } : { set: true as const, limit: l.callsPerHour },
          };
        });
        const ceilingsTotalMinor = [...limits.values()].reduce((t, l) => t + l.ceilingMinor, 0);
        return {
          status: 200,
          body: {
            agents, shopCapMinor: budget.capMinor, shopSpentMinor: budget.spentMinor, ceilingsTotalMinor,
            platformCeilingMinor: D3_PLATFORM_CEILING_MINOR,
            said: budget.capMinor === 0
              ? 'No AI cap is set for the shop, so no call that costs anything can be made (OB-296: no AI cost).'
              : `The agents' own ceilings add up to ${ceilingsTotalMinor} of the shop's ${budget.capMinor} AI cap, inside the ${D3_PLATFORM_CEILING_MINOR} platform ceiling (D3).`,
            asAt: deps.now(),
          },
        };
      },
    },
    {
      // Set one agent's ceiling (and, if the owner wants one, its call-rate limit). Body: { ceilingMinor, callsPerHour? }.
      api: 'API-13', method: 'PUT', path: '/v1/ai/agents/:agent/budget',
      permission: 'ai.budget.set', idempotent: true,
      handler: async (ctx) => {
        const agent = ctx.params['agent'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!isAgent(agent) || !Number.isInteger(b['ceilingMinor']) || (b['ceilingMinor'] as number) < 0
          || (b['callsPerHour'] !== undefined && (!Number.isInteger(b['callsPerHour']) || (b['callsPerHour'] as number) < 1))) {
          refuse(400, 'not_readable_as_an_agent_budget', 'An agent budget needs a known agent and { ceilingMinor: whole paise ≥ 0, callsPerHour?: whole number ≥ 1 }.', 'Nothing was changed.');
        }
        const budget = await deps.budget(ctx.tenantId);
        const limits = latestLimits(await deps.governance.agentLimits(ctx.tenantId));
        const others = [...limits.values()].filter((l) => l.agentId !== agent).reduce((t, l) => t + l.ceilingMinor, 0);
        const ceilingMinor = b['ceilingMinor'] as number;
        if (others + ceilingMinor > budget.capMinor) {
          refuse(409, 'agent_ceilings_exceed_the_shop_cap',
            `The agents' ceilings would add up to ${others + ceilingMinor} paise, more than the shop's AI cap of ${budget.capMinor} (inside the ₹15,000 platform ceiling, D3).`,
            budget.capMinor === 0 ? 'No AI cap is set for the shop yet. Set one first (PUT /v1/ai/budget), within D3. Nothing was changed.' : 'Send a smaller ceiling, or lower another agent\'s first. Nothing was changed.');
        }
        const limit: AgentLimit = {
          agentId: agent, ceilingMinor, ...(b['callsPerHour'] === undefined ? {} : { callsPerHour: b['callsPerHour'] as number }),
          setBy: ctx.userId, setAt: deps.now(),
        };
        await deps.governance.recordAgentLimit(ctx.tenantId, limit);
        return { status: 200, body: { limit, shopCapMinor: budget.capMinor, ceilingsTotalMinor: others + ceilingMinor } };
      },
    },
    {
      // OB-296: free-text questions (A01) and free-text answers (A05) — built, and OFF until the owner switches them on.
      api: 'API-13', method: 'GET', path: '/v1/ai/free-text',
      permission: 'ai.proposal.read',
      handler: async (ctx) => ({ status: 200, body: { ...(await deps.governance.freeText(ctx.tenantId)), agents: FREE_TEXT_AGENTS, decision: 'OB-296: free text stays off; the agents work on rules.' } }),
    },
    {
      api: 'API-13', method: 'PUT', path: '/v1/ai/free-text',
      permission: 'ai.agent.enable', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (typeof b['enabled'] !== 'boolean' || !isStr(b['reason'])) {
          refuse(400, 'not_readable_as_a_free_text_setting', 'The free-text setting needs { enabled: true | false, reason }.', 'Nothing was changed.');
        }
        const setting = { enabled: b['enabled'] as boolean, reason: (b['reason'] as string).trim(), by: ctx.userId, at: deps.now() };
        await deps.governance.recordFreeText(ctx.tenantId, setting);
        return { status: 200, body: { ...setting, agents: FREE_TEXT_AGENTS } };
      },
    },
    {
      // AIRecommendationApproved / AIRecommendationRejected. Body: { decision: approved | rejected, reason? (required to reject) }.
      // A person's decision on ONE proposal — the first decision settles it. It COMMITS NOTHING: an approved proposal is
      // acted on through the ordinary route it names, with that route's own permissions, limits and approvals.
      api: 'API-13', method: 'POST', path: '/v1/ai/proposals/:proposalId/outcome',
      permission: 'ai.proposal.decide', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const decision = b['decision'];
        const reason = isStr(b['reason']) ? b['reason'].trim() : undefined;
        if ((decision !== 'approved' && decision !== 'rejected') || (decision === 'rejected' && reason === undefined)) {
          refuse(400, 'not_readable_as_a_decision', 'A decision needs { decision: "approved" | "rejected" } — and a reason to reject.', 'Nothing was recorded.');
        }
        const proposalId = ctx.params['proposalId'] ?? '';
        const proposal = (await deps.openProposals(ctx.tenantId)).find((p) => p.proposalId === proposalId);
        if (proposal === undefined) refuse(404, 'no_such_proposal', `There is no proposal "${proposalId}" on the register.`, 'Read GET /v1/ai/proposals and choose one. Nothing was recorded.');
        const prior = (await deps.governance.proposalOutcomes(ctx.tenantId)).find((o) => o.proposalId === proposalId);
        if (prior !== undefined) refuse(409, 'already_decided', `${proposalId} was already ${prior.decision} by ${prior.by} at ${prior.at}.`, 'The first decision stands. Nothing was recorded.');
        const outcome: ProposalOutcome = {
          proposalId, agent: proposal.agent, decision: decision as 'approved' | 'rejected', ...(reason === undefined ? {} : { reason }),
          by: ctx.userId, at: deps.now(), wouldRequire: proposal.wouldRequire, committedAnything: false,
        };
        await deps.governance.recordProposalOutcome(ctx.tenantId, outcome);
        return {
          status: 201,
          body: {
            outcome,
            nextStep: decision === 'approved'
              ? `Nothing has happened yet. To act on it, use ${proposal.wouldRequire} — that route applies its own permissions, limits and approvals.`
              : 'Recorded as rejected, with your reason. Nothing was changed anywhere.',
          },
        };
      },
    },
  ];
}
