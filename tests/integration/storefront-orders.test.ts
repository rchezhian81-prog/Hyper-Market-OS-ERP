import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { testModePaymentProvider, type TestModePaymentProvider } from '../../packages/orders/src/payment-verification';
import { seedSubstitutionTruth } from '../support/substitution-truth';

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

// FUL-03: the payment provider is the test-mode one — a capture is registered by the test standing in for the bank,
// never by the app's request.
let provider: TestModePaymentProvider;
async function seeded(entitled = true): Promise<ApiHarness> {
  provider = testModePaymentProvider();
  const h = apiHarness({ paymentVerifier: provider });
  await h.seedOwner(T, OWNER);
  await h.provisionRole(T, C1, 'customer');
  await h.provisionRole(T, C2, 'customer');
  if (entitled) await h.enableFeature(T, 'customer_app');
  // Real stock at the store, from the real inventory ledger — what a promise reserves against.
  await h.request({ method: 'POST', path: '/v1/inventory/movements', userId: OWNER, tenantId: T, idempotencyKey: 'mv-1', body: { movementId: 'mv-1', productId: 'MILK', locationId: 'L1', kind: 'received', quantityMinor: 5, uom: 'each', occurredAt: AT, enteredBy: OWNER } });
  return h;
}
/** Head office publishes milk at ₹50 for store L1 — the shop's own price, which the quote is made from (FUL-03). */
async function publishMilk(h: ApiHarness): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const ok = async (path: string, body: unknown, key: string) => expect((await post(h, path, OWNER, key, body)).status, path).toBeLessThan(300);
  await ok('/v1/catalogue/tax-classes/0401/rates/2017-07-01', { rateBps: 0 }, 'tax');
  await ok('/v1/catalogue/products/MILK/publish', { product: { sku: 'MILK-1L', name: 'Milk 1L', baseUom: 'each', primaryCategoryId: 'dairy', taxClass: '0401', lifecycle: 'active' }, categories: [{ categoryId: 'dairy', name: 'Dairy', parentId: null }] }, 'pub');
  await ok('/v1/prices/list/MILK/entries/e1', { scope: 'store', scopeRef: 'L1', priceMinor: 5_000, mrpMinor: 6_000, costMinor: 4_000, marginFloorBps: 0, currency: 'INR', effectiveFrom: today }, 'price');
  await ok('/v1/catalogue/pack', { storeId: 'L1', asOf: today }, 'pack');
}
const post = (h: ApiHarness, path: string, userId: string, key: string, body: unknown) =>
  h.request({ method: 'POST', path, userId, tenantId: T, idempotencyKey: key, body });
const get = (h: ApiHarness, path: string, userId: string) => h.request({ method: 'GET', path, userId, tenantId: T });
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
const BASKET = { lines: [{ productId: 'MILK', quantityMinor: 3 }], locationId: 'L1' };
const PAID = { providerRef: 'tok_cust_1', amountMinor: 15_000, result: 'authorised' };

describe('the storefront places, pays and reads its own orders (M20)', () => {
  it('FUL-03, THE AUDIT\'S CASE: an app that SAYS "authorised" with a made-up token and one paisa is not paid — pending, the mismatch named, and the desk cannot confirm it', async () => {
    const h = await seeded();
    await publishMilk(h);
    const claimed = await post(h, '/v1/storefront/orders/so-fake', C1, 'pf', { ...BASKET, payment: { providerRef: 'tok_made_up', amountMinor: 1, result: 'authorised' } });
    expect(claimed.status).toBe(201);
    expect(claimed.body).toMatchObject({ payment: { state: 'pending', paidMinor: 0 }, quote: { itemsMinor: 15_000 }, amountMismatch: true });
    expect(codeOf(await post(h, '/v1/orders/so-fake/transition', OWNER, 'tf', { event: 'confirm' }))).toBe('payment_pending');
    // The right amount but a token the provider never captured: still pending — the app's word alone is never "paid".
    const unknown = await post(h, '/v1/storefront/orders/so-unk', C2, 'pu', { lines: [{ productId: 'MILK', quantityMinor: 1 }], locationId: 'L1', payment: { providerRef: 'tok_never', amountMinor: 5_000, result: 'authorised' } });
    expect(unknown.body).toMatchObject({ payment: { state: 'pending' } });
    expect(unknown.body).not.toHaveProperty('amountMismatch');
    // The provider captures it later; the customer's app asks the shop to check — the provider's word makes it paid.
    provider.capture('tok_never', 5_000);
    expect((await post(h, '/v1/storefront/orders/so-unk/payment/check', C2, 'pc', {})).body).toMatchObject({ payment: { state: 'authorised', paidMinor: 5_000 } });
    // With no published price there is no quote, and nothing is ever taken as paid.
    const bare = await seeded();
    provider.capture('tok_cust_1', 15_000);
    expect((await post(bare, '/v1/storefront/orders/so-np', C1, 'pn', { ...BASKET, payment: PAID })).body).toMatchObject({ payment: { state: 'pending' }, quote: { unpriced: ['MILK'] } });
  });

  it('a customer places an order that reserves stock and records its payment (captured by the provider for the shop\'s quote); staff see who placed it; a second customer is promised only what is left', async () => {
    const h = await seeded();
    await publishMilk(h);
    provider.capture('tok_cust_1', 15_000);
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
    // FUL-07: short → no payment taken; the customer is told and decides. They pay for the 2 the shop promised…
    expect(second.body).toMatchObject({ needsCustomerDecision: true, shortages: [{ productId: 'MILK', requestedMinor: 3, promisedMinor: 2 }], quote: { itemsMinor: 10_000 } });
    expect((second.body as { tellTheCustomer: string }).tellTheCustomer).toMatch(/not in stock/);
    provider.capture('tok_cust_2', 10_000);
    expect((await post(h, '/v1/storefront/orders/so-2/payment', C2, 'pay2', { providerRef: 'tok_cust_2', amountMinor: 10_000, result: 'authorised' })).body).toMatchObject({ payment: { state: 'authorised', paidMinor: 10_000 } });
    // …and another short order is cancelled by its customer instead: its hold is released, nothing charged.
    const third = await post(h, '/v1/storefront/orders/so-3c', C2, 'p3c', { lines: [{ productId: 'MILK', quantityMinor: 9 }], locationId: 'L1', payment: { providerRef: 'tok_x', amountMinor: 45_000, result: 'authorised' } });
    expect(third.body).toMatchObject({ needsCustomerDecision: true, payment: { state: 'none' } });
    expect((await post(h, '/v1/storefront/orders/so-3c/cancel', C2, 'c3c', {})).body).toMatchObject({ state: 'cancelled' });
    expect(codeOf(await post(h, '/v1/storefront/orders/so-2/cancel', C2, 'c2', {}))).toBe('cancel_at_the_desk'); // paid — a refund is the shop's
    expect(codeOf(await post(h, '/v1/storefront/orders/so-2/cancel', C1, 'c2x', {}))).toBe('not_your_order');
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

describe('FUL-14: the customer\'s own substitution rules and their own yes are what a swap rests on', () => {
  it('a "contact me" customer\'s standing rule makes the picker ask; the customer\'s own yes in the app lets the swap through; another customer cannot answer for the order', async () => {
    const h = await seeded();
    await seedSubstitutionTruth(h, T, [
      { productId: 'MILK', name: 'Milk 1L', priceMinor: 5_000, brand: 'aavin', categoryId: 'dairy' },
      { productId: 'MILK-ALT', name: 'Milk 1L alt', priceMinor: 4_000, brand: 'arokya', categoryId: 'dairy' },
    ]);
    expect((await h.request({ method: 'PUT', path: '/v1/storefront/substitution-preferences', userId: C1, tenantId: T, idempotencyKey: 'pref', body: { rules: { preference: 'contact_me' } } })).status).toBe(200);
    expect((await post(h, '/v1/storefront/orders/so-sub', C1, 'p-sub', { lines: [{ productId: 'MILK', quantityMinor: 2 }], locationId: 'L1' })).status).toBe(201);
    const offer = { lineId: 'l1', orderedProductId: 'MILK', orderedName: 'Milk', orderedUnitPriceMinor: 0, orderedQuantityMinor: 2, substituteProductId: 'MILK-ALT', substituteName: 'Alt', substituteUnitPriceMinor: 0, substituteQuantityMinor: 2, offeredAt: AT };
    const asked = await post(h, '/v1/orders/so-sub/substitute', OWNER, 's1', { offer, decision: 'confirmed' });
    expect(codeOf(asked)).toBe('customer_consent_required');
    // Another customer cannot answer for this order — refused and recorded.
    expect((await post(h, '/v1/storefront/orders/so-sub/substitutions/l1', C2, 'c2', { substituteProductId: 'MILK-ALT', decision: 'confirmed' })).status).toBe(403);
    // The customer says yes in the app.
    expect((await post(h, '/v1/storefront/orders/so-sub/substitutions/l1', C1, 'c1', { substituteProductId: 'MILK-ALT', decision: 'confirmed' })).status).toBe(201);
    const swapped = await post(h, '/v1/orders/so-sub/substitute', OWNER, 's2', { offer, decision: 'confirmed' });
    expect(swapped.status).toBe(201);
    expect(swapped.body).toMatchObject({ outcome: 'substituted', eligibility: 'needs_confirmation', consent: { given: 'customer', by: C1 }, chargeMinor: 8_000 });
  });
});
