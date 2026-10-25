import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { useRestartableBackings } from '../support/p3-backings';
import { approvedRequestId } from '../support/approval-request';
import { actionDetails } from '../../services/identity/src/approval-requests';
import { storeRules } from '../support/store-rules';

// D11-FR-03 · OB-358 (owner, 24 Oct 2026, in writing: "the department's floor champion; if none is named, the store
// manager"). Through the real API, in memory and — with DATABASE_URL — on real PostgreSQL, with cold restarts.
//
// A price change raises one relabel task per shelf place (as built). Each task now GOES TO a person, decided when it is
// raised and kept on it: the floor champion of the department that owns the product at that store; else the store manager
// — when no champion is named, when the champion has left the staff list, or when no department of that store owns the
// product — each said why. The champion reads their own tasks with the permission they complete their own tasks with (the
// My tasks page); the store manager reads theirs the same way; a cashier who is nobody's champion sees none of them.

const backings = useRestartableBackings();
type Res = { status: number; body: unknown };
interface Row { taskId: string; productId: string; assignee: Record<string, unknown> | null; assignedToMe: boolean; storeManagers?: string[] }

describe.each(backings)('a relabel task goes to the floor champion, else the store manager (OB-358) — on $name', ({ harness }) => {
  it('champion named → theirs; none named / left / no department → the store manager, each said; "mine" for each; a restart keeps it', async () => {
    let h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-mgr', 'store_manager', ['br-1']);
    await h.provisionRole(T, 'u-asha', 'cashier', ['br-1']);
    await h.provisionRole(T, 'u-bala', 'cashier', ['br-1']);
    await h.provisionRole(T, 'u-it', 'platform_admin');
    const scoped = new Set(['u-mgr', 'u-asha', 'u-bala']);
    const call = (method: 'GET' | 'POST' | 'PUT', path: string, userId: string, body?: unknown, query?: Record<string, string>): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(scoped.has(userId) ? { branchId: 'br-1' } : {}), ...(method === 'GET' ? {} : { idempotencyKey: `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });
    const ok = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };

    // The store, its two departments (dairy owns the dairy category, grocery the grocery one), and a second store whose
    // dairy department is never this store's.
    await ok(call('POST', '/v1/org/nodes/C1', 'u-it', { kind: 'company', name: 'SRE Retail' }), 'company');
    await ok(call('POST', '/v1/org/nodes/br-1', 'u-it', { kind: 'branch', name: 'Main store', parentId: 'C1', companyId: 'C1' }), 'branch');
    await storeRules(h, T, 'u-owner', 'br-1', 0);
    for (const [id, name] of [['D-dairy', 'Dairy'], ['D-grocery', 'Grocery']]) await ok(call('POST', `/v1/org/nodes/${id}`, 'u-it', { kind: 'department', name, parentId: 'br-1' }), id!);
    await ok(call('POST', '/v1/catalogue/tax-classes/04061000/rates/2017-07-01', 'u-owner', { rateBps: 500 }), 'tax');
    for (const [id, cat] of [['p-milk', 'dairy-cat'], ['p-salt', 'grocery-cat'], ['p-soap', 'home-cat']] as const) {
      await ok(call('POST', `/v1/catalogue/products/${id}/publish`, 'u-owner', { product: { sku: `SKU-${id}`, name: id, baseUom: 'each', primaryCategoryId: cat, taxClass: '04061000', lifecycle: 'draft' }, categories: [{ categoryId: cat, name: cat, parentId: null }] }), `publish ${id}`);
    }
    for (const [dept, cat] of [['D-dairy', 'dairy-cat'], ['D-grocery', 'grocery-cat']] as const) {
      const link = { categoryIds: [cat], reason: `${dept} counter` };
      const approvalId = await approvedRequestId(h, T, 'u-it', 'u-owner', { kind: 'org_structure_change', subjectRef: `department:${dept}`, details: actionDetails(link, { departmentId: dept }) });
      await ok(call('POST', `/v1/org/departments/${dept}/categories`, 'u-it', { ...link, approvalId }), `link ${dept}`);
    }
    // The staff list; Asha is dairy's floor champion. Grocery has none.
    for (const [id, name] of [['u-asha', 'Asha'], ['u-bala', 'Bala']] as const) {
      await ok(call('POST', `/v1/hr/workforce/employees/${id}`, 'u-mgr', { name, branchId: 'br-1', roles: ['cashier'], active: true }), `employee ${id}`);
    }
    await ok(call('POST', '/v1/hr/workforce/floor-champions/D-dairy', 'u-owner', { employeeId: 'u-asha' }), 'champion');

    const price = (productId: string, priceMinor: number) => ok(call('POST', '/v1/prices/changes', 'u-owner', { productId, priceMinor, mrpMinor: 5_000, costMinor: 1_000, currency: 'INR', marginFloorBps: 0 }), `price ${productId}`);
    for (const [id, p] of [['p-milk', 3_000], ['p-salt', 1_800], ['p-soap', 4_000]] as const) expect((await price(id, p)).body).toMatchObject({ relabelTasks: 1 });

    h = harness(h); // ── COLD RESTART ──
    const all = (await ok(call('GET', '/v1/pricing/relabel-tasks', 'u-mgr'), 'all')).body as { tasks: Row[] };
    const by = (rows: Row[]) => Object.fromEntries(rows.map((r) => [r.productId, r.assignee]));
    expect(by(all.tasks)).toEqual({
      'p-milk': { to: 'floor_champion', departmentId: 'D-dairy', employeeId: 'u-asha' },
      'p-salt': { to: 'store_manager', departmentId: 'D-grocery', because: 'no_champion_named' },
      'p-soap': { to: 'store_manager', departmentId: null, because: 'no_department_owns_it' },
    });
    expect(all.tasks.find((r) => r.productId === 'p-salt')).toMatchObject({ assignedToMe: true, storeManagers: ['u-mgr'] });

    // Mine: Asha sees the milk; the store manager the salt and the soap; Bala (nobody's champion) none; a cashier still
    // cannot read the whole store's list.
    const mine = async (who: string) => ((await ok(call('GET', '/v1/pricing/relabel-tasks/mine', who), `mine ${who}`)).body as { tasks: Row[] }).tasks.map((r) => r.productId).sort();
    expect(await mine('u-asha')).toEqual(['p-milk']);
    expect(await mine('u-mgr')).toEqual(['p-salt', 'p-soap']);
    expect(await mine('u-bala')).toEqual([]);
    expect((await call('GET', '/v1/pricing/relabel-tasks', 'u-asha')).status).toBe(403);
    expect(((await ok(call('GET', '/v1/pricing/relabel-tasks', 'u-mgr', undefined, { mine: '1' }), 'mgr mine=1')).body as { tasks: Row[] }).tasks.map((r) => r.productId).sort()).toEqual(['p-salt', 'p-soap']);
    // Asha closes her own (the photo and the price on the label).
    const milk = all.tasks.find((r) => r.productId === 'p-milk')!;
    await ok(call('POST', `/v1/pricing/relabel-tasks/${milk.taskId}/done`, 'u-asha', { shelfPriceMinor: 3_000, evidenceRef: 'photo-milk' }), 'done');

    // Asha leaves the staff list: the next milk price goes to the store manager, said why. The task already raised keeps
    // the champion it was given (a fact, never re-guessed).
    await ok(call('POST', '/v1/hr/workforce/employees/u-asha', 'u-mgr', { name: 'Asha', branchId: 'br-1', roles: ['cashier'], active: false }), 'asha leaves');
    await price('p-milk', 3_200);
    h = harness(h); // ── COLD RESTART ──
    const later = ((await ok(call('GET', '/v1/pricing/relabel-tasks', 'u-mgr'), 'later')).body as { tasks: (Row & { priceMinor: number })[] }).tasks.filter((r) => r.productId === 'p-milk');
    expect(later.map((r) => [r.priceMinor, r.assignee])).toEqual([
      [3_200, { to: 'store_manager', departmentId: 'D-dairy', because: 'champion_left' }],
      [3_000, { to: 'floor_champion', departmentId: 'D-dairy', employeeId: 'u-asha' }],
    ]);
  }, 120_000);
});
