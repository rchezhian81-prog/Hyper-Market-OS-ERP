import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ApiHarness } from '../support/api-harness';
import { r3OpsBackings, tenantClient } from '../support/r3-ops-backings';

/**
 * D-14 (R3, OB-147 "A", signed sentence OB-188) — on the real API, in memory and on PostgreSQL, with a cold restart:
 * "a product with on-hand > 0 and no sale for longer than its expected gap (from its own sales rate) is raised as a
 * suspected phantom. It proposes a targeted count task. A count confirming zero posts a compensating adjustment through
 * the existing approval path. It never auto-adjusts stock."
 */
const backings = r3OpsBackings();
const STORE = 'store-01';
const AS_OF = '2030-06-28';
const GROCERY = { categoryId: 'grocery', name: 'Grocery', parentId: null };

describe.each(backings)('a suspected phantom raises a count, not an adjustment — on $name (D-14)', ({ harness, restart }) => {
  it('owner minimum → suspects by own selling rate → targeted count → zero counted → pending request → second person posts it', async () => {
    let h: ApiHarness = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    await h.provisionRole(T, 'u-mgr2', 'store_manager');
    await h.provisionRole(T, 'u-till', 'cashier');
    const { req, ok, code } = tenantClient(() => h, T);

    await ok(req('POST', '/v1/catalogue/tax-classes/10063000/rates/2017-07-01', { rateBps: 500 }), 'tax');
    for (const [id, sku, name] of [['p-rice', 'SKU-RICE', 'Rice 5kg'], ['p-ghost', 'SKU-GHOST', 'Ghee 1L'], ['p-curd', 'SKU-CURD', 'Curd 400g']] as const) {
      await ok(req('POST', `/v1/catalogue/products/${id}/publish`, { product: { sku, name, baseUom: 'ea', primaryCategoryId: 'grocery', taxClass: '10063000', lifecycle: 'draft' }, categories: [GROCERY] }), `publish ${id}`);
    }
    for (const [p, q] of [['p-rice', 40], ['p-ghost', 6]] as const) {
      await ok(req('POST', '/v1/inventory/movements', { movementId: `rx-${p}`, productId: p, locationId: STORE, kind: 'received', quantityMinor: q, uom: 'ea', occurredAt: '2030-05-01T00:00:00.000Z', enteredBy: 'u-owner', unitCostMinor: 5_000 }), `receive ${p}`);
    }
    // Rice sells every day from 1 to 24 June; ghee never sells; curd has no stock.
    for (let d = 1; d <= 24; d++) {
      const day = `2030-06-${String(d).padStart(2, '0')}`;
      await ok(req('POST', '/v1/sales', {
        saleId: `S-${d}`, receiptNumber: `R-${d}`, laneId: 'lane-1', locationId: STORE, cashierId: 'u-owner', tradingDay: day, committedAt: `${day}T10:00:00Z`,
        totalMinor: 9_000, currency: 'INR', packVersion: 1,
        lines: [{ productId: 'p-rice', quantityMinor: 1, uom: 'ea', unitPriceMinor: 9_000, lineTotalMinor: 9_000 }],
        tenders: [{ kind: 'cash', amountMinor: 9_000 }],
      }), `sale ${d}`);
    }
    const osa = async () => (await req('GET', '/v1/inventory/on-shelf-availability', undefined, 'u-owner', { asOf: AS_OF })).body as {
      state: string; suspects: { productId: string; daysWithoutSale: number; basis: string; thresholdDays: number; proposedCountTask: { taskId: string } | null; openCountTask: { taskId: string } | null }[]; changesStock: boolean;
    };
    const onHand = async (p: string) => ((await req('GET', '/v1/inventory/availability', undefined, 'u-owner', { productId: p })).body as { rows: { onHandMinor: number }[] }).rows[0]?.onHandMinor;

    // No owner minimum yet: nothing judged, and said.
    expect((await osa()).state).toBe('minimum_not_set');
    expect(code(await req('POST', '/v1/inventory/on-shelf-availability/count-tasks/t-early', { productId: 'p-ghost', locationId: STORE }, 'u-mgr', { asOf: AS_OF }))).toBe('osa_minimum_not_set');
    // Only the owner sets the minimum (OB-147).
    expect((await req('POST', '/v1/inventory/on-shelf-availability/minimum', { minimumDays: 3 }, 'u-mgr')).status).toBe(403);
    expect((await req('POST', '/v1/inventory/on-shelf-availability/minimum', { minimumDays: 0 })).status).toBe(400);
    await ok(req('POST', '/v1/inventory/on-shelf-availability/minimum', { minimumDays: 3 }), 'minimum');

    const list = await osa();
    expect(list.state).toBe('judged');
    expect(list.changesStock).toBe(false);
    expect(list.suspects.map((s) => s.productId)).toEqual(['p-ghost', 'p-rice']);
    expect(list.suspects.find((s) => s.productId === 'p-rice')).toMatchObject({ daysWithoutSale: 4, thresholdDays: 3 });
    expect(list.suspects.find((s) => s.productId === 'p-ghost')).toMatchObject({ basis: 'no_sale_in_window' });

    // A cashier cannot raise the count; something not suspected cannot be raised.
    expect((await req('POST', '/v1/inventory/on-shelf-availability/count-tasks/t-1', { productId: 'p-ghost', locationId: STORE }, 'u-till', { asOf: AS_OF })).status).toBe(403);
    expect(code(await req('POST', '/v1/inventory/on-shelf-availability/count-tasks/t-x', { productId: 'p-curd', locationId: STORE }, 'u-mgr', { asOf: AS_OF }))).toBe('not_a_suspected_phantom');
    const ghostTask = list.suspects.find((s) => s.productId === 'p-ghost')!.proposedCountTask!.taskId;
    await ok(req('POST', `/v1/inventory/on-shelf-availability/count-tasks/${ghostTask}`, { productId: 'p-ghost', locationId: STORE }, 'u-mgr', { asOf: AS_OF }), 'raise ghee');
    await ok(req('POST', '/v1/inventory/on-shelf-availability/count-tasks/t-rice', { productId: 'p-rice', locationId: STORE }, 'u-mgr', { asOf: AS_OF }), 'raise rice');
    expect(code(await req('POST', '/v1/inventory/on-shelf-availability/count-tasks/t-dup', { productId: 'p-rice', locationId: STORE }, 'u-mgr', { asOf: AS_OF }))).toBe('osa_count_already_open');
    expect((await osa()).suspects.find((s) => s.productId === 'p-ghost')!.openCountTask!.taskId).toBe(ghostTask);
    expect(await onHand('p-ghost')).toBe(6); // raising a task moved nothing

    // ── COLD RESTART ─────────────────────────────────────────────────────────────────────────────────────────────
    h = restart(h);

    // The count confirms zero. A difference needs a reason from the fixed list; then a PENDING request is raised.
    expect(code(await req('POST', `/v1/inventory/on-shelf-availability/count-tasks/${ghostTask}/count`, { countedMinor: 0 }, 'u-mgr'))).toBe('osa_count_needs_a_reason');
    const counted = (await ok(req('POST', `/v1/inventory/on-shelf-availability/count-tasks/${ghostTask}/count`, { countedMinor: 0, reasonCode: 'theft_suspected', note: 'shelf empty, none in back' }, 'u-mgr'), 'count ghee')).body as {
      task: { state: string; expectedMinor: number }; stockChanged: boolean; adjustmentRequest: { requestId: string; status: string };
    };
    expect(counted).toMatchObject({ stockChanged: false, task: { state: 'adjustment_requested', expectedMinor: 6 }, adjustmentRequest: { status: 'pending' } });
    expect(await onHand('p-ghost')).toBe(6); // never auto-adjusted

    // It is on the EXISTING approval path: listed pending; the counter cannot approve it; a second manager posts it.
    const pending = (await req('GET', '/v1/inventory/adjustment-requests', undefined, 'u-owner', { status: 'pending' })).body as { requests: { requestId: string; deltaMinor: number; source: string }[] };
    expect(pending.requests).toEqual([expect.objectContaining({ requestId: counted.adjustmentRequest.requestId, deltaMinor: -6, source: 'on-shelf-availability' })]);
    const decide = `/v1/inventory/adjustment-requests/${counted.adjustmentRequest.requestId}/decide`;
    expect(code(await req('POST', decide, { decision: 'approved', reason: 'checked' }, 'u-mgr'))).toBe('self_approval');
    expect(await onHand('p-ghost')).toBe(6);
    await ok(req('POST', decide, { decision: 'approved', reason: 'shelf and back store checked' }, 'u-mgr2'), 'approve');
    expect(await onHand('p-ghost')).toBe(0); // one compensating movement, by a second person

    // Rice is counted as the books say: closed "stock confirmed", no request, nothing moves.
    const rice = (await ok(req('POST', '/v1/inventory/on-shelf-availability/count-tasks/t-rice/count', { countedMinor: 16 }, 'u-mgr'), 'count rice')).body as { task: { state: string }; adjustmentRequest?: unknown };
    expect(rice.task.state).toBe('stock_confirmed');
    expect(rice.adjustmentRequest).toBeUndefined();
    expect(await onHand('p-rice')).toBe(16);
    const tasks = (await req('GET', '/v1/inventory/on-shelf-availability/count-tasks')).body as { tasks: { taskId: string; state: string; adjustmentStatus: string | null }[]; open: number };
    expect(tasks.open).toBe(0);
    expect(tasks.tasks.find((t) => t.taskId === ghostTask)!.adjustmentStatus).toBe('posted');
    // Ghee now has no stock, so it is no longer a suspect.
    expect((await osa()).suspects.map((s) => s.productId)).toEqual(['p-rice']);
  });
});
