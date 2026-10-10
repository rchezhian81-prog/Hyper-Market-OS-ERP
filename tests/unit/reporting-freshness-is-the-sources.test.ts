import { describe, it, expect } from 'vitest';
import { InMemoryEventStore } from '../../packages/persistence/src/event-store';
import { makeEvent } from '../../packages/contracts/src/event';
import { reportingAdapter, STREAM } from '../../services/api/src/adapters';
import { reportingRoutes, dashboard, figure, type Dashboard, type Figure } from '../../services/reporting/src/index';
import type { Route, RequestContext } from '../../services/kernel/src/index';

// Audit EA-01 (M29-FR-01 / M29-FR-03 / D13 / P-08): every owner figure states its REAL data freshness — the newest
// record that reached head office from the source it is built from — never the moment somebody read it. An 08:00 sale
// read at 16:00 is "as at 08:00, stale", not "as at 16:00, live". A shop no till has reached is "not available",
// never ₹0 and never fresh. A store that keeps trading through a long cloud disconnection reads stale until its queue
// drains, then live again with the whole day's takings.

const TENANT = '22222222-2222-4222-8222-222222222222';
const DAY = '2026-08-10';
const UTC = { timeZone: 'UTC', tradingDayCutoff: '00:00' };

interface SaleIn { id: string; at: string; totalMinor: number; locationId?: string; laneId?: string }

async function append(store: InMemoryEventStore, s: SaleIn): Promise<void> {
  await store.append(TENANT, STREAM.sales, makeEvent({
    id: `e-${s.id}`, type: 'SaleCommitted', occurredAt: s.at,
    idempotencyKey: `sale-${TENANT}-${s.id}`, source: 'test',
    payload: {
      saleId: s.id, receiptNumber: `R-${s.id}`, laneId: s.laneId ?? 'lane-1', cashierId: 'u-1',
      ...(s.locationId === undefined ? {} : { locationId: s.locationId }),
      tradingDay: DAY, committedAt: s.at, totalMinor: s.totalMinor,
      currency: 'INR', packVersion: 1, lines: [], tenders: [{ kind: 'cash', amountMinor: s.totalMinor }],
    },
  }));
}

const byName = (figures: readonly Figure[], name: string): Figure | undefined => figures.find((f) => f.name === name);

function ctx(): RequestContext {
  return { tenantId: TENANT, userId: 'u-owner', params: {}, query: {}, body: undefined } as unknown as RequestContext;
}
const routeFor = (routes: readonly Route[], path: string): Route => routes.find((r) => r.path === path)!;

async function readDashboard(store: InMemoryEventStore, now: string): Promise<Dashboard> {
  const routes = reportingRoutes(reportingAdapter({ store, now: () => now, calendar: () => UTC }));
  return (await routeFor(routes, '/v1/reports/dashboard').handler(ctx())).body as Dashboard;
}

describe('a head-office figure is as at its SOURCE, never the read time (audit EA-01)', () => {
  it('an 08:00 sale read at 16:00 is as at 08:00 and stale — the audit\'s reproduction, reversed', async () => {
    const store = new InMemoryEventStore();
    await append(store, { id: 'S1', at: `${DAY}T08:00:00.000Z`, totalMinor: 50_000, locationId: 'S1' });
    const figures = await reportingAdapter({ store, now: () => `${DAY}T16:00:00.000Z`, calendar: () => UTC }).figures(TENANT, 'dashboard');
    const sales = byName(figures, 'Sales today')!;
    expect(sales.valueMinor).toBe(50_000);
    expect(sales.asAt).toBe(`${DAY}T08:00:00.000Z`);
    expect(sales.staleness).toBe('stale');
    expect(sales.detail).toMatch(/8 hour\(s\) old/);
  });

  it('a sale two minutes old is live', async () => {
    const store = new InMemoryEventStore();
    await append(store, { id: 'S1', at: `${DAY}T11:58:00.000Z`, totalMinor: 10_000, locationId: 'S1' });
    const figures = await reportingAdapter({ store, now: () => `${DAY}T12:00:00.000Z`, calendar: () => UTC }).figures(TENANT, 'dashboard');
    expect(byName(figures, 'Sales today')?.staleness).toBe('live');
    expect(byName(figures, 'Sales today')?.asAt).toBe(`${DAY}T11:58:00.000Z`);
  });

  it('a shop no till has ever reached: not available, never ₹0, never fresh — and the dashboard says it is as at nothing', async () => {
    const store = new InMemoryEventStore();
    const body = await readDashboard(store, `${DAY}T12:00:00.000Z`);
    const sales = byName(body.figures, 'Sales today')!;
    expect(sales.valueMinor).toBeUndefined();
    expect(sales.asAt).toBeNull();
    expect(sales.staleness).toBe('stale');
    expect(sales.notAvailableBecause).toMatch(/no till has ever sent a sale/);
    expect(body.asAt).toBeNull();
    expect(body.readAt).toBe(`${DAY}T12:00:00.000Z`);
    expect(body.worstStaleness).toBe('stale');
    expect(body.sources).toEqual([expect.objectContaining({ source: 'any till', lastEventAt: null, staleness: 'stale' })]);
  });

  it('a shop that has not traded today is judged by when it was last heard from, not dropped', async () => {
    const store = new InMemoryEventStore();
    await store.append(TENANT, STREAM.sales, makeEvent({
      id: 'e-Y', type: 'SaleCommitted', occurredAt: '2026-08-09T18:00:00.000Z', idempotencyKey: `sale-${TENANT}-Y`, source: 'test',
      payload: { saleId: 'Y', receiptNumber: 'R-Y', laneId: 'lane-1', locationId: 'S1', cashierId: 'u-1', tradingDay: '2026-08-09', committedAt: '2026-08-09T18:00:00.000Z', totalMinor: 9_000, currency: 'INR', packVersion: 1, lines: [], tenders: [] },
    }));
    const body = await readDashboard(store, `${DAY}T09:00:00.000Z`);
    expect(byName(body.figures, 'Sales today')?.valueMinor).toBe(0); // the shop has been heard from: today's ₹0 is real
    expect(byName(body.figures, 'Sales today')?.asAt).toBe('2026-08-09T18:00:00.000Z');
    expect(body.sources?.[0]).toMatchObject({ source: 'store:S1', lastEventAt: '2026-08-09T18:00:00.000Z', staleness: 'stale' });
  });

  it('a store trading through a long cloud disconnection reads stale until its queue drains, then live with the whole day', async () => {
    const store = new InMemoryEventStore();
    // Morning: the link is up — two sales arrive.
    await append(store, { id: 'M1', at: `${DAY}T08:00:00.000Z`, totalMinor: 10_000, locationId: 'S1' });
    await append(store, { id: 'M2', at: `${DAY}T09:00:00.000Z`, totalMinor: 20_000, locationId: 'S1' });
    // 09:00 → 16:00 the link is down; the store keeps trading on its own box (P-01). Head office has heard nothing.
    const during = await readDashboard(store, `${DAY}T16:00:00.000Z`);
    expect(byName(during.figures, 'Sales today')?.valueMinor).toBe(30_000);
    expect(byName(during.figures, 'Sales today')?.asAt).toBe(`${DAY}T09:00:00.000Z`);
    expect(during.worstStaleness).toBe('stale');
    expect(during.asAt).toBe(`${DAY}T09:00:00.000Z`);
    expect(during.readAt).toBe(`${DAY}T16:00:00.000Z`);
    // 16:00 the link returns; the box drains in order — every sale it rang in the gap arrives.
    for (let h = 10; h <= 15; h += 1) await append(store, { id: `G${h}`, at: `${DAY}T${h}:30:00.000Z`, totalMinor: 1_000, locationId: 'S1' });
    await append(store, { id: 'G16', at: `${DAY}T15:58:00.000Z`, totalMinor: 4_000, locationId: 'S1' });
    const after = await readDashboard(store, `${DAY}T16:00:00.000Z`);
    expect(byName(after.figures, 'Sales today')?.valueMinor).toBe(30_000 + 6_000 + 4_000);
    expect(byName(after.figures, 'Sales today')?.staleness).toBe('live');
    expect(after.worstStaleness).toBe('live');
  });

  it('two stores: the figure is as current as the STALEST store, and each store says how current it is', async () => {
    const store = new InMemoryEventStore();
    await append(store, { id: 'A', at: `${DAY}T15:59:00.000Z`, totalMinor: 10_000, locationId: 'S1' });
    await append(store, { id: 'B', at: `${DAY}T10:00:00.000Z`, totalMinor: 5_000, locationId: 'S2' });
    const body = await readDashboard(store, `${DAY}T16:00:00.000Z`);
    expect(byName(body.figures, 'Sales today')?.asAt).toBe(`${DAY}T10:00:00.000Z`);
    expect(byName(body.figures, 'Sales today')?.staleness).toBe('stale');
    expect(body.sources?.map((s) => [s.source, s.staleness])).toEqual([['store:S1', 'live'], ['store:S2', 'stale']]);
  });
});

describe('the dashboard is never fresher than its stalest figure or source', () => {
  const NOW = `${DAY}T12:00:00.000Z`;
  it('its asAt is the oldest figure time, the read time is separate', () => {
    const d = dashboard([
      figure({ name: 'a', valueMinor: 1, unit: 'count', asAt: `${DAY}T11:59:00.000Z`, now: NOW }),
      figure({ name: 'b', valueMinor: 2, unit: 'count', asAt: `${DAY}T10:00:00.000Z`, now: NOW }),
    ], NOW);
    expect(d.asAt).toBe(`${DAY}T10:00:00.000Z`);
    expect(d.readAt).toBe(NOW);
    expect(d.worstStaleness).toBe('stale');
  });
  it('an empty dashboard is as at nothing', () => {
    expect(dashboard([], NOW).asAt).toBeNull();
  });
});
