import { describe, it, expect } from 'vitest';
import { scopeOrderToCustomer, probingCustomers, type StorefrontAccessRefusal } from '../../packages/orders/src/storefront-scope';
import { storefrontRoutes, type StorefrontDeps } from '../../services/orders/src/storefront';
import type { OrdersDeps, PlacedOrder } from '../../services/orders/src/index';
import type { PaymentRefundDeps } from '../../services/orders/src/payments';
import { testModeRefundProcessor, type OrderPayment } from '../../packages/orders/src/payment-refunds';
import type { RequestContext, Route } from '../../services/kernel/src/index';

/**
 * **Customer-scoped orders — the pure scope decision and the storefront routes over a stubbed ledger (M20 · §35 · #6).**
 *
 * A customer sees its own orders and nothing else. "Own" is what the order records about who placed it — the
 * authenticated subject at placement — never an id in the request. Another customer's order, or a desk order with
 * no customer, is refused AND recorded; probing (more than one distinct refused order) is named for staff.
 */

const NOW = '2026-10-10T10:00:00.000Z';
const T = 't-sre';
const order = (over: Partial<PlacedOrder> = {}): PlacedOrder =>
  ({ orderId: 'o1', locationId: 'L1', lines: [{ productId: 'MILK', quantityMinor: 2 }], state: 'placed', placedAt: NOW, customerRef: 'cust-1', ...over });

describe('scopeOrderToCustomer', () => {
  it('own → allowed; unknown → a plain 404, not a security event', () => {
    expect(scopeOrderToCustomer({ order: order(), customerRef: 'cust-1' })).toMatchObject({ outcome: 'own', allowed: true, securityEvent: false });
    expect(scopeOrderToCustomer({ order: undefined, customerRef: 'cust-1' })).toMatchObject({ outcome: 'unknown', allowed: false, securityEvent: false });
  });
  it('another customer\'s order and a desk order are both refused AND security events', () => {
    expect(scopeOrderToCustomer({ order: order(), customerRef: 'cust-2' })).toMatchObject({ outcome: 'not_your_order', allowed: false, securityEvent: true });
    expect(scopeOrderToCustomer({ order: order({ customerRef: undefined }), customerRef: 'cust-1' })).toMatchObject({ outcome: 'not_a_storefront_order', allowed: false, securityEvent: true });
  });
  it('probingCustomers names a customer refused on two or more DISTINCT orders — a retry on one order is not probing', () => {
    const r = (customerRef: string, orderId: string): StorefrontAccessRefusal => ({ customerRef, orderId, outcome: 'not_your_order', action: 'read', at: NOW });
    expect(probingCustomers([r('a', 'o1'), r('a', 'o1'), r('b', 'o1'), r('b', 'o2'), r('c', 'o1'), r('c', 'o2'), r('c', 'o3')]))
      .toEqual([{ customerRef: 'c', distinctOrders: 3 }, { customerRef: 'b', distinctOrders: 2 }]);
    expect(probingCustomers([])).toEqual([]);
  });
});

function stub() {
  const l = { placed: [] as PlacedOrder[], payments: [] as OrderPayment[], refusals: [] as StorefrontAccessRefusal[], held: 0 };
  const deps: OrdersDeps & PaymentRefundDeps & StorefrontDeps = {
    onHand: () => new Map([['MILK', 10]]), outstanding: () => [], holdReservations: (_t, rs) => { l.held += rs.length; }, holdMinutes: 60, now: () => NOW,
    recordPlaced: (_t, o) => { l.placed.push(o); },
    orderState: (_t, id) => { const o = l.placed.find((p) => p.orderId === id); return o === undefined ? undefined : { state: o.state, locationId: o.locationId, lines: o.lines }; },
    orderReservations: () => [], recordTransition: () => {}, releaseReservations: () => {},
    recordSubstitution: () => {}, orderSubstitutions: () => [], allSubstitutions: () => [], recordBackorder: () => {}, orderBackorders: () => [],
    orderPayment: (_t, id) => l.payments.find((p) => p.orderId === id), paymentResolution: () => undefined,
    recordPayment: (_t, p) => { l.payments.push(p); }, recordPaymentResolution: () => {},
    orderRefunds: () => [], refundOutcomes: () => [], recordRefund: () => {}, recordRefundOutcome: () => {},
    allPayments: () => l.payments, allPaymentResolutions: () => [], allRefunds: () => [], allRefundOutcomes: () => [],
    refundThreshold: () => 0, holdsPermission: () => false, refundProcessor: testModeRefundProcessor(),
    placedOrder: (_t, id) => l.placed.find((p) => p.orderId === id),
    ordersForCustomer: (_t, c) => l.placed.filter((p) => p.customerRef === c),
    recordAccessRefusal: (_t, r) => { l.refusals.push(r); },
    accessRefusals: () => l.refusals,
  };
  return { l, routes: storefrontRoutes(deps) };
}
const ctx = (over: Partial<RequestContext> = {}): RequestContext =>
  ({ tenantId: T, userId: 'cust-1', branchId: null, params: { orderId: 'o1' }, query: {}, body: undefined, traceId: 't', ...over });
const routeFor = (routes: readonly Route[], method: string, path: string): Route => {
  const r = routes.find((x) => x.method === method && x.path === path);
  if (r === undefined) throw new Error(`no route ${method} ${path}`);
  return r;
};
interface Thrown { readonly status: number; readonly body: { readonly code: string } }
async function thrown(fn: () => unknown): Promise<Thrown> {
  try { await fn(); } catch (e) { return e as Thrown; }
  throw new Error('expected a refusal');
}
const BODY = { lines: [{ productId: 'MILK', quantityMinor: 2 }], locationId: 'L1', payment: { providerRef: 'tok_1', amountMinor: 10_000, result: 'authorised' } };

describe('storefront routes over a stubbed ledger', () => {
  it('four routes, all behind the customer_app entitlement; the register is a staff read', () => {
    const { routes } = stub();
    expect(routes.map((r) => [r.method, r.path, r.permission, r.entitlement])).toEqual([
      ['POST', '/v1/storefront/orders/:orderId', 'storefront.order.place', 'customer_app'],
      ['GET', '/v1/storefront/access-refusals', 'order.read', 'customer_app'],
      ['GET', '/v1/storefront/orders', 'storefront.order.read', 'customer_app'],
      ['GET', '/v1/storefront/orders/:orderId', 'storefront.order.read', 'customer_app'],
    ]);
  });

  it('places for the SIGNED-IN customer (never a body field), reserves in the same breath, records the payment; a retry reserves nothing twice', async () => {
    const s = stub();
    const post = routeFor(s.routes, 'POST', '/v1/storefront/orders/:orderId');
    const res = await post.handler(ctx({ body: { ...BODY, customerRef: 'cust-EVIL' } }));
    expect(res.status).toBe(201);
    expect(s.l.placed[0]).toMatchObject({ orderId: 'o1', customerRef: 'cust-1' });
    expect(s.l.held).toBe(1);
    expect(s.l.payments[0]).toMatchObject({ orderId: 'o1', providerRef: 'tok_1', recordedBy: 'cust-1' });
    expect(res.body).toMatchObject({ state: 'placed', payment: { state: 'authorised', paidMinor: 10_000 }, promise: { outcome: 'promised' } });
    const again = await post.handler(ctx({ body: BODY }));
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ alreadyPlaced: true });
    expect(s.l.held).toBe(1);
    expect(s.l.payments).toHaveLength(1);
  });

  it('a card-shaped payment reference and an unreadable basket are refused with nothing reserved or recorded', async () => {
    const s = stub();
    const post = routeFor(s.routes, 'POST', '/v1/storefront/orders/:orderId');
    expect((await thrown(() => post.handler(ctx({ body: { ...BODY, payment: { ...BODY.payment, providerRef: '4111 1111 1111 1111' } } })))).body.code).toBe('not_a_provider_token');
    for (const body of [undefined, { lines: [], locationId: 'L1' }, { lines: [{ productId: 'MILK', quantityMinor: 0 }], locationId: 'L1' }, { lines: BODY.lines }, { ...BODY, payment: { providerRef: 'tok', amountMinor: 1, result: 'maybe' } }]) {
      expect((await thrown(() => post.handler(ctx({ body })))).body.code).toBe('not_readable_as_an_order');
    }
    expect(s.l.placed).toEqual([]); expect(s.l.held).toBe(0); expect(s.l.payments).toEqual([]);
  });

  it('another customer\'s order — read or place — is refused AND recorded; a desk order too; an unknown order is a plain 404', async () => {
    const s = stub();
    s.l.placed.push(order({ orderId: 'o1', customerRef: 'cust-1' }), order({ orderId: 'o-desk', customerRef: undefined }));
    const get = routeFor(s.routes, 'GET', '/v1/storefront/orders/:orderId');
    const post = routeFor(s.routes, 'POST', '/v1/storefront/orders/:orderId');
    expect((await thrown(() => get.handler(ctx({ userId: 'cust-2' })))).body.code).toBe('not_your_order');
    expect((await thrown(() => post.handler(ctx({ userId: 'cust-2', body: BODY })))).body.code).toBe('not_your_order');
    expect((await thrown(() => get.handler(ctx({ params: { orderId: 'o-desk' } })))).body.code).toBe('not_a_storefront_order');
    expect((await thrown(() => get.handler(ctx({ params: { orderId: 'o-none' } })))).status).toBe(404);
    expect(s.l.refusals.map((r) => [r.customerRef, r.orderId, r.outcome, r.action])).toEqual([
      ['cust-2', 'o1', 'not_your_order', 'read'], ['cust-2', 'o1', 'not_your_order', 'place'], ['cust-1', 'o-desk', 'not_a_storefront_order', 'read'],
    ]);
    const reg = await routeFor(s.routes, 'GET', '/v1/storefront/access-refusals').handler(ctx({ userId: 'u-owner' }));
    expect(reg.body).toMatchObject({ probing: [] }); // cust-2 was refused twice on ONE order — a retry, not probing
    expect((await get.handler(ctx())).body).toMatchObject({ orderId: 'o1', state: 'placed', payment: { state: 'none' } });
  });

  it('my orders lists only mine, newest first', async () => {
    const s = stub();
    s.l.placed.push(order({ orderId: 'a', placedAt: '2026-10-01T00:00:00.000Z' }), order({ orderId: 'b', placedAt: '2026-10-02T00:00:00.000Z' }), order({ orderId: 'x', customerRef: 'cust-2' }));
    const res = await routeFor(s.routes, 'GET', '/v1/storefront/orders').handler(ctx());
    expect((res.body as { orders: { orderId: string }[] }).orders.map((o) => o.orderId)).toEqual(['b', 'a']);
  });
});
