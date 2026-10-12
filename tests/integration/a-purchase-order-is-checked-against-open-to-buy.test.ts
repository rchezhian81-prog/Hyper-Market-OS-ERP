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
import { gateApprovalOnBudget, type OpenToBuyDeps } from '../../services/purchase/src/open-to-buy';
import type { StoredPurchaseOrder } from '../../services/purchase/src/purchase-orders';

/**
 * **WF-03 · D02-FR-01 · D03-FR-01 — the budget step of purchase planning (round 8).** On the real API, in memory and — with
 * DATABASE_URL — on real PostgreSQL: the owner sets category budgets for a month (a new figure supersedes, the old stays on
 * record); every proposed order carries its open-to-buy check (committed = issued orders raised that month net of
 * cancellations; waiting = proposed, shown apart); an order over budget is NOT refused at proposal but ESCALATES at approval
 * (M06-FR-01 "PO above limit escalates") — issued only by a person allowed to exceed the budget, with an over-budget reason,
 * recorded; a store's own budget governs its orders before the company's; a category with no budget is said, not hidden.
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

type Res = { status: number; body: unknown };
const codeOf = (r: Res): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
const cost = (minor: number) => ({ minor, currency: 'INR' });
interface Cat { categoryId: string; state: string; budgetMinor: number | null; committedMinor: number; waitingMinor: number; thisOrderMinor?: number; remainingAfterMinor?: number | null; openToBuyMinor?: number | null; budgetScope?: string | null }

describe.each(backings)('a purchase order is checked against open-to-buy — on $name (WF-03 · D02-FR-01)', ({ harness }) => {
  it('budgets per category and month; within proceeds; over escalates to the owner with a reason; a store budget governs its orders', async () => {
    const h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-buyer', 'store_manager');
    await approvedSuppliers(h, T, 'sup-1');
    await deliveryPlaces(h, T, 'store-1');
    await deliveryPlaces(h, T, 'store-2');
    const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, key?: string, query?: Record<string, string>): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }), ...(method === 'GET' ? {} : { idempotencyKey: key ?? `${path}-${JSON.stringify(body)}` }) });
    const ok = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
    // Products with their departments in the product master; MYSTERY has none on file.
    await ok(call('POST', '/v1/catalogue/tax-classes/1006/rates/2017-07-01', 'u-owner', { rateBps: 500 }, 'tax'), 'tax');
    for (const [p, cat] of [['RICE', 'grocery'], ['OIL', 'grocery'], ['SOAP', 'home']] as const) {
      await ok(call('POST', `/v1/catalogue/products/${p}/publish`, 'u-owner', {
        product: { sku: `SKU-${p}`, name: p, baseUom: 'ea', primaryCategoryId: cat, taxClass: '1006', lifecycle: 'active' },
        categories: [{ categoryId: 'grocery', name: 'Grocery', parentId: null }, { categoryId: 'home', name: 'Home care', parentId: null }],
      }, `pub-${p}`), `publish ${p}`);
    }
    const month = new Date().toISOString().slice(0, 7);
    const budget = (body: Record<string, unknown>, key: string, u = 'u-owner') => call('POST', '/v1/purchase/budgets', u, { period: month, ...body }, key);
    const order = (poId: string, lines: unknown[], to = 'store-1') => call('POST', `/v1/purchase/orders/${poId}`, 'u-buyer', { supplierId: 'sup-1', deliverToLocationId: to, lines }, `po-${poId}`);
    const approve = (poId: string, extra: Record<string, unknown> = {}, key = `ap-${poId}`) => call('POST', `/v1/purchase/orders/${poId}/approval`, 'u-owner', { reason: 'weekly replenishment', ...extra }, key);
    const otb = async (storeId?: string) => (await call('GET', '/v1/purchase/open-to-buy', 'u-owner', undefined, undefined, { period: month, ...(storeId === undefined ? {} : { storeId }) })).body as { categories: Cat[]; overrides: { poId: string; approvedBy: string; reason: string; overByMinor: number }[] };

    // ── BUDGETS: the owner's figures; a store manager cannot set one; a bad month is refused ─────────────────────────
    expect((await budget({ categoryId: 'grocery', amountMinor: 100_000, reason: 'October grocery plan' }, 'b-x', 'u-buyer')).status).toBe(403);
    expect(codeOf(await call('POST', '/v1/purchase/budgets', 'u-owner', { categoryId: 'grocery', period: '2026-13', amountMinor: 1, reason: 'x' }, 'b-bad'))).toBe('not_readable_as_a_purchase_budget');
    await ok(budget({ categoryId: 'grocery', amountMinor: 100_000, reason: 'October grocery plan' }, 'b-g'), 'grocery budget');
    await ok(budget({ categoryId: 'home', amountMinor: 50_000, reason: 'October home-care plan' }, 'b-h'), 'home budget');
    await ok(budget({ categoryId: 'home', storeId: 'store-1', amountMinor: 10_000, reason: 'store 1 home-care cap' }, 'b-h1'), 'store-1 home budget');

    // ── WITHIN: the order carries its check; approval proceeds as ever ───────────────────────────────────────────────
    const p1 = await ok(order('po-1', [{ productId: 'RICE', orderedQty: 10, unitCost: cost(4_000) }, { productId: 'OIL', orderedQty: 2, unitCost: cost(10_000) }]), 'po-1');
    expect((p1.body as { order: { budgetCheck: { overBudget: boolean; categories: Cat[] } } }).order.budgetCheck).toMatchObject({ overBudget: false, categories: [{ categoryId: 'grocery', state: 'within', budgetMinor: 100_000, committedMinor: 0, thisOrderMinor: 60_000, remainingAfterMinor: 40_000 }] });
    expect((await otb()).categories.find((c) => c.categoryId === 'grocery')).toMatchObject({ committedMinor: 0, waitingMinor: 60_000, openToBuyMinor: 100_000, state: 'within' });
    await ok(approve('po-1'), 'approve po-1');
    expect((await otb()).categories.find((c) => c.categoryId === 'grocery')).toMatchObject({ committedMinor: 60_000, waitingMinor: 0, openToBuyMinor: 40_000 });

    // ── OVER: proposed (never refused at the desk), escalated at approval: no reason → refused; with one → issued, recorded ──
    const p2 = await ok(order('po-2', [{ productId: 'RICE', orderedQty: 10, unitCost: cost(5_000) }]), 'po-2');
    expect((p2.body as { order: { budgetCheck: { overBudget: boolean; overByMinor: number } } }).order.budgetCheck).toMatchObject({ overBudget: true, overByMinor: 10_000 });
    const noReason = await approve('po-2');
    expect(noReason.status).toBe(422);
    expect(codeOf(noReason)).toBe('over_budget_reason_required');
    expect(((await call('GET', '/v1/purchase/orders/po-2', 'u-owner')).body as { order: { status: string } }).order.status).toBe('proposed');
    const over = await ok(approve('po-2', { overBudgetReason: 'Diwali stock-up agreed with the buyer' }, 'ap-po-2-ok'), 'approve over budget');
    expect(over.body).toMatchObject({ order: { status: 'issued' }, budgetAtApproval: { overBudget: true, overByMinor: 10_000 } });
    const view = await otb();
    expect(view.categories.find((c) => c.categoryId === 'grocery')).toMatchObject({ committedMinor: 110_000, openToBuyMinor: -10_000, state: 'over' });
    expect(view.overrides).toMatchObject([{ poId: 'po-2', approvedBy: 'u-owner', reason: 'Diwali stock-up agreed with the buyer', overByMinor: 10_000 }]);

    // ── A cancellation nets the commitment back; a budget change supersedes (the old figure stays on record) ───────────
    await ok(call('POST', '/v1/purchase/orders/po-2/cancellations', 'u-owner', { cancellationId: 'c1', cancelledByProduct: { RICE: 4 }, reason: 'supplier short' }, 'cx-1'), 'cancel part');
    expect((await otb()).categories.find((c) => c.categoryId === 'grocery')).toMatchObject({ committedMinor: 90_000, openToBuyMinor: 10_000, state: 'within' });
    await ok(budget({ categoryId: 'grocery', amountMinor: 150_000, reason: 'festival uplift approved' }, 'b-g2'), 'grocery budget raised');
    expect((await otb()).categories.find((c) => c.categoryId === 'grocery')).toMatchObject({ budgetMinor: 150_000, openToBuyMinor: 60_000 });
    const history = (await call('GET', '/v1/purchase/budgets', 'u-owner')).body as { budgets: { categoryId: string; amountMinor: number }[] };
    expect(history.budgets.filter((b) => b.categoryId === 'grocery').map((b) => b.amountMinor)).toEqual([100_000, 150_000]);

    // ── A STORE's own budget governs its orders before the company's; another store reads the company's ──────────────
    const s1 = await ok(order('po-3', [{ productId: 'SOAP', orderedQty: 4, unitCost: cost(5_000) }], 'store-1'), 'po-3 store-1');
    expect((s1.body as { order: { budgetCheck: { categories: Cat[] } } }).order.budgetCheck.categories).toMatchObject([{ categoryId: 'home', budgetScope: 'store', budgetMinor: 10_000, state: 'over' }]);
    const s2 = await ok(order('po-4', [{ productId: 'SOAP', orderedQty: 4, unitCost: cost(5_000) }], 'store-2'), 'po-4 store-2');
    expect((s2.body as { order: { budgetCheck: { categories: Cat[] } } }).order.budgetCheck.categories).toMatchObject([{ categoryId: 'home', budgetScope: 'company', budgetMinor: 50_000, state: 'within' }]);
    expect((await otb('store-1')).categories.find((c) => c.categoryId === 'home')).toMatchObject({ budgetMinor: 10_000, budgetScope: 'store', waitingMinor: 20_000 });

    // ── NO BUDGET for a category is said on the order, and does not stop it ────────────────────────────────────────
    const p5 = await ok(order('po-5', [{ productId: 'MYSTERY', orderedQty: 1, unitCost: cost(700) }]), 'po-5');
    expect((p5.body as { order: { budgetCheck: { categories: Cat[]; overBudget: boolean } } }).order.budgetCheck).toMatchObject({ overBudget: false, categories: [{ categoryId: 'uncategorised', state: 'no_budget', budgetMinor: null }] });
    await ok(approve('po-5'), 'approve po-5');
  });

  it('WF-03 (round 10): two approvals at the same moment cannot together spend more than the budget — one issues, the other is refused by name and is judged again on what the first committed', async () => {
    const h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-buyer', 'store_manager');
    await h.provisionRole(T, 'u-owner2', 'owner');
    await approvedSuppliers(h, T, 'sup-1');
    await deliveryPlaces(h, T, 'store-1');
    const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, key?: string, query?: Record<string, string>): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }), ...(method === 'GET' ? {} : { idempotencyKey: key ?? `${path}-${JSON.stringify(body)}` }) });
    const ok = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
    await ok(call('POST', '/v1/catalogue/tax-classes/1006/rates/2017-07-01', 'u-owner', { rateBps: 500 }, 'tax'), 'tax');
    await ok(call('POST', '/v1/catalogue/products/RICE/publish', 'u-owner', {
      product: { sku: 'SKU-RICE', name: 'RICE', baseUom: 'ea', primaryCategoryId: 'grocery', taxClass: '1006', lifecycle: 'active' },
      categories: [{ categoryId: 'grocery', name: 'Grocery', parentId: null }],
    }, 'pub-RICE'), 'publish');
    const month = new Date().toISOString().slice(0, 7);
    await ok(call('POST', '/v1/purchase/budgets', 'u-owner', { period: month, categoryId: 'grocery', amountMinor: 100_000, reason: 'October grocery plan' }, 'b-g'), 'budget');
    // Two orders, each within budget alone (60 000 of 100 000) — together over it.
    for (const id of ['po-a', 'po-b']) {
      await ok(call('POST', `/v1/purchase/orders/${id}`, 'u-buyer', { supplierId: 'sup-1', deliverToLocationId: 'store-1', lines: [{ productId: 'RICE', orderedQty: 12, unitCost: cost(5_000) }] }, `po-${id}`), id);
    }
    // Two owners approve at the same moment — neither names an over-budget reason.
    const [ra, rb] = await Promise.all([
      call('POST', '/v1/purchase/orders/po-a/approval', 'u-owner', { reason: 'weekly replenishment' }, 'ap-a'),
      call('POST', '/v1/purchase/orders/po-b/approval', 'u-owner2', { reason: 'weekly replenishment' }, 'ap-b'),
    ]);
    // Exactly one issues. The other is refused by name: when the two truly overlap, the budget guard refuses the second
    // write (409 concurrent_change); when a busy machine lets one finish first, the second is judged on what it committed
    // (422 over_budget_reason_required). Never both issued — that is the race this closes.
    const results = [ra, rb].map((r) => [r.status, codeOf(r) ?? 'issued']).sort();
    expect(results[0], JSON.stringify([ra.body, rb.body])).toEqual([200, 'issued']);
    expect([[409, 'concurrent_change'], [422, 'over_budget_reason_required']], JSON.stringify([ra.body, rb.body])).toContainEqual(results[1]);
    const status = async (id: string) => ((await call('GET', `/v1/purchase/orders/${id}`, 'u-owner')).body as { order: { status: string } }).order.status;
    const [winner, loser] = ra.status === 200 ? ['po-a', 'po-b'] : ['po-b', 'po-a'];
    expect([await status(winner), await status(loser)]).toEqual(['issued', 'proposed']);
    // Committed is what one order spent — never both; no override was recorded for the loser.
    const otb = (await call('GET', '/v1/purchase/open-to-buy', 'u-owner', undefined, undefined, { period: month })).body as { categories: Cat[]; overrides: unknown[] };
    expect(otb.categories.find((c) => c.categoryId === 'grocery')).toMatchObject({ committedMinor: 60_000, openToBuyMinor: 40_000, state: 'within' });
    expect(otb.overrides).toEqual([]);
    // Asked again, the loser is judged on what the winner committed: now over budget — it escalates by name.
    const again = await call('POST', `/v1/purchase/orders/${loser}/approval`, loser === 'po-a' ? 'u-owner' : 'u-owner2', { reason: 'weekly replenishment' }, `ap-${loser}-again`);
    expect([again.status, codeOf(again)]).toEqual([422, 'over_budget_reason_required']);
    expect(await status(loser)).toBe('proposed');
  });

  // OB-63 · WF-03: an issued order's AMENDMENT that raises its value goes through the same open-to-buy check and race guard
  // as an approval; over budget it escalates to the owner with a reason (recorded per amendment); a lowering one is not judged.
  const amendShop = async () => {
    const h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-buyer', 'store_manager');
    await h.provisionRole(T, 'u-owner2', 'owner');
    await approvedSuppliers(h, T, 'sup-1');
    await deliveryPlaces(h, T, 'store-1');
    const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, key?: string, query?: Record<string, string>): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }), ...(method === 'GET' ? {} : { idempotencyKey: key ?? randomUUID() }) });
    const ok = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
    await ok(call('POST', '/v1/catalogue/tax-classes/1006/rates/2017-07-01', 'u-owner', { rateBps: 500 }, 'tax'), 'tax');
    for (const [p, cat] of [['RICE', 'grocery'], ['SOAP', 'home']] as const) {
      await ok(call('POST', `/v1/catalogue/products/${p}/publish`, 'u-owner', {
        product: { sku: `SKU-${p}`, name: p, baseUom: 'ea', primaryCategoryId: cat, taxClass: '1006', lifecycle: 'active' },
        categories: [{ categoryId: 'grocery', name: 'Grocery', parentId: null }, { categoryId: 'home', name: 'Home care', parentId: null }],
      }, `pub-${p}`), `publish ${p}`);
    }
    const month = new Date().toISOString().slice(0, 7);
    const issued = async (poId: string, productId: string, qty: number) => {
      await ok(call('POST', `/v1/purchase/orders/${poId}`, 'u-buyer', { supplierId: 'sup-1', deliverToLocationId: 'store-1', lines: [{ productId, orderedQty: qty, unitCost: cost(5_000) }] }), poId);
      await ok(call('POST', `/v1/purchase/orders/${poId}/approval`, 'u-owner', { reason: 'weekly replenishment' }), `approve ${poId}`);
    };
    const amend = (poId: string, amendmentId: string, productId: string, qty: number, userId = 'u-owner', extra: Record<string, unknown> = {}, key?: string) =>
      call('POST', `/v1/purchase/orders/${poId}/amendments`, userId, { amendmentId, reason: 'supplier can fill more', lines: [{ productId, orderedQty: qty, unitCost: cost(5_000) }], ...extra }, key);
    const otb = async () => (await call('GET', '/v1/purchase/open-to-buy', 'u-owner', undefined, undefined, { period: month })).body as { categories: Cat[]; overrides: { poId: string; amendmentId?: string; approvedBy: string; reason: string; overByMinor: number }[] };
    const order = async (poId: string) => ((await call('GET', `/v1/purchase/orders/${poId}`, 'u-owner')).body as { order: { lines: { orderedQty: number; uom?: string }[]; amendmentCount: number; totalMinor: number } }).order;
    return { h, T, call, ok, month, issued, amend, otb, order };
  };

  it('OB-63: a raising amendment is judged on open-to-buy and escalates to the owner over budget; a lowering one is not judged; replay changes nothing', async () => {
    const { call, ok, month, issued, amend, otb, order } = await amendShop();
    await ok(call('POST', '/v1/purchase/budgets', 'u-owner', { period: month, categoryId: 'grocery', amountMinor: 100_000, reason: 'October grocery plan' }), 'budget');
    await issued('po-a', 'RICE', 12); // 60 000
    await issued('po-b', 'RICE', 6); // 30 000 — committed 90 000
    // Raised within budget (+10 000 → committed 100 000): judged, proceeds, the check rides on the answer.
    const within = await ok(amend('po-a', 'am-1', 'RICE', 14), 'am-1');
    expect((within.body as { budgetAtAmendment: { overBudget: boolean; categories: Cat[] } }).budgetAtAmendment).toMatchObject({ overBudget: false, categories: [{ categoryId: 'grocery', committedMinor: 30_000, thisOrderMinor: 70_000, remainingAfterMinor: 0 }] });
    expect((await otb()).categories.find((c) => c.categoryId === 'grocery')).toMatchObject({ committedMinor: 100_000, openToBuyMinor: 0 });
    // Raised OVER budget with no over-budget reason: escalates by name — nothing changed.
    const over = await amend('po-a', 'am-2', 'RICE', 16);
    expect([over.status, codeOf(over)]).toEqual([422, 'over_budget_reason_required']);
    expect((over.body as { error: { whatHappened: string } }).error.whatHappened).toContain('Amendment am-2 to purchase order po-a is over budget');
    expect(await order('po-a')).toMatchObject({ amendmentCount: 1, lines: [{ orderedQty: 14 }] });
    expect((await otb()).overrides).toEqual([]);
    // The owner, with a reason: amended, the override recorded against THIS amendment.
    await ok(amend('po-a', 'am-2', 'RICE', 16, 'u-owner', { overBudgetReason: 'Diwali stock-up' }), 'am-2 over budget');
    // The amended line keeps the product's own unit (OB-31), so it is valued like the ordered one.
    expect(await order('po-a')).toMatchObject({ amendmentCount: 2, lines: [{ orderedQty: 16, uom: 'ea' }] });
    let o = await otb();
    expect(o.categories.find((c) => c.categoryId === 'grocery')).toMatchObject({ committedMinor: 110_000, openToBuyMinor: -10_000, state: 'over' });
    expect(o.overrides).toEqual([expect.objectContaining({ poId: 'po-a', amendmentId: 'am-2', approvedBy: 'u-owner', reason: 'Diwali stock-up', overByMinor: 10_000 })]);
    // Re-sent (a lost reply, a fresh key): the same amendment — nothing applied twice, no second override.
    expect((await amend('po-a', 'am-2', 'RICE', 16, 'u-owner', { overBudgetReason: 'Diwali stock-up' })).status).toBe(200);
    expect(await order('po-a')).toMatchObject({ amendmentCount: 2 });
    expect((await otb()).overrides).toHaveLength(1);
    // A LOWERING amendment spends no budget: not judged, no reason needed, even with the month over budget.
    const lower = await ok(amend('po-b', 'am-3', 'RICE', 2), 'am-3 lower');
    expect((lower.body as { budgetAtAmendment?: unknown }).budgetAtAmendment).toBeUndefined();
    o = await otb();
    expect(o.categories.find((c) => c.categoryId === 'grocery')).toMatchObject({ committedMinor: 90_000, openToBuyMinor: 10_000, state: 'within' });
    // Only a person who approves orders may amend one (a store manager may not).
    expect((await amend('po-b', 'am-4', 'RICE', 3, 'u-buyer')).status).toBe(403);
  });

  it('OB-63 (race): two raising amendments — or an amendment and an approval — at the same moment never together spend more than the budget', async () => {
    const { call, ok, month, issued, amend, otb, order } = await amendShop();
    await ok(call('POST', '/v1/purchase/budgets', 'u-owner', { period: month, categoryId: 'grocery', amountMinor: 100_000, reason: 'October grocery plan' }), 'grocery budget');
    await ok(call('POST', '/v1/purchase/budgets', 'u-owner', { period: month, categoryId: 'home', amountMinor: 100_000, reason: 'October home plan' }), 'home budget');
    await issued('po-a', 'RICE', 8); // 40 000
    await issued('po-b', 'RICE', 8); // 40 000 — grocery committed 80 000
    // Each raise alone is within (+15 000 → 95 000); together they would be 110 000. Neither names an over-budget reason.
    const [ra, rb] = await Promise.all([amend('po-a', 'am-a', 'RICE', 11, 'u-owner'), amend('po-b', 'am-b', 'RICE', 11, 'u-owner2')]);
    const results = [ra, rb].map((r) => [r.status, codeOf(r) ?? 'amended']).sort();
    expect(results[0], JSON.stringify([ra.body, rb.body])).toEqual([200, 'amended']);
    expect([[409, 'concurrent_change'], [422, 'over_budget_reason_required']], JSON.stringify([ra.body, rb.body])).toContainEqual(results[1]);
    expect((await otb()).categories.find((c) => c.categoryId === 'grocery')).toMatchObject({ committedMinor: 95_000, openToBuyMinor: 5_000, state: 'within' });
    expect([(await order('po-a')).amendmentCount + (await order('po-b')).amendmentCount]).toEqual([1]);

    // An amendment and an approval at the same moment (home care): each alone within, together over — one lands.
    await issued('po-c', 'SOAP', 12); // 60 000
    await ok(call('POST', '/v1/purchase/orders/po-d', 'u-buyer', { supplierId: 'sup-1', deliverToLocationId: 'store-1', lines: [{ productId: 'SOAP', orderedQty: 6, unitCost: cost(5_000) }] }), 'po-d'); // 30 000 proposed
    const [rAmend, rApprove] = await Promise.all([
      amend('po-c', 'am-c', 'SOAP', 16, 'u-owner'), // +20 000 → 80 000
      call('POST', '/v1/purchase/orders/po-d/approval', 'u-owner2', { reason: 'weekly replenishment' }), // +30 000 → 90 000
    ]);
    const both = [rAmend, rApprove].map((r) => [r.status, codeOf(r) ?? 'done']).sort();
    expect(both[0], JSON.stringify([rAmend.body, rApprove.body])).toEqual([200, 'done']);
    expect([[409, 'concurrent_change'], [422, 'over_budget_reason_required']], JSON.stringify([rAmend.body, rApprove.body])).toContainEqual(both[1]);
    const home = (await otb()).categories.find((c) => c.categoryId === 'home')!;
    expect(home.committedMinor === 80_000 || home.committedMinor === 90_000, JSON.stringify(home)).toBe(true);
    expect(home.state).toBe('within');
    expect((await otb()).overrides).toEqual([]);
  });
});

describe('the over-budget escalation refuses an approver without the authority to exceed (unit, on the same gate the route runs)', () => {
  const po: StoredPurchaseOrder = {
    poId: 'po-x', number: 'po-x', supplierId: 's', deliverToLocationId: 'store-1', requisitionedBy: 'u-buyer', at: '2026-10-05T00:00:00.000Z',
    lines: [{ productId: 'RICE', orderedQty: 3, unitCost: { minor: 1_000, currency: 'INR' } }], totalMinor: 3_000, currency: 'INR',
    status: 'proposed', approvedBy: null, issuedAt: null, receivedByProduct: {}, cancelledByProduct: {}, amendmentCount: 0,
  };
  const recorded: unknown[] = [];
  const deps = (perms: readonly string[]): OpenToBuyDeps => ({
    budgets: () => [{ categoryId: 'grocery', period: '2026-10', storeId: null, amountMinor: 2_000, reason: 'r', setBy: 'u-owner', setAt: '2026-10-01T00:00:00.000Z' }],
    recordBudget: () => {}, orders: () => [po], categoryOf: () => 'grocery', overrides: () => [], recordOverride: (_t, o) => { recorded.push(o); },
    permissionsOfUser: () => perms, now: () => '2026-10-05T01:00:00.000Z',
  });
  it('409 over_open_to_buy without `purchase.budget.exceed`, nothing recorded; with it and a reason, the override is recorded', async () => {
    await expect(gateApprovalOnBudget(deps(['purchase.order.approve']), { tenantId: 't', userId: 'u-approver' }, po, 'festival')).rejects.toMatchObject({ status: 409, body: { code: 'over_open_to_buy' } });
    expect(recorded).toHaveLength(0);
    const check = await gateApprovalOnBudget(deps(['purchase.order.approve', 'purchase.budget.exceed']), { tenantId: 't', userId: 'u-owner' }, po, 'festival');
    expect(check).toMatchObject({ overBudget: true, overByMinor: 1_000 });
    expect(recorded).toMatchObject([{ poId: 'po-x', approvedBy: 'u-owner', reason: 'festival', overByMinor: 1_000 }]);
  });
});
