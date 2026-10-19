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
 * **D-24 (R4, signed OB-227 · OB-220): a festival or local event the manager records changes the forecast and the order
 * proposal with no extra step, and says so.** "Each figure it changed names the event. The 7-day forecast is corrected
 * from the most recent days' actual sales, with the back-test error shown beside it. An effect never back-tested shows as
 * 'manager's estimate'. The weather feed is built as a switched-off link, and nothing is sent or fetched while switched
 * off." On the real API, in memory and on real PostgreSQL, with a cold restart.
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

const backings: { name: string; harness: () => ApiHarness; restart: (h: ApiHarness) => ApiHarness }[] = [
  { name: 'the in-memory event store', harness: () => apiHarness(), restart: (h) => apiHarness({ store: h.store }) },
];
if (DATABASE_URL !== undefined) {
  const pg = () => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); };
  backings.push({ name: 'real PostgreSQL', harness: pg, restart: pg });
}

type Res = { status: number; body: unknown };
const codeOf = (r: Res): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
const STORE = 'store-01';
const today = (): string => new Date().toISOString().slice(0, 10);
const day = (n: number): string => new Date(Date.parse(`${today()}T00:00:00.000Z`) + n * 86_400_000).toISOString().slice(0, 10);
interface Forecast {
  horizon: { day: string; forecastQty: number; signalMultiplier: number; appliedSignals: string[] }[];
  storedEvents: { eventId: string; label: string; effect: { basis: string; words: string; on?: { observedMultiplier: number } } }[];
  shortHorizon: { correction: { basis: string; factor: number; recentDays: number }; horizon: { day: string; correctedQty: number; appliedSignals: string[] }[]; backtest: { testedDays: number; plainWape: number; correctedWape: number } };
  weather: { state: string; detail: string };
}

describe.each(backings)('a stored festival changes the forecast and says so — on $name (D-24)', ({ harness, restart }) => {
  it('recorded events reach the forecast and the order proposal by name; the short-horizon correction and its back-test; manager\'s estimate; weather off', async () => {
    let h = harness();
    const T = randomUUID();
    if (h.store instanceof SqlEventStore) await h.store.registerTenant(T, 'test/provision');
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-cash', 'cashier');
    const req = (method: 'GET' | 'POST', path: string, body?: unknown, userId = 'u-owner', query?: Record<string, string>): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'POST' ? { idempotencyKey: `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });
    const ok = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };

    // Eight weeks of the shop's own sales: 10 teas and 10 soaps a day; on last month's market day, 20 teas.
    let n = 0;
    for (let i = 56; i >= 1; i -= 1) {
      const d = day(-i);
      const teas = i === 20 ? 20 : 10;
      n += 1;
      await ok(req('POST', '/v1/sales', {
        saleId: `S-${n}`, receiptNumber: `R-${n}`, laneId: 'lane-1', locationId: STORE, cashierId: 'u-owner', tradingDay: d, committedAt: `${d}T06:00:00.000Z`,
        totalMinor: (teas + 10) * 100, currency: 'INR', packVersion: 1,
        lines: [{ productId: 'p-tea', quantityMinor: teas, uom: 'ea', unitPriceMinor: 100, lineTotalMinor: teas * 100 }, { productId: 'p-soap', quantityMinor: 10, uom: 'ea', unitPriceMinor: 100, lineTotalMinor: 1_000 }],
        tenders: [{ kind: 'cash', amountMinor: (teas + 10) * 100 }],
      }), `sale ${n}`);
    }

    const record = (id: string, body: Record<string, unknown>, userId = 'u-owner') => req('POST', `/v1/inventory/demand-events/${id}`, { storeId: STORE, ...body }, userId);
    expect((await record('md-next', { label: 'Market day', kind: 'local_event', from: day(3), to: day(3), multiplier: 1.8 }, 'u-cash')).status).toBe(403);
    expect(codeOf(await record('bad', { label: 'X', kind: 'festival', from: day(3), to: day(2), multiplier: 1.5 }))).toBe('not_readable_as_a_demand_event');
    expect(codeOf(await record('bad', { label: 'X', kind: 'festival', from: day(3), to: day(3), multiplier: 0 }))).toBe('not_readable_as_a_demand_event');
    await ok(record('md-last', { label: 'Market day', kind: 'local_event', from: day(-20), to: day(-20), multiplier: 2 }), 'last market day');
    await ok(record('md-next', { label: 'Market day', kind: 'local_event', from: day(3), to: day(3), multiplier: 1.8 }), 'next market day');
    await ok(record('pongal', { label: 'Pongal', kind: 'festival', from: day(5), to: day(6), multiplier: 1.5, productIds: ['p-tea'] }), 'pongal');

    h = restart(h); // cold restart: the calendar is what was recorded

    // The forecast uses them with no extra step, and each changed day names its event.
    const tea = (await ok(req('GET', '/v1/inventory/demand-forecast', undefined, 'u-owner', { productId: 'p-tea' }), 'tea forecast')).body as Forecast;
    const on = (d: string) => tea.horizon.find((x) => x.day === d)!;
    expect(on(day(3)).appliedSignals).toEqual(['Market day']);
    expect(on(day(3)).signalMultiplier).toBe(1.8);
    expect(on(day(5)).appliedSignals).toEqual(['Pongal']);
    expect(on(day(1)).appliedSignals).toEqual([]);
    expect(on(day(3)).forecastQty).toBeGreaterThan(on(day(1)).forecastQty);
    // How each effect is known: the market day was seen before (back-tested); Pongal never was — the manager's estimate.
    const md = tea.storedEvents.find((e) => e.eventId === 'md-next')!;
    expect(md.effect.basis).toBe('back_tested');
    expect(md.effect.on?.observedMultiplier).toBe(2);
    expect(tea.storedEvents.find((e) => e.eventId === 'pongal')!.effect).toEqual({ basis: 'manager_estimate', words: "manager's estimate" });
    // The 7-day forecast corrected from the last days' actual sales, the back-test error beside it.
    expect(tea.shortHorizon.correction.recentDays).toBe(7);
    expect(tea.shortHorizon.correction.basis).toBe('corrected');
    expect(tea.shortHorizon.horizon).toHaveLength(7);
    expect(tea.shortHorizon.horizon.find((x) => x.day === day(3))!.appliedSignals).toEqual(['Market day']);
    expect(tea.shortHorizon.backtest.testedDays).toBe(7);
    expect(typeof tea.shortHorizon.backtest.plainWape).toBe('number');
    expect(typeof tea.shortHorizon.backtest.correctedWape).toBe('number');
    // Weather: switched off, said.
    expect(tea.weather.state).toBe('switched_off');
    expect(tea.weather.detail).toMatch(/nothing is fetched or sent/);

    // Pongal was for tea only: soap's forecast carries the market day and not Pongal.
    const soap = (await ok(req('GET', '/v1/inventory/demand-forecast', undefined, 'u-owner', { productId: 'p-soap' }), 'soap')).body as Forecast;
    expect(soap.horizon.find((x) => x.day === day(5))!.appliedSignals).toEqual([]);
    expect(soap.horizon.find((x) => x.day === day(3))!.appliedSignals).toEqual(['Market day']);

    // The order proposal uses the calendar too, and names the event on the day it changed.
    const proposal = (await ok(req('POST', '/v1/replenishment/order-proposal', { productId: 'p-tea', onHand: 0, upcomingDeliveries: [day(1), day(8)] }), 'proposal')).body as { eventsApplied: { day: string; events: string[] }[] };
    expect(proposal.eventsApplied).toEqual([{ day: day(3), events: ['Market day'] }, { day: day(5), events: ['Pongal'] }, { day: day(6), events: ['Pongal'] }]);

    // The calendar page's read; a withdrawal is a new fact and the next forecast drops it.
    const list = (await ok(req('GET', '/v1/inventory/demand-events', undefined, 'u-owner', { storeId: STORE }), 'list')).body as { events: { eventId: string; effect: { basis: string } }[]; weather: { state: string } };
    expect(Object.fromEntries(list.events.map((e) => [e.eventId, e.effect.basis]))).toEqual({ 'md-last': 'manager_estimate', 'md-next': 'back_tested', pongal: 'manager_estimate' });
    expect(list.weather.state).toBe('switched_off');
    expect(codeOf(await req('POST', '/v1/inventory/demand-events/pongal/withdraw', {}))).toBe('withdrawal_needs_a_reason');
    await ok(req('POST', '/v1/inventory/demand-events/pongal/withdraw', { reason: 'moved to next month' }), 'withdraw');
    expect(codeOf(await record('pongal', { label: 'Pongal', kind: 'festival', from: day(5), to: day(6), multiplier: 1.5 }))).toBe('demand_event_withdrawn');
    const after = (await ok(req('GET', '/v1/inventory/demand-forecast', undefined, 'u-owner', { productId: 'p-tea' }), 'after')).body as Forecast;
    expect(after.horizon.find((x) => x.day === day(5))!.appliedSignals).toEqual([]);
    const weather = (await ok(req('GET', '/v1/inventory/demand-events/weather'), 'weather')).body as { switchedOn: boolean; state: string; fetched: number };
    expect([weather.switchedOn, weather.state, weather.fetched]).toEqual([false, 'switched_off', 0]);
  }, 180_000);
});
