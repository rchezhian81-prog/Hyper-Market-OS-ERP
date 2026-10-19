import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { approvedBody } from '../support/approval-request';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { testModePaymentProvider } from '../../packages/orders/src/payment-verification';
import { ordersAdapter } from '../../services/api/src/adapters';
import { seedOnlineShop, listShopOnline, deliveredOrder, callsFor, codeOf, saidOf, OWNER, MANAGER, CASHIER, CHECKER, CUSTOMER, OTHER_CUSTOMER, STORE } from '../support/online-shop';

/**
 * **R4 · WF-16 — an online return after delivery refunds only what came back — on the real API, in memory and on REAL
 * PostgreSQL, across a cold restart.**
 *
 * The signed sentence (OB-227): the customer raises a return in the app within the window set for the product's
 * category (OB-213); the shop books a collection and receives the goods back with a count; a person chooses the
 * disposition; the refund goes back to the original payment only for lines received; the customer sees each step.
 * Refused by name: outside the window ("return window closed"), on the non-returnable list ("not returnable"), a second
 * refund for the same line ("already refunded"). A refund the provider has not confirmed shows "waiting". Until the owner
 * gives the windows they read "not set" and no return can be judged.
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

const provider = testModePaymentProvider();
const backings: { name: string; harness: () => ApiHarness; restart: (h: ApiHarness) => ApiHarness }[] = [
  { name: 'the in-memory event store', harness: () => apiHarness({ paymentVerifier: provider }), restart: (h) => apiHarness({ store: h.store, paymentVerifier: provider }) },
];
if (DATABASE_URL !== undefined) {
  const pg = (): ApiHarness => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql), paymentVerifier: provider }); };
  backings.push({ name: 'real PostgreSQL', harness: pg, restart: pg });
}

type ReturnView = { returnId: string; stage: string; stageSay: string; lines: { productId: string; requestedMinor: number; receivedMinor?: number; disposition?: string; refundId?: string }[]; steps: { say: string }[]; refunds: { refundId: string; state: string; amountMinor: number }[]; customerRef?: string };

describe.each(backings)('WF-16 — an online return refunds only what came back, on $name', ({ harness, restart }) => {
  it('window "not set" → set by category → refused by name → collect → count → disposition → refund to source, waiting → confirmed', async () => {
    let h = harness();
    const T = randomUUID();
    const c = callsFor(() => h, T);
    const { req, ok } = c;
    await seedOnlineShop(h, T, c);
    await listShopOnline(c); // OB-234: only what is published online is sold online
    await deliveredOrder(c, provider, 'ORD-1');

    // OB-213: nothing set yet — the windows and the list read "not set", and a return cannot be judged.
    const pol = (await ok(req('GET', '/v1/me/return-policy', undefined, CUSTOMER), 'policy')).body as { policy: { windows?: string; nonReturnable: unknown } };
    expect(pol.policy).toMatchObject({ windows: 'not set', nonReturnable: 'not set' });
    const notSet = await req('POST', '/v1/me/orders/ORD-1/online-returns/R-0', { lines: [{ productId: 'MILK', quantityMinor: 1 }], reason: 'sour' }, CUSTOMER);
    expect(notSet.status).toBe(422);
    expect(codeOf(notSet)).toBe('return_window_not_set');
    expect(saidOf(notSet)).toBe('MILK: return window not set: dairy.');

    // The owner's windows by category and the non-returnable list (synthetic values standing in for OB-213's answer).
    expect((await req('POST', '/v1/online-returns/policy', { windowDaysByCategory: { dairy: 2 }, nonReturnable: [], reason: 'x' }, CASHIER)).status).toBe(403);
    await ok(req('POST', '/v1/online-returns/policy', { windowDaysByCategory: { dairy: 2, household: 7 }, nonReturnable: ['BROOM'], reason: 'test windows (synthetic)' }), 'policy');

    // Refused by name: an item on the non-returnable list; more than was ordered; someone else's order.
    const nr = await req('POST', '/v1/me/orders/ORD-1/online-returns/R-1', { lines: [{ productId: 'BROOM', quantityMinor: 1 }], reason: 'not needed' }, CUSTOMER);
    expect([nr.status, codeOf(nr), saidOf(nr)]).toEqual([422, 'not_returnable', 'BROOM: not returnable.']);
    expect(codeOf(await req('POST', '/v1/me/orders/ORD-1/online-returns/R-1', { lines: [{ productId: 'MILK', quantityMinor: 3 }], reason: 'x' }, CUSTOMER))).toBe('more_than_was_ordered');
    expect((await req('POST', '/v1/me/orders/ORD-1/online-returns/R-X', { lines: [{ productId: 'MILK', quantityMinor: 1 }], reason: 'x' }, OTHER_CUSTOMER)).status).toBe(404);

    // Outside the window: an older order of the customer's, delivered five days ago (synthetic history on the ledger).
    const orders = ordersAdapter({ store: h.store, now: () => new Date().toISOString(), holdMinutes: 60 });
    const fiveDaysAgo = new Date(Date.now() - 5 * 86_400_000).toISOString();
    await orders.recordPlaced(T, { orderId: 'ORD-OLD', locationId: STORE, lines: [{ productId: 'MILK', quantityMinor: 1 }], state: 'placed', placedAt: fiveDaysAgo, customerRef: CUSTOMER });
    await orders.recordTransition(T, { orderId: 'ORD-OLD', event: 'deliver', from: 'dispatched', to: 'delivered', at: fiveDaysAgo });
    const closed = await req('POST', '/v1/me/orders/ORD-OLD/online-returns/R-OLD', { lines: [{ productId: 'MILK', quantityMinor: 1 }], reason: 'late' }, CUSTOMER);
    expect([closed.status, codeOf(closed), saidOf(closed)]).toEqual([422, 'return_window_closed', 'MILK: return window closed.']);

    // Within the window: two MILK asked back.
    const raised = await ok(req('POST', '/v1/me/orders/ORD-1/online-returns/R-1', { lines: [{ productId: 'MILK', quantityMinor: 2 }], reason: 'sour (synthetic)' }, CUSTOMER), 'raise');
    expect((raised.body as { return: ReturnView }).return.stage).toBe('requested');
    expect((raised.body as { return: ReturnView }).return.customerRef).toBeUndefined();
    expect(((await ok(req('GET', '/v1/me/online-returns', undefined, OTHER_CUSTOMER), 'other')).body as { count: number }).count).toBe(0);

    // The steps in order — nothing is received before it is collected.
    expect(codeOf(await req('POST', '/v1/online-returns/R-1/received', { lines: [{ productId: 'MILK', receivedMinor: 2 }] }, MANAGER))).toBe('not_at_this_step');
    expect((await req('POST', '/v1/online-returns/R-1/collection', { collectOn: '2026-10-20' }, CASHIER)).status).toBe(403);
    await ok(req('POST', '/v1/online-returns/R-1/collection', { collectOn: '2026-10-20' }, MANAGER), 'book');
    await ok(req('POST', '/v1/online-returns/R-1/collected', {}, MANAGER), 'collected');

    // ── A cold restart: the return is rebuilt from its own stream ──
    h = restart(h);
    // Only ONE of the two came back. Counting more than was asked, or leaving a line out, is refused.
    expect(codeOf(await req('POST', '/v1/online-returns/R-1/received', { lines: [{ productId: 'MILK', receivedMinor: 3 }] }, MANAGER))).toBe('count_does_not_fit');
    await ok(req('POST', '/v1/online-returns/R-1/received', { lines: [{ productId: 'MILK', receivedMinor: 1 }] }, MANAGER), 'received');

    // A refund waits for a person's disposition; waste needs a reason.
    expect(codeOf(await req('POST', '/v1/online-returns/R-1/refund', { refundId: 'rf-1' }, MANAGER))).toBe('not_disposed_yet');
    expect(codeOf(await req('POST', '/v1/online-returns/R-1/lines/MILK/disposition', { disposition: 'waste' }, MANAGER))).toBe('reason_required');
    const onHand = async () => ((await ok(req('GET', '/v1/inventory/availability', undefined, OWNER, { productId: 'MILK' }), 'avail')).body as { rows?: { locationId: string; onHandMinor: number }[] }).rows?.find((a) => a.locationId === STORE)?.onHandMinor;
    const before = await onHand();
    await ok(req('POST', '/v1/online-returns/R-1/lines/MILK/disposition', { disposition: 'sellable' }, MANAGER), 'sellable');
    expect(await onHand()).toBe((before ?? 0) + 1); // back on the shelf: one `returned` movement, the counted one only
    expect(codeOf(await req('POST', '/v1/online-returns/R-1/lines/MILK/disposition', { disposition: 'quarantine' }, MANAGER))).toBe('disposition_already_chosen');

    // The refund needs a second person's approval for exactly it (§28); then it goes to the ORDER's token — 1 × ₹60.
    expect(codeOf(await req('POST', '/v1/online-returns/R-1/refund', { refundId: 'rf-1' }, MANAGER))).toBe('given_without_approval');
    expect((await req('POST', '/v1/online-returns/R-1/refund', { refundId: 'rf-1' }, CASHIER)).status).toBe(403);
    const body = await approvedBody(h, T, MANAGER, CHECKER, 'order_refund', 'ORD-1/rf-1', { refundId: 'rf-1' }, { returnId: 'R-1' }, 60_00);
    const refunded = (await ok(req('POST', '/v1/online-returns/R-1/refund', body, MANAGER), 'refund')).body as { refund: { amountMinor: number; state: string; shown: string }; return: ReturnView };
    // No payment provider is connected (OA-4): the refund is ASKED and WAITS — never shown as done.
    expect(refunded.refund).toEqual({ refundId: 'rf-1', amountMinor: 60_00, state: 'pending', shown: 'waiting' });
    expect(refunded.return.stage).toBe('refund_waiting');

    // A second refund for the same line is refused by name.
    const twice = await req('POST', '/v1/online-returns/R-1/refund', { refundId: 'rf-2' }, MANAGER);
    expect([codeOf(twice), saidOf(twice)]).toEqual(['already_refunded', 'The refund was not sent: already refunded: MILK.']);

    // The order desk's own worklist carries it as pending (P-08), on the order's own money position.
    const pending = (await ok(req('GET', '/v1/orders/refunds/pending'), 'pending')).body as { pendingRefunds: { refundId: string; basis: string }[] };
    expect(pending.pendingRefunds.map((r) => [r.refundId, r.basis])).toEqual([['rf-1', 'return']]);

    // The customer sees every step — and "waiting".
    const mine = ((await ok(req('GET', '/v1/me/online-returns', undefined, CUSTOMER), 'mine')).body as { returns: ReturnView[] }).returns;
    expect(mine).toHaveLength(1);
    expect(mine[0]!.stageSay).toBe('Refund asked for — waiting for the bank to confirm. It is not done until the bank says so.');
    expect(mine[0]!.steps.map((s) => s.say)).toEqual([
      'Return asked for: 2 × MILK', 'Collection booked for 2026-10-20', 'Collected from you', 'Received back at the shop: 1 × MILK',
      'Refund of ₹60.00 asked for — waiting for the bank to confirm',
    ]);

    // The bank's statement confirms it: done, from the recorded outcome only.
    await ok(req('POST', '/v1/orders/ORD-1/refunds/rf-1/outcome', { result: 'refunded', evidenceRef: 'stmt-line-1 (synthetic)' }), 'outcome');
    h = restart(h);
    const done = ((await ok(req('GET', '/v1/me/online-returns', undefined, CUSTOMER), 'mine 2')).body as { returns: ReturnView[] }).returns[0]!;
    expect(done.stage).toBe('refunded');
    expect(done.refunds).toEqual([{ refundId: 'rf-1', amountMinor: 60_00, state: 'issued' }]);
    const desk = (await ok(req('GET', '/v1/online-returns', undefined, MANAGER), 'desk')).body as { count: number; refundsWaiting: number };
    expect(desk).toMatchObject({ count: 1, refundsWaiting: 0 });
  }, 120_000);
});
