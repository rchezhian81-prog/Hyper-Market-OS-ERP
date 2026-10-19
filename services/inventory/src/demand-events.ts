// D-24 (R4, signed OB-227 · OB-220) — the store's festival and local-event calendar on head office's API, read by the
// forecast and the order proposal through a PORT (`DemandCalendarPort`) with no extra step.
//
//   POST /v1/inventory/demand-events/:eventId            a manager records (or changes — a new version) an event
//   POST /v1/inventory/demand-events/:eventId/withdraw   a manager withdraws it (a new fact; the event is kept)
//   GET  /v1/inventory/demand-events                     the calendar: each event with how its effect is known
//   GET  /v1/inventory/demand-events/weather             the weather link: switched off (OB-220)
//
// Each event's effect is "back-tested" only when an EARLIER occurrence of it (same name, same store) lies inside the
// shop's own sales history — then the effect actually seen is shown beside the manager's figure. Otherwise it is the
// "manager's estimate", said in those words. The forecast still uses the manager's figure either way: it is his
// decision what the event will do; the back-test is the evidence beside it.
//
// The weather link is the `WEATHER_FEED_SWITCHED_OFF` port in production: nothing is fetched or sent, and every forecast
// says weather is switched off. Nothing here moves stock, places an order or changes a price.

import type { Route, RequestContext } from '../../kernel/src/index';
import { apiError, notFound, assertBranchInScope } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import {
  validateDemandEvent, eventsInForce, signalsFor, earlierOccurrences, weatherSignals, InvalidDemandEventError,
  type DemandEvent, type DemandEventKind, type EventSignal, type WeatherFeedPort, type WeatherSignal,
} from '../../../packages/calendar/src/demand-events';
import { backtestEventEffect, type DailyDemand, type EventEffectBacktest } from '../../../packages/demand/src/forecast';

export type EffectBasis =
  | { readonly basis: 'manager_estimate'; readonly words: "manager's estimate" }
  | { readonly basis: 'back_tested'; readonly words: string; readonly on: EventEffectBacktest };

/** How an event's effect is known, from an earlier occurrence in the history — or the manager's estimate. */
export function effectBasisOf(all: readonly DemandEvent[], e: DemandEvent, history: readonly DailyDemand[], from: string, to: string): EffectBasis {
  for (const earlier of earlierOccurrences(all, e, e.from).sort((a, b) => b.from.localeCompare(a.from))) {
    const on = backtestEventEffect({ history, from, to, occFrom: earlier.from, occTo: earlier.to });
    if (on !== undefined) return { basis: 'back_tested', words: `back-tested on ${on.from}–${on.to}: seen ×${on.observedMultiplier}`, on };
  }
  return { basis: 'manager_estimate', words: "manager's estimate" };
}

/** What the forecast and the order proposal read: the stored calendar and the weather link. */
export interface DemandCalendarPort {
  readonly events: (tenantId: string) => Promise<readonly DemandEvent[]>;
  readonly categoryChain: (tenantId: string, productId: string) => Promise<readonly string[]>;
  readonly weather: WeatherFeedPort;
}

/** One product's stored signals over [fromDay, toDay], and the weather link's answer (switched off in production). */
export async function calendarSignals(port: DemandCalendarPort, tenantId: string, productId: string, fromDay: string, toDay: string): Promise<{
  readonly events: readonly DemandEvent[]; readonly signals: readonly EventSignal[];
  readonly weather: { readonly state: 'switched_off' | 'on'; readonly signals: readonly WeatherSignal[]; readonly detail: string };
}> {
  const events = await port.events(tenantId);
  const signals = signalsFor(events, { productId, categoryChain: await port.categoryChain(tenantId, productId), fromDay, toDay });
  // The weather link is asked ONLY through `weatherSignals`, which never calls the provider while it is switched off.
  const weather = await weatherSignals(port.weather, 'all', fromDay, toDay);
  return { events, signals, weather };
}

export interface DemandEventsDeps {
  readonly now: () => string;
  readonly events: (tenantId: string) => Promise<readonly DemandEvent[]>;
  /** Append one version of an event (never an edit). */
  readonly recordEvent: (tenantId: string, e: DemandEvent) => Promise<void>;
  /** The store's total sold per trading day over [fromDay, toDay] — what an earlier occurrence is back-tested on. */
  readonly storeDailyTotals: (tenantId: string, storeId: string, fromDay: string, toDay: string) => Promise<readonly DailyDemand[]>;
  readonly weather: WeatherFeedPort;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const strList = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);
const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00.000Z`) + n * 86_400_000).toISOString().slice(0, 10);
const bad = (code: string, whatHappened: string): never => {
  throw apiError(400, { code, whatHappened, wasItSaved: 'not_saved', nextSafeAction: 'Correct it and send it again. Nothing was changed.' });
};
/** How far back an earlier occurrence is looked for: a year and a little, so last year's festival counts. */
export const EVENT_HISTORY_DAYS = 400;

export function demandEventRoutes(deps: DemandEventsDeps): readonly Route[] {
  const latestOf = async (t: string, eventId: string) => {
    const mine = (await deps.events(t)).filter((e) => e.eventId === eventId);
    return mine.sort((a, b) => a.version - b.version).at(-1);
  };
  const audit = async (ctx: RequestContext, action: string, e: DemandEvent) => {
    await deps.recordAudit?.(ctx.tenantId, {
      actorId: ctx.userId, action, objectType: 'demand_event', objectId: e.eventId, at: deps.now(),
      origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null }, before: null,
      after: { label: e.label, from: e.from, to: e.to, multiplier: String(e.multiplier), version: String(e.version) },
      reason: 'D-24 store event calendar', correlationId: `demand-event-${e.eventId}-v${e.version}`,
    });
  };
  return [
    {
      api: 'API-04', method: 'POST', path: '/v1/inventory/demand-events/:eventId',
      permission: 'inventory.calendar.manage', idempotent: true,
      handler: async (ctx) => {
        const eventId = (ctx.params['eventId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!/^[A-Za-z0-9_-]{1,60}$/.test(eventId) || !isStr(b['storeId']) || !isStr(b['label']) || !isStr(b['kind']) || !isStr(b['from']) || !isStr(b['to']) || typeof b['multiplier'] !== 'number'
          || (b['productIds'] !== undefined && !strList(b['productIds'])) || (b['categoryIds'] !== undefined && !strList(b['categoryIds']))) {
          bad('not_readable_as_a_demand_event', 'An event needs { storeId, label, kind (festival | local_event), from, to (YYYY-MM-DD), multiplier (the expected effect, e.g. 1.5) }, and may name productIds or categoryIds.');
        }
        const storeId = (b['storeId'] as string).trim();
        assertBranchInScope(ctx, storeId);
        const draft = { label: (b['label'] as string).trim(), kind: b['kind'] as DemandEventKind, from: b['from'] as string, to: b['to'] as string, multiplier: b['multiplier'] as number };
        try { validateDemandEvent(draft); } catch (e) { if (e instanceof InvalidDemandEventError) bad('not_readable_as_a_demand_event', e.message); throw e; }
        const prior = await latestOf(ctx.tenantId, eventId);
        if (prior?.withdrawn !== undefined) {
          throw apiError(409, { code: 'demand_event_withdrawn', whatHappened: `Event ${eventId} was withdrawn by ${prior.withdrawn.by}; it is kept as it was.`, wasItSaved: 'not_saved', nextSafeAction: 'Record it under a new id. Nothing was changed.' });
        }
        if (prior !== undefined && prior.storeId !== storeId) {
          throw apiError(409, { code: 'demand_event_other_store', whatHappened: `Event ${eventId} is for store ${prior.storeId}.`, wasItSaved: 'not_saved', nextSafeAction: 'Use a new id for another store. Nothing was changed.' });
        }
        const e: DemandEvent = {
          eventId, version: (prior?.version ?? 0) + 1, storeId, ...draft,
          ...(strList(b['productIds']) && b['productIds'].length > 0 ? { productIds: b['productIds'] } : {}),
          ...(strList(b['categoryIds']) && b['categoryIds'].length > 0 ? { categoryIds: b['categoryIds'] } : {}),
          recordedBy: ctx.userId, recordedAt: deps.now(),
        };
        await deps.recordEvent(ctx.tenantId, e);
        await audit(ctx, 'demand.event.recorded', e);
        return { status: 201, body: { event: e, detail: 'Recorded. The next forecast and order proposal use it, and every figure it changes names it.' } };
      },
    },
    {
      api: 'API-04', method: 'POST', path: '/v1/inventory/demand-events/:eventId/withdraw',
      permission: 'inventory.calendar.manage', idempotent: true,
      handler: async (ctx) => {
        const eventId = (ctx.params['eventId'] ?? '').trim();
        const reason = ((ctx.body ?? {}) as { reason?: unknown }).reason;
        if (!isStr(reason)) bad('withdrawal_needs_a_reason', 'Withdrawing an event needs { reason }.');
        const prior = await latestOf(ctx.tenantId, eventId);
        if (prior === undefined) throw notFound(`demand event ${eventId}`);
        assertBranchInScope(ctx, prior.storeId);
        if (prior.withdrawn !== undefined) return { status: 200, body: { event: prior } };
        const e: DemandEvent = { ...prior, version: prior.version + 1, withdrawn: { by: ctx.userId, at: deps.now(), reason: (reason as string).slice(0, 300) } };
        await deps.recordEvent(ctx.tenantId, e);
        await audit(ctx, 'demand.event.withdrawn', e);
        return { status: 200, body: { event: e } };
      },
    },
    {
      api: 'API-04', method: 'GET', path: '/v1/inventory/demand-events',
      permission: 'inventory.availability.read',
      handler: async (ctx) => {
        const storeId = ctx.query['storeId'];
        const all = await deps.events(ctx.tenantId);
        const latest = new Map<string, DemandEvent>();
        for (const e of all) { const h = latest.get(e.eventId); if (h === undefined || e.version >= h.version) latest.set(e.eventId, e); }
        const today = deps.now().slice(0, 10);
        const histFrom = addDays(today, -EVENT_HISTORY_DAYS);
        const inForce = eventsInForce(all).filter((e) => storeId === undefined || e.storeId === storeId);
        const totals = new Map<string, readonly DailyDemand[]>();
        const rows = [];
        for (const e of inForce) {
          if (!totals.has(e.storeId)) totals.set(e.storeId, await deps.storeDailyTotals(ctx.tenantId, e.storeId, histFrom, addDays(today, -1)));
          rows.push({ ...e, effect: effectBasisOf(all, e, totals.get(e.storeId) ?? [], histFrom, addDays(today, -1)) });
        }
        const withdrawn = [...latest.values()].filter((e) => e.withdrawn !== undefined && (storeId === undefined || e.storeId === storeId));
        const weather = await weatherSignals(deps.weather, storeId ?? 'all', today, addDays(today, 6));
        return { status: 200, body: { events: rows, withdrawn, weather: { state: weather.state, detail: weather.detail }, asAt: deps.now() } };
      },
    },
    {
      api: 'API-04', method: 'GET', path: '/v1/inventory/demand-events/weather',
      permission: 'inventory.availability.read',
      handler: async () => {
        const today = deps.now().slice(0, 10);
        const w = await weatherSignals(deps.weather, 'all', today, addDays(today, 6));
        return { status: 200, body: { link: deps.weather.name, switchedOn: deps.weather.switchedOn, state: w.state, detail: w.detail, fetched: w.signals.length, asAt: deps.now() } };
      },
    },
  ];
}
