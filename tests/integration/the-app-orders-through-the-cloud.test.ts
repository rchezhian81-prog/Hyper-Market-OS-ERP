import { describe, it, expect } from 'vitest';
import { apiHarness, TEST_IDP, type ApiHarness } from '../support/api-harness';
import { bootShop, forgetfulBasket, type ShopData } from '../../apps/customer-app/src/browser-entry';
import { httpShopTransport } from '../../apps/customer-app/src/shop-transport';
import type { StorefrontProduct } from '../../packages/storefront/src/browse';
import { testModePaymentProvider, type TestModePaymentProvider } from '../../packages/orders/src/payment-verification';

/**
 * M20-FR-03 / §31 (Stage C, M20 slice 2) — the customer app's REAL transport against the REAL API.
 *
 * `tests/unit/customer-app-places-through-the-shop.test.ts` proves the hop against a scripted shop. This
 * drives the same `bootShop` + `httpShopTransport` into the authenticated API kernel — the exact request
 * the browser makes (path, bearer, idempotency key, body) — and proves the cloud ends up holding the
 * order for the signed-in customer with real stock reserved, that a request lost on the way is sent
 * once and only once when it gets through, and that the shop's refusals reach the customer in the
 * shop's own words.
 */

const T = 'ab000000-0000-4000-8000-000000000048';
const OWNER = 'u-owner'; const C1 = 'cust-1'; const C2 = 'cust-2';
const AT = '2026-10-10T10:00:00.000Z';
const NOW = '2026-10-10T11:00:00.000Z';

const MILK: StorefrontProduct = {
  productId: 'MILK', name: 'Aavin Milk 1L', categoryId: 'dairy', unitPriceMinor: 60_00, uom: 'each',
  barcodes: ['8901234567891'], status: 'active', availableMinor: 5, availabilityAgeMinutes: 1,
};
const data = (over: Partial<ShopData> = {}): ShopData => ({
  tenantId: T, customerRef: C1, products: [MILK], packVersion: 3, locationId: 'L1',
  slots: [{ slotId: 'S-17', startsAt: '2026-10-10T17:00:00.000Z', endsAt: '2026-10-10T19:00:00.000Z', capacity: 4, booked: 0, kind: 'delivery' }],
  policy: { radiusMetres: 10_000, deliveryFeeMinor: 40_00 }, deliveryFeeMinor: 40_00,
  storeLocation: { lat: 11.0168, lon: 76.9558 }, deliveryLocation: { lat: 11.0200, lon: 76.9600 },
  ...over,
});

// FUL-03: the test-mode payment provider — captures are registered here, standing in for the bank, never by the app.
let provider: TestModePaymentProvider;
async function seeded(entitled = true): Promise<ApiHarness> {
  provider = testModePaymentProvider();
  const h = apiHarness({ paymentVerifier: provider });
  await h.seedOwner(T, OWNER);
  await h.provisionRole(T, C1, 'customer');
  await h.provisionRole(T, C2, 'customer');
  if (entitled) await h.enableFeature(T, 'customer_app');
  await h.request({ method: 'POST', path: '/v1/inventory/movements', userId: OWNER, tenantId: T, idempotencyKey: 'mv-1', body: { movementId: 'mv-1', productId: 'MILK', locationId: 'L1', kind: 'received', quantityMinor: 5, uom: 'each', occurredAt: AT, enteredBy: OWNER } });
  // The shop's own figures the quote is made from (FUL-03): milk published at ₹60 for L1, and a ₹40 delivery fee.
  const today = new Date().toISOString().slice(0, 10);
  const ok = async (path: string, body: unknown, key: string) => expect((await h.request({ method: 'POST', path, userId: OWNER, tenantId: T, idempotencyKey: key, body })).status, path).toBeLessThan(300);
  await ok('/v1/catalogue/tax-classes/0401/rates/2017-07-01', { rateBps: 0 }, 'tax');
  await ok('/v1/catalogue/products/MILK/publish', { product: { sku: 'MILK-1L', name: 'Aavin Milk 1L', baseUom: 'each', primaryCategoryId: 'dairy', taxClass: '0401', lifecycle: 'active' }, categories: [{ categoryId: 'dairy', name: 'Dairy', parentId: null }] }, 'pub');
  await ok('/v1/prices/list/MILK/entries/e1', { scope: 'store', scopeRef: 'L1', priceMinor: 60_00, mrpMinor: 70_00, costMinor: 40_00, marginFloorBps: 0, currency: 'INR', effectiveFrom: today }, 'price');
  await ok('/v1/catalogue/pack', { storeId: 'L1', asOf: today }, 'pack');
  await ok('/v1/serviceability/periods/2026-01-01', { radiusMetres: 10_000, deliveryFeeMinor: 40_00 }, 'svc');
  return h;
}

/** The app's `fetch`, wired straight into the real API kernel — what a same-origin reverse proxy does. */
function fetchInto(h: ApiHarness, log: { method: string; path: string; auth: boolean; key?: string }[] = []) {
  return (async (url: string | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const auth = headers['authorization'] ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : undefined;
    const method = (init?.method ?? 'GET') as 'GET' | 'POST';
    const path = String(url);
    const key = headers['idempotency-key'];
    log.push({ method, path, auth: token !== undefined, ...(key === undefined ? {} : { key }) });
    const res = await h.raw({
      method, path, ...(token === undefined ? {} : { token }),
      ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) as unknown }),
      ...(key === undefined ? {} : { idempotencyKey: key }),
    });
    return new Response(JSON.stringify(res.body ?? null), { status: res.status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof globalThis.fetch;
}

const customerToken = (sub: string) => TEST_IDP.issue({ sub, tenantId: T, amr: ['otp'] });
const PAY = { providerRef: 'tok_2f9a41ce', result: 'authorised' as const };

let n = 0;
function appReady(fetchFn: typeof globalThis.fetch, token: string | undefined, over: Partial<ShopData> = {}) {
  const shop = bootShop(data(over), forgetfulBasket(), () => 'DSR-1', httpShopTransport({ fetch: fetchFn }), () => `ORD-IT-${(n += 1)}`)!;
  shop.setLine('MILK', 2);
  shop.review();
  shop.chooseSlot('S-17', NOW);
  if (token !== undefined) shop.signedIn(token);
  return shop;
}

describe('the customer app places its order through the real API (M20-FR-03, slice 2)', () => {
  it('the cloud holds the order FOR the signed-in customer, with the payment and real stock reserved; a second customer is promised only what is left', async () => {
    const h = await seeded();
    const log: { method: string; path: string; auth: boolean; key?: string }[] = [];
    const shop = appReady(fetchInto(h, log), customerToken(C1));
    // The provider captured exactly the shop's quote: 2 × ₹60 + ₹40 delivery.
    provider.capture(PAY.providerRef, 2 * 60_00 + 40_00);
    const out = await shop.place(PAY);
    expect(out).toMatchObject({ ok: true, shopHasIt: true, paymentState: 'authorised', quoteMinor: 2 * 60_00 + 40_00 });
    const orderId = out.ok ? out.orderId : '';
    expect(shop.statusLine()).toMatch(/confirmed and will be picked/);

    // Exactly one authenticated, idempotent POST to the storefront route — nothing else left the app.
    expect(log).toEqual([{ method: 'POST', path: `/v1/storefront/orders/${orderId}`, auth: true, key: `storefront-order-${orderId}` }]);

    // The customer's own view of it on the cloud.
    const mine = await h.request({ method: 'GET', path: '/v1/storefront/orders', userId: C1, tenantId: T });
    expect(mine.status).toBe(200);
    const orders = (mine.body as { orders: { orderId: string; payment: { state: string; paidMinor: number } }[] }).orders;
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ orderId, payment: { state: 'authorised', paidMinor: 2 * 60_00 + 40_00 } });

    // Staff see who placed it.
    const staff = await h.request({ method: 'GET', path: `/v1/storefront/orders/${orderId}`, userId: C1, tenantId: T });
    expect(staff.status).toBe(200);
    // Real stock: 5 on hand, 2 reserved by the app → a second customer asking for 5 is promised 3.
    const second = await h.request({ method: 'POST', path: '/v1/storefront/orders/so-second', userId: C2, tenantId: T, idempotencyKey: 'so-second', body: { lines: [{ productId: 'MILK', quantityMinor: 5 }], locationId: 'L1' } });
    expect(second.status).toBe(201);
    const promise = (second.body as { promise: { lines: { productId: string; promisedMinor: number }[] } }).promise;
    expect(promise.lines[0]).toMatchObject({ productId: 'MILK', promisedMinor: 3 });
  });

  it('FUL-03/FUL-07: the app\'s "authorised" alone is not paid — the screen shows the SHOP\'s answer (waiting), and turns confirmed only when the provider has captured it', async () => {
    const h = await seeded();
    const shop = appReady(fetchInto(h, []), customerToken(C1));
    const out = await shop.place(PAY); // the provider has not captured anything
    expect(out).toMatchObject({ ok: true, shopHasIt: true, paymentState: 'pending' });
    expect(shop.statusLine()).toMatch(/waiting on your bank/);
    expect(shop.statusLine()).not.toMatch(/confirmed and will be picked/);
    provider.capture(PAY.providerRef, 2 * 60_00 + 40_00);
    expect(await shop.checkPayment()).toMatchObject({ ok: true, paymentState: 'authorised' });
    expect(shop.statusLine()).toMatch(/confirmed and will be picked/);
  });

  it('FUL-07: when the shop cannot promise everything, nothing is charged — the app shows the shortage and the customer pays the shop\'s price for what it has, or cancels', async () => {
    const h = await seeded();
    // Another customer takes 4 of the 5 first.
    expect((await h.request({ method: 'POST', path: '/v1/storefront/orders/so-first', userId: C2, tenantId: T, idempotencyKey: 'so-first', body: { lines: [{ productId: 'MILK', quantityMinor: 4 }], locationId: 'L1' } })).status).toBe(201);
    const shop = appReady(fetchInto(h, []), customerToken(C1)); // asks for 2
    const out = await shop.place(PAY);
    expect(out).toMatchObject({ ok: true, shopHasIt: true, needsDecision: true, shortages: [{ productId: 'MILK', requestedMinor: 2, promisedMinor: 1 }], quoteMinor: 60_00 + 40_00, paymentState: 'none' });
    expect(shop.statusLine()).toMatch(/not in stock/);
    provider.capture('tok_short', 60_00 + 40_00);
    expect(await shop.payForWhatTheShopHas({ providerRef: 'tok_short', result: 'authorised' })).toMatchObject({ ok: true, paymentState: 'authorised' });
    expect(shop.statusLine()).toMatch(/confirmed and will be picked/);

    const other = appReady(fetchInto(h, []), customerToken(C2)); // nothing left: 5 − 4 − 1
    const short = await other.place({ providerRef: 'tok_none', result: 'authorised' });
    expect(short).toMatchObject({ needsDecision: true });
    expect(await other.cancelOrder()).toMatchObject({ ok: true });
    expect(other.statusLine()).toMatch(/cancelled/);
  });

  it('a request lost on the way is prepared, not sent — and when it gets through it is the SAME order, held once', async () => {
    const h = await seeded();
    const log: { method: string; path: string; auth: boolean; key?: string }[] = [];
    let cut = true;
    const real = fetchInto(h, log);
    const flaky = ((url: string | URL, init?: RequestInit) => (cut ? Promise.reject(new TypeError('Failed to fetch')) : real(url, init))) as unknown as typeof globalThis.fetch;
    const shop = appReady(flaky, customerToken(C1));

    const first = await shop.place(PAY);
    expect(first).toMatchObject({ ok: true, shopHasIt: false });
    expect(shop.state().stage).toBe('waiting_for_signal');
    expect(shop.state().tellTheCustomer).toMatch(/NOT been sent/);
    expect((await h.request({ method: 'GET', path: '/v1/storefront/orders', userId: C1, tenantId: T }).then((r) => (r.body as { orders: unknown[] }).orders))).toHaveLength(0);

    cut = false;
    const again = await shop.retry();
    expect(again).toMatchObject({ ok: true, shopHasIt: true, orderId: first.ok ? first.orderId : '' });
    // A second retry (a tap that races the connection event) reaches an order the shop already holds.
    const third = await shop.place(PAY);
    expect(third).toMatchObject({ ok: false, refusedBecause: 'already_sent' });
    const orders = (await h.request({ method: 'GET', path: '/v1/storefront/orders', userId: C1, tenantId: T })).body as { orders: { orderId: string }[] };
    expect(orders.orders).toHaveLength(1);
    expect(log.filter((l) => l.method === 'POST')).toHaveLength(1);
  });

  it('the same request replayed by the transport (same order id, same key) is the same order — the kernel replays its first answer, never a second order', async () => {
    const h = await seeded();
    const transport = httpShopTransport({ fetch: fetchInto(h) });
    const request = { orderId: 'ORD-REPLAY', token: customerToken(C1), lines: [{ productId: 'MILK', quantityMinor: 1 }], locationId: 'L1', payment: { providerRef: 'tok_2f9a41ce', amountMinor: 100_00, result: 'authorised' as const } };
    const a = await transport.placeOrder(request);
    const b = await transport.placeOrder(request);
    expect(a).toMatchObject({ reached: true, status: 201 });
    // The idempotency key is the order, so the kernel hands back the FIRST answer (the stored 201) —
    // which the app reads as "placed", the same as the route's own 200 `alreadyPlaced` for a retry
    // under a new key. Either way one order.
    expect(b).toMatchObject({ reached: true, status: 201 });
    expect((b as { body: { orderId: string } }).body.orderId).toBe('ORD-REPLAY');
    const orders = (await h.request({ method: 'GET', path: '/v1/storefront/orders', userId: C1, tenantId: T })).body as { orders: unknown[] };
    expect(orders.orders).toHaveLength(1);
  });

  it('a sign-in that has ended is refused by the real kernel (401) and the app says so, keeping the basket', async () => {
    const h = await seeded();
    const shop = appReady(fetchInto(h), 'not-a-real-token');
    const out = await shop.place(PAY);
    expect(out).toMatchObject({ ok: false, refusedBecause: 'signed_out' });
    expect(shop.isSignedIn()).toBe(false);
    expect(shop.state().stage).toBe('slot_booked');
    expect((await h.request({ method: 'GET', path: '/v1/storefront/orders', userId: C1, tenantId: T })).body).toMatchObject({ orders: [] });
  });

  it('the shop\'s refusals reach the customer in the shop\'s words: no customer role, and no customer_app entitlement', async () => {
    const h = await seeded();
    const stranger = appReady(fetchInto(h), customerToken('u-stranger'));
    const out = await stranger.place(PAY);
    expect(out).toMatchObject({ ok: false, refusedBecause: 'the_shop_refused' });
    expect(out.ok === false && out.tellTheCustomer).toMatch(/does not hold/);
    expect(stranger.state().stage).toBe('slot_booked');

    const off = await seeded(false);
    const noPlan = appReady(fetchInto(off), customerToken(C1));
    const refused = await noPlan.place(PAY);
    expect(refused).toMatchObject({ ok: false, refusedBecause: 'the_shop_refused' });
    expect(refused.ok === false && refused.tellTheCustomer).toMatch(/plan does not include/);
  });
});
