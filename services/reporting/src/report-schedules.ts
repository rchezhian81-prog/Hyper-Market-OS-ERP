// API-10 Scheduled reports and exports (OB-288 P2 · M29-FR-04 · M30-FR-02 · NFR-12 · P-08).
//
// Only the daily brief could be scheduled. Here the owner schedules ANY catalogue report, or any governed export, to be
// prepared every day at a set time of the SHOP's clock — and it is prepared with nobody pressing anything, on the
// ops-alert worker's timer (or the owner's "run now"):
//
//   • OWNER-SCOPED. Only the owner sets one (`owner.report.schedule`), and each run is made AS that owner: a report in his
//     scope, an export through the export engine under his own authority, with the export logged on the export ledger
//     exactly like one he took by hand. A schedule whose owner no longer holds the authority is refused at run time, by
//     name — it never runs as anybody else.
//   • IDEMPOTENT. One run per schedule per trading day, keyed on both: a pass run twice prepares once.
//   • A MISSED RUN IS CARRIED, not skipped (`briefsDue`, the brief's own engine): a day the worker did not reach is
//     prepared late and labelled late, up to a week back.
//   • EVERY RUN IS KEPT (append-only, hard rule #6): its figures with their freshness, or the export's file with its
//     schema, readable later on the owner's screen. A report that could not be produced is a run that says why — never an
//     empty file.
//   • SENDING IS SWITCHED OFF (OB-222): no message provider is chosen, so a prepared run is said to be "prepared, not
//     sent". With the PA-08 queue and a sending link (a test stand-in today), the owner is told on the queue.
//
// No AI is involved anywhere (AI-NFR-04); nothing here commits a business action (hard rule #5).

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import { briefsDue } from '../../../packages/owner-control/src/index';
import type { NotificationQueueEvent } from '../../customer/src/notification-queue';
import type { Figure } from './index';

export type ScheduleKind = 'report' | 'export';

/** One fact about a schedule (append-only; the latest per id applies). */
export interface ReportSchedule {
  readonly scheduleId: string;
  readonly kind: ScheduleKind;
  /** The catalogue report id, or the export domain. */
  readonly target: string;
  /** The shop's local hour and minute it is prepared at. */
  readonly dueAt: readonly [number, number];
  readonly language: 'en' | 'ta';
  /** The owner who set it — every run is made as them. */
  readonly ownerUserId: string;
  readonly status: 'active' | 'stopped';
  readonly setAt: string;
  /** When the schedule first began — the first trading day a run is owed. */
  readonly since: string;
  readonly reason?: string;
}

/** What one run prepared (append-only, one per schedule per trading day). */
export interface ScheduledRun {
  readonly scheduleId: string;
  readonly kind: ScheduleKind;
  readonly target: string;
  readonly tradingDay: string;
  readonly reason: 'scheduled' | 'missed_catch_up';
  readonly ranAt: string;
  readonly ranAs: string;
  readonly outcome: 'prepared' | 'refused';
  /** Plain lines for the owner's screen and, when sending is on, the message. */
  readonly lines: readonly string[];
  /** A report run: its figures, each with its own freshness. */
  readonly figures?: readonly Figure[];
  readonly rowCount?: number;
  /** An export run: the file and its schema (the export engine's own output). */
  readonly csv?: string;
  readonly schema?: unknown;
  readonly sending: 'switched_off' | 'queued';
  readonly detail: string;
}

/** What producing a report or an export for a run hands back — or why it could not. */
export type RunOutput =
  | { readonly ok: true; readonly figures?: readonly Figure[]; readonly rowCount: number; readonly csv?: string; readonly schema?: unknown; readonly lines: readonly string[] }
  | { readonly ok: false; readonly why: string };

export interface ReportScheduleDeps {
  readonly now: () => string;
  readonly schedules: (tenantId: string) => Promise<readonly ReportSchedule[]>;
  readonly recordSchedule: (tenantId: string, s: ReportSchedule, key: string) => Promise<void>;
  readonly runs: (tenantId: string) => Promise<readonly ScheduledRun[]>;
  readonly recordRun: (tenantId: string, run: ScheduledRun) => Promise<void>;
  /** The shop's trading day and wall clock now (YYYY-MM-DD and YYYY-MM-DDTHH:MM, in its own zone). */
  readonly shopClock: (tenantId: string) => Promise<{ readonly today: string; readonly wall: string }>;
  /** The shop's trading day an instant falls on. */
  readonly tradingDayOf: (tenantId: string, at: string) => Promise<string>;
  /** Is this a report head office can produce / an export domain it offers? (A schedule for neither is refused.) */
  readonly reportKnown: (tenantId: string, reportId: string) => Promise<boolean>;
  readonly exportKnown: (tenantId: string, domain: string) => Promise<boolean>;
  /** Does this person (still) hold the authority to have scheduled reports made as them? */
  readonly mayRunAs: (tenantId: string, userId: string) => Promise<boolean>;
  readonly produceReport: (tenantId: string, reportId: string, tradingDay: string, asUser: string) => Promise<RunOutput>;
  readonly runExport: (tenantId: string, domain: string, tradingDay: string, asUser: string, key: string) => Promise<RunOutput>;
  /** The PA-08 queue and the sending link (absent in production: sending is switched off, OB-222). */
  readonly outbox?: { readonly enqueue: (tenantId: string, event: NotificationQueueEvent, key: string) => Promise<void> | void };
  readonly sendingOn?: boolean;
}

export const SCHEDULE_SENDING_OFF = 'Prepared, NOT sent: sending is switched off (OB-222) — no message provider is chosen. The owner reads it on the schedules screen.';

/** The latest fact per schedule id. */
export function currentSchedules(facts: readonly ReportSchedule[]): readonly ReportSchedule[] {
  const by = new Map<string, ReportSchedule>();
  for (const f of facts) by.set(f.scheduleId, f);
  return [...by.values()].sort((a, b) => a.scheduleId.localeCompare(b.scheduleId));
}

const daysBetween = (from: string, to: string): string[] => {
  const out: string[] = [];
  for (let d = Date.parse(`${from}T00:00:00Z`); d <= Date.parse(`${to}T00:00:00Z`); d += 86_400_000) out.push(new Date(d).toISOString().slice(0, 10));
  return out;
};

/** ONE PASS for one shop: every active schedule's due runs (missed days carried), each prepared once. */
export async function runSchedulesPass(deps: ReportScheduleDeps, tenantId: string): Promise<{ readonly prepared: number; readonly runs: readonly ScheduledRun[] }> {
  const { today, wall } = await deps.shopClock(tenantId);
  const weekAgo = new Date(Date.parse(`${today}T00:00:00Z`) - 6 * 86_400_000).toISOString().slice(0, 10);
  const done = await deps.runs(tenantId);
  const made: ScheduledRun[] = [];
  for (const s of currentSchedules(await deps.schedules(tenantId))) {
    if (s.status !== 'active') continue;
    const first = await deps.tradingDayOf(tenantId, s.since);
    const ranDays = done.filter((r) => r.scheduleId === s.scheduleId).map((r) => r.tradingDay);
    const due = briefsDue({ schedule: { scheduleId: s.scheduleId, dueAt: s.dueAt, sentDays: ranDays }, tradingDays: daysBetween(first > weekAgo ? first : weekAgo, today), now: `${today}${wall.slice(10)}:00Z` });
    for (const d of due) {
      const ranAt = deps.now();
      const base = { scheduleId: s.scheduleId, kind: s.kind, target: s.target, tradingDay: d.tradingDay, reason: d.reason, ranAt, ranAs: s.ownerUserId };
      let out: RunOutput;
      if (!(await deps.mayRunAs(tenantId, s.ownerUserId))) {
        out = { ok: false, why: `${s.ownerUserId}, who set this schedule, no longer holds the authority to have reports made as them — it never runs as anybody else` };
      } else {
        out = s.kind === 'report'
          ? await deps.produceReport(tenantId, s.target, d.tradingDay, s.ownerUserId)
          : await deps.runExport(tenantId, s.target, d.tradingDay, s.ownerUserId, `scheduled-${s.scheduleId}-${d.tradingDay}`);
      }
      const late = d.reason === 'missed_catch_up' ? [`LATE — the ${s.kind} for ${d.tradingDay}, which was not prepared on time.`] : [];
      const lines = out.ok ? [...late, ...out.lines] : [...late, `${s.kind === 'report' ? 'Report' : 'Export'} ${s.target} for ${d.tradingDay} could not be prepared: ${out.why}.`];
      const queue = deps.sendingOn === true && deps.outbox !== undefined;
      const run: ScheduledRun = {
        ...base, outcome: out.ok ? 'prepared' : 'refused', lines,
        ...(out.ok && out.figures !== undefined ? { figures: out.figures } : {}),
        ...(out.ok ? { rowCount: out.rowCount } : {}),
        ...(out.ok && out.csv !== undefined ? { csv: out.csv, schema: out.schema } : {}),
        sending: queue ? 'queued' : 'switched_off',
        detail: queue ? `put on the queue as report-${s.scheduleId}-${d.tradingDay}` : SCHEDULE_SENDING_OFF,
      };
      await deps.recordRun(tenantId, run);
      if (queue) {
        const id = `report-${s.scheduleId}-${d.tradingDay}`;
        await deps.outbox!.enqueue(tenantId, {
          id, change: 'enqueued', by: 'system:report-schedules', at: ranAt, channel: 'whatsapp',
          intent: { customerId: s.ownerUserId, purpose: 'transactional', templateId: 'owner-scheduled-report', templateVersion: 1, text: lines.join('\n'), composedBy: 'system:owner-brief' /* the owner's own digest, composed by head office from governed figures — like the brief */ },
        }, `notif-enqueue-${id}`);
      }
      made.push(run);
    }
  }
  return { prepared: made.length, runs: made };
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/** A run as a list shows it — without the file (read one run for that). */
const brief = (r: ScheduledRun) => {
  const rest: { -readonly [K in keyof ScheduledRun]?: ScheduledRun[K] } = { ...r };
  delete rest.csv; delete rest.schema;
  return { ...rest, hasFile: r.csv !== undefined };
};

export function reportScheduleRoutes(deps: ReportScheduleDeps): readonly Route[] {
  return [
    {
      // RUN NOW (declared BEFORE `:scheduleId`, so "run" is never read as a schedule id) — the same pass the worker runs on its timer. Idempotent per schedule and trading day.
      api: 'API-10', method: 'POST', path: '/v1/reporting/report-schedules/run',
      permission: 'owner.report.schedule', idempotent: true,
      handler: async (ctx) => {
        const r = await runSchedulesPass(deps, ctx.tenantId);
        return { status: 200, body: { prepared: r.prepared, runs: r.runs.map(brief), asAt: deps.now() } };
      },
    },
    {
      // SET a schedule. Body: { kind: report|export, target, dueAt: [hour, minute], language? }. The owner's alone.
      api: 'API-10', method: 'POST', path: '/v1/reporting/report-schedules/:scheduleId',
      permission: 'owner.report.schedule', idempotent: true,
      handler: async (ctx) => {
        const scheduleId = (ctx.params['scheduleId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const kind = b['kind'];
        const due = b['dueAt'];
        const dueOk = Array.isArray(due) && due.length === 2 && Number.isInteger(due[0]) && Number.isInteger(due[1]) && (due[0] as number) >= 0 && (due[0] as number) <= 23 && (due[1] as number) >= 0 && (due[1] as number) <= 59;
        if (scheduleId === '' || (kind !== 'report' && kind !== 'export') || !isStr(b['target']) || !dueOk || (b['language'] !== undefined && b['language'] !== 'en' && b['language'] !== 'ta')) {
          throw apiError(400, { code: 'not_readable_as_a_schedule', whatHappened: 'A schedule needs { kind: "report" or "export", target (the report id or export domain), dueAt: [hour 0–23, minute 0–59] } and an optional language ("en" or "ta").', wasItSaved: 'not_saved', nextSafeAction: 'Correct it and send again. Nothing was saved.' });
        }
        const target = (b['target'] as string).trim();
        const known = kind === 'report' ? await deps.reportKnown(ctx.tenantId, target) : await deps.exportKnown(ctx.tenantId, target);
        if (!known) {
          throw apiError(422, { code: kind === 'report' ? 'report_not_produced_here' : 'export_domain_not_offered', whatHappened: kind === 'report' ? `Head office cannot produce a report called "${target}", so a schedule for it would only ever say so.` : `There is no export of "${target}" here.`, wasItSaved: 'not_saved', nextSafeAction: kind === 'report' ? 'Pick a report the catalogue says can be run.' : 'Pick a domain from GET /v1/export.' });
        }
        const at = deps.now();
        const prior = currentSchedules(await deps.schedules(ctx.tenantId)).find((s) => s.scheduleId === scheduleId);
        const s: ReportSchedule = {
          scheduleId, kind, target, dueAt: [due[0] as number, due[1] as number], language: b['language'] === 'ta' ? 'ta' : 'en',
          ownerUserId: ctx.userId, status: 'active', setAt: at, since: prior?.status === 'active' ? prior.since : at,
        };
        await deps.recordSchedule(ctx.tenantId, s, ctx.idempotencyKey ?? `${scheduleId}-${at}`);
        return { status: prior === undefined ? 201 : 200, body: { schedule: s } };
      },
    },
    {
      // STOP a schedule (kept, stopped — never deleted). Body: { reason }.
      api: 'API-10', method: 'POST', path: '/v1/reporting/report-schedules/:scheduleId/stop',
      permission: 'owner.report.schedule', idempotent: true,
      handler: async (ctx) => {
        const scheduleId = (ctx.params['scheduleId'] ?? '').trim();
        const prior = currentSchedules(await deps.schedules(ctx.tenantId)).find((s) => s.scheduleId === scheduleId);
        if (prior === undefined) throw apiError(404, { code: 'no_such_schedule', whatHappened: `There is no schedule "${scheduleId}".`, wasItSaved: 'not_saved', nextSafeAction: 'Check the id against GET /v1/reporting/report-schedules.' });
        const reason = ((ctx.body ?? {}) as Record<string, unknown>)['reason'];
        if (!isStr(reason)) throw apiError(400, { code: 'stop_needs_a_reason', whatHappened: 'Stopping a schedule says why.', wasItSaved: 'not_saved', nextSafeAction: 'Send { reason }. Nothing was changed.' });
        if (prior.status === 'stopped') return { status: 200, body: { schedule: prior, alreadyStopped: true } };
        const s: ReportSchedule = { ...prior, status: 'stopped', setAt: deps.now(), reason: reason.trim() };
        await deps.recordSchedule(ctx.tenantId, s, ctx.idempotencyKey ?? `${scheduleId}-stop-${s.setAt}`);
        return { status: 200, body: { schedule: s } };
      },
    },
    {
      // The schedules and their latest runs (without the files).
      api: 'API-10', method: 'GET', path: '/v1/reporting/report-schedules',
      permission: 'owner.kpi.read',
      handler: async (ctx) => {
        const runs = await deps.runs(ctx.tenantId);
        const schedules = currentSchedules(await deps.schedules(ctx.tenantId)).map((s) => {
          const mine = runs.filter((r) => r.scheduleId === s.scheduleId).sort((a, b) => b.tradingDay.localeCompare(a.tradingDay));
          return { schedule: s, runs: mine.length, lastRun: mine[0] === undefined ? null : brief(mine[0]) };
        });
        return { status: 200, body: { schedules, sending: deps.sendingOn === true ? 'on' : 'switched_off', asAt: deps.now() } };
      },
    },
    {
      // Every run of one schedule (newest first), or one day's run in full with its file (?day=YYYY-MM-DD).
      api: 'API-10', method: 'GET', path: '/v1/reporting/report-schedules/:scheduleId/runs',
      permission: 'owner.kpi.read',
      handler: async (ctx) => {
        const scheduleId = ctx.params['scheduleId'] ?? '';
        const mine = (await deps.runs(ctx.tenantId)).filter((r) => r.scheduleId === scheduleId).sort((a, b) => b.tradingDay.localeCompare(a.tradingDay));
        const day = ctx.query['day'];
        if (day !== undefined) {
          const one = mine.find((r) => r.tradingDay === day);
          if (one === undefined) throw apiError(404, { code: 'no_such_run', whatHappened: `Schedule "${scheduleId}" has no run for ${day}.`, wasItSaved: 'not_saved', nextSafeAction: 'Pick a day from the list of runs.' });
          return { status: 200, body: { run: one } };
        }
        return { status: 200, body: { runs: mine.map(brief), asAt: deps.now() } };
      },
    },
  ];
}
