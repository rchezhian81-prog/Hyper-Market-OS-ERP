import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { STREAM } from '../../services/api/src/adapters';
import { makeEvent } from '../../packages/contracts/src/event';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { alignToOrder, remainingOnOrder, type ReceiptFlag } from '../../services/inventory/src/goods-receipt';
import type { CapturedLine } from '../../packages/receiving/src/index';

/**
 * **SF-02 — each delivery is judged against what REMAINS on the purchase order, not the original order (Wave 3 · audit
 * step 3 · M06-FR-04 · M07-FR-01 · M07-FR-03 · §28 · hard rules #2/#10 · P-08).**
 *
 * The audit's harness: an order of 100, a first receipt of 60 and a second of 60 — both 201, the second's 60 all sellable
 * with nothing held, the order showing 120 received and −20 open. Each receipt was measured against the ORIGINAL 100, so
 * successive partial deliveries could over-receive without the second-person excess approval. Now head office measures
 * every receipt against ordered − already received − cancelled (never below zero), keeps the original quantity
 * separately on the record, and serialises receipts against one order with a write guard: two receipts judged on the
 * same remainder cannot both post. The first half drives the real API over the in-memory store; the last block runs the
 * simultaneous case on real PostgreSQL (skips, never passes, without DATABASE_URL). Synthetic data (hard rule #7).
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AT = '2026-10-09T09:00:00.000Z';
const WH = 'wh-1';
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

interface Grn {
  grnId: string; availableMinor: number; heldMinor: number; governanceFlags: string[];
  poReceipt: { receiptId: string; receivedByProduct: Record<string, number> } | null;
  orderPosition?: Record<string, { orderedMinor: number; alreadyReceivedMinor: number; cancelledMinor: number; remainingMinor: number }>;
  captured: { requiresApproval: boolean; lines: { sellableMinor: number; heldMinor: number }[]; discrepancies: { kind: string; quantityMinor: number; requiresApproval: boolean }[] };
}
interface Order { order: { receivedByProduct: Record<string, number>; cancelledByProduct: Record<string, number> }; openCommitment: { fullyReceived: boolean; lines: { productId: string; openQty: number }[] } | null }

const req = (h: ApiHarness, t: string, method: 'POST' | 'GET', path: string, userId: string, key?: string, body?: unknown) =>
  h.request({ method, path, userId, tenantId: t, ...(key === undefined ? {} : { idempotencyKey: key }), ...(body === undefined ? {} : { body }) });
const line = (counted: number, ordered = 100) =>
  ({ lineId: 'L1', productId: 'p1', orderedMinor: ordered, countedMinor: counted, uom: 'ea', unitCost: { minor: 5000, currency: 'INR' }, condition: 'good' });
const receive = (h: ApiHarness, t: string, grnId: string, counted: number, opts: { ordered?: number; key?: string; poId?: string } = {}) =>
  req(h, t, 'POST', `/v1/inventory/goods-receipt/${grnId}`, 'u-recv', opts.key ?? grnId,
    { warehouseId: WH, receivedOnDate: '2026-10-09', currency: 'INR', poId: opts.poId ?? 'po-1', lines: [line(counted, opts.ordered)] });
const grnOf = (res: { body: unknown }): Grn => (res.body as { grn: Grn }).grn;
const orderOf = async (h: ApiHarness, t: string, poId = 'po-1') => (await req(h, t, 'GET', `/v1/purchase/orders/${poId}`, 'u-owner')).body as Order;
const onHand = async (h: ApiHarness, t: string): Promise<number> =>
  ((await h.request({ method: 'GET', path: '/v1/inventory/availability', userId: 'u-owner', tenantId: t, query: { productId: 'p1' } })).body as { rows: { onHandMinor: number }[] }).rows.reduce((s, r) => s + r.onHandMinor, 0);

/** The cast, the product master (p1 untracked), zero tolerance, and an ISSUED order of 100 p1 (proposed by the buyer, approved by the owner). */
async function seeded(h: ApiHarness = apiHarness(), t = A): Promise<ApiHarness> {
  await h.seedOwner(t, 'u-owner');
  await h.provisionRole(t, 'u-recv', 'store_manager'); // receives — never decides their own delivery's excess
  await h.provisionRole(t, 'u-boss', 'store_manager'); // the second person
  await h.provisionRole(t, 'u-buyer', 'store_manager');
  await h.provisionRole(t, 'u-box', 'cashier');        // the store computer's sync identity
  await h.store.append(t, STREAM.catalogue, makeEvent({
    id: `pack-${t}-1`, type: 'CataloguePublished', occurredAt: AT, idempotencyKey: `catalogue-${t}-v1`, source: 'test/catalogue',
    payload: { snapshot: { tenantId: t, version: 1, builtAt: AT, scope: { tenantId: t, storeId: 'store-1' },
      products: [{ productId: 'p1', sku: 'p1', name: 'Toor dal 1kg', unitPriceMinor: 16_000, taxBps: 0, status: 'active', uom: 'ea', batchTracked: false }], barcodes: [] } },
  }));
  expect((await req(h, t, 'POST', '/v1/inventory/receipt-policy', 'u-owner', 'pol', { excessToleranceBp: 0, shortageToleranceBp: 0, nearExpiryDays: 7 })).status).toBe(201);
  expect((await req(h, t, 'POST', '/v1/purchase/orders/po-1', 'u-buyer', 'po-1', { supplierId: 's-1', lines: [{ productId: 'p1', orderedQty: 100, unitCost: { minor: 5000, currency: 'INR' } }] })).status).toBe(201);
  expect((await req(h, t, 'POST', '/v1/purchase/orders/po-1/approval', 'u-owner', 'po-1-ok', { reason: 'fixture' })).status).toBe(200);
  return h;
}

describe('SF-02 — a delivery is judged against what remains on the order', () => {
  it('60 then 40 against an order of 100: both sellable, nothing held, the order exactly fully received; the original 100 is kept beside what remained', async () => {
    const h = await seeded();
    const first = await receive(h, A, 'grn-1', 60);
    expect(first.status).toBe(201);
    expect(grnOf(first)).toMatchObject({ availableMinor: 60, heldMinor: 0, poReceipt: { receivedByProduct: { p1: 60 } } });
    expect(grnOf(first).orderPosition).toEqual({ p1: { orderedMinor: 100, alreadyReceivedMinor: 0, cancelledMinor: 0, remainingMinor: 100 } });

    // The sender still quotes the ORIGINAL 100 on the line — that is not a disagreement; the line is measured against the 40 left.
    const second = await receive(h, A, 'grn-2', 40);
    expect(second.status).toBe(201);
    expect(grnOf(second)).toMatchObject({ availableMinor: 40, heldMinor: 0, governanceFlags: [] });
    expect(grnOf(second).captured.lines[0]).toMatchObject({ sellableMinor: 40, heldMinor: 0 });
    expect(grnOf(second).captured.discrepancies).toEqual([]);
    expect(grnOf(second).orderPosition).toEqual({ p1: { orderedMinor: 100, alreadyReceivedMinor: 60, cancelledMinor: 0, remainingMinor: 40 } });
    const po = await orderOf(h, A);
    expect(po.order.receivedByProduct).toEqual({ p1: 100 });
    expect(po.openCommitment).toMatchObject({ fullyReceived: true, lines: [expect.objectContaining({ productId: 'p1', openQty: 0 })] });
    expect(await onHand(h, A)).toBe(100);
  });

  it('60 then 60 against an order of 100 (the audit\'s case): the second sells only the 40 still owed, HOLDS 20 for a second person, and the order never goes below zero open', async () => {
    const h = await seeded();
    expect((await receive(h, A, 'grn-1', 60)).status).toBe(201);
    const second = await receive(h, A, 'grn-2', 60);
    expect(second.status).toBe(201);
    const g = grnOf(second);
    expect(g).toMatchObject({ availableMinor: 40, heldMinor: 20, poReceipt: { receivedByProduct: { p1: 40 } } });
    expect(g.captured.requiresApproval).toBe(true);
    expect(g.captured.discrepancies).toEqual([expect.objectContaining({ kind: 'excess', quantityMinor: 20, requiresApproval: true })]);
    let po = await orderOf(h, A);
    expect(po.order.receivedByProduct).toEqual({ p1: 100 }); // never 120
    expect(po.openCommitment?.lines).toEqual([expect.objectContaining({ productId: 'p1', openQty: 0 })]); // never −20
    expect(await onHand(h, A)).toBe(100); // the 20 are in the building, counted, and NOT sellable

    // The receiver cannot accept their own over-delivery; a second person can — and only then is it received against the order.
    expect(codeOf(await req(h, A, 'POST', '/v1/inventory/goods-receipt/grn-2/excess/decide', 'u-recv', 'ex-self', { decision: 'approved', reason: 'mine' }))).toBe('self_approval');
    expect((await req(h, A, 'POST', '/v1/inventory/goods-receipt/grn-2/excess/decide', 'u-boss', 'ex-ok', { decision: 'approved', reason: 'supplier sent extra; we keep it' })).status).toBe(200);
    expect(await onHand(h, A)).toBe(120);
    po = await orderOf(h, A);
    expect(po.order.receivedByProduct).toEqual({ p1: 120 }); // a governed over-receipt, decided by a second person
  });

  it('a delivery after the remainder was CANCELLED: nothing is owed, so all of it is held for a second person', async () => {
    const h = await seeded();
    expect((await receive(h, A, 'grn-1', 60)).status).toBe(201);
    expect((await req(h, A, 'POST', '/v1/purchase/orders/po-1/cancellations', 'u-owner', 'cx-1', { cancellationId: 'cx-1', reason: 'supplier cannot supply the rest', cancelledByProduct: { p1: 40 } })).status).toBe(200);
    const late = await receive(h, A, 'grn-2', 10);
    expect(late.status).toBe(201);
    expect(grnOf(late)).toMatchObject({ availableMinor: 0, heldMinor: 10, poReceipt: null });
    expect(grnOf(late).orderPosition).toEqual({ p1: { orderedMinor: 100, alreadyReceivedMinor: 60, cancelledMinor: 40, remainingMinor: 0 } });
    expect((await orderOf(h, A)).order.receivedByProduct).toEqual({ p1: 60 });
    expect(await onHand(h, A)).toBe(60);
  });

  it('a short second delivery is a shortage against what remains, not against the original order', async () => {
    const h = await seeded();
    await receive(h, A, 'grn-1', 60);
    const short = await receive(h, A, 'grn-2', 30);
    expect(grnOf(short).captured.discrepancies).toEqual([expect.objectContaining({ kind: 'short', quantityMinor: 10 })]); // 10 of the 40 owed, not 70 of 100
    expect((await orderOf(h, A)).openCommitment?.lines).toEqual([expect.objectContaining({ productId: 'p1', openQty: 10 })]);
  });

  it('the store computer\'s relayed receipt is judged the same way: 60 then 60 relayed — 40 sell, 20 held', async () => {
    const h = await seeded();
    const relay = (grnId: string, qty: number) => req(h, A, 'POST', `/v1/inventory/goods-receipt/${grnId}/synced`, 'u-box', `relay-${grnId}`, {
      grnId, number: `DN-${grnId}`, poId: 'po-1', lineCount: 1, warehouseId: WH, receivedBy: 'u-recv', receivedAt: AT,
      lines: [{ productId: 'p1', quantityMinor: qty, uom: 'ea', batchId: null }], storeId: 'store-1', source: 'manager-screen',
    });
    // 202 is the relayed route's own success: the goods were booked in at the store and head office records that it happened.
    expect((await relay('g-1', 60)).status).toBe(202);
    const second = await relay('g-2', 60);
    expect(second.status).toBe(202);
    expect(grnOf(second)).toMatchObject({ availableMinor: 40, heldMinor: 20 });
    expect((await orderOf(h, A)).order.receivedByProduct).toEqual({ p1: 100 });
  });

  it('two receipts of 60 at the SAME moment: one lands, the other is refused by name and nothing of it is written; sent again it is judged on the 40 left', async () => {
    const h = await seeded();
    const [a, b] = await Promise.all([receive(h, A, 'grn-a', 60), receive(h, A, 'grn-b', 60)]);
    const [won, lost] = a.status === 201 ? [a, b] : [b, a];
    expect(won.status).toBe(201);
    expect(grnOf(won)).toMatchObject({ availableMinor: 60, heldMinor: 0 });
    expect(lost.status).toBe(409);
    expect(codeOf(lost)).toBe('concurrent_change');
    const loser = lost === a ? 'grn-a' : 'grn-b';
    expect((await req(h, A, 'GET', `/v1/inventory/goods-receipt/${loser}`, 'u-owner')).status).toBe(404); // nothing of it was written
    expect(await onHand(h, A)).toBe(60);
    // Sent again (the handheld or store computer retries): judged on the 40 that remain — 40 sell, 20 held.
    const again = await receive(h, A, loser, 60, { key: `${loser}-again` });
    expect(again.status).toBe(201);
    expect(grnOf(again)).toMatchObject({ availableMinor: 40, heldMinor: 20 });
    expect((await orderOf(h, A)).order.receivedByProduct).toEqual({ p1: 100 });
    expect(await onHand(h, A)).toBe(100);
  });
});

describe('SF-02 — the remainder and the line alignment, as pure rules', () => {
  it('remaining = ordered − received − cancelled, never below zero; the position keeps the original', () => {
    expect(remainingOnOrder({ status: 'issued', orderedByProduct: { p1: 100, p2: 5 }, receivedByProduct: { p1: 120 }, cancelledByProduct: { p2: 2 } })).toEqual({
      remaining: { p1: 0, p2: 3 },
      position: { p1: { orderedMinor: 100, alreadyReceivedMinor: 120, cancelledMinor: 0, remainingMinor: 0 }, p2: { orderedMinor: 5, alreadyReceivedMinor: 0, cancelledMinor: 2, remainingMinor: 3 } },
    });
    expect(remainingOnOrder({ status: 'issued', orderedByProduct: { p1: 10 } }).remaining).toEqual({ p1: 10 });
  });

  it('a line quoting the original order is not a disagreement; a line quoting neither figure is', () => {
    const l = (ordered: number, counted = 40): CapturedLine => ({ lineId: 'L1', productId: 'p1', orderedMinor: ordered, countedMinor: counted, uom: 'ea', unitCost: { minor: 1, currency: 'INR' }, condition: 'good' });
    const quoteOriginal: ReceiptFlag[] = [];
    expect(alignToOrder([l(100)], { p1: 40 }, quoteOriginal, { p1: 100 })[0]!.orderedMinor).toBe(40);
    expect(quoteOriginal).toEqual([]);
    const quoteRemaining: ReceiptFlag[] = [];
    alignToOrder([l(40)], { p1: 40 }, quoteRemaining, { p1: 100 });
    expect(quoteRemaining).toEqual([]);
    const quoteNeither: ReceiptFlag[] = [];
    alignToOrder([l(70)], { p1: 40 }, quoteNeither, { p1: 100 });
    expect(quoteNeither).toEqual(['ordered_quantity_disagrees']);
  });
});

// ── The simultaneous case on real PostgreSQL — the proof the audit asked for ─────────────────────────────────
const DATABASE_URL = process.env['DATABASE_URL'];
// A unique tenant per case — an append-only database keeps what earlier runs put in it (§35).
const freshTenant = (): string => `e${Date.now().toString(16).slice(-6)}${Math.floor(Math.random() * 16).toString(16)}-eeee-4eee-8eee-${'e'.repeat(12)}`;

describe.skipIf(!DATABASE_URL)('SF-02 on real PostgreSQL (Wave 3)', () => {
  let pool: Pool;
  beforeAll(async () => {
    // The TRANSACTIONAL pool client — the wiring main.ts uses; a guarded append refuses a client without one.
    pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
    const dir = 'db/migrations';
    await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
      .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
  });
  afterAll(async () => { await pool.end(); });

  const harness = () => { const sql = pgPoolClient(pool); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); };

  it('60 then 60 on the database: 40 sell, 20 held, the order 100 received and 0 open', async () => {
    const t = freshTenant();
    const h = await seeded(harness(), t);
    expect((await receive(h, t, 'grn-1', 60)).status).toBe(201);
    expect(grnOf(await receive(h, t, 'grn-2', 60))).toMatchObject({ availableMinor: 40, heldMinor: 20 });
    expect((await orderOf(h, t)).order.receivedByProduct).toEqual({ p1: 100 });
  });

  it('two receipts of 60 at once on the database: never 120 received — the loser is refused by the guard, or judged on the true remainder once the first committed', async () => {
    const t = freshTenant();
    const h = await seeded(harness(), t);
    const [a, b] = await Promise.all([receive(h, t, 'grn-a', 60), receive(h, t, 'grn-b', 60)]);
    const statuses = [a.status, b.status].sort();
    // In memory both read before either writes; on the database the first may COMMIT before the second reads the order, and
    // then the second is judged on the 40 that truly remain (201, 20 held). Either way the order never shows 120 received.
    expect([[201, 201], [201, 409]]).toContainEqual(statuses);
    for (const r of [a, b]) if (r.status === 409) expect(codeOf(r)).toBe('concurrent_change');
    const received = (await orderOf(h, t)).order.receivedByProduct['p1'];
    expect(received).toBeLessThanOrEqual(100);
    const sellable = [a, b].filter((r) => r.status === 201).reduce((s, r) => s + grnOf(r).availableMinor, 0);
    expect(sellable).toBe(received);
  });
});
