import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';

/**
 * **Verifier r18 C2-R1 — stock moves only at a place head office has registered, and a transfer is judged against
 * registered places, never "a place that once held stock".** Probe zz-v18-ghost: with store-1 registered, a head-office
 * movement at "store-99" (canonical, never registered) was 202 — it created a phantom place in availability AND laundered
 * the id: a transfer store-1 → store-99, 422 before, was then accepted. In memory and on PostgreSQL, through the routes:
 *
 *   • a movement at an unregistered place is refused 422 `unknown_location` — nothing appended, nothing in availability;
 *   • a transfer to it stays refused afterwards;
 *   • registered places are accepted: an organisation node, a store set up with its settings and its back-store
 *     warehouse, a bin's location inside a registered store — but never a bin typed for an unregistered store;
 *   • a store manager's movement outside their branch is still refused by scope first (403), and an accepted movement
 *     re-sent under the same key is one movement.
 */

type Res = { status: number; body: unknown };
const codeOf = (r: Res): string | undefined => (r.body as { error?: { code?: string } } | null)?.error?.code;
const AT = new Date(Date.now() - 60_000).toISOString();
const SETTINGS = { tradingDayCutoff: '02:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 5_000, cashVarianceToleranceMinor: 5_000, privacySlaDays: 30 };

async function onlyRegisteredPlaces(h: ApiHarness): Promise<void> {
  const T = randomUUID();
  await h.seedOwner(T, 'u-owner');
  await h.provisionRole(T, 'u-mgr', 'store_manager', ['store-1']);
  const call = (method: 'GET' | 'POST', path: string, body?: unknown, user = 'u-owner', key?: string, query?: Record<string, string>): Promise<Res> =>
    h.request({ method, path, userId: user, tenantId: T, ...(user === 'u-mgr' ? { branchId: 'store-1' } : {}), ...(method === 'GET' ? {} : { idempotencyKey: key ?? `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });
  const move = (movementId: string, locationId: string, user = 'u-owner', key?: string) => call('POST', '/v1/inventory/movements', {
    movementId, productId: 'P1', locationId, kind: 'received', quantityMinor: 10, unitCostMinor: 100, uom: 'ea', occurredAt: AT, enteredBy: user,
  }, user, key);
  const places = async (): Promise<string[]> => ((await call('GET', '/v1/inventory/availability')).body as { rows: { locationId: string }[] }).rows.map((r) => r.locationId);
  const transfer = (id: string, to: string) => call('POST', `/v1/warehouse/transfers/${id}`, { fromLocationId: 'store-1', toLocationId: to, lines: [{ productId: 'P1', batchId: null, quantityMinor: 1, uom: 'ea' }] });

  expect((await call('POST', '/v1/org/nodes/C1', { kind: 'company', name: 'C' })).status).toBeLessThan(300);
  expect((await call('POST', '/v1/org/nodes/store-1', { kind: 'branch', name: 's1', parentId: 'C1', companyId: 'C1' })).status).toBeLessThan(300);

  // The probe: a movement at a canonical but never-registered store is refused, nothing kept.
  const ghost = await move('mv-g', 'store-99');
  expect(ghost.status).toBe(422);
  expect(codeOf(ghost)).toBe('unknown_location');
  expect(await places()).not.toContain('store-99');
  // ... and it launders nothing: a transfer there stays refused.
  expect(codeOf(await transfer('t-g', 'store-99'))).toBe('unknown_location');

  // Registered places are accepted; an accepted movement re-sent under its key is one movement.
  const key = `k-${randomUUID()}`;
  expect((await move('mv-1', 'store-1', 'u-owner', key)).status).toBe(202);
  expect((await move('mv-1', 'store-1', 'u-owner', key)).status).toBe(202);
  expect(((await call('GET', '/v1/inventory/availability')).body as { rows: { locationId: string; onHandMinor: number }[] }).rows
    .filter((r) => r.locationId === 'store-1').reduce((n, r) => n + r.onHandMinor, 0)).toBe(10);
  // A store set up with its settings, and its back-store warehouse.
  expect((await call('POST', '/v1/org/nodes/store-2', { kind: 'branch', name: 's2', parentId: 'C1', companyId: 'C1' })).status).toBeLessThan(300);
  expect((await call('POST', '/v1/stores/store-2/settings', { ...SETTINGS, warehouseId: 'store-2-back' })).status).toBeLessThan(300);
  expect((await move('mv-2', 'store-2-back')).status).toBe(202);
  // A bin's location inside a registered store is a place; a bin typed for an unregistered store makes nothing a place.
  expect((await call('POST', '/v1/warehouse/bins/B1', { storeId: 'store-1', locationId: 'store-1-chiller', capacityMinor: 100, pickable: true })).status).toBe(201);
  expect((await move('mv-3', 'store-1-chiller')).status).toBe(202);
  expect((await call('POST', '/v1/warehouse/bins/B9', { storeId: 'store-77', locationId: 'store-77-a', capacityMinor: 100, pickable: true })).status).toBe(201);
  expect(codeOf(await move('mv-4', 'store-77'))).toBe('unknown_location');
  expect(codeOf(await move('mv-5', 'store-77-a'))).toBe('unknown_location');
  expect(codeOf(await transfer('t-77', 'store-77'))).toBe('unknown_location');

  // A store manager outside their branch: refused by scope first, by name.
  const outside = await move('mv-6', 'store-99', 'u-mgr');
  expect(outside.status).toBe(403);
  expect(await places()).not.toContain('store-99');
  expect(await places()).not.toContain('store-77');
}

/**
 * Verifier r19 (6a/6b · P-08): stock left at a place that is not (or no longer) a stock place — booked before the business
 * registered its places, or at a department since CLOSED — is LISTED for head office (`strandedStock` on the stock
 * exceptions), and a movement there is refused with words that say which it is and the way out; reopening (or registering)
 * the place makes it movable again. Never a silent block.
 */
async function strandedStockIsListed(h: ApiHarness): Promise<void> {
  const T = randomUUID();
  await h.seedOwner(T, 'u-owner');
  const call = (method: 'GET' | 'POST', path: string, body?: unknown): Promise<Res> =>
    h.request({ method, path, userId: 'u-owner', tenantId: T, ...(method === 'GET' ? {} : { idempotencyKey: `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }) });
  const move = (movementId: string, locationId: string, kind = 'received', quantityMinor = 5) => call('POST', '/v1/inventory/movements', {
    movementId, productId: 'P1', locationId, kind, quantityMinor, unitCostMinor: 100, uom: 'ea', occurredAt: AT, enteredBy: 'u-owner',
  });
  // 6a: stock booked at an id BEFORE any place was registered (unjudged then).
  expect((await move('mv-pre', 'old-shelf')).status).toBe(202);
  expect((await call('POST', '/v1/org/nodes/C1', { kind: 'company', name: 'C' })).status).toBeLessThan(300);
  expect((await call('POST', '/v1/org/nodes/store-1', { kind: 'branch', name: 's1', parentId: 'C1', companyId: 'C1' })).status).toBeLessThan(300);
  // 6b: a department with stock, then CLOSED.
  expect((await call('POST', '/v1/org/nodes/D-DAIRY', { kind: 'department', name: 'Dairy', parentId: 'store-1' })).status).toBeLessThan(300);
  expect((await move('mv-dairy', 'D-DAIRY', 'received', 7)).status).toBe(202);
  expect((await call('POST', '/v1/org/nodes/D-DAIRY', { kind: 'department', name: 'Dairy', parentId: 'store-1', status: 'closed' })).status).toBeLessThan(300);

  const stranded = async (): Promise<{ locationId: string; onHandMinor: number; why: string; says: string }[]> =>
    ((await call('GET', '/v1/inventory/exceptions')).body as { strandedStock: { locationId: string; onHandMinor: number; why: string; says: string }[] }).strandedStock;
  const listed = await stranded();
  expect(listed).toEqual(expect.arrayContaining([
    expect.objectContaining({ locationId: 'old-shelf', onHandMinor: 5, why: 'place_not_registered' }),
    expect.objectContaining({ locationId: 'D-DAIRY', onHandMinor: 7, why: 'place_closed' }),
  ]));
  expect(listed.find((r) => r.locationId === 'D-DAIRY')?.says).toMatch(/CLOSED: reopen it/);
  // Verifier r20 (P-04): read by the reader's scope, like the neighbouring lists — store 2's closed department is store 2's.
  expect((await call('POST', '/v1/org/nodes/store-2', { kind: 'branch', name: 's2', parentId: 'C1', companyId: 'C1' })).status).toBeLessThan(300);
  expect((await call('POST', '/v1/org/nodes/D-S2', { kind: 'department', name: 'S2 dairy', parentId: 'store-2' })).status).toBeLessThan(300);
  expect((await move('mv-s2', 'D-S2', 'received', 3)).status).toBe(202);
  expect((await call('POST', '/v1/org/nodes/D-S2', { kind: 'department', name: 'S2 dairy', parentId: 'store-2', status: 'closed' })).status).toBeLessThan(300);
  await h.provisionRole(T, 'u-mgr1', 'store_manager', ['store-1']);
  await h.provisionRole(T, 'u-mgr2', 'store_manager', ['store-2']);
  const strandedAs = async (user: string, branchId: string): Promise<string[]> => {
    const r = await h.request({ method: 'GET', path: '/v1/inventory/exceptions', userId: user, tenantId: T, branchId });
    expect(r.status).toBe(200);
    return (r.body as { strandedStock: { locationId: string }[] }).strandedStock.map((x) => x.locationId).sort();
  };
  expect(await strandedAs('u-mgr1', 'store-1')).toEqual(['D-DAIRY']);
  expect(await strandedAs('u-mgr2', 'store-2')).toEqual(['D-S2']);
  expect((await stranded()).map((x) => x.locationId).sort()).toEqual(['D-DAIRY', 'D-S2', 'old-shelf']);
  expect((await call('POST', '/v1/org/nodes/D-S2', { kind: 'department', name: 'S2 dairy', parentId: 'store-2', status: 'draft' })).status).toBeLessThan(300);
  expect((await move('mv-s2-out', 'D-S2', 'transferred_out', 3)).status).toBe(202);
  // The refusals say which it is, and where the stock is listed.
  const closedMove = await move('mv-out-1', 'D-DAIRY', 'transferred_out', 7);
  expect(closedMove.status).toBe(422);
  expect((closedMove.body as { error: { whatHappened: string; nextSafeAction: string } }).error.whatHappened).toMatch(/CLOSED place/);
  expect((closedMove.body as { error: { nextSafeAction: string } }).error.nextSafeAction).toMatch(/strandedStock/);
  const preMove = await move('mv-out-2', 'old-shelf', 'transferred_out', 5);
  expect(codeOf(preMove)).toBe('unknown_location');
  expect((preMove.body as { error: { nextSafeAction: string } }).error.nextSafeAction).toMatch(/strandedStock/);
  // The way out works: reopen the department / register the old id, move the stock out, and it leaves the list.
  expect((await call('POST', '/v1/org/nodes/D-DAIRY', { kind: 'department', name: 'Dairy', parentId: 'store-1', status: 'draft' })).status).toBeLessThan(300);
  expect((await move('mv-out-1', 'D-DAIRY', 'transferred_out', 7)).status).toBe(202);
  expect((await call('POST', '/v1/org/nodes/old-shelf', { kind: 'department', name: 'Old shelf', parentId: 'store-1' })).status).toBeLessThan(300);
  expect((await move('mv-out-2', 'old-shelf', 'transferred_out', 5)).status).toBe(202);
  expect(await stranded()).toEqual([]);
}

describe('verifier r18 C2-R1: stock moves only at a registered place (memory)', () => {
  it('refuses a phantom place, launders nothing, accepts registered places', async () => { await onlyRegisteredPlaces(apiHarness()); }, 60_000);
  it('r19: stock stranded at an unregistered or closed place is listed and the refusal says why', async () => { await strandedStockIsListed(apiHarness()); }, 60_000);
});

const DATABASE_URL = process.env['DATABASE_URL'];
describe.skipIf(DATABASE_URL === undefined)('verifier r18 C2-R1: stock moves only at a registered place (PostgreSQL)', () => {
  it('refuses a phantom place, launders nothing, accepts registered places', async () => {
    const pool = new Pool({ connectionString: DATABASE_URL, max: 8, options: '-c app.tenant_id=*' });
    const sql = pgPoolClient(pool);
    try { await onlyRegisteredPlaces(apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) })); } finally { await pool.end(); }
  }, 120_000);
  it('r19: stock stranded at an unregistered or closed place is listed and the refusal says why', async () => {
    const pool = new Pool({ connectionString: DATABASE_URL, max: 8, options: '-c app.tenant_id=*' });
    const sql = pgPoolClient(pool);
    try { await strandedStockIsListed(apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) })); } finally { await pool.end(); }
  }, 120_000);
});
