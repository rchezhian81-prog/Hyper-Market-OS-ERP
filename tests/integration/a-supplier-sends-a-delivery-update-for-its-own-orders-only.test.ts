import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { approvedSuppliers, deliveryPlaces } from '../support/approved-supplier';
import { InMemoryEventStore, SqlEventStore, type EventStore } from '../../packages/persistence/src/event-store';
import { MemoryIdempotencyStore, SqlIdempotencyStore, type IdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { runMigrations } from '../../packages/persistence/src/migrations';

/**
 * **OB-362 (owner, 24–25 Oct 2026, in writing): a "Delivery update" form in the supplier app, for the supplier's OWN orders
 * only, sending the existing `delivery_status` submission.**
 *
 * On the real API (in memory and, with DATABASE_URL, on real PostgreSQL with a cold restart):
 *   • `GET /v1/supplier-portal/me/orders` lists the supplier's own OPEN orders (issued, not all received) and no other
 *     supplier's; an order not yet issued is not there; whether the login may send an update is said;
 *   • asking for another supplier's orders is refused AND recorded as a probe; a login without the read grant is refused;
 *   • the update for one of its own orders is taken and the buyer reads it; one naming another supplier's order is refused;
 *   • after a cold restart the order list and the update read back the same.
 * Synthetic data only.
 */

const codeOf = (r: { body: unknown }): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
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
const inDays = (n: number): string => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

describe.each(backings)('OB-362 — a supplier sends a delivery update for its own orders only, on $name', ({ name, stores }) => {
  it('lists its own open orders; refuses another\'s (recorded); takes the update for its own; a restart reads it back', async () => {
    const backing = stores();
    let h: ApiHarness = apiHarness(backing);
    const t = randomUUID();
    const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, query?: Readonly<Record<string, string>>) =>
      h.request({ method, path, userId, tenantId: t, ...(body === undefined ? {} : { body }), ...(method === 'GET' ? {} : { idempotencyKey: `${path}-${userId}-${randomUUID()}` }), ...(query === undefined ? {} : { query }) });
    const ok = async (p: ReturnType<typeof call>, what: string) => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
    await h.seedOwner(t, 'u-owner');
    await h.provisionRole(t, 'u-buyer', 'store_manager');
    for (const u of ['u-sup', 'u-supb', 'u-sup-view']) await h.provisionRole(t, u, 'supplier');
    await approvedSuppliers(h, t, 'sup-a', 'sup-b');
    await deliveryPlaces(h, t, 'S1', 'S1-BACK');
    await ok(call('POST', '/v1/catalogue/products/p-oil/publish', 'u-owner', {
      product: { sku: 'p-oil', name: 'Oil 1L', baseUom: 'ea', primaryCategoryId: 'grocery', taxClass: '1507', lifecycle: 'active', handling: 'ambient' },
      categories: [{ categoryId: 'grocery', name: 'Grocery', parentId: null }],
    }), 'publish');
    // sup-a: po-a1 issued, po-a2 only proposed (not issued — not its order to update yet). sup-b: po-b issued.
    for (const [po, supplier, issue] of [['po-a1', 'sup-a', true], ['po-a2', 'sup-a', false], ['po-b', 'sup-b', true]] as const) {
      await ok(call('POST', `/v1/purchase/orders/${po}`, 'u-buyer', { supplierId: supplier, deliverToLocationId: 'S1', lines: [{ productId: 'p-oil', orderedQty: 12, unitCost: { minor: 1_800, currency: 'INR' } }] }), po);
      if (issue) await ok(call('POST', `/v1/purchase/orders/${po}/approval`, 'u-owner', { reason: 'ok' }), `${po} approval`);
    }
    await ok(call('POST', '/v1/supplier-portal/partners/sup-a', 'u-buyer', { grants: ['view_orders', 'acknowledge_orders'], documents: [], requiredDocuments: [], logins: ['u-sup'] }), 'cfg a');
    await ok(call('POST', '/v1/supplier-portal/partners/sup-b', 'u-buyer', { grants: ['view_orders', 'acknowledge_orders'], documents: [], requiredDocuments: [], logins: ['u-supb'] }), 'cfg b');

    // ── 1 · Its own open orders, and only them; whether it may send an update.
    const mine = (await ok(call('GET', '/v1/supplier-portal/me/orders', 'u-sup'), 'my orders')).body as { partnerId: string; ordersKnown: boolean; mayUpdate: boolean; orders: { poId: string; number: string; issuedAt: string | null; deliverToLocationId: string | null }[]; deliveryStatuses: string[] };
    expect(mine).toMatchObject({ partnerId: 'sup-a', ordersKnown: true, mayUpdate: true, deliveryStatuses: ['dispatched', 'in_transit', 'delayed'] });
    expect(mine.orders.map((o) => o.poId)).toEqual(['po-a1']);
    expect(mine.orders[0]).toMatchObject({ deliverToLocationId: 'S1' });
    expect(JSON.stringify(mine)).not.toMatch(/1800|unitCost|totalMinor/); // the order, never its costs
    expect(((await ok(call('GET', '/v1/supplier-portal/me/orders', 'u-supb'), 'b orders')).body as { orders: { poId: string }[] }).orders.map((o) => o.poId)).toEqual(['po-b']);

    // ── 2 · Another supplier's orders: refused and recorded as a probe. A buyer (no portal login) is no supplier.
    const probe = await call('GET', '/v1/supplier-portal/me/orders', 'u-sup', undefined, { partnerId: 'sup-b' });
    expect(probe.status).toBe(403);
    expect(codeOf(probe)).toBe('not_your_data');
    // Recorded: three distinct probes make the pattern the buyer's probing list surfaces.
    for (const other of ['sup-c', 'sup-d']) expect((await call('GET', '/v1/supplier-portal/me/orders', 'u-sup', undefined, { partnerId: other })).status).toBe(403);
    const probing = (await ok(call('GET', '/v1/supplier-portal/probing', 'u-buyer'), 'probing')).body as { count: number };
    expect(probing.count, JSON.stringify(probing)).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(probing)).toContain('sup-a');
    expect((await call('GET', '/v1/supplier-portal/me/orders', 'u-buyer')).status).toBe(403);
    // A supplier login bound to no partner is not a supplier login.
    expect(codeOf(await call('GET', '/v1/supplier-portal/me/orders', 'u-sup-view'))).toBe('not_a_supplier_login');

    // ── 3 · The update for its own order is taken; the buyer reads it. Another supplier's order is refused by name.
    const update = { submissionId: 'ds-po-a1-1', kind: 'delivery_status', document: { poId: 'po-a1', status: 'in_transit', expectedOn: inDays(2), note: 'lorry left at 6' } };
    const sent = await ok(call('POST', '/v1/supplier-portal/me/submissions', 'u-sup', update), 'update');
    expect(sent.body).toMatchObject({ kind: 'delivery_status', accepted: true });
    const theirs = await call('POST', '/v1/supplier-portal/me/submissions', 'u-sup', { submissionId: 'ds-po-b-1', kind: 'delivery_status', document: { poId: 'po-b', status: 'delayed', expectedOn: inDays(3) } });
    expect(theirs.status).toBe(422);
    expect(codeOf(theirs)).toBe('not_your_order');
    const buyerView = JSON.stringify((await ok(call('GET', '/v1/supplier-portal/partners/sup-a/submissions', 'u-buyer'), 'buyer reads')).body);
    expect(buyerView).toContain('lorry left at 6');

    // ── 4 · Cold restart: the order list and the update read back the same.
    h = apiHarness(name === 'real PostgreSQL' ? stores() : backing);
    expect(((await ok(call('GET', '/v1/supplier-portal/me/orders', 'u-sup'), 'after restart')).body as { orders: { poId: string }[] }).orders.map((o) => o.poId)).toEqual(['po-a1']);
    const subs = (await ok(call('GET', '/v1/supplier-portal/me/submissions', 'u-sup'), 'my submissions')).body as { submissions: { submissionId: string; kind: string }[] };
    expect(subs.submissions.map((s) => `${s.submissionId}:${s.kind}`)).toEqual(['ds-po-a1-1:delivery_status']);
  }, 60_000);
});
