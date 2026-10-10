import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { SqlIdempotencyStore, MemoryIdempotencyStore } from '../../services/kernel/src/index';
import { simulatedTransport, runEvalSuite, type ModelTransport, type ModelTier, type TierPricing, type ModelResponse } from '../../packages/ai/src/index';
import { auditChainHolds, type ModelCallAudit } from '../../services/ai/src/model-gateway';
import { EVALUATION_SET, EVALUATION_EVIDENCE, EVALUATION_SIMULATOR, EVALUATION_SET_VERSION } from '../../services/ai/src/evaluation-set';

/**
 * **A model call is governed on the server before any provider is enabled (audit EA-08 · AI-NFR-01/08/10 · hard rule #5).**
 *
 * Through the real API with the deterministic simulator standing in for a provider (no provider is chosen — an external
 * gate): no pricing → nothing admitted; the cost is ADMITTED before the call on the server's own estimate and the call
 * that would overspend is refused WITHOUT the transport being touched; the actual cost is METERED from the tokens and
 * settles the reservation into the same budget the AI budget screen reads; the kill switch stops calls before the
 * transport; a model steered by hostile evidence proposes a refund and the gateway drops it; every call — refused or
 * not — is on an append-only, hash-chained REQUEST/RESULT AUDIT that detects tampering, across a restart and on
 * PostgreSQL. And the FIXED evaluation set runs through the same governed call, every case at its expected verdict, no
 * unsafe case.
 */

const OWNER = 'u-owner';
// ₹0.01 per input token and ₹0.02 per output token on the small tier — synthetic pricing, from configuration in tests.
const PRICING: Readonly<Record<ModelTier, TierPricing>> = {
  small: { inputPerMillionMinor: 1_000_000, outputPerMillionMinor: 2_000_000 },
  standard: { inputPerMillionMinor: 3_000_000, outputPerMillionMinor: 6_000_000 },
  complex: { inputPerMillionMinor: 9_000_000, outputPerMillionMinor: 18_000_000 },
};

function countingTransport(): ModelTransport & { calls: number } {
  const inner = simulatedTransport(EVALUATION_SIMULATOR);
  const t = ((req) => { t.calls += 1; return inner(req); }) as ModelTransport & { calls: number };
  t.calls = 0;
  return t;
}

const call = (h: ApiHarness, T: string, agent: string, caseId: string, key: string) => h.request({
  method: 'POST', path: `/v1/ai/agents/${agent}/model-calls`, userId: OWNER, tenantId: T, idempotencyKey: key,
  body: { instruction: EVALUATION_SET.find((c) => c.caseId === caseId)!.instruction, evidence: EVALUATION_EVIDENCE[caseId] },
});
const put = (h: ApiHarness, T: string, path: string, body: unknown, key: string) => h.request({ method: 'PUT', path, userId: OWNER, tenantId: T, idempotencyKey: key, body });
const code = (r: { body: unknown }) => (r.body as { error?: { code?: string } }).error?.code;
const auditsOf = async (h: ApiHarness, T: string) => (await h.request({ method: 'GET', path: '/v1/ai/model-calls', userId: OWNER, tenantId: T })).body as { audits: ModelCallAudit[]; chain: { ok: boolean } };

async function journey(make: (opts: { transport?: ModelTransport; pricing?: typeof PRICING }) => ApiHarness, T: string): Promise<void> {
  const transport = countingTransport();
  // ── No pricing configured: nothing can be admitted — refused, audited, transport untouched.
  const bare = make({ transport });
  await bare.seedOwner(T, OWNER);
  await put(bare, T, '/v1/ai/agents/enabled', { agents: ['A01', 'A04'] }, 'en');
  await put(bare, T, '/v1/ai/budget', { capMinor: 2_450, periodEnds: '2026-10-31T23:59:59.000Z' }, 'bud');
  await put(bare, T, '/v1/ai/kill-switch', { on: false, reason: 'the owner switched AI on for the trial' }, 'unkill'); // AI starts OFF
  const unpriced = await call(bare, T, 'A01', 'a01-takings', 'c0');
  expect(code(unpriced)).toBe('no_pricing');
  expect(transport.calls).toBe(0);

  const h = make({ transport, pricing: PRICING });
  // ── Admitted: the estimate (≈ prompt + 1,200 output tokens) fits the ₹24.50 cap; actual cost metered from tokens.
  const first = await call(h, T, 'A01', 'a01-takings', 'c1');
  expect(first.status, JSON.stringify(first.body)).toBe(200);
  const b1 = first.body as { outcome: string; text: string; costMinor: number; committedAnything: boolean };
  expect(b1).toMatchObject({ outcome: 'answered', committedAnything: false });
  expect(b1.text).toContain('₹1,200');
  expect(transport.calls).toBe(1);
  expect(b1.costMinor).toBeGreaterThan(0);
  const budget = (await h.request({ method: 'GET', path: '/v1/ai/budget', userId: OWNER, tenantId: T })).body as { spentMinor: number };
  expect(budget.spentMinor).toBe(b1.costMinor); // the reservation settled at the ACTUAL cost, in the same budget

  // ── The next call's estimate no longer fits what is left: refused BEFORE the transport, nothing spent.
  const over = await call(h, T, 'A01', 'a01-forecast', 'c2');
  expect(over.status).toBe(429);
  expect(code(over)).toBe('budget_exhausted');
  expect(transport.calls).toBe(1);
  expect(((await h.request({ method: 'GET', path: '/v1/ai/budget', userId: OWNER, tenantId: T })).body as { spentMinor: number }).spentMinor).toBe(b1.costMinor);

  // ── More budget; a model steered by hostile evidence proposes a refund — the gateway drops it; nothing commits.
  await put(h, T, '/v1/ai/budget', { capMinor: 100_000, periodEnds: '2026-10-31T23:59:59.000Z' }, 'bud2');
  const steered = await call(h, T, 'A01', 'a01-injection', 'c3');
  expect(steered.status).toBe(200);
  expect((steered.body as { proposals: unknown[] }).proposals).toEqual([]);
  // The customer-facing agent's allowed proposal survives (suggest_alternatives is in A04's grant).
  const a04 = await call(h, T, 'A04', 'a04-alternatives', 'c4');
  expect((a04.body as { proposals: { tool: string }[] }).proposals.map((p) => p.tool)).toEqual(['suggest_alternatives']);

  // ── Kill switch: refused before the transport.
  const callsBefore = transport.calls;
  await put(h, T, '/v1/ai/kill-switch', { on: true, reason: 'evaluation of the kill switch' }, 'kill');
  const killed = await call(h, T, 'A01', 'a01-takings', 'c5');
  expect([503, 429]).toContain(killed.status);
  expect(code(killed)).toBe('killed');
  expect(transport.calls).toBe(callsBefore);

  // ── The immutable request/result audit: every call, refused or not, hash-chained; tampering is detected.
  const { audits, chain } = await auditsOf(h, T);
  expect(audits.map((a) => [a.callId.split('-').at(-1), a.admission.outcome, a.calledAModel])).toEqual([
    ['c0', 'no_pricing', false], ['c1', 'allowed', true], ['c2', 'budget_exhausted', false], ['c3', 'allowed', true], ['c4', 'allowed', true], ['c5', 'killed', false],
  ]);
  expect(chain.ok).toBe(true);
  expect(audits[3]!.result.detail).toMatch(/DROPPED/); // the refund proposal was dropped, and the record says so
  expect(audits[1]!.request.evidenceIds).toEqual(['ev-sales-day']);
  const tampered = audits.map((a, i) => (i === 1 ? { ...a, actualCostMinor: 0 } : a));
  expect(auditChainHolds(tampered)).toEqual({ ok: false, brokenAt: audits[1]!.callId });

  // ── RESTART: the audit and the budget read the same from the store.
  const again = make({ transport, pricing: PRICING });
  const after = await auditsOf(again, T);
  expect(after.audits).toHaveLength(6);
  expect(after.chain.ok).toBe(true);
}

describe('a model call is governed on the server (EA-08)', () => {
  it('admission before the call, metering, the kill switch, the dropped refund, the hash-chained audit — in memory, across a restart', async () => {
    const T = 'ab000000-0000-4000-8000-0000000ea008';
    let store: ApiHarness['store'] | undefined;
    await journey(({ transport, pricing }) => {
      const h = apiHarness({ ...(store === undefined ? {} : { store }), idempotency: new MemoryIdempotencyStore(), ...(transport === undefined ? {} : { modelTransport: transport }), ...(pricing === undefined ? {} : { modelPricing: pricing }) });
      store = h.store;
      return h;
    }, T);
  });

  it(`the fixed evaluation set (v${EVALUATION_SET_VERSION}) runs through the governed call: every case at its verdict, nothing unsafe`, async () => {
    const T = 'ab000000-0000-4000-8000-0000000ea018';
    const h = apiHarness({ modelTransport: simulatedTransport(EVALUATION_SIMULATOR), modelPricing: PRICING });
    await h.seedOwner(T, OWNER);
    await put(h, T, '/v1/ai/agents/enabled', { agents: ['A01', 'A04'] }, 'en');
    await put(h, T, '/v1/ai/budget', { capMinor: 1_000_000, periodEnds: '2026-10-31T23:59:59.000Z' }, 'bud');
  await put(h, T, '/v1/ai/kill-switch', { on: false, reason: 'evaluation run' }, 'unkill');
    const responses: Record<string, ModelResponse> = {};
    for (const c of EVALUATION_SET) {
      const r = await call(h, T, c.agentId, c.caseId, `eval-${c.caseId}`);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const b = r.body as { outcome: string; text: string | null; proposals: ModelResponse['proposals']; citedEvidenceIds: string[] };
      responses[c.caseId] = { requestId: c.caseId, outcome: b.outcome as ModelResponse['outcome'], ...(b.text === null ? {} : { text: b.text }), proposals: b.proposals, citedEvidenceIds: b.citedEvidenceIds, inputTokens: 0, outputTokens: 0, tier: 'small', elapsedMs: 0, detail: '' };
    }
    for (const agentId of ['A01', 'A04'] as const) {
      const suite = runEvalSuite({ agentId, cases: EVALUATION_SET, responses });
      expect(suite.unsafe, suite.detail).toBe(0);
      expect(suite.results.every((r) => r.verdict === 'pass'), JSON.stringify(suite.results)).toBe(true);
      expect(suite.fitToFacePeople).toBe(true);
    }
    // Every evaluation call is itself on the audit.
    expect((await auditsOf(h, T)).audits).toHaveLength(EVALUATION_SET.length);
  });
});

const DATABASE_URL = process.env['DATABASE_URL'];
describe.skipIf(!DATABASE_URL)('a model call is governed on the server — real PostgreSQL (EA-08)', () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 4, options: '-c app.tenant_id=*' });
    const dir = 'db/migrations';
    await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
      .map((name) => ({ name, sql: readFileSync(`${dir}/${name}`, 'utf8') })));
  });
  afterAll(async () => { await pool.end(); });

  it('the same journey on PostgreSQL', async () => {
    const sql = pgPoolClient(pool);
    await journey(({ transport, pricing }) => apiHarness({
      store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql),
      ...(transport === undefined ? {} : { modelTransport: transport }), ...(pricing === undefined ? {} : { modelPricing: pricing }),
    }), randomUUID());
  });
});
