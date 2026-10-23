// OB-288 fulfilment & delivery test support: a synthetic shop that delivers — through the production routes only. The
// owner, a dispatcher (store manager), a second manager, a picker and a driver (each holding the job's grant), a cashier
// and three customers; three products published to the store's pack and listed online; stock received at the store and
// put away to pickable bins; the delivery service (where the store is, its slots); and delivery orders placed by the
// customers for tomorrow's slots and confirmed by the owner. Nothing here is a real person, address or price.

import { randomUUID } from 'node:crypto';
import type { ApiHarness } from './api-harness';
import { listableProduct } from './sell-online';

export const OWNER = 'u-owner';
export const DISPATCHER = 'u-dispatch';
export const MANAGER2 = 'u-mgr-2';
export const PICKER = 'u-picker';
export const DRIVER = 'u-driver';
export const DRIVER2 = 'u-driver-2';
export const CASHIER = 'u-cash';
export const CUSTOMERS = ['c-1', 'c-2', 'c-3'] as const;
export const STORE_ID = 'L1';
export const STORE = { lat: 11.0168, lon: 76.9558 };
/** Synthetic doors, each well inside the 10 km radius. */
export const DOORS = {
  near: { lat: 11.0200, lon: 76.9600 },
  mid: { lat: 11.0300, lon: 76.9700 },
  far: { lat: 11.0500, lon: 76.9900 },
} as const;
export const PRODUCTS = [
  { productId: 'RICE', priceMinor: 80_00 },
  { productId: 'DAL', priceMinor: 75_00 },
  { productId: 'OIL', priceMinor: 190_00 },
] as const;

export const codeOf = (r: { body: unknown }): string | undefined => (r.body as { error?: { code?: string } }).error?.code;

export interface Shop {
  readonly h: ApiHarness;
  readonly t: string;
  call(method: 'GET' | 'POST' | 'PUT', path: string, userId: string, body?: unknown, query?: Record<string, string>): ReturnType<ApiHarness['request']>;
  ok(method: 'GET' | 'POST' | 'PUT', path: string, userId: string, body?: unknown, query?: Record<string, string>): Promise<Record<string, unknown>>;
  /** Tomorrow's delivery slots, in the store's time zone. */
  readonly slots: readonly { readonly startsAt: string; readonly endsAt: string }[];
  /** Tomorrow, as the shop's own date. */
  readonly runDate: string;
  /** Place a delivery order as a customer in a slot to a door, then confirm it as the owner. */
  placeConfirmed(customer: string, orderId: string, lines: readonly [string, number][], slot: number, door: { lat: number; lon: number }): Promise<void>;
}

/** Build the shop. `bins` puts each product away to a pickable bin (OIL is left in a holding bin when `oilUnbinned`). */
export async function fulfilmentShop(h: ApiHarness, opts: { readonly oilUnbinned?: boolean } = {}): Promise<Shop> {
  const t = randomUUID();
  await h.seedOwner(t, OWNER);
  for (const [u, role] of [[DISPATCHER, 'store_manager'], [MANAGER2, 'store_manager'], [PICKER, 'store_manager'], [DRIVER, 'store_manager'], [DRIVER2, 'store_manager'], [CASHIER, 'cashier']] as const) {
    await h.provisionRole(t, u, role);
  }
  for (const c of CUSTOMERS) await h.provisionRole(t, c, 'customer');
  await h.enableFeature(t, 'customer_app');
  await h.enableFeature(t, 'delivery');
  const call: Shop['call'] = (method, path, userId, body, query) => h.request({
    method, path, userId, tenantId: t, ...(method === 'GET' ? {} : { idempotencyKey: `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }),
  });
  const ok: Shop['ok'] = async (method, path, userId, body, query) => {
    const r = await call(method, path, userId, body, query);
    if (r.status >= 300) throw new Error(`${method} ${path} as ${userId}: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body as Record<string, unknown>;
  };
  const post = (path: string, body: unknown) => call('POST', path, OWNER, body);
  for (const p of PRODUCTS) await listableProduct(post, { productId: p.productId, storeId: STORE_ID, priceMinor: p.priceMinor });
  const now = new Date().toISOString();
  for (const p of PRODUCTS) {
    await ok('POST', '/v1/inventory/movements', OWNER, { movementId: `rcv-${p.productId}`, productId: p.productId, locationId: STORE_ID, kind: 'received', quantityMinor: 50, uom: 'each', occurredAt: now, enteredBy: OWNER });
  }
  // The store's bins: two pickable, one holding.
  for (const [binId, pickable] of [['A-01', true], ['A-02', true], ['H-01', false]] as const) {
    await ok('POST', `/v1/warehouse/bins/${binId}`, OWNER, { storeId: STORE_ID, capacityMinor: 500, pickable });
  }
  const putAway = (id: string, productId: string, toBinId: string, qty: number) => ok('POST', `/v1/warehouse/movements/${id}`, OWNER, { kind: 'put_away', storeId: STORE_ID, productId, batchId: null, quantityMinor: qty, uom: 'each', fromBinId: null, toBinId });
  await putAway('pa-rice', 'RICE', 'A-01', 30);
  await putAway('pa-dal', 'DAL', 'A-02', 30);
  await putAway('pa-oil', 'OIL', opts.oilUnbinned === true ? 'H-01' : 'A-02', 30);
  await ok('PUT', '/v1/serviceability/delivery-service', OWNER, { storeLocation: STORE, slotsPerDay: 6, windowOpen: '09:00', windowClose: '21:00', capacityPerSlot: 10, leadMinutes: 60 });
  const tomorrowUtc = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
  const svc = await ok('GET', '/v1/serviceability/delivery-service', OWNER, undefined, { day: tomorrowUtc });
  const slots = (svc['slots'] as { startsAt: string; endsAt: string }[]);
  const runDate = svc['day'] as string;
  return {
    h, t, call, ok, slots, runDate,
    placeConfirmed: async (customer, orderId, lines, slot, door) => {
      await ok('POST', `/v1/storefront/orders/${orderId}`, customer, {
        lines: lines.map(([productId, quantityMinor]) => ({ productId, quantityMinor })), locationId: STORE_ID, fulfilment: 'delivery',
        deliverySlot: { startsAt: slots[slot]!.startsAt }, deliveryLocation: door,
      });
      await ok('POST', `/v1/orders/${orderId}/transition`, OWNER, { event: 'confirm' });
    },
  };
}

/** The day's figures a dispatcher enters: the drivers on shift for the whole of tomorrow, a speed and minutes per stop. */
export function dayFigures(shop: Shop, drivers: readonly string[] = [DRIVER]): Record<string, unknown> {
  const from = new Date(Date.parse(shop.slots[0]!.startsAt) - 3_600_000).toISOString();
  const until = new Date(Date.parse(shop.slots.at(-1)!.endsAt) + 3_600_000).toISOString();
  return { storeId: STORE_ID, drivers: drivers.map((driverId) => ({ driverId, maxStops: 10, availableFrom: from, availableUntil: until })), averageSpeedKmh: 20, serviceMinutesPerStop: 5 };
}
