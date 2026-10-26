import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { useRestartableBackings } from '../support/p3-backings';
import { P3, p3Shop, caller } from '../support/p3-purchase';
import { approvedRequestId } from '../support/approval-request';
import { actionDetails } from '../../services/identity/src/approval-requests';
import { makeEvent } from '../../packages/contracts/src/event';
import { RELABEL_STREAM } from '../../services/api/src/lp-workforce-adapters';

/**
 * **FU-2 · M02-FR-02 · SEC-03 · §28 — the FG-4 scopes now reach the paths FG-4 left out, derived on the server from the
 * person's grants and refused by name:**
 *
 *   • a receipt and a count the STORE COMPUTER relays (`…/synced`) are judged on the person who booked it in or counted it
 *     (named in the record) — their location scope, from THEIR grants, not the box's; refused by name, so the box keeps it
 *     as a visible dead letter; a relayed record by an unlimited person, or at their own place, goes through;
 *   • a requisition made FROM a replenishment proposal or FROM A02 drafts is judged on its products' categories like a
 *     typed one — outside: refused by name before anything is raised; inside: head office's own rule answers;
 *   • closing a shelf relabel task is judged on the product's department and the shelf place for the closer;
 *   • a cold restart reads the same.
 * Synthetic data only.
 */

const backings = useRestartableBackings();
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
const AT = new Date().toISOString();

describe.each(backings)('M02-FR-02 — scopes on relayed records, sourced requisitions and relabel tasks — on $name', ({ harness }) => {
  it('refused by name outside the scope, allowed inside it, across a cold restart', async () => {
    let h = harness();
    const T = randomUUID();
    await p3Shop(h, T, 'sup-1');
    let call = caller(h, T);
    const ok = async (p: ReturnType<typeof call>, what: string) => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
    for (const u of ['u-dm', 'u-buy', 'u-recv2', 'u-mgr']) await h.provisionRole(T, u, 'store_manager');
    await h.provisionRole(T, 'u-box', 'store_computer', [P3.STORE]);
    await ok(call('POST', '/v1/org/nodes/wh-2', 'u-org-setup', { kind: 'warehouse', name: 'Cold room', parentId: P3.STORE, companyId: 'C-FIXTURE' }), 'wh-2');
    await ok(call('POST', '/v1/org/nodes/D-dairy', 'u-org-setup', { kind: 'department', name: 'Dairy', parentId: P3.STORE, companyId: 'C-FIXTURE' }), 'dept');
    await ok(call('POST', '/v1/catalogue/tax-classes/04061000/rates/2017-07-01', P3.OWNER, { rateBps: 500 }), 'tax');
    for (const [id, cat] of [['p-milk', 'dairy-cat'], ['p-rice', 'grocery-cat']] as const) {
      await ok(call('POST', `/v1/catalogue/products/${id}/publish`, P3.OWNER, { product: { sku: `SKU-${id}`, name: id, baseUom: 'ea', primaryCategoryId: cat, taxClass: '04061000', lifecycle: 'draft' }, categories: [{ categoryId: cat, name: cat, parentId: null }] }), `publish ${id}`);
    }
    const link = { categoryIds: ['dairy-cat'], reason: 'dairy counter' };
    const linkId = await approvedRequestId(h, T, P3.OWNER, 'u-org-setup', { kind: 'org_structure_change', subjectRef: 'department:D-dairy', details: actionDetails(link, { departmentId: 'D-dairy' }) });
    await ok(call('POST', '/v1/org/departments/D-dairy/categories', P3.OWNER, { ...link, approvalId: linkId }), 'link dairy');

    // The limits — another manager asks, the owner approves.
    const dept = { departments: ['D-dairy'], reason: 'runs the dairy counter' };
    const deptId = await approvedRequestId(h, T, 'u-mgr', P3.OWNER, { kind: 'department_scope_change', subjectRef: 'u-dm/store_manager', details: actionDetails(dept, { userId: 'u-dm', roleId: 'store_manager' }) });
    await ok(call('POST', '/v1/identity/department-scopes/u-dm/store_manager', 'u-mgr', { ...dept, approvalId: deptId }), 'dept scope');
    const limit = async (userId: string, dimension: string, values: string[], reason: string) => {
      const b = { values, reason };
      const approvalId = await approvedRequestId(h, T, 'u-mgr', P3.OWNER, { kind: 'role_scope_change', subjectRef: `${userId}/store_manager/${dimension}`, details: actionDetails(b, { userId, roleId: 'store_manager', dimension }) });
      return call('POST', `/v1/identity/role-scopes/${userId}/store_manager/${dimension}`, 'u-mgr', { ...b, approvalId });
    };
    await ok(limit('u-buy', 'categories', ['grocery-cat'], 'buys grocery only'), 'category scope');
    await ok(limit('u-recv2', 'locations', ['wh-1'], 'works the back store only'), 'location scope');

    // Two relabel tasks raised at store-1 (as a price change raises them): milk at wh-1, rice at wh-2.
    for (const [taskId, productId, locationId] of [['rl-milk', 'p-milk', 'wh-1'], ['rl-rice', 'p-rice', 'wh-2']] as const) {
      await h.store.append(T, RELABEL_STREAM, makeEvent({
        id: `RelabelTaskRaised-${taskId}`, type: 'RelabelTaskRaised', occurredAt: AT, idempotencyKey: `RelabelTaskRaised-${T}-${taskId}`, source: 'test/setup',
        payload: { taskId, branchId: P3.STORE, productId, locationId, priceMinor: 5_000, dueAt: AT, because: 'price_change', sourceRef: `price-change:${productId}`, raisedAt: AT, assignee: { to: 'store_manager', departmentId: null, because: 'no_champion_named' } },
      }));
    }

    h = harness(h); // ── COLD RESTART: every limit and task is read back from the store ──
    call = caller(h, T);

    // ── 1 · Relayed by the store computer: judged on the person named, from THEIR grants.
    // The store computer's credential carries its one store (OB-54) — named here, as the harness forgets it on a restart.
    const box = (path: string, body: unknown, key: string) => h.request({ method: 'POST', path, userId: 'u-box', tenantId: T, branchId: P3.STORE, idempotencyKey: key, body });
    const relayedReceipt = (grnId: string, warehouseId: string, receivedBy: string) => box(`/v1/inventory/goods-receipt/${grnId}/synced`, {
      grnId, number: `DN-${grnId}`, poId: null, lineCount: 1, warehouseId, receivedBy, receivedAt: AT,
      lines: [{ productId: 'p-rice', quantityMinor: 5, uom: 'ea', batchId: null }], storeId: P3.STORE, source: 'manager-screen',
    }, `relay-${grnId}`);
    const outside = await relayedReceipt('g-out', 'wh-2', 'u-recv2');
    expect([outside.status, codeOf(outside)], JSON.stringify(outside.body)).toEqual([403, 'outside_your_location_scope']);
    expect((outside.body as { error: { whatHappened: string; nextSafeAction: string } }).error.whatHappened).toMatch(/u-recv2 recorded this at wh-2/);
    expect((outside.body as { error: { nextSafeAction: string } }).error.nextSafeAction).toMatch(/Do not discard it at the store/);
    expect((await call('GET', '/v1/inventory/goods-receipt/g-out', P3.OWNER)).status).toBe(404); // nothing was booked
    await ok(relayedReceipt('g-in', 'wh-1', 'u-recv2'), 'at their own place');
    await ok(relayedReceipt('g-free', 'wh-2', P3.RECEIVER), 'an unlimited receiver');
    const relayedCount = (countId: string, locationId: string, counterId: string) => box(`/v1/inventory/counts/${countId}/synced`, {
      countId, productId: 'p-rice', locationId, uom: 'ea', countedMinor: 5, reasonCode: 'cycle', counterId, at: AT, storeId: P3.STORE, source: 'manager-screen',
    }, `count-${countId}`);
    const countOut = await relayedCount('c-out', 'wh-2', 'u-recv2');
    expect([countOut.status, codeOf(countOut)]).toEqual([403, 'outside_your_location_scope']);
    expect((await relayedCount('c-in', 'wh-1', 'u-recv2')).status).toBeLessThan(300);

    // ── 2 · Requisitions from replenishment or drafts: the products' categories.
    const fromRep = (who: string, id: string, productId: string) => call('POST', `/v1/purchase/requisitions/${id}/from-replenishment`, who, {
      storeId: P3.STORE, currency: 'INR', items: [{ productId, onHandMinor: 0, reorderPointMinor: 10, targetMinor: 20 }], accept: [{ productId }],
    });
    expect(codeOf(await fromRep('u-buy', 'rq-milk', 'p-milk'))).toBe('outside_your_category_scope');
    expect(codeOf(await fromRep('u-buy', 'rq-rice', 'p-rice'))).not.toBe('outside_your_category_scope'); // inside: head office's own rule answers
    const fromDrafts = (who: string, id: string, productId: string) => call('POST', `/v1/purchase/requisitions/${id}/from-drafts`, who, { currency: 'INR', lines: [{ proposalId: 'a02-none', productId, quantity: 5 }] });
    expect(codeOf(await fromDrafts('u-buy', 'rd-milk', 'p-milk'))).toBe('outside_your_category_scope');
    expect(codeOf(await fromDrafts('u-buy', 'rd-rice', 'p-rice'))).toBe('draft_unknown'); // past the scope, to the draft register
    expect((await call('GET', '/v1/purchase/requisitions', P3.OWNER)).body).not.toMatchObject({ requisitions: [expect.objectContaining({ requisitionId: 'rq-milk' })] });

    // ── 3 · Closing a relabel task: the product's department, and the shelf place.
    const done = (who: string, taskId: string) => call('POST', `/v1/pricing/relabel-tasks/${taskId}/done`, who, { evidenceRef: `photo-${taskId}`, shelfPriceMinor: 5_000 }, `done-${taskId}-${who}`);
    expect(codeOf(await done('u-dm', 'rl-rice'))).toBe('outside_your_department_scope');
    expect(codeOf(await done('u-recv2', 'rl-rice'))).toBe('outside_your_location_scope');
    await ok(done('u-dm', 'rl-milk'), 'dairy label, by the dairy manager');
    await ok(done('u-mgr', 'rl-rice'), 'an unlimited store manager');
  }, 180_000);
});
