// Per-agent budgets, metering and kill switches (Stage 17 / AI-NFR / D3 / P-01 / hard rule #1).
//
// The owner's cost decision of 4 August 2026 is specific, and it is the specification for this
// file: **₹15,000/month for the whole platform runtime**, every agent with its own configurable
// ceiling, customer-facing AI on the smallest model that passes evaluation, expensive models
// only for explicitly approved low-volume work, customer-facing AI independently switchable,
// **the system fails SAFE when a budget is exhausted, and no unexpected overage is permitted.**
//
// "Fails safe" is the whole design, and it means something precise here that is easy to get
// backwards. When an AI budget runs out:
//
//   **THE AI STOPS. THE SHOP DOES NOT.**
//
// Every agent in this product is an assistant to a process that already worked without it. The
// owner's brief still arrives with the figures and no written summary; the buyer still places
// orders; the picker still picks. So budget exhaustion switches off a *convenience*, never a
// capability — and `shopKeepsTrading` is typed as the literal `true` for the same reason it is
// in `packages/platform`: so no future edit can quietly make an AI bill stop a till.
//
//   • **AN ESTIMATE IS CHECKED BEFORE THE CALL, NOT AFTER.** Metering after the fact tells you
//     what you already owe. The reservation happens first, which is the only way "no unexpected
//     overage" can be true rather than aspirational.
//   • **A TIER IS DOWNGRADED, NEVER UPGRADED.** If the complex tier would breach the ceiling and
//     the small one would not, the call runs small and says so. Silently spending more than the
//     owner approved is the failure this prevents.
//   • **THE KILL SWITCH IS INSTANT, SCOPED AND REVERSIBLE.** All AI, one agent, or just the
//     customer-facing ones — because the realistic emergency is *"the shopping assistant is
//     saying something wrong to customers, stop it now"*, at 8pm, by a manager.
//
// Exact integer money (§29.1). Pure and deterministic: the clock is injected, no I/O.

import type { AgentId, ModelTier } from './index-types';

/** Price per million tokens, in minor units. Per tier, per tenant, from configuration. */
export interface TierPricing {
  readonly inputPerMillionMinor: number;
  readonly outputPerMillionMinor: number;
}

export interface AgentBudget {
  readonly agentId: AgentId;
  readonly tenantId: string;
  /** This agent's own monthly ceiling, in minor units. Owner-configurable per agent. */
  readonly monthlyCeilingMinor: number;
  /** Tier this agent runs on by default. Customer-facing agents default to 'small'. */
  readonly defaultTier: ModelTier;
  /** Tiers this agent may use at all. A costly tier needs explicit approval to appear here. */
  readonly permittedTiers: readonly ModelTier[];
  readonly enabled: boolean;
}

export interface UsageEntry {
  readonly tenantId: string;
  readonly agentId: AgentId;
  readonly period: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly tier: ModelTier;
  readonly costMinor: number;
}

/** Exact cost of a call. Integer minor units, BigInt intermediates (§29.1). */
export function costOf(input: {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly pricing: TierPricing;
}): number {
  const inCost = Number((BigInt(input.inputTokens) * BigInt(input.pricing.inputPerMillionMinor)) / 1_000_000n);
  const outCost = Number((BigInt(input.outputTokens) * BigInt(input.pricing.outputPerMillionMinor)) / 1_000_000n);
  return inCost + outCost;
}

export type AdmissionOutcome =
  | 'allowed'
  | 'allowed_downgraded'
  | 'budget_exhausted'
  | 'agent_disabled'
  | 'killed'
  | 'tier_not_permitted';

export interface AdmissionDecision {
  readonly agentId: AgentId;
  readonly allowed: boolean;
  readonly outcome: AdmissionOutcome;
  /** The tier this call will actually run on. Never higher than requested. */
  readonly tier: ModelTier;
  readonly estimatedCostMinor: number;
  readonly spentThisPeriodMinor: number;
  readonly remainingMinor: number;
  /** ALWAYS true. An AI bill can never stop a shop trading. */
  readonly shopKeepsTrading: true;
  /** What the caller does instead when the answer is no. Every agent has a fallback. */
  readonly fallback?: string;
  readonly detail: string;
}

const TIER_ORDER: readonly ModelTier[] = ['small', 'standard', 'complex'];

/**
 * Decide whether a call may be made — **before it is made**.
 *
 * Metering afterwards tells you what you already owe; that is a report, not a control. The
 * estimate is checked first, which is the only way the owner's *"no unexpected overage"* can
 * be a property of the system rather than a hope.
 *
 * When the requested tier would breach the ceiling, the call is **downgraded rather than
 * refused** where a permitted cheaper tier fits. A smaller model answering is better than no
 * answer, and both are better than silently spending more than was approved.
 */
export function admitCall(input: {
  readonly budget: AgentBudget;
  readonly requestedTier: ModelTier;
  readonly estimatedInputTokens: number;
  readonly estimatedOutputTokens: number;
  readonly pricing: Readonly<Record<ModelTier, TierPricing>>;
  readonly spentThisPeriodMinor: number;
  /** Active kill switches, from `killSwitchState`. */
  readonly killed?: boolean;
  /** What this agent's caller does without AI. Required — every agent must have one. */
  readonly fallback: string;
}): AdmissionDecision {
  const b = input.budget;
  const remainingMinor = Math.max(0, b.monthlyCeilingMinor - input.spentThisPeriodMinor);
  const base = {
    agentId: b.agentId,
    spentThisPeriodMinor: input.spentThisPeriodMinor,
    remainingMinor,
    // The point of the whole file.
    shopKeepsTrading: true as const,
    fallback: input.fallback,
  };

  if (input.killed === true) {
    return {
      ...base,
      allowed: false,
      outcome: 'killed',
      tier: input.requestedTier,
      estimatedCostMinor: 0,
      detail: `${b.agentId} is stopped by a kill switch — ${input.fallback}`,
    };
  }
  if (!b.enabled) {
    return {
      ...base,
      allowed: false,
      outcome: 'agent_disabled',
      tier: input.requestedTier,
      estimatedCostMinor: 0,
      detail: `${b.agentId} is switched off for this tenant — ${input.fallback}`,
    };
  }
  if (!b.permittedTiers.includes(input.requestedTier)) {
    return {
      ...base,
      allowed: false,
      outcome: 'tier_not_permitted',
      tier: input.requestedTier,
      estimatedCostMinor: 0,
      detail: `${b.agentId} is not approved for the ${input.requestedTier} tier — a costly model needs explicit approval for a named, low-volume task`,
    };
  }

  const costAt = (tier: ModelTier): number =>
    costOf({
      inputTokens: input.estimatedInputTokens,
      outputTokens: input.estimatedOutputTokens,
      pricing: input.pricing[tier],
    });

  const requestedCost = costAt(input.requestedTier);
  if (requestedCost <= remainingMinor) {
    return {
      ...base,
      allowed: true,
      outcome: 'allowed',
      tier: input.requestedTier,
      estimatedCostMinor: requestedCost,
      detail: `${requestedCost} estimated against ${remainingMinor} remaining this period`,
    };
  }

  // Downgrade rather than refuse, where a permitted cheaper tier fits.
  const cheaper = TIER_ORDER.filter(
    (t) => b.permittedTiers.includes(t) && TIER_ORDER.indexOf(t) < TIER_ORDER.indexOf(input.requestedTier),
  ).reverse();

  for (const tier of cheaper) {
    const cost = costAt(tier);
    if (cost <= remainingMinor) {
      return {
        ...base,
        allowed: true,
        outcome: 'allowed_downgraded',
        tier,
        estimatedCostMinor: cost,
        detail: `the ${input.requestedTier} tier would cost ${requestedCost} against ${remainingMinor} remaining, so this runs on ${tier} instead — a smaller model answering beats no answer, and both beat spending more than was approved`,
      };
    }
  }

  return {
    ...base,
    allowed: false,
    outcome: 'budget_exhausted',
    tier: input.requestedTier,
    estimatedCostMinor: requestedCost,
    detail: `${b.agentId} has spent its ${b.monthlyCeilingMinor} ceiling for this period. The AI stops; the shop does not — ${input.fallback}`,
  };
}

export interface SpendSummary {
  readonly tenantId: string;
  readonly period: string;
  readonly totalMinor: number;
  readonly byAgent: readonly { readonly agentId: AgentId; readonly costMinor: number; readonly ceilingMinor: number; readonly usedBps: number; readonly calls: number }[];
  /** Agents at or over their ceiling. Reported, and already stopped by `admitCall`. */
  readonly exhausted: readonly AgentId[];
  /** Agents past the warning threshold — told before the invoice tells anybody. */
  readonly approaching: readonly AgentId[];
  /** The platform ceiling this contributes to (D3). */
  readonly platformCeilingMinor: number;
  readonly platformShareBps: number;
  readonly detail: string;
}

/**
 * What the AI has cost this period, per agent, against each agent's own ceiling **and** the
 * platform ceiling it contributes to.
 *
 * Both figures matter and they answer different questions. The per-agent number tells you which
 * assistant to switch off; the platform share tells you whether the whole thing still fits
 * inside ₹15,000 alongside hosting, backups and messaging.
 */
export function summariseSpend(input: {
  readonly tenantId: string;
  readonly period: string;
  readonly usage: readonly UsageEntry[];
  readonly budgets: readonly AgentBudget[];
  /** D3 platform runtime ceiling in minor units. Owner-set. */
  readonly platformCeilingMinor: number;
  /** Share of an agent ceiling at which it is flagged. Default 8,000bps (80%). */
  readonly warnAtBps?: number;
}): SpendSummary {
  const warn = input.warnAtBps ?? 8_000;
  const window = input.usage.filter((u) => u.tenantId === input.tenantId && u.period === input.period);

  const byAgent = input.budgets
    .filter((b) => b.tenantId === input.tenantId)
    .map((b) => {
      const mine = window.filter((u) => u.agentId === b.agentId);
      const costMinor = mine.reduce((s, u) => s + u.costMinor, 0);
      return {
        agentId: b.agentId,
        costMinor,
        ceilingMinor: b.monthlyCeilingMinor,
        usedBps:
          b.monthlyCeilingMinor === 0
            ? 0
            : Number((BigInt(costMinor) * 10_000n) / BigInt(b.monthlyCeilingMinor)),
        calls: mine.length,
      };
    })
    .sort((a, b) => b.costMinor - a.costMinor || a.agentId.localeCompare(b.agentId));

  const totalMinor = byAgent.reduce((s, a) => s + a.costMinor, 0);
  const exhausted = byAgent.filter((a) => a.usedBps >= 10_000).map((a) => a.agentId);
  const approaching = byAgent
    .filter((a) => a.usedBps >= warn && a.usedBps < 10_000)
    .map((a) => a.agentId);

  const platformShareBps =
    input.platformCeilingMinor === 0
      ? 0
      : Number((BigInt(totalMinor) * 10_000n) / BigInt(input.platformCeilingMinor));

  return {
    tenantId: input.tenantId,
    period: input.period,
    totalMinor,
    byAgent,
    exhausted,
    approaching,
    platformCeilingMinor: input.platformCeilingMinor,
    platformShareBps,
    detail:
      exhausted.length > 0
        ? `${totalMinor} spent; ${exhausted.join(', ')} ${exhausted.length === 1 ? 'has' : 'have'} stopped at their ceiling and the shop is trading normally`
        : approaching.length > 0
          ? `${totalMinor} spent, ${(platformShareBps / 100).toFixed(1)}% of the platform ceiling; ${approaching.join(', ')} approaching their limit — worth knowing before the invoice says so`
          : `${totalMinor} spent this period, ${(platformShareBps / 100).toFixed(1)}% of the ${input.platformCeilingMinor} platform ceiling`,
  };
}

export type KillScope = 'all_ai' | 'single_agent' | 'customer_facing';

export interface KillSwitch {
  readonly switchId: string;
  readonly tenantId: string;
  readonly scope: KillScope;
  readonly agentId?: AgentId;
  readonly reason: string;
  readonly activatedBy: string;
  readonly activatedAt: string;
  readonly liftedBy?: string;
  readonly liftedAt?: string;
}

export interface KillState {
  readonly tenantId: string;
  readonly allStopped: boolean;
  readonly stoppedAgents: readonly AgentId[];
  readonly active: readonly KillSwitch[];
  readonly detail: string;
}

/**
 * Which agents are stopped right now.
 *
 * Three scopes, because the realistic emergency is specific: *"the shopping assistant is
 * telling customers the wrong thing — stop it now"*, at 8pm, by a duty manager who should not
 * have to think about which of ten agents to disable. `customer_facing` stops A04 and A05 and
 * leaves the owner's brief alone.
 *
 * **Lifting a kill switch is a separate, named act.** A switch that expires by itself is a
 * switch that turns a known-bad agent back on at midnight while nobody is watching.
 */
export function killSwitchState(input: {
  readonly tenantId: string;
  readonly switches: readonly KillSwitch[];
  readonly customerFacingAgents: readonly AgentId[];
  readonly allAgents: readonly AgentId[];
}): KillState {
  const active = input.switches.filter((s) => s.tenantId === input.tenantId && s.liftedAt === undefined);

  const allStopped = active.some((s) => s.scope === 'all_ai');
  const stopped = new Set<AgentId>();

  if (allStopped) {
    for (const a of input.allAgents) stopped.add(a);
  }
  for (const s of active) {
    if (s.scope === 'customer_facing') for (const a of input.customerFacingAgents) stopped.add(a);
    if (s.scope === 'single_agent' && s.agentId !== undefined) stopped.add(s.agentId);
  }

  const stoppedAgents = [...stopped].sort();

  return {
    tenantId: input.tenantId,
    allStopped,
    stoppedAgents,
    active,
    detail:
      stoppedAgents.length === 0
        ? 'no kill switch active'
        : allStopped
          ? `ALL AI stopped for this tenant (${active.find((s) => s.scope === 'all_ai')?.reason ?? 'no reason given'}) — every process it assists carries on without it`
          : `${stoppedAgents.join(', ')} stopped; the rest are unaffected`,
  };
}

export type KillOutcome = 'activated' | 'no_reason' | 'no_actor' | 'agent_required' | 'already_active';

export interface KillResult {
  readonly activated: boolean;
  readonly outcome: KillOutcome;
  readonly killSwitch?: KillSwitch;
  readonly stops: readonly AgentId[];
  readonly detail: string;
}

/**
 * Pull a kill switch. **Instant, and it needs a name and a reason.**
 *
 * Not an approval — a kill switch that needs approval is a kill switch that gets pulled twenty
 * minutes too late. The reason and the actor are recorded so somebody can review it afterwards,
 * which is the right order for an emergency control: act now, account later.
 */
export function activateKillSwitch(input: {
  readonly switchId: string;
  readonly tenantId: string;
  readonly scope: KillScope;
  readonly agentId?: AgentId;
  readonly reason: string;
  readonly activatedBy: string;
  readonly existing: readonly KillSwitch[];
  readonly customerFacingAgents: readonly AgentId[];
  readonly allAgents: readonly AgentId[];
  readonly at: string;
}): KillResult {
  if (input.reason.trim() === '') {
    return { activated: false, outcome: 'no_reason', stops: [], detail: 'a kill switch needs a reason, so somebody can review it afterwards' };
  }
  if (input.activatedBy.trim() === '') {
    return { activated: false, outcome: 'no_actor', stops: [], detail: 'a kill switch needs a name against it' };
  }
  if (input.scope === 'single_agent' && input.agentId === undefined) {
    return { activated: false, outcome: 'agent_required', stops: [], detail: 'which agent?' };
  }

  const duplicate = input.existing.some(
    (s) =>
      s.tenantId === input.tenantId &&
      s.liftedAt === undefined &&
      s.scope === input.scope &&
      s.agentId === input.agentId,
  );
  if (duplicate) {
    return { activated: false, outcome: 'already_active', stops: [], detail: 'that switch is already pulled' };
  }

  const killSwitch: KillSwitch = {
    switchId: input.switchId,
    tenantId: input.tenantId,
    scope: input.scope,
    agentId: input.agentId,
    reason: input.reason,
    activatedBy: input.activatedBy,
    activatedAt: input.at,
  };

  const state = killSwitchState({
    tenantId: input.tenantId,
    switches: [...input.existing, killSwitch],
    customerFacingAgents: input.customerFacingAgents,
    allAgents: input.allAgents,
  });

  return {
    activated: true,
    outcome: 'activated',
    killSwitch,
    stops: state.stoppedAgents,
    detail: `${input.activatedBy} stopped ${state.stoppedAgents.length} agent(s) — ${input.reason}. Every process they assist continues without them`,
  };
}

/**
 * Lift a kill switch. **A separate, named act** — never a timer.
 *
 * A switch that expires by itself turns a known-bad agent back on at midnight while nobody is
 * watching, which is exactly the situation somebody pulled it to prevent.
 */
export function liftKillSwitch(input: {
  readonly killSwitch: KillSwitch;
  readonly liftedBy: string;
  readonly at: string;
}): { readonly lifted: boolean; readonly killSwitch: KillSwitch; readonly detail: string } {
  if (input.liftedBy.trim() === '' || input.liftedBy === input.killSwitch.activatedBy) {
    return {
      lifted: false,
      killSwitch: input.killSwitch,
      detail:
        input.liftedBy === input.killSwitch.activatedBy
          ? `${input.liftedBy} pulled this switch and cannot also be the one to decide the problem is over (§28)`
          : 'lifting a kill switch needs a name against it',
    };
  }

  return {
    lifted: true,
    killSwitch: { ...input.killSwitch, liftedBy: input.liftedBy, liftedAt: input.at },
    detail: `${input.liftedBy} lifted the switch ${input.killSwitch.activatedBy} pulled for "${input.killSwitch.reason}"`,
  };
}
