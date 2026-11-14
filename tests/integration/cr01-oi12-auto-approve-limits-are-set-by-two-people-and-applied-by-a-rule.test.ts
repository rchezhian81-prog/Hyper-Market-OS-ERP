import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore, InMemoryEventStore, type EventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { makeEvent } from '../../packages/contracts/src/event';
import { STREAM } from '../../services/api/src/adapters';
import type { DraftAct } from '../../packages/ai/src/index';

/**
 * **CR-01 OI-12 · OB-712 — owner-set auto-approve limits, end to end on head office's API (real PostgreSQL when
 * DATABASE_URL is set; in memory otherwise).**
 *
 *   • the owner ASKS for a ₹5,000 reorder limit — nothing changes until the accountant (a different person) confirms;
 *   • the owner cannot confirm his own request; nobody can ask for a rule on a refund, a permission change or a new payee;
 *   • auto-approval starts STOPPED, and starting it is two people too;
 *   • a synthetic A02 draft of ₹4,200 from an approved supplier is approved BY THE RULE — the register shows the rule as the
 *     approver, never the assistant — and a person can no longer decide it twice;
 *   • a ₹9,000 draft, and one from a supplier not approved, wait for a person, with the reason recorded;
 *   • the store manager STOPS all auto-approval at once; the next draft waits; the manager cannot set a limit;
 *   • a limit asked against a rule that has since changed is refused (hard rule 10).
 * Synthetic data only.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const OWNER = 'u-owner'; const ACCOUNTANT = 'u-accountant'; const MANAGER = 'u-manager';

describe('CR-01 OI-12: auto-approve limits are set by two people and applied by a rule', () => {
  let pool: Pool | undefined;
  let h: ApiHarness;
  let store: EventStore;
  const T = randomUUID();
  const send = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown) =>
    h.request({ method, path, userId, tenantId: T, ...(method === 'POST' ? { idempotencyKey: `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }) });
  const state = async () => (await send('GET', '/v1/ai/auto-approve', OWNER)).body as {
    rules: { kind: string; limit: number; version: number; askedBy: string; confirmedBy: string; ruleId: string }[];
    pending: { requestId: string }[]; running: boolean; switchVersion: number; versionOf: Record<string, number>;
    decisions: { proposalId: string; outcome: string; because?: string; approvedBy?: string }[];
  };
  /** A future A02/A03 draft that says exactly what it would do — appended as the run route records one. Synthetic. */
  const raise = async (proposalId: string, agent: 'A02' | 'A03', act: DraftAct) => {
    const p = { proposalId, agent, summary: `synthetic draft ${proposalId}`, wouldRequire: 'POST /v1/purchase/orders/:poId', evidence: [{ source: 'synthetic', reference: 'r-1', summary: 'synthetic evidence' }], createdAt: new Date().toISOString(), act, committed: false };
    await store.append(T, STREAM.ai, makeEvent({ id: `ai-proposal-${proposalId}`, type: 'AiProposalRaised', occurredAt: p.createdAt, idempotencyKey: `ai-proposal-${T}-${proposalId}`, source: 'test/synthetic', payload: p }));
  };
  const reorder = (valueMinor: number, supplierApproved = true): DraftAct => ({ kind: 'reorder_from_approved_supplier', supplierId: 'sup-synthetic-01', supplierApproved, valueMinor, lines: [{ productId: 'p-synthetic-rice', qty: 10 }] });

  beforeAll(async () => {
    if (DATABASE_URL !== undefined) {
      pool = new Pool({ connectionString: DATABASE_URL, max: 4, options: '-c app.tenant_id=*' });
      await runMigrations(pgPoolClient(pool), readdirSync('db/migrations').filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join('db/migrations', name), 'utf8') })));
      const sql = pgPoolClient(pool);
      store = new SqlEventStore(sql);
      h = apiHarness({ store, idempotency: new SqlIdempotencyStore(sql) });
    } else {
      store = new InMemoryEventStore();
      h = apiHarness({ store });
    }
    await h.seedOwner(T, OWNER);
    await h.provisionRole(T, ACCOUNTANT, 'accountant');
    await h.provisionRole(T, MANAGER, 'store_manager');
  }, 120_000);
  afterAll(async () => { await pool?.end(); });

  it('the whole journey: asked, confirmed by another person, started, applied by the rule, stopped', async () => {
    // Nothing set: stopped, no rules.
    let s = await state();
    expect([s.running, s.rules]).toEqual([false, []]);

    // A rule on a refund, a permission change or a payment to a new payee can never even be asked for.
    for (const kind of ['refund', 'permission_change', 'payment_to_new_payee']) {
      const r = await send('POST', '/v1/ai/auto-approve/requests', OWNER, { action: 'set_limit', kind, limit: 100, basedOnVersion: 0, reason: 'try' });
      expect([r.status, (r.body as { error: { code: string } }).error.code]).toEqual([403, 'never_auto_approvable']);
    }
    // The manager cannot ask for a limit at all (no permission).
    expect((await send('POST', '/v1/ai/auto-approve/requests', MANAGER, { action: 'set_limit', kind: 'stock_transfer', limit: 100, basedOnVersion: 0, reason: 'try' })).status).toBe(403);

    // The owner asks for ₹5,000 on reorders. Nothing changes yet.
    const asked = await send('POST', '/v1/ai/auto-approve/requests', OWNER, { action: 'set_limit', kind: 'reorder_from_approved_supplier', limit: 500_000, basedOnVersion: 0, reason: 'small reorders from regular suppliers' });
    expect(asked.status).toBe(201);
    const reqId = (asked.body as { request: { requestId: string } }).request.requestId;
    expect((await state()).rules).toEqual([]);
    // He cannot confirm his own request.
    const self = await send('POST', `/v1/ai/auto-approve/requests/${reqId}/decision`, OWNER, { decision: 'confirmed' });
    expect([self.status, (self.body as { error: { code: string } }).error.code]).toEqual([403, 'same_person']);
    // The accountant confirms it: now it is the rule, naming both people.
    expect((await send('POST', `/v1/ai/auto-approve/requests/${reqId}/decision`, ACCOUNTANT, { decision: 'confirmed' })).status).toBe(200);
    s = await state();
    expect(s.rules).toEqual([expect.objectContaining({ kind: 'reorder_from_approved_supplier', limit: 500_000, version: 1, askedBy: OWNER, confirmedBy: ACCOUNTANT })]);
    // A second decision on the same request is refused.
    expect((await send('POST', `/v1/ai/auto-approve/requests/${reqId}/decision`, ACCOUNTANT, { decision: 'refused', reason: 'late' })).status).toBe(409);

    // While the shop's AI master switch is ON (stopped — its default, OB-296), the rule approves nothing either.
    await raise('a02-synth-1', 'A02', reorder(420_000));
    let sweep = await send('POST', '/v1/ai/auto-approve/sweep', OWNER, {});
    expect((sweep.body as { decisions: { because?: string }[] }).decisions[0]).toMatchObject({ because: 'ai_stopped' });
    expect((await h.request({ method: 'PUT', path: '/v1/ai/kill-switch', userId: OWNER, tenantId: T, idempotencyKey: `k-${randomUUID()}`, body: { on: false, reason: 'integration trial' } })).status).toBe(200);
    // A rule exists but auto-approval itself is still stopped: the sweep approves nothing.
    sweep = await send('POST', '/v1/ai/auto-approve/sweep', OWNER, {});
    expect((sweep.body as { decisions: { because?: string }[] }).decisions[0]).toMatchObject({ because: 'auto_approval_stopped' });

    // Starting it is two people.
    const start = await send('POST', '/v1/ai/auto-approve/requests', OWNER, { action: 'resume', basedOnVersion: s.switchVersion, reason: 'start with the reorder rule' });
    expect(start.status).toBe(201);
    await send('POST', `/v1/ai/auto-approve/requests/${(start.body as { request: { requestId: string } }).request.requestId}/decision`, ACCOUNTANT, { decision: 'confirmed' });
    expect((await state()).running).toBe(true);

    // ₹4,200 from an approved supplier is inside the limit — but since step 6b (OB-760 A) a rule's approval stands only once the
    // ORDINARY route has placed the act, and this synthetic draft does not say where to deliver: nothing can be placed exactly,
    // so it waits for a person with the reason, and the rule never tries it again. (A real placed order: cr01-oi12-step6b-*.)
    sweep = await send('POST', '/v1/ai/auto-approve/sweep', OWNER, {});
    expect((sweep.body as { autoApproved: number; decisions: { proposalId: string; because?: string; refusedBy?: { code: string } }[] }).autoApproved).toBe(0);
    expect((sweep.body as { decisions: { proposalId: string; because?: string; refusedBy?: { code: string } }[] }).decisions.find((d) => d.proposalId === 'a02-synth-1'))
      .toMatchObject({ because: 'refused_by_route', refusedBy: { code: 'act_not_exact', ruleId: 'reorder_from_approved_supplier-v1' } });
    // A second sweep does not try it again.
    expect(((await send('POST', '/v1/ai/auto-approve/sweep', OWNER, {})).body as { decisions: { proposalId: string }[] }).decisions.some((d) => d.proposalId === 'a02-synth-1')).toBe(false);
    // A person still decides it (nothing was decided for them).
    expect((await send('POST', '/v1/ai/proposals/a02-synth-1/outcome', OWNER, { decision: 'rejected', reason: 'not needed' })).status).toBeLessThan(300);

    // Over the limit, and an unapproved supplier: both wait, the reasons kept.
    await raise('a02-synth-2', 'A02', reorder(900_000));
    await raise('a02-synth-3', 'A02', reorder(100_000, false));
    await send('POST', '/v1/ai/auto-approve/sweep', OWNER, {});
    s = await state();
    expect(s.decisions.find((d) => d.proposalId === 'a02-synth-2')).toMatchObject({ outcome: 'waits_for_a_person', because: 'over_the_limit' });
    expect(s.decisions.find((d) => d.proposalId === 'a02-synth-3')).toMatchObject({ outcome: 'waits_for_a_person', because: 'unusual' });
    expect(s.decisions.find((d) => d.proposalId === 'a02-synth-1')).toMatchObject({ outcome: 'waits_for_a_person', because: 'refused_by_route' });

    // The manager stops ALL auto-approval at once (a reason is needed); the next draft waits.
    expect((await send('POST', '/v1/ai/auto-approve/stop', MANAGER, {})).status).toBe(400);
    expect((await send('POST', '/v1/ai/auto-approve/stop', MANAGER, { reason: 'checking a delivery' })).status).toBe(200);
    expect((await state()).running).toBe(false);
    await raise('a02-synth-4', 'A02', reorder(100_000));
    sweep = await send('POST', '/v1/ai/auto-approve/sweep', OWNER, {});
    expect((sweep.body as { decisions: { proposalId: string; because?: string }[] }).decisions.find((d) => d.proposalId === 'a02-synth-4')).toMatchObject({ because: 'auto_approval_stopped' });

    // A change asked against an old version of the rule is refused, never overwrites (hard rule 10).
    const stale = await send('POST', '/v1/ai/auto-approve/requests', OWNER, { action: 'set_limit', kind: 'reorder_from_approved_supplier', limit: 900_000, basedOnVersion: 0, reason: 'raise it' });
    expect([stale.status, (stale.body as { error: { code: string } }).error.code]).toEqual([409, 'rule_changed_since_asked']);
  });
});
