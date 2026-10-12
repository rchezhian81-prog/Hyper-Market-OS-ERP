import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { testModePaymentProvider } from '../../packages/orders/src/payment-verification';

/**
 * **WF-15 (delivery: assign → hand-over → TRACK → proof → settlement) · M19-FR-03 · M20-FR-03 — the customer reads their
 * delivery while it is in progress, on the real API (in memory and, with DATABASE_URL, on real PostgreSQL).**
 *
 * The customer places and pays in the app (`POST /v1/storefront/orders/:id`, the provider's capture deciding "paid"); the
 * store confirms, packs and dispatches it under its manifest; the driver departs and records the door. At each step the
 * CUSTOMER's own read (`GET /v1/storefront/orders/:id`) says where the order is — confirmed, packed, dispatched (on its
 * way), then delivered — read back through a second head-office instance over the same store (a restart). Another
 * customer asking for it is refused.
 *
 * OB-77 "A" (owner, 12 Oct 2026, in writing, "Yes, add it now"): the customer's read ALSO carries where the DRIVER says the
 * delivery is — `delivery: { status, asOf, asOfMinutesAgo, stale, final, tellTheCustomer }` from the driver's own append-only
 * record (out_for_delivery → attempted → failed / delivered …), worded and aged by the tracking engine (`trackDelivery`,
 * which words the stages `trackOrder` knows through `trackOrder`). Before (the DEFECT this file pinned): after a failed door
 * attempt the customer still read only "dispatched", with no as-of time. A restart reads the same; another customer is refused.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
let pool: Pool | undefined;
beforeAll(async () => {
  if (DATABASE_URL === undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
  const dir = 'db/migrations';
  await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
});
afterAll(async () => { await pool?.end(); });

const PROOF = { kind: 'otp', ref: 'OTP-4711' };
const NEAR = { lat: 11.0200, lon: 76.9600 };
type Factory = (provider: ReturnType<typeof testModePaymentProvider>, sameStoreAs?: ApiHarness) => ApiHarness;
const backings: { name: string; harness: Factory }[] = [{ name: 'the in-memory event store', harness: (p, same) => apiHarness({ paymentVerifier: p, ...(same === undefined ? {} : { store: same.store }) }) }];
if (DATABASE_URL !== undefined) {
  backings.push({ name: 'real PostgreSQL', harness: (p) => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql), paymentVerifier: p }); } });
}

interface CustomerView { orderId: string; state: string; payment: { state: string }; tellTheCustomer: string }

describe.each(backings)('WF-15 — the customer reads their delivery in progress — on $name', ({ harness }) => {
  const shop = async () => {
    const provider = testModePaymentProvider();
    const h = harness(provider);
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    for (const f of ['customer_app', 'delivery']) await h.enableFeature(T, f);
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    await h.provisionRole(T, 'cust-1', 'customer');
    await h.provisionRole(T, 'cust-2', 'customer');
    const call = (method: 'GET' | 'POST' | 'PUT', path: string, user: string, body?: unknown, query?: Record<string, string>) =>
      h.request({ method, path, userId: user, tenantId: T, ...(method === 'GET' ? {} : { idempotencyKey: `${user}-${path}-${JSON.stringify(body ?? {})}`, body: body ?? {} }), ...(query === undefined ? {} : { query }) });
    const ok = async (p: Promise<{ status: number; body: unknown }>, label: string) => { const r = await p; expect(r.status, `${label}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
    const today = new Date().toISOString().slice(0, 10);
    await ok(call('POST', '/v1/inventory/movements', 'u-owner', { movementId: 'mv-1', productId: 'MILK', locationId: 'L1', kind: 'received', quantityMinor: 5, uom: 'each', occurredAt: new Date().toISOString(), enteredBy: 'u-owner', unitCostMinor: 40_00 }), 'stock');
    await ok(call('POST', '/v1/catalogue/tax-classes/0401/rates/2017-07-01', 'u-owner', { rateBps: 0 }), 'tax');
    await ok(call('POST', '/v1/catalogue/products/MILK/publish', 'u-owner', { product: { sku: 'MILK-1L', name: 'Aavin Milk 1L', baseUom: 'each', primaryCategoryId: 'dairy', taxClass: '0401', lifecycle: 'active', handling: 'ambient' }, categories: [{ categoryId: 'dairy', name: 'Dairy', parentId: null }] }), 'publish');
    await ok(call('POST', '/v1/prices/list/MILK/entries/e1', 'u-owner', { scope: 'store', scopeRef: 'L1', priceMinor: 60_00, mrpMinor: 70_00, costMinor: 40_00, marginFloorBps: 0, currency: 'INR', effectiveFrom: today }), 'price');
    await ok(call('POST', '/v1/catalogue/pack', 'u-owner', { storeId: 'L1', asOf: today }), 'pack');
    await ok(call('POST', '/v1/serviceability/periods/2026-01-01', 'u-owner', { radiusMetres: 10_000, deliveryFeeMinor: 40_00 }), 'serviceability');
    await ok(call('PUT', '/v1/serviceability/delivery-service', 'u-owner', { storeLocation: { lat: 11.0168, lon: 76.9558 }, slotsPerDay: 8, windowOpen: '09:00', windowClose: '21:00', capacityPerSlot: 10, leadMinutes: 60 }), 'delivery service');
    const tomorrow = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
    const slot = ((await call('GET', '/v1/serviceability/delivery-service', 'u-owner', undefined, { day: tomorrow })).body as { slots: { startsAt: string }[] }).slots[0]!;
    const mine = async (orderId: string, hh: ApiHarness = h, who = 'cust-1') => {
      const r = await hh.request({ method: 'GET', path: `/v1/storefront/orders/${orderId}`, userId: who, tenantId: T });
      return { status: r.status, body: r.body as CustomerView };
    };
    /** The customer places and pays 2 milk + delivery in the app; the store confirms, packs and dispatches it. */
    const onItsWay = async (orderId: string) => {
      provider.capture(`tok_${orderId}`, 2 * 60_00 + 40_00);
      const placed = await ok(call('POST', `/v1/storefront/orders/${orderId}`, 'cust-1', {
        lines: [{ productId: 'MILK', quantityMinor: 2 }], locationId: 'L1', fulfilment: 'delivery', deliverySlot: { startsAt: slot.startsAt }, deliveryLocation: NEAR,
        payment: { providerRef: `tok_${orderId}`, amountMinor: 2 * 60_00 + 40_00, result: 'authorised' },
      }), 'place');
      expect((placed.body as CustomerView).payment.state).toBe('authorised');
      await ok(call('POST', `/v1/orders/${orderId}/transition`, 'u-owner', { event: 'confirm' }), 'confirm');
      expect((await mine(orderId)).body).toMatchObject({ state: 'confirmed', tellTheCustomer: 'Your order is confirmed.' });
      await ok(call('POST', `/v1/fulfilment/orders/${orderId}/pack`, 'u-mgr', { lines: [{ productId: 'MILK', pickedMinor: 2 }], crateAssignment: { MILK: 'c1' } }), 'pack');
      expect((await mine(orderId)).body).toMatchObject({ state: 'packed', tellTheCustomer: 'Your order is packed.' });
      await ok(call('POST', `/v1/fulfilment/orders/${orderId}/dispatch`, 'u-mgr', { manifestId: `m-${orderId}`, locationId: 'L1', seals: { c1: 's1' } }), 'dispatch');
      await ok(call('POST', `/v1/delivery/orders/${orderId}/transition`, 'u-owner', { event: 'depart' }), 'depart');
    };
    return { h, T, call, ok, mine, onItsWay, provider };
  };

  it('confirmed → packed → on its way (dispatched) → delivered, each read by the customer; a restart reads the same; another customer is refused', async () => {
    const s = await shop();
    await s.onItsWay('ORD-T1');
    const onTheWay = await s.mine('ORD-T1');
    expect(onTheWay.status).toBe(200);
    expect(onTheWay.body).toMatchObject({ orderId: 'ORD-T1', state: 'dispatched', payment: { state: 'authorised' }, tellTheCustomer: 'Your order is dispatched.' });
    // A second head-office instance over the same store (a restart) tells the customer the same.
    expect((await s.mine('ORD-T1', harness(s.provider, s.h))).body).toMatchObject({ state: 'dispatched' });
    // Another customer cannot read it.
    expect((await s.mine('ORD-T1', s.h, 'cust-2')).status).toBe(403);

    // The door: delivered with proof — the customer's read follows.
    await s.ok(s.call('POST', '/v1/delivery/orders/ORD-T1/transition', 'u-owner', { event: 'deliver', proof: PROOF }), 'deliver');
    expect((await s.mine('ORD-T1')).body).toMatchObject({ state: 'delivered', tellTheCustomer: 'Your order is delivered.' });
  });

  it('OB-77: the driver\'s steps reach the customer — on its way, at the door, could not deliver — each with its as-of time; a restart reads the same; another customer is refused', async () => {
    const s = await shop();
    await s.onItsWay('ORD-T2');
    type Tracked = { state: string; tellTheCustomer: string; delivery: { status: string; asOf: string; asOfMinutesAgo: number; stale: boolean; final: boolean; tellTheCustomer: string } | null };
    const read = async (hh: ApiHarness = s.h) => (await s.mine('ORD-T2', hh)).body as unknown as Tracked;
    const steps = async () => ((await s.call('GET', '/v1/delivery/orders/ORD-T2', 'u-owner')).body as { history: { to: string; at: string }[] }).history;

    // Departed: the order is "dispatched"; the driver says it is out for delivery, as of the moment they set off.
    let mine = await read();
    expect(mine.state).toBe('dispatched');
    expect(mine.delivery).toMatchObject({ status: 'out_for_delivery', stale: false, final: false, tellTheCustomer: 'Your order is on its way.' });
    expect(mine.delivery!.asOf).toBe((await steps()).at(-1)!.at);

    await s.ok(s.call('POST', '/v1/delivery/orders/ORD-T2/transition', 'u-owner', { event: 'arrive' }), 'arrive');
    mine = await read();
    expect(mine.delivery).toMatchObject({ status: 'attempted', final: false, tellTheCustomer: 'The driver has reached your address.' });
    expect(mine.delivery!.asOf).toBe((await steps()).at(-1)!.at);

    await s.ok(s.call('POST', '/v1/delivery/orders/ORD-T2/transition', 'u-owner', { event: 'fail' }), 'fail');
    // The dispatcher's read and the customer's read now agree that the stop failed — with the time the driver said so.
    const desk = await s.call('GET', '/v1/delivery/orders/ORD-T2', 'u-owner');
    expect(desk.body).toMatchObject({ state: 'failed' });
    mine = await read();
    expect(mine.state).toBe('dispatched'); // the ORDER's own lifecycle is unchanged; the delivery says what happened at the door
    expect(mine.delivery).toMatchObject({ status: 'failed', final: true, stale: false, tellTheCustomer: 'The driver could not deliver your order. The shop will contact you to arrange another time.' });
    const failedAt = (await steps()).at(-1)!.at;
    expect(mine.delivery!.asOf).toBe(failedAt);
    expect(Number.isNaN(Date.parse(mine.delivery!.asOf))).toBe(false);

    // A second head-office instance over the same store (a restart) tells the customer the same.
    expect((await read(harness(s.provider, s.h))).delivery).toMatchObject({ status: 'failed', asOf: failedAt });
    // Another customer is refused (and the probe recorded), never shown the driver's steps.
    const other = await s.mine('ORD-T2', s.h, 'cust-2');
    expect(other.status).toBe(403);
    expect(JSON.stringify(other.body)).not.toContain('failed');

    // Reattempted and delivered with proof: the customer reads "Delivered", final.
    await s.ok(s.call('POST', '/v1/delivery/orders/ORD-T2/transition', 'u-owner', { event: 'reattempt' }), 'reattempt');
    expect((await read()).delivery).toMatchObject({ status: 'out_for_delivery' });
    await s.ok(s.call('POST', '/v1/delivery/orders/ORD-T2/transition', 'u-owner', { event: 'arrive' }), 'arrive again');
    await s.ok(s.call('POST', '/v1/delivery/orders/ORD-T2/transition', 'u-owner', { event: 'deliver', proof: PROOF }), 'deliver');
    expect((await read()).delivery).toMatchObject({ status: 'delivered', final: true, stale: false, tellTheCustomer: 'Delivered.' });
  });
});
