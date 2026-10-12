import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness } from '../support/api-harness';
import { approvedSuppliers, deliveryPlaces } from '../support/approved-supplier';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore, InMemoryEventStore, type EventStore, type BatchEntry } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';

/**
 * **Round 13 (verifier A4 · OB-63 · WF-03 · hard rule #10): a purchase-order amendment is judged on the order AS IT STANDS
 * when it lands.**
 *
 * The amendment route judged "does this raise the order?" on the copy it read, but the write re-read the order's guard on
 * every retry — so an amendment made from an OLDER copy was never judged again. Scenario (budget 100 000): po-a 60 000 and
 * po-b 30 000 are issued. Amendment am-2 is decided from po-a as it stood (12 units — "not raising", so not judged on the
 * budget). Before it lands, am-1 lowers po-a to 8 units and the freed budget is spent by po-c (30 000). Landing am-2 would
 * put po-a back to 12: committed 120 000 with no escalation. Now, on the real API (in memory and on real PostgreSQL):
 *   • am-2 is refused 409 `concurrent_change` naming the order — nothing changed, no override;
 *   • decided again on the order as it now stands, the same lines RAISE it and go through open-to-buy: over budget, it
 *     escalates (422 `over_budget_reason_required`); only the owner with a reason lands it, and the override is recorded;
 *   • a re-send of a landed amendment (fresh key) still collapses onto it (no second amendment).
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
const backings: { name: string; make: () => { store: EventStore; idempotency?: SqlIdempotencyStore } }[] = [{ name: 'the in-memory event store', make: () => ({ store: new InMemoryEventStore() }) }];
if (DATABASE_URL !== undefined) backings.push({ name: 'real PostgreSQL', make: () => { const sql = pgPoolClient(pool!); return { store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }; } });

type Res = { status: number; body: unknown };
const codeOf = (r: Res): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
const cost = (minor: number) => ({ minor, currency: 'INR' });

describe.each(backings)('Round 13 — an amendment is judged on the order as it stands — on $name', ({ make }) => {
  it('an amendment decided on an older copy is refused; judged again it raises the order and escalates on the budget', async () => {
    const { store, idempotency } = make();
    // Between am-2's read and its write, another person's change lands (deterministically, at am-2's write).
    let interleave: (() => Promise<void>) | undefined;
    const racing = new Proxy(store, {
      get(t, p, r) {
        if (p === 'appendBatch') {
          return async (tenantId: string, entries: readonly BatchEntry[], options?: unknown) => {
            if (interleave !== undefined && entries.some((e) => e.event.id === 'po-po-a-amended-am-2')) { const run = interleave; interleave = undefined; await run(); }
            return t.appendBatch(tenantId, entries, options as never);
          };
        }
        const v = Reflect.get(t, p, r); return typeof v === 'function' ? v.bind(t) : v;
      },
    }) as EventStore;
    const h = apiHarness({ store: racing, ...(idempotency === undefined ? {} : { idempotency }) });
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-buyer', 'store_manager');
    await approvedSuppliers(h, T, 'sup-1');
    await deliveryPlaces(h, T, 'store-1');
    const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, query?: Record<string, string>): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }), ...(method === 'GET' ? {} : { idempotencyKey: randomUUID() }) });
    const ok = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
    await ok(call('POST', '/v1/catalogue/tax-classes/1006/rates/2017-07-01', 'u-owner', { rateBps: 500 }), 'tax');
    await ok(call('POST', '/v1/catalogue/products/RICE/publish', 'u-owner', {
      product: { sku: 'SKU-RICE', name: 'RICE', baseUom: 'ea', primaryCategoryId: 'grocery', taxClass: '1006', lifecycle: 'active' },
      categories: [{ categoryId: 'grocery', name: 'Grocery', parentId: null }],
    }), 'publish');
    const month = new Date().toISOString().slice(0, 7);
    await ok(call('POST', '/v1/purchase/budgets', 'u-owner', { period: month, categoryId: 'grocery', amountMinor: 100_000, reason: 'October grocery plan' }), 'budget');
    const issued = async (poId: string, qty: number) => {
      await ok(call('POST', `/v1/purchase/orders/${poId}`, 'u-buyer', { supplierId: 'sup-1', deliverToLocationId: 'store-1', lines: [{ productId: 'RICE', orderedQty: qty, unitCost: cost(5_000) }] }), poId);
      await ok(call('POST', `/v1/purchase/orders/${poId}/approval`, 'u-owner', { reason: 'weekly replenishment' }), `approve ${poId}`);
    };
    const amend = (amendmentId: string, qty: number, extra: Record<string, unknown> = {}) =>
      call('POST', '/v1/purchase/orders/po-a/amendments', 'u-owner', { amendmentId, reason: 'supplier changed the fill', lines: [{ productId: 'RICE', orderedQty: qty, unitCost: cost(5_000) }], ...extra });
    const order = async () => ((await call('GET', '/v1/purchase/orders/po-a', 'u-owner')).body as { order: { lines: { orderedQty: number }[]; amendmentCount: number } }).order;
    const otb = async () => (await call('GET', '/v1/purchase/open-to-buy', 'u-owner', undefined, { period: month })).body as { categories: { categoryId: string; committedMinor: number; state: string }[]; overrides: { amendmentId?: string; reason: string }[] };
    const grocery = async () => (await otb()).categories.find((c) => c.categoryId === 'grocery')!;

    await issued('po-a', 12); // 60 000
    await issued('po-b', 6); // 30 000 — committed 90 000
    // am-2 is decided on po-a as it stands (12 units: "not raising", so not judged). Before it lands, am-1 lowers po-a to
    // 8 units and po-c spends what that freed.
    interleave = async () => {
      await ok(amend('am-1', 8), 'am-1 lowers');
      await ok(call('POST', '/v1/purchase/orders/po-c', 'u-buyer', { supplierId: 'sup-1', deliverToLocationId: 'store-1', lines: [{ productId: 'RICE', orderedQty: 6, unitCost: cost(5_000) }] }), 'po-c');
      await ok(call('POST', '/v1/purchase/orders/po-c/approval', 'u-owner', { reason: 'weekly replenishment' }), 'approve po-c');
    };
    const stale = await amend('am-2', 12);
    expect([stale.status, codeOf(stale)], JSON.stringify(stale.body)).toEqual([409, 'concurrent_change']);
    expect((stale.body as { error: { whatHappened: string } }).error.whatHappened).toContain('purchase order po-a');
    expect(interleave).toBeUndefined(); // the other change did land in between
    // Nothing changed by am-2: po-a stands at am-1's 8 units; the month is exactly at budget, no override.
    expect(await order()).toMatchObject({ amendmentCount: 1, lines: [{ orderedQty: 8 }] });
    expect(await grocery()).toMatchObject({ committedMinor: 100_000, state: 'within' });
    expect((await otb()).overrides).toEqual([]);

    // Decided again on the order as it now stands: the same lines RAISE it (+20 000) and are judged on open-to-buy.
    const again = await amend('am-2', 12);
    expect([again.status, codeOf(again)], JSON.stringify(again.body)).toEqual([422, 'over_budget_reason_required']);
    expect(await order()).toMatchObject({ amendmentCount: 1 });
    // The owner, with a reason: it lands, and the overrun is on the record.
    await ok(amend('am-2', 12, { overBudgetReason: 'supplier insists on full cases' }), 'am-2 with a reason');
    expect(await order()).toMatchObject({ amendmentCount: 2, lines: [{ orderedQty: 12 }] });
    expect(await grocery()).toMatchObject({ committedMinor: 120_000, state: 'over' });
    expect((await otb()).overrides).toEqual([expect.objectContaining({ amendmentId: 'am-2', reason: 'supplier insists on full cases' })]);
    // Re-sent (a lost reply, a fresh key): collapses onto the landed amendment — nothing applied twice.
    expect((await amend('am-2', 12, { overBudgetReason: 'supplier insists on full cases' })).status).toBe(200);
    expect(await order()).toMatchObject({ amendmentCount: 2 });
    expect((await otb()).overrides).toHaveLength(1);
  }, 60_000);
});
