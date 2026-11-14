import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { approvedSuppliers, deliveryPlaces } from '../support/approved-supplier';
import { storeRules } from '../support/store-rules';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore, InMemoryEventStore, type EventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { makeEvent } from '../../packages/contracts/src/event';
import { shopDateIn } from '../../packages/calendar/src/shop-clock';
import { STREAM } from '../../services/api/src/adapters';
import { exactActsFor } from '../../services/api/src/ai-auto-approve-acts';
import { RULE_IDENTITY } from '../../services/api/src/ai-auto-approve-executor';
import type { DraftAct } from '../../packages/ai/src/index';

/**
 * **CR-01 OI-12 step 6b · OB-760 A · OB-761 A · OB-762 A — a rule's approval PLACES the act through its ORDINARY route, on head
 * office's real API (real PostgreSQL when DATABASE_URL is set; in memory otherwise).** Synthetic data only.
 *
 *   • A02's reorder says exactly what it would do from the shop's own records: the manager's stored reorder settings for rice
 *     at S1 (most to hold 100, reorder at 20, packs of 12), the 12 still owed on an earlier order, and that order's price
 *     (₹30 from an approved supplier) → 96 rice, ₹2,880;
 *   • inside the owner's ₹5,000 limit (asked by the owner, confirmed by the accountant), the rule RAISES the order as
 *     `rule:auto-approve` and ISSUES it as the rule itself — through the ordinary purchase-order routes and their checks; the
 *     order names the rule, and its reason names the owner and the accountant; a person cannot decide the draft again, and a
 *     second sweep places nothing more;
 *   • a markdown inside its limit is REFUSED by the price route (below the store's margin floor): nothing is priced, the draft
 *     waits for a person with the route's own reason, and the rule never tries it again;
 *   • a transfer inside its limit is RAISED by the rule through the transfer route — a person dispatches it, another receives;
 *   • the rule's identity has no power of its own over HTTP: a token in its name is refused.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const OWNER = 'u-owner'; const ACCOUNTANT = 'u-accountant'; const MANAGER = 'u-manager';
const TODAY = shopDateIn(new Date().toISOString());

describe('CR-01 OI-12 step 6b: a rule\'s approval places the act through its ordinary route', () => {
  let pool: Pool | undefined;
  let h: ApiHarness;
  let store: EventStore;
  const T = randomUUID();
  type Res = { status: number; body: unknown };
  const send = (method: 'GET' | 'POST' | 'PUT', path: string, userId: string, body?: unknown): Promise<Res> =>
    h.request({ method, path, userId, tenantId: T, ...(method === 'GET' ? {} : { idempotencyKey: `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }) });
  const ok = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
  const raise = async (proposalId: string, agent: 'A02' | 'A03', act: DraftAct) => {
    const p = { proposalId, agent, summary: `synthetic draft ${proposalId}`, wouldRequire: 'the ordinary route', evidence: [{ source: 'synthetic', reference: 'r-1', summary: 'synthetic evidence' }], createdAt: new Date().toISOString(), act, committed: false };
    await store.append(T, STREAM.ai, makeEvent({ id: `ai-proposal-${proposalId}`, type: 'AiProposalRaised', occurredAt: p.createdAt, idempotencyKey: `ai-proposal-${T}-${proposalId}`, source: 'test/synthetic', payload: p }));
  };
  const limit = async (kind: string, value: number) => {
    const s = (await send('GET', '/v1/ai/auto-approve', OWNER)).body as { versionOf: Record<string, number> };
    const asked = await ok(send('POST', '/v1/ai/auto-approve/requests', OWNER, { action: 'set_limit', kind, limit: value, basedOnVersion: s.versionOf[kind], reason: 'synthetic step 6b trial' }), `ask ${kind}`);
    await ok(send('POST', `/v1/ai/auto-approve/requests/${(asked.body as { request: { requestId: string } }).request.requestId}/decision`, ACCOUNTANT, { decision: 'confirmed' }), `confirm ${kind}`);
  };
  type Decision = { proposalId: string; outcome: string; because?: string; placed?: { reference: string; route: string }; refusedBy?: { code: string; route: string }; detail: string };
  const sweep = async (): Promise<Decision[]> => ((await ok(send('POST', '/v1/ai/auto-approve/sweep', OWNER, {}), 'sweep')).body as { decisions: Decision[] }).decisions;

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
    await deliveryPlaces(h, T, 'S1', 'WH');
    await approvedSuppliers(h, T, 'sup-synthetic-soap');
    await storeRules(h, T, OWNER, 'S1', 2_000); // the store's margin floor: 20%

    // The last price: an earlier order for 12 rice at ₹30 from the approved supplier, proposed by the manager, issued by the owner.
    await ok(send('POST', '/v1/purchase/orders/po-synthetic-old', MANAGER, { supplierId: 'sup-synthetic-soap', deliverToLocationId: 'S1', lines: [{ productId: 'p-rice', orderedQty: 12, unitCost: { minor: 3_000, currency: 'INR' } }] }), 'earlier order');
    await ok(send('POST', '/v1/purchase/orders/po-synthetic-old/approval', OWNER, { reason: 'synthetic earlier order' }), 'issue earlier order');
    // The manager's reorder settings for rice at S1 (Reorder tab, M09-FR-02).
    await ok(send('POST', '/v1/replenishment/parameters/S1/p-rice', MANAGER, { maxLevel: 100, reorderPoint: 20, orderMultiple: 12, reason: 'synthetic rice settings' }), 'reorder settings');
    // Stock in the warehouse to move, at a known cost.
    await ok(send('POST', '/v1/inventory/movements', OWNER, { movementId: `m-wh-soap-${T}`, productId: 'p-soap', locationId: 'WH', kind: 'received', quantityMinor: 60, uom: 'ea', occurredAt: new Date(Date.now() - 3_600_000).toISOString(), enteredBy: OWNER, unitCostMinor: 3_000 }), 'stock at WH');
    // A shelf price for curd at S1 (₹40, MRP ₹45, cost ₹26).
    await ok(send('POST', '/v1/prices/list/p-curd/entries/e1', OWNER, { scope: 'store', scopeRef: 'S1', priceMinor: 4_000, mrpMinor: 4_500, costMinor: 2_600, marginFloorBps: 0, currency: 'INR', effectiveFrom: TODAY }), 'curd price');

    // The owner's limits — each asked by the owner and confirmed by the accountant — and auto-approval started, AI on.
    await limit('reorder_from_approved_supplier', 500_000);
    await limit('markdown_short_dated', 3_000);
    await limit('stock_transfer', 200_000);
    const s = (await send('GET', '/v1/ai/auto-approve', OWNER)).body as { switchVersion: number };
    const start = await ok(send('POST', '/v1/ai/auto-approve/requests', OWNER, { action: 'resume', basedOnVersion: s.switchVersion, reason: 'synthetic trial' }), 'ask start');
    await ok(send('POST', `/v1/ai/auto-approve/requests/${(start.body as { request: { requestId: string } }).request.requestId}/decision`, ACCOUNTANT, { decision: 'confirmed' }), 'confirm start');
    await ok(send('PUT', '/v1/ai/kill-switch', OWNER, { on: false, reason: 'synthetic step 6b trial' }), 'AI on');
  }, 180_000);
  afterAll(async () => { await pool?.end(); });

  it('A02\'s reorder says exactly what to order, from the stored settings and the last price (OB-761 A)', async () => {
    const r = await exactActsFor({ store, now: () => new Date().toISOString() })(T).reorder('p-rice', 'S1');
    // Position: 0 on hand + 12 still owed → up to 100 → 88 → packs of 12 → 96; at ₹30 → ₹2,880.
    expect(r.act).toMatchObject({ kind: 'reorder_from_approved_supplier', supplierId: 'sup-synthetic-soap', supplierApproved: true, valueMinor: 288_000, deliverToLocationId: 'S1', lines: [{ productId: 'p-rice', qty: 96, unitCostMinor: 3_000 }] });
    // A product with no settings gets no act.
    expect((await exactActsFor({ store, now: () => new Date().toISOString() })(T).reorder('p-nothing-set', 'S1')).act).toBeUndefined();
  });

  it('inside the limit, the rule RAISES and ISSUES the order through the ordinary routes, at most once', async () => {
    const r = await exactActsFor({ store, now: () => new Date().toISOString() })(T).reorder('p-rice', 'S1');
    await raise('a02-step6b-rice', 'A02', r.act!);
    const decided = (await sweep()).find((d) => d.proposalId === 'a02-step6b-rice')!;
    expect(decided).toMatchObject({ outcome: 'auto_approved', placed: { reference: expect.stringMatching(/^po-auto-/) } });
    const poId = decided.placed!.reference;
    const po = (await ok(send('GET', `/v1/purchase/orders/${poId}`, OWNER), 'read order')).body as { order: { status: string; requisitionedBy: string; approvedBy: string; totalMinor: number; supplierId: string } };
    expect(po.order).toMatchObject({ status: 'issued', requisitionedBy: RULE_IDENTITY, approvedBy: 'rule:reorder_from_approved_supplier-v1', totalMinor: 288_000, supplierId: 'sup-synthetic-soap' });
    // The drafts register: approved by the rule; a person cannot decide it a second time.
    const proposals = (await send('GET', '/v1/ai/proposals', OWNER)).body as { proposals: { proposalId: string; outcome: { decision: string; by: string } | null }[] };
    expect(proposals.proposals.find((p) => p.proposalId === 'a02-step6b-rice')!.outcome).toMatchObject({ decision: 'approved', by: 'rule:reorder_from_approved_supplier-v1' });
    expect((await send('POST', '/v1/ai/proposals/a02-step6b-rice/outcome', OWNER, { decision: 'rejected', reason: 'no' })).status).toBe(409);
    // A second sweep places nothing more: still exactly one order raised by the rule.
    await sweep();
    const all = (await send('GET', '/v1/purchase/orders', OWNER)).body as { orders: { poId: string; requisitionedBy: string }[] };
    expect(all.orders.filter((o) => o.requisitionedBy === RULE_IDENTITY).map((o) => o.poId)).toEqual([poId]);
    // The Auto-approve limits page reads it as placed.
    const page = (await send('GET', '/v1/ai/auto-approve', OWNER)).body as { decisions: Decision[] };
    expect(page.decisions.find((d) => d.proposalId === 'a02-step6b-rice')).toMatchObject({ outcome: 'auto_approved', placed: { reference: poId } });
  });

  it('a markdown the price route refuses waits for a person with the route\'s reason — nothing is priced, never retried', async () => {
    // 25% off ₹40 = ₹30, against a cost of ₹26: a 13% margin, under the store's 20% floor.
    await raise('a03-step6b-curd', 'A03', { kind: 'markdown_short_dated', productId: 'p-curd', batchId: 'b-curd-synthetic', percentOffBps: 2_500, daysToExpiry: 3, storeId: 'S1', currentPriceMinor: 4_000, newPriceMinor: 3_000, mrpMinor: 4_500, costMinor: 2_600, surplusQty: 12 });
    const d = (await sweep()).find((x) => x.proposalId === 'a03-step6b-curd')!;
    expect(d).toMatchObject({ outcome: 'waits_for_a_person', because: 'refused_by_route', refusedBy: { route: 'POST /v1/prices/changes', code: 'price_below_floor' } });
    expect((await sweep()).some((x) => x.proposalId === 'a03-step6b-curd')).toBe(false);
    // A person may still decide it.
    expect((await send('POST', '/v1/ai/proposals/a03-step6b-curd/outcome', MANAGER, { decision: 'rejected', reason: 'too deep for this curd' })).status).toBeLessThan(300);
  });

  it('a transfer inside its limit is raised by the rule — a person dispatches it, another receives it', async () => {
    await raise('a03-step6b-soap-move', 'A03', { kind: 'stock_transfer', productId: 'p-soap', fromLocationId: 'WH', toLocationId: 'S1', qty: 24, valueMinor: 72_000, uom: 'ea' });
    const d = (await sweep()).find((x) => x.proposalId === 'a03-step6b-soap-move')!;
    expect(d).toMatchObject({ outcome: 'auto_approved', placed: { reference: expect.stringMatching(/^tr-auto-/) } });
    const t = (await ok(send('GET', `/v1/warehouse/transfers/${d.placed!.reference}`, OWNER), 'read transfer')).body as Record<string, unknown>;
    expect(JSON.stringify(t)).toMatch(/"state":"proposed"/);
    expect(JSON.stringify(t)).toMatch(new RegExp(`"requestedBy":"${RULE_IDENTITY}"`));
  });

  it('the rule\'s identity has no power of its own: a request in its name is refused', async () => {
    const r = await send('POST', '/v1/purchase/orders/po-by-a-token', RULE_IDENTITY, { supplierId: 'sup-synthetic-soap', deliverToLocationId: 'S1', lines: [{ productId: 'p-soap', orderedQty: 1, unitCost: { minor: 3_000, currency: 'INR' } }] });
    expect(r.status).toBe(403);
  });
});
