// OB-288 lane 4 · P2 — owner reporting: head office's wiring (audit-4 P2 · M29-FR-01/03/04 · M28-FR-04 · D13).
//
// One entry point, `ownerReportingSurface(surface, input)`, is the line in main.ts; `ownerReportingSweep(input)` is the line
// on the ops-alert worker. It ADDS this package's routes and wraps existing ones IN PLACE, each keeping its own path and
// permission and gaining only the step named here:
//
//   • `GET /v1/reports/dashboard` (M29-FR-01) — gains `kpis`: the seven domains (sales, margin, cash, stock, purchase,
//     customer, fulfilment), each from its catalogue report's producer, each with its own freshness, in the reader's
//     scope (`dashboard-figures.ts`). A branch-limited reader's headline sales are their own branches'.
//   • `GET /v1/waste/report` (M28-FR-04) — gains the energy the facilities register holds for the branch and window (from
//     `reportEnergy`, the same engine `GET /v1/facilities/energy` runs), the scrap proceeds from the scrap register, and
//     the drill-through: the waste records, scrap sales and readings behind the totals. One that is absent is said.
//   • Owner exception alerts (M29-FR-03, `services/reporting/src/owner-exceptions.ts`) — the six thresholds (each "not
//     set" until the owner enters it), the day's exceptions from the synced till actions, till closes and (OB-365) the till
//     sign-in log, and the sweep that raises them into every owner's alert inbox on the worker's timer.
//   • Scheduled reports and exports (M29-FR-04, `services/reporting/src/report-schedules.ts`) — a report made by its own
//     producer; an export made through the governed export route under the owner's own authority, and logged.
//
// A target route that is missing throws at start-up (P-08: a wrapper that wraps nothing is a silent failure). Every
// register here is append-only on its own stream (hard rules #2, #6). Nothing here moves money or stock; no AI writes.

import { InMemoryEventStore, type EventStore } from '../../../packages/persistence/src/event-store';
import { makeEvent } from '../../../packages/contracts/src/event';
import type { AuditEntry } from '../../../packages/audit/src/index';
import { tradingDayIn, shiftDate, wallClockIn, type TradingCalendar } from '../../../packages/calendar/src/index';
import { FAILED_SIGN_IN_REASONS, LOCKOUT_REASONS } from '../../identity/src/till-sign-in-log';
import { tillSignInRecords } from './wave5-followups-adapters';
import { SETTINGS } from '../../../packages/tenant/src/index';
import type { TenantSetting } from '../../../packages/tenant/src/settings';
import { REPORTS } from '../../../packages/reporting/src/index';
import { buildSustainabilityReport, type WasteRecord } from '../../../packages/waste/src/index';
import { reportEnergy } from '../../../packages/facilities/src/assets';
import type { ExceptionEvent, OwnerAlert } from '../../../packages/owner-control/src/index';
import type { Route, RequestContext } from '../../kernel/src/index';
import { ApiError, narrowScope } from '../../kernel/src/index';
import { dashboard, type Dashboard } from '../../reporting/src/index';
import { shopWallClock } from '../../reporting/src/scheduled-brief';
import { ownerExceptionRoutes, ownerExceptionAlertId, sweepOwnerExceptions, THRESHOLD_WORDS, type OwnerExceptionsDeps, type ThresholdSetting, type ExceptionSource } from '../../reporting/src/owner-exceptions';
import { reportScheduleRoutes, runSchedulesPass, type ReportScheduleDeps, type ReportSchedule, type ScheduledRun, type RunOutput } from '../../reporting/src/report-schedules';
import type { NotificationQueueEvent } from '../../customer/src/notification-queue';
import type { TillActivity } from '../../pos/src/loss-prevention';
import type { ClosedShiftRecord } from '../../pos/src/shift';
import type { AlertLifecycleEvent } from '../../platform/src/alert-lifecycle';
import {
  STREAM, streamName, effectiveGrants, permissionsHeldBy, alertLifecycleAdapter, wasteAdapter, scrapAdapter, facilitiesAssetsAdapter, storeSyncView,
} from './adapters';
import { reportProducers, PRODUCED_AT_HEAD_OFFICE } from './report-producers';
import { dashboardKpis } from './dashboard-figures';
import { OWNER_ROLE_ID } from './roles';

type Recorder = (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
/** The one thing this file reads from tenant settings: a setting's value in force (the shop's calendar, the loyalty rule). */
export interface SettingsReader { value<T>(tenantId: string, setting: TenantSetting<T>): Promise<T> }

export interface OwnerReportingInput {
  readonly store: EventStore | undefined;
  readonly now: () => string;
  readonly settings: SettingsReader;
  readonly recordAudit?: Recorder;
  /** The route table — a scheduled export runs through the governed export route itself, as its owner. */
  readonly routes?: () => readonly Route[];
  /** Tests only: the PA-08 queue and a switched-on sending link. Production has none: sending is off (OB-222). */
  readonly outbox?: { readonly enqueue: (tenantId: string, event: NotificationQueueEvent, key: string) => Promise<void> | void };
  readonly sendingOn?: boolean;
}
interface Base extends Omit<OwnerReportingInput, 'store'> { readonly store: EventStore }

export const OWNER_REPORTING_STREAMS = Object.freeze({
  thresholds: streamName(STREAM.reporting, 'owner-alert-thresholds'),
  schedules: streamName(STREAM.reporting, 'report-schedules'),
  runs: streamName(STREAM.reporting, 'report-runs'),
});

const payloads = async <T>(store: EventStore, tenantId: string, stream: string, type: string): Promise<{ readonly p: T; readonly at: string }[]> =>
  (await store.readStream(tenantId, stream, { type })).map((e) => ({ p: e.event.payload as T, at: e.event.occurredAt }));

const put = async (store: EventStore, tenantId: string, stream: string, type: string, id: string, at: string, payload: unknown): Promise<void> => {
  await store.append(tenantId, stream, makeEvent({ id: `${type}-${id}`, type, occurredAt: at, idempotencyKey: `${type}-${tenantId}-${id}`, source: 'api/reporting', payload: payload as Record<string, unknown> }));
};

const calendarOf = (input: Base) => async (tenantId: string): Promise<TradingCalendar> => ({
  timeZone: await input.settings.value(tenantId, SETTINGS.STORE_TIME_ZONE),
  tradingDayCutoff: await input.settings.value(tenantId, SETTINGS.TRADING_DAY_CUTOFF),
});

const producersOf = (input: Base) => reportProducers({
  store: input.store, now: input.now, calendar: calendarOf(input),
  loyaltyRule: async (t) => ({ pointValuePaise: await input.settings.value(t, SETTINGS.LOYALTY_POINT_VALUE_PAISE) }),
  storeSync: (t) => storeSyncView(input.store, t, input.now),
});

function replaceRoute(surface: Route[], method: Route['method'], path: string, wrap: (base: Route) => Route['handler']): void {
  const i = surface.findIndex((r) => r.method === method && r.path === path);
  if (i < 0) throw new Error(`owner reporting: the route ${method} ${path} is not registered — nothing to wrap`);
  const base = surface[i]!;
  surface[i] = { ...base, handler: wrap(base) };
}

// ── M29-FR-03: owner exception alerts ───────────────────────────────────────────────────────────────────────────────

// OB-365: the store computers send their till sign-in logs (services/api/src/wave5-followups-adapters.ts); a sign-in is
// judged by the SHOP's wall clock (its time zone), never the server's.
const isFailedSignIn = (reason: string | undefined): boolean => reason !== undefined && FAILED_SIGN_IN_REASONS.includes(reason);
/** P-08: before the first record arrives, "none" would read like a clean day — so it is said as not yet known. */
const NO_SIGN_IN_LOG_YET = 'no till sign-in record has reached head office yet — each store computer sends its sign-in log (OB-365); until the first arrives this cannot be judged';

/** The day's exception events, read from the synced till actions and till closes (the store computers relay both). */
async function exceptionEventsOn(input: Base, tenantId: string, day: string): Promise<{ events: ExceptionEvent[]; sources: ExceptionSource[] }> {
  const calendar = await calendarOf(input)(tenantId);
  const acts = await payloads<TillActivity>(input.store, tenantId, streamName(STREAM.lossPrevention, 'activity'), 'TillActivityRecorded');
  const closes = await payloads<ClosedShiftRecord>(input.store, tenantId, streamName(STREAM.cash, 'shifts'), 'TillClosed');
  const newest = (xs: readonly { at: string }[]): string | null => (xs.length === 0 ? null : xs.map((x) => x.at).reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a)));
  const today = acts.map((a) => a.p).filter((a) => (a.tradingDay ?? tradingDayIn(a.at, calendar)) === day);
  const branchOf = (a: TillActivity): string => a.storeId ?? a.laneId;
  const events: ExceptionEvent[] = [];
  // A voided bill: every void on one bill by one cashier is ONE voided bill, worth what its voided lines were.
  const bills = new Map<string, TillActivity[]>();
  for (const a of today.filter((x) => x.kind === 'void')) {
    const k = `${a.cashierId}|${a.billRef ?? a.activityId}`;
    bills.set(k, [...(bills.get(k) ?? []), a]);
  }
  for (const list of bills.values()) {
    const first = [...list].sort((x, y) => x.at.localeCompare(y.at))[0]!;
    events.push({ eventId: `void:${first.billRef ?? first.activityId}`, kind: 'voided_bill', at: first.at, branchId: branchOf(first), actorId: first.cashierId, laneId: first.laneId, valueMinor: list.reduce((t, x) => t + x.valueMinor, 0), transactionRef: first.billRef ?? first.activityId });
  }
  // A price override: each one is one. A large discount: what overrides took off ONE bill, together.
  const overrides = today.filter((x) => x.kind === 'price_override');
  const discounts = new Map<string, TillActivity[]>();
  for (const a of overrides) {
    events.push({ eventId: `override:${a.activityId}`, kind: 'price_override', at: a.at, branchId: branchOf(a), actorId: a.cashierId, laneId: a.laneId, valueMinor: a.valueMinor, transactionRef: a.billRef ?? a.activityId });
    const k = `${a.cashierId}|${a.billRef ?? a.activityId}`;
    discounts.set(k, [...(discounts.get(k) ?? []), a]);
  }
  for (const list of discounts.values()) {
    const first = [...list].sort((x, y) => x.at.localeCompare(y.at))[0]!;
    events.push({ eventId: `discount:${first.billRef ?? first.activityId}`, kind: 'large_discount', at: first.at, branchId: branchOf(first), actorId: first.cashierId, laneId: first.laneId, valueMinor: list.reduce((t, x) => t + x.valueMinor, 0), transactionRef: first.billRef ?? first.activityId });
  }
  // Cash short: a till close that counted less than it should have held.
  for (const { p: c } of closes.filter(({ p }) => p.tradingDay === day && p.varianceMinor < 0)) {
    events.push({ eventId: `short:${c.shiftId}`, kind: 'cash_short', at: c.closedAt, branchId: c.storeId ?? c.tillId, actorId: c.cashierId, laneId: c.tillId, valueMinor: -c.varianceMinor, transactionRef: c.shiftId });
  }
  // OB-365: after-hours sign-ins and failed sign-ins, from the till sign-in log the store computers send.
  const signIns = await tillSignInRecords(input.store, tenantId);
  for (const { p: r } of signIns) {
    if (tradingDayIn(r.at, calendar) !== day) continue;
    const branchId = r.storeId ?? r.laneId ?? 'store';
    if (r.kind === 'signed_in') {
      // The engine reads the hour from `at` — so it is the shop's own wall-clock time of the sign-in.
      events.push({ eventId: `sign-in:${r.entryId}`, kind: 'after_hours_login', at: wallClockIn(r.at, calendar.timeZone), branchId, actorId: r.person, ...(r.laneId === null ? {} : { laneId: r.laneId }), valueMinor: 0, transactionRef: r.entryId });
    } else if (r.kind === 'refused' && isFailedSignIn(r.reason)) {
      events.push({ eventId: `failed-sign-in:${r.entryId}`, kind: 'failed_sign_in', at: r.at, branchId, actorId: r.person, ...(r.laneId === null ? {} : { laneId: r.laneId }), valueMinor: 0, transactionRef: r.entryId, ...(LOCKOUT_REASONS.includes(r.reason!) ? { lockedOut: true } : {}) });
    }
  }
  const actsAt = newest(acts);
  const closesAt = newest(closes);
  const signInsAt = newest(signIns);
  return {
    events,
    sources: [
      { kind: 'large_discount', known: true, asAt: actsAt },
      { kind: 'voided_bill', known: true, asAt: actsAt },
      { kind: 'price_override', known: true, asAt: actsAt },
      signInsAt === null ? { kind: 'after_hours_login', known: false, asAt: null, why: NO_SIGN_IN_LOG_YET } : { kind: 'after_hours_login', known: true, asAt: signInsAt },
      { kind: 'cash_short', known: true, asAt: closesAt },
      signInsAt === null ? { kind: 'failed_sign_in', known: false, asAt: null, why: NO_SIGN_IN_LOG_YET } : { kind: 'failed_sign_in', known: true, asAt: signInsAt },
    ],
  };
}

export function ownerExceptionsAdapter(input: Base): OwnerExceptionsDeps {
  const lifecycle = alertLifecycleAdapter({ store: input.store, now: input.now });
  return {
    now: input.now,
    settings: async (t) => (await payloads<ThresholdSetting>(input.store, t, OWNER_REPORTING_STREAMS.thresholds, 'OwnerAlertThresholdSet')).map((x) => x.p),
    recordSetting: (t, s, key) => put(input.store, t, OWNER_REPORTING_STREAMS.thresholds, 'OwnerAlertThresholdSet', `${s.kind}-${key}`, s.setAt, s),
    today: async (t) => tradingDayIn(input.now(), await calendarOf(input)(t)),
    dayBefore: (day) => shiftDate(day, -1),
    exceptions: (t, day) => exceptionEventsOn(input, t, day),
    raisedIds: async (t, day) => new Set((await lifecycle.alerts(t)).map((a) => a.alert.alertId).filter((id) => id.startsWith(`owner-exception:${day}:`))),
    raise: async (t, day, alerts: readonly OwnerAlert[], at, by) => {
      const owners = [...new Set((await effectiveGrants(input.store, t)).filter((g) => g.roleId === OWNER_ROLE_ID).map((g) => g.userId))].sort();
      if (owners.length === 0) return { raised: 0, alreadyRaised: 0, owners: 0 };
      const held = new Set((await lifecycle.alerts(t)).map((a) => a.alert.alertId));
      let raised = 0; let alreadyRaised = 0;
      for (const a of alerts) {
        const alertId = ownerExceptionAlertId(day, a);
        if (held.has(alertId)) { alreadyRaised += 1; continue; }
        const event: AlertLifecycleEvent = {
          alertId, change: 'raised', by, at,
          alert: {
            alertId, component: `Owner alert — ${THRESHOLD_WORDS[a.kind].en.split(':')[0]}`, status: a.severity === 'urgent' ? 'down' : 'degraded',
            ownerUserId: owners[0]!, ownerName: owners[0]!, branchId: a.branchId,
            detail: `${a.headline} (trading day ${day}; ${a.count} record(s): ${a.transactionRefs.join(', ')})`, raisedAt: at, ackDueBy: at,
            ...(owners.length > 1 ? { alsoToUserIds: owners.slice(1) } : {}),
          },
        };
        await lifecycle.recordAlertEvent(t, event, `${alertId}|raised`);
        raised += 1;
      }
      return { raised, alreadyRaised, owners: owners.length };
    },
    ...(input.recordAudit === undefined ? {} : { recordAudit: input.recordAudit }),
  };
}

// ── M29-FR-04: scheduled reports and exports ───────────────────────────────────────────────────────────────────────

/** Call a registered route's handler in-process, as a named person, with company-wide scope (the owner's). */
async function asOwner(routes: () => readonly Route[], method: Route['method'], path: string, ctx: Omit<RequestContext, 'traceId' | 'branchId' | 'scope'>): Promise<{ ok: true; body: unknown } | { ok: false; why: string }> {
  const route = routes().find((r) => r.method === method && r.path === path);
  if (route === undefined) return { ok: false, why: `${method} ${path} is not served here` };
  try {
    const res = await route.handler({ ...ctx, branchId: null, scope: 'all', traceId: `t-scheduled-${Date.now().toString(36)}` });
    return res.status >= 200 && res.status < 300 ? { ok: true, body: res.body } : { ok: false, why: `it answered ${res.status}` };
  } catch (e) {
    if (e instanceof ApiError) return { ok: false, why: e.body.whatHappened };
    return { ok: false, why: e instanceof Error ? e.message : String(e) };
  }
}

export function reportSchedulesAdapter(input: Base): ReportScheduleDeps {
  const producers = producersOf(input);
  const calendar = calendarOf(input);
  const routes = input.routes ?? (() => []);
  return {
    now: input.now,
    schedules: async (t) => (await payloads<ReportSchedule>(input.store, t, OWNER_REPORTING_STREAMS.schedules, 'ReportScheduleSet')).map((x) => x.p),
    recordSchedule: (t, s, key) => put(input.store, t, OWNER_REPORTING_STREAMS.schedules, 'ReportScheduleSet', `${s.scheduleId}-${key}`, s.setAt, s),
    runs: async (t) => (await payloads<ScheduledRun>(input.store, t, OWNER_REPORTING_STREAMS.runs, 'ScheduledReportRun')).map((x) => x.p),
    // One run per schedule per trading day: the key is both, so a pass run twice (or two workers) records it once.
    recordRun: (t, run) => put(input.store, t, OWNER_REPORTING_STREAMS.runs, 'ScheduledReportRun', `${run.scheduleId}-${run.tradingDay}`, run.ranAt, run),
    shopClock: async (t) => {
      const cal = await calendar(t);
      return { today: tradingDayIn(input.now(), cal), wall: shopWallClock(input.now(), cal.timeZone) };
    },
    tradingDayOf: async (t, at) => tradingDayIn(at, await calendar(t)),
    reportKnown: async (_t, id) => REPORTS.some((r) => r.id === id) && PRODUCED_AT_HEAD_OFFICE.includes(id),
    exportKnown: async (t, domain) => {
      const listed = await asOwner(routes, 'GET', '/v1/export', { tenantId: t, userId: 'system:report-schedules', params: {}, query: {}, body: undefined });
      return listed.ok && ((listed.body as { domains?: { domain: string }[] }).domains ?? []).some((d) => d.domain === domain);
    },
    mayRunAs: async (t, userId) => ((await permissionsHeldBy(input.store, t, userId)) ?? []).includes('owner.report.schedule'),
    produceReport: async (t, reportId, day): Promise<RunOutput> => {
      const report = REPORTS.find((r) => r.id === reportId)!;
      try {
        const out = await producers.produce(t, reportId, { tradingDay: day, scope: 'all' });
        const d: Dashboard = dashboard(out.figures, input.now(), out.sources);
        return { ok: true, figures: out.figures, rowCount: out.rows.length, lines: [`${report.name} — ${day}${out.period === undefined ? '' : ` (${out.period.from} to ${out.period.to})`}`, ...out.figures.map((f) => f.detail), `${out.rows.length} row(s) behind these figures. ${d.detail}.`] };
      } catch (e) {
        return { ok: false, why: e instanceof Error ? e.message : String(e) };
      }
    },
    runExport: async (t, domain, day, asUser, key): Promise<RunOutput> => {
      // Through the governed export route itself: the owner's own authority, branch scope and redaction (the export engine),
      // and the export logged on the export ledger under the run's own key — exactly as an export he took by hand.
      const r = await asOwner(routes, 'POST', '/v1/export/:domain', { tenantId: t, userId: asUser, params: { domain }, query: {}, body: { from: day, to: day }, idempotencyKey: key });
      if (!r.ok) return { ok: false, why: r.why };
      const body = r.body as { csv: string; schema: unknown; audit: { rowCount: number; redactedColumns: readonly string[] } };
      return { ok: true, rowCount: body.audit.rowCount, csv: body.csv, schema: body.schema, lines: [`Export ${domain} — ${day}: ${body.audit.rowCount} row(s)${body.audit.redactedColumns.length === 0 ? '' : `, ${body.audit.redactedColumns.join(', ')} redacted`}. The file is kept with this run.`] };
    },
    ...(input.outbox === undefined ? {} : { outbox: input.outbox }),
    ...(input.sendingOn === true ? { sendingOn: true } : {}),
  };
}

// ── the surface and the worker's hook ───────────────────────────────────────────────────────────────────────────────

const based = (raw: OwnerReportingInput): Base => ({ ...raw, store: raw.store ?? new InMemoryEventStore() });

export function ownerReportingSurface(surface: Route[], raw: OwnerReportingInput): void {
  const input: Base = { ...based(raw), routes: raw.routes ?? (() => surface) };
  const producers = producersOf(input);
  const calendar = calendarOf(input);

  // M29-FR-01: the dashboard gains every domain's block, in the reader's scope.
  replaceRoute(surface, 'GET', '/v1/reports/dashboard', (base) => async (ctx) => {
    const scope = narrowScope(ctx);
    const kpis = await dashboardKpis({ store: input.store, now: input.now, produce: producers.produce, calendar }, ctx.tenantId, scope);
    if (scope === 'all') {
      const res = await base.handler(ctx);
      return { status: res.status, body: { ...(res.body as Dashboard), scope, kpis } };
    }
    // A branch-limited reader: the headline is their own branches' sales (the sales block), never the whole shop's.
    const sales = kpis.find((k) => k.domain === 'sales')!;
    return { status: 200, body: { ...dashboard(sales.figures, input.now(), sales.sources), scope, kpis } };
  });

  // M28-FR-04: the waste report gains energy, scrap proceeds and its drill-through.
  const waste = wasteAdapter({ store: input.store, now: input.now });
  const scrap = scrapAdapter({ store: input.store, now: input.now });
  const facilities = facilitiesAssetsAdapter({ store: input.store, now: input.now });
  replaceRoute(surface, 'GET', '/v1/waste/report', (base) => async (ctx) => {
    await base.handler(ctx); // the base validates the query and refuses another branch by name (PA-01-r1)
    const branchId = ctx.query['branchId']!; const from = ctx.query['from']!; const to = ctx.query['to']!;
    const inWindow = (at: string): boolean => at >= from && at <= `${to}T23:59:59Z`;
    const [records, cov, readings, scrapSales] = await Promise.all([waste.records(ctx.tenantId), waste.coverage(ctx.tenantId), facilities.energyReadings(ctx.tenantId), scrap.scrapSales(ctx.tenantId)]);
    const energy = reportEnergy({ branchId, readings, from, to });
    const branchReadings = readings.filter((r) => r.branchId === branchId && r.onDate >= from && r.onDate <= to);
    const branchScrap = scrapSales.filter((s) => s.branchId === branchId && inWindow(s.at));
    const report = buildSustainabilityReport({
      branchId, from, to, waste: records, coverage: { expected: cov.expected }, departmentNames: cov.departmentNames,
      ...(branchReadings.length === 0 ? {} : { energyKilowattHours: energy.kilowattHours, energyCostMinor: energy.costMinor }),
      ...(branchScrap.length === 0 ? {} : { scrapProceedsMinor: branchScrap.reduce((t, s) => t + s.proceedsMinor, 0) }),
    });
    const behind: WasteRecord[] = records.filter((w) => w.branchId === branchId && inWindow(w.at)).sort((a, b) => a.at.localeCompare(b.at));
    return {
      status: 200,
      body: {
        ...report,
        // P-08: no readings is "not known", never 0 kWh; no scrap sold is said, never ₹0 earned.
        energy: branchReadings.length === 0
          ? { known: false, detail: energy.detail }
          : { known: true, kilowattHours: energy.kilowattHours, costMinor: energy.costMinor, estimatedShareBps: energy.estimatedShareBps, readings: branchReadings.length, detail: energy.detail },
        scrap: branchScrap.length === 0
          ? { known: false, detail: 'no scrap sale is recorded for this branch in this window — nothing sold, or nothing recorded' }
          : { known: true, sales: branchScrap.length, proceedsMinor: branchScrap.reduce((t, s) => t + s.proceedsMinor, 0), grams: branchScrap.reduce((t, s) => t + s.grams, 0), offBooks: branchScrap.filter((s) => s.postedToFinance !== true).length },
        drill: {
          waste: behind.map((w) => ({ wasteId: w.wasteId, at: w.at, departmentId: w.departmentId, productId: w.productId, source: w.source, valueMinor: w.valueMinor, disposal: w.disposal, ...(w.grams === undefined ? {} : { grams: w.grams }) })),
          scrap: branchScrap.map((s) => ({ scrapId: s.scrapId, at: s.at, category: s.category, grams: s.grams, proceedsMinor: s.proceedsMinor, postedToFinance: s.postedToFinance === true })),
          energy: branchReadings.map((r) => ({ onDate: r.onDate, kilowattHours: r.kilowattHours, costMinor: r.costMinor, source: r.source, ...(r.assetId === undefined ? {} : { assetId: r.assetId }) })),
        },
      },
    };
  });

  surface.push(...ownerExceptionRoutes(ownerExceptionsAdapter(input)));
  surface.push(...reportScheduleRoutes(reportSchedulesAdapter(input)));
}

/**
 * The ops-alert worker's hook (`alsoEachPass`, ops-alert-sweeps.ts): for one shop, raise the owner's exception alerts
 * (yesterday and today) and prepare every scheduled report and export that is due. Answers how many alerts were raised
 * plus how many runs were prepared.
 */
export function ownerReportingSweep(raw: OwnerReportingInput): (tenantId: string, at: string) => Promise<number> {
  const input = based(raw);
  const exceptions = ownerExceptionsAdapter(input);
  const schedules = reportSchedulesAdapter(input);
  return async (tenantId, at) => {
    const raised = (await sweepOwnerExceptions(exceptions, tenantId, at)).raised;
    const prepared = (await runSchedulesPass(schedules, tenantId)).prepared;
    return raised + prepared;
  };
}
