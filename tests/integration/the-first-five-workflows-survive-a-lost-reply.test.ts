import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { approvedSuppliers, deliveryPlaces } from '../support/approved-supplier';
import { MemoryIdempotencyStore, SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';

/**
 * **§26 WORKFLOW RULE — the TIMEOUT scenario of WF-01 (product onboarding), WF-02 (supplier onboarding) and WF-03
 * (purchase planning), on the real API, in memory and — with DATABASE_URL — on real PostgreSQL (re-audit final, T3).**
 *
 * A timeout here is: head office DID the write, but the answer never reached the screen (the line dropped, the browser
 * gave up). The screen sends the same request again under the SAME idempotency key. Head office must answer with what it
 * did the first time — never a second product version, a second supplier or a second purchase order — and the record
 * must read the same from a second head-office instance over the same store (a restart). §31.1: "duplicates collapse by
 * immutable transaction/idempotency identity". (A re-send under a NEW key is the separate "duplicate" scenario, proved
 * in each workflow's own tests.)
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

/** A head office, and a second instance over the SAME durable store and idempotency record (a restart). */
type Factory = () => { first: ApiHarness; restarted: () => ApiHarness };
const backings: { name: string; harness: Factory }[] = [{
  name: 'the in-memory event store',
  harness: () => {
    const idempotency = new MemoryIdempotencyStore();
    const first = apiHarness({ idempotency });
    return { first, restarted: () => apiHarness({ store: first.store, idempotency }) };
  },
}];
if (DATABASE_URL !== undefined) {
  backings.push({
    name: 'real PostgreSQL',
    harness: () => {
      const make = (): ApiHarness => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); };
      return { first: make(), restarted: make };
    },
  });
}

const GROCERY = { categoryId: 'grocery', name: 'Grocery', parentId: null };
const SALT = { sku: 'SKU-SALT', name: 'Tata Salt 1kg', baseUom: 'each', primaryCategoryId: 'grocery', taxClass: '25010020', lifecycle: 'draft' };

describe.each(backings)('the first five workflows survive a lost reply (§26 timeout) — on $name', ({ harness }) => {
  it('WF-01: a product publish whose reply was lost, sent again under the same key, is the same answer and one product', async () => {
    const { first: h, restarted } = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    const send = (hh: ApiHarness) => hh.request({ method: 'POST', path: '/v1/catalogue/products/p-salt/publish', userId: 'u-owner', tenantId: T, idempotencyKey: 'pub-salt-1', body: { product: SALT, categories: [GROCERY] } });
    const first = await send(h);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    // The answer is lost; the screen tries again with the same key — from a second head-office instance (a restart).
    const h2 = restarted();
    const again = await send(h2);
    expect(again.status).toBe(first.status);
    expect((again.body as { product: unknown }).product).toEqual((first.body as { product: unknown }).product);
    const list = (await h2.request({ method: 'GET', path: '/v1/catalogue/products', userId: 'u-owner', tenantId: T })).body as { products: { productId: string }[] };
    expect(list.products.filter((p) => p.productId === 'p-salt')).toHaveLength(1);
    // The same key with a DIFFERENT body is not a retry — it is refused, never applied.
    const changed = await h2.request({ method: 'POST', path: '/v1/catalogue/products/p-salt/publish', userId: 'u-owner', tenantId: T, idempotencyKey: 'pub-salt-1', body: { product: { ...SALT, name: 'Something else' }, categories: [GROCERY] } });
    expect(changed.status).toBeGreaterThanOrEqual(400);
    const read = (await h2.request({ method: 'GET', path: '/v1/catalogue/products/p-salt', userId: 'u-owner', tenantId: T })).body as { product: { name: string } };
    expect(read.product.name).toBe('Tata Salt 1kg');
  });

  it('WF-02: a supplier application whose reply was lost, sent again under the same key, is the same answer and one supplier', async () => {
    const { first: h, restarted } = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-buyer', 'store_manager');
    const send = (hh: ApiHarness) => hh.request({ method: 'POST', path: '/v1/purchase/suppliers/sup-kav', userId: 'u-buyer', tenantId: T, idempotencyKey: 'apply-kav', body: { name: 'Kaveri Foods', gstin: '33KAVER1234F1Z5', paymentTermsDays: 30 } });
    const first = await send(h);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const h2 = restarted();
    const again = await send(h2);
    expect(again.status).toBe(first.status);
    expect(again.body).toEqual(first.body);
    const all = (await h2.request({ method: 'GET', path: '/v1/purchase/suppliers', userId: 'u-owner', tenantId: T })).body as { suppliers: { supplierId: string; status: string }[] };
    expect(all.suppliers.filter((s) => s.supplierId === 'sup-kav').map((s) => s.status)).toEqual(['proposed']);
  });

  it('WF-03: a purchase order whose reply was lost, sent again under the same key, is the same answer and one order counted once', async () => {
    const { first: h, restarted } = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await approvedSuppliers(h, T, 'sup-1');
    await deliveryPlaces(h, T, 'store-1');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    const body = { supplierId: 'sup-1', deliverToLocationId: 'store-1', lines: [{ productId: 'p1', orderedQty: 10, unitCost: { minor: 5000, currency: 'INR' } }] };
    const send = (hh: ApiHarness) => hh.request({ method: 'POST', path: '/v1/purchase/orders/po-lost', userId: 'u-mgr', tenantId: T, idempotencyKey: 'po-lost-1', body });
    const first = await send(h);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const h2 = restarted();
    const again = await send(h2);
    expect(again.status).toBe(first.status);
    expect(again.body).toEqual(first.body);
    // Approved once (its own reply lost too, and re-sent under the same key): one issued order, its value counted once.
    const approve = (hh: ApiHarness) => hh.request({ method: 'POST', path: '/v1/purchase/orders/po-lost/approval', userId: 'u-owner', tenantId: T, idempotencyKey: 'po-lost-appr', body: { reason: 'within budget' } });
    const issued = await approve(h2);
    expect(issued.status, JSON.stringify(issued.body)).toBe(200);
    expect((await approve(restarted())).body).toEqual(issued.body);
    const c = (await h2.request({ method: 'GET', path: '/v1/purchase/commitments', userId: 'u-owner', tenantId: T })).body as { commitments?: unknown[]; count?: number; totalOpenValue?: { minor: number } };
    const orders = (await h2.request({ method: 'GET', path: '/v1/purchase/orders', userId: 'u-owner', tenantId: T })).body as { orders: { poId: string }[] };
    expect(orders.orders.filter((o) => o.poId === 'po-lost')).toHaveLength(1);
    expect(JSON.stringify(c)).toContain('50000');
  });
});
