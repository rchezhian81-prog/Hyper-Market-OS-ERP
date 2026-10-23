import { describe, it, expect } from 'vitest';
import { aiControlView, pullRequest, liftRequest, decisionRequest, withoutIt, ACT_REFUSAL_KINDS, type ControlRead, type ControlProposal, type ControlSwitch } from '../../apps/web-erp/src/ai-control';
import { aiViewerFrom } from '../../apps/web-erp/src/browser-entry';
import { FORBIDDEN_TOOLS } from '../../packages/ai/src/index';

// OB-288 lane 4 · P1 — the AI control screen's view model over head office's live read (roadmap §27 "AI control").

const agent = (id: 'A01' | 'A04' | 'A08', over: Partial<ControlRead['agents'][number]> = {}): ControlRead['agents'][number] => ({
  agentId: id, name: id, purpose: 'p', approver: 'manager', readOnly: false, customerFacing: id === 'A04', tools: ['t'], enabled: true,
  stopped: false, stoppedBecause: null, spentMinor: 0, ceilingMinor: null, callsPerHour: null, evaluationCases: 4, lastEvaluation: null, awaitingDecision: 0, ...over,
});
const proposal = (id: string, createdAt: string, outcome: ControlProposal['outcome'] = null): ControlProposal => ({
  proposalId: id, agent: 'A08', summary: 's', wouldRequire: 'POST /v1/catalogue/x', evidence: [{ source: 'm', reference: 'r', summary: 'x' }], createdAt,
  confidence: { band: 'high', basis: 'recorded_fact', uncertainty: 'u' }, outcome,
});
const read = (over: Partial<ControlRead> = {}): ControlRead => ({
  agents: [agent('A01'), agent('A08'), agent('A04', { stopped: true, stoppedBecause: 'kill_switch' })],
  forbidden: [...FORBIDDEN_TOOLS],
  killSwitch: { masterOn: false, active: [], history: [] },
  budget: { capMinor: 0, spentMinor: 0, periodEnds: '2026-10-31', platformCeilingMinor: 1_500_000, ceilingsTotalMinor: 0 },
  provider: { configured: false, said: 'none' }, models: [], freeText: { enabled: false }, evaluations: { setVersion: 4 },
  incidents: { open: 0, list: [] },
  proposals: { awaitingDecision: 1, list: [proposal('p-old', '2026-10-22T00:00:00Z', { decision: 'approved', by: 'u', at: 'x' }), proposal('p-new', '2026-10-23T00:00:00Z')] },
  modelCalls: { count: 0, chain: { ok: true }, recent: [] }, decisions: {}, asAt: '2026-10-23T10:00:00Z', ...over,
});
const OWNER = { userId: 'u-owner', permissions: ['ai.killswitch.set', 'ai.proposal.decide', 'ai.model.approve', 'ai.evaluation.run', 'ai.incident.manage', 'ai.budget.set'] };
const READER = { userId: 'u-mgr', permissions: ['ai.proposal.read'] };
const NOBODY = { userId: null, permissions: null };

describe('the AI control view model', () => {
  it('lists stopped assistants first, the waiting drafts first, and offers only what the person holds', () => {
    const v = aiControlView(read(), OWNER);
    expect(v.agents.map((a) => a.agentId)).toEqual(['A04', 'A01', 'A08']);
    expect(v.queue.map((p) => [p.proposalId, p.mayDecide])).toEqual([['p-new', true], ['p-old', false]]);
    expect(v.may).toEqual({ stop: true, decide: true, approveModel: true, evaluate: true, manageIncidents: true, setBudget: true });
    const r = aiControlView(read(), READER);
    expect(r.may.stop).toBe(false);
    expect(r.queue.every((p) => !p.mayDecide)).toBe(true);
    // Nobody named: nothing is offered.
    const n = aiControlView(read(), NOBODY);
    expect(n.nobodyNamed).toBe(true);
    expect(Object.values(n.may).every((x) => x === false)).toBe(true);
    // Permission words not given: the page offers, the server decides.
    expect(aiControlView(read(), { userId: 'u', permissions: null }).may.stop).toBe(true);
  });

  it('a shop AI cap of nought is "nothing that costs may run" — never a comfortable 0% used', () => {
    expect(aiControlView(read(), OWNER).cost).toEqual({ known: false, why: 'no_cap_set' });
    const v = aiControlView(read({ budget: { capMinor: 100_000, spentMinor: 25_000, periodEnds: 'x', platformCeilingMinor: 1_500_000, ceilingsTotalMinor: 0 }, agents: [agent('A01', { spentMinor: 25_000, ceilingMinor: 50_000 }), agent('A08')] }), OWNER);
    expect(v.cost).toMatchObject({ known: true, usedBps: 2_500 });
    if (v.cost.known) expect(v.cost.rows).toEqual([
      { agentId: 'A01', spentMinor: 25_000, ceilingMinor: 50_000, usedBps: 5_000, callsPerHour: null },
      { agentId: 'A08', spentMinor: 0, ceilingMinor: null, usedBps: null, callsPerHour: null },
    ]);
  });

  it('the forbidden list is always shown, in full', () => {
    expect(aiControlView(read({ forbidden: [] }), OWNER).forbidden).toEqual(FORBIDDEN_TOOLS);
  });
});

describe('every act is checked here and SENT to head office', () => {
  const sw: ControlSwitch = { switchId: 'ks 1', scope: 'customer_facing', reason: 'r', activatedBy: 'u-owner', activatedAt: 'x' };
  it('pulling needs a name, a reason, and the agent for a single stop', () => {
    expect(pullRequest(NOBODY, { scope: 'all_ai', reason: 'x' })).toMatchObject({ ok: false, refusal: 'nobody_is_named_at_this_desk' });
    expect(pullRequest(OWNER, { scope: 'all_ai', reason: '  ' })).toMatchObject({ ok: false, refusal: 'reason_needed' });
    expect(pullRequest(OWNER, { scope: 'single_agent', reason: 'x' })).toMatchObject({ ok: false, refusal: 'which_agent' });
    expect(pullRequest(OWNER, { scope: 'single_agent', agentId: 'A04', reason: ' wrong milk ' })).toEqual({ ok: true, method: 'POST', path: '/v1/ai/kill-switches', body: { scope: 'single_agent', agentId: 'A04', reason: 'wrong milk' } });
    expect(pullRequest(OWNER, { scope: 'all_ai', agentId: 'A04', reason: 'x' })).toMatchObject({ ok: true, body: { scope: 'all_ai', reason: 'x' } });
  });
  it('lifting is somebody else\'s, with a reason; the switch id is escaped into the path', () => {
    expect(liftRequest(OWNER, sw, 'fixed')).toMatchObject({ ok: false, refusal: 'same_person' });
    expect(liftRequest({ userId: 'u-2', permissions: null }, sw, '')).toMatchObject({ ok: false, refusal: 'reason_needed' });
    expect(liftRequest({ userId: 'u-2', permissions: null }, sw, 'checked')).toEqual({ ok: true, method: 'POST', path: '/v1/ai/kill-switches/ks%201/lift', body: { reason: 'checked' } });
  });
  it('a decision is once, and a rejection says why', () => {
    const open = proposal('p 1', 'x');
    expect(decisionRequest(OWNER, open, 'rejected', '')).toMatchObject({ ok: false, refusal: 'reason_needed' });
    expect(decisionRequest(OWNER, proposal('p', 'x', { decision: 'approved', by: 'u', at: 'x' }), 'approved', '')).toMatchObject({ ok: false, refusal: 'not_yours' });
    expect(decisionRequest(OWNER, open, 'approved', '')).toEqual({ ok: true, method: 'POST', path: '/v1/ai/proposals/p%201/outcome', body: { decision: 'approved' } });
    expect(ACT_REFUSAL_KINDS).toHaveLength(5);
  });
  it('says what the shop does without each assistant', () => {
    expect(withoutIt({ agentId: 'A01' })).toMatch(/only reads and drafts/);
    expect(withoutIt({ agentId: 'A03' })).toMatch(/decided by the manager/);
  });
});

describe('who is looking — only the user id and the permission words are kept', () => {
  it('drops everything else and never invents a name', () => {
    expect(aiViewerFrom(undefined)).toEqual({ userId: null, permissions: null });
    expect(aiViewerFrom({ userId: ' ', killSwitches: [] })).toEqual({ userId: null, permissions: null });
    expect(aiViewerFrom({ userId: 'u-1', permissions: ['ai.proposal.read'], usage: [1] })).toEqual({ userId: 'u-1', permissions: ['ai.proposal.read'] });
    expect(aiViewerFrom({ userId: 'u-1', permissions: [1] })).toEqual({ userId: 'u-1', permissions: null });
  });
});
