import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { useRestartableBackings } from '../support/p3-backings';
import { P3, p3Shop, caller } from '../support/p3-purchase';
import { approvedRequestId } from '../support/approval-request';
import { actionDetails } from '../../services/identity/src/approval-requests';

/**
 * **FG-4 · M02-FR-02 "Role, branch, department, value-limit and state-based authorization" · SEC-03 · §28 · §35 "deny
 * server-side" — the scopes the re-audit found missing, derived on the server from the person's grants and refused by name:**
 *
 *   (a) a store manager limited to the dairy department cannot propose a markdown on rice, assign a task to someone whose
 *       home department is grocery (or who has none), or raise a role-routed daily task; inside dairy, they can;
 *   (b) a buyer limited to supplier sup-1 and the grocery category cannot quote, agree or order with sup-2, nor requisition
 *       or order a dairy product; inside the limits, they can;
 *   (c) a receiver limited to the back store wh-1 cannot book a delivery into wh-2, count there, or move stock out of it;
 *       at wh-1, they can;
 *   • each limit is set by two OTHER people through the engine (kind role_scope_change); nobody limits themselves; an
 *     unknown supplier is refused; a body cannot widen it; a person with no limit is untouched;
 *   • the limits survive a cold restart.
 * Synthetic data only.
 */

const backings = useRestartableBackings();
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
const iso = (ms: number): string => new Date(ms).toISOString();

describe.each(backings)('M02-FR-02 — department, supplier/category and location scopes — on $name', ({ harness }) => {
  it('refused by name outside the scope; allowed inside it; set by two other people; kept across a restart', async () => {
    let h = harness();
    const T = randomUUID();
    await p3Shop(h, T, 'sup-1', 'sup-2');
    let call = caller(h, T);
    const ok = async (p: ReturnType<typeof call>, what: string) => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
    for (const u of ['u-dm', 'u-buy', 'u-recv2', 'u-mgr']) await h.provisionRole(T, u, 'store_manager');
    for (const u of ['u-a', 'u-b']) await h.provisionRole(T, u, 'cashier');
    // The places: a second back store inside store-1, and two departments.
    await ok(call('POST', '/v1/org/nodes/wh-2', 'u-org-setup', { kind: 'warehouse', name: 'Cold room', parentId: P3.STORE, companyId: 'C-FIXTURE' }), 'wh-2');
    for (const d of ['D-dairy', 'D-grocery']) await ok(call('POST', `/v1/org/nodes/${d}`, 'u-org-setup', { kind: 'department', name: d, parentId: P3.STORE, companyId: 'C-FIXTURE' }), d);
    // The products and their categories; the departments own the categories (the owner approves the structure).
    await ok(call('POST', '/v1/catalogue/tax-classes/04061000/rates/2017-07-01', P3.OWNER, { rateBps: 500 }), 'tax');
    for (const [id, cat] of [['p-milk', 'dairy-cat'], ['p-rice', 'grocery-cat']] as const) {
      await ok(call('POST', `/v1/catalogue/products/${id}/publish`, P3.OWNER, { product: { sku: `SKU-${id}`, name: id, baseUom: 'ea', primaryCategoryId: cat, taxClass: '04061000', lifecycle: 'draft' }, categories: [{ categoryId: cat, name: cat, parentId: null }] }), `publish ${id}`);
    }
    for (const [dept, cat] of [['D-dairy', 'dairy-cat'], ['D-grocery', 'grocery-cat']] as const) {
      const link = { categoryIds: [cat], reason: `${dept} counter` };
      const approvalId = await approvedRequestId(h, T, P3.OWNER, 'u-org-setup', { kind: 'org_structure_change', subjectRef: `department:${dept}`, details: actionDetails(link, { departmentId: dept }) });
      await ok(call('POST', `/v1/org/departments/${dept}/categories`, P3.OWNER, { ...link, approvalId }), `link ${dept}`);
    }
    // Staff records: u-a's home department is dairy, u-b's grocery.
    for (const u of ['u-a', 'u-b']) await ok(call('POST', `/v1/hr/workforce/employees/${u}`, 'u-mgr', { name: u, branchId: P3.STORE, roles: ['cashier'], active: true }), `employee ${u}`);
    await ok(call('POST', '/v1/hr/workforce/employees/u-a/home-department', 'u-mgr', { departmentId: 'D-dairy' }), 'home a');
    await ok(call('POST', '/v1/hr/workforce/employees/u-b/home-department', 'u-mgr', { departmentId: 'D-grocery' }), 'home b');

    // ── The limits: another manager asks, the owner approves — never the person limited.
    const dept = { departments: ['D-dairy'], reason: 'runs the dairy counter' };
    const deptId = await approvedRequestId(h, T, 'u-mgr', P3.OWNER, { kind: 'department_scope_change', subjectRef: 'u-dm/store_manager', details: actionDetails(dept, { userId: 'u-dm', roleId: 'store_manager' }) });
    await ok(call('POST', '/v1/identity/department-scopes/u-dm/store_manager', 'u-mgr', { ...dept, approvalId: deptId }), 'dept scope');
    const limit = async (userId: string, dimension: string, values: string[], reason: string) => {
      const b = { values, reason };
      const approvalId = await approvedRequestId(h, T, 'u-mgr', P3.OWNER, { kind: 'role_scope_change', subjectRef: `${userId}/store_manager/${dimension}`, details: actionDetails(b, { userId, roleId: 'store_manager', dimension }) });
      return call('POST', `/v1/identity/role-scopes/${userId}/store_manager/${dimension}`, 'u-mgr', { ...b, approvalId });
    };
    // Nobody limits themselves; an unknown supplier and an unknown dimension are refused; nothing without an approval.
    const selfB = { values: ['sup-1'], reason: 'mine' };
    const selfId = await approvedRequestId(h, T, 'u-buy', P3.OWNER, { kind: 'role_scope_change', subjectRef: 'u-buy/store_manager/suppliers', details: actionDetails(selfB, { userId: 'u-buy', roleId: 'store_manager', dimension: 'suppliers' }) });
    expect(codeOf(await call('POST', '/v1/identity/role-scopes/u-buy/store_manager/suppliers', 'u-buy', { ...selfB, approvalId: selfId }))).toBe('scoping_yourself');
    expect(codeOf(await limit('u-buy', 'suppliers', ['sup-nobody'], 'x'))).toBe('unknown_supplier');
    expect(codeOf(await call('POST', '/v1/identity/role-scopes/u-buy/store_manager/colours', 'u-mgr', { values: ['red'], reason: 'x', approvalId: 'a' }))).toBe('no_such_scope');
    expect(codeOf(await call('POST', '/v1/identity/role-scopes/u-buy/store_manager/suppliers', 'u-mgr', { values: ['sup-1'], reason: 'x' }))).toBe('not_readable_as_a_role_scope');
    await ok(limit('u-buy', 'suppliers', ['sup-1'], 'buys from sup-1 only'), 'supplier scope');
    await ok(limit('u-buy', 'categories', ['grocery-cat'], 'buys grocery only'), 'category scope');
    await ok(limit('u-recv2', 'locations', ['wh-1'], 'receives at the back store only'), 'location scope');
    const listed = (await ok(call('GET', '/v1/identity/role-scopes', P3.OWNER), 'list')).body as { scopes: { userId: string; dimension: string; values: string[] }[] };
    expect(listed.scopes.map((s) => `${s.userId}:${s.dimension}:${s.values.join('+')}`).sort()).toEqual(['u-buy:categories:grocery-cat', 'u-buy:suppliers:sup-1', 'u-recv2:locations:wh-1']);

    h = harness(h); // ── COLD RESTART: every limit is read back from the store ──
    call = caller(h, T);

    // (a) Department scope: markdowns and tasks.
    const markdown = (who: string, productId: string) => call('POST', '/v1/pricing/markdown/propose', who, { items: [{ productId, remainingShelfLifeDays: 2, onHandMinor: 10, currentPriceMinor: 5_000, avgDailyDemand: 1 }] });
    expect(codeOf(await markdown('u-dm', 'p-rice'))).toBe('outside_your_department_scope');
    await ok(markdown('u-dm', 'p-milk'), 'dairy markdown');
    await ok(markdown('u-mgr', 'p-rice'), 'an unlimited manager');
    const assign = (who: string, id: string, assignedTo: string) => call('POST', `/v1/hr/workforce/assigned-tasks/${id}`, who, { branchId: P3.STORE, title: 'Face up the chiller', assignedTo, dueAt: iso(Date.now() + 3_600_000), critical: false, evidenceRequired: false });
    expect(codeOf(await assign('u-dm', 't-1', 'u-b'))).toBe('outside_your_department_scope');
    expect(codeOf(await assign('u-dm', 't-2', 'u-cash'))).toBe('outside_your_department_scope'); // no home department on record
    await ok(assign('u-dm', 't-3', 'u-a'), 'a task in dairy');
    expect(codeOf(await call('POST', '/v1/hr/workforce/tasks/d-1', 'u-dm', { description: 'Open the shutters', forRole: 'cashier', dueAt: iso(Date.now() + 3_600_000), critical: false }))).toBe('outside_your_department_scope');

    // (b) Supplier / category scope: requisition, quote, blanket agreement, purchase order.
    const reqn = (who: string, id: string, productId: string) => call('POST', `/v1/purchase/requisitions/${id}`, who, { currency: 'INR', lines: [{ productId, quantity: 5 }] });
    expect(codeOf(await reqn('u-buy', 'r-milk', 'p-milk'))).toBe('outside_your_category_scope');
    await ok(reqn('u-buy', 'r-rice', 'p-rice'), 'rice requisition');
    const quote = (supplierId: string) => call('POST', `/v1/purchase/requisitions/r-rice/quotes/q-${supplierId}`, 'u-buy', { supplierId, lines: [{ productId: 'p-rice', unitCost: { minor: 4_000, currency: 'INR' }, leadTimeDays: 2 }] });
    expect(codeOf(await quote('sup-2'))).toBe('outside_your_supplier_scope');
    await ok(quote('sup-1'), 'sup-1 quote');
    const po = (id: string, supplierId: string, productId: string) => call('POST', `/v1/purchase/orders/${id}`, 'u-buy', { supplierId, deliverToLocationId: P3.STORE, lines: [{ productId, orderedQty: 5, unitCost: { minor: 4_000, currency: 'INR' } }] });
    expect(codeOf(await po('po-x', 'sup-2', 'p-rice'))).toBe('outside_your_supplier_scope');
    expect(codeOf(await po('po-y', 'sup-1', 'p-milk'))).toBe('outside_your_category_scope');
    await ok(po('po-ok', 'sup-1', 'p-rice'), 'an order inside both limits');
    expect(codeOf(await call('POST', '/v1/purchase/blanket-orders/bpo-2', 'u-buy', { supplierId: 'sup-2', currency: 'INR', ceilingMinor: 100_000, validFrom: '2026-01-01', validTo: '2030-12-31', deliverToLocationId: P3.STORE, lines: [{ productId: 'p-rice', agreedUnitCost: { minor: 4_000, currency: 'INR' } }] }))).toBe('outside_your_supplier_scope');
    await ok(call('POST', '/v1/purchase/orders/po-mgr', P3.BUYER, { supplierId: 'sup-2', deliverToLocationId: P3.STORE, lines: [{ productId: 'p-milk', orderedQty: 5, unitCost: { minor: 4_000, currency: 'INR' } }] }), 'an unlimited buyer');

    // (c) Location scope inside the branch: goods receipt, count, transfer.
    const grn = (id: string, warehouseId: string) => call('POST', `/v1/inventory/goods-receipt/${id}`, 'u-recv2', {
      warehouseId, receivedOnDate: '2026-10-20', currency: 'INR', lines: [{ lineId: 'L1', productId: 'p-rice', orderedMinor: 5, countedMinor: 5, uom: 'ea', unitCost: { minor: 4_000, currency: 'INR' }, condition: 'good' }],
    });
    expect(codeOf(await grn('grn-x', 'wh-2'))).toBe('outside_your_location_scope');
    await ok(grn('grn-ok', 'wh-1'), 'a receipt at wh-1');
    expect(codeOf(await call('POST', '/v1/inventory/counts/c-x', 'u-recv2', { productId: 'p-rice', locationId: 'wh-2', uom: 'ea', countedMinor: 1, reasonCode: 'cycle' }))).toBe('outside_your_location_scope');
    expect(codeOf(await call('POST', '/v1/warehouse/transfers/tr-x', 'u-recv2', { fromLocationId: 'wh-1', toLocationId: 'wh-2', lines: [{ productId: 'p-rice', quantityMinor: 1, uom: 'ea' }] }))).toBe('outside_your_location_scope');
    // The access review shows each limit on the role it narrows.
    const review = (await ok(call('GET', '/v1/identity/access-review', P3.OWNER), 'access review')).body as { rows: { userId: string; roles: { roleId: string; supplierScope: unknown; categoryScope: unknown; locationScope: unknown }[] }[] };
    expect(review.rows.find((r) => r.userId === 'u-buy')!.roles).toEqual([expect.objectContaining({ roleId: 'store_manager', supplierScope: ['sup-1'], categoryScope: ['grocery-cat'], locationScope: 'all' })]);
    expect(review.rows.find((r) => r.userId === 'u-recv2')!.roles).toEqual([expect.objectContaining({ locationScope: ['wh-1'], supplierScope: 'all' })]);
    // A body naming its own scope does not widen it.
    expect(codeOf(await call('POST', '/v1/inventory/goods-receipt/grn-y', 'u-recv2', { warehouseId: 'wh-2', locationScope: 'all', receivedOnDate: '2026-10-20', currency: 'INR', lines: [{ lineId: 'L1', productId: 'p-rice', orderedMinor: 5, countedMinor: 5, uom: 'ea', unitCost: { minor: 4_000, currency: 'INR' }, condition: 'good' }] }))).toBe('outside_your_location_scope');
  }, 180_000);
});
