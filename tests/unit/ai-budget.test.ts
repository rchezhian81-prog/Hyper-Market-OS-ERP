import { describe, it, expect } from 'vitest';
import * as ai from '../../packages/ai/src/index';
import {
  costOf,
  admitCall,
  summariseSpend,
  killSwitchState,
  activateKillSwitch,
  liftKillSwitch,
  type AgentBudget,
  type TierPricing,
  type UsageEntry,
  type KillSwitch,
} from '../../packages/ai/src/budget';
import type { ModelTier } from '../../packages/ai/src/gateway';
import type { AgentId } from '../../packages/ai/src/authority';

// Owner cost decision, 4 Aug 2026: ₹15,000/month platform runtime; every agent its own
// ceiling; customer-facing on the smallest model; fail SAFE when exhausted; no overage.

/** Indicative rates in paise per million tokens. Configuration, not a provider price list. */
const PRICING: Readonly<Record<ModelTier, TierPricing>> = {
  small: { inputPerMillionMinor: 6_000, outputPerMillionMinor: 30_000 },
  standard: { inputPerMillionMinor: 25_000, outputPerMillionMinor: 125_000 },
  complex: { inputPerMillionMinor: 125_000, outputPerMillionMinor: 625_000 },
};

const budget = (over: Partial<AgentBudget> = {}): AgentBudget => ({
  agentId: 'A01', tenantId: 't-sre',
  monthlyCeilingMinor: 100_000, // ₹1,000
  defaultTier: 'standard',
  permittedTiers: ['small', 'standard'],
  enabled: true,
  ...over,
});

function admit(over: Partial<Parameters<typeof admitCall>[0]> = {}) {
  return admitCall({
    budget: budget(), requestedTier: 'standard',
    estimatedInputTokens: 3_000, estimatedOutputTokens: 500,
    pricing: PRICING, spentThisPeriodMinor: 0,
    fallback: 'the brief still sends with every figure, and no written summary',
    ...over,
  });
}

describe('the AI stops and the SHOP DOES NOT (P-01, hard rule #1)', () => {
  it('types shopKeepsTrading as literally true, on every path', () => {
    const paths = [
      admit(),
      admit({ spentThisPeriodMinor: 100_000 }),
      admit({ killed: true }),
      admit({ budget: budget({ enabled: false }) }),
      admit({ requestedTier: 'complex' }),
    ];
    for (const p of paths) expect(p.shopKeepsTrading).toBe(true);
  });

  it('names what happens instead, every time it says no', () => {
    const exhausted = admit({ spentThisPeriodMinor: 100_000 });
    expect(exhausted.allowed).toBe(false);
    expect(exhausted.outcome).toBe('budget_exhausted');
    expect(exhausted.fallback).toContain('the brief still sends with every figure');
    expect(exhausted.detail).toContain('The AI stops; the shop does not');
  });

  it('EXPOSES NO FUNCTION that could stop trading on cost', () => {
    const named = Object.keys(ai);
    for (const forbidden of ['suspendTrading', 'blockPos', 'haltStore', 'enforceSpend']) {
      expect(named).not.toContain(forbidden);
    }
  });
});

describe('a call is admitted BEFORE it is made — the only way "no overage" is true', () => {
  it('computes cost exactly in integer minor units', () => {
    // 3,000 in at 25,000/M = 75; 500 out at 125,000/M = 62
    expect(costOf({ inputTokens: 3_000, outputTokens: 500, pricing: PRICING.standard })).toBe(137);
  });

  it('allows a call that fits', () => {
    const d = admit();
    expect(d.allowed).toBe(true);
    expect(d.outcome).toBe('allowed');
    expect(d.estimatedCostMinor).toBe(137);
    expect(d.remainingMinor).toBe(100_000);
  });

  it('DOWNGRADES the tier rather than refusing, when a cheaper one fits', () => {
    // Only 40 paise left: standard costs 137, small costs 33.
    const d = admit({ spentThisPeriodMinor: 99_960 });
    expect(d.allowed).toBe(true);
    expect(d.outcome).toBe('allowed_downgraded');
    expect(d.tier).toBe('small');
    expect(d.estimatedCostMinor).toBe(33);
    expect(d.detail).toContain('both beat spending more than was approved');
  });

  it('NEVER upgrades a tier', () => {
    const d = admit({ requestedTier: 'small' });
    expect(d.tier).toBe('small');
    // Even with the whole ceiling free, a small request stays small.
    expect(d.estimatedCostMinor).toBe(33);
  });

  it('refuses a tier the agent is not approved for', () => {
    const d = admit({ requestedTier: 'complex' });
    expect(d.outcome).toBe('tier_not_permitted');
    expect(d.detail).toContain('explicit approval for a named, low-volume task');
  });

  it('refuses when nothing fits, and stays exact about what is left', () => {
    const d = admit({ spentThisPeriodMinor: 99_990 });
    expect(d.allowed).toBe(false);
    expect(d.outcome).toBe('budget_exhausted');
    expect(d.remainingMinor).toBe(10);
  });

  it('honours a per-agent switch and a kill switch separately', () => {
    expect(admit({ budget: budget({ enabled: false }) }).outcome).toBe('agent_disabled');
    expect(admit({ killed: true }).outcome).toBe('killed');
  });

  it('puts customer-facing agents on the smallest model by default', () => {
    const shopping = budget({ agentId: 'A04', defaultTier: 'small', permittedTiers: ['small'] });
    expect(shopping.defaultTier).toBe('small');
    expect(admit({ budget: shopping, requestedTier: 'standard' }).outcome).toBe('tier_not_permitted');
  });
});

const usage = (over: Partial<UsageEntry> = {}): UsageEntry => ({
  tenantId: 't-sre', agentId: 'A01', period: '2026-08',
  inputTokens: 3_000, outputTokens: 500, tier: 'standard', costMinor: 137, ...over,
});

describe('spend is reported per agent AND against the platform ceiling (D3)', () => {
  const budgets = [
    budget({ agentId: 'A01', monthlyCeilingMinor: 100_000 }),
    budget({ agentId: 'A04', monthlyCeilingMinor: 500_000 }),
  ];

  it('answers both questions: which agent, and does it fit in ₹15,000', () => {
    const s = summariseSpend({
      tenantId: 't-sre', period: '2026-08', budgets,
      usage: [
        ...Array.from({ length: 100 }, (_, n) => usage({ agentId: 'A01', costMinor: 137, inputTokens: n })),
        ...Array.from({ length: 50 }, () => usage({ agentId: 'A04', costMinor: 33 })),
      ],
      platformCeilingMinor: 1_500_000, // ₹15,000
    });
    expect(s.totalMinor).toBe(13_700 + 1_650);
    expect(s.byAgent[0]?.agentId).toBe('A01');
    expect(s.byAgent[0]?.calls).toBe(100);
    expect(s.platformShareBps).toBe(102);
    expect(s.detail).toContain('of the 1500000 platform ceiling');
  });

  it('flags an agent approaching its ceiling BEFORE the invoice does', () => {
    const s = summariseSpend({
      tenantId: 't-sre', period: '2026-08', budgets,
      usage: [usage({ agentId: 'A01', costMinor: 85_000 })],
      platformCeilingMinor: 1_500_000,
    });
    expect(s.approaching).toEqual(['A01']);
    expect(s.detail).toContain('before the invoice says so');
  });

  it('reports an exhausted agent and says the shop is fine', () => {
    const s = summariseSpend({
      tenantId: 't-sre', period: '2026-08', budgets,
      usage: [usage({ agentId: 'A01', costMinor: 100_000 })],
      platformCeilingMinor: 1_500_000,
    });
    expect(s.exhausted).toEqual(['A01']);
    expect(s.detail).toContain('the shop is trading normally');
  });

  it('never counts another tenant or another period', () => {
    const s = summariseSpend({
      tenantId: 't-sre', period: '2026-08', budgets,
      usage: [
        usage({ costMinor: 100 }),
        usage({ tenantId: 't-kumar', costMinor: 999_999 }),
        usage({ period: '2026-07', costMinor: 999_999 }),
      ],
      platformCeilingMinor: 1_500_000,
    });
    expect(s.totalMinor).toBe(100);
  });
});

const ALL_AGENTS: readonly AgentId[] = ['A01', 'A02', 'A03', 'A04', 'A05', 'A06', 'A07', 'A08', 'A09', 'A10'];
const CUSTOMER_FACING: readonly AgentId[] = ['A04', 'A05'];

const killSwitch = (over: Partial<KillSwitch> = {}): KillSwitch => ({
  switchId: 'ks-1', tenantId: 't-sre', scope: 'customer_facing',
  reason: 'the shopping assistant is quoting the wrong return policy',
  activatedBy: 'u-duty-manager', activatedAt: '2026-08-05T20:00:00Z', ...over,
});

describe('the kill switch is instant, scoped and reversible', () => {
  it('stops the two customer-facing agents and leaves the owner brief alone', () => {
    const state = killSwitchState({
      tenantId: 't-sre', switches: [killSwitch()],
      customerFacingAgents: CUSTOMER_FACING, allAgents: ALL_AGENTS,
    });
    // The realistic 8pm emergency, without a duty manager having to think about which
    // of ten agents to disable.
    expect(state.stoppedAgents).toEqual(['A04', 'A05']);
    expect(state.allStopped).toBe(false);
  });

  it('stops everything on the all_ai scope', () => {
    const state = killSwitchState({
      tenantId: 't-sre', switches: [killSwitch({ scope: 'all_ai' })],
      customerFacingAgents: CUSTOMER_FACING, allAgents: ALL_AGENTS,
    });
    expect(state.allStopped).toBe(true);
    expect(state.stoppedAgents).toHaveLength(10);
    expect(state.detail).toContain('carries on without it');
  });

  it('stops a single named agent', () => {
    const state = killSwitchState({
      tenantId: 't-sre', switches: [killSwitch({ scope: 'single_agent', agentId: 'A09' })],
      customerFacingAgents: CUSTOMER_FACING, allAgents: ALL_AGENTS,
    });
    expect(state.stoppedAgents).toEqual(['A09']);
  });

  it('needs a name and a reason, but NOT an approval', () => {
    const activate = (over: Partial<Parameters<typeof activateKillSwitch>[0]> = {}) =>
      activateKillSwitch({
        switchId: 'ks-2', tenantId: 't-sre', scope: 'customer_facing',
        reason: 'wrong policy quoted', activatedBy: 'u-duty-manager',
        existing: [], customerFacingAgents: CUSTOMER_FACING, allAgents: ALL_AGENTS,
        at: '2026-08-05T20:00:00Z', ...over,
      });

    const ok = activate();
    expect(ok.activated).toBe(true);
    expect(ok.stops).toEqual(['A04', 'A05']);
    // A kill switch that needs approval is one that gets pulled twenty minutes too late.
    expect(ok.detail).toContain('Every process they assist continues without them');

    expect(activate({ reason: '  ' }).outcome).toBe('no_reason');
    expect(activate({ activatedBy: '' }).outcome).toBe('no_actor');
    expect(activate({ scope: 'single_agent' }).outcome).toBe('agent_required');
    expect(activate({ existing: [killSwitch({ switchId: 'ks-1' })] }).outcome).toBe('already_active');
  });

  it('does NOT expire by itself — lifting is a separate, named act', () => {
    const lifted = liftKillSwitch({
      killSwitch: killSwitch(), liftedBy: 'u-owner', at: '2026-08-06T09:00:00Z',
    });
    expect(lifted.lifted).toBe(true);
    expect(lifted.killSwitch.liftedBy).toBe('u-owner');

    // A switch that expires turns a known-bad agent back on at midnight.
    const state = killSwitchState({
      tenantId: 't-sre', switches: [lifted.killSwitch],
      customerFacingAgents: CUSTOMER_FACING, allAgents: ALL_AGENTS,
    });
    expect(state.stoppedAgents).toEqual([]);
  });

  it('will not let the person who pulled it also decide the problem is over', () => {
    const r = liftKillSwitch({
      killSwitch: killSwitch(), liftedBy: 'u-duty-manager', at: '2026-08-06T09:00:00Z',
    });
    expect(r.lifted).toBe(false);
    expect(r.detail).toContain('cannot also be the one to decide the problem is over');
  });

  it('never applies another tenant\'s switch', () => {
    const state = killSwitchState({
      tenantId: 't-sre', switches: [killSwitch({ tenantId: 't-kumar', scope: 'all_ai' })],
      customerFacingAgents: CUSTOMER_FACING, allAgents: ALL_AGENTS,
    });
    expect(state.stoppedAgents).toEqual([]);
  });
});
