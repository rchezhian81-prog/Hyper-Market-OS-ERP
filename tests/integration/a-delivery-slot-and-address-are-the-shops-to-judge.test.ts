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

/**
 * **FUL-03 (rest) — a delivery's slot and address are judged by head office, from its OWN stored configuration, at
 * placement (M18-FR-01 · M20-FR-03 · D08 · OA-11 · P-02 · hard rule #10).**
 *
 * The app offers slots and measures the distance in the browser; neither is taken on its word. Head office holds where
 * the store is and its daily slots (OA-11: 8 a day, 9 am–9 pm, each for so many orders), and at placement it refuses —
 * BEFORE anything is reserved or charged — an address outside the radius, a slot it does not offer or that starts too
 * soon, and a slot already full (with the slots still open). The last place in a slot is taken once, even when several
 * customers press Pay together; a cancelled order frees its place; a retry is the same booking.
 *
 * Runs on the in-memory event store and, with DATABASE_URL, on real PostgreSQL. Synthetic data only.
 */

const OWNER = 'u-owner';
const STORE = { lat: 11.0168, lon: 76.9558 };
const NEAR = { lat: 11.0300, lon: 76.9700 }; // ~2 km
const FAR = { lat: 11.2000, lon: 76.9558 }; // ~20 km
const codeOf = (r: { body: unknown }): string | undefined => (r.body as { error?: { code?: string } }).error?.code;

const DATABASE_URL = process.env['DATABASE_URL'];
let pool: Pool | undefined;
beforeAll(async () => {
  if (DATABASE_URL === undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL, max: 8, options: '-c app.tenant_id=*' });
  const dir = 'db/migrations';
  await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
});
afterAll(async () => { await pool?.end(); });
const backings: { name: string; harness: () => ApiHarness }[] = [{ name: 'the in-memory event store', harness: () => apiHarness() }];
if (DATABASE_URL !== undefined) backings.push({ name: 'real PostgreSQL', harness: () => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); } });

describe.each(backings)('FUL-03 — the shop judges a delivery\'s slot and address — on $name', ({ harness }) => {
  async function shop() {
    const h = harness();
    const t = randomUUID();
    await h.seedOwner(t, OWNER);
    for (const c of ['c-1', 'c-2', 'c-3', 'c-4', 'c-5']) await h.provisionRole(t, c, 'customer');
    await h.enableFeature(t, 'customer_app');
    expect((await h.request({ method: 'POST', path: '/v1/inventory/movements', userId: OWNER, tenantId: t, idempotencyKey: 'mv-1', body: { movementId: 'mv-1', productId: 'MILK', locationId: 'L1', kind: 'received', quantityMinor: 50, uom: 'each', occurredAt: new Date().toISOString(), enteredBy: OWNER } })).status).toBeLessThan(300);
    const place = (customer: string, orderId: string, extra: Record<string, unknown>, key = `k-${orderId}`) => h.request({
      method: 'POST', path: `/v1/storefront/orders/${orderId}`, userId: customer, tenantId: t, idempotencyKey: key,
      body: { lines: [{ productId: 'MILK', quantityMinor: 1 }], locationId: 'L1', fulfilment: 'delivery', ...extra },
    });
    const setUp = (body: Record<string, unknown>) => h.request({ method: 'PUT', path: '/v1/serviceability/delivery-service', userId: OWNER, tenantId: t, idempotencyKey: `svc-${randomUUID()}`, body });
    const slotsOn = async (day: string) => ((await h.request({ method: 'GET', path: '/v1/serviceability/delivery-service', userId: OWNER, tenantId: t, query: { day } })).body as { slots: { startsAt: string; endsAt: string; capacity: number; taken: number }[] }).slots;
    const mine = async (customer: string) => ((await h.request({ method: 'GET', path: '/v1/storefront/orders', userId: customer, tenantId: t })).body as { orders: { orderId: string }[] }).orders;
    return { h, t, place, setUp, slotsOn, mine };
  }
  const tomorrow = (): string => new Date(Date.now() + 864e5).toISOString().slice(0, 10);

  it('no delivery service on record: a delivery is refused (collection still works); only the owner/manager may set one, and it must be readable', async () => {
    const s = await shop();
    const r = await s.place('c-1', 'ORD-A', { deliverySlot: { startsAt: `${tomorrow()}T05:00:00.000Z` }, deliveryLocation: NEAR });
    expect(r.status).toBe(409);
    expect(codeOf(r)).toBe('delivery_not_set_up');
    expect(await s.mine('c-1')).toHaveLength(0);
    expect((await s.place('c-1', 'ORD-B', { fulfilment: 'pickup' })).status).toBe(201);
    // A customer cannot set the shop's delivery service; nonsense is refused.
    expect((await s.h.request({ method: 'PUT', path: '/v1/serviceability/delivery-service', userId: 'c-1', tenantId: s.t, idempotencyKey: 'x', body: { storeLocation: NEAR, slotsPerDay: 8, windowOpen: '09:00', windowClose: '21:00', capacityPerSlot: 99 } })).status).toBe(403);
    expect(codeOf(await s.setUp({ storeLocation: STORE, slotsPerDay: 8, windowOpen: '21:00', windowClose: '09:00', capacityPerSlot: 10 }))).toBe('not_readable_as_a_delivery_service');
  });

  it('THE CASE: an address 20 km out, a slot the shop does not run, a slot too soon — refused before anything is reserved; the store location the app might send is never used', async () => {
    const s = await shop();
    expect((await s.setUp({ storeLocation: STORE, slotsPerDay: 8, windowOpen: '09:00', windowClose: '21:00', capacityPerSlot: 10, leadMinutes: 60 })).status).toBe(200);
    expect((await s.h.request({ method: 'POST', path: '/v1/serviceability/periods/2026-01-01', userId: OWNER, tenantId: s.t, idempotencyKey: 'p', body: { radiusMetres: 10_000 } })).status).toBe(201);
    const slots = await s.slotsOn(tomorrow());
    expect(slots).toHaveLength(8); // OA-11: 8 a day, 9 am–9 pm shop time
    const first = slots[0]!;

    // Out of the radius — even though the body claims the store is right next to the customer.
    const far = await s.place('c-1', 'ORD-FAR', { deliverySlot: { startsAt: first.startsAt }, deliveryLocation: FAR, storeLocation: FAR });
    expect(far.status).toBe(422);
    expect(codeOf(far)).toBe('address_outside_service_area');
    expect((far.body as { error: { distanceMetres: number; radiusMetres: number } }).error).toMatchObject({ radiusMetres: 10_000 });

    // A slot the shop does not run (07:00 shop time), and one that has already begun.
    const odd = await s.place('c-1', 'ORD-ODD', { deliverySlot: { startsAt: new Date(Date.parse(first.startsAt) - 2 * 3_600_000).toISOString() }, deliveryLocation: NEAR });
    expect(codeOf(odd)).toBe('slot_closed');
    expect((odd.body as { error: { alternatives: unknown[] } }).error.alternatives.length).toBeGreaterThan(0);
    const past = await s.place('c-1', 'ORD-PAST', { deliverySlot: { startsAt: new Date(Date.now() - 3_600_000).toISOString() }, deliveryLocation: NEAR });
    expect(codeOf(past)).toBe('slot_closed');
    // No slot or location at all.
    expect(codeOf(await s.place('c-1', 'ORD-NONE', {}))).toBe('delivery_needs_slot_and_location');

    // Nothing was placed or reserved by any of them.
    expect(await s.mine('c-1')).toHaveLength(0);
    expect((await s.slotsOn(tomorrow()))[0]!.taken).toBe(0);

    // A good one is placed, and says which slot and how far, by the shop's own measure.
    const good = await s.place('c-1', 'ORD-GOOD', { deliverySlot: { startsAt: first.startsAt }, deliveryLocation: NEAR });
    expect(good.status, JSON.stringify(good.body)).toBe(201);
    expect((good.body as { delivery: { slot: { startsAt: string }; distanceMetres: number } }).delivery).toMatchObject({ slot: { startsAt: first.startsAt } });
    expect((good.body as { delivery: { distanceMetres: number } }).delivery.distanceMetres).toBeLessThan(3_000);
  });

  it('a full slot is refused with the open ones; several customers pressing Pay together take its last place ONCE; a cancel frees it; a retry is the same booking', async () => {
    const s = await shop();
    expect((await s.setUp({ storeLocation: STORE, slotsPerDay: 8, windowOpen: '09:00', windowClose: '21:00', capacityPerSlot: 2, leadMinutes: 60 })).status).toBe(200);
    const slot = (await s.slotsOn(tomorrow()))[3]!;
    const ask = (c: string, id: string) => s.place(c, id, { deliverySlot: { startsAt: slot.startsAt }, deliveryLocation: NEAR });

    expect((await ask('c-1', 'ORD-1')).status).toBe(201);
    // The same order again (a lost reply, a new request key): the same booking, not a second place.
    const again = await s.place('c-1', 'ORD-1', { deliverySlot: { startsAt: slot.startsAt }, deliveryLocation: NEAR }, 'k-ORD-1-again');
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ alreadyPlaced: true });
    expect((await s.slotsOn(tomorrow()))[3]!.taken).toBe(1);

    // Three customers at once for ONE remaining place.
    const raced = await Promise.all([ask('c-2', 'ORD-2'), ask('c-3', 'ORD-3'), ask('c-4', 'ORD-4')]);
    expect(raced.filter((r) => r.status === 201)).toHaveLength(1);
    for (const r of raced.filter((x) => x.status !== 201)) expect(['slot_full', 'slot_busy']).toContain(codeOf(r));
    expect((await s.slotsOn(tomorrow()))[3]!.taken).toBe(2);

    // Full: refused, with the slots still open (not this one).
    const full = await ask('c-5', 'ORD-5');
    expect(full.status).toBe(409);
    expect(codeOf(full)).toBe('slot_full');
    const alternatives = (full.body as { error: { alternatives: { startsAt: string }[] } }).error.alternatives;
    expect(alternatives.length).toBeGreaterThan(0);
    expect(alternatives.map((a) => a.startsAt)).not.toContain(slot.startsAt);

    // c-1 cancels (no payment was taken) — the place frees, and c-5 gets it.
    expect((await s.h.request({ method: 'POST', path: '/v1/storefront/orders/ORD-1/cancel', userId: 'c-1', tenantId: s.t, idempotencyKey: 'cx-1', body: {} })).status).toBeLessThan(300);
    expect((await s.slotsOn(tomorrow()))[3]!.taken).toBe(1);
    expect((await ask('c-5', 'ORD-5b')).status).toBe(201);
    expect((await s.slotsOn(tomorrow()))[3]!.taken).toBe(2);
  });
});
