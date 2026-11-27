import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore, InMemoryEventStore, type EventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { simulatedTransport, type ModelTier, type TierPricing } from '../../packages/ai/src/index';
import { EVALUATION_SIMULATOR } from '../../services/ai/src/evaluation-set';
import { agentsInTheSet } from '../../services/ai/src/evaluations';
import { qg11ReadingView, type Qg11ControlRead } from '../../apps/web-erp/src/gates-session';

/**
 * **QG-11 (roadmap §22 "Accuracy/safety evaluations, authority, evidence, human override, budgets and kill switch pass") — the
 * AI gate's reading, from head office's own AI control read, on the real API, in memory and on real PostgreSQL.**
 *
 * The Quality gates page reads GET /v1/ai/control (no new route: both people who read the gate register — the owner and the
 * store manager — may read it) and turns it into the QG-11 reading (apps/web-erp/src/gates-session.ts `qg11ReadingView`):
 *   • as the shop is today — no model connected (OB-296; live provider EX-12) — every agent in the evaluation set is listed,
 *     none run; an evaluation the owner runs is recorded NOT COMPLETE (it reached no model) and the gate HOLDS;
 *   • the kill switch and the budgets are said as head office holds them (a scoped switch names its agent; a shop budget);
 *   • with a stand-in model behind the governed call (synthetic — the shape a live provider will have at R8, OB-382), one agent
 *     complete and passing still HOLDS the gate, naming the others; every agent complete and passing is evidence for the
 *     owner's decision — the gate register still reads QG-11 "undecided": a reading is never GO;
 *   • a cashier may read neither; nothing here writes to the gate register.
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
  await runMigrations(pgPoolClient(pool), readdirSync('db/migrations').filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join('db/migrations', name), 'utf8') })));
});
afterAll(async () => { await pool?.end(); });

/** Two APIs over ONE store: the shop as it is (no model) and the same shop with a stand-in model behind the governed call. */
type Pair = { plain: ApiHarness; withModel: ApiHarness; fresh: () => ApiHarness };
const backings: { name: string; make: () => Pair }[] = [{
  name: 'the in-memory event store',
  make: () => { const store: EventStore = new InMemoryEventStore(); return { plain: apiHarness({ store }), withModel: apiHarness({ store, modelTransport: simulatedTransport(EVALUATION_SIMULATOR), modelPricing: PRICING }), fresh: () => apiHarness({ store, modelTransport: simulatedTransport(EVALUATION_SIMULATOR), modelPricing: PRICING }) }; },
}];
if (DATABASE_URL !== undefined) {
  backings.push({
    name: 'real PostgreSQL',
    make: () => {
      const sql = pgPoolClient(pool!); const store = new SqlEventStore(sql); const idempotency = new SqlIdempotencyStore(sql);
      return {
        plain: apiHarness({ store, idempotency }), withModel: apiHarness({ store, idempotency, modelTransport: simulatedTransport(EVALUATION_SIMULATOR), modelPricing: PRICING }),
        // A cold restart: a new connection's store, nothing carried in memory.
        fresh: () => { const s2 = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(s2), idempotency: new SqlIdempotencyStore(s2), modelTransport: simulatedTransport(EVALUATION_SIMULATOR), modelPricing: PRICING }); },
      };
    },
  });
}

describe.each(backings)('QG-11: the AI evaluations reading from head office — on $name', ({ make }) => {
  it('no model: every agent listed, an evaluation NOT COMPLETE, the gate HOLDS; with a model: one agent short holds by name, all passing is evidence — never GO', async () => {
    const { plain, withModel, fresh } = make();
    const T = randomUUID();
    await plain.seedOwner(T, OWNER);
    await plain.provisionOwner(T, OWNER2);
    await plain.provisionRole(T, MGR, 'store_manager');
    await plain.provisionRole(T, CASH, 'cashier');
    const req = (h: ApiHarness, method: 'GET' | 'POST' | 'PUT', path: string, userId: string, body?: unknown, query?: Record<string, string>) =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'GET' ? {} : { idempotencyKey: `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });
    const reading = async (h: ApiHarness, who = MGR) => {
      const r = await req(h, 'GET', '/v1/ai/control', who);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return qg11ReadingView('en', { result: 'ok', value: r.body as Qg11ControlRead });
    };
    const qg11Gate = async () => ((await req(plain, 'GET', '/v1/compliance/gate-register', MGR, undefined, { release: 'R8' })).body as { gates: { gate: string; state: string }[] }).gates.find((g) => g.gate === 'QG-11')!;
    const SET = agentsInTheSet();
    expect(SET.length).toBeGreaterThan(0);

    // ── As the shop is today: no model connected. Every agent in the set listed, none run; the gate HOLDS.
    let v = await reading(plain);
    expect(v.state).toBe('no_live_model');
    expect(v.headline).toMatch(/^HOLD — no live model is connected \(OB-296; live provider EX-12\)/);
    expect(v.agents.map((a) => a.agentId)).toEqual(SET);
    expect(v.agents.every((a) => a.state === 'not_run')).toBe(true);
    expect(v.lines).toContain('Model: none connected — the assistants work on tested rules only.');
    expect(v.lines).toContain('Kill switch: the shop-wide AI switch is ON — every assistant is stopped.'); // OB-296: the shop starts stopped
    expect(v.lines).toContain('Shop AI budget: not set — no call that costs anything can be made.');
    // The owner reads the same; a cashier reads neither the AI records nor the register.
    expect((await reading(plain, OWNER)).state).toBe('no_live_model');
    expect((await req(plain, 'GET', '/v1/ai/control', CASH)).status).toBe(403);
    expect((await req(plain, 'GET', '/v1/compliance/gate-register', CASH, undefined, { release: 'R8' })).status).toBe(403);

    // ── The owner runs the first agent's evaluation with no model: recorded, NOT COMPLETE — it proves nothing.
    const first = SET[0]!;
    const noModel = await req(plain, 'POST', `/v1/ai/evaluations/${first}`, OWNER);
    expect(noModel.status, JSON.stringify(noModel.body)).toBe(201);
    expect((noModel.body as { run: { complete: boolean } }).run.complete).toBe(false);
    v = await reading(plain);
    expect(v.agents.find((a) => a.agentId === first)).toMatchObject({ icon: '⚠', state: 'not_complete' });
    expect(v.agents.find((a) => a.agentId === first)!.words).toMatch(new RegExp(`^${first} · .+ — NOT COMPLETE: it did not reach a model, so it proves nothing · run evr-${first}-`));
    expect(v.state).toBe('no_live_model');

    // ── The owner sets the budgets and lifts the shop-wide switch; a second owner stops one agent with a scoped switch.
    expect((await req(plain, 'PUT', '/v1/ai/budget', OWNER, { capMinor: 1_000_000, periodEnds: '2099-01-01T00:00:00.000Z' })).status).toBe(200);
    expect((await req(plain, 'PUT', `/v1/ai/agents/${first}/budget`, OWNER, { ceilingMinor: 400_000 })).status).toBe(200);
    expect((await req(plain, 'PUT', '/v1/ai/kill-switch', OWNER, { on: false, reason: 'evaluating the assistants' })).status).toBe(200);
    expect((await req(plain, 'PUT', '/v1/ai/agents/enabled', OWNER, { expected: [], agents: SET })).status).toBe(200);
    expect((await req(plain, 'POST', '/v1/ai/kill-switches', OWNER2, { scope: 'single_agent', agentId: 'A06', reason: 'held back while its cases are checked' })).status).toBe(201);
    v = await reading(plain);
    expect(v.lines).toContain('Kill switch: 1 switch is stopping an assistant (A06).');
    expect(v.lines).toContain('Shop AI budget: ₹10,000.00 a month, ₹0.00 spent (platform ceiling ₹15,000.00).');
    expect(v.lines).toContain(`Agents with a budget of their own: ${first}.`);
    const a06 = ((await req(plain, 'GET', '/v1/ai/kill-switches', OWNER)).body as { active: { switchId: string }[] }).active[0]!;
    expect((await req(plain, 'POST', `/v1/ai/kill-switches/${a06.switchId}/lift`, OWNER, { reason: 'checked' })).status).toBe(200);
    expect((await reading(plain)).lines).toContain('Kill switch: off — no assistant is stopped by it.');

    // ── A stand-in model behind the governed call (synthetic; the shape a live provider takes at R8). One agent complete and
    //    passing: the gate still HOLDS, naming the agents that are not.
    const one = await req(withModel, 'POST', `/v1/ai/evaluations/${first}`, OWNER);
    expect((one.body as { run: { complete: boolean; fitToFacePeople: boolean } }).run).toMatchObject({ complete: true, fitToFacePeople: true });
    v = await reading(withModel);
    expect(v.state).toBe('holds');
    expect(v.headline).toBe(`HOLD — ${SET.length - 1} of ${SET.length} agents have no complete, passing evaluation.`);
    expect(v.agents.find((a) => a.agentId === first)).toMatchObject({ icon: '✓', state: 'passed' });
    expect(v.lines).toContain('Model: a model provider is connected behind the governed call.');

    // ── Every agent complete and passing: evidence for the owner's decision — and QG-11 is still undecided at head office.
    for (const a of SET.slice(1)) {
      const r = await req(withModel, 'POST', `/v1/ai/evaluations/${a}`, OWNER);
      expect(r.status, JSON.stringify(r.body)).toBe(201);
    }
    v = await reading(withModel);
    expect(v.state, v.agents.map((a) => a.words).join('\n')).toBe('evaluations_clean');
    expect(v.lines.at(-1)).toBe('This is evidence for the owner\'s QG-11 decision, not the decision — the gate is not passed until he records it with his signed review.');
    expect((await qg11Gate()).state).toBe('undecided');
    expect((await req(plain, 'GET', '/v1/compliance/gate-decisions/QG-11/R8', OWNER)).body).toMatchObject({ count: 0 });

    // ── A cold restart (a fresh API over the same store) reads the same.
    const after = await reading(fresh());
    expect(after.state).toBe('evaluations_clean');
    expect(after.agents.map((a) => [a.agentId, a.state])).toEqual(SET.map((a) => [a, 'passed']));
  }, 120_000);
});
