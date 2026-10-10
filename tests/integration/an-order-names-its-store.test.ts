import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { approvedSuppliers } from '../support/approved-supplier';
import { makeEvent } from '../../packages/contracts/src/event';
import { STREAM } from '../../services/api/src/adapters';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';

/**
 * **OB-37 "A" (owner, 10 Oct 2026) — every purchase order names the store it is delivered to (M06-FR-02 · M07-FR-01 ·
 * PA-01-r1 · P-08).**
 *
 *   • a new order without a store, or naming a place the organisation does not have, is refused by name — nothing recorded;
 *   • a buyer granted only store A cannot raise an order for store B (Batch 1's branch rule);
 *   • a receipt against the order is booked at that store or a place under it — anywhere else is refused by name;
 *   • a store's open deliveries (issued, not fully received) read back for the warehouse phone / store pack;
 *   • an order recorded before the rule (no store) is listed as "store not named", never guessed into a store, and a receipt
 *     against it is received and SAYS `order_store_not_named`.
 * In-memory and, with DATABASE_URL, real PostgreSQL. Synthetic data only.
 */

type Body = Record<string, unknown>;
const codeOf = (r: { body: unknown }): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
const cost = { minor: 2_000, currency: 'INR' };

async function shop(h: ApiHarness, t: string) {
  // A buyer granted one store acts AT that store (the branch their session is for).
  const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, key?: string, query?: Readonly<Record<string, string>>) =>
    h.request({ method, path, userId, tenantId: t, ...(userId === 'u-buyer-a' ? { branchId: 'S-A' } : {}), ...(body === undefined ? {} : { body }), ...(key === undefined ? {} : { idempotencyKey: key }), ...(query === undefined ? {} : { query }) });
  await h.seedOwner(t, 'u-owner');
  await h.provisionRole(t, 'u-buyer', 'store_manager');
  await h.provisionRole(t, 'u-recv', 'store_manager');
  await h.provisionRole(t, 'u-buyer-a', 'store_manager', ['S-A']); // granted store A only
  await approvedSuppliers(h, t, 'sup-1');
  const node = async (id: string, body: Body) => expect((await call('POST', `/v1/org/nodes/${id}`, 'u-owner', body, `org-${id}`)).status).toBe(201);
  await node('C1', { kind: 'company', name: 'SRE Retail' });
  await node('S-A', { kind: 'branch', name: 'Store A', parentId: 'C1', companyId: 'C1' });
  await node('S-A-BACK', { kind: 'warehouse', name: 'Store A back store', parentId: 'S-A', companyId: 'C1' });
  await node('S-B', { kind: 'branch', name: 'Store B', parentId: 'C1', companyId: 'C1' });
  expect((await call('POST', '/v1/inventory/receipt-policy', 'u-owner', { excessToleranceBp: 0, shortageToleranceBp: 0, nearExpiryDays: 7 }, 'pol')).status).toBe(201);
  const order = (poId: string, extra: Body, userId = 'u-buyer') => call('POST', `/v1/purchase/orders/${poId}`, userId, { supplierId: 'sup-1', lines: [{ productId: 'p1', orderedQty: 10, unitCost: cost }], ...extra }, `po-${poId}`);
  const issue = async (poId: string) => expect((await call('POST', `/v1/purchase/orders/${poId}/approval`, 'u-owner', { reason: 'ok' }, `po-${poId}-ok`)).status).toBe(200);
  const receive = (grnId: string, poId: string, warehouseId: string, counted: number) => call('POST', `/v1/inventory/goods-receipt/${grnId}`, 'u-recv', {
    warehouseId, receivedOnDate: '2026-10-10', currency: 'INR', poId,
    lines: [{ lineId: 'L1', productId: 'p1', orderedMinor: 10, countedMinor: counted, uom: 'ea', unitCost: cost, condition: 'good' }],
  }, grnId);
  return { call, order, issue, receive };
}

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

describe.each(backings)('OB-37 — an order names the store it is delivered to — on $name', ({ harness }) => {
  it('refuses an order with no store, an unknown place, or a store outside the buyer\'s branches; receipts only at that store; a store\'s open deliveries read back', async () => {
    const h = harness();
    const t = randomUUID();
    const s = await shop(h, t);

    expect(codeOf(await s.order('po-none', {}))).toBe('deliver_to_store_required');
    expect(codeOf(await s.order('po-nowhere', { deliverToLocationId: 'S-Z' }))).toBe('unknown_location');
    expect(codeOf(await s.order('po-company', { deliverToLocationId: 'C1' }))).toBe('unknown_location');
    const outside = await s.order('po-b-by-a', { deliverToLocationId: 'S-B' }, 'u-buyer-a');
    expect(outside.status).toBe(403);
    for (const poId of ['po-none', 'po-nowhere', 'po-b-by-a']) expect((await s.call('GET', `/v1/purchase/orders/${poId}`, 'u-owner')).status).toBe(404);

    const a = await s.order('po-a', { deliverToLocationId: 'S-A' }, 'u-buyer-a');
    expect(a.status).toBe(201);
    expect(a.body).toMatchObject({ order: { deliverToLocationId: 'S-A' } });
    await s.issue('po-a');
    expect((await s.order('po-b', { deliverToLocationId: 'S-B' })).status).toBe(201);
    await s.issue('po-b');

    // Booked in at store B against an order for store A: refused by name, nothing received.
    const wrong = await s.receive('grn-wrong', 'po-a', 'S-B', 6);
    expect(wrong.status).toBe(422);
    expect(codeOf(wrong)).toBe('receipt_not_at_order_store');
    expect((await s.call('GET', '/v1/inventory/goods-receipt/grn-wrong', 'u-owner')).status).toBe(404);
    // At store A's back store: received; 4 still to come.
    expect((await s.receive('grn-a1', 'po-a', 'S-A-BACK', 6)).status).toBe(201);

    const open = await s.call('GET', '/v1/purchase/deliveries/open', 'u-owner', undefined, undefined, { storeId: 'S-A' });
    expect(open.status).toBe(200);
    expect(open.body).toMatchObject({ storeId: 'S-A', count: 1, deliveries: [{ poId: 'po-a', deliverToLocationId: 'S-A', supplierId: 'sup-1', lines: [{ productId: 'p1', orderedQty: 10, receivedQty: 6, openQty: 4 }] }] });
    // Store A's buyer cannot read store B's deliveries.
    expect((await s.call('GET', '/v1/purchase/deliveries/open', 'u-buyer-a', undefined, undefined, { storeId: 'S-B' })).status).toBe(403);
    // Fully received → no longer open.
    expect((await s.receive('grn-a2', 'po-a', 'S-A', 4)).status).toBe(201);
    expect((await s.call('GET', '/v1/purchase/deliveries/open', 'u-owner', undefined, undefined, { storeId: 'S-A' })).body).toMatchObject({ count: 0, deliveries: [] });
  }, 60_000);

  it('an order recorded before the rule is listed as "store not named" — never guessed — and a receipt against it says so', async () => {
    const h = harness();
    const t = randomUUID();
    const s = await shop(h, t);
    // A legacy order as the register held it before OB-37: proposed and issued with no store.
    const legacy = { poId: 'po-old', number: 'po-old', supplierId: 'sup-1', requisitionedBy: 'u-buyer', at: '2026-10-01T09:00:00.000Z', lines: [{ productId: 'p1', orderedQty: 10, unitCost: cost }], totalMinor: 20_000, currency: 'INR', status: 'proposed', approvedBy: null, issuedAt: null, receivedByProduct: {}, cancelledByProduct: {}, amendmentCount: 0 };
    await h.store.append(t, [STREAM.purchase, 'orders'].join('\u001f') /* the purchase-orders stream, as the adapter names it */, makeEvent({ id: 'legacy-po', type: 'PurchaseOrderProposed', occurredAt: legacy.at, idempotencyKey: `legacy-po-${t}`, source: 'test/legacy', payload: legacy }));
    await s.issue('po-old');
    const list = (await s.call('GET', '/v1/purchase/orders', 'u-owner')).body as { orders: { poId: string; deliverTo: string }[]; storeNotNamedCount: number };
    expect(list.orders.find((o) => o.poId === 'po-old')).toMatchObject({ deliverTo: 'store_not_named' });
    expect(list.storeNotNamedCount).toBe(1);
    const open = (await s.call('GET', '/v1/purchase/deliveries/open', 'u-owner', undefined, undefined, { storeId: 'S-A' })).body as { deliveries: unknown[]; storeNotNamed: { poId: string }[] };
    expect(open.deliveries).toEqual([]);
    expect(open.storeNotNamed).toEqual([expect.objectContaining({ poId: 'po-old', deliverTo: 'store_not_named' })]);
    const got = await s.receive('grn-old', 'po-old', 'S-A', 10);
    expect(got.status).toBe(201);
    expect((got.body as { grn: { governanceFlags: string[] } }).grn.governanceFlags).toContain('order_store_not_named');
  }, 60_000);
});
