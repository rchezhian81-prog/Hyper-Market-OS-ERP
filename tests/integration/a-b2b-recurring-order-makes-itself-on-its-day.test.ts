import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { setApprovedCreditLimit } from '../support/approved-credit-limit';
import { onThePriceList, harnessPriceList } from '../support/b2b-price-on-record';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore, type EventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { commercialDesksSweep } from '../../services/api/src/commercial-desks-adapters';
import { RECURRING_RUNNER } from '../../services/finance/src/b2b-ordering';

/**
 * **M22-FR-03 "recurring orders generate on schedule" — head office's own worker makes each approved recurring order on
 * its due day, once, by itself; a paused one makes nothing until a second person approves it again (OB-384 · §28 ·
 * P-03 · P-08 · hard rules #2 #10).**
 *
 * The route `POST /v1/b2b/recurring-runs` said "the scheduler calls this each day" and nothing did. Now the ops-alert
 * worker's pass (`commercialDesksSweep`, every minute) runs the day's recurring orders:
 *   • on the due day (the SHOP's date) an approved schedule's order is made through the ordinary stock and credit checks,
 *     recorded as run by `system:b2b-recurring`;
 *   • the next pass, a minute later, and a COLD RESTART of head office make nothing more — no second order, no second
 *     exception — because what was run is read back from the record;
 *   • a run the shelf cannot supply is an exception on record AND raised to the owners, once;
 *   • not due → nothing; the `b2b` switch off (OB-384: off in production until the old system is retired) → nothing;
 *   • PAUSE needs a reason and the right; a paused schedule makes nothing; it is in force again only when someone other
 *     than its maker approves it — and then it makes its next due day; an order not yet approved cannot be paused.
 * In memory and, with DATABASE_URL, on real PostgreSQL. Synthetic data only.
 */

const OWNER = 'u-owner'; const MGR = 'u-mgr'; const CASHIER = 'u-cash';
const RICE = { lineId: 'l1', productId: 'rice', description: 'Ponni rice 25kg', unitPriceMinor: 10_000, taxRateBps: 500 };
const MON = '2026-11-02'; // a Monday
const at = (date: string): string => `${date}T04:30:00.000Z`; // 10:00 in the shop (IST)
const codeOf = (r: { body: unknown }): string | undefined => (r.body as { error?: { code?: string } }).error?.code;

const DATABASE_URL = process.env['DATABASE_URL'];
let pool: Pool | undefined;
beforeAll(async () => {
  if (DATABASE_URL === undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
  const dir = 'db/migrations';
  await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
});
afterAll(async () => { await pool?.end(); });

interface Backing { readonly name: string; readonly fresh: () => { harness: ApiHarness; store: EventStore }; readonly restart: (prior: EventStore) => { harness: ApiHarness; store: EventStore } }
const backings: Backing[] = [{
  name: 'the in-memory event store',
  fresh: () => { const harness = apiHarness(); return { harness, store: harness.store }; },
  // In memory, "restart" is a new head-office surface over the same store: nothing held in the old one carries over.
  restart: (prior) => { const harness = apiHarness({ store: prior }); return { harness, store: prior }; },
}];
if (DATABASE_URL !== undefined) {
  const pg = () => { const sql = pgPoolClient(pool!); const store = new SqlEventStore(sql); return { harness: apiHarness({ store, idempotency: new SqlIdempotencyStore(sql) }), store }; };
  backings.push({ name: 'real PostgreSQL', fresh: pg, restart: () => pg() });
}

describe.each(backings)('M22-FR-03 — a recurring order makes itself on its day, once — on $name', ({ fresh, restart }) => {
  it('made by the worker on its due day, never twice (next pass, cold restart); exceptions raised once; pause and re-approval governed; off when b2b is off', async () => {
    const first = fresh();
    let h = first.harness;
    let store = first.store;
    const T = randomUUID();
    await h.seedOwner(T, OWNER);
    await h.enableFeature(T, 'b2b');
    await h.provisionRole(T, MGR, 'store_manager');
    await h.provisionRole(T, CASHIER, 'cashier');
    const call = (method: 'GET' | 'POST' | 'PUT', path: string, user: string, body?: unknown) =>
      h.request({ method, path, userId: user, tenantId: T, ...(body === undefined ? {} : { body }), ...(method === 'GET' ? {} : { idempotencyKey: `${path}-${user}-${randomUUID()}` }) });
    const ok = async (p: ReturnType<typeof call>, what: string) => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
    type Book = { schedules: { scheduleId: string; inForce: boolean; pausedBy?: string; pauseReason?: string; round?: number; runs: { on: string; outcome: string; ranBy: string; orderId?: string }[] }[]; exceptions: { scheduleId: string; on: string }[] };
    const book = async (): Promise<Book> => (await call('GET', '/v1/b2b/recurring', OWNER)).body as Book;
    const runsOf = async (id: string) => (await book()).schedules.find((s) => s.scheduleId === id)!.runs;
    const sweepOn = (date: string, s: EventStore = store) => commercialDesksSweep({ store: s, now: () => at(date), recurring: {} })(T, at(date));

    await ok(call('POST', '/v1/inventory/movements', OWNER, { movementId: 'rice-in', productId: 'rice', locationId: 'S1', kind: 'received', quantityMinor: 20, uom: 'ea', occurredAt: new Date().toISOString(), enteredBy: OWNER }), 'stock');
    await ok(setApprovedCreditLimit(h, T, OWNER, 'CATERER', { creditLimitMinor: 10_000_000, paymentTermsDays: 30 }), 'terms');
    const lines = async (qty: number) => onThePriceList(harnessPriceList(h, T, OWNER), 'CATERER', [{ ...RICE, qty }]);
    await ok(call('POST', '/v1/b2b/documents/CATERER/quotations/q-tpl', MGR, { lines: await lines(2), locationId: 'S1', validForDays: 365 }), 'template');
    await ok(call('POST', '/v1/b2b/documents/CATERER/quotations/q-big', MGR, { lines: await lines(50), locationId: 'S1', validForDays: 365 }), 'big template');
    await ok(call('POST', '/v1/b2b/recurring/rec-1', MGR, { customerId: 'CATERER', fromQuotationId: 'q-tpl', cadence: 'weekly', dayOf: 1, startsOn: MON }), 'propose');
    await ok(call('POST', '/v1/b2b/recurring/rec-big', MGR, { customerId: 'CATERER', fromQuotationId: 'q-big', cadence: 'weekly', dayOf: 1, startsOn: MON }), 'propose big');

    // Not yet approved: the worker makes nothing; and it cannot be paused (it is not running).
    expect(await sweepOn(MON)).toBe(0);
    expect(await runsOf('rec-1')).toEqual([]);
    const pauseEarly = await call('POST', '/v1/b2b/recurring/rec-1/pause', MGR, { reason: 'too soon' });
    expect(pauseEarly.status).toBe(409);
    expect(codeOf(pauseEarly)).toBe('recurring_order_not_in_force');

    await ok(call('POST', '/v1/b2b/recurring/rec-1/approve', OWNER, {}), 'approve');
    await ok(call('POST', '/v1/b2b/recurring/rec-big/approve', OWNER, {}), 'approve big');

    // ── The due day: the worker makes rec-1's order by itself; rec-big cannot be supplied → an exception, raised once.
    expect(await sweepOn(MON)).toBe(1); // one alert to the owners: rec-big
    expect(await runsOf('rec-1')).toEqual([expect.objectContaining({ on: MON, outcome: 'generated', ranBy: RECURRING_RUNNER, orderId: `RSO-rec-1-${MON}` })]);
    expect(await runsOf('rec-big')).toEqual([expect.objectContaining({ on: MON, outcome: 'exception', ranBy: RECURRING_RUNNER })]);
    expect((await book()).exceptions).toEqual([expect.objectContaining({ scheduleId: 'rec-big', on: MON })]);
    const order = await call('GET', `/v1/b2b/desk/CATERER`, OWNER);
    expect(JSON.stringify(order.body)).toContain(`RSO-rec-1-${MON}`);

    // ── The next pass a minute later: nothing more — no second order, no second exception, no second alert.
    expect(await commercialDesksSweep({ store, now: () => `${MON}T04:31:00.000Z`, recurring: {} })(T, `${MON}T04:31:00.000Z`)).toBe(0);
    expect(await runsOf('rec-1')).toHaveLength(1);
    expect(await runsOf('rec-big')).toHaveLength(1);

    // ── COLD RESTART of head office: a new surface over what was stored makes nothing more for that day either.
    ({ harness: h, store } = restart(store));
    expect(await sweepOn(MON)).toBe(0);
    expect(await runsOf('rec-1')).toHaveLength(1);
    expect(await runsOf('rec-big')).toHaveLength(1);
    // A person may still retry the exception from the desk (the manual route keeps trying it).
    expect(((await ok(call('POST', '/v1/b2b/recurring-runs', MGR, { on: MON }), 'manual retry')).body as { exceptions: number }).exceptions).toBe(1);

    // ── Not due (a Tuesday): nothing.
    expect(await sweepOn('2026-11-03')).toBe(0);
    expect(await runsOf('rec-1')).toHaveLength(1);

    // ── PAUSE: needs the right and a reason; then the next Monday makes nothing.
    expect((await call('POST', '/v1/b2b/recurring/rec-1/pause', CASHIER, { reason: 'x' })).status).toBe(403);
    expect(codeOf(await call('POST', '/v1/b2b/recurring/rec-1/pause', MGR, {}))).toBe('pause_needs_a_reason');
    await ok(call('POST', '/v1/b2b/recurring/rec-1/pause', MGR, { reason: 'school closed for the holidays' }), 'pause');
    await ok(call('POST', '/v1/b2b/recurring/rec-big/pause', MGR, { reason: 'cannot be supplied' }), 'pause big');
    expect((await book()).schedules.find((s) => s.scheduleId === 'rec-1')).toMatchObject({ inForce: false, pausedBy: MGR, pauseReason: 'school closed for the holidays' });
    expect(await sweepOn('2026-11-09')).toBe(0);
    expect(await runsOf('rec-1')).toHaveLength(1);

    // ── Approved AGAIN — never by its maker — and the next due day makes its order.
    const self = await call('POST', '/v1/b2b/recurring/rec-1/approve', MGR, {});
    expect(self.status).toBe(403);
    await ok(call('POST', '/v1/b2b/recurring/rec-1/approve', OWNER, {}), 're-approve');
    expect((await book()).schedules.find((s) => s.scheduleId === 'rec-1')).toMatchObject({ inForce: true, round: 2 });
    expect(await sweepOn('2026-11-16')).toBe(0);
    expect((await runsOf('rec-1')).map((r) => r.on)).toEqual([MON, '2026-11-16']);

    // ── OB-384: with the shop's b2b switch OFF, the worker makes nothing at all.
    await ok(call('PUT', '/v1/platform/entitlements/b2b', OWNER, { enabled: false }), 'b2b off');
    expect(await sweepOn('2026-11-23')).toBe(0);
    await ok(call('PUT', '/v1/platform/entitlements/b2b', OWNER, { enabled: true }), 'b2b on again to read');
    expect((await runsOf('rec-1')).map((r) => r.on)).toEqual([MON, '2026-11-16']);
  }, 90_000);
});
