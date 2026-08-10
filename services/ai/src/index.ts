// API-13 AI — agent runs, evidence, budget, kill switch.
//
// **Nothing an agent produces can commit anything.** Hard rule #5 says an AI agent never writes to
// the database and never commits a price, payment, refund, purchase, stock or privilege change,
// and this service is where that stops being a policy and becomes a shape: an agent run returns a
// **proposal**, a proposal carries its evidence, and the only way it becomes real is a human
// calling the ordinary domain endpoint — which applies its own permissions, approvals and audit,
// exactly as if the human had thought of it.
//
// There is deliberately no `applyProposal` here. Adding one would create a second path into every
// domain with none of that domain's controls, and it is precisely the endpoint that gets added
// "just to save the manager some clicks".
//
// Three more things, each of which is a real failure mode rather than a formality:
//
//   • **The kill switch takes effect immediately and needs no approval.** A control that needs a
//     second person is a control that does not work at 2am, which is when it is needed.
//   • **A run without evidence is refused.** A recommendation nobody can check is a recommendation
//     somebody follows because it sounded confident.
//   • **The budget is enforced before the call, not reported after it.** A spend limit checked
//     afterwards is a record of the overspend.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  AGENTS,
  FORBIDDEN_TOOLS,
  type AgentDefinition,
  type AgentId as EngineAgentId,
} from '../../../packages/ai/src/index';

/**
 * Who the ten agents are — sourced from the tested authority engine (`packages/ai`), not a second
 * copy of the literal union here (CORE-01 / GAP-ARCH-01). One definition of the agents, and the
 * running service and the engine's own tests agree on it by construction.
 */
export type AgentId = EngineAgentId;

export interface EvidenceItem {
  /** Where the claim came from — a report, a document, a query. Never the model's own assertion. */
  readonly source: string;
  readonly reference: string;
  readonly summary: string;
}

export interface Proposal {
  readonly proposalId: string;
  readonly agent: AgentId;
  readonly summary: string;
  /** The domain endpoint a human would call to act on it. Named, never invoked from here. */
  readonly wouldRequire: string;
  readonly evidence: readonly EvidenceItem[];
  readonly createdAt: string;
  /**
   * Typed as the literal `false`. A proposal has committed nothing and can commit nothing —
   * hard rule #5 in the type system rather than in a comment.
   */
  readonly committed: false;
}

export type RunRefusal =
  | 'kill_switch_is_on'
  | 'budget_exhausted'
  | 'proposal_without_evidence'
  | 'agent_not_permitted_here';

export interface RunResult {
  readonly ok: boolean;
  readonly proposals?: readonly Proposal[];
  readonly refusedBecause?: RunRefusal;
  readonly spentMinor?: number;
  readonly detail: string;
}

export interface Budget {
  readonly capMinor: number;
  readonly spentMinor: number;
  readonly periodEnds: string;
}

/**
 * Decide whether a run may happen at all — before any model is called.
 *
 * Order matters: the kill switch first, then the budget, then permission. A killed agent must not
 * spend anything finding out it is killed.
 */
export function mayRun(input: {
  readonly agent: AgentId;
  readonly killSwitchOn: boolean;
  readonly budget: Budget;
  readonly estimatedCostMinor: number;
  readonly enabledAgents: readonly AgentId[];
}): RunResult {
  if (input.killSwitchOn) {
    return {
      ok: false, refusedBecause: 'kill_switch_is_on',
      detail: 'the AI kill switch is on. Every agent is stopped and the rest of the system carries on exactly as before — no part of the shop depends on one running (AI-NFR)',
    };
  }
  if (!input.enabledAgents.includes(input.agent)) {
    return {
      ok: false, refusedBecause: 'agent_not_permitted_here',
      detail: `${input.agent} is not enabled for this tenant. An agent runs where it has been switched on, not everywhere it could`,
    };
  }
  if (input.budget.spentMinor + input.estimatedCostMinor > input.budget.capMinor) {
    return {
      ok: false, refusedBecause: 'budget_exhausted',
      detail: `${input.budget.spentMinor} of ${input.budget.capMinor} is already spent this period and this run would cost about ${input.estimatedCostMinor}. Checked before the call — a limit checked afterwards is a record of the overspend, not a limit`,
      spentMinor: input.budget.spentMinor,
    };
  }
  return { ok: true, detail: `${input.agent} may run; ${input.budget.capMinor - input.budget.spentMinor} of budget remains` };
}

/** A proposal with no evidence is refused. Confidence is not a source. */
export function acceptProposal(p: Omit<Proposal, 'committed'>): RunResult {
  if (p.evidence.length === 0) {
    return {
      ok: false, refusedBecause: 'proposal_without_evidence',
      detail: `${p.agent} proposed "${p.summary}" with nothing behind it. A recommendation nobody can check is a recommendation somebody follows because it sounded confident`,
    };
  }
  return {
    ok: true,
    proposals: [{ ...p, committed: false }],
    detail: `${p.agent}: ${p.summary} — ${p.evidence.length} piece(s) of evidence, requires ${p.wouldRequire} by a person`,
  };
}

export interface AiDeps {
  readonly killSwitchOn: (tenantId: string) => Promise<boolean> | boolean;
  readonly setKillSwitch: (tenantId: string, on: boolean, by: string, at: string) => Promise<void> | void;
  readonly budget: (tenantId: string) => Promise<Budget> | Budget;
  readonly enabledAgents: (tenantId: string) => Promise<readonly AgentId[]> | readonly AgentId[];
  readonly run: (tenantId: string, agent: AgentId) => Promise<Omit<Proposal, 'committed'>[]> | Omit<Proposal, 'committed'>[];
  readonly openProposals: (tenantId: string) => Promise<readonly Proposal[]> | readonly Proposal[];
  readonly now: () => string;
}

/** The governance catalogue this route returns — who the agents are and what no agent may ever do. */
export interface AgentCatalogue {
  readonly agents: readonly AgentDefinition[];
  /** Tools no agent may ever be granted (AI-NFR-12). A closed list with no override anywhere. */
  readonly neverAllowed: readonly string[];
  readonly committedAnything: false;
}

export function aiRoutes(deps: AiDeps): readonly Route[] {
  return [
    {
      // The agent authority catalogue (AI-NFR-01/02/03): every agent, exactly what it may ask for,
      // who must approve it, whether it is read-only — plus the tools NO agent may ever be granted.
      // Served from the tested `packages/ai` authority engine, so the running answer to "what can the
      // AI do here" is the same object its own tests pin, not a second copy that can drift from it.
      api: 'API-13', method: 'GET', path: '/v1/ai/agents',
      permission: 'ai.proposal.read',
      handler: () => {
        const body: AgentCatalogue = {
          agents: Object.values(AGENTS),
          neverAllowed: FORBIDDEN_TOOLS,
          committedAnything: false,
        };
        return { status: 200, body };
      },
    },
    {
      api: 'API-13', method: 'POST', path: '/v1/ai/agents/:agent/runs',
      permission: 'ai.agent.run', idempotent: true,
      handler: async (ctx) => {
        const agent = (ctx.params['agent'] ?? '') as AgentId;
        const gate = mayRun({
          agent,
          killSwitchOn: await deps.killSwitchOn(ctx.tenantId),
          budget: await deps.budget(ctx.tenantId),
          estimatedCostMinor: Number((ctx.body as { estimatedCostMinor?: number })?.estimatedCostMinor ?? 0),
          enabledAgents: await deps.enabledAgents(ctx.tenantId),
        });
        if (!gate.ok) {
          throw apiError(gate.refusedBecause === 'kill_switch_is_on' ? 503 : 429, {
            code: gate.refusedBecause!,
            whatHappened: gate.detail,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing ran and nothing was spent. The shop is unaffected — no part of it depends on an agent running.',
          });
        }

        const drafts = await deps.run(ctx.tenantId, agent);
        const accepted = drafts.map(acceptProposal);
        const refused = accepted.filter((r) => !r.ok);
        return {
          status: 200,
          body: {
            proposals: accepted.flatMap((r) => r.proposals ?? []),
            refused: refused.map((r) => ({ code: r.refusedBecause, detail: r.detail })),
            // Stated on every reply, so nothing downstream can read a proposal as an action.
            committedAnything: false,
          },
        };
      },
    },
    {
      api: 'API-13', method: 'GET', path: '/v1/ai/proposals',
      permission: 'ai.proposal.read',
      handler: async (ctx) => ({
        status: 200,
        body: { proposals: await deps.openProposals(ctx.tenantId), committedAnything: false },
      }),
    },
    {
      api: 'API-13', method: 'GET', path: '/v1/ai/budget',
      permission: 'ai.budget.read',
      handler: async (ctx) => ({ status: 200, body: { ...(await deps.budget(ctx.tenantId)), asAt: deps.now() } }),
    },
    {
      api: 'API-13', method: 'PUT', path: '/v1/ai/kill-switch',
      // Deliberately a low bar. A control that needs a second person is a control that does not
      // work at 2am, which is when it is needed. Turning agents OFF can never make anything worse.
      permission: 'ai.killswitch.set', idempotent: true,
      handler: async (ctx) => {
        const on = (ctx.body as { on?: boolean })?.on;
        if (typeof on !== 'boolean') {
          throw apiError(400, {
            code: 'kill_switch_state_not_given',
            whatHappened: 'The kill switch must be set to true or false.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the intended state. The switch is unchanged.',
          });
        }
        await deps.setKillSwitch(ctx.tenantId, on, ctx.userId, deps.now());
        return {
          status: 200,
          body: {
            on, by: ctx.userId, at: deps.now(),
            effect: on
              ? 'Every agent is stopped now. Nothing else in the shop changes — no part of it depends on an agent running.'
              : 'Agents may run again, within their budget and their enabled list.',
          },
        };
      },
    },
  ];
}
