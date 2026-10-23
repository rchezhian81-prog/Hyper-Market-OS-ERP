import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { askForApproval, decide, approvedRequestId } from '../support/approval-request';
import { actionDetails } from '../../services/identity/src/approval-requests';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { InMemoryConfigVersionStore, SqlConfigVersionStore } from '../../packages/persistence/src/config-store';
import { DurableTenantSettings } from '../../packages/tenant/src/durable-settings';

/**
 * **Governed configuration, owner-approved structure, department scope and the access review — on the real API, in memory
 * AND on real PostgreSQL with a cold restart (M01-FR-01/02/03 · M02-FR-01/02 · SEC-03 · §28 · §35 "deny server-side").**
 *
 *   • a switch change needs a reason and becomes a numbered version; a high-impact switch (payments) needs the owner's
 *     approval — the maker can never approve their own — and a rollback is its own version;
 *   • the trading-day cut-off waits for the owner's approval;
 *   • a branch is activated only with the owner's approval, never the maker's own;
 *   • a department owns categories (owner-approved); a store manager limited to the dairy department is refused, through
 *     the API, outside it, and works inside it; the dairy report returns dairy's sales only;
 *   • the access review lists who holds what, where, up to how much, with the rows that need a look; the permission
 *     matrix exports as CSV; a cashier reads neither.
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

const backings: { name: string; make: () => () => ApiHarness }[] = [{
  name: 'the in-memory stores',
  make: () => { const settings = new DurableTenantSettings(new InMemoryConfigVersionStore()); const first = apiHarness({ settings }); return () => apiHarness({ store: first.store, settings }); },
}];
if (DATABASE_URL !== undefined) {
  backings.push({
    name: 'real PostgreSQL',
    make: () => { const sql = pgPoolClient(pool!); const settings = new DurableTenantSettings(new SqlConfigVersionStore(sql)); const store = new SqlEventStore(sql); return () => apiHarness({ store, idempotency: new SqlIdempotencyStore(sql), settings }); },
  });
}

type Res = { status: number; body: unknown };
const codeOf = (r: Res): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
const G1 = '33AABCS1429B1Z1';

describe.each(backings)('configuration, structure, departments and access on $name (M01 · M02)', ({ make }) => {
  async function shop() {
    const harness = make();
    let h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-it', 'platform_admin');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    await h.provisionRole(T, 'u-dm', 'store_manager');
    await h.provisionRole(T, 'u-cash', 'cashier');
    await h.provisionRole(T, 'u-acc', 'accountant');
    const req = (method: 'GET' | 'POST' | 'PUT', path: string, userId: string, body?: unknown, query?: Record<string, string>): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'GET' ? {} : { idempotencyKey: `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });
    const ok = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
    return { T, h: () => h, restart: () => { h = harness(); }, req, ok };
  }

  it('switches: a reason and a version every time; a payments switch waits for the owner; rollback is its own version', async () => {
    const { T, h, req, restart } = await shop();
    expect(codeOf(await req('PUT', '/v1/platform/flags/screens.large_text', 'u-it', { enabled: true }))).toBe('reason_required');
    expect(((await req('PUT', '/v1/platform/flags/screens.large_text', 'u-it', { enabled: true, reason: 'older eyes at the desk' })).body as { version: number }).version).toBe(1);
    expect(((await req('PUT', '/v1/platform/flags/screens.large_text', 'u-it', { enabled: false, reason: 'trial over' })).body as { version: number }).version).toBe(2);
    expect((await req('PUT', '/v1/platform/flags/screens.large_text', 'u-cash', { enabled: true, reason: 'x' })).status).toBe(403);

    const preview = (await req('POST', '/v1/platform/flags/payments.upi_collect/preview', 'u-it', { enabled: true })).body as { highImpact: boolean; needsSecondPerson: boolean; current: boolean | null };
    expect(preview).toMatchObject({ highImpact: true, needsSecondPerson: true, current: null });
    const body = { enabled: true, reason: 'UPI collect requests at the service desk' };
    expect(codeOf(await req('PUT', '/v1/platform/flags/payments.upi_collect', 'u-owner', body))).toBe('high_impact_change_needs_owner_approval');
    // The maker cannot approve their own high-impact switch (M01-FR-03 acceptance).
    const own = await askForApproval(h(), T, 'u-owner', { kind: 'flag_change', subjectRef: 'flag:payments.upi_collect', details: actionDetails(body, { key: 'payments.upi_collect' }) });
    expect(codeOf(await decide(h(), T, 'u-owner', (own.body as { requestId: string }).requestId))).toBe('self_approval');
    const approvalId = await approvedRequestId(h(), T, 'u-it', 'u-owner', { kind: 'flag_change', subjectRef: 'flag:payments.upi_collect', details: actionDetails(body, { key: 'payments.upi_collect' }) });
    const on = await req('PUT', '/v1/platform/flags/payments.upi_collect', 'u-it', { ...body, approvalId });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    expect(on.body).toMatchObject({ version: 1, approvedBy: 'u-owner', highImpact: true });

    restart();
    const back = await req('POST', '/v1/platform/flags/screens.large_text/rollback', 'u-it', { toVersion: 1, reason: 'they liked it' });
    expect(back.status).toBe(200);
    const history = (await req('GET', '/v1/platform/flags/screens.large_text/history', 'u-owner')).body as { versions: { version: number; enabled: boolean; rolledBackFrom?: number; reason?: string }[] };
    expect(history.versions.map((v) => [v.version, v.enabled, v.rolledBackFrom ?? null])).toEqual([[1, true, null], [2, false, null], [3, true, 1]]);
    expect(((await req('GET', '/v1/platform/flags', 'u-owner')).body as { flags: Record<string, boolean> }).flags).toMatchObject({ 'screens.large_text': true, 'payments.upi_collect': true });
  });

  it('the trading-day cut-off and a branch activation wait for the owner\'s approval', async () => {
    const { T, h, req, ok } = await shop();
    const cut = { value: '03:00', ifVersion: 0 };
    expect(codeOf(await req('PUT', '/v1/platform/setup/trading_day.cutoff', 'u-it', cut))).toBe('high_impact_change_needs_owner_approval');
    expect(codeOf(await req('PUT', '/v1/platform/setup/trading_day.cutoff', 'u-it', { value: 'midnight-ish' }))).toBe('setup_answer_refused'); // an invalid value spends nothing
    const approvalId = await approvedRequestId(h(), T, 'u-it', 'u-owner', { kind: 'config_change', subjectRef: 'setting:trading_day.cutoff', details: actionDetails(cut, { key: 'trading_day.cutoff' }) });
    await ok(req('PUT', '/v1/platform/setup/trading_day.cutoff', 'u-it', { ...cut, approvalId }), 'cut-off');
    expect(((await req('GET', '/v1/platform/config/trading_day.cutoff', 'u-owner')).body as { current: { value: string } }).current.value).toBe('03:00');
    // A low-impact setting still saves with one person.
    await ok(req('PUT', '/v1/platform/setup/delivery.radius_km', 'u-it', { value: 5, ifVersion: 0 }), 'radius');

    await ok(req('POST', '/v1/org/nodes/C1', 'u-it', { kind: 'company', name: 'SRE Retail' }), 'company');
    await ok(req('POST', `/v1/org/gst-registrations/${G1}`, 'u-it', { companyId: 'C1', legalName: 'SRE Retail Pvt Ltd' }), 'gst');
    await ok(req('POST', '/v1/org/nodes/B1', 'u-it', { kind: 'branch', name: 'Main store', parentId: 'C1', companyId: 'C1', gstin: G1 }), 'branch draft');
    expect(codeOf(await req('POST', '/v1/org/nodes/B1/activation', 'u-it', {}))).toBe('structural_change_needs_owner_approval');
    expect(codeOf(await req('POST', '/v1/org/nodes/B1', 'u-it', { kind: 'branch', name: 'Main store', parentId: 'C1', companyId: 'C1', gstin: G1, status: 'active' }))).toBe('structural_change_needs_owner_approval');
    const act = await askForApproval(h(), T, 'u-it', { kind: 'org_structure_change', subjectRef: 'B1', details: { nodeId: 'B1', action: 'activate' } });
    const actId = (act.body as { requestId: string }).requestId;
    expect((await decide(h(), T, 'u-it', actId)).status).toBe(403); // IT may set up, never approve the structure
    expect((await decide(h(), T, 'u-owner', actId)).status).toBe(201);
    expect(((await ok(req('POST', '/v1/org/nodes/B1/activation', 'u-it', { approvalId: actId }), 'activate')).body as { node: { status: string } }).node.status).toBe('active');
  });

  it('a store manager limited to dairy is refused outside it, through the API; the dairy report holds only dairy\'s sales', async () => {
    const { T, h, req, ok, restart } = await shop();
    const DAY = '2030-05-20';
    await ok(req('POST', '/v1/org/nodes/C1', 'u-owner', { kind: 'company', name: 'SRE Retail' }), 'company');
    await ok(req('POST', '/v1/org/nodes/store-01', 'u-owner', { kind: 'branch', name: 'Main store', parentId: 'C1', companyId: 'C1' }), 'branch');
    for (const [id, name] of [['D-dairy', 'Dairy'], ['D-grocery', 'Grocery']]) await ok(req('POST', `/v1/org/nodes/${id}`, 'u-owner', { kind: 'department', name, parentId: 'store-01' }), id!);
    await ok(req('POST', '/v1/catalogue/tax-classes/04061000/rates/2017-07-01', 'u-owner', { rateBps: 500 }), 'tax');
    for (const [id, cat, code] of [['p-milk', 'dairy-cat', '8901000000019'], ['p-rice', 'grocery-cat', '8901000000026']] as const) {
      await ok(req('POST', `/v1/catalogue/products/${id}/publish`, 'u-owner', { product: { sku: `SKU-${id}`, name: id, baseUom: 'ea', primaryCategoryId: cat, taxClass: '04061000', lifecycle: 'draft' }, categories: [{ categoryId: cat, name: cat, parentId: null }] }), `publish ${id}`);
      await ok(req('POST', `/v1/prices/list/${id}/entries/e1`, 'u-owner', { scope: 'store', scopeRef: 'store-01', priceMinor: 5_000, mrpMinor: 6_000, costMinor: 1, marginFloorBps: 0, currency: 'INR', effectiveFrom: '2030-01-01' }), `price ${id}`);
      await ok(req('POST', `/v1/catalogue/products/${id}/barcodes/${code}`, 'u-owner', { kind: 'ean' }), `barcode ${id}`);
      await ok(req('POST', '/v1/inventory/movements', 'u-owner', { movementId: `rx-${id}`, productId: id, locationId: 'store-01', kind: 'received', quantityMinor: 20, uom: 'EA', occurredAt: '2030-05-01T00:00:00.000Z', enteredBy: 'u-owner', unitCostMinor: 1_000 }), `receive ${id}`);
    }
    await ok(req('POST', '/v1/sales', 'u-owner', {
      saleId: 'S-1', receiptNumber: 'R-1', laneId: 'lane-1', locationId: 'store-01', cashierId: 'u-owner', tradingDay: DAY, committedAt: `${DAY}T10:00:00Z`, totalMinor: 15_000, currency: 'INR', packVersion: 1,
      lines: [{ productId: 'p-milk', quantityMinor: 2, uom: 'EA', unitPriceMinor: 5_000, lineTotalMinor: 10_000 }, { productId: 'p-rice', quantityMinor: 1, uom: 'EA', unitPriceMinor: 5_000, lineTotalMinor: 5_000 }],
      tenders: [{ kind: 'cash', amountMinor: 15_000 }],
    }), 'sale');

    // The dairy department owns the dairy category — a structural fact, approved by the owner.
    const link = { categoryIds: ['dairy-cat'], reason: 'dairy counter' };
    expect(codeOf(await req('POST', '/v1/org/departments/D-dairy/categories', 'u-it', link))).toBe('not_readable_as_department_categories');
    const linkId = await approvedRequestId(h(), T, 'u-it', 'u-owner', { kind: 'org_structure_change', subjectRef: 'department:D-dairy', details: actionDetails(link, { departmentId: 'D-dairy' }) });
    await ok(req('POST', '/v1/org/departments/D-dairy/categories', 'u-it', { ...link, approvalId: linkId }), 'link');
    const steal = { categoryIds: ['dairy-cat'], reason: 'x' };
    const stealId = await approvedRequestId(h(), T, 'u-it', 'u-owner', { kind: 'org_structure_change', subjectRef: 'department:D-grocery', details: actionDetails(steal, { departmentId: 'D-grocery' }) });
    expect(codeOf(await req('POST', '/v1/org/departments/D-grocery/categories', 'u-it', { ...steal, approvalId: stealId }))).toBe('category_owned_by_another_department');

    // u-dm's store-manager role is limited to dairy: another manager asks, the owner approves, never u-dm.
    const scope = { departments: ['D-dairy'], reason: 'runs the dairy counter' };
    const scopeId = await approvedRequestId(h(), T, 'u-mgr', 'u-owner', { kind: 'department_scope_change', subjectRef: 'u-dm/store_manager', details: actionDetails(scope, { userId: 'u-dm', roleId: 'store_manager' }) });
    expect(codeOf(await req('POST', '/v1/identity/department-scopes/u-dm/store_manager', 'u-dm', { ...scope, approvalId: scopeId }))).toBe('scoping_yourself');
    await ok(req('POST', '/v1/identity/department-scopes/u-dm/store_manager', 'u-mgr', { ...scope, approvalId: scopeId }), 'scope');

    restart(); // ── cold restart: the scope and the link are read back ──
    const outside = await req('POST', '/v1/merchandising/assortment/store-01/p-rice/list', 'u-dm', { effectiveFrom: '2030-06-01' });
    expect(outside.status).toBe(403);
    expect(codeOf(outside)).toBe('outside_your_department_scope');
    await ok(req('POST', '/v1/merchandising/assortment/store-01/p-milk/list', 'u-dm', { effectiveFrom: '2030-06-01' }), 'list milk');
    await ok(req('POST', '/v1/merchandising/assortment/store-01/p-rice/list', 'u-mgr', { effectiveFrom: '2030-06-01' }), 'an unlimited manager lists rice');
    const listed = (await req('GET', '/v1/merchandising/assortment/store-01', 'u-dm', undefined, { onDate: '2030-06-02' })).body as { listed: string[]; outsideYourDepartments: number };
    expect(listed).toMatchObject({ listed: ['p-milk'], outsideYourDepartments: 1 });
    expect(codeOf(await req('POST', '/v1/inventory/counts/c-rice', 'u-dm', { productId: 'p-rice', locationId: 'store-01', uom: 'EA', countedMinor: 19, reasonCode: 'cycle' }))).toBe('outside_your_department_scope');

    const report = (await req('GET', '/v1/org/departments/D-dairy/report', 'u-dm', undefined, { day: DAY })).body as { products: { productId: string; valueMinor: number }[]; totalValueMinor: number; unownedValueMinor: number };
    expect(report.products.map((p) => p.productId)).toEqual(['p-milk']);
    expect(report).toMatchObject({ totalValueMinor: 10_000, unownedValueMinor: 5_000 });
    expect(codeOf(await req('GET', '/v1/org/departments/D-grocery/report', 'u-dm', undefined, { day: DAY }))).toBe('outside_your_department_scope');
    expect((await req('GET', '/v1/org/departments/D-grocery/report', 'u-owner', undefined, { day: DAY })).status).toBe(200);

    // The access review shows the limit, the money authority and what needs a look; the matrix exports.
    const review = (await req('GET', '/v1/identity/access-review', 'u-acc')).body as { rows: { userId: string; roles: { roleId: string; departmentScope: unknown }[]; moneyLimits?: Record<string, { state: string; limitMinor: number | null }>; flags: string[] }[] };
    const dm = review.rows.find((r) => r.userId === 'u-dm')!;
    expect(dm.roles).toEqual([expect.objectContaining({ roleId: 'store_manager', departmentScope: ['D-dairy'] })]);
    expect(dm.moneyLimits!['refund']).toMatchObject({ state: 'limit', limitMinor: 500_000 });
    expect(review.rows.find((r) => r.userId === 'u-owner')!.flags).toContain('holds_roles_with_no_sign_in');
    expect((await req('GET', '/v1/identity/access-review', 'u-cash')).status).toBe(403);
    const csv = (await req('GET', '/v1/identity/permission-matrix', 'u-owner', undefined, { format: 'csv' })).body as { csv: string };
    expect(csv.csv.split('\n')[0]).toMatch(/^permission,owner,store_manager/);
    expect((await req('GET', '/v1/identity/permission-matrix', 'u-mgr')).status).toBe(403);
  });
});
