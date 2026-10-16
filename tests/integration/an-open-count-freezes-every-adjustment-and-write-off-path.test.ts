import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { sealedDecision } from '../support/store-seal';
import { withApprovals } from '../support/refund-approval';
import { STREAM } from '../../services/api/src/adapters';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';

/**
 * **WF-08 · D05-FR-05 · OB-59 "A" (owner, 11 Oct 2026, "Adjustments & write-offs") — while a count is open at a place,
 * EVERY path that writes an adjustment or a write-off there for a counted product is held to the freeze (P-08 · hard
 * rules #2 #10).**
 *
 * Round 8 refused a frozen kind only on the plain movements route; every other route still landed and was only flagged.
 * On the real API — in memory and, with DATABASE_URL, on real PostgreSQL — a plan with the owner's default freeze
 * (adjustments and write-offs) counts P1 and P2 at S1, and then:
 *
 *   HEAD-OFFICE routes are refused by name (`frozen_by_a_stock_count`, 409) and NOTHING is written — the write-off route;
 *   a held returned unit's write-off decision; an adjustment request's approval (it stays pending); an ad-hoc count with a
 *   variance (not recorded) and an ad-hoc held count's approval (it stays held); a transfer's found-stock resolution; a
 *   floor indent's found-stock resolution. A product NOT counted at the same place, and the till's own restock decision, go
 *   through; once the plan is cancelled the same write-off lands. OB-66 (round 11): a floor receipt with arrived-damaged
 *   units is no longer refused — the good units land at once and the damaged units' write-off is HELD on the plan (direct
 *   or relayed), applied once when the plan closes (here: cancelled).
 *
 *   BOX-RELAYED records (a manager's decision made on the store screen, a floor receipt counted on the device) already
 *   happened on the floor: they are KEPT — never refused into the void — and the open plan raises each as a visible
 *   exception (`freezeBreaches`), and the product it touched must be counted again (`moved_during_freeze`) before the plan
 *   can be approved. Never silently dropped; never applied as if no count were open.
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
const SEED_AT = '2026-08-01T00:00:00.000Z';

describe.each(backings)('an open count freezes every adjustment and write-off path at its place — on $name (WF-08 · OB-59)', ({ harness }) => {
  it('head-office routes are refused by name with nothing written; box-relayed records are kept and raised as freeze exceptions needing a recount', async () => {
    const h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    for (const u of ['u-plan', 'u-c1', 'u-mgr', 'u-mgr2', 'u-back', 'u-floor2', 'u-area', 'u-worker']) await h.provisionRole(T, u, 'store_manager');
    await h.provisionRole(T, 'u-cash', 'cashier');
    await h.provisionRole(T, 'u-box', 'store_computer', ['S1']);
    let n = 0;
    const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, query?: Record<string, string>): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }), ...(method === 'GET' ? {} : { idempotencyKey: `k-${n += 1}` }) });
    const ok = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
    const frozen = async (p: Promise<Res>, what: string): Promise<void> => { const r = await p; expect([r.status, codeOf(r)], `${what}: ${JSON.stringify(r.body)}`).toEqual([409, 'frozen_by_a_stock_count']); };
    const relayDecision = (id: string, subjectType: string, subjectRef: string, requestedBy: string) =>
      h.request({ method: 'POST', path: `/v1/approvals/decisions/${id}/synced`, userId: 'u-box', tenantId: T, idempotencyKey: `relay-${id}`, body: sealedDecision(T, 'ApprovalDecided', {
        id, subjectType, subjectRef, requestedBy, branchId: 'S1', value: null, status: 'approved', decidedBy: 'u-mgr', reason: 'checked on the floor', decidedAt: new Date().toISOString(), storeId: 'S1', source: 'manager-screen',
      }) });
    const onHand = async (p: string, loc = 'S1'): Promise<number> =>
      ((await call('GET', '/v1/inventory/availability', 'u-owner', undefined, { productId: p })).body as { rows: { locationId: string; onHandMinor: number }[] }).rows.filter((r) => r.locationId === loc).reduce((s, r) => s + r.onHandMinor, 0);
    const movementIds = async (): Promise<string[]> => (await h.store.readStream(T, STREAM.inventory, { type: 'InventoryMoved' })).map((e) => (e.event.payload as { movementId: string }).movementId);

    // ── The shop: S1 (the floor) with its back store, a warehouse; stock costed at each ─────────────────────────────
    await ok(call('POST', '/v1/org/nodes/C1', 'u-owner', { kind: 'company', name: 'SRE Retail' }), 'company');
    await ok(call('POST', '/v1/org/nodes/S1', 'u-owner', { kind: 'branch', name: 'Store 1', parentId: 'C1', companyId: 'C1' }), 'store');
    await ok(call('POST', '/v1/org/nodes/S1-BACK', 'u-owner', { kind: 'warehouse', name: 'Store 1 back store', parentId: 'S1', companyId: 'C1' }), 'back store');
    await ok(call('POST', '/v1/org/nodes/WH', 'u-owner', { kind: 'warehouse', name: 'Central warehouse', parentId: 'C1', companyId: 'C1' }), 'warehouse');
    const seed = (id: string, productId: string, locationId: string, qty: number, cost: number) =>
      ok(call('POST', '/v1/inventory/movements', 'u-owner', { movementId: id, productId, locationId, kind: 'received', quantityMinor: qty, uom: 'EA', occurredAt: SEED_AT, enteredBy: 'u-owner', unitCostMinor: cost }), `seed ${id}`);
    await seed('s-p1', 'P1', 'S1', 100, 100);
    await seed('s-p2', 'P2', 'S1', 50, 1_000);
    await seed('s-p3', 'P3', 'S1', 20, 500);
    await seed('s-p2-back', 'P2', 'S1-BACK', 30, 1_000);
    await seed('s-p1-wh', 'P1', 'WH', 20, 100);

    // ── Before the count: work already in flight at S1 ─────────────────────────────────────────────────────────────
    // A till sale of P1 and a return of one DAMAGED unit — held off the shelf, waiting for a person's decision.
    const SALE = { saleId: 'SL1', receiptNumber: 'R-1', laneId: 'lane-1', cashierId: 'u-cash', locationId: 'S1', tradingDay: new Date().toISOString().slice(0, 10), committedAt: new Date().toISOString(), totalMinor: 400, currency: 'INR', packVersion: 1,
      lines: [{ productId: 'P1', quantityMinor: 2, uom: 'EA', unitPriceMinor: 200, lineTotalMinor: 400 }], tenders: [{ kind: 'cash', amountMinor: 400 }] };
    await ok(call('POST', '/v1/sales', 'u-owner', SALE), 'sale');
    await ok(call('POST', '/v1/sales/SL1/returns', 'u-owner', await withApprovals(h, T, 'u-owner', 'SL1', {
      returnId: 'RT1', reasonCode: 'damaged_in_use', refundMinor: 400, refundTender: 'cash', approvedBy: 'u-mgr',
      lines: [{ productId: 'P1', uom: 'EA', quantityMinor: 1, disposition: 'damaged', condition: 'torn pack' }, { productId: 'P1', uom: 'EA', quantityMinor: 1, disposition: 'quarantine' }],
    })), 'return');
    const held = ((await call('GET', '/v1/returns/held-stock/worklist', 'u-mgr')).body as { items: { heldId: string; disposition: string; state: string }[] }).items;
    const damagedUnit = held.find((i) => i.disposition === 'damaged')!;
    const quarantinedUnit = held.find((i) => i.disposition === 'quarantine')!;
    // Two adjustment requests relayed from the handheld (pending — nothing moved).
    for (const id of ['ar-1', 'ar-2']) {
      await ok(call('POST', `/v1/inventory/adjustment-requests/${id}/synced`, 'u-box', { requestId: id, productId: 'P1', locationId: 'S1', binId: null, deltaMinor: -3, uom: 'EA', reasonCode: 'damaged', requestedBy: 'u-worker', at: new Date().toISOString(), storeId: 'S1', source: 'warehouse-handheld' }), `request ${id}`);
    }
    // An ad-hoc count of P1 HELD for a second person (a low count-approval threshold), and a second one of P2.
    await ok(call('POST', '/v1/inventory/count-policy', 'u-owner', { approvalThresholdMinor: 50 }), 'count policy');
    expect((await ok(call('POST', '/v1/inventory/counts/c-held', 'u-c1', { productId: 'P1', locationId: 'S1', uom: 'EA', countedMinor: 95, reasonCode: 'cycle_count' }), 'held count')).body).toMatchObject({ pendingApproval: true });
    expect((await ok(call('POST', '/v1/inventory/counts/c-held2', 'u-c1', { productId: 'P1', locationId: 'S1', uom: 'EA', countedMinor: 94, reasonCode: 'cycle_count' }), 'held count 2')).body).toMatchObject({ pendingApproval: true });
    // A warehouse transfer of P1 into S1 counted SHORT (8 of 10).
    await ok(call('POST', '/v1/warehouse/transfers/t1', 'u-owner', { fromLocationId: 'WH', toLocationId: 'S1', lines: [{ productId: 'P1', batchId: null, quantityMinor: 10, uom: 'EA', unitCost: { minor: 100, currency: 'INR' } }] }), 'propose');
    await ok(call('POST', '/v1/warehouse/transfers/t1/dispatch', 'u-mgr', {}), 'dispatch');
    await ok(call('POST', '/v1/warehouse/transfers/t1/receive', 'u-c1', { counted: [{ productId: 'P1', batchId: null, quantityMinor: 8 }] }), 'receive short');
    // A floor indent of P2 from the back store: two issues in transit; the second counted in SHORT (3 of 4).
    await ok(call('POST', '/v1/floor/indents/ind-1', 'u-plan', { fromLocationId: 'S1-BACK', toLocationId: 'S1', lines: [{ productId: 'P2', quantityMinor: 10, uom: 'EA' }], reason: 'shelf 4 empty' }), 'indent');
    await ok(call('POST', '/v1/floor/indents/ind-1/approval', 'u-mgr', {}), 'indent approval');
    await ok(call('POST', '/v1/floor/indents/ind-1/issues/is-1', 'u-back', { lines: [{ productId: 'P2', batchId: null, quantityMinor: 6 }] }), 'issue 1');
    await ok(call('POST', '/v1/floor/indents/ind-1/issues/is-2', 'u-back', { lines: [{ productId: 'P2', batchId: null, quantityMinor: 4 }] }), 'issue 2');
    await ok(call('POST', '/v1/floor/indents/ind-1/issues/is-2/receipt', 'u-floor2', { counted: [{ productId: 'P2', batchId: null, quantityMinor: 3 }] }), 'receipt short');
    // A second indent of P2, its one issue in transit (to be counted in on the device and relayed while the count is open).
    await ok(call('POST', '/v1/floor/indents/ind-2', 'u-plan', { fromLocationId: 'S1-BACK', toLocationId: 'S1', lines: [{ productId: 'P2', quantityMinor: 4, uom: 'EA' }], reason: 'shelf 5 empty' }), 'indent 2');
    await ok(call('POST', '/v1/floor/indents/ind-2/approval', 'u-mgr', {}), 'indent 2 approval');
    await ok(call('POST', '/v1/floor/indents/ind-2/issues/is-3', 'u-back', { lines: [{ productId: 'P2', batchId: null, quantityMinor: 4 }] }), 'issue 3');

    // ── THE COUNT: the owner's default freeze (OB-59) on P1 and P2 at S1; both counted blind at once ────────────────
    const plan = await ok(call('POST', '/v1/inventory/count-plans/cp1', 'u-plan', { locationId: 'S1', productIds: ['P1', 'P2'], recountThresholdMinor: 1_000_000, note: 'aisle 4' }), 'plan');
    expect((plan.body as { plan: { frozenKinds: string[] } }).plan.frozenKinds).toEqual(['adjusted', 'wasted']);
    await ok(call('POST', '/v1/inventory/count-plans/cp1/open', 'u-plan', {}), 'open');
    await ok(call('POST', '/v1/inventory/count-plans/cp1/counts/k-p1', 'u-c1', { productId: 'P1', locationId: 'S1', uom: 'EA', countedMinor: 106 }), 'count P1');
    await ok(call('POST', '/v1/inventory/count-plans/cp1/counts/k-p2', 'u-c1', { productId: 'P2', locationId: 'S1', uom: 'EA', countedMinor: 53 }), 'count P2');
    const p1Before = await onHand('P1');
    const p2Before = await onHand('P2');
    const movesBefore = (await movementIds()).length;

    // ── HEAD-OFFICE paths: each refused by name, nothing written ─────────────────────────────────────────────────
    // 1. The write-off route.
    await frozen(call('POST', '/v1/inventory/write-off/wo-1', 'u-mgr', { productId: 'P1', locationId: 'S1', qty: 1, uom: 'EA', lossType: 'damage', reasonCode: 'damage' }), 'write-off');
    expect(((await call('GET', '/v1/inventory/write-offs', 'u-owner')).body as { writeOffs: { id: string }[] }).writeOffs.map((w) => w.id)).toEqual([]);
    // 2. A held returned unit's write-off decision — the unit stays held. (Its restock — a `returned`, not frozen — goes through.)
    await frozen(call('POST', `/v1/returns/held-stock/${damagedUnit.heldId}/decisions/d-wo`, 'u-mgr', { decision: 'write_off', reasonCode: 'damage', note: 'torn', evidenceRef: 'photo-1' }), 'held write-off');
    expect(((await call('GET', '/v1/returns/held-stock/worklist', 'u-mgr')).body as { items: { heldId: string; state: string }[] }).items.find((i) => i.heldId === damagedUnit.heldId)?.state).toBe('held');
    // 3. An adjustment request approved on the head-office screen — it stays pending.
    await frozen(call('POST', '/v1/inventory/adjustment-requests/ar-1/decide', 'u-mgr', { decision: 'approved', reason: 'saw it' }), 'adjustment approval');
    expect(((await call('GET', '/v1/inventory/adjustment-requests', 'u-owner')).body as { requests: { requestId: string; status: string }[] }).requests.find((r) => r.requestId === 'ar-1')?.status).toBe('pending');
    // 4. An ad-hoc count with a variance — not recorded; and an ad-hoc held count's approval — it stays held.
    await frozen(call('POST', '/v1/inventory/counts/c-new', 'u-c1', { productId: 'P1', locationId: 'S1', uom: 'EA', countedMinor: 90, reasonCode: 'cycle_count' }), 'ad-hoc count');
    await frozen(call('POST', '/v1/inventory/counts/c-held/decide', 'u-mgr', { decision: 'approved', reason: 'ok' }), 'held count approval');
    const counts = (await call('GET', '/v1/inventory/counts', 'u-owner', undefined, { productId: 'P1', locationId: 'S1' })).body as { counts: { countId: string; pendingApproval?: boolean }[] };
    expect(counts.counts.some((c) => c.countId === 'c-new')).toBe(false);
    expect(counts.counts.find((c) => c.countId === 'c-held')?.pendingApproval).toBe(true);
    // 5. A transfer's found-stock resolution (1 of the 2 missing turned up at S1).
    await frozen(call('POST', '/v1/warehouse/transfers/t1/shortfall/resolution', 'u-area', { lines: [{ productId: 'P1', batchId: null, foundMinor: 1 }], reasonCode: 'miscount', note: 'behind the cold-room door' }), 'transfer found stock');
    expect((await call('GET', '/v1/warehouse/transfers/t1', 'u-owner')).body).toMatchObject({ transferId: 't1', state: 'received' });
    expect(((await call('GET', '/v1/warehouse/transfers/t1', 'u-owner')).body as { shortfallResolution?: unknown }).shortfallResolution).toBeUndefined();
    // 6. A floor indent's found-stock resolution.
    await frozen(call('POST', '/v1/floor/indents/ind-1/issues/is-2/shortfall/resolution', 'u-area', { lines: [{ productId: 'P2', batchId: null, foundMinor: 1 }], reasonCode: 'miscount', note: 'under the trolley' }), 'indent found stock');
    const ind = (await call('GET', '/v1/floor/indents/ind-1', 'u-owner')).body as { issues: { issueId: string; state: string; shortfallResolution?: unknown }[] };
    expect(ind.issues.find((i) => i.issueId === 'is-2')?.shortfallResolution).toBeUndefined();
    expect(ind.issues.find((i) => i.issueId === 'is-2')?.state).toBe('received');
    // Nothing moved on any of them.
    expect([await onHand('P1'), await onHand('P2'), (await movementIds()).length]).toEqual([p1Before, p2Before, movesBefore]);
    expect((await call('GET', '/v1/inventory/count-plans/cp1', 'u-plan')).body).toMatchObject({ freezeBreaches: [] });
    // 7. OB-66 "A" (owner, 11 Oct 2026): a floor receipt with arrived-damaged units is NOT refused any more — the 5 GOOD units
    //    are received at once (on the shelf); the 1 damaged unit's write-off is HELD on the plan (not on hand, not written off).
    const dmg = await ok(call('POST', '/v1/floor/indents/ind-1/issues/is-1/receipt', 'u-floor2', { counted: [{ productId: 'P2', batchId: null, quantityMinor: 5, damagedMinor: 1 }] }), 'damaged receipt');
    expect((dmg.body as { heldWriteOffs: { planId: string; quantityMinor: number }[] }).heldWriteOffs.map((h) => [h.planId, h.quantityMinor])).toEqual([['cp1', 1]]);
    expect(await onHand('P2')).toBe(p2Before + 5);
    expect((await movementIds()).some((id) => id.startsWith('ind-1:is-1-damaged'))).toBe(false);
    expect((await call('GET', '/v1/inventory/count-plans/cp1', 'u-plan')).body).toMatchObject({ freezeBreaches: [], heldWriteOffs: [{ heldId: 'ind-1:is-1-damaged-1', state: 'awaiting_close' }] });

    // Controls: a product NOT counted at the same place is written off; the till's restock (not a frozen kind) goes through.
    await ok(call('POST', '/v1/inventory/write-off/wo-p3', 'u-mgr', { productId: 'P3', locationId: 'S1', qty: 1, uom: 'EA', lossType: 'damage', reasonCode: 'damage' }), 'write-off of an uncounted product');
    await ok(call('POST', `/v1/returns/held-stock/${quarantinedUnit.heldId}/decisions/d-rs`, 'u-owner', { decision: 'restock', reasonCode: 'qc_passed' }), 'restock');

    // ── BOX-RELAYED records: kept, and raised on the plan as freeze exceptions that need a recount ─────────────────
    // a. The manager's decision on the store screen approving ar-2 — it happened on the floor: it posts.
    const relayedAdj = await relayDecision('ap-ar2', 'stock_adjustment', 'ar-2', 'u-worker');
    expect(relayedAdj.body).toMatchObject({ applied: true, flags: [] });
    // b. …and approving the held ad-hoc count c-held2.
    expect((await relayDecision('ap-c2', 'stock_count', 'c-held2', 'u-c1')).body).toMatchObject({ applied: true, flags: [] });
    // c. The floor counts issue is-3 in on the device — 3 good, 1 damaged — relayed through the box. OB-66: the good units land;
    //    the damaged unit's write-off is HELD on the plan (no frozen movement written, so no breach and no recount for it).
    await ok(call('POST', '/v1/floor/indents/ind-2/issues/is-3/receipt/synced', 'u-box', { indentId: 'ind-2', issueId: 'is-3', counted: [{ productId: 'P2', batchId: null, quantityMinor: 3, damagedMinor: 1 }], receivedBy: 'u-floor2', at: new Date().toISOString(), storeId: 'S1', source: 'manager-screen' }), 'relayed damaged receipt');
    const moved = await movementIds();
    expect(moved.some((id) => id.includes('-damaged-'))).toBe(false);
    expect(await onHand('P2')).toBe(p2Before + 5 + 3);
    expect(moved).toEqual(expect.arrayContaining(['adj-req:ar-2', 'count:c-held2']));
    const v = (await call('GET', '/v1/inventory/count-plans/cp1', 'u-plan')).body as { freezeBreaches: { movementId: string; kind: string; productId: string }[]; lines: { productId: string; state: string; recountBecause: string[] }[]; heldWriteOffs: { heldId: string; relayed: boolean; state: string }[] };
    expect(v.freezeBreaches.map((b) => [b.movementId, b.kind, b.productId]).sort()).toEqual([['adj-req:ar-2', 'wasted', 'P1'], ['count:c-held2', 'wasted', 'P1']].sort());
    expect(v.heldWriteOffs.map((h) => [h.heldId, h.relayed, h.state])).toEqual([['ind-1:is-1-damaged-1', false, 'awaiting_close'], ['ind-2:is-3-damaged-1', true, 'awaiting_close']]);
    expect(v.lines.map((l) => [l.productId, l.state, l.recountBecause.includes('moved_during_freeze')])).toEqual([['P1', 'recount_required', true], ['P2', 'matched', false]]);
    // The plan cannot be approved over them.
    const early = await call('POST', '/v1/inventory/count-plans/cp1/approve', 'u-appr', { reason: 'done' });
    expect([403, 409]).toContain(early.status);
    expect(codeOf(await call('POST', '/v1/inventory/count-plans/cp1/approve', 'u-mgr2', { reason: 'done' }))).toBe('count_not_ready_to_approve');

    // ── The freeze is what refused them: once the plan is cancelled, the same write-off lands ───────────────────────
    const p2BeforeClose = await onHand('P2');
    const cancelled = await ok(call('POST', '/v1/inventory/count-plans/cp1/cancel', 'u-plan', { reason: 'test over' }), 'cancel');
    // OB-66: the cancelled count's held write-offs are applied once — the damaged units in and written off (on-hand unchanged).
    expect((cancelled.body as { heldWriteOffsApplied: { writeOffId: string; outcome: string }[] }).heldWriteOffsApplied.map((a) => [a.writeOffId, a.outcome])).toEqual([['held-ind-1:is-1-damaged-1', 'cancelled'], ['held-ind-2:is-3-damaged-1', 'cancelled']]);
    expect(await onHand('P2')).toBe(p2BeforeClose);
    expect(((await call('GET', '/v1/inventory/write-offs', 'u-owner')).body as { writeOffs: { id: string }[] }).writeOffs.map((w) => w.id)).toEqual(expect.arrayContaining(['held-ind-1:is-1-damaged-1', 'held-ind-2:is-3-damaged-1']));
    await ok(call('POST', '/v1/inventory/write-off/wo-1', 'u-mgr', { productId: 'P1', locationId: 'S1', qty: 1, uom: 'EA', lossType: 'damage', reasonCode: 'damage' }), 'write-off after the count');
    expect(await movementIds()).toContain('writeoff-wo-1');
  }, 180_000);
});
