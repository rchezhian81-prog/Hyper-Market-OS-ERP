import { describe, it, expect } from 'vitest';
import * as ai from '../../packages/ai/src/index';
import {
  AGENTS,
  FORBIDDEN_TOOLS,
  grantTools,
  reviewProposals,
  commitProposal,
  type AgentId,
  type ReviewedProposal,
} from '../../packages/ai/src/authority';
import type { ToolProposal } from '../../packages/ai/src/gateway';

// AI-NFR-12 (absolute): no autonomous payment, refund, purchase commitment, price change,
// stock adjustment or user-privilege change. The model never writes to a business database.

const ALL: readonly AgentId[] = ['A01', 'A02', 'A03', 'A04', 'A05', 'A06', 'A07', 'A08', 'A09', 'A10'];

describe('AI-NFR-12 is enforced structurally, not by discipline', () => {
  it('defines all ten roadmap agents', () => {
    expect(Object.keys(AGENTS).sort()).toEqual([...ALL]);
  });

  it('NO agent is granted a forbidden tool, in any definition', () => {
    for (const id of ALL) {
      const overlap = AGENTS[id].allowedTools.filter((t) => FORBIDDEN_TOOLS.includes(t));
      expect(overlap, `${id} was granted ${overlap.join(', ')}`).toEqual([]);
    }
  });

  it('EXPOSES NO FUNCTION that could widen an agent at runtime', () => {
    // Absence as a control. The pressure runs one way: every quarter somebody has a good
    // reason why THIS agent should just apply the markdown itself.
    const named = Object.keys(ai);
    for (const forbidden of ['grantForbiddenTool', 'overrideAuthority', 'addTool', 'elevateAgent', 'bypassApproval']) {
      expect(named).not.toContain(forbidden);
    }
  });

  it('subtracts forbidden tools even if a definition were edited badly', () => {
    // Belt and braces: grantTools filters FORBIDDEN_TOOLS regardless of the definition.
    const grant = grantTools({ agentId: 'A02', tenantEnabled: true, agentEnabled: true });
    expect(grant.tools.some((t) => FORBIDDEN_TOOLS.includes(t))).toBe(false);
  });

  it('keeps A01, the agent closest to the owner, READ-ONLY', () => {
    expect(AGENTS.A01.readOnly).toBe(true);
    const reviews = reviewProposals({
      agentId: 'A01',
      proposals: [{ tool: 'draft_brief', arguments: {}, rationale: 'the owner asked' }],
      grantedTools: ['draft_brief'],
      verifiedCitations: ['ev-1'],
    });
    expect(reviews[0]?.accepted).toBe(false);
    expect(reviews[0]?.verdict).toBe('read_only_agent');
    expect(reviews[0]?.detail).toContain('that is its whole authority');
  });

  it('requires evidence of every agent', () => {
    for (const id of ALL) expect(AGENTS[id].requiresEvidence).toBe(true);
  });
});

describe('tools are an allowlist, and the switches are per tenant and per agent', () => {
  it('grants exactly the agent\'s own tools', () => {
    const grant = grantTools({ agentId: 'A03', tenantEnabled: true, agentEnabled: true });
    expect(grant.tools).toEqual(AGENTS.A03.allowedTools);
    expect(grant.detail).toContain('a manager');
  });

  it('one tenant setting stops EVERY agent instantly', () => {
    const grant = grantTools({ agentId: 'A04', tenantEnabled: false, agentEnabled: true });
    expect(grant.granted).toBe(false);
    expect(grant.outcome).toBe('tenant_disabled');
    expect(grant.tools).toEqual([]);
  });

  it('one agent can be stopped without touching the rest', () => {
    const off = grantTools({ agentId: 'A04', tenantEnabled: true, agentEnabled: false });
    expect(off.outcome).toBe('agent_disabled');
    expect(off.detail).toContain('the others are unaffected');
    expect(grantTools({ agentId: 'A01', tenantEnabled: true, agentEnabled: true }).granted).toBe(true);
  });

  it('honours a tenant switching off a single tool', () => {
    const grant = grantTools({
      agentId: 'A03', tenantEnabled: true, agentEnabled: true, tenantDisabledTools: ['suggest_markdown'],
    });
    expect(grant.tools).not.toContain('suggest_markdown');
    expect(grant.tools).toContain('suggest_transfer');
  });
});

const proposal = (over: Partial<ToolProposal> = {}): ToolProposal => ({
  tool: 'suggest_markdown', arguments: { productId: 'p-1' }, rationale: '9 days to expiry, 40 units', ...over,
});

describe('a proposal is reviewed against the agent\'s authority', () => {
  const review = (over: Partial<Parameters<typeof reviewProposals>[0]> = {}) =>
    reviewProposals({
      agentId: 'A03', proposals: [proposal()],
      grantedTools: [...AGENTS.A03.allowedTools], verifiedCitations: ['ev-1'], ...over,
    })[0]!;

  it('accepts a well-formed proposal FOR APPROVAL — nothing has happened yet', () => {
    const r = review();
    expect(r.accepted).toBe(true);
    expect(r.verdict).toBe('accepted_for_approval');
    expect(r.approver).toBe('manager');
    expect(r.detail).toContain('NOTHING has happened yet');
  });

  it('REFUSES a forbidden tool FIRST, before any other check, as a security event', () => {
    const r = review({ proposals: [proposal({ tool: 'commit_stock_adjustment' })] });
    expect(r.verdict).toBe('forbidden_tool');
    expect(r.securityEvent).toBe(true);
    expect(r.detail).toContain('no agent, no tenant and no setting can grant it');
  });

  it('refuses every one of the forbidden tools', () => {
    for (const tool of FORBIDDEN_TOOLS) {
      const r = review({ proposals: [proposal({ tool })], grantedTools: [tool] });
      // Even when the caller mistakenly "granted" it.
      expect(r.accepted).toBe(false);
      expect(r.verdict).toBe('forbidden_tool');
    }
  });

  it('refuses a tool that was not granted on this call', () => {
    const r = review({ grantedTools: ['read_stock_position'] });
    expect(r.verdict).toBe('tool_not_granted');
    expect(r.securityEvent).toBe(true);
  });

  it('refuses an uncited answer — the failure mode people trust most', () => {
    const r = review({ verifiedCitations: [] });
    expect(r.verdict).toBe('no_evidence');
    expect(r.detail).toContain('a confident answer with nothing behind it');
  });

  it('refuses a proposal with no rationale', () => {
    expect(review({ proposals: [proposal({ rationale: '  ' })] }).verdict).toBe('no_rationale');
  });
});

describe('the human is the ACTOR and the agent is the DRAFTER (§28)', () => {
  const accepted: ReviewedProposal = {
    agentId: 'A03', tool: 'suggest_markdown', verdict: 'accepted_for_approval',
    accepted: true, approver: 'manager', securityEvent: false, detail: 'queued',
  };

  const commit = (over: Partial<Parameters<typeof commitProposal>[0]> = {}) =>
    commitProposal({
      proposalId: 'prop-1', agentId: 'A03', tool: 'suggest_markdown', review: accepted,
      approvedBy: 'u-manager', approverRole: 'manager',
      proposedAt: '2026-08-05T09:00:00Z', at: '2026-08-05T09:10:00Z', ...over,
    });

  it('records the PERSON as the actor and the agent as the drafter', () => {
    const r = commit();
    expect(r.committed).toBe(true);
    expect(r.actor).toBe('u-manager');
    expect(r.draftedBy).toBe('A03');
    // "The AI did it" is an audit trail with nobody in it.
    expect(r.detail).toContain('the person is the actor and the agent is the drafter');
  });

  it('REFUSES to let an agent approve anything', () => {
    const r = commit({ approvedBy: 'A07', agentIdentities: ['A01', 'A07'] });
    expect(r.outcome).toBe('agent_cannot_approve');
    expect(r.detail).toContain('no identity in this system is both');
  });

  it('refuses an unnamed approver and the wrong role', () => {
    expect(commit({ approvedBy: '  ' }).outcome).toBe('not_approved');
    const wrongRole = commit({ approverRole: 'customer' });
    expect(wrongRole.outcome).toBe('approver_wrong_role');
    expect(wrongRole.detail).toContain('needs a manager');
  });

  it('refuses a proposal that was never accepted', () => {
    const r = commit({
      review: { ...accepted, accepted: false, verdict: 'forbidden_tool', detail: 'forbidden' },
    });
    expect(r.outcome).toBe('proposal_not_accepted');
  });

  it('REFUSES a stale proposal rather than approving yesterday\'s reasoning', () => {
    const r = commit({ at: '2026-08-05T11:30:00Z' });
    expect(r.outcome).toBe('stale_proposal');
    expect(r.detail).toContain('figures that have moved');
  });
});

describe('every agent matches its roadmap authority', () => {
  it('names the right approver for each', () => {
    const expected: Readonly<Record<AgentId, string>> = {
      A01: 'none', A02: 'buyer', A03: 'manager', A04: 'customer', A05: 'agent_supervisor',
      A06: 'operator', A07: 'security_officer', A08: 'data_steward', A09: 'marketing_approver',
      A10: 'manager',
    };
    for (const id of ALL) expect(AGENTS[id].approver).toBe(expected[id]);
  });

  it('marks exactly the two customer-facing agents', () => {
    expect(ALL.filter((id) => AGENTS[id].customerFacing)).toEqual(['A04', 'A05']);
  });

  it('gives A07 no power to sanction anybody', () => {
    expect(AGENTS.A07.allowedTools.every((t) => t.startsWith('read_') || t.startsWith('summarise') || t.startsWith('prioritise'))).toBe(true);
    expect(AGENTS.A07.purpose).toContain('NO autonomous sanctions');
  });

  it('gives A10 no HR authority', () => {
    expect(AGENTS.A10.purpose).toContain('NO HR decisions');
    expect(AGENTS.A10.allowedTools).not.toContain('grant_privilege');
  });
});
