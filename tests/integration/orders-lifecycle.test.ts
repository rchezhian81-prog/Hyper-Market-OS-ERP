import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Order lifecycle and reservation, end to end through the real API (M18, API-07). A promise is
// made against stock reserved in the SAME breath — checking availability and reserving a moment
// later is the oversell (§6.2), so the second order can only be promised what the first left, and
// an order that would exceed availability is not promised more than exists. An order then moves
// through its auditable lifecycle (M18-FR-01) by allowed transitions only; an illegal step is
// refused, never applied. And a cancellation gives EVERY reservation back in the same step
// (M18-FR-04) — a cancel that forgets the release makes stock invisible to the shop floor, the
// commonest phantom out-of-stock. This proves the wired `services/orders` surface against the real
// pipeline, real per-tenant RBAC and stock projected from the real inventory ledger.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const AT = '2026-08-07T10:00:00.000Z';

const base = { locationId: 'L1', uom: 'each', occurredAt: AT, enteredBy: 'u-owner' };

const move = (h: ApiHarness, tenant: string, user: string, m: Record<string, unknown>) =>
  h.request({ method: 'POST', path: '/v1/inventory/movements', userId: user, tenantId: tenant, idempotencyKey: `mv-${String(m['movementId'])}`, body: m });

interface Line { productId: string; quantityMinor: number }
interface PromiseLine { productId: string; requestedMinor: number; promisedMinor: number; outcome: string }
interface PromiseBody { orderId: string; outcome: string; lines: PromiseLine[] }

const promise = (h: ApiHarness, tenant: string, user: string, orderId: string, lines: Line[], key: string) =>
  h.request({ method: 'POST', path: `/v1/orders/${orderId}/promise`, userId: user, tenantId: tenant, idempotencyKey: key, body: { lines, locationId: 'L1' } });

interface StatusBody { orderId: string; state: string; locationId: string; lines: Line[]; reservations: { reservationId: string; orderId: string; quantityMinor: number }[] }
const status = (h: ApiHarness, tenant: string, user: string, orderId: string) =>
  h.request({ method: 'GET', path: `/v1/orders/${orderId}`, userId: user, tenantId: tenant });

const transition = (h: ApiHarness, tenant: string, user: string, orderId: string, event: string, key: string) =>
  h.request({ method: 'POST', path: `/v1/orders/${orderId}/transition`, userId: user, tenantId: tenant, idempotencyKey: key, body: { event } });

interface ReservationsBody { outstanding: { reservationId: string; orderId: string; quantityMinor: number }[] }
const reservationsAt = async (h: ApiHarness, tenant: string, user: string): Promise<ReservationsBody['outstanding']> =>
  ((await h.request({ method: 'GET', path: '/v1/orders/reservations', userId: user, tenantId: tenant, query: { locationId: 'L1' } })).body as ReservationsBody).outstanding;

const sumMinor = (rs: { quantityMinor: number }[]): number => rs.reduce((s, r) => s + r.quantityMinor, 0);

describe('order lifecycle and reservation, end to end (M18, API-07)', () => {
  it('reserves stock in the same breath and never oversells it (M18-FR-02, §6.2)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    expect((await move(h, A, 'u-owner', { movementId: 'r1', productId: 'P1', kind: 'received', quantityMinor: 100, ...base })).status).toBe(202);

    // First order takes 60 of the 100.
    const o1 = (await promise(h, A, 'u-owner', 'o1', [{ productId: 'P1', quantityMinor: 60 }], 'pr-o1')).body as PromiseBody;
    expect(o1.outcome).toBe('promised');
    expect(o1.lines[0]).toMatchObject({ promisedMinor: 60, outcome: 'promised' });
    expect(sumMinor(await reservationsAt(h, A, 'u-owner'))).toBe(60);

    // Second order asks for 60 more but only 40 are free — it is promised 40, never 60 (no oversell).
    const o2 = (await promise(h, A, 'u-owner', 'o2', [{ productId: 'P1', quantityMinor: 60 }], 'pr-o2')).body as PromiseBody;
    expect(o2.lines[0]).toMatchObject({ requestedMinor: 60, promisedMinor: 40, outcome: 'partially_promised' });

    // Third order finds the shelf spoken for — promised nothing, told before paying.
    const o3 = (await promise(h, A, 'u-owner', 'o3', [{ productId: 'P1', quantityMinor: 10 }], 'pr-o3')).body as PromiseBody;
    expect(o3.outcome).toBe('cannot_promise');
    expect(o3.lines[0]?.promisedMinor).toBe(0);

    // Total reserved is exactly the 100 on the shelf and not a unit more.
    expect(sumMinor(await reservationsAt(h, A, 'u-owner'))).toBe(100);
  });

  it('places an order and reports its lifecycle end to end (M18-FR-01)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await move(h, A, 'u-owner', { movementId: 'r1', productId: 'P1', kind: 'received', quantityMinor: 100, ...base });
    await promise(h, A, 'u-owner', 'o1', [{ productId: 'P1', quantityMinor: 60 }], 'pr-o1');

    const placed = (await status(h, A, 'u-owner', 'o1')).body as StatusBody;
    expect(placed).toMatchObject({ orderId: 'o1', state: 'placed', locationId: 'L1' });
    expect(placed.lines).toEqual([{ productId: 'P1', quantityMinor: 60 }]);
    expect(sumMinor(placed.reservations)).toBe(60);

    // Every allowed step in order, each one visible.
    for (const [event, expected] of [
      ['confirm', 'confirmed'], ['pick', 'picking'], ['pack', 'packed'],
      ['dispatch', 'dispatched'], ['deliver', 'delivered'],
    ] as const) {
      const res = await transition(h, A, 'u-owner', 'o1', event, `tx-o1-${event}`);
      expect(res.status).toBe(200);
      expect((res.body as { state: string }).state).toBe(expected);
    }
    expect(((await status(h, A, 'u-owner', 'o1')).body as StatusBody).state).toBe('delivered');
  });

  it('refuses an illegal step and an unknown order, never applying it (M18-FR-01)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await move(h, A, 'u-owner', { movementId: 'r1', productId: 'P1', kind: 'received', quantityMinor: 100, ...base });
    await promise(h, A, 'u-owner', 'o1', [{ productId: 'P1', quantityMinor: 60 }], 'pr-o1');

    // A placed order cannot jump to delivered.
    const illegal = await transition(h, A, 'u-owner', 'o1', 'deliver', 'tx-o1-bad');
    expect(illegal.status).toBe(409);
    expect((illegal.body as { error: { code: string } }).error.code).toBe('illegal_transition');
    expect(((await status(h, A, 'u-owner', 'o1')).body as StatusBody).state).toBe('placed'); // unchanged

    // A step against an order that was never placed.
    const unknown = await transition(h, A, 'u-owner', 'ghost', 'confirm', 'tx-ghost');
    expect(unknown.status).toBe(404);
    expect((unknown.body as { error: { code: string } }).error.code).toBe('order_unknown');

    // A step with no event named.
    const nothing = await h.request({ method: 'POST', path: '/v1/orders/o1/transition', userId: 'u-owner', tenantId: A, idempotencyKey: 'tx-o1-empty', body: {} });
    expect(nothing.status).toBe(400);
    expect((nothing.body as { error: { code: string } }).error.code).toBe('no_transition');
  });

  it('a cancellation gives every reservation back to the shop floor (M18-FR-04)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await move(h, A, 'u-owner', { movementId: 'r5', productId: 'P5', kind: 'received', quantityMinor: 100, ...base });
    await promise(h, A, 'u-owner', 'o4', [{ productId: 'P5', quantityMinor: 60 }], 'pr-o4');
    expect(sumMinor(await reservationsAt(h, A, 'u-owner'))).toBe(60);

    // Cancel returns the reservation IN THE SAME STEP.
    const cancelled = await transition(h, A, 'u-owner', 'o4', 'cancel', 'tx-o4-cancel');
    expect(cancelled.status).toBe(200);
    const cbody = cancelled.body as { state: string; released: { quantityMinor: number }[] };
    expect(cbody.state).toBe('cancelled');
    expect(sumMinor(cbody.released)).toBe(60);

    // The shelf is free again — nothing outstanding, and a new order can be promised the full 100.
    expect(await reservationsAt(h, A, 'u-owner')).toEqual([]);
    const o5 = (await promise(h, A, 'u-owner', 'o5', [{ productId: 'P5', quantityMinor: 100 }], 'pr-o5')).body as PromiseBody;
    expect(o5.outcome).toBe('promised');
    expect(o5.lines[0]?.promisedMinor).toBe(100);

    const view = (await status(h, A, 'u-owner', 'o4')).body as StatusBody;
    expect(view.state).toBe('cancelled');
    expect(view.reservations).toEqual([]);
  });

  it('is authorized, per-tenant isolated and idempotent on the order', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier');
    await move(h, A, 'u-owner', { movementId: 'r1', productId: 'P1', kind: 'received', quantityMinor: 100, ...base });
    await promise(h, A, 'u-owner', 'o1', [{ productId: 'P1', quantityMinor: 60 }], 'pr-o1');

    // A cashier holds no order authority: cannot read one, cannot move one.
    expect((await status(h, A, 'u-cash', 'o1')).status).toBe(403);
    expect((await transition(h, A, 'u-cash', 'o1', 'confirm', 'tx-cash')).status).toBe(403);

    // Another tenant cannot see this order at all.
    await h.seedOwner(B, 'u-owner-b');
    expect((await status(h, B, 'u-owner-b', 'o1')).status).toBe(404);

    // Resending the same transition (a network retry) does not advance the order twice.
    expect((await transition(h, A, 'u-owner', 'o1', 'confirm', 'tx-o1-confirm')).status).toBe(200);
    expect((await transition(h, A, 'u-owner', 'o1', 'confirm', 'tx-o1-confirm')).status).toBe(200);
    expect(((await status(h, A, 'u-owner', 'o1')).body as StatusBody).state).toBe('confirmed');

    // Re-promising the same order+line under a fresh key holds ONE reservation, not two.
    await promise(h, A, 'u-owner', 'o1', [{ productId: 'P1', quantityMinor: 60 }], 'pr-o1-again');
    const outstanding = await reservationsAt(h, A, 'u-owner');
    expect(outstanding.filter((r) => r.orderId === 'o1')).toHaveLength(1);
    expect(sumMinor(outstanding)).toBe(60);
  });
});
