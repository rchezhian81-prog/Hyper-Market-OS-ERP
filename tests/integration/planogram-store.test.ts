import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// M04-FR-02/03 through the real authenticated API (un-parks CH-02): the shelf map and the planogram are
// published, versioned, validated against the stored map, read back by store staff, and the compliance run
// judges the stored plan with no plan in the body. Merchandising publishes; the till cannot.

const T = 'ab000000-0000-4000-8000-000000000042';
const OWNER = 'u-owner';
const MANAGER = 'u-manager';
const CASHIER = 'u-cashier';
const S1 = 'S1';

const LOCS = [
  { locationId: 'A1-1', aisle: 1, rack: 1, bay: 1, shelf: 1, position: 1, zone: 'ambient', label: 'A1' },
  { locationId: 'A1-2', aisle: 1, rack: 1, bay: 1, shelf: 1, position: 2, zone: 'ambient' },
];
const ASSIGN = [
  { productId: 'P-RICE', locationId: 'A1-1', capacityMinor: 40, primary: true },
  { productId: 'P-SOAP', locationId: 'A1-2', capacityMinor: 60, primary: true },
];

async function seeded(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(T, OWNER);
  await h.provisionRole(T, MANAGER, 'store_manager');
  await h.provisionRole(T, CASHIER, 'cashier');
  return h;
}
const put = (h: ApiHarness, path: string, userId: string, key: string, body: unknown) => h.request({ method: 'PUT', path, userId, tenantId: T, idempotencyKey: key, body });
const post = (h: ApiHarness, path: string, userId: string, key: string, body: unknown) => h.request({ method: 'POST', path, userId, tenantId: T, idempotencyKey: key, body });
const get = (h: ApiHarness, path: string, userId: string) => h.request({ method: 'GET', path, userId, tenantId: T });

describe('the planogram store through the API', () => {
  it('publishes the shelf map and two plan versions, reads them back, and the compliance run uses the plan in force', async () => {
    const h = await seeded();
    expect((await put(h, `/v1/merchandising/stores/${S1}/shelf-map`, MANAGER, 'm1', { locations: LOCS })).status).toBe(201);
    const v1 = await put(h, `/v1/merchandising/stores/${S1}/planograms/PG-1`, MANAGER, 'p1', { effectiveFrom: '2026-09-01', assignments: ASSIGN });
    expect(v1.status, JSON.stringify(v1.body)).toBe(201);
    const v2 = await put(h, `/v1/merchandising/stores/${S1}/planograms/PG-1`, OWNER, 'p2', { effectiveFrom: '2026-09-15', assignments: [ASSIGN[0]!, { ...ASSIGN[1]!, capacityMinor: 80 }] });
    expect(v2.body).toMatchObject({ planogram: { version: 2, createdBy: OWNER }, previousVersions: 1 });

    const list = (await get(h, `/v1/merchandising/stores/${S1}/planograms`, MANAGER)).body as { inForce: { version: number } | null; plans: { versions: number }[] };
    expect(list.inForce?.version).toBe(2);
    expect(list.plans[0]!.versions).toBe(2);

    // Record a shelf count, then run compliance with NO plan in the body.
    const count = await post(h, '/v1/merchandising/shelf-counts/c1', MANAGER, 'c1', { storeId: S1, productId: 'P-RICE', locationId: 'A1-1', countedMinor: 4, knownLocationIds: ['A1-1', 'A1-2'] });
    expect([200, 201, 202], JSON.stringify(count.body)).toContain(count.status);
    const run = await post(h, '/v1/merchandising/planogram-compliance', MANAGER, 'r1', { storeId: S1, backstock: { 'P-RICE': 100, 'P-SOAP': 100 }, assignedRole: 'store_manager' });
    expect(run.status, JSON.stringify(run.body)).toBe(200);
    expect(run.body).toMatchObject({ planogramId: 'PG-1', planogramVersion: 2, planSource: 'stored' });
    expect((run.body as { tasks: { productId: string }[] }).tasks.map((t) => t.productId)).toContain('P-RICE');

    // Append-only: every version is kept; nothing was overwritten.
    const history = (await get(h, `/v1/merchandising/stores/${S1}/planograms/PG-1`, MANAGER)).body as { versions: { version: number; createdBy: string }[] };
    expect(history.versions.map((v) => [v.version, v.createdBy])).toEqual([[1, MANAGER], [2, OWNER]]);
  });

  it('a cashier cannot publish (403); an inconsistent plan is refused (422) and stores nothing; a replayed publish is one version', async () => {
    const h = await seeded();
    expect((await put(h, `/v1/merchandising/stores/${S1}/shelf-map`, CASHIER, 'x1', { locations: LOCS })).status).toBe(403);
    await put(h, `/v1/merchandising/stores/${S1}/shelf-map`, MANAGER, 'm1', { locations: LOCS });
    const bad = await put(h, `/v1/merchandising/stores/${S1}/planograms/PG-1`, MANAGER, 'p-bad', { effectiveFrom: '2026-09-01', assignments: [{ productId: 'P-X', locationId: 'NOWHERE', capacityMinor: 1, primary: true }] });
    expect(bad.status).toBe(422);
    expect((bad.body as { error: { code: string } }).error.code).toBe('the_plan_is_inconsistent');
    await put(h, `/v1/merchandising/stores/${S1}/planograms/PG-1`, MANAGER, 'p1', { effectiveFrom: '2026-09-01', assignments: ASSIGN });
    await put(h, `/v1/merchandising/stores/${S1}/planograms/PG-1`, MANAGER, 'p1', { effectiveFrom: '2026-09-01', assignments: ASSIGN }); // same key: replay
    const history = (await get(h, `/v1/merchandising/stores/${S1}/planograms/PG-1`, MANAGER)).body as { versions: unknown[] };
    expect(history.versions).toHaveLength(1);
    expect((await get(h, `/v1/merchandising/stores/${S1}/planograms/PG-1`, CASHIER)).status).toBe(403);
  });

  it('a second tenant and a second store see none of it', async () => {
    const h = await seeded();
    await put(h, `/v1/merchandising/stores/${S1}/shelf-map`, MANAGER, 'm1', { locations: LOCS });
    expect((await get(h, '/v1/merchandising/stores/S2/shelf-map', MANAGER)).status).toBe(404);
    const OTHER = 'cd000000-0000-4000-8000-000000000077';
    await h.seedOwner(OTHER, 'u-other');
    expect((await h.request({ method: 'GET', path: `/v1/merchandising/stores/${S1}/shelf-map`, userId: 'u-other', tenantId: OTHER })).status).toBe(404);
  });
});
