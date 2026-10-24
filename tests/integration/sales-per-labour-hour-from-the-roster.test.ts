import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { useRestartableBackings } from '../support/p3-backings';
import { approvedRequestId } from '../support/approval-request';
import { actionDetails } from '../../services/identity/src/approval-requests';

// M25-FR-03 · OB-317 (owner, 23 Oct 2026: "sales per labour hour per department, from the roster plus department
// sales"). Through the real API, in memory and — with DATABASE_URL — on real PostgreSQL, with a cold restart.
//
// The labour hours are the rostered hours (a leaver on the grid is not labour); the sales are the banked bills' lines,
// each department's from the categories it owns. A rostered hour carries no department today, so each department's
// rate says "not attributed" — never a made-up figure — and the whole-store rate is given. A cashier reads nothing.

const backings = useRestartableBackings();
type Res = { status: number; body: unknown };
const DAY = '2030-05-20';

describe.each(backings)('sales per labour hour from the roster (OB-317) — on $name', ({ harness }) => {
  it('rostered hours over banked sales: whole store, and each department\'s sales with its hours not attributed', async () => {
    let h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    await h.provisionRole(T, 'u-cash', 'cashier');
    await h.provisionRole(T, 'u-it', 'platform_admin');
    const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, query?: Record<string, string>): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'POST' ? { idempotencyKey: `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });
    const ok = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };

    // The organisation: a store with two departments; dairy owns the dairy category.
    await ok(call('POST', '/v1/org/nodes/C1', 'u-it', { kind: 'company', name: 'SRE Retail' }), 'company');
    await ok(call('POST', '/v1/org/nodes/br-1', 'u-it', { kind: 'branch', name: 'Main store', parentId: 'C1', companyId: 'C1' }), 'branch');
    for (const [id, name] of [['D-dairy', 'Dairy'], ['D-grocery', 'Grocery']]) await ok(call('POST', `/v1/org/nodes/${id}`, 'u-it', { kind: 'department', name, parentId: 'br-1' }), id!);
    await ok(call('POST', '/v1/catalogue/tax-classes/04061000/rates/2017-07-01', 'u-owner', { rateBps: 500 }), 'tax');
    for (const [id, cat] of [['p-milk', 'dairy-cat'], ['p-rice', 'grocery-cat'], ['p-soap', 'home-cat']] as const) {
      await ok(call('POST', `/v1/catalogue/products/${id}/publish`, 'u-owner', { product: { sku: `SKU-${id}`, name: id, baseUom: 'ea', primaryCategoryId: cat, taxClass: '04061000', lifecycle: 'draft' }, categories: [{ categoryId: cat, name: cat, parentId: null }] }), `publish ${id}`);
    }
    for (const [dept, cat] of [['D-dairy', 'dairy-cat'], ['D-grocery', 'grocery-cat']] as const) {
      const link = { categoryIds: [cat], reason: `${dept} counter` };
      const approvalId = await approvedRequestId(h, T, 'u-it', 'u-owner', { kind: 'org_structure_change', subjectRef: `department:${dept}`, details: actionDetails(link, { departmentId: dept }) });
      await ok(call('POST', `/v1/org/departments/${dept}/categories`, 'u-it', { ...link, approvalId }), `link ${dept}`);
    }
    // The day's bills: milk ₹600, rice ₹300, soap ₹100 (soap's category belongs to no department).
    await ok(call('POST', '/v1/sales', 'u-owner', {
      saleId: 'S-1', receiptNumber: 'R-1', laneId: 'lane-1', locationId: 'br-1', cashierId: 'u-cash', tradingDay: DAY, committedAt: `${DAY}T10:00:00.000Z`, totalMinor: 100_000, currency: 'INR', packVersion: 1,
      lines: [
        { productId: 'p-milk', quantityMinor: 2, uom: 'ea', unitPriceMinor: 30_000, lineTotalMinor: 60_000 },
        { productId: 'p-rice', quantityMinor: 1, uom: 'ea', unitPriceMinor: 30_000, lineTotalMinor: 30_000 },
        { productId: 'p-soap', quantityMinor: 1, uom: 'ea', unitPriceMinor: 10_000, lineTotalMinor: 10_000 },
      ],
      tenders: [{ kind: 'cash', amountMinor: 100_000 }],
    }), 'sale');
    // The roster: two people on an 8-hour shift and one on a 4-hour shift — and a leaver still on the grid (not labour).
    for (const [id, name, active] of [['u-a', 'Asha', true], ['u-b', 'Bala', true], ['u-c', 'Chitra', true], ['u-gone', 'Gopi', false]] as const) {
      await ok(call('POST', `/v1/hr/workforce/employees/${id}`, 'u-mgr', { name, branchId: 'br-1', roles: ['cashier'], active }), `employee ${id}`);
    }
    await ok(call('POST', '/v1/hr/workforce/shifts/SH-1', 'u-mgr', { branchId: 'br-1', startsAt: `${DAY}T03:30:00.000Z`, endsAt: `${DAY}T11:30:00.000Z`, requiredRoles: [{ role: 'cashier', count: 2 }] }), 'shift 1');
    await ok(call('POST', '/v1/hr/workforce/shifts/SH-2', 'u-mgr', { branchId: 'br-1', startsAt: `${DAY}T11:30:00.000Z`, endsAt: `${DAY}T15:30:00.000Z`, requiredRoles: [{ role: 'cashier', count: 1 }] }), 'shift 2');
    for (const [shift, who] of [['SH-1', 'u-a'], ['SH-1', 'u-b'], ['SH-2', 'u-c'], ['SH-2', 'u-gone']] as const) {
      await ok(call('POST', `/v1/hr/workforce/shifts/${shift}/assignments/${who}`, 'u-mgr', { role: 'cashier' }), `assign ${who}`);
    }

    h = harness(h); // ── COLD RESTART ──
    expect((await call('GET', '/v1/hr/workforce/productivity', 'u-cash', undefined, { from: DAY, to: DAY })).status).toBe(403);
    const r = (await ok(call('GET', '/v1/hr/workforce/productivity', 'u-mgr', undefined, { from: DAY, to: DAY }), 'productivity')).body as {
      store: { salesMinor: number; labourMinutes: number; people: number; rate: { kind: string; minorPerHour?: number } };
      departments: { departmentId: string; salesMinor: number; labourMinutes: number | null; rate: { kind: string; because?: string } }[];
      unownedSalesMinor: number; hoursAttributed: boolean; reportedOnly: boolean;
    };
    // ₹1,000 over 20 rostered hours (8 + 8 + 4; the leaver's 4 are not labour) = ₹50 an hour.
    expect(r.store).toEqual({ salesMinor: 100_000, labourMinutes: 1_200, people: 3, rate: { kind: 'per_hour', minorPerHour: 5_000 } });
    expect(r.departments.map((d) => [d.departmentId, d.salesMinor, d.labourMinutes, d.rate.kind])).toEqual([['D-dairy', 60_000, null, 'not_meaningful'], ['D-grocery', 30_000, null, 'not_meaningful']]);
    expect(r.departments[0]!.rate.because).toBe('labour hours are not attributed to departments yet');
    expect([r.unownedSalesMinor, r.hoursAttributed, r.reportedOnly]).toEqual([10_000, false, true]);
    // Another day: nothing rostered, nothing sold — no rate, said so.
    const empty = (await ok(call('GET', '/v1/hr/workforce/productivity', 'u-mgr', undefined, { from: '2030-06-01', to: '2030-06-01' }), 'empty')).body as { store: { rate: { kind: string; because: string } } };
    expect(empty.store.rate).toEqual({ kind: 'not_meaningful', because: 'no rostered hours' });
    expect((await call('GET', '/v1/hr/workforce/productivity', 'u-mgr', undefined, { from: '2030-06-02', to: '2030-06-01' })).status).toBe(400);
  }, 120_000);
});
