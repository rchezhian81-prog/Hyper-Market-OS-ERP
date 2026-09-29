import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

/**
 * **The storefront's own surface, through the real authenticated API (M20-FR-02/FR-03 · M18-FR-01/FR-02 · §31 · §35 · #3 · #6).**
 *
 * A customer signed into the storefront places an order that reserves real stock in the same breath and records the
 * checkout's payment answer against it; reads back only its own orders; is refused AND recorded when it asks for
 * another customer's; cannot reach the desk's order routes; and reaches none of this at all unless the shop's plan
 * has the customer app on. Staff see the order with who placed it, and the refusal register.
 */

const T = 'ab000000-0000-4000-8000-000000000047';
const OWNER = 'u-owner'; const C1 = 'cust-1'; const C2 = 'cust-2';
const AT = '2026-10-10T10:00:00.000Z';

async function seeded(entitled = true): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(T, OWNER);
  await h.provisionRole(T, C1, 'customer');
  await h.provisionRole(T, C2, 'customer');
  if (entitled) await h.enableFeature(T, 'customer_app');
  // Real stock at the store, from the real inventory ledger — what a promise reserves against.
  await h.request({ method: 'POST', path: '/v1/inventory/movements', userId: OWNER, tenantId: T, idempotencyKey: 'mv-1', body: { movementId: 'mv-1', productId: 'MILK', locationId: 'L1', kind: 'received', quantityMinor: 5, uom: 'each', occurredAt: AT, enteredBy: OWNER } });
  return h;
}
const post = (h: ApiHarness, path: string, userId: string, key: string, body: unknown) =>
  h.request({ method: 'POST', path, userId, tenantId: T, idempotencyKey: key, body });
const get = (h: ApiHarness, path: string, userId: string) => h.request({ method: 'GET', path, userId, tenantId: T });
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
const BASKET = { lines: [{ productId: 'MILK', quantityMinor: 3 }], locationId: 'L1' };
const PAID = { providerRef: 'tok_cust_1', amountMinor: 15_000, result: 'authorised' };

describe('the storefront places, pays and reads its own orders (M20)', () => {
  it('a customer places an order that reserves stock and records its payment; staff see who placed it; a second customer is promised only what is left', async () => {
    const h = await seeded();
    const placed = await post(h, '/v1/storefront/orders/so-1', C1, 'p1', { ...BASKET, payment: PAID });
    expect(placed.status, JSON.stringify(placed.body)).toBe(201);
    expect(placed.body).toMatchObject({ orderId: 'so-1', state: 'placed', payment: { state: 'authorised', paidMinor: 15_000 }, promise: { outcome: 'promised' } });
    // Staff read the same order through the desk route, with who placed it and its reservations.
    const desk = (await get(h, '/v1/orders/so-1', OWNER)).body as { reservations: unknown[] };
    expect(desk.reservations).toHaveLength(1);
    expect(((await get(h, '/v1/orders/so-1/refunds', OWNER)).body as { payment: { state: string } }).payment.state).toBe('authorised');
    // The second customer can only be promised the 2 left of 5.
    const second = await post(h, '/v1/storefront/orders/so-2', C2, 'p2', { lines: [{ productId: 'MILK', quantityMinor: 3 }], locationId: 'L1' });
    expect(second.status).toBe(201);
    expect(second.body).toMatchObject({ promise: { outcome: 'partially_promised', lines: [{ productId: 'MILK', requestedMinor: 3, promisedMinor: 2 }] }, payment: { state: 'none' } });
    // A retry of the first order (new idempotency key) reserves nothing twice.
    expect((await post(h, '/v1/storefront/orders/so-1', C1, 'p1-retry', { ...BASKET, payment: PAID })).body).toMatchObject({ alreadyPlaced: true });
    expect(((await get(h, '/v1/orders/so-1', OWNER)).body as { reservations: unknown[] }).reservations).toHaveLength(1);
  });

  it('a customer reads only its own orders; another customer\'s order is refused AND recorded; the register names probing to staff', async () => {
    const h = await seeded();
    await post(h, '/v1/storefront/orders/so-1', C1, 'p1', { ...BASKET, payment: PAID });
    await post(h, '/v1/storefront/orders/so-3', C1, 'p3', { lines: [{ productId: 'MILK', quantityMinor: 1 }], locationId: 'L1' });
    await post(h, '/v1/orders/so-desk/promise', OWNER, 'pd', { lines: [{ productId: 'MILK', quantityMinor: 1 }], locationId: 'L1' });
    const mine = (await get(h, '/v1/storefront/orders', C1)).body as { orders: { orderId: string }[] };
    expect(mine.orders.map((o) => o.orderId).sort()).toEqual(['so-1', 'so-3']);
    expect(((await get(h, '/v1/storefront/orders', C2)).body as { orders: unknown[] }).orders).toEqual([]);
    expect((await get(h, '/v1/storefront/orders/so-1', C1)).status).toBe(200);
    expect(codeOf(await get(h, '/v1/storefront/orders/so-1', C2))).toBe('not_your_order');
    expect(codeOf(await get(h, '/v1/storefront/orders/so-3', C2))).toBe('not_your_order');
    expect(codeOf(await get(h, '/v1/storefront/orders/so-desk', C2))).toBe('not_a_storefront_order');
    expect((await get(h, '/v1/storefront/orders/so-none', C2)).status).toBe(404);
    const reg = (await get(h, '/v1/storefront/access-refusals', OWNER)).body as { refusals: { customerRef: string; orderId: string }[]; probing: { customerRef: string; distinctOrders: number }[] };
    expect(reg.refusals.map((r) => [r.customerRef, r.orderId])).toEqual([[C2, 'so-1'], [C2, 'so-3'], [C2, 'so-desk']]);
    expect(reg.probing).toEqual([{ customerRef: C2, distinctOrders: 3 }]);
    expect((await get(h, '/v1/storefront/access-refusals', C1)).status).toBe(403); // a customer never sees the register
  });

  it('an unknown payment answer leaves the order payment-pending and the desk cannot confirm it (§31); a card number is refused unrecorded (#3)', async () => {
    const h = await seeded();
    const pending = await post(h, '/v1/storefront/orders/so-4', C1, 'p4', { ...BASKET, payment: { providerRef: 'tok_slow', amountMinor: 15_000, result: 'unknown', reason: 'gateway timeout' } });
    expect(pending.status).toBe(201);
    expect(pending.body).toMatchObject({ payment: { state: 'pending' } });
    expect((pending.body as { tellTheCustomer: string }).tellTheCustomer).toContain('not placed yet');
    expect(codeOf(await post(h, '/v1/orders/so-4/transition', OWNER, 't4', { event: 'confirm' }))).toBe('payment_pending');
    expect(codeOf(await post(h, '/v1/storefront/orders/so-5', C1, 'p5', { ...BASKET, payment: { ...PAID, providerRef: '4111111111111111' } }))).toBe('not_a_provider_token');
    expect((await get(h, '/v1/storefront/orders/so-5', C1)).status).toBe(404); // nothing was placed
  });

  it('least privilege both ways: a customer cannot use the desk\'s order routes, staff cannot place as a customer, and nothing is reachable without the customer_app entitlement', async () => {
    const h = await seeded();
    expect((await post(h, '/v1/orders/so-x/promise', C1, 'px', BASKET)).status).toBe(403);
    expect((await get(h, '/v1/orders/reservations', C1)).status).toBe(403);
    expect((await post(h, '/v1/storefront/orders/so-y', OWNER, 'py', BASKET)).status).toBe(403);
    const off = await seeded(false);
    const refused = await post(off, '/v1/storefront/orders/so-1', C1, 'p1', BASKET);
    expect(refused.status).toBe(403);
    expect(codeOf(refused)).toBe('feature_not_entitled');
  });
});
