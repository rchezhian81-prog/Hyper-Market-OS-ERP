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
 * **P2 · batch 18c — a proposed purchase order is REJECTED, SENT BACK (then changed and resubmitted) or WITHDRAWN before it
 * is issued (M06-FR-02 · pilot audit B-6 · OB-871) — through the real API, in memory and on real PostgreSQL, with a cold
 * restart in the middle.**
 *
 *   • the raiser cannot reject or send back their own order (§28); a second person can, only with a reason;
 *   • a sent-back order cannot be issued; its raiser changes a quantity and resubmits it — it waits again, re-valued;
 *   • a rejected order has ended: it cannot be issued, withdrawn or resubmitted; a withdrawn one likewise;
 *   • only the raiser withdraws; an issued order is untouched (its cancellation already exists);
 *   • every step is on the order's record and on the audit trail with who, when and why.
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

type Res = { status: number; body: unknown };
interface Order { poId: string; status: string; totalMinor: number; lines: { productId: string; orderedQty: number; unitCost: { minor: number } }[]; proposalSteps?: { step: string; by: string; reason: string; at: string }[]; documentNumber?: string }
interface Trail { matches: { actorId: string; action: string; objectId: string; after: Record<string, string> | null; reason?: string }[] }

describe.each(backings)('P2: a waiting purchase order is rejected, sent back or withdrawn — on $name', ({ harness, restart }) => {
  it('every step needs the right person and a reason, is final where it should be, and is on the record and the audit trail', async () => {
    let h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await approvedSuppliers(h, T, 'sup-1');
    await deliveryPlaces(h, T, 'S1', 'WH');
    await h.provisionRole(T, 'u-buyer', 'store_manager');
    const req = (method: 'GET' | 'POST', path: string, body?: unknown, userId = 'u-owner'): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'POST' ? { idempotencyKey: `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }) });
    const ok = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
    const code = (r: Res): string => (r.body as { error?: { code: string } }).error?.code ?? '';
    const order = async (poId: string): Promise<Order> => ((await ok(req('GET', `/v1/purchase/orders/${poId}`), 'read')).body as { order: Order }).order;
    const raise = (poId: string) => ok(req('POST', `/v1/purchase/orders/${poId}`, { supplierId: 'sup-1', deliverToLocationId: 'S1', lines: [
      { productId: 'p-rice', orderedQty: 10, unitCost: { minor: 5_000, currency: 'INR' } },
      { productId: 'p-dal', orderedQty: 4, unitCost: { minor: 12_000, currency: 'INR' } },
    ] }, 'u-buyer'), `raise ${poId}`);

    await raise('po-a');
    expect((await order('po-a')).documentNumber).toMatch(/^PO\/\d\d-\d\d\/\d{5}$/);

    // The store manager may not decide orders at all; and a person who may decide orders cannot decide their own.
    expect((await req('POST', '/v1/purchase/orders/po-a/rejection', { reason: 'no' }, 'u-buyer')).status).toBe(403);
    await ok(req('POST', '/v1/purchase/orders/po-own', { supplierId: 'sup-1', deliverToLocationId: 'S1', lines: [{ productId: 'p-rice', orderedQty: 1, unitCost: { minor: 5_000, currency: 'INR' } }] }), 'owner raises');
    expect(code(await req('POST', '/v1/purchase/orders/po-own/rejection', { reason: 'no' }))).toBe('proposer_cannot_decide');
    expect(code(await req('POST', '/v1/purchase/orders/po-own/send-back', { reason: 'no' }))).toBe('proposer_cannot_decide');
    await ok(req('POST', '/v1/purchase/orders/po-own/withdrawal', { reason: 'raised to test' }), 'owner withdraws his own');
    // A second person needs a note.
    expect(code(await req('POST', '/v1/purchase/orders/po-a/send-back', {}))).toBe('reason_required');
    expect((await order('po-a')).status).toBe('proposed');

    // Sent back with a note: it cannot be issued until resubmitted.
    const back = (await ok(req('POST', '/v1/purchase/orders/po-a/send-back', { reason: 'Rice is 6 bags too many — we still have stock' }), 'send back')).body as { order: Order };
    expect(back.order.status).toBe('sent_back');
    expect(code(await req('POST', '/v1/purchase/orders/po-a/approval', { reason: 'ok' }))).toBe('purchase_order_not_waiting');
    // Only the raiser resubmits.
    expect(code(await req('POST', '/v1/purchase/orders/po-a/resubmission', { reason: 'cut rice' }))).toBe('only_the_raiser');
    // A new item on a resubmission is refused — a new item needs a new order.
    expect(code(await req('POST', '/v1/purchase/orders/po-a/resubmission', { reason: 'add oil', lines: [{ productId: 'p-oil', orderedQty: 1 }] }, 'u-buyer'))).toBe('not_readable_as_resubmitted_lines');

    h = restart(h); // ── COLD RESTART: the steps are read back from what is stored ──

    const re = (await ok(req('POST', '/v1/purchase/orders/po-a/resubmission', { reason: 'Rice cut to 4 bags', lines: [{ productId: 'p-rice', orderedQty: 4 }] }, 'u-buyer'), 'resubmit')).body as { order: Order };
    expect(re.order.status).toBe('proposed');
    let a = await order('po-a');
    expect(a.status).toBe('proposed');
    expect(a.lines.map((l) => [l.productId, l.orderedQty])).toEqual([['p-rice', 4], ['p-dal', 4]]);
    expect(a.totalMinor).toBe(4 * 5_000 + 4 * 12_000);
    expect(a.proposalSteps?.map((s) => [s.step, s.by, s.reason])).toEqual([
      ['sent_back', 'u-owner', 'Rice is 6 bags too many — we still have stock'],
      ['resubmitted', 'u-buyer', 'Rice cut to 4 bags'],
    ]);

    // Rejected: the order has ended.
    expect(code(await req('POST', '/v1/purchase/orders/po-a/rejection', {}))).toBe('reason_required');
    await ok(req('POST', '/v1/purchase/orders/po-a/rejection', { reason: 'Supplier price is higher than the market this week' }), 'reject');
    a = await order('po-a');
    expect(a.status).toBe('rejected');
    expect(code(await req('POST', '/v1/purchase/orders/po-a/approval', { reason: 'ok' }))).toBe('purchase_order_not_waiting');
    expect(code(await req('POST', '/v1/purchase/orders/po-a/withdrawal', { reason: 'x' }, 'u-buyer'))).toBe('purchase_order_not_waiting');
    expect(code(await req('POST', '/v1/purchase/orders/po-a/resubmission', { reason: 'x' }, 'u-buyer'))).toBe('purchase_order_not_waiting');
    // A re-sent rejection says it is already done, adding nothing.
    expect(((await ok(req('POST', '/v1/purchase/orders/po-a/rejection', { reason: 'again' }), 'again')).body as { already?: boolean }).already).toBe(true);
    expect((await order('po-a')).proposalSteps).toHaveLength(3);

    // Withdrawn by the raiser only.
    await raise('po-b');
    expect(code(await req('POST', '/v1/purchase/orders/po-b/withdrawal', { reason: 'x' }))).toBe('only_the_raiser');
    expect(code(await req('POST', '/v1/purchase/orders/po-b/withdrawal', {}, 'u-buyer'))).toBe('reason_required');
    await ok(req('POST', '/v1/purchase/orders/po-b/withdrawal', { reason: 'Raised twice by mistake' }, 'u-buyer'), 'withdraw');
    expect((await order('po-b')).status).toBe('withdrawn');
    expect(code(await req('POST', '/v1/purchase/orders/po-b/approval', { reason: 'ok' }))).toBe('purchase_order_not_waiting');
    expect(code(await req('POST', '/v1/purchase/orders/po-b/rejection', { reason: 'ok' }))).toBe('purchase_order_not_waiting');

    // A sent-back order may also be withdrawn by its raiser.
    await raise('po-c');
    await ok(req('POST', '/v1/purchase/orders/po-c/send-back', { reason: 'check the dal price' }), 'send back c');
    await ok(req('POST', '/v1/purchase/orders/po-c/withdrawal', { reason: 'not needed after all' }, 'u-buyer'), 'withdraw c');
    expect((await order('po-c')).status).toBe('withdrawn');

    // An issued order is untouched: it is cancelled instead.
    await raise('po-d');
    await ok(req('POST', '/v1/purchase/orders/po-d/approval', { reason: 'weekly' }), 'issue d');
    const r = await req('POST', '/v1/purchase/orders/po-d/rejection', { reason: 'late' });
    expect(code(r)).toBe('purchase_order_not_waiting');
    expect((r.body as { error: { whatHappened: string } }).error.whatHappened).toMatch(/cancelled instead/);
    expect((await order('po-d')).status).toBe('issued');

    // Rejected and withdrawn orders are not counted as waiting.
    const list = (await ok(req('GET', '/v1/purchase/orders'), 'list')).body as { awaitingApprovalCount: number };
    expect(list.awaitingApprovalCount).toBe(0);

    // The audit trail: who, when and why, for every step.
    const trail = async (action: string) => ((await ok(h.request({ method: 'GET', path: '/v1/audit/trail', userId: 'u-owner', tenantId: T, query: { action } }), action)).body as Trail).matches;
    expect((await trail('purchase.order.send_back')).map((m) => [m.objectId, m.actorId, m.reason])).toEqual(expect.arrayContaining([
      ['po-a', 'u-owner', 'Rice is 6 bags too many — we still have stock'], ['po-c', 'u-owner', 'check the dal price'],
    ]));
    expect((await trail('purchase.order.resubmit')).map((m) => [m.objectId, m.actorId, m.reason, m.after?.['totalMinor']])).toEqual([['po-a', 'u-buyer', 'Rice cut to 4 bags', '68000']]);
    expect((await trail('purchase.order.reject')).map((m) => [m.objectId, m.actorId, m.reason])).toEqual([['po-a', 'u-owner', 'Supplier price is higher than the market this week']]);
    expect((await trail('purchase.order.withdraw')).map((m) => [m.objectId, m.actorId]).sort()).toEqual([['po-b', 'u-buyer'], ['po-c', 'u-buyer'], ['po-own', 'u-owner']]);
  }, 120_000);
});
