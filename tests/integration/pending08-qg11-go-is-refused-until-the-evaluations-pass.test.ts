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

/**
 * **QG-11 — head office REFUSES a GO while any assistant in the evaluation set lacks a complete, passing latest evaluation
 * against a live model (owner, 27 Nov 2026, in writing: "QG-11 A" — OB-935).**
 *
 *   • as the shop is today (no model connected — OB-296, EX-12) GO on QG-11 is refused 422 for every release, naming each
 *     assistant; HOLD (and REWORK) are recorded;
 *   • an evaluation run with no model is NOT COMPLETE and still blocks, by name;
 *   • with a stand-in model behind the governed call (synthetic — the shape a live provider takes at R8, OB-382) the blocker
 *     clears assistant by assistant; only when EVERY assistant's latest run is complete and passing is GO accepted;
 *   • the risk register's can-pass reads the same blockers; a cold restart reads the same.
 * In memory and on real PostgreSQL.
 */

const OWNER = 'u-owner'; const MGR = 'u-mgr';
const PRICING: Readonly<Record<ModelTier, TierPricing>> = {
  small: { inputPerMillionMinor: 1_000_000, outputPerMillionMinor: 2_000_000 },
  standard: { inputPerMillionMinor: 3_000_000, outputPerMillionMinor: 6_000_000 },
  complex: { inputPerMillionMinor: 9_000_000, outputPerMillionMinor: 18_000_000 },
};
const EVIDENCE = [{ label: 'the AI evaluations reading', ref: 'Quality gates page, QG-11 row' }];

const DATABASE_URL = process.env['DATABASE_URL'];
let pool: Pool | undefined;
beforeAll(async () => {
  if (DATABASE_URL === undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
  await runMigrations(pgPoolClient(pool), readdirSync('db/migrations').filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join('db/migrations', name), 'utf8') })));
});
afterAll(async () => { await pool?.end(); });

type Pair = { plain: ApiHarness; withModel: ApiHarness; fresh: () => ApiHarness };
const backings: { name: string; make: () => Pair }[] = [{
  name: 'the in-memory event store',
  make: () => { const store: EventStore = new InMemoryEventStore(); return { plain: apiHarness({ store }), withModel: apiHarness({ store, modelTransport: simulatedTransport(EVALUATION_SIMULATOR), modelPricing: PRICING }), fresh: () => apiHarness({ store }) }; },
}];
if (DATABASE_URL !== undefined) {
  backings.push({
    name: 'real PostgreSQL',
    make: () => {
      const sql = pgPoolClient(pool!); const store = new SqlEventStore(sql); const idempotency = new SqlIdempotencyStore(sql);
      return {
        plain: apiHarness({ store, idempotency }), withModel: apiHarness({ store, idempotency, modelTransport: simulatedTransport(EVALUATION_SIMULATOR), modelPricing: PRICING }),
        fresh: () => { const s2 = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(s2), idempotency: new SqlIdempotencyStore(s2) }); },
      };
    },
  });
}

type Body = { error?: { code?: string; whatHappened?: string } };
type Blocker = { gate: string; ref: string; reason: string };

describe.each(backings)('QG-11: GO is refused until every assistant\'s evaluation passes — on $name', ({ make }) => {
  it('refuses GO naming each assistant (HOLD recorded), clears assistant by assistant, accepts GO only when all pass', async () => {
    const { plain, withModel, fresh } = make();
    const T = randomUUID();
    await plain.seedOwner(T, OWNER);
    await plain.provisionRole(T, MGR, 'store_manager');
    const req = (h: ApiHarness, method: 'GET' | 'POST' | 'PUT', path: string, userId: string, body?: unknown, query?: Record<string, string>) =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'GET' ? {} : { idempotencyKey: `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });
    const decide = (h: ApiHarness, release: string, decision: string) =>
      req(h, 'POST', `/v1/compliance/gate-decisions/QG-11/${release}`, OWNER, { decision, evidence: EVIDENCE, rationale: 'read the QG-11 row' });
    const qg11Blockers = async (h: ApiHarness): Promise<Blocker[]> =>
      ((await req(h, 'GET', '/v1/compliance/gate-register', OWNER, undefined, { release: 'R8' })).body as { gates: { gate: string; blockers: Blocker[] }[] })
        .gates.find((g) => g.gate === 'QG-11')!.blockers;
    const SET = agentsInTheSet();
    expect(SET.length).toBeGreaterThan(1);

    // ── As the shop is today: no model connected. GO refused for any release, naming every assistant in plain words.
    for (const release of ['R8', 'R1']) {
      const go = await decide(plain, release, 'GO');
      expect(go.status, JSON.stringify(go.body)).toBe(422);
      const said = (go.body as Body).error!;
      expect(said.code).toBe('go_refused_while_blocked');
      for (const a of SET) expect(said.whatHappened).toMatch(new RegExp(`${a} · [^;]+ has no evaluation on record — it needs a complete, passing evaluation against a live model`));
      expect(said.whatHappened).toContain('(no model is connected yet — EX-12, OB-296; live models are due at R8, OB-382)');
    }
    expect((await qg11Blockers(plain)).map((b) => b.ref).sort()).toEqual(SET.map((a) => `ai-evaluation:${a}:not_run`).sort());
    // The risk register's can-pass reads the same blockers.
    const can = (await req(plain, 'GET', '/v1/compliance/gates/QG-11/can-pass', OWNER)).body as { canPass: boolean; alsoBlockedBy: Blocker[] };
    expect(can.canPass).toBe(false);
    expect(can.alsoBlockedBy.length).toBe(SET.length);

    // HOLD and REWORK stay allowed.
    expect((await decide(plain, 'R8', 'HOLD')).status).toBe(201);
    expect((await decide(plain, 'R1', 'REWORK')).status).toBe(201);

    // ── An evaluation run with no model is NOT COMPLETE: still blocking, by name.
    const first = SET[0]!;
    expect((await req(plain, 'POST', `/v1/ai/evaluations/${first}`, OWNER)).status).toBe(201);
    const afterNoModel = await qg11Blockers(plain);
    expect(afterNoModel.find((b) => b.ref.startsWith(`ai-evaluation:${first}:`))!.reason).toMatch(new RegExp(`^${first} · .+'s latest evaluation \\(run evr-${first}-[^)]+\\) is NOT COMPLETE — it never reached a model, so it proves nothing`));
    expect((await decide(plain, 'R8', 'GO')).status).toBe(422);

    // ── A stand-in model behind the governed call: one assistant complete and passing clears ITS blocker only.
    expect((await req(plain, 'PUT', '/v1/ai/budget', OWNER, { capMinor: 1_000_000, periodEnds: '2099-01-01T00:00:00.000Z' })).status).toBe(200);
    expect((await req(plain, 'PUT', '/v1/ai/kill-switch', OWNER, { on: false, reason: 'evaluating the assistants' })).status).toBe(200);
    expect((await req(plain, 'PUT', '/v1/ai/agents/enabled', OWNER, { expected: [], agents: SET })).status).toBe(200);
    const one = await req(withModel, 'POST', `/v1/ai/evaluations/${first}`, OWNER);
    expect((one.body as { run: { complete: boolean; fitToFacePeople: boolean } }).run).toMatchObject({ complete: true, fitToFacePeople: true });
    const afterOne = await qg11Blockers(withModel);
    expect(afterOne.map((b) => b.ref).sort()).toEqual(SET.slice(1).map((a) => `ai-evaluation:${a}:not_run`).sort());
    const stillRefused = await decide(withModel, 'R8', 'GO');
    expect(stillRefused.status).toBe(422);
    expect((stillRefused.body as Body).error!.whatHappened).not.toMatch(new RegExp(`${first} · `));

    // ── Every assistant complete and passing: no QG-11 blocker; GO is accepted.
    for (const a of SET.slice(1)) expect((await req(withModel, 'POST', `/v1/ai/evaluations/${a}`, OWNER)).status).toBe(201);
    expect(await qg11Blockers(withModel)).toEqual([]);
    expect(((await req(withModel, 'GET', '/v1/compliance/gates/QG-11/can-pass', OWNER)).body as { canPass: boolean }).canPass).toBe(true);
    // A cold restart (no model behind it) reads the same records: nothing blocks.
    const restarted = fresh();
    expect(await qg11Blockers(restarted)).toEqual([]);
    const go = await decide(restarted, 'R8', 'GO');
    expect(go.status, JSON.stringify(go.body)).toBe(201);
    const history = (await req(restarted, 'GET', '/v1/compliance/gate-decisions/QG-11/R8', OWNER)).body as { history: { decision: string }[] };
    expect(history.history.map((d) => d.decision)).toEqual(['HOLD', 'GO']); // nothing overwritten
  }, 120_000);
});
