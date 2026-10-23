import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { approvedSuppliers, deliveryPlaces } from '../support/approved-supplier';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';

/**
 * **M10-FR-04 "recall-block stops POS sale AND ORDERING" (Lane 2 · P1) — through the real API, in memory and on real
 * PostgreSQL, with a cold restart between the recall and the orders.**
 *
 * Before this, a product with a batch under open recall could be put on a purchase order, approved and sent to the
 * supplier the same afternoon: nothing on the buying side read the recall register. Now:
 *   • a NEW order naming a recalled product is refused, 409 `product_under_recall`, naming the product and the batch;
 *   • an order PROPOSED before the recall started is not ISSUED;
 *   • an amendment that ADDS or RAISES a recalled product is refused — lowering it is allowed (that is the remedy);
 *   • the product master's own recall-block flag stops ordering too ("stops sale AND purchase everywhere");
 *   • every refusal is sealed on the audit trail: who tried, which order, which products and batches;
 *   • when every recall on the product is closed with evidence, it can be ordered again.
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
const backings: { name: string; harness: () => ApiHarness; restart: (h: ApiHarness) => ApiHarness }[] = [
  { name: 'the in-memory event store', harness: () => apiHarness(), restart: (h) => apiHarness({ store: h.store }) },
];
if (DATABASE_URL !== undefined) {
  const pg = (): ApiHarness => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); };
  backings.push({ name: 'real PostgreSQL', harness: pg, restart: pg });
}

const cost = (minor: number) => ({ minor, currency: 'INR' });
const line = (productId: string, orderedQty: number) => ({ productId, orderedQty, unitCost: cost(6_000) });
type Res = { status: number; body: unknown };
type Refusal = { error: { code: string; whatHappened: string; wasItSaved: string; nextSafeAction: string } };
interface Trail { matches: { actorId: string; action: string; objectId: string; after: Record<string, string> | null; reason?: string }[] }

describe.each(backings)('M10-FR-04: a recalled product cannot be ordered — on $name', ({ harness, restart }) => {
  it('a new order, the approval of an older one, and a raising amendment are refused and audited; lowering is allowed; closed → orderable again', async () => {
    let h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await approvedSuppliers(h, T, 'sup-dairy');
    await deliveryPlaces(h, T, 'S1', 'WH');
    await h.provisionRole(T, 'u-buyer', 'store_manager');
    await h.provisionRole(T, 'u-cash', 'cashier');
    const req = (method: 'GET' | 'POST', path: string, body?: unknown, userId = 'u-owner', key = `k-${randomUUID()}`): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'POST' ? { idempotencyKey: key } : {}), ...(body === undefined ? {} : { body }) });
    const ok = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
    const order = (poId: string, lines: unknown[], key?: string) => req('POST', `/v1/purchase/orders/${poId}`, { supplierId: 'sup-dairy', deliverToLocationId: 'WH', lines }, 'u-buyer', key);

    // Batch B-1 of paneer is on the ledger — that is where head office names a recalled batch to its product.
    await ok(req('POST', '/v1/inventory/movements', { movementId: 'rx-B-1', productId: 'p-paneer', locationId: 'S1', kind: 'received', quantityMinor: 20, uom: 'EA', occurredAt: '2030-05-01T00:00:00.000Z', enteredBy: 'u-owner', batchId: 'B-1' }), 'receive B-1');
    // Before the recall: one order proposed (not yet issued), one issued with paneer on it.
    await ok(order('po-pre', [line('p-paneer', 10)], 'k-po-pre'), 'propose po-pre');
    await ok(order('po-issued', [line('p-paneer', 20), line('p-curd', 5)]), 'propose po-issued');
    await ok(req('POST', '/v1/purchase/orders/po-issued/approval', { reason: 'weekly dairy' }), 'issue po-issued');

    // The recall starts. Its reply lists the orders still open for the product (the buyer's list to cancel or hold).
    const started = (await ok(req('POST', '/v1/quality/recalls/B-1', { reason: 'supplier contamination notice SN-17' }), 'recall')).body as { openPurchaseOrders: { poId: string; status: string }[] };
    expect(started.openPurchaseOrders.map((o) => [o.poId, o.status])).toEqual([['po-issued', 'issued'], ['po-pre', 'proposed']]);

    h = restart(h); // ── COLD RESTART: the guard reads the recall from what is stored ──

    // 403 before anything else: a cashier never orders.
    expect((await req('POST', '/v1/purchase/orders/po-cash', { supplierId: 'sup-dairy', deliverToLocationId: 'WH', lines: [line('p-curd', 1)] }, 'u-cash')).status).toBe(403);

    // A NEW order naming the recalled product: refused, by name, nothing saved.
    const refused = await order('po-new', [line('p-curd', 3), line('p-paneer', 6)]);
    expect(refused.status).toBe(409);
    expect((refused.body as Refusal).error).toMatchObject({ code: 'product_under_recall', wasItSaved: 'not_saved' });
    expect((refused.body as Refusal).error.whatHappened).toMatch(/p-paneer \(batch B-1 under recall\)/);
    expect((refused.body as Refusal).error.whatHappened).not.toMatch(/p-curd/);
    expect((await req('GET', '/v1/purchase/orders/po-new')).status).toBe(404);
    // An order for something else goes through.
    await ok(order('po-curd', [line('p-curd', 3)]), 'curd only');
    // A replay of the order proposed before the recall is the same order, not a new one — its reply stands.
    expect(((await ok(order('po-pre', [line('p-paneer', 10)], 'k-po-pre'), 'replay')).body as { order: { status: string } }).order.status).toBe('proposed');

    // The order proposed BEFORE the recall is not issued.
    const notIssued = await req('POST', '/v1/purchase/orders/po-pre/approval', { reason: 'weekly dairy' });
    expect(notIssued.status).toBe(409);
    expect((notIssued.body as Refusal).error.code).toBe('product_under_recall');
    expect(((await req('GET', '/v1/purchase/orders/po-pre')).body as { order: { status: string } }).order.status).toBe('proposed');

    // An amendment that RAISES paneer, or ADDS it, is refused; one that LOWERS it is the remedy and goes through.
    const raise = await req('POST', '/v1/purchase/orders/po-issued/amendments', { amendmentId: 'am-up', reason: 'more', lines: [line('p-paneer', 30), line('p-curd', 5)] });
    expect(raise.status).toBe(409);
    const add = await req('POST', '/v1/purchase/orders/po-curd/amendments', { amendmentId: 'am-add', reason: 'add', lines: [line('p-curd', 3), line('p-paneer', 1)] });
    expect(add.status).toBe(409);
    // (po-curd is only proposed, so the route itself would refuse it as not issued — the recall answers first, by name.)
    expect((add.body as Refusal).error.code).toBe('product_under_recall');
    await ok(req('POST', '/v1/purchase/orders/po-issued/amendments', { amendmentId: 'am-down', reason: 'recall: cut paneer', lines: [line('p-paneer', 5), line('p-curd', 5)] }), 'lower paneer');

    // The product master's own recall flag stops ordering too.
    expect((await req('POST', '/v1/catalogue/tax-classes/04061000/rates/2017-07-01', { rateBps: 500 })).status).toBeLessThan(300);
    await ok(req('POST', '/v1/catalogue/products/p-ghee/publish', {
      product: { sku: 'SKU-GHEE', name: 'Ghee 500ml', baseUom: 'ea', primaryCategoryId: 'grocery', taxClass: '04061000', lifecycle: 'draft', recallBlocked: true },
      categories: [{ categoryId: 'grocery', name: 'Grocery', parentId: null }],
    }), 'ghee, recall-blocked on the master');
    const flagged = await order('po-ghee', [line('p-ghee', 4)]);
    expect(flagged.status).toBe(409);
    expect((flagged.body as Refusal).error.whatHappened).toMatch(/p-ghee \(the product itself is marked recall-blocked\)/);

    // Every refusal is sealed on the audit trail — who tried, which order, which products and batches, at which step.
    h = restart(h);
    const trail = (await ok(h.request({ method: 'GET', path: '/v1/audit/trail', userId: 'u-owner', tenantId: T, query: { action: 'purchase.order.refused_under_recall' } }), 'trail')).body as Trail;
    const refusals = trail.matches.filter((m) => m.action === 'purchase.order.refused_under_recall');
    expect(refusals.map((m) => [m.actorId, m.objectId, m.after?.['step'], m.after?.['products'], m.after?.['batches']]).sort()).toEqual([
      ['u-buyer', 'po-ghee', 'propose', 'p-ghee', ''],
      ['u-buyer', 'po-new', 'propose', 'p-paneer', 'B-1'],
      ['u-owner', 'po-curd', 'amend', 'p-paneer', 'B-1'],
      ['u-owner', 'po-issued', 'amend', 'p-paneer', 'B-1'],
      ['u-owner', 'po-pre', 'approve', 'p-paneer', 'B-1'],
    ]);
    expect(refusals.every((m) => m.reason === 'M10-FR-04: a recall block stops ordering')).toBe(true);

    // Closed with evidence: paneer can be ordered, and the older order issued.
    await ok(req('POST', '/v1/quality/recalls/B-1/closure', { evidenceRef: 'DOC-recall-B-1' }), 'close recall');
    h = restart(h);
    await ok(order('po-after', [line('p-paneer', 6)]), 'paneer again');
    expect(((await ok(req('POST', '/v1/purchase/orders/po-pre/approval', { reason: 'recall closed' }), 'issue po-pre')).body as { order: { status: string } }).order.status).toBe('issued');
  }, 120_000);
});
