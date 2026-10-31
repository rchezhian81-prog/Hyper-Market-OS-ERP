import { describe, it, expect } from 'vitest';
import { aiControlView, pullRequest, liftRequest, decisionRequest, withoutIt, ACT_REFUSAL_KINDS, enableRequest, budgetRequest, agentBudgetRequest, toActKey, toActWords, TO_ACT_WORDS, type ControlRead, type ControlProposal, type ControlSwitch } from '../../apps/web-erp/src/ai-control';
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
    expect(v.may).toEqual({ stop: true, decide: true, approveModel: true, evaluate: true, manageIncidents: true, setBudget: true, enable: false });
    expect(aiControlView(read(), { ...OWNER, permissions: [...OWNER.permissions, 'ai.agent.enable'] }).may.enable).toBe(true);
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
    expect(ACT_REFUSAL_KINDS).toHaveLength(8);
  });
  it('says what the shop does without each assistant', () => {
    expect(withoutIt({ agentId: 'A01' })).toMatch(/only reads and drafts/);
    expect(withoutIt({ agentId: 'A03' })).toMatch(/decided by the manager/);
  });
});

describe('AI-SCREEN (re-audit 30 Oct 2026): switching an assistant on or off, and the spending limits', () => {
  const agents = [{ agentId: 'A08' as const, enabled: true }, { agentId: 'A01' as const, enabled: false }, { agentId: 'A04' as const, enabled: true }];
  it('switching ONE assistant on or off sends head office\'s whole list with only that one changed — nobody else\'s setting', () => {
    expect(enableRequest(OWNER, agents, 'A01', true)).toEqual({ ok: true, method: 'PUT', path: '/v1/ai/agents/enabled', body: { expected: ['A04', 'A08'], agents: ['A01', 'A04', 'A08'] } });
    expect(enableRequest(OWNER, agents, 'A04', false)).toEqual({ ok: true, method: 'PUT', path: '/v1/ai/agents/enabled', body: { expected: ['A04', 'A08'], agents: ['A08'] } });
    // Already so at head office (somebody just changed it): nothing is sent.
    expect(enableRequest(OWNER, agents, 'A08', true)).toMatchObject({ ok: false, refusal: 'already_so' });
    expect(enableRequest(OWNER, agents, 'A03', true)).toMatchObject({ ok: false, refusal: 'which_agent' });
    expect(enableRequest(NOBODY, agents, 'A01', true)).toMatchObject({ ok: false, refusal: 'nobody_is_named_at_this_desk' });
  });
  it('the shop\'s limit is exact paise and a day; its shape only — head office refuses a limit above D3 itself', () => {
    expect(budgetRequest(OWNER, { cap: '1,000.50', periodEnds: '2026-11-30T18:29:00.000Z' })).toEqual({ ok: true, method: 'PUT', path: '/v1/ai/budget', body: { capMinor: 100_050, periodEnds: '2026-11-30T18:29:00.000Z' } });
    // Above the ₹15,000 ceiling is NOT refused here: head office refuses it by name (over_the_platform_ceiling).
    expect(budgetRequest(OWNER, { cap: '20000', periodEnds: '2026-11-30T18:29:00.000Z' })).toMatchObject({ ok: true, body: { capMinor: 2_000_000 } });
    expect(budgetRequest(OWNER, { cap: '', periodEnds: '2026-11-30T18:29:00.000Z' })).toMatchObject({ ok: false, refusal: 'not_money' });
    expect(budgetRequest(OWNER, { cap: '10.555', periodEnds: '2026-11-30T18:29:00.000Z' })).toMatchObject({ ok: false, refusal: 'not_money' });
    expect(budgetRequest(OWNER, { cap: '-5', periodEnds: '2026-11-30T18:29:00.000Z' })).toMatchObject({ ok: false, refusal: 'not_money' });
    expect(budgetRequest(OWNER, { cap: '100', periodEnds: '' })).toMatchObject({ ok: false, refusal: 'period_needed' });
    expect(budgetRequest(NOBODY, { cap: '100', periodEnds: '2026-11-30T18:29:00.000Z' })).toMatchObject({ ok: false, refusal: 'nobody_is_named_at_this_desk' });
  });
  it('an assistant\'s own limit, and its requests an hour only when given', () => {
    expect(agentBudgetRequest(OWNER, 'A08', { ceiling: '200', callsPerHour: '' })).toEqual({ ok: true, method: 'PUT', path: '/v1/ai/agents/A08/budget', body: { ceilingMinor: 20_000 } });
    expect(agentBudgetRequest(OWNER, 'A08', { ceiling: '200.5', callsPerHour: ' 30 ' })).toEqual({ ok: true, method: 'PUT', path: '/v1/ai/agents/A08/budget', body: { ceilingMinor: 20_050, callsPerHour: 30 } });
    expect(agentBudgetRequest(OWNER, 'A08', { ceiling: '200', callsPerHour: '0' })).toMatchObject({ ok: false, refusal: 'not_money' });
    expect(agentBudgetRequest(OWNER, 'A08', { ceiling: 'lots' })).toMatchObject({ ok: false, refusal: 'not_money' });
    expect(agentBudgetRequest(OWNER, 'A99' as 'A08', { ceiling: '1' })).toMatchObject({ ok: false, refusal: 'which_agent' });
  });
  it('every path is one of head office\'s existing governance routes — never the free-text switch, a model approval or the shop-wide switch', () => {
    const paths = [enableRequest(OWNER, agents, 'A01', true), budgetRequest(OWNER, { cap: '1', periodEnds: '2026-11-30T00:00:00Z' }), agentBudgetRequest(OWNER, 'A01', { ceiling: '1' })]
      .map((c) => (c.ok ? `${c.method} ${c.path}` : ''));
    expect(paths).toEqual(['PUT /v1/ai/agents/enabled', 'PUT /v1/ai/budget', 'PUT /v1/ai/agents/A01/budget']);
  });
});

describe('O-2: a draft\'s "to act" is said in plain words, never as a raw route', () => {
  it('every route an assistant names today has its own words, in English and Tamil; an unknown one gets the general words', () => {
    const named: readonly [string, string][] = [
      ['POST /v1/purchase/orders/:poId by a buyer, approved by a second person (§28)', 'purchase_order'],
      ['POST /v1/warehouse/transfers/:transferId by a person, dispatched and received by others (M09-FR-03 · §28)', 'transfer'],
      ['POST /v1/prices/changes (markdown) or POST /v1/warehouse/transfers/:transferId, by a manager', 'markdown_or_transfer'],
      ['POST /v1/prices/changes', 'price_change'],
      ['POST /v1/inventory/write-off/:writeOffId', 'write_off'],
      ['POST /v1/promotions/:promotionId/simulate then POST /v1/promotions/:promotionId/launch, by a marketing approver (§28)', 'promotion'],
      ['a marketing approver reviews and launches a campaign to this audience (no auto-send)', 'campaign'],
      ['POST /v1/service/cases/:caseId/first-response', 'service_reply'],
      ['POST /v1/platform/alerts/:alertId/acknowledge', 'alert'],
      ['POST /v1/hr/workforce/tasks/:taskId/complete', 'staff_task'],
      ['GET /v1/purchase/import-quality/:sourceId', 'import_quality'],
      ['GET /v1/loss-prevention/cases', 'loss_cases'],
      ['POST /v1/catalogue/products/:productId/barcodes/:code', 'barcode'],
      ['POST /v1/catalogue/merges/:mergeId', 'merge'],
      ['POST /v1/catalogue/products/:productId/publish', 'publish_mrp'],
      ['the CUSTOMER confirms any change to their cart in the app — A04 only drafts the shortlist', 'customer_confirms'],
      ['nothing — A01 is read-only; a person decides what, if anything, to do', 'nothing'],
      ['POST /v1/something/new', 'general'],
    ];
    for (const [route, key] of named) {
      expect(toActKey(route), route).toBe(key);
      for (const lang of ['en', 'ta'] as const) {
        const said = toActWords(route, lang);
        expect(said, `${route} (${lang})`).not.toMatch(/\/v1\/|POST|GET|:[a-zA-Z]+Id/);
        expect(said.length).toBeGreaterThan(10);
      }
    }
    for (const words of Object.values(TO_ACT_WORDS)) expect(words.ta).not.toBe(words.en);
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
