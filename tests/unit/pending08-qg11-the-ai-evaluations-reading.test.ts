import { describe, it, expect } from 'vitest';
import { createGatesSession, qg11ReadingView, gatesWords, type Qg11ControlRead } from '../../apps/web-erp/src/gates-session';

// QG-11 (roadmap §22 "Accuracy/safety evaluations, authority, evidence, human override, budgets and kill switch pass") — the
// AI gate's reading on the Quality gates page, built on head office's own AI control read (GET /v1/ai/control): per agent in
// the evaluation set, its latest run (complete or NOT COMPLETE, passed or failed, any unsafe case); the kill switch; the
// budgets. With no live model connected (OB-296; live provider EX-12) no run can be complete, so the gate HOLDS until R8
// (OB-382). A clean reading is evidence for the owner's decision, never "passed"; a reading that cannot be read is never "none".

type Agent = Qg11ControlRead['agents'][number];
const run = (over: Partial<NonNullable<Agent['lastEvaluation']>> = {}): NonNullable<Agent['lastEvaluation']> => ({
  runId: 'evr-A01-1', at: '2026-11-27T04:30:00.000Z', passed: 0, total: 6, unsafe: 0, complete: false, fitToFacePeople: false, detail: 'not complete', ...over,
});
const agent = (agentId: string, lastEvaluation: Agent['lastEvaluation'], over: Partial<Agent> = {}): Agent => ({
  agentId, name: `Assistant ${agentId}`, enabled: true, stopped: false, stoppedBecause: null, ceilingMinor: null, evaluationCases: 6, lastEvaluation, ...over,
});
const control = (over: Partial<Qg11ControlRead> = {}): Qg11ControlRead => ({
  agents: [agent('A01', null), agent('A02', null), agent('A07', null, { evaluationCases: 0 })],
  killSwitch: { masterOn: false, active: [] },
  budget: { capMinor: 0, spentMinor: 0, platformCeilingMinor: 1_500_000 },
  provider: { configured: false },
  ...over,
});
const ok = (value: Qg11ControlRead) => ({ result: 'ok' as const, value });
const all = (v: ReturnType<typeof qg11ReadingView>) => [v.headline, ...v.agents.map((a) => a.words), ...v.lines].join('\n');

describe('QG-11: the AI evaluations reading on the Quality gates page', () => {
  it('with no live model the gate HOLDS: every agent in the set is listed, none run yet or NOT COMPLETE — never passed', () => {
    const none = qg11ReadingView('en', ok(control()));
    expect([none.icon, none.tone, none.state]).toEqual(['⚠', 'error', 'no_live_model']);
    expect(none.headline).toBe('HOLD — no live model is connected (OB-296; live provider EX-12), so no agent\'s evaluation can be complete.');
    // Only the agents the evaluation set has cases for (A07 has none).
    expect(none.agents.map((a) => a.agentId)).toEqual(['A01', 'A02']);
    expect(none.agents.map((a) => [a.icon, a.state])).toEqual([['○', 'not_run'], ['○', 'not_run']]);
    expect(none.agents[0]!.words).toBe('A01 · Assistant A01 — no evaluation has been run yet');
    const notComplete = qg11ReadingView('en', ok(control({ agents: [agent('A01', run()), agent('A02', null)] })));
    expect(notComplete.agents[0]).toMatchObject({ icon: '⚠', state: 'not_complete' });
    expect(notComplete.agents[0]!.words).toBe('A01 · Assistant A01 — NOT COMPLETE: it did not reach a model, so it proves nothing · run evr-A01-1 · 2026-11-27 10:00');
    expect(notComplete.lines).toContain('QG-11 holds until every agent in the evaluation set has a complete, passing evaluation against a live model (R8, OB-382).');
    // OB-935 (owner decided A): the reading says head office refuses GO until then — the only "GO" it ever says.
    const GO_REFUSED = 'Head office refuses GO on QG-11 until then (owner\'s decision, 27 Nov 2026 — OB-935); HOLD and REWORK can still be recorded.';
    expect(notComplete.lines.at(-1)).toBe(GO_REFUSED);
    expect(all(notComplete).replace(GO_REFUSED, '')).not.toMatch(/\bpassed\b|GO/);
  });

  it('says the kill switch and the budgets in words, set or not', () => {
    const v = qg11ReadingView('en', ok(control()));
    expect(v.lines).toContain('Kill switch: off — no assistant is stopped by it.');
    expect(v.lines).toContain('Shop AI budget: not set — no call that costs anything can be made.');
    expect(v.lines).toContain('Agents with a budget of their own: none — only the shop budget applies.');
    const set = qg11ReadingView('en', ok(control({
      agents: [agent('A01', null, { ceilingMinor: 600_000 }), agent('A02', null)],
      killSwitch: { masterOn: false, active: [{ switchId: 'ks-1', scope: 'single_agent', agentId: 'A06' }] },
      budget: { capMinor: 1_000_000, spentMinor: 12_345, platformCeilingMinor: 1_500_000 },
    })));
    expect(set.lines).toContain('Kill switch: 1 switch is stopping an assistant (A06).');
    expect(set.lines).toContain('Shop AI budget: ₹10,000.00 a month, ₹123.45 spent (platform ceiling ₹15,000.00).');
    expect(set.lines).toContain('Agents with a budget of their own: A01.');
    const master = qg11ReadingView('en', ok(control({ killSwitch: { masterOn: true, active: [] } })));
    expect(master.lines).toContain('Kill switch: the shop-wide AI switch is ON — every assistant is stopped.');
  });

  it('with a model connected: a failed or unsafe agent holds the gate by name; all complete and passing is evidence, not the decision', () => {
    const bad = qg11ReadingView('en', ok(control({
      provider: { configured: true },
      agents: [agent('A01', run({ complete: true, passed: 6, fitToFacePeople: true })), agent('A02', run({ runId: 'evr-A02-1', complete: true, passed: 4, unsafe: 1 })), agent('A03', run({ runId: 'evr-A03-1', complete: true, passed: 5 }))],
    })));
    expect([bad.icon, bad.state]).toEqual(['⚠', 'holds']);
    expect(bad.headline).toBe('HOLD — 2 of 3 agents have no complete, passing evaluation.');
    expect(bad.agents.map((a) => [a.agentId, a.icon, a.state])).toEqual([['A01', '✓', 'passed'], ['A02', '⚠', 'unsafe'], ['A03', '⚠', 'failed']]);
    expect(bad.agents[1]!.words).toMatch(/^A02 · Assistant A02 — UNSAFE: 1 unsafe case; 4 of 6 passed · run evr-A02-1/);
    expect(bad.agents[2]!.words).toMatch(/^A03 · Assistant A03 — failed: 5 of 6 passed · run evr-A03-1/);
    const clean = qg11ReadingView('en', ok(control({ provider: { configured: true }, agents: [agent('A01', run({ complete: true, passed: 6, fitToFacePeople: true }))] })));
    expect([clean.icon, clean.tone, clean.state]).toEqual(['✓', 'ok', 'evaluations_clean']);
    expect(clean.headline).toBe('Every agent\'s latest evaluation is complete and passing, with no unsafe case.');
    expect(clean.lines).toContain('This is evidence for the owner\'s QG-11 decision, not the decision — the gate is not passed until he records it with his signed review.');
  });

  it('silence is never a pass: an empty set, an unread reading, or nobody signed in all HOLD in words', () => {
    const empty = qg11ReadingView('en', ok(control({ provider: { configured: true }, agents: [] })));
    expect(empty.state).toBe('holds');
    expect(empty.headline).toBe('HOLD — no agent has evaluation cases on record, so nothing has been evaluated.');
    for (const out of [null, { result: 'lost_link' as const }, { result: 'invalid' as const, why: 'cannotReadAi' }]) {
      const v = qg11ReadingView('en', out);
      expect([v.icon, v.state]).toEqual(['⚠', 'unread']);
      expect(v.headline).toMatch(/^The AI evaluations reading could not be read — this is not the same as "none"\./);
      expect(v.lines).toContain('QG-11 holds until every agent in the evaluation set has a complete, passing evaluation against a live model (R8, OB-382).');
    }
  });

  it('Tamil: every word of the reading has its Tamil twin', () => {
    const v = qg11ReadingView('ta', ok(control()));
    expect(v.headline).toBe(gatesWords('ta', 'qg11NoLiveModel'));
    for (const k of ['qg11H', 'qg11Lead', 'qg11NoLiveModel', 'qg11Holds', 'qg11HoldsN', 'qg11Empty', 'qg11Clean', 'qg11NotPassed', 'qg11HoldsUntil', 'qg11GoRefused', 'qg11Unread',
      'qg11NotRun', 'qg11NotComplete', 'qg11Unsafe', 'qg11Failed', 'qg11Passed', 'qg11RunK', 'qg11KillOff', 'qg11KillMaster', 'qg11KillScoped',
      'qg11CapNone', 'qg11Cap', 'qg11OwnNone', 'qg11Own', 'qg11ProviderNone', 'qg11Provider', 'cannotReadAi']) {
      expect(gatesWords('ta', k), k).not.toBe(gatesWords('en', k));
      expect(gatesWords('en', k), k).not.toBe(k);
    }
  });

  it('the session reads head office\'s AI control only for whoever may read both the register and the AI records', async () => {
    const urls: string[] = [];
    const fetch = (async (url: string) => { urls.push(String(url)); return new Response(JSON.stringify(control()), { status: 200 }); }) as unknown as typeof globalThis.fetch;
    expect(await createGatesSession({ viewer: undefined, fetch }).readQg11()).toEqual({ result: 'invalid', why: 'nobody' });
    expect(await createGatesSession({ viewer: { userId: 'u-c', permissions: ['ai.proposal.read'] } as never, fetch }).readQg11()).toEqual({ result: 'invalid', why: 'cannotRead' });
    expect(await createGatesSession({ viewer: { userId: 'u-r', permissions: ['compliance.gate.read'] } as never, fetch }).readQg11()).toEqual({ result: 'invalid', why: 'cannotReadAi' });
    expect(urls).toEqual([]);
    const out = await createGatesSession({ viewer: { userId: 'u-o', permissions: ['compliance.gate.read', 'ai.proposal.read'] } as never, fetch }).readQg11();
    expect(out.result).toBe('ok');
    expect(urls).toEqual(['/v1/ai/control']);
  });
});
