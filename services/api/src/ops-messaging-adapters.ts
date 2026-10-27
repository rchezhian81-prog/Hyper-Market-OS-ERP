// OB-288 package P5 (messaging and operations) — head office's wiring for the do-not-contact register (M31-FR-04), the
// CERT-In 6-hour clock and the capacity report (M35-FR-04). Every register is append-only on its own stream (hard rules
// #2, #6). Registered from main.ts: `opsMessagingRoutes` (routes), `notificationGuardHooks` (the send guard's register
// read) and `opsMessagingSweep` (the alert worker's pass: an overdue CERT-In report raised to the owners, once).

import { createHash } from 'node:crypto';
import { makeEvent } from '../../../packages/contracts/src/event';
import type { EventStore } from '../../../packages/persistence/src/event-store';
import { InMemoryEventStore } from '../../../packages/persistence/src/event-store';
import type { Route } from '../../kernel/src/index';
import { suppressionRoutes, type SuppressionFact } from '../../customer/src/suppression-register';
import { certInRoutes, certInOverdue, type CertInFact } from '../../platform/src/cert-in-reporting';
import { capacityRoutes, type CapacityPlan, type CapacityMeasure, type MeasuredVolume } from '../../platform/src/capacity-report';
import type { IncidentFact } from '../../platform/src/ops-incidents';
import { STREAM, streamName, SUPPRESSIONS_STREAM, effectiveGrants } from './adapters';
import { finBridgeRaiseToOwners } from './finance-bridge-adapters';
import { shopClock, type ShopCalendarOf } from '../../../packages/calendar/src/shop-clock';
import { wallClockIn } from '../../../packages/calendar/src/trading-day';

interface Base { readonly store: EventStore; readonly now: () => string; readonly calendar?: ShopCalendarOf }

const CERT_IN = (): string => streamName(STREAM.platform, 'cert-in');
const CAPACITY = (): string => streamName(STREAM.platform, 'capacity-plan');

const digest = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 32);
const payloads = async <T>(store: EventStore, tenantId: string, stream: string, type: string): Promise<T[]> =>
  (await store.readStream(tenantId, stream, { type })).map((e) => e.event.payload as T);
const put = async (store: EventStore, tenantId: string, stream: string, type: string, key: string, occurredAt: string, payload: unknown, source: string): Promise<void> => {
  const d = digest(key);
  await store.append(tenantId, stream, makeEvent({ id: `${type}-${d}`, type, occurredAt, idempotencyKey: `${type}-${tenantId}-${d}`, source, payload: payload as Record<string, unknown> }));
};

const suppressionFacts = (store: EventStore, t: string): Promise<SuppressionFact[]> => payloads<SuppressionFact>(store, t, SUPPRESSIONS_STREAM(), 'SuppressionRecorded');

/** The send guard reads the stored register (spread into its registration in main.ts). */
export function notificationGuardHooks(input: { readonly store: EventStore | undefined }): { readonly suppressions?: (tenantId: string) => Promise<readonly SuppressionFact[]> } {
  const store = input.store;
  return store === undefined ? {} : { suppressions: (t) => suppressionFacts(store, t) };
}

interface SaleForCapacity { readonly saleId: string; readonly laneId: string; readonly tradingDay: string; readonly committedAt: string }

/** The shop's own peaks over the window, from head office's records. Not known (null) when the records cannot show it. */
async function measure(input: Base, tenantId: string, windowDays: number): Promise<Readonly<Record<CapacityMeasure, MeasuredVolume>>> {
  const { store } = input;
  const from = new Date(Date.parse(input.now()) - windowDays * 86_400_000).toISOString();
  const sales = (await store.readStream(tenantId, STREAM.sales, { type: 'SaleCommitted', from })).map((e) => e.event.payload as SaleForCapacity);
  const perDay = new Map<string, number>();
  const perHour = new Map<string, number>();
  const lanes = new Set<string>();
  // M01-FR-02 (re-audit T1): the hour and the day are the shop's own, read in the tenant's zone — never a fixed +05:30.
  const zone = (await shopClock(input.calendar).calendar(tenantId)).timeZone;
  for (const s of sales) {
    perDay.set(s.tradingDay, (perDay.get(s.tradingDay) ?? 0) + 1);
    const hour = wallClockIn(s.committedAt, zone).slice(0, 13); // "YYYY-MM-DDTHH" on the store's clock
    perHour.set(hour, (perHour.get(hour) ?? 0) + 1);
    lanes.add(s.laneId);
  }
  const orders = (await payloads<{ placedAt?: string }>(store, tenantId, streamName(STREAM.orders, 'index'), 'OrderPlaced')).filter((o) => typeof o.placedAt === 'string' && o.placedAt >= from);
  const ordersPerDay = new Map<string, number>();
  for (const o of orders) { const d = wallClockIn(o.placedAt!, zone).slice(0, 10); ordersPerDay.set(d, (ordersPerDay.get(d) ?? 0) + 1); }
  const pack = (await store.latestOfType(tenantId, STREAM.catalogue, 'CataloguePublished'))?.event.payload as { snapshot?: { products?: readonly unknown[] } } | undefined;
  const people = new Set((await effectiveGrants(store, tenantId)).map((g) => g.userId));
  const peak = (m: Map<string, number>): number | null => (m.size === 0 ? null : Math.max(...m.values()));
  const window = `the last ${windowDays} days of head office's records`;
  return {
    bills_per_day: { peak: peak(perDay), basis: perDay.size === 0 ? `no bill has reached head office in ${window}` : `the busiest trading day in ${window} (${perDay.size} day(s) traded)` },
    bills_per_peak_hour: { peak: peak(perHour), basis: perHour.size === 0 ? `no bill has reached head office in ${window}` : `the busiest hour in ${window}, by the store's clock` },
    online_orders_per_day: { peak: peak(ordersPerDay), basis: ordersPerDay.size === 0 ? `no online order in ${window}` : `the busiest day for online orders in ${window}` },
    products: { peak: pack?.snapshot?.products === undefined ? null : pack.snapshot.products.length, basis: pack === undefined ? 'no catalogue has been published yet' : 'the products in the catalogue published last' },
    lanes: { peak: lanes.size === 0 ? null : lanes.size, basis: lanes.size === 0 ? `no till has sent a bill in ${window}` : `the tills that sent bills in ${window}` },
    people_with_access: { peak: people.size === 0 ? null : people.size, basis: 'every person or machine holding a role at the shop now' },
  };
}

/** Every route of this package. With no store, an in-memory one (the bare surface the guardrails build). */
export function opsMessagingRoutes(input: { readonly store: EventStore | undefined; readonly now: () => string; readonly calendar?: ShopCalendarOf }): readonly Route[] {
  const store = input.store ?? new InMemoryEventStore();
  const { now } = input;
  return [
    ...suppressionRoutes({
      now,
      facts: (t) => suppressionFacts(store, t),
      record: (t, f) => put(store, t, SUPPRESSIONS_STREAM(), 'SuppressionRecorded', f.factId, f.at, f, 'api/customer'),
    }),
    ...certInRoutes({
      now,
      facts: (t) => payloads<CertInFact>(store, t, CERT_IN(), 'CertInFact'),
      record: (t, f) => put(store, t, CERT_IN(), 'CertInFact', `${f.change}|${f.incidentId}`, f.at, f, 'api/platform'),
      incidentExists: async (t, id) => (await payloads<IncidentFact>(store, t, streamName(STREAM.platform, 'incidents'), 'OpsIncidentFact')).some((f) => f.change === 'opened' && f.incidentId === id),
    }),
    ...capacityRoutes({
      now,
      measure: (t, days) => measure({ store, now, ...(input.calendar === undefined ? {} : { calendar: input.calendar }) }, t, days),
      plan: async (t) => (await payloads<CapacityPlan>(store, t, CAPACITY(), 'CapacityPlanSet')).at(-1),
      recordPlan: (t, p) => put(store, t, CAPACITY(), 'CapacityPlanSet', `v${p.version}`, p.setAt, p, 'api/platform'),
    }),
  ];
}

/** The alert worker's per-shop pass: each CERT-In report past its six hours is raised to the owners, once. */
export function opsMessagingSweep(input: Base): (tenantId: string, at: string) => Promise<number> {
  return async (tenantId, at) => {
    let raised = 0;
    for (const c of certInOverdue(await payloads<CertInFact>(input.store, tenantId, CERT_IN(), 'CertInFact'), at)) {
      const ok = await finBridgeRaiseToOwners(input.store, input.now, tenantId, `cert-in-overdue:${c.incidentId}`, `CERT-In report — incident ${c.incidentId}`,
        `The CERT-In report for incident ${c.incidentId} (${c.category}) was due by ${c.reportBy} — six hours from when it was noticed (${c.noticedAt}). Report it now and record the reference.`,
        'system:cert-in-clock', at, c.incidentId);
      if (ok) raised += 1;
    }
    return raised;
  };
}
