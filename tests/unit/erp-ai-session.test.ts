import { describe, it, expect } from 'vitest';
import {
  createAiSession, fallbackFor, admissionFor,
  PULL_REFUSAL_KINDS, DECIDE_REFUSAL_KINDS,
  type AiConfig, type AiPorts, type PendingProposal,
} from '../../apps/web-erp/src/ai-session';
import {
  AGENTS, FORBIDDEN_TOOLS,
  type AgentBudget, type AgentId, type KillSwitch, type ModelTier,
  type TierPricing, type UsageEntry,
} from '../../packages/ai/src/index';

/**
 * **AI control (M32 · M36 · A01–A10 · AI-NFR-01…12 · API-13 · P-05 · hard rule #5).**
 *
 * The design bar is one line: *AI recommends or drafts; deterministic rules and authorised humans
 * commit — and a kill switch that always works.*
 *
 * The controls under test are the ones nothing outside their own tests had ever reached:
 *
 *   • **a stopped agent reads as stopped**, decided from the switches every time, never a flag;
 *   • **no agent is ever granted a forbidden tool**, and the screen shows the list;
 *   • an agent with **no ceiling**, and one whose **spend was never metered**, each say which —
 *     neither is a budget of nought, and the two need different answers;
 *   • **one number, one source**: what an agent has spent comes from the metered calls filtered to
 *     the period, so the assistants tab and the cost tab beside it cannot disagree;
 *   • an agent **never evaluated** is `undefined`, not a score of nought;
 *   • a proposal is committed **by a named person**, and the agent is recorded as the drafter;
 *   • **nobody named at the desk means nothing can be pulled and nothing can be committed.**
 */

const NOW = '2026-08-06T14:00:00.000Z';
const ALL: readonly AgentId[] = Object.keys(AGENTS) as AgentId[];

const budget = (over: Partial<AgentBudget> = {}): AgentBudget => ({
  agentId: 'A02', tenantId: 't1', monthlyCeilingMinor: 100_000,
  defaultTier: 'standard', permittedTiers: ['small', 'standard'], enabled: true,
  ...over,
});

const killSwitch = (over: Partial<KillSwitch> = {}): KillSwitch => ({
  switchId: 'KS-1', tenantId: 't1', scope: 'single_agent', agentId: 'A04',
  reason: 'it told a customer the wrong allergen', activatedBy: 'u-manager',
  activatedAt: '2026-08-06T13:00:00.000Z',
  ...over,
});

const usage = (over: Partial<UsageEntry> = {}): UsageEntry => ({
  tenantId: 't1', agentId: 'A02', period: '2026-08',
  inputTokens: 1_000, outputTokens: 500, tier: 'standard', costMinor: 400,
  ...over,
});

const pending = (over: Partial<PendingProposal> = {}): PendingProposal => ({
  proposalId: 'P-1',
  agentId: 'A02',
  proposal: {
    tool: 'draft_purchase_order',
    rationale: 'toor dal cover is 4 days and the supplier lead time is 6',
    arguments: { supplierId: 'sup-1' },
  },
  proposedAt: '2026-08-06T13:45:00.000Z',
  verifiedCitations: ['ev-stock-1'],
  ...over,
});

const PRICING: Readonly<Record<ModelTier, TierPricing>> = {
  small: { inputPerMillionMinor: 10_000, outputPerMillionMinor: 30_000 },
  standard: { inputPerMillionMinor: 40_000, outputPerMillionMinor: 120_000 },
  complex: { inputPerMillionMinor: 200_000, outputPerMillionMinor: 600_000 },
};

const CONFIG: AiConfig = { tenantId: 't1', userId: 'u-owner', now: NOW, staleAfterMinutes: 60 };

function ports(over: Partial<AiPorts> = {}): AiPorts {
  return {
    switches: () => [],
    budgets: () => [budget()],
    usage: () => [],
    platformCeilingMinor: () => 1_500_000,
    period: () => '2026-08',
    pending: () => [],
    evaluations: () => ({}),
    ...over,
  };
}

const ai = (over: Partial<AiPorts> = {}, config: Partial<AiConfig> = {}) =>
  createAiSession({ ...CONFIG, ...config }, ports(over));

const view = (agentId: AgentId, over: Partial<AiPorts> = {}, config: Partial<AiConfig> = {}) => {
  const found = ai(over, config).agents().find((a) => a.agentId === agentId);
  expect(found, `no view for ${agentId}`).toBeDefined();
  return found!;
};

// ── The one that was not merely unwired ─────────────────────────────────────

describe('a stopped agent reads as stopped, from the switches, every time', () => {
  it('shows every agent running when no switch is pulled', () => {
    expect(ai().agents().filter((a) => a.stopped)).toHaveLength(0);
    expect(ai().agents()).toHaveLength(ALL.length);
  });

  it('shows the single stopped agent, and only that one', () => {
    const agents = ai({ switches: () => [killSwitch()] }).agents();
    expect(agents.filter((a) => a.stopped).map((a) => a.agentId)).toEqual(['A04']);
  });

  it('puts the stopped ones FIRST, because that is what somebody came here about', () => {
    const agents = ai({ switches: () => [killSwitch({ agentId: 'A07' })] }).agents();
    expect(agents[0]?.agentId).toBe('A07');
    expect(agents[0]?.stopped).toBe(true);
  });

  it('stops every customer-facing agent on one pull, and leaves the rest alone', () => {
    const agents = ai({
      switches: () => [killSwitch({ scope: 'customer_facing', agentId: undefined })],
    }).agents();
    const stopped = agents.filter((a) => a.stopped).map((a) => a.agentId);
    const facing = ALL.filter((a) => AGENTS[a].customerFacing);
    expect([...stopped].sort()).toEqual([...facing].sort());
    expect(stopped.length).toBeGreaterThan(0);
    expect(stopped.length).toBeLessThan(ALL.length);
  });

  it('a lifted switch stops nothing — lifting is a real act, not a flag left set', () => {
    const agents = ai({
      switches: () => [killSwitch({ liftedBy: 'u-owner', liftedAt: NOW })],
    }).agents();
    expect(agents.filter((a) => a.stopped)).toHaveLength(0);
  });
});

describe('pulling the switch', () => {
  it('records who pulled it and what it stopped', () => {
    const result = ai().pull({ scope: 'all_ai', reason: 'the provider is answering nonsense' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect([...result.stops].sort()).toEqual([...ALL].sort());
      expect(result.detail).toContain('u-owner');
    }
  });

  it('refuses without a reason — somebody has to be able to review it afterwards', () => {
    const result = ai().pull({ scope: 'all_ai', reason: '  ' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal).toBe('refused');
  });

  it('refuses when the box was not told who is at the desk', () => {
    // Not a default of "the owner". A kill switch carries a name or it does not get pulled.
    const result = ai({}, { userId: null }).pull({ scope: 'all_ai', reason: 'stop it' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal).toBe('nobody_is_named_at_this_desk');
  });

  it('refuses to pull the same switch twice', () => {
    const result = ai({ switches: () => [killSwitch()] })
      .pull({ scope: 'single_agent', agentId: 'A04', reason: 'still wrong' });
    expect(result.ok).toBe(false);
  });

  it('lifts a switch, but not by the person who pulled it', () => {
    const pulled = killSwitch({ activatedBy: 'u-owner' });
    const refused = ai({ switches: () => [pulled] }).lift({ switchId: 'KS-1', reason: 'fixed' });
    expect(refused.ok, 'the same person pulled and lifted it').toBe(false);

    const allowed = ai({ switches: () => [pulled] }, { userId: 'u-manager2' })
      .lift({ switchId: 'KS-1', reason: 'fixed' });
    expect(allowed.ok).toBe(true);
  });

  it('refuses to lift a switch that does not exist', () => {
    const result = ai({ switches: () => [killSwitch()] }).lift({ switchId: 'KS-99', reason: 'x' });
    expect(result.ok).toBe(false);
  });
});

describe('every agent says what the shop does without it', () => {
  it('has a fallback sentence for all ten', () => {
    for (const agent of ai().agents()) {
      expect(agent.fallback.length, `${agent.agentId} has no fallback`).toBeGreaterThan(20);
    }
  });

  it('says a read-only agent takes no work with it when it goes', () => {
    expect(fallbackFor('A01')).toContain('only reads and drafts');
  });

  it('names the human who decides when a proposing agent is stopped', () => {
    expect(fallbackFor('A02')).toContain('buyer');
  });
});

// ── What no configuration can ever grant ────────────────────────────────────

describe('no agent is granted a forbidden tool, and the list is shown', () => {
  it('shows the forbidden list as a list — a rule nobody can see is a rule nobody trusts', () => {
    expect(ai().forbidden()).toEqual(FORBIDDEN_TOOLS);
    expect(ai().forbidden()).toContain('commit_payment');
    expect(ai().forbidden()).toContain('write_database');
  });

  it('no agent view offers a forbidden tool', () => {
    for (const agent of ai().agents()) {
      for (const tool of agent.tools) {
        expect(FORBIDDEN_TOOLS, `${agent.agentId} offers ${tool}`).not.toContain(tool);
      }
    }
  });

  it('a disabled agent is offered no tools at all', () => {
    const disabled = view('A02', { budgets: () => [budget({ enabled: false })] });
    expect(disabled.tools).toEqual([]);
  });
});

// ── Absence is not nought ───────────────────────────────────────────────────

describe('what has never been set reads as never set', () => {
  it('an agent with no budget has NO budget, not a budget of nought', () => {
    // A03 has no budget row in the fixture. Reporting `ceilingMinor: 0` would show every one of
    // these agents sitting comfortably inside a limit nobody has ever agreed.
    expect(view('A03').budget).toEqual({ known: false, why: 'no_ceiling_set' });
  });

  it('an agent with a budget shows spend, ceiling and what is left', () => {
    const funded = view('A02', { usage: () => [usage({ costMinor: 30_000 })] });
    expect(funded.budget).toEqual({
      known: true, spentMinor: 30_000, ceilingMinor: 100_000, remainingMinor: 70_000,
    });
  });

  it('never reports a negative remainder', () => {
    const over = view('A02', { usage: () => [usage({ costMinor: 140_000 })] });
    expect(over.budget).toEqual({
      known: true, spentMinor: 140_000, ceilingMinor: 100_000, remainingMinor: 0,
    });
  });

  it('counts only THIS period — last month’s calls are not this month’s spend', () => {
    // The fault this shape exists for. A carried per-agent total with no period on it read
    // 95,000 spent on the assistants tab while the cost tab beside it read nought.
    const carried = view('A02', {
      usage: () => [usage({ period: '2026-07', costMinor: 95_000 }), usage({ costMinor: 400 })],
    });
    expect(carried.budget).toEqual({
      known: true, spentMinor: 400, ceilingMinor: 100_000, remainingMinor: 99_600,
    });
  });

  it('and the two tabs cannot disagree, because they are the same calls', () => {
    const ports = { usage: () => [usage({ period: '2026-07', costMinor: 95_000 }), usage({ costMinor: 400 })] };
    const onTheAgent = view('A02', ports).budget;
    const onTheCostTab = ai(ports).spend()?.byAgent.find((a) => a.agentId === 'A02');
    expect(onTheAgent.known && onTheAgent.spentMinor).toBe(onTheCostTab?.costMinor);
  });

  it('an agent whose spend was never metered says so, rather than reading as unspent', () => {
    // A substituted nought hands it the whole ceiling again, every period, for as long as the
    // meter is broken — the more expensive of the two guesses.
    expect(view('A02', { usage: () => undefined }).budget)
      .toEqual({ known: false, why: 'spend_not_known' });
  });

  it('an agent NEVER evaluated is undefined, not a score of nought', () => {
    expect(view('A01').evaluation).toBeUndefined();
  });

  it('an evaluated agent carries its score and when it was run', () => {
    const evaluated = view('A01', {
      evaluations: () => ({ A01: { passed: 18, total: 20, at: '2026-08-05T10:00:00.000Z' } }),
    });
    expect(evaluated.evaluation).toEqual({ passed: 18, total: 20, at: '2026-08-05T10:00:00.000Z' });
  });

  it('with no platform ceiling set there is NO spend summary, not a comfortable one', () => {
    // D3 is the owner's ₹15,000 rule. A summary built without it reports a share of nothing.
    expect(ai({ platformCeilingMinor: () => undefined }).spend()).toBeUndefined();
  });

  it('with no metered calls at all there is NO summary either', () => {
    // "The AI has cost nothing" is the same sentence a shop with no AI would see.
    expect(ai({ usage: () => undefined }).spend()).toBeUndefined();
  });

  it('summarises spend against the platform ceiling when one has been set', () => {
    const summary = ai({ usage: () => [usage(), usage({ costMinor: 600 })] }).spend();
    expect(summary?.totalMinor).toBe(1_000);
    expect(summary?.platformCeilingMinor).toBe(1_500_000);
  });
});

// ── AI drafts; a person commits ─────────────────────────────────────────────

describe('the queue shows what is waiting and what it actually cited', () => {
  it('accepts a granted, reasoned, cited proposal for approval — and nothing has happened yet', () => {
    const queued = ai({ pending: () => [pending()] }).queue();
    expect(queued).toHaveLength(1);
    expect(queued[0]?.review.verdict).toBe('accepted_for_approval');
    expect(queued[0]?.review.approver).toBe('buyer');
  });

  it('refuses a proposal whose citations were never verified, however confident it reads', () => {
    const queued = ai({ pending: () => [pending({ verifiedCitations: [] })] }).queue();
    expect(queued[0]?.review.verdict).toBe('no_evidence');
    expect(queued[0]?.review.accepted).toBe(false);
  });

  it('records a forbidden tool as a security event, not a mistake', () => {
    const queued = ai({
      pending: () => [pending({
        proposal: { tool: 'commit_purchase_order', rationale: 'stock is low', arguments: {} },
      })],
    }).queue();
    expect(queued[0]?.review.verdict).toBe('forbidden_tool');
    expect(queued[0]?.review.securityEvent).toBe(true);
  });

  it('reviews against the same grant the runtime uses, so an ungranted tool is refused', () => {
    const queued = ai({
      pending: () => [pending({
        proposal: { tool: 'suggest_markdown', rationale: 'expiring', arguments: {} },
      })],
    }).queue();
    expect(queued[0]?.review.verdict).toBe('tool_not_granted');
  });
});

describe('committing is a human act', () => {
  it('records the person as the actor and the agent as the drafter', () => {
    const result = ai({ pending: () => [pending()] }, { userId: 'u-buyer' })
      .decide({ proposalId: 'P-1', approverRole: 'buyer' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.actor).toBe('u-buyer');
      expect(result.record.draftedBy).toBe('A02');
    }
  });

  it('refuses the wrong approving role', () => {
    const result = ai({ pending: () => [pending()] }, { userId: 'u-someone' })
      .decide({ proposalId: 'P-1', approverRole: 'manager' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal).toBe('refused');
  });

  it('refuses a proposal drafted against figures that have moved', () => {
    const result = ai(
      { pending: () => [pending({ proposedAt: '2026-08-06T10:00:00.000Z' })] },
      { userId: 'u-buyer' },
    ).decide({ proposalId: 'P-1', approverRole: 'buyer' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toContain('regenerate');
  });

  it('refuses a proposal it has never heard of', () => {
    const result = ai({ pending: () => [pending()] }).decide({ proposalId: 'P-9', approverRole: 'buyer' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal).toBe('no_such_proposal');
  });

  it('refuses when the box was not told who is at the desk', () => {
    const result = ai({ pending: () => [pending()] }, { userId: null })
      .decide({ proposalId: 'P-1', approverRole: 'buyer' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal).toBe('nobody_is_named_at_this_desk');
  });

  it('an AGENT can never be the approver, whatever id is at the desk', () => {
    for (const agentId of ALL) {
      const result = ai({ pending: () => [pending()] }, { userId: agentId })
        .decide({ proposalId: 'P-1', approverRole: 'buyer' });
      expect(result.ok, `${agentId} approved its own kind`).toBe(false);
    }
  });
});

// ── The admission the gateway now requires ──────────────────────────────────

describe('admission is decided before a call, by the same rule the gateway enforces', () => {
  const call = (over: Partial<Parameters<typeof admissionFor>[0]> = {}) =>
    admissionFor({
      agentId: 'A02', budget: budget(), requestedTier: 'standard',
      estimatedInputTokens: 1_000, estimatedOutputTokens: 500,
      pricing: PRICING, spentThisPeriodMinor: 0, killed: false,
      ...over,
    });

  it('allows a call inside its ceiling', () => {
    expect(call().allowed).toBe(true);
  });

  it('refuses a killed agent, and says what the shop does instead', () => {
    const decision = call({ killed: true });
    expect(decision.allowed).toBe(false);
    expect(decision.detail).toContain('buyer');
  });

  it('refuses when the ceiling is spent', () => {
    expect(call({ spentThisPeriodMinor: 100_000 }).allowed).toBe(false);
  });

  it('refuses a disabled agent', () => {
    expect(call({ budget: budget({ enabled: false }) }).allowed).toBe(false);
  });

  it('refuses when nothing has measured what it has spent', () => {
    // A ceiling can only be enforced against a figure somebody actually measured.
    const decision = call({ spentThisPeriodMinor: undefined });
    expect(decision.allowed).toBe(false);
    expect(decision.detail).toContain('cannot be enforced');
  });
});

// ── The refusal words the screen must be able to say ────────────────────────

describe('the screen can name every refusal it can produce', () => {
  it('lists every pull refusal', () => {
    expect(PULL_REFUSAL_KINDS).toContain('nobody_is_named_at_this_desk');
    expect(PULL_REFUSAL_KINDS).toContain('refused');
  });

  it('lists every decide refusal', () => {
    expect(DECIDE_REFUSAL_KINDS).toContain('no_such_proposal');
    expect(DECIDE_REFUSAL_KINDS.length).toBe(3);
  });
});
