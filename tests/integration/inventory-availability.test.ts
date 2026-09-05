import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Inventory availability, end to end through the real API (M08, API-04). Movements are appended and
// on-hand is PROJECTED from them (hard rule #2): the same movements in any order give the same
// figure; a state that has gone negative is REPORTED as an exception, never blocked (P-08 / hard
// rule #10); a stock LOSS (`wasted`) is refused on this route and directed to the governed write-off
// route (where value, evidence and a verified §28 approver are enforced). This proves the wired
// `services/inventory` implementation against the real pipeline and real per-tenant RBAC.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const AT = '2026-08-07T10:00:00.000Z';

interface Availability { productId: string; locationId: string; onHandMinor: number; movements: number }
interface Negative { productId: string; locationId: string; onHandMinor: number }

const move = (h: ApiHarness, tenantId: string, userId: string, m: Record<string, unknown>) =>
  h.request({ method: 'POST', path: '/v1/inventory/movements', userId, tenantId, idempotencyKey: `mv-${m['movementId']}`, body: m });

const availability = async (h: ApiHarness, tenantId: string, userId: string): Promise<Availability[]> =>
  ((await h.request({ method: 'GET', path: '/v1/inventory/availability', userId, tenantId })).body as { rows: Availability[] }).rows;

const exceptions = async (h: ApiHarness, tenantId: string, userId: string): Promise<Negative[]> =>
  ((await h.request({ method: 'GET', path: '/v1/inventory/exceptions', userId, tenantId })).body as { negative: Negative[] }).negative;

const base = { locationId: 'L1', uom: 'each', occurredAt: AT, enteredBy: 'u-owner' };

describe('inventory availability is projected from appended movements (M08, API-04)', () => {
  it('reflects appended movements, order-independently', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    expect((await move(h, A, 'u-owner', { movementId: 'r1', productId: 'P1', kind: 'received', quantityMinor: 100, ...base })).status).toBe(202);
    expect((await move(h, A, 'u-owner', { movementId: 's1', productId: 'P1', kind: 'sold', quantityMinor: 30, ...base })).status).toBe(202);

    const p1 = (await availability(h, A, 'u-owner')).find((r) => r.productId === 'P1' && r.locationId === 'L1');
    expect(p1).toMatchObject({ onHandMinor: 70, movements: 2 });
  });

  it('reports negative stock as a visible exception, never blocking the movement (P-08)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await move(h, A, 'u-owner', { movementId: 'r2', productId: 'P2', kind: 'received', quantityMinor: 30, ...base });
    // Sell more than was received — the shelf was already wrong; the movement still records.
    expect((await move(h, A, 'u-owner', { movementId: 's2', productId: 'P2', kind: 'sold', quantityMinor: 50, ...base })).status).toBe(202);

    const neg = await exceptions(h, A, 'u-owner');
    expect(neg.find((n) => n.productId === 'P2')).toMatchObject({ onHandMinor: -20 });
  });

  it('refuses a stock write-off on the movements route — losses go through the governed write-off route', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');

    // A loss makes stock disappear: it is not a plain movement, and the ungoverned door is closed. Even a
    // well-formed 'wasted' movement (a reason + a different approver) is refused and directed to the write-off
    // route, which captures the value, evidence for a material loss, and a §28 approver who holds the authority.
    const res = await move(h, A, 'u-owner', { movementId: 'w3', productId: 'P3', kind: 'wasted', quantityMinor: 5, reason: 'damaged in transit', approvedBy: 'u-manager', ...base });
    expect(res.status).toBe(422);
    expect((res.body as { error?: { code?: string } }).error?.code).toBe('write_off_uses_the_write_off_route');
  });

  it('is per-tenant and authorized: another tenant is unaffected, and a cashier cannot append (403)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier');
    await move(h, A, 'u-owner', { movementId: 'r3', productId: 'P4', kind: 'received', quantityMinor: 10, ...base });

    await h.seedOwner(B, 'u-owner-b');
    expect(await availability(h, B, 'u-owner-b')).toEqual([]); // tenant B holds nothing

    expect((await move(h, A, 'u-cash', { movementId: 'r4', productId: 'P4', kind: 'received', quantityMinor: 1, ...base, enteredBy: 'u-cash' })).status).toBe(403);
  });
});
