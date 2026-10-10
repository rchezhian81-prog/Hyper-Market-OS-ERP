import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { DEFAULT_RETAIL_POSTING_MAP } from '../../packages/finance/src/index';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';

/**
 * **The inventory-loss journal (Batch 3 over Batch 2's resolved shortfalls · M23-FR-01 · P-08 · hard rule #2).** A transfer
 * of 10 at ₹50 arrives 8; a third person resolves the shortfall: 1 found at the store (back on the ledger, not a loss), 1
 * confirmed lost at ₹50. The accountant's posting run turns that loss into ONE balanced journal — loss expense against
 * inventory, ₹50 — and a second run posts nothing; with no rule for the kind, nothing posts and the loss stays visibly
 * unposted. In memory and, with DATABASE_URL, on real PostgreSQL.
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

describe.each(backings)('confirmed-lost stock posts one inventory-loss journal — on $name', ({ harness }) => {
  const lostOnATransfer = async () => {
    const h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    for (const [u, role] of [['u-boss', 'store_manager'], ['u-store', 'store_manager'], ['u-area', 'store_manager'], ['u-acct', 'accountant']] as const) await h.provisionRole(T, u, role);
    const call = (method: 'GET' | 'POST' | 'PUT', path: string, userId: string, body?: unknown, key?: string) =>
      h.request({ method, path, userId, tenantId: T, ...(body === undefined ? {} : { body }), ...(method === 'GET' ? {} : { idempotencyKey: key ?? `${path}-${userId}` }) });
    const ok = async (p: ReturnType<typeof call>, what: string) => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
    await ok(call('POST', '/v1/org/nodes/C1', 'u-owner', { kind: 'company', name: 'SRE Retail' }), 'company');
    await ok(call('POST', '/v1/org/nodes/WH', 'u-owner', { kind: 'warehouse', name: 'Central warehouse', parentId: 'C1', companyId: 'C1' }), 'warehouse');
    await ok(call('POST', '/v1/org/nodes/S1', 'u-owner', { kind: 'branch', name: 'Store 1', parentId: 'C1', companyId: 'C1' }), 'store');
    await ok(call('POST', '/v1/inventory/movements', 'u-owner', { movementId: 'seed', productId: 'P1', locationId: 'WH', kind: 'received', quantityMinor: 20, uom: 'EA', occurredAt: '2026-08-01T00:00:00.000Z', enteredBy: 'u-owner', unitCostMinor: 5_000 }), 'stock');
    await ok(call('POST', '/v1/warehouse/transfers/t1', 'u-owner', { fromLocationId: 'WH', toLocationId: 'S1', lines: [{ productId: 'P1', batchId: null, quantityMinor: 10, uom: 'EA', unitCost: { minor: 5_000, currency: 'INR' } }] }), 'propose');
    await ok(call('POST', '/v1/warehouse/transfers/t1/dispatch', 'u-boss', {}), 'dispatch');
    await ok(call('POST', '/v1/warehouse/transfers/t1/receive', 'u-store', { counted: [{ productId: 'P1', batchId: null, quantityMinor: 8 }] }), 'receive');
    await ok(call('POST', '/v1/warehouse/transfers/t1/shortfall/resolution', 'u-area', { lines: [{ productId: 'P1', batchId: null, foundMinor: 1 }], reasonCode: 'miscount', note: 'one carton was behind the cold-room door' }), 'resolve');
    return { call, ok };
  };

  it('posts the confirmed loss once, loss expense against inventory, and a re-run posts nothing', async () => {
    const { call, ok } = await lostOnATransfer();
    await ok(call('PUT', '/v1/finance/posting-map', 'u-acct', DEFAULT_RETAIL_POSTING_MAP, 'map'), 'mapping');
    const before = (await call('GET', '/v1/finance/stock-losses', 'u-acct')).body;
    expect(before).toMatchObject({ unposted: ['transfer:t1'], lostValueMinor: 5_000, postedValueMinor: 0 });
    const run = await call('POST', '/v1/finance/stock-losses/post', 'u-acct', {}, 'post-1');
    expect(run.status).toBe(201);
    expect(run.body).toMatchObject({ exceptions: [], posted: [{ entryId: 'stock-loss:transfer:t1', lines: [
      { accountCode: 'inventory_loss', debitMinor: 5_000, creditMinor: 0 }, { accountCode: 'inventory', debitMinor: 0, creditMinor: 5_000 },
    ], stockLoss: { sourceId: 'transfer:t1', kind: 'stock_loss:transfer', lostValueMinor: 5_000 } }] });
    const again = await call('POST', '/v1/finance/stock-losses/post', 'u-acct', {}, 'post-2');
    expect(again).toMatchObject({ status: 200, body: { posted: [] } });
    expect((await call('GET', '/v1/finance/stock-losses', 'u-acct')).body).toMatchObject({ unposted: [], postedValueMinor: 5_000 });
  });

  it('with no rule for stock losses in the mapping, nothing posts and the loss stays visibly unposted', async () => {
    const { call, ok } = await lostOnATransfer();
    const map = { rules: DEFAULT_RETAIL_POSTING_MAP.rules.filter((r) => !r.kind.startsWith('stock_loss:')) };
    await ok(call('PUT', '/v1/finance/posting-map', 'u-acct', map, 'map'), 'mapping');
    const run = await call('POST', '/v1/finance/stock-losses/post', 'u-acct', {}, 'post-1');
    expect(run.body).toMatchObject({ posted: [], exceptions: [{ sourceId: 'transfer:t1', kind: 'stock_loss:transfer', reason: 'unmapped_kind' }] });
    expect((await call('GET', '/v1/finance/stock-losses', 'u-acct')).body).toMatchObject({ unposted: ['transfer:t1'] });
  });
});
