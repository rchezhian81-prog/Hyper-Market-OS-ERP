import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { useRestartableBackings } from '../support/p3-backings';
import { seedOnlineShop, listShopOnline, callsFor, codeOf, CASHIER, CUSTOMER, OTHER_CUSTOMER, STORE, MANAGER } from '../support/online-shop';
import { dayIn, customerCommerceSweep } from '../../services/api/src/customer-commerce-adapters';
import { addDays } from '../../packages/storefront/src/subscriptions';

// OB-303 (owner, 23 Oct 2026) · M17-FR-02 "subscriptions" · M18-FR-01 — repeat online orders on a schedule, placed
// automatically into the order register; the customer pauses or cancels any time. Proved through the real API, in memory
// and on real PostgreSQL with a cold restart:
//   • a plan is the customer's own; a bad plan or one starting in the past is refused by name;
//   • the run places today's and tomorrow's orders as ORDINARY online orders (the storefront's own placement — listing,
//     promise, reservation, price), ONCE: a second run places nothing more; nothing is charged — the order waits for the
//     customer to pay in the app, and says so;
//   • a paused plan places nothing until resumed; a cancelled one never again, and cannot be paused;
//   • a day the shop could not place is RECORDED with the shop's own words (a product not sold online), for the customer
//     and staff — never skipped silently; another customer cannot touch the plan; a cashier cannot run it.

const backings = useRestartableBackings();
interface PlanView { subscriptionId: string; state: string; nextDays: string[]; occurrences: { day: string; orderId: string; outcome: string; detail: string; payableMinor?: number }[] }

describe.each(backings)('a repeat order is placed on its days and paused or cancelled by the customer (OB-303) — on $name', ({ harness }) => {
  it('placed once per day as an ordinary order waiting for payment; pause and cancel are the customer\'s; a day not placed says why; a restart reads the same', async () => {
    const h = harness();
    const T = randomUUID();
    const c = callsFor(() => h, T);
    const { req, ok } = c;
    await seedOnlineShop(h, T, c);
    await listShopOnline(c);
    const today = dayIn(new Date().toISOString(), 'Asia/Kolkata');
    const plan = (over: Record<string, unknown> = {}) => ({ lines: [{ productId: 'MILK', quantityMinor: 2 }], locationId: STORE, schedule: { kind: 'every_days', days: 1 }, startsOn: today, fulfilment: 'pickup', ...over });

    // Refused by name before anything is kept.
    expect(codeOf(await req('POST', '/v1/me/subscriptions/S-BAD', plan({ schedule: { kind: 'monthly' } }), CUSTOMER))).toBe('not_readable_as_a_repeat_order');
    expect(codeOf(await req('POST', '/v1/me/subscriptions/S-OLD', plan({ startsOn: addDays(today, -3) }), CUSTOMER))).toBe('starts_in_the_past');
    expect((await req('POST', '/v1/me/subscriptions/S-MILK', plan(), CUSTOMER)).status).toBe(201);
    expect((await req('POST', '/v1/me/subscriptions/S-MILK', plan(), CUSTOMER)).body).toMatchObject({ alreadySaved: true });

    // The run places today's and tomorrow's orders — once.
    expect((await req('POST', '/v1/repeat-orders/run', {}, CASHIER)).status).toBe(403);
    // Head office's own timer places them (the ops worker's pass); the staff run then finds nothing left to do.
    expect(await customerCommerceSweep({ store: h.store, now: () => new Date().toISOString() })(T, new Date().toISOString())).toBe(2);
    expect(((await ok(req('POST', '/v1/repeat-orders/run', {}, MANAGER), 'run again')).body as { placed: number }).placed).toBe(0);
    const mine = async (who = CUSTOMER, hh = h) => {
      const r = await hh.request({ method: 'GET', path: '/v1/me/subscriptions', userId: who, tenantId: T });
      expect(r.status).toBe(200);
      return (r.body as { subscriptions: PlanView[] }).subscriptions;
    };
    const milk = (await mine()).find((p) => p.subscriptionId === 'S-MILK')!;
    expect(milk.state).toBe('active');
    expect(milk.occurrences.map((o) => [o.day, o.outcome, o.orderId])).toEqual([
      [addDays(today, 1), 'placed', `SUB-S-MILK-${addDays(today, 1)}`],
      [today, 'placed', `SUB-S-MILK-${today}`],
    ]);
    expect(milk.occurrences[0]!.payableMinor).toBe(120_00);
    expect(milk.occurrences[0]!.detail).toBe(`Placed for ${addDays(today, 1)} — ₹120.00 to pay in the app. Nothing has been charged yet.`);
    // An ordinary online order of the customer's, waiting for them to pay — nothing taken.
    const orders = (await req('GET', '/v1/storefront/orders', undefined, CUSTOMER)).body as { orders: { orderId: string; payment: { state: string }; tellTheCustomer: string }[] };
    const todays = orders.orders.find((o) => o.orderId === `SUB-S-MILK-${today}`)!;
    expect(todays.payment.state).toBe('none');
    expect(todays.tellTheCustomer).toMatch(/^Your repeat order is placed and waiting for you to pay in the app\./);
    // The stock is held for it, like any order.
    const held = (await req('GET', '/v1/orders/reservations', undefined, MANAGER, { locationId: STORE })).body as { reservations?: { orderId: string }[] };
    expect(JSON.stringify(held)).toContain(`SUB-S-MILK-${today}`);

    // Another customer cannot touch it; pause, then nothing; resume; cancel; a cancelled plan cannot be paused.
    expect((await req('POST', '/v1/me/subscriptions/S-MILK/pause', {}, OTHER_CUSTOMER)).status).toBe(403);
    expect((await req('POST', '/v1/me/subscriptions/S-EVERY2/pause', {}, CUSTOMER)).status).toBe(404);
    expect((await req('POST', '/v1/me/subscriptions/S-EVERY2', plan({ schedule: { kind: 'every_days', days: 2 }, startsOn: addDays(today, 1) }), CUSTOMER)).status).toBe(201);
    expect(((await ok(req('POST', '/v1/me/subscriptions/S-EVERY2/pause', {}, CUSTOMER), 'pause')).body as PlanView).state).toBe('paused');
    expect((await ok(req('POST', '/v1/repeat-orders/run', {}, MANAGER), 'run while paused')).body).toMatchObject({ placed: 0 });
    expect(((await ok(req('POST', '/v1/me/subscriptions/S-EVERY2/resume', {}, CUSTOMER), 'resume')).body as PlanView).state).toBe('active');
    expect((await ok(req('POST', '/v1/repeat-orders/run', {}, MANAGER), 'run resumed')).body).toMatchObject({ placed: 1 });
    expect(((await ok(req('POST', '/v1/me/subscriptions/S-EVERY2/cancel', { reason: 'moving house' }, CUSTOMER), 'cancel')).body as PlanView)).toMatchObject({ state: 'cancelled', nextDays: [] });
    expect(codeOf(await req('POST', '/v1/me/subscriptions/S-EVERY2/pause', {}, CUSTOMER))).toBe('repeat_order_cancelled');

    // A product not sold online: the day is RECORDED as not placed, with the shop's own words.
    expect((await req('POST', '/v1/me/subscriptions/S-SAREE', plan({ lines: [{ productId: 'SAREE', quantityMinor: 1 }] }), OTHER_CUSTOMER)).status).toBe(201);
    expect((await ok(req('POST', '/v1/repeat-orders/run', {}, MANAGER), 'run saree')).body).toMatchObject({ placed: 0, notPlaced: 2 });
    const saree = (await mine(OTHER_CUSTOMER)).find((p) => p.subscriptionId === 'S-SAREE')!;
    expect(saree.occurrences.every((o) => o.outcome === 'not_placed' && /^Not placed: SAREE: .*Nothing was charged\.$/.test(o.detail))).toBe(true);
    const staff = (await req('GET', '/v1/repeat-orders', undefined, MANAGER)).body as { notPlaced: { subscriptionId: string }[]; detail: string };
    expect(staff.notPlaced.map((o) => o.subscriptionId)).toEqual(['S-SAREE', 'S-SAREE']);
    expect(staff.detail).toBe('2 day(s) were not placed — each says why.');

    // A cold restart reads the same plans and days.
    const again = await mine(CUSTOMER, harness(h));
    expect(again.find((p) => p.subscriptionId === 'S-MILK')!.occurrences).toHaveLength(2);
    expect(again.find((p) => p.subscriptionId === 'S-EVERY2')!.state).toBe('cancelled');
  });
});
