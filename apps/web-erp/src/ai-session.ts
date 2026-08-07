// AI control (M32 · M36 · A01–A10 · AI-NFR-01…12 · API-13 · P-05 · hard rule #5).
//
// The design bar is one line: **AI recommends or drafts; deterministic rules and authorised humans
// commit — and a kill switch that always works.**
//
// ── The one that was not merely unwired ─────────────────────────────────────
//
// `killSwitchState` decides which agents are stopped. `admitCall` refuses a call that is killed,
// over budget, or from a disabled agent. Both written, both tested — and **`callModel`, the one
// place every model call in this product passes through, consulted neither.**
//
// So pulling the kill switch stopped nothing. The switch existed, the state was computed, and the
// gateway carried on calling the provider. That is now fixed at the gateway: an admission decision
// is required and **its absence refuses**, because an emergency control that depends on every
// caller remembering to consult it is not an emergency control.
//
// ── And the ten beside it ───────────────────────────────────────────────────
//
// `grantTools`, `reviewProposals`, `commitProposal`, `admitCall`, `summariseSpend`,
// `killSwitchState`, `activateKillSwitch`, `liftKillSwitch`, `runEvalSuite`, `liveProviderGate`
// and `scanForInjection`: **every AI governance rule in this product was called by nothing.**
// The twelfth instance of this codebase's recurring shape, and the one where the whole module is
// governance — so unwired governance was the entire module doing nothing.
//
// ── What this screen refuses to let anybody believe ─────────────────────────
//
// **That an agent can commit.** The registry states, per agent, that no agent writes the database
// and none commits a price, payment, refund, purchase, stock or privilege change — and the
// forbidden list is shown as a list, because a rule nobody can see is a rule nobody trusts.
//
// **That the shop stops when the AI does.** Every agent carries the sentence describing what its
// caller does without it, and that sentence is shown beside the kill switch, so pulling it is a
// decision somebody can make calmly.

import {
  AGENTS, FORBIDDEN_TOOLS, grantTools, reviewProposals, commitProposal,
  admitCall, summariseSpend, killSwitchState, activateKillSwitch, liftKillSwitch,
  type AgentBudget, type AgentId, type AiCommitRecord, type ApprovalRole, type KillState,
  type KillSwitch, type ModelTier, type ReviewedProposal, type SpendSummary, type TierPricing,
  type ToolProposal, type UsageEntry,
} from '../../../packages/ai/src/index';

/** What this surface can see, and what it honestly cannot. */
export interface AiPorts {
  /** Every kill switch ever pulled, lifted or not. Never pruned — it is the record of a decision. */
  switches(): readonly KillSwitch[];
  /** Per-agent budgets. Absent for an agent means it has no ceiling set and cannot be admitted. */
  budgets(): readonly AgentBudget[];
  /**
   * Every call ever metered. **`undefined` means the box has never been told**, which is not the
   * same as no calls having been made.
   *
   * This is the **only** source of what an agent has spent. There used to be a second — a carried
   * map of per-agent totals with no period attached to it — and the two disagreed by an entire
   * budget on a box that had been running for a month: the assistants tab read 95,000 spent while
   * the cost tab beside it read nought. Both were on the same screen. One number, one source.
   */
  usage(): readonly UsageEntry[] | undefined;
  /** The owner's own platform ceiling (D3), in minor units. Absent means none has been set. */
  platformCeilingMinor(): number | undefined;
  /** The period the spend is summarised over, e.g. "2026-08". */
  period(): string;
  /** Proposals waiting for a human. AI drafts; a person commits (P-05). */
  pending(): readonly PendingProposal[];
  /** The most recent evaluation run per agent, if any has ever been run. */
  evaluations(): Readonly<Record<string, { readonly passed: number; readonly total: number; readonly at: string }>>;
}

/** One thing an agent has proposed, and the evidence it cited for it. */
export interface PendingProposal {
  readonly proposalId: string;
  readonly agentId: AgentId;
  readonly proposal: ToolProposal;
  readonly proposedAt: string;
  /** Evidence ids the model cited AND that were verified as real. Never what it merely claimed. */
  readonly verifiedCitations: readonly string[];
}

export interface AiConfig {
  readonly tenantId: string;
  /** Who is looking. `null` means the box was not told — nothing may be pulled or committed. */
  readonly userId: string | null;
  readonly now: string;
  /** Minutes after which a proposal must be regenerated against fresh data. Per-tenant. */
  readonly staleAfterMinutes: number;
}

export type PullRefusal = 'nobody_is_named_at_this_desk' | 'refused';
export type DecideRefusal = 'nobody_is_named_at_this_desk' | 'no_such_proposal' | 'refused';

const PULL_REFUSAL_VALUES: Readonly<Record<PullRefusal, PullRefusal>> = Object.freeze({
  nobody_is_named_at_this_desk: 'nobody_is_named_at_this_desk',
  refused: 'refused',
});
export const PULL_REFUSAL_KINDS: readonly PullRefusal[] = Object.freeze(Object.values(PULL_REFUSAL_VALUES));

const DECIDE_REFUSAL_VALUES: Readonly<Record<DecideRefusal, DecideRefusal>> = Object.freeze({
  nobody_is_named_at_this_desk: 'nobody_is_named_at_this_desk',
  no_such_proposal: 'no_such_proposal',
  refused: 'refused',
});
export const DECIDE_REFUSAL_KINDS: readonly DecideRefusal[] = Object.freeze(Object.values(DECIDE_REFUSAL_VALUES));

/** What an agent has spent against its ceiling, or the reason that cannot be said. */
export type AgentBudgetView =
  | {
    readonly known: true;
    readonly spentMinor: number;
    readonly ceilingMinor: number;
    readonly remainingMinor: number;
  }
  | { readonly known: false; readonly why: 'no_ceiling_set' | 'spend_not_known' };

/** One agent, as the screen shows it: what it may do, what it costs, and whether it is running. */
export interface AgentView {
  readonly agentId: AgentId;
  readonly name: string;
  readonly purpose: string;
  /** Exactly what it may ask for, after the forbidden list is subtracted. Never "everything". */
  readonly tools: readonly string[];
  readonly approver: string;
  readonly readOnly: boolean;
  readonly customerFacing: boolean;
  /** **Stopped by a kill switch right now**, decided from the switches, never a stored flag. */
  readonly stopped: boolean;
  /** What the shop does without it. Every agent has one, and it is shown beside the switch. */
  readonly fallback: string;
  /**
   * Spend against ceiling, or **why it cannot be stated**.
   *
   * A register rather than a number, because there are two different ways not to have one and
   * they need different answers: no ceiling has been set (so no call may be made at all), or the
   * box has never been told what has been spent (so nothing can be judged against the ceiling).
   * Neither is a budget of nought.
   */
  readonly budget: AgentBudgetView;
  /** The last evaluation run. `undefined` means this agent has **never been evaluated**. */
  readonly evaluation: { readonly passed: number; readonly total: number; readonly at: string } | undefined;
}

export type PullOutcome =
  | { readonly ok: true; readonly stops: readonly AgentId[]; readonly detail: string }
  | { readonly ok: false; readonly refusal: PullRefusal; readonly detail: string };

export type DecideOutcome =
  | { readonly ok: true; readonly record: AiCommitRecord }
  | { readonly ok: false; readonly refusal: DecideRefusal; readonly detail: string; readonly review?: ReviewedProposal };

export interface AiSession {
  /** Every agent, stopped ones first — a stopped agent is the thing somebody came here about. */
  agents(): readonly AgentView[];
  /** What no agent may ever be granted, whatever anybody configures (AI-NFR-12). */
  forbidden(): readonly string[];
  /** The kill switch as it stands, and what it is stopping. */
  killState(): KillState;
  /** Pull one — instant, with a name and a reason. Never an approval; that arrives twenty minutes late. */
  pull(input: { readonly scope: 'all_ai' | 'customer_facing' | 'single_agent'; readonly agentId?: AgentId; readonly reason: string }): PullOutcome;
  /** Lift one. */
  lift(input: { readonly switchId: string; readonly reason: string }): PullOutcome;
  /** What is waiting for a human, with the evidence each one cited. */
  queue(): readonly { readonly pending: PendingProposal; readonly review: ReviewedProposal }[];
  /** A human accepts a proposal. The agent never commits (P-05, hard rule #5). */
  decide(input: { readonly proposalId: string; readonly approverRole: ApprovalRole }): DecideOutcome;
  /** What every agent is spending against its ceiling. */
  spend(): SpendSummary | undefined;
}

export function createAiSession(config: AiConfig, ports: AiPorts): AiSession {
  const ALL: readonly AgentId[] = Object.keys(AGENTS) as AgentId[];
  const CUSTOMER_FACING = ALL.filter((a) => AGENTS[a].customerFacing);

  const state = (): KillState => killSwitchState({
    tenantId: config.tenantId,
    switches: ports.switches(),
    customerFacingAgents: CUSTOMER_FACING,
    allAgents: ALL,
  });

  const budgetOf = (agentId: AgentId): AgentBudget | undefined =>
    ports.budgets().find((b) => b.agentId === agentId);

  /**
   * What one agent has spent **in this period**, from the metered calls and nothing else.
   *
   * The period filter is the whole point. A carried total with no period on it is last month's
   * number wearing this month's label, and it decides whether an agent may make another call.
   */
  const spentBy = (agentId: AgentId): number | undefined => {
    const usage = ports.usage();
    if (usage === undefined) return undefined;
    return usage
      .filter((u) => u.tenantId === config.tenantId && u.period === ports.period() && u.agentId === agentId)
      .reduce((sum, u) => sum + u.costMinor, 0);
  };

  const session: AiSession = {
    agents: () => {
      const killed = state();
      const evaluations = ports.evaluations();

      const views = ALL.map((agentId): AgentView => {
        const definition = AGENTS[agentId];
        const budget = budgetOf(agentId);
        // Granted through the same function the gateway uses, so the screen cannot show a tool
        // the runtime would refuse — and the forbidden list is subtracted regardless.
        const granted = grantTools({ agentId, tenantEnabled: true, agentEnabled: budget?.enabled !== false });
        return {
          agentId,
          name: definition.name,
          purpose: definition.purpose,
          tools: granted.tools,
          approver: definition.approver,
          readOnly: definition.readOnly,
          customerFacing: definition.customerFacing,
          stopped: killed.stoppedAgents.includes(agentId),
          fallback: fallbackFor(agentId),
          budget: budgetView(budget, spentBy(agentId)),
          // `undefined` means NEVER EVALUATED, which is different from evaluated and scoring nought.
          evaluation: evaluations[agentId],
        };
      });

      // Stopped first. Somebody who opens this screen in a hurry is looking for what is off.
      return [...views].sort((a, b) => (a.stopped === b.stopped ? 0 : a.stopped ? -1 : 1));
    },

    forbidden: () => FORBIDDEN_TOOLS,

    killState: state,

    pull: (input) => {
      if (config.userId === null) {
        return {
          ok: false,
          refusal: PULL_REFUSAL_VALUES.nobody_is_named_at_this_desk,
          detail: 'this store box has not been told who is using this screen. Stopping the AI carries the name of whoever stopped it, so somebody can review it afterwards.',
        };
      }
      const result = activateKillSwitch({
        switchId: `KS-${input.scope}-${input.agentId ?? 'all'}-${config.now}`,
        tenantId: config.tenantId,
        scope: input.scope,
        ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
        reason: input.reason,
        activatedBy: config.userId,
        at: config.now,
        existing: ports.switches(),
        customerFacingAgents: CUSTOMER_FACING,
        allAgents: ALL,
      });
      return result.activated
        ? { ok: true, stops: result.stops, detail: result.detail }
        : { ok: false, refusal: PULL_REFUSAL_VALUES.refused, detail: result.detail };
    },

    lift: (input) => {
      if (config.userId === null) {
        return {
          ok: false,
          refusal: PULL_REFUSAL_VALUES.nobody_is_named_at_this_desk,
          detail: 'this store box has not been told who is using this screen.',
        };
      }
      const killSwitch = ports.switches().find((sw) => sw.switchId === input.switchId);
      if (killSwitch === undefined) {
        return { ok: false, refusal: PULL_REFUSAL_VALUES.refused, detail: `there is no kill switch "${input.switchId}".` };
      }
      const result = liftKillSwitch({ killSwitch, liftedBy: config.userId, at: config.now });
      return result.lifted
        ? { ok: true, stops: [], detail: result.detail }
        : { ok: false, refusal: PULL_REFUSAL_VALUES.refused, detail: result.detail };
    },

    queue: () => ports.pending().map((pending) => ({
      pending,
      // Reviewed with the SAME function the runtime uses, and against the verified citations —
      // never what the model claimed to have cited.
      review: reviewProposals({
        agentId: pending.agentId,
        proposals: [pending.proposal],
        grantedTools: grantTools({
          agentId: pending.agentId, tenantEnabled: true, agentEnabled: true,
        }).tools,
        verifiedCitations: pending.verifiedCitations,
      })[0]!,
    })),

    decide: (input) => {
      if (config.userId === null) {
        return {
          ok: false,
          refusal: DECIDE_REFUSAL_VALUES.nobody_is_named_at_this_desk,
          detail: 'this store box has not been told who is using this screen. A proposal is committed by a named person, never by the agent that drafted it.',
        };
      }
      const found = session.queue().find((q) => q.pending.proposalId === input.proposalId);
      if (found === undefined) {
        return { ok: false, refusal: DECIDE_REFUSAL_VALUES.no_such_proposal, detail: `there is no proposal "${input.proposalId}".` };
      }
      const record = commitProposal({
        proposalId: input.proposalId,
        agentId: found.pending.agentId,
        tool: found.pending.proposal.tool,
        review: found.review,
        approvedBy: config.userId,
        approverRole: input.approverRole,
        // Every agent id, so an agent can never appear as an approver (P-05).
        agentIdentities: ALL,
        staleAfterMinutes: config.staleAfterMinutes,
        proposedAt: found.pending.proposedAt,
        at: config.now,
      });
      return record.committed
        ? { ok: true, record }
        : { ok: false, refusal: DECIDE_REFUSAL_VALUES.refused, detail: record.detail, review: found.review };
    },

    spend: () => {
      const ceiling = ports.platformCeilingMinor();
      // No ceiling means the owner has never set one (D3). A summary built without it would
      // report every agent comfortably inside a limit nobody has agreed.
      if (ceiling === undefined) return undefined;
      const usage = ports.usage();
      // And a summary built over a substituted empty list says the AI has cost nothing, which is
      // the same sentence a shop with no AI at all would see.
      if (usage === undefined) return undefined;
      return summariseSpend({
        tenantId: config.tenantId,
        period: ports.period(),
        // The SAME calls, filtered by the SAME period, that every agent's own figure comes from.
        usage,
        budgets: ports.budgets(),
        platformCeilingMinor: ceiling,
      });
    },
  };

  return session;
}

/**
 * A ceiling and a spend, or the reason there is no figure.
 *
 * Two distinct absences, kept distinct. No ceiling means **no call may be made at all** — a
 * missing limit is not an unlimited one. No spend means the box has never been metered, and a
 * substituted nought would say the agent has its whole ceiling still to spend, which is the more
 * expensive of the two guesses.
 */
export function budgetView(budget: AgentBudget | undefined, spentMinor: number | undefined): AgentBudgetView {
  if (budget === undefined) return { known: false, why: 'no_ceiling_set' };
  if (spentMinor === undefined) return { known: false, why: 'spend_not_known' };
  return {
    known: true,
    spentMinor,
    ceilingMinor: budget.monthlyCeilingMinor,
    remainingMinor: Math.max(0, budget.monthlyCeilingMinor - spentMinor),
  };
}

/**
 * What the shop does without each agent.
 *
 * Shown beside the kill switch on purpose: pulling it is a decision somebody has to be able to make
 * calmly, and "what breaks if I do this?" is the only question they will ask.
 */
export function fallbackFor(agentId: AgentId): string {
  const definition = AGENTS[agentId];
  return definition.readOnly
    ? `${definition.name} only reads and drafts — the figures behind it are computed without AI and stay on the screen`
    : `${definition.name} only proposes — the work carries on as it did before, decided by ${definition.approver}`;
}

/**
 * Whether one call may go ahead, in the shape the gateway now requires.
 *
 * Exported so the screen and the runtime cannot drift: this is the same `admitCall` the gateway's
 * admission comes from, and the gateway refuses when it is absent.
 *
 * **`spentThisPeriodMinor` may be `undefined`, and then the call is refused.** A ceiling can only
 * be enforced against a spend somebody has actually measured; treating "not metered" as nought
 * hands the agent its whole ceiling again, every period, for as long as the meter is broken.
 */
export function admissionFor(input: {
  readonly agentId: AgentId;
  readonly budget: AgentBudget;
  readonly requestedTier: ModelTier;
  readonly estimatedInputTokens: number;
  readonly estimatedOutputTokens: number;
  readonly pricing: Readonly<Record<ModelTier, TierPricing>>;
  readonly spentThisPeriodMinor: number | undefined;
  readonly killed: boolean;
}): { readonly allowed: boolean; readonly detail: string } {
  if (input.spentThisPeriodMinor === undefined) {
    return {
      allowed: false,
      detail: `nothing has told this box what ${AGENTS[input.agentId].name} has spent this period, so its ceiling cannot be enforced — ${fallbackFor(input.agentId)}`,
    };
  }
  const decision = admitCall({
    budget: input.budget,
    requestedTier: input.requestedTier,
    estimatedInputTokens: input.estimatedInputTokens,
    estimatedOutputTokens: input.estimatedOutputTokens,
    pricing: input.pricing,
    spentThisPeriodMinor: input.spentThisPeriodMinor,
    killed: input.killed,
    fallback: fallbackFor(input.agentId),
  });
  return { allowed: decision.allowed, detail: decision.detail };
}
