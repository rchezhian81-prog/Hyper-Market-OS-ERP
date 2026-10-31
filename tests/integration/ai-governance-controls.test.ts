import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore, type EventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { simulatedTransport, type ModelTier, type TierPricing } from '../../packages/ai/src/index';
import { EVALUATION_SET, EVALUATION_SIMULATOR } from '../../services/ai/src/evaluation-set';

/**
 * **The AI is governed by people, on the server (OB-288 lane 4 · P1 · AI-NFR-01/04/07/09/10 · AI-INCIDENTS · OB-296).**
 *
 * Through the real API — in memory and, with DATABASE_URL, on real PostgreSQL — with a cold restart that reads every
 * register back from the store:
 *   • D3: the shop's AI cap can never exceed the ₹15,000-a-month platform ceiling; every agent's own ceiling fits inside it;
 *   • a SCOPED kill switch (customer-facing) needs a reason, stops exactly A04 and A05, leaves the rest running, and is
 *     lifted only by a DIFFERENT person with a reason; the history is kept;
 *   • the evaluation route runs A02's and A03's cases through the governed call against the stand-in: complete, fit, safe,
 *     and compared with the previous run;
 *   • only an APPROVED model may be called — approval cites a passed evaluation; withdrawing it refuses calls again;
 *   • free text for A01 is OFF until switched on (OB-296); the owner's call-rate limit and an agent's own ceiling refuse
 *     before the call;
 *   • a model reaching for a tool it was never granted is dropped AND raises an AI incident; incidents are owned and
 *     closed with a reason;
 *   • every proposal carries a confidence band; a person approves or rejects it — once — and nothing is committed;
 *   • the people without the authority are refused (403).
 */

const OWNER = 'u-owner'; const OWNER2 = 'u-owner-2'; const MGR = 'u-mgr'; const CASH = 'u-cash';
const PRICING: Readonly<Record<ModelTier, TierPricing>> = {
  small: { inputPerMillionMinor: 1_000_000, outputPerMillionMinor: 2_000_000 },
  standard: { inputPerMillionMinor: 3_000_000, outputPerMillionMinor: 6_000_000 },
  complex: { inputPerMillionMinor: 9_000_000, outputPerMillionMinor: 18_000_000 },
};

const DATABASE_URL = process.env['DATABASE_URL'];
let pool: Pool | undefined;
beforeAll(async () => {
  if (DATABASE_URL === undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
  const dir = 'db/migrations';
  await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
});
afterAll(async () => { await pool?.end(); });

type Make = (store?: EventStore) => ApiHarness;
const backings: { name: string; make: Make }[] = [
  { name: 'the in-memory event store', make: (store) => apiHarness({ ...(store === undefined ? {} : { store }), modelTransport: simulatedTransport(EVALUATION_SIMULATOR), modelPricing: PRICING }) },
];
if (DATABASE_URL !== undefined) {
  backings.push({ name: 'real PostgreSQL', make: () => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql), modelTransport: simulatedTransport(EVALUATION_SIMULATOR), modelPricing: PRICING }); } });
}

const code = (r: { body: unknown }): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
const evalInstruction = (caseId: string): string => EVALUATION_SET.find((c) => c.caseId === caseId)!.instruction;

describe.each(backings)('the AI is governed by people, on the server — on $name', ({ make }) => {
  it('D3 cap, agent ceilings, scoped kill switch, evaluations, the model register, free text, rate limits, incidents, decisions — and a cold restart', async () => {
    let h = make();
    const T = randomUUID();
    await h.seedOwner(T, OWNER);
    await h.provisionOwner(T, OWNER2);
    await h.provisionRole(T, MGR, 'store_manager');
    await h.provisionRole(T, CASH, 'cashier');
    const req = (method: 'GET' | 'POST' | 'PUT', path: string, userId: string, body?: unknown, key?: string) =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'GET' ? {} : { idempotencyKey: key ?? `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }) });

    // ── OB-296: the shop starts with every assistant stopped, no model approved and free text off.
    const control0 = (await req('GET', '/v1/ai/control', OWNER)).body as { killSwitch: { masterOn: boolean }; agents: { stopped: boolean }[]; models: unknown[]; freeText: { enabled: boolean } };
    expect(control0.killSwitch.masterOn).toBe(true);
    expect(control0.agents.every((a) => a.stopped)).toBe(true);
    expect(control0.models).toEqual([]);
    expect(control0.freeText.enabled).toBe(false);

    // ── D3: the AI cap can never exceed ₹15,000 a month (the whole platform's runtime ceiling).
    const over = await req('PUT', '/v1/ai/budget', OWNER, { capMinor: 1_500_001, periodEnds: '2099-01-01T00:00:00.000Z' });
    expect(over.status).toBe(409);
    expect(code(over)).toBe('over_the_platform_ceiling');
    expect((await req('PUT', '/v1/ai/budget', OWNER, { capMinor: 1_000_000, periodEnds: '2099-01-01T00:00:00.000Z' })).status).toBe(200);

    // ── Per-agent ceilings fit inside the shop cap; the cap cannot then be cut below them. The rate limit is the owner's.
    expect(code(await req('PUT', '/v1/ai/agents/A01/budget', OWNER, { ceilingMinor: 1_000_001 }))).toBe('agent_ceilings_exceed_the_shop_cap');
    expect((await req('PUT', '/v1/ai/agents/A01/budget', OWNER, { ceilingMinor: 600_000, callsPerHour: 2 })).status).toBe(200);
    expect(code(await req('PUT', '/v1/ai/agents/A04/budget', OWNER, { ceilingMinor: 500_000 }))).toBe('agent_ceilings_exceed_the_shop_cap');
    expect(code(await req('PUT', '/v1/ai/budget', OWNER, { capMinor: 500_000, periodEnds: '2099-01-01T00:00:00.000Z' }))).toBe('below_the_agent_ceilings');
    expect((await req('PUT', '/v1/ai/agents/A01/budget', CASH, { ceilingMinor: 1 })).status).toBe(403);
    const budgets = (await req('GET', '/v1/ai/agent-budgets', OWNER)).body as { agents: { agentId: string; ceiling: { set: boolean; ceilingMinor?: number }; callsPerHour: { set: boolean; limit?: number } }[]; platformCeilingMinor: number };
    expect(budgets.platformCeilingMinor).toBe(1_500_000);
    expect(budgets.agents.find((a) => a.agentId === 'A01')).toMatchObject({ ceiling: { set: true, ceilingMinor: 600_000 }, callsPerHour: { set: true, limit: 2 } });
    expect(budgets.agents.find((a) => a.agentId === 'A02')).toMatchObject({ ceiling: { set: false }, callsPerHour: { set: false } });

    // ── The owner switches the assistants on for the trial.
    expect(code(await req('PUT', '/v1/ai/kill-switch', OWNER, { on: true }))).toBe('kill_switch_needs_a_reason');
    expect((await req('PUT', '/v1/ai/kill-switch', OWNER, { on: false, reason: 'trial' })).status).toBe(200);
    expect((await req('PUT', '/v1/ai/agents/enabled', OWNER, { expected: [], agents: ['A01', 'A02', 'A03', 'A04', 'A05', 'A06'] })).status).toBe(200);

    // ── AI-NFR-10: a scoped kill switch — reason required, customer-facing only, instant, no approval.
    expect((await req('POST', '/v1/ai/kill-switches', CASH, { scope: 'customer_facing', reason: 'x' })).status).toBe(403);
    expect(code(await req('POST', '/v1/ai/kill-switches', OWNER, { scope: 'customer_facing' }))).toBe('kill_switch_no_reason');
    const pulled = await req('POST', '/v1/ai/kill-switches', OWNER, { scope: 'customer_facing', reason: 'the shopping assistant offered the wrong milk' }, 'pull-1');
    expect(pulled.status).toBe(201);
    const ks = (pulled.body as { killSwitch: { switchId: string }; stops: string[] });
    expect(ks.stops).toEqual(['A04', 'A05']);
    expect((await req('POST', '/v1/ai/agents/A04/runs', OWNER, {})).status).toBe(503);
    expect((await req('POST', '/v1/ai/agents/A05/runs', OWNER, {})).status).toBe(503);
    expect((await req('POST', '/v1/ai/agents/A01/runs', OWNER, {})).status).toBe(200); // the rest run on
    expect(code(await req('POST', '/v1/ai/kill-switches', OWNER, { scope: 'customer_facing', reason: 'again' }))).toBe('kill_switch_already_active');
    // Lifting: a separate act, with a reason, by somebody else (§28).
    expect(code(await req('POST', `/v1/ai/kill-switches/${ks.killSwitch.switchId}/lift`, OWNER2, {}))).toBe('lift_needs_a_reason');
    expect(code(await req('POST', `/v1/ai/kill-switches/${ks.killSwitch.switchId}/lift`, OWNER, { reason: 'fixed' }))).toBe('same_person_cannot_lift');
    expect((await req('POST', `/v1/ai/kill-switches/${ks.killSwitch.switchId}/lift`, OWNER2, { reason: 'the alternatives were checked against stock' })).status).toBe(200);
    expect((await req('POST', '/v1/ai/agents/A04/runs', OWNER, {})).status).toBe(200);

    // ── AI-NFR-01: no model is approved yet — a call is refused before any transport, and audited.
    const notApproved = await req('POST', '/v1/ai/agents/A06/model-calls', OWNER, { instruction: evalInstruction('a06-runbook'), scope: { evaluationCase: 'a06-runbook' } });
    expect(notApproved.status).toBe(409);
    expect(code(notApproved)).toBe('model_not_approved');

    // ── AI-NFR-09: the evaluation route — A02's and A03's cases through the governed call, recorded, compared.
    expect((await req('POST', '/v1/ai/evaluations/A02', CASH)).status).toBe(403);
    expect(code(await req('POST', '/v1/ai/evaluations/A99', OWNER))).toBe('unknown_agent');
    const a02 = await req('POST', '/v1/ai/evaluations/A02', OWNER, undefined, 'eval-a02-1');
    expect(a02.status, JSON.stringify(a02.body)).toBe(201);
    const run02 = (a02.body as { run: { runId: string; complete: boolean; unsafe: number; fitToFacePeople: boolean; total: number; passed: number; regression: unknown } }).run;
    expect(run02).toMatchObject({ complete: true, unsafe: 0, fitToFacePeople: true, total: 4, passed: 4, regression: null });
    const a03 = (await req('POST', '/v1/ai/evaluations/A03', OWNER, undefined, 'eval-a03-1')).body as { run: { complete: boolean; unsafe: number; fitToFacePeople: boolean; total: number } };
    expect(a03.run).toMatchObject({ complete: true, unsafe: 0, fitToFacePeople: true, total: 4 });
    const again02 = (await req('POST', '/v1/ai/evaluations/A02', OWNER, undefined, 'eval-a02-2')).body as { run: { regression: { verdict: string; againstRunId: string; releasable: boolean } } };
    expect(again02.run.regression).toMatchObject({ verdict: 'unchanged', againstRunId: run02.runId, releasable: true });
    // A stopped agent's evaluation reaches no model, and is recorded as proving nothing.
    expect((await req('POST', '/v1/ai/kill-switches', OWNER, { scope: 'single_agent', agentId: 'A06', reason: 'evaluating with A06 stopped' }, 'pull-a06')).status).toBe(201);
    const stoppedEval = (await req('POST', '/v1/ai/evaluations/A06', OWNER, undefined, 'eval-a06-stopped')).body as { run: { runId: string; complete: boolean; fitToFacePeople: boolean; reachedModel: number } };
    expect(stoppedEval.run).toMatchObject({ complete: false, fitToFacePeople: false, reachedModel: 0 });

    // ── The register: approval cites a PASSED evaluation; a run that proves nothing is refused.
    expect((await req('POST', '/v1/ai/models', MGR, { modelId: 'stand-in-small', adapterId: 'simulator', tier: 'small', dataResidency: 'india', evaluationRunId: run02.runId })).status).toBe(403);
    expect(code(await req('POST', '/v1/ai/models', OWNER, { modelId: 'stand-in-small', adapterId: 'simulator', tier: 'small', dataResidency: 'india', evaluationRunId: 'evr-nope' }))).toBe('no_such_evaluation_run');
    expect(code(await req('POST', '/v1/ai/models', OWNER, { modelId: 'stand-in-small', adapterId: 'simulator', tier: 'small', dataResidency: 'india', evaluationRunId: stoppedEval.run.runId }))).toBe('evaluation_not_passed');
    expect(code(await req('POST', '/v1/ai/models', OWNER, { modelId: 'stand-in-small', adapterId: 'https://key@host', tier: 'small', dataResidency: 'india', evaluationRunId: run02.runId }))).toBe('not_readable_as_a_model_approval');
    expect((await req('POST', '/v1/ai/models', OWNER, { modelId: 'stand-in-small', adapterId: 'simulator', tier: 'small', dataResidency: 'india', evaluationRunId: run02.runId }, 'approve-1')).status).toBe(201);
    expect(code(await req('POST', '/v1/ai/models', OWNER, { modelId: 'stand-in-small', adapterId: 'simulator', tier: 'small', dataResidency: 'india', evaluationRunId: run02.runId }))).toBe('model_already_on_the_register');
    const a06Lift = ((await req('GET', '/v1/ai/kill-switches', OWNER)).body as { active: { switchId: string; agentId?: string }[] }).active.find((s) => s.agentId === 'A06')!;
    expect((await req('POST', `/v1/ai/kill-switches/${a06Lift.switchId}/lift`, OWNER2, { reason: 'evaluation done' })).status).toBe(200);

    // ── OB-296: free text for A01 is OFF until the owner switches it on — and it is not switched on in production.
    const freeText = await req('POST', '/v1/ai/agents/A01/model-calls', OWNER, { instruction: evalInstruction('a01-takings'), scope: { evaluationCase: 'a01-takings' }, callerText: 'and how is my brother-in-law\'s shop doing?' });
    expect(freeText.status).toBe(409);
    expect(code(freeText)).toBe('free_text_is_off');
    expect(code(await req('PUT', '/v1/ai/free-text', OWNER, { enabled: true }))).toBe('not_readable_as_a_free_text_setting');
    expect((await req('PUT', '/v1/ai/free-text', MGR, { enabled: true, reason: 'x' })).status).toBe(403);
    expect((await req('PUT', '/v1/ai/free-text', OWNER, { enabled: true, reason: 'tested against the stand-in only' }, 'ft-on')).status).toBe(200);
    const asked = await req('POST', '/v1/ai/agents/A01/model-calls', OWNER, { instruction: evalInstruction('a01-takings'), scope: { evaluationCase: 'a01-takings' }, callerText: 'Call me back on 9876543210 or mail owner@example.com' }, 'mc-a01-1');
    expect(asked.status, JSON.stringify(asked.body)).toBe(200);
    const askedBody = asked.body as { modelId: string; confidence: { band: string; basis: string; uncertainty: string }; minimisation: { piiRemoved: string[]; fenced: number } };
    expect(askedBody.modelId).toBe('stand-in-small');
    expect(askedBody.confidence).toMatchObject({ band: 'medium', basis: 'model_answer' });
    // AI-NFR-06: the phone number and the e-mail never reached the model; the caller's text was fenced as data.
    expect(askedBody.minimisation.piiRemoved).toEqual(['email', 'phone']);
    expect(askedBody.minimisation.fenced).toBe(1);
    expect((await req('PUT', '/v1/ai/free-text', OWNER, { enabled: false, reason: 'back off after the test' }, 'ft-off')).status).toBe(200);

    // ── AI-NFR-10: the owner's call-rate limit (2 an hour for A01) refuses the third call before it is made.
    expect((await req('POST', '/v1/ai/agents/A01/model-calls', OWNER, { instruction: evalInstruction('a01-forecast'), scope: { evaluationCase: 'a01-forecast' } }, 'mc-a01-2')).status).toBe(200);
    const limited = await req('POST', '/v1/ai/agents/A01/model-calls', OWNER, { instruction: evalInstruction('a01-takings'), scope: { evaluationCase: 'a01-takings' } }, 'mc-a01-3');
    expect(limited.status).toBe(429);
    expect(code(limited)).toBe('rate_limited');
    // An agent's own ceiling refuses before the call, too.
    expect((await req('PUT', '/v1/ai/agents/A06/budget', OWNER, { ceilingMinor: 1 })).status).toBe(200);
    const poor = await req('POST', '/v1/ai/agents/A06/model-calls', OWNER, { instruction: evalInstruction('a06-excess'), scope: { evaluationCase: 'a06-excess' } }, 'mc-a06-1');
    expect(poor.status).toBe(429);
    expect(code(poor)).toBe('agent_budget_exhausted');
    expect((await req('PUT', '/v1/ai/agents/A06/budget', OWNER, { ceilingMinor: 100_000 })).status).toBe(200);

    // ── A model reaching beyond its grant: dropped by the gateway, AND an AI incident for a person.
    const excess = await req('POST', '/v1/ai/agents/A06/model-calls', OWNER, { instruction: evalInstruction('a06-excess'), scope: { evaluationCase: 'a06-excess' } }, 'mc-a06-2');
    expect(excess.status).toBe(200);
    expect((excess.body as { proposals: unknown[] }).proposals).toEqual([]);
    const incidents1 = (await req('GET', '/v1/ai/incidents', OWNER)).body as { incidents: { incidentId: string; kind: string; agent: string; state: string; evidence: { tools?: string[] } }[] };
    const blocked = incidents1.incidents.find((i) => i.kind === 'tool_call_blocked')!;
    expect(blocked).toMatchObject({ agent: 'A06', state: 'open', evidence: { tools: ['purge_dead_letters', 'acknowledge_alert'] } });
    // Owned by a named person, closed with a reason — never before it is owned.
    expect((await req('POST', `/v1/ai/incidents/${blocked.incidentId}/owner`, CASH, { owner: OWNER2 })).status).toBe(403);
    expect(code(await req('POST', `/v1/ai/incidents/${blocked.incidentId}/close`, OWNER, { reason: 'nothing to do' }))).toBe('ai_incident_has_no_owner');
    expect((await req('POST', `/v1/ai/incidents/${blocked.incidentId}/owner`, OWNER, { owner: OWNER2 })).status).toBe(200);
    expect(code(await req('POST', `/v1/ai/incidents/${blocked.incidentId}/close`, OWNER2, {}))).toBe('close_needs_a_reason');
    expect((await req('POST', `/v1/ai/incidents/${blocked.incidentId}/close`, OWNER2, { reason: 'the evaluation case asks for it on purpose; the gateway held' })).status).toBe(200);
    // A person raises one.
    expect((await req('POST', '/v1/ai/incidents', CASH, { summary: 'it said the wrong price' })).status).toBe(403);
    const raised = await req('POST', '/v1/ai/incidents', OWNER, { summary: 'The service assistant promised a refund date', agent: 'A05' }, 'raise-1');
    expect(raised.status).toBe(201);

    // ── AI-NFR-04 + AIRecommendationApproved/Rejected: every proposal carries confidence; a person decides once.
    const a01 = (await req('POST', '/v1/ai/agents/A01/runs', OWNER, {}, 'run-a01')).body as { proposals: { proposalId: string; confidence: { band: string; uncertainty: string } }[] };
    expect(a01.proposals.length).toBeGreaterThan(0);
    for (const p of a01.proposals) {
      expect(['high', 'medium', 'low']).toContain(p.confidence.band);
      expect(p.confidence.uncertainty.length).toBeGreaterThan(10);
    }
    const target = a01.proposals[0]!.proposalId;
    expect((await req('POST', `/v1/ai/proposals/${target}/outcome`, CASH, { decision: 'approved' })).status).toBe(403);
    expect(code(await req('POST', `/v1/ai/proposals/${target}/outcome`, MGR, { decision: 'rejected' }))).toBe('not_readable_as_a_decision');
    expect(code(await req('POST', '/v1/ai/proposals/nope/outcome', MGR, { decision: 'approved' }))).toBe('no_such_proposal');
    const decided = await req('POST', `/v1/ai/proposals/${target}/outcome`, MGR, { decision: 'approved' }, 'decide-1');
    expect(decided.status).toBe(201);
    expect((decided.body as { outcome: { committedAnything: boolean; by: string } }).outcome).toMatchObject({ committedAnything: false, by: MGR });
    expect(code(await req('POST', `/v1/ai/proposals/${target}/outcome`, OWNER, { decision: 'rejected', reason: 'changed my mind' }))).toBe('already_decided');
    const register = (await req('GET', '/v1/ai/proposals', OWNER)).body as { proposals: { proposalId: string; outcome: { decision: string } | null; confidence: { band: string } }[]; committedAnything: boolean };
    expect(register.committedAnything).toBe(false);
    expect(register.proposals.find((p) => p.proposalId === target)!.outcome).toMatchObject({ decision: 'approved' });
    expect(register.proposals.every((p) => typeof p.confidence.band === 'string')).toBe(true);

    // ── Withdrawing the model refuses calls again.
    expect(code(await req('POST', '/v1/ai/models/stand-in-small/withdraw', OWNER, {}))).toBe('withdrawal_needs_a_reason');
    expect((await req('POST', '/v1/ai/models/stand-in-small/withdraw', OWNER, { reason: 'provider changed the model under us' }, 'withdraw-1')).status).toBe(200);
    expect(code(await req('POST', '/v1/ai/agents/A06/model-calls', OWNER, { instruction: evalInstruction('a06-runbook'), scope: { evaluationCase: 'a06-runbook' } }, 'mc-a06-3'))).toBe('model_not_approved');

    // ── COLD RESTART: a fresh API over the same store reads every register back.
    h = make(h.store);
    const control = (await req('GET', '/v1/ai/control', OWNER)).body as {
      killSwitch: { masterOn: boolean; active: unknown[]; history: { liftedBy?: string }[] };
      models: { modelId: string; state: string }[]; freeText: { enabled: boolean };
      evaluations: { runs: { agent: string }[] }; incidents: { list: { state: string; kind: string }[] };
      agents: { agentId: string; ceilingMinor: number | null; callsPerHour: number | null; lastEvaluation: { complete: boolean } | null }[];
      modelCalls: { chain: { ok: boolean }; recent: { piiRemoved: string[] }[] };
    };
    expect(control.killSwitch.masterOn).toBe(false);
    expect(control.killSwitch.active).toEqual([]);
    expect(control.killSwitch.history).toHaveLength(2);
    expect(control.killSwitch.history.every((s) => s.liftedBy === OWNER2)).toBe(true);
    expect(control.models).toEqual([expect.objectContaining({ modelId: 'stand-in-small', state: 'withdrawn' })]);
    expect(control.freeText.enabled).toBe(false);
    expect(control.evaluations.runs.map((r) => r.agent)).toEqual(['A02', 'A03', 'A02', 'A06']);
    expect(control.incidents.list.map((i) => [i.kind, i.state]).sort()).toEqual([['raised_by_person', 'open'], ['tool_call_blocked', 'closed']]);
    expect(control.agents.find((a) => a.agentId === 'A01')).toMatchObject({ ceilingMinor: 600_000, callsPerHour: 2 });
    expect(control.agents.find((a) => a.agentId === 'A02')!.lastEvaluation).toMatchObject({ complete: true });
    expect(control.modelCalls.chain.ok).toBe(true);
    expect(control.modelCalls.recent.some((c) => c.piiRemoved.includes('phone'))).toBe(true);
    const decidedAfter = (await req('GET', '/v1/ai/proposals', OWNER)).body as { proposals: { proposalId: string; outcome: { decision: string } | null }[] };
    expect(decidedAfter.proposals.find((p) => p.proposalId === target)!.outcome).toMatchObject({ decision: 'approved' });
  }, 180_000);
});
