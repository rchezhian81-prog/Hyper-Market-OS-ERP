import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { ownerApprovedSetting } from '../support/owner-approved-setting';
import { InMemoryEventStore, SqlEventStore, type EventStore } from '../../packages/persistence/src/event-store';
import { MemoryIdempotencyStore, SqlIdempotencyStore, type IdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { shopDateIn } from '../../packages/calendar/src/shop-clock';

/**
 * **A01 says WHY the takings fell — "likely because…", with evidence and a confidence, and commits nothing (roadmap §7
 * "causal hypotheses" · A01 · AI-NFR-04 · hard rule 5).**
 *
 * Through the real API (in memory and, with DATABASE_URL, on real PostgreSQL with a cold restart): on the same weekday last
 * week the shop took ₹1,200 (milk ₹1,000 in Dairy, rice ₹200 in Grocery) and sold the milk out; yesterday it took ₹5,000
 * (a busier day that must NOT be the comparison — OB-516); today it took ₹300 (rice only). A01's run:
 *   • states what changed against the same weekday last week (down ₹900), never against yesterday;
 *   • adds "likely because Dairy took ₹1,000 less" and "likely in part because P-MILK … is out of stock there", each with
 *     its governed evidence and a confidence that is never "high", proposing nothing to do;
 *   • spends nothing, calls no model, and writes nothing but its own run record — no price, stock or order changed;
 *   • a cashier cannot run it (403); after a cold restart the run's likely causes are still on the register.
 * Synthetic data only.
 */

const OWNER = 'u-owner'; const TILL = 'u-till';
const DATABASE_URL = process.env['DATABASE_URL'];
let pool: Pool | undefined;
beforeAll(async () => {
  if (DATABASE_URL === undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
  const dir = 'db/migrations';
  await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
});
afterAll(async () => { await pool?.end(); });

interface Backing { readonly name: string; readonly stores: () => { store: EventStore; idempotency: IdempotencyStore } }
const backings: Backing[] = [{ name: 'the in-memory event store', stores: () => ({ store: new InMemoryEventStore(), idempotency: new MemoryIdempotencyStore() }) }];
if (DATABASE_URL !== undefined) backings.push({ name: 'real PostgreSQL', stores: () => { const sql = pgPoolClient(pool!); return { store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }; } });

interface Proposal { proposalId: string; agent: string; summary: string; wouldRequire: string; evidence: { source: string }[]; confidence?: { band: string; basis: string; uncertainty: string }; committed: false }

describe.each(backings)('A01 says the likely cause of a takings drop, on $name', ({ stores }) => {
  it('likely because a department fell and a top seller is out — evidenced, read-only, kept across a cold restart', async () => {
    const backing = stores();
    let h: ApiHarness = apiHarness(backing);
    const T = randomUUID();
    const now = new Date();
    const today = shopDateIn(now.toISOString(), 'UTC');
    const yesterday = shopDateIn(new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString(), 'UTC');
    const lastWeek = shopDateIn(new Date(Date.parse(`${today}T00:00:00Z`) - 7 * 86_400_000).toISOString(), 'UTC'); // OB-516
    await h.seedOwner(T, OWNER);
    await h.provisionRole(T, TILL, 'cashier');
    expect((await ownerApprovedSetting(h, T, 'locale.time_zone', { value: 'UTC' })).status).toBe(200);
    const ok = async (r: Promise<{ status: number; body: unknown }>, what: string) => { const x = await r; expect(x.status, `${what}: ${JSON.stringify(x.body)}`).toBeLessThan(300); return x; };
    const owner = (method: 'POST' | 'PUT', path: string, body: unknown) => h.request({ method, path, userId: OWNER, tenantId: T, idempotencyKey: `k-${randomUUID()}`, body });
    for (const [id, cat] of [['P-MILK', 'dairy'], ['P-RICE', 'grocery']] as const) {
      await ok(owner('POST', `/v1/catalogue/products/${id}/publish`, { product: { sku: `SKU-${id}`, name: id, baseUom: 'ea', primaryCategoryId: cat, taxClass: '1006', lifecycle: 'active', handling: 'ambient' }, categories: [{ categoryId: cat, name: cat, parentId: null }] }), `publish ${id}`);
    }
    await ok(owner('POST', '/v1/inventory/movements', { movementId: 'mv-milk', productId: 'P-MILK', locationId: 'S1', kind: 'received', quantityMinor: 2, uom: 'ea', occurredAt: `${lastWeek}T03:00:00.000Z`, enteredBy: OWNER, unitCostMinor: 8_000 }), 'receive milk');
    const sale = (saleId: string, day: string, at: string, lines: { productId: string; qty: number; unit: number }[]) => {
      const total = lines.reduce((t, l) => t + l.qty * l.unit, 0);
      return ok(h.request({ method: 'POST', path: '/v1/sales', userId: TILL, tenantId: T, idempotencyKey: `sale-${saleId}`, body: {
        saleId, receiptNumber: `R-${saleId}`, laneId: 'lane-1', locationId: 'S1', cashierId: TILL, tradingDay: day, committedAt: at, totalMinor: total, currency: 'INR', packVersion: 1,
        lines: lines.map((l) => ({ productId: l.productId, quantityMinor: l.qty, uom: 'ea', unitPriceMinor: l.unit, lineTotalMinor: l.qty * l.unit })), tenders: [{ kind: 'cash', amountMinor: total }],
      } }), `sale ${saleId}`);
    };
    await sale('W-1', lastWeek, `${lastWeek}T10:00:00.000Z`, [{ productId: 'P-MILK', qty: 10, unit: 10_000 }, { productId: 'P-RICE', qty: 4, unit: 5_000 }]);
    // Yesterday: a busier day in another department (no milk) — the old "against yesterday" comparison would read this.
    await sale('Y-1', yesterday, `${yesterday}T10:00:00.000Z`, [{ productId: 'P-RICE', qty: 100, unit: 5_000 }]);
    await sale('T-1', today, new Date(now.getTime() - 1_000).toISOString(), [{ productId: 'P-RICE', qty: 6, unit: 5_000 }]);
    await ok(owner('PUT', '/v1/ai/kill-switch', { on: false }), 'kill switch off');
    await ok(owner('PUT', '/v1/ai/agents/enabled', { agents: ['A01'] }), 'A01 on');

    // A cashier may not run the owner's agent.
    expect((await h.request({ method: 'POST', path: '/v1/ai/agents/A01/runs', userId: TILL, tenantId: T, idempotencyKey: 'run-cash', body: {} })).status).toBe(403);

    const before = (await h.store.readStream(T, 'inventory')).length;
    expect(before).toBeGreaterThan(0);
    const res = await ok(owner('POST', '/v1/ai/agents/A01/runs', {}), 'run A01');
    const body = res.body as { proposals: Proposal[]; costMinor: number; calledAModel: boolean; committedAnything: false };
    expect(body).toMatchObject({ costMinor: 0, calledAModel: false, committedAnything: false });
    const byId = new Map(body.proposals.map((p) => [p.proposalId, p]));
    expect(byId.get(`a01-takings-${today}`)?.summary).toMatch(new RegExp(`Taken so far today: ₹300\\.00 against ₹1,200\\.00 on ${lastWeek}, the same weekday last week \\(down ₹900\\.00\\)`));
    const dept = byId.get(`a01-cause-department-${today}`);
    expect(dept?.summary).toBe(`Takings are down ₹900.00 on ${lastWeek} (the same weekday last week) — likely because dairy took ₹1,000.00 less (₹1,000.00 on ${lastWeek}, ₹0.00 today), 100% of the drop`);
    expect(dept?.evidence.map((e) => e.source)).toEqual(expect.arrayContaining(['report sales_by_day', 'report units_by_category']));
    const out = byId.get(`a01-cause-stockout-P-MILK-S1-${today}`);
    expect(out?.summary).toMatch(/likely in part because P-MILK, one of .*'s top sellers at S1 \(₹1,000\.00\), is out of stock there \(on hand -8\) and took ₹0\.00 today/);
    for (const p of [dept!, out!]) {
      expect(p.agent).toBe('A01');
      expect(p.committed).toBe(false);
      expect(p.wouldRequire).toMatch(/A01 is read-only/);
      expect(p.confidence).toMatchObject({ basis: 'rule_inference' });
      expect(p.confidence?.band).not.toBe('high');
    }
    expect(byId.has(`a01-cause-unknown-${today}`)).toBe(false);
    // Read-only: nothing moved in stock; no price, no order.
    expect((await h.store.readStream(T, 'inventory')).length).toBe(before);
    expect(await h.store.readStream(T, 'purchase\u001forders')).toHaveLength(0);

    // Cold restart: a new API over the same store still lists the run's likely causes.
    h = apiHarness(backing);
    const listed = (await h.request({ method: 'GET', path: '/v1/ai/proposals', userId: OWNER, tenantId: T })).body as { proposals: Proposal[]; committedAnything: false };
    expect(listed.committedAnything).toBe(false);
    const kept = listed.proposals.find((p) => p.proposalId === `a01-cause-department-${today}`);
    expect(kept?.summary).toMatch(/likely because dairy took ₹1,000\.00 less/);
    expect(kept?.confidence?.basis).toBe('rule_inference');
  }, 60_000);
});
