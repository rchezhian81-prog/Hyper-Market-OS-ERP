import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';

/**
 * **A03's transfer-suggestion leg (round 8 · M09-FR-03 · A03 "transfer suggestion — manager approval" · hard rule #5 · P-05).**
 * Through the real AI run route, in memory and — with DATABASE_URL — on real PostgreSQL: a product out at a store that sold
 * there this week, and held elsewhere in the company, is a DRAFT transfer — from the store's own back store first, then head
 * office's warehouse, then another store — citing what each place holds and what sold. No quantity is invented, nothing is
 * transferred, and a product nobody holds is not a transfer (it is A02's reorder). The manager then raises the transfer
 * through the ordinary route, where the people and the stock rules are the transfer's own.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
let pool: Pool | undefined;
beforeAll(async () => {
  if (DATABASE_URL === undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
  const dir = 'db/migrations';
  await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
});
afterAll(async () => { await pool?.end(); });
const backings: { name: string; harness: () => ApiHarness }[] = [{ name: 'the in-memory event store', harness: () => apiHarness() }];
if (DATABASE_URL !== undefined) backings.push({ name: 'real PostgreSQL', harness: () => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); } });

interface Proposal { proposalId: string; agent: string; summary: string; wouldRequire: string; evidence: { source: string; summary: string }[]; committed: boolean }

describe.each(backings)('A03 suggests transfers from where the company holds stock to where it ran out — on $name', ({ harness }) => {
  it('back store first, then head office, never a quantity, never a transfer; nobody holds it → no transfer suggestion', async () => {
    const h = harness();
    const T = randomUUID();
    const today = new Date().toISOString().slice(0, 10);
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-till', 'cashier');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    const post = (path: string, body: unknown, key: string, u = 'u-owner') => h.request({ method: 'POST', path, userId: u, tenantId: T, idempotencyKey: key, body });
    const put = (path: string, body: unknown, key: string) => h.request({ method: 'PUT', path, userId: 'u-owner', tenantId: T, idempotencyKey: key, body });
    for (const [id, body] of [
      ['C1', { kind: 'company', name: 'SRE Retail' }],
      ['S1', { kind: 'branch', name: 'Store 1', parentId: 'C1', companyId: 'C1' }],
      ['S1-BACK', { kind: 'warehouse', name: 'Store 1 back store', parentId: 'S1', companyId: 'C1' }],
      ['WH', { kind: 'warehouse', name: 'Head office warehouse', parentId: 'C1', companyId: 'C1' }],
      ['S2', { kind: 'branch', name: 'Store 2', parentId: 'C1', companyId: 'C1' }],
    ] as const) expect((await post(`/v1/org/nodes/${id}`, body, `org-${id}`)).status).toBe(201);
    const receive = async (p: string, loc: string, q: number) =>
      expect((await post('/v1/inventory/movements', { movementId: `rx-${p}-${loc}`, productId: p, locationId: loc, kind: 'received', quantityMinor: q, uom: 'ea', occurredAt: new Date(Date.now() - 7_200_000).toISOString(), enteredBy: 'u-owner', unitCostMinor: 1_000 }, `rx-${p}-${loc}`)).status).toBe(202);
    const sell = async (saleId: string, loc: string, p: string, q: number) =>
      expect((await post('/v1/sales', {
        saleId, receiptNumber: `R-${saleId}`, laneId: 'lane-1', locationId: loc, cashierId: 'u-till', tradingDay: today, committedAt: new Date(Date.now() - 60_000).toISOString(),
        totalMinor: q * 2_000, currency: 'INR', packVersion: 1, lines: [{ productId: p, quantityMinor: q, uom: 'ea', unitPriceMinor: 2_000, lineTotalMinor: q * 2_000 }], tenders: [{ kind: 'cash', amountMinor: q * 2_000 }],
      }, saleId, 'u-till')).status).toBe(202);
    // OIL: 2 on the floor at S1, 3 sold → out; its back store holds 5, head office 20, store 2 holds 4.
    await receive('OIL', 'S1', 2); await receive('OIL', 'S1-BACK', 5); await receive('OIL', 'WH', 20); await receive('OIL', 'S2', 4);
    await sell('s-1', 'S1', 'OIL', 3);
    // RICE: sold out at S1; held only at head office and at store 2.
    await receive('RICE', 'S1', 1); await receive('RICE', 'WH', 12); await receive('RICE', 'S2', 30);
    await sell('s-2', 'S1', 'RICE', 1);
    // SALT: sold out at S2 and nobody else holds any — a reorder, not a transfer.
    await receive('SALT', 'S2', 2);
    await sell('s-3', 'S2', 'SALT', 2);
    // DAL: sold at S1 but still on the shelf — nothing to suggest.
    await receive('DAL', 'S1', 9); await receive('DAL', 'WH', 9);
    await sell('s-4', 'S1', 'DAL', 1);

    expect((await put('/v1/ai/kill-switch', { on: false }, 'k')).status).toBe(200);
    expect((await put('/v1/ai/budget', { capMinor: 500_000, periodEnds: '2027-01-01T00:00:00Z' }, 'b')).status).toBe(200);
    expect((await put('/v1/ai/agents/enabled', { agents: ['A03'] }, 'e')).status).toBe(200);
    const run = await post('/v1/ai/agents/A03/runs', {}, 'run-1');
    expect(run.status).toBe(200);
    const body = run.body as { proposals: Proposal[]; committedAnything: boolean };
    expect(body.committedAnything).toBe(false);
    const transfers = body.proposals.filter((p) => p.proposalId.startsWith('a03-transfer-'));
    expect(transfers.map((p) => p.proposalId)).toEqual([`a03-transfer-OIL-S1-BACK-S1-${today}`, `a03-transfer-RICE-WH-S1-${today}`]);
    const [oil, rice] = transfers as [Proposal, Proposal];
    expect(oil.summary).toMatch(/OIL is out at S1 \(on hand -1\) and sold 3 there in the last 7 days; S1-BACK \(its own back store\) holds 5/);
    expect(oil.summary).toMatch(/how many is the manager's decision/);
    expect(rice.summary).toMatch(/RICE is out at S1 \(on hand 0\) and sold 1 .* WH \(head office's warehouse\) holds 12/);
    expect(oil.wouldRequire).toMatch(/POST \/v1\/warehouse\/transfers\/:transferId by a person/);
    expect(oil.evidence.map((e) => e.source)).toEqual(['inventory availability', 'sales ledger']);
    expect(transfers.every((p) => p.agent === 'A03' && p.committed === false)).toBe(true);
    // Nothing moved: no transfer was raised and the stock is where it was.
    expect(await h.store.readStream(T, 'warehouse\u001ftransfers')).toHaveLength(0);

    // The manager acts on the suggestion through the ordinary transfer route — their own decision, their own figures.
    expect((await post('/v1/warehouse/transfers/t-oil', { fromLocationId: 'S1-BACK', toLocationId: 'S1', lines: [{ productId: 'OIL', batchId: null, quantityMinor: 4, uom: 'ea', unitCost: { minor: 1_000, currency: 'INR' } }] }, 't-oil', 'u-mgr')).status).toBeLessThan(300);
    expect((await h.store.readStream(T, 'warehouse\u001ftransfers')).length).toBeGreaterThan(0); // the same stream the run left empty
  });
});
