// R4 Lane 2 — a synthetic online shop on the REAL API (in memory or on PostgreSQL): the products, prices, stock and
// delivery fee the online store reads, a customer, and a delivered order of theirs. Every fact goes through the
// production routes; nothing here is a real person, a real price or a real provider.

import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type { ApiHarness } from './api-harness';
import type { TestModePaymentProvider } from '../../packages/orders/src/payment-verification';
import { sellOnline } from './sell-online';

export const OWNER = 'u-owner';
export const MANAGER = 'u-manager';
export const CASHIER = 'u-cashier';
export const CHECKER = 'u-checker';
export const CUSTOMER = 'cust-app-1';
export const OTHER_CUSTOMER = 'cust-app-2';
export const STORE = 'store-01';
export type Res = { status: number; body: unknown };
export const codeOf = (r: Res): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
export const saidOf = (r: Res): string => (r.body as { error?: { whatHappened?: string } }).error?.whatHappened ?? '';

export interface ShopCalls {
  readonly req: (method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown, userId?: string, query?: Record<string, string>) => Promise<Res>;
  readonly ok: (p: Promise<Res>, what: string) => Promise<Res>;
}

export function callsFor(h: () => ApiHarness, T: string): ShopCalls {
  const req = (method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown, userId = OWNER, query?: Record<string, string>): Promise<Res> =>
    h().request({ method, path, userId, tenantId: T, ...(method === 'GET' ? {} : { idempotencyKey: `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });
  const ok = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
  return { req, ok };
}

/**
 * MILK (dairy, food, batch on hand to 2099-12-31, from India, MRP ₹70, ₹60 incl. 5% GST), BROOM (household, no country
 * of origin) and SAREE (a concession tenant's goods on the shelf). A ₹40 delivery fee. The cast: a manager, a cashier, a
 * second person who approves refunds, and two app customers.
 */
/** The product's printed MRP, in force from the start of the year (the master's effective-dated history, M03-FR-03). */
const mrp = (minor: number) => [{ value: { minor, currency: 'INR' }, effectiveFrom: '2026-01-01' }];

export async function seedOnlineShop(h: ApiHarness, T: string, c: ShopCalls): Promise<void> {
  await h.seedOwner(T, OWNER);
  await h.enableFeature(T, 'customer_app');
  await h.provisionRole(T, MANAGER, 'store_manager');
  await h.provisionRole(T, CASHIER, 'cashier');
  await h.provisionRole(T, CHECKER, 'store_manager');
  await h.provisionRole(T, CUSTOMER, 'customer');
  await h.provisionRole(T, OTHER_CUSTOMER, 'customer');
  await seedOnlineCatalogue(c);
}

/** The catalogue half of the shop — products, prices, stock, the pack and the delivery fee — through any caller's routes. */
export async function seedOnlineCatalogue(c: ShopCalls, store = STORE): Promise<void> {
  const { ok, req } = c;
  // The API runs on the real clock: prices start today, stock arrived an hour ago (no time-of-day trap: whole days only).
  const today = new Date().toISOString().slice(0, 10);
  const arrived = new Date(Date.now() - 3_600_000).toISOString();
  await ok(req('POST', '/v1/catalogue/tax-classes/0401/rates/2017-07-01', { rateBps: 500 }), 'tax 0401');
  await ok(req('POST', '/v1/catalogue/tax-classes/9603/rates/2017-07-01', { rateBps: 1_800 }), 'tax 9603');
  await ok(req('POST', '/v1/catalogue/tax-classes/5208/rates/2017-07-01', { rateBps: 500 }), 'tax 5208');
  await ok(req('POST', '/v1/catalogue/products/MILK/publish', {
    product: { sku: 'MILK-1L', name: 'Synthetic Milk 1L', baseUom: 'ea', primaryCategoryId: 'dairy', taxClass: '0401', lifecycle: 'active', mrpHistory: mrp(70_00), safety: { allergens: ['milk'], countryOfOrigin: 'India' } },
    categories: [{ categoryId: 'dairy', name: 'Dairy', parentId: null, regulated: ['food'] }],
  }), 'publish MILK');
  await ok(req('POST', '/v1/catalogue/products/BROOM/publish', {
    product: { sku: 'BROOM-1', name: 'Synthetic Broom', baseUom: 'ea', primaryCategoryId: 'household', taxClass: '9603', lifecycle: 'active', mrpHistory: mrp(180_00) },
    categories: [{ categoryId: 'household', name: 'Household', parentId: null }],
  }), 'publish BROOM');
  await ok(req('POST', '/v1/catalogue/products/SAREE/publish', {
    product: { sku: 'SAREE-1', name: 'Synthetic Saree', baseUom: 'ea', primaryCategoryId: 'textiles', taxClass: '5208', lifecycle: 'active', mrpHistory: mrp(1_500_00), safety: { countryOfOrigin: 'India' } },
    categories: [{ categoryId: 'textiles', name: 'Textiles', parentId: null }],
  }), 'publish SAREE');
  for (const [id, price, mrp] of [['MILK', 60_00, 70_00], ['BROOM', 150_00, 180_00], ['SAREE', 1_200_00, 1_500_00]] as const) {
    await ok(req('POST', `/v1/prices/list/${id}/entries/e1`, { scope: 'store', scopeRef: store, priceMinor: price, mrpMinor: mrp, costMinor: 1, marginFloorBps: 0, currency: 'INR', effectiveFrom: today }), `price ${id}`);
  }
  await ok(req('POST', '/v1/inventory/movements', { movementId: 'rx-milk', productId: 'MILK', locationId: store, kind: 'received', quantityMinor: 20, uom: 'ea', occurredAt: arrived, enteredBy: OWNER, batchId: 'M-01', expiry: '2099-12-31', unitCostMinor: 40_00 }), 'receive MILK');
  await ok(req('POST', '/v1/inventory/movements', { movementId: 'rx-broom', productId: 'BROOM', locationId: store, kind: 'received', quantityMinor: 10, uom: 'ea', occurredAt: arrived, enteredBy: OWNER, unitCostMinor: 90_00 }), 'receive BROOM');
  await ok(req('POST', '/v1/inventory/movements', { movementId: 'rx-saree', productId: 'SAREE', locationId: store, kind: 'received', quantityMinor: 3, uom: 'ea', occurredAt: arrived, enteredBy: OWNER, ownership: 'concession', ownerId: 'silks-counter' }), 'receive SAREE (concession)');
  await ok(req('POST', '/v1/catalogue/pack', { storeId: store, asOf: today }), 'pack');
  await ok(req('POST', '/v1/serviceability/periods/2026-01-01', { radiusMetres: 10_000, deliveryFeeMinor: 40_00 }), 'delivery fee');
}

/**
 * OB-234: the online store sells only what the shop has published online. Set the shop's (synthetic) details, give BROOM
 * the country of origin it lacks, and publish MILK and BROOM online. SAREE (another seller's goods) is never listed.
 */
export async function listShopOnline(c: ShopCalls): Promise<void> {
  await c.ok(c.req('POST', '/v1/catalogue/products/BROOM/publish', {
    product: { sku: 'BROOM-1', name: 'Synthetic Broom', baseUom: 'ea', primaryCategoryId: 'household', taxClass: '9603', lifecycle: 'active', mrpHistory: mrp(180_00), safety: { countryOfOrigin: 'India' } },
    categories: [{ categoryId: 'household', name: 'Household', parentId: null }],
  }), 'BROOM country of origin');
  await sellOnline((path, body) => c.req('POST', path, body), ['MILK', 'BROOM']);
}

/** The customer orders 2 MILK and 1 BROOM, pays (the test provider captures it), and the shop delivers it. */
export async function deliveredOrder(c: ShopCalls, provider: TestModePaymentProvider, orderId: string, customer = CUSTOMER, payRef = `tok-${orderId}`): Promise<void> {
  const { ok, req } = c;
  provider.capture(payRef, 2 * 60_00 + 150_00);
  const placed = await ok(req('POST', `/v1/storefront/orders/${orderId}`, { lines: [{ productId: 'MILK', quantityMinor: 2 }, { productId: 'BROOM', quantityMinor: 1 }], locationId: STORE, payment: { providerRef: payRef, amountMinor: 2 * 60_00 + 150_00, result: 'authorised' } }, customer), `place ${orderId}`);
  expect((placed.body as { payment?: { state: string } }).payment?.state, JSON.stringify(placed.body)).toBe('authorised');
  for (const event of ['confirm', 'pick', 'pack', 'dispatch', 'deliver']) await ok(req('POST', `/v1/orders/${orderId}/transition`, { event }), `${orderId} ${event}`);
}
