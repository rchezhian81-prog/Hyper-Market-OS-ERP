import { describe, it, expect } from 'vitest';
import { aiRoutes, type AiDeps, type AgentCatalogue } from '../../services/ai/src/index';
import type { RequestContext, Route } from '../../services/kernel/src/index';

// CORE-01 inc3: the running ai service serves the agent authority catalogue from the tested
// packages/ai engine (AGENTS + FORBIDDEN_TOOLS), not a second copy. The engine's own rules are
// pinned in tests/unit/ai-authority.test.ts; here we prove the running route delegates to it.

const NOW = '2026-08-10T12:00:00Z';

const ctx = (): RequestContext => ({
  tenantId: 'sre', userId: 'owner-1', branchId: null, params: {}, query: {}, body: undefined, traceId: 't',
});

const deps: AiDeps = {
  killSwitchOn: () => false, setKillSwitch: () => {}, budget: () => ({ capMinor: 0, spentMinor: 0, periodEnds: NOW }),
  enabledAgents: () => [], run: () => [], openProposals: () => [], now: () => NOW,
};

const agentsRoute = (): Route => {
  const r = aiRoutes(deps).find((x) => x.method === 'GET' && x.path === '/v1/ai/agents');
  if (r === undefined) throw new Error('no GET /v1/ai/agents');
  return r;
};

describe('GET /v1/ai/agents serves the tested authority engine', () => {
  it('returns all ten agents with their authority — read-only and approver from the engine', async () => {
    const res = await agentsRoute().handler(ctx());
    expect(res.status).toBe(200);
    const body = res.body as AgentCatalogue;

    expect(body.agents).toHaveLength(10);
    const a01 = body.agents.find((a) => a.agentId === 'A01');
    expect(a01?.readOnly).toBe(true);       // Owner Intelligence — least power, read-only
    expect(a01?.approver).toBe('none');
    const a02 = body.agents.find((a) => a.agentId === 'A02');
    expect(a02?.readOnly).toBe(false);      // Purchase — drafts a PO, a buyer commits it
    expect(a02?.approver).toBe('buyer');
  });

  it('publishes the tools NO agent may ever be granted (AI-NFR-12), and no agent lists one', async () => {
    const body = (await agentsRoute().handler(ctx())).body as AgentCatalogue;
    expect(body.neverAllowed).toContain('issue_refund');
    expect(body.neverAllowed).toContain('write_database');
    expect(body.neverAllowed).toContain('commit_price_change');

    // The invariant, proven on the RUNNING surface: no agent's allowed tools include a forbidden one.
    const forbidden = new Set(body.neverAllowed);
    for (const agent of body.agents) {
      for (const tool of agent.allowedTools) {
        expect(forbidden.has(tool), `${agent.agentId} lists forbidden tool ${tool}`).toBe(false);
      }
    }
  });

  it('commits nothing — it is a read of authority, and says so', async () => {
    const body = (await agentsRoute().handler(ctx())).body as AgentCatalogue;
    expect(body.committedAnything).toBe(false);
  });
});
