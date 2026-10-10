// API-10 Scheduled daily brief (M29-FR-04 / D13 / AI-NFR-04 / NFR-08) — the brief that sends itself, on the
// live API over the tested `@sre/owner-control` engine.
//
// The roadmap's acceptance is concrete: "the daily brief arrives on the phone at the set time for three days
// running without anyone sending it" AND "if AI is off, the numbers still arrive." The engine is built the
// right way round for that — the NUMBERS are the brief, the narrative is decoration on top — so
// `buildScheduledBrief` always returns a complete, sendable brief with no language model involved; a missing,
// low-confidence, wrong-language or evidence-free narrative is dropped with a line saying so (never blocks).
//
// This wires the durable half — the schedule state that lets a brief go out unattended, and a MISSED send
// carried rather than skipped (a brief that silently does not arrive is indistinguishable from a quiet day):
//   • SET the schedule (the local time it is due, the language, when to warn the numbers are stale).
//   • DUE — which briefs are due now, including any missed day, labelled late (idempotent: a day already sent
//     is never returned again).
//   • SENT — record a send, append-only; the same day sent twice is one send.
//   • BUILD — compose a sendable brief from the day's figures (the transport that delivers it to the phone is
//     the deployment step, like any other outbound channel).
//
// Configuring the schedule and recording a send are gated `owner.brief.manage`; reading the schedule, the due
// list and building a brief read `owner.kpi.read` (the brief IS the owner's KPI digest). No AI is required for
// any of it (AI-NFR-04).

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import { tradingDayIn, type TradingCalendar } from '../../../packages/calendar/src/index';
import type { NotificationTransport } from '../../../packages/notifications/src/index';
import type { NotificationQueueEvent } from '../../customer/src/notification-queue';
import {
  buildScheduledBrief, briefsDue, type BriefFigures, type AttentionLine, type Narrative, type BriefLanguage,
} from '../../../packages/owner-control/src/index';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const LANGUAGES = ['en', 'ta'] as const;
const CONFIDENCES = ['low', 'medium', 'high'] as const;

/** The schedule as stored — the engine's `ScheduleState` plus the per-tenant language and stale threshold. */
export interface StoredSchedule {
  readonly scheduleId: string;
  readonly dueAt: readonly [number, number];
  readonly sentDays: readonly string[];
  readonly language?: BriefLanguage;
  readonly staleAfterMinutes?: number;
  /** When the schedule was first set — the first day a brief is owed. */
  readonly since?: string;
}

/** What one scheduled run did for one day (EA-07). */
export interface BriefRunLine {
  readonly tradingDay: string;
  readonly reason: 'scheduled' | 'missed_catch_up';
  readonly outcome: 'sent' | 'composed_not_sent' | 'send_failed_will_retry'
    /** EA-07 outbox: put on the queue now / still on the queue / the queue delivered it and the day is acknowledged. */
    | 'queued' | 'queued_waiting' | 'acknowledged';
  readonly detail: string;
  readonly lines: readonly string[];
  readonly deterministic: boolean;
}

export interface ScheduledBriefDeps {
  readonly schedule: (tenantId: string) => Promise<StoredSchedule | undefined> | StoredSchedule | undefined;
  readonly setSchedule: (tenantId: string, config: { dueAt: readonly [number, number]; language?: BriefLanguage; staleAfterMinutes?: number }, by: string, key: string) => Promise<void> | void;
  readonly recordSent: (tenantId: string, tradingDay: string, by: string, key: string) => Promise<void> | void;
  readonly now: () => string;
  /** The shop's trading calendar (zone + cut-off) — "due at 08:00" is the SHOP's 08:00 (EA-07). */
  readonly calendar?: (tenantId: string) => Promise<TradingCalendar> | TradingCalendar;
  /** The day's figures from head office's governed producers — the numbers ARE the brief (EA-07). */
  readonly dayFigures?: (tenantId: string, tradingDay: string) => Promise<BriefFigures> | BriefFigures;
  /** Who the brief goes to: the shop's owner. */
  readonly recipient?: (tenantId: string) => Promise<string | undefined> | string | undefined;
  /** The phone transport. Absent until a real provider is certified (the SMS provider is R4, OB-29). */
  readonly transport?: NotificationTransport;
  /**
   * EA-07 OUTBOX: the PA-08 notification queue. When wired, a due brief is ENQUEUED (durable, retried, dead-lettered
   * visibly by the queue's own sender) instead of handed to a transport here, and the day is acknowledged as sent only
   * when the queue says the message was delivered.
   */
  readonly outbox?: {
    readonly enqueue: (tenantId: string, event: NotificationQueueEvent, key: string) => Promise<void> | void;
    readonly item: (tenantId: string, id: string) => Promise<{ readonly state: string; readonly reason: string | null } | undefined>;
  };
}

/** The shop's wall-clock "now" as YYYY-MM-DDTHH:MM, in its own zone — what a local due time is measured against. */
export function shopWallClock(nowIso: string, timeZone: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(nowIso)).map((p) => [p.type, p.value]));
  return `${parts['year']}-${parts['month']}-${parts['day']}T${parts['hour']}:${parts['minute']}`;
}

/** Every calendar day from `from` to `to` inclusive (YYYY-MM-DD), oldest first. */
function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = Date.parse(`${from}T00:00:00Z`); d <= Date.parse(`${to}T00:00:00Z`); d += 86_400_000) out.push(new Date(d).toISOString().slice(0, 10));
  return out;
}

function readDueAt(v: unknown): readonly [number, number] | undefined {
  if (!Array.isArray(v) || v.length !== 2 || !isInt(v[0]) || !isInt(v[1])) return undefined;
  const [h, m] = v as [number, number];
  if (h < 0 || h > 23 || m < 0 || m > 59) return undefined;
  return [h, m];
}

function readFigures(v: unknown): BriefFigures | undefined {
  if (!isObj(v) || !isStr(v['tradingDay'])
    || !isInt(v['netSalesMinor']) || !isInt(v['marginMinor']) || !isInt(v['marginBps'])
    || !isInt(v['basketCount']) || !isInt(v['cashBankedMinor']) || !isInt(v['dataAgeMinutes'])) {
    return undefined;
  }
  return {
    tradingDay: v['tradingDay'] as string, netSalesMinor: v['netSalesMinor'] as number, marginMinor: v['marginMinor'] as number,
    marginBps: v['marginBps'] as number, basketCount: v['basketCount'] as number, cashBankedMinor: v['cashBankedMinor'] as number,
    dataAgeMinutes: v['dataAgeMinutes'] as number,
  };
}

function readAttention(v: unknown): readonly AttentionLine[] | undefined {
  if (v === undefined) return [];
  if (!Array.isArray(v)) return undefined;
  const out: AttentionLine[] = [];
  for (const item of v) {
    if (!isObj(item) || !isStr(item['headline']) || !isInt(item['valueMinor']) || !isStr(item['ref'])) return undefined;
    out.push({ headline: item['headline'] as string, valueMinor: item['valueMinor'] as number, ref: item['ref'] as string });
  }
  return out;
}

function readNarrative(v: unknown): Narrative | undefined {
  if (!isObj(v)) return undefined;
  if (v['text'] !== undefined && typeof v['text'] !== 'string') return undefined;
  if (v['language'] !== undefined && !(LANGUAGES as readonly string[]).includes(v['language'] as string)) return undefined;
  if (v['confidence'] !== undefined && !(CONFIDENCES as readonly string[]).includes(v['confidence'] as string)) return undefined;
  if (v['evidenceRefs'] !== undefined && !(Array.isArray(v['evidenceRefs']) && v['evidenceRefs'].every((r) => typeof r === 'string'))) return undefined;
  return v as Narrative;
}

const noSchedule = () => apiError(404, {
  code: 'no_brief_schedule',
  whatHappened: 'This tenant has no daily-brief schedule yet.',
  wasItSaved: 'not_saved',
  nextSafeAction: 'Set one with POST /v1/reporting/brief-schedule (a due time).',
});

/**
 * ONE PASS of the brief scheduler for one shop (EA-07) — what the run route and the in-process worker both call. Which
 * briefs are due by the SHOP's clock (missed days carried, labelled late); each composed from head office's governed
 * figures with NO AI. With the OUTBOX wired, a due day goes onto the PA-08 queue once (`brief-<day>`) and is acknowledged
 * as sent only when the queue delivered it; a dead-lettered one is queued again under a new attempt id and said so.
 * Without it, the older direct transport path stands (acknowledged only when the transport took it).
 */
export async function runBriefPass(deps: ScheduledBriefDeps, tenantId: string, actor: string): Promise<{ ran: BriefRunLine[]; shopClock: string; today: string; asAt: string }> {
  const s = await deps.schedule(tenantId);
  if (s === undefined) throw noSchedule();
  if (deps.calendar === undefined || deps.dayFigures === undefined) {
    throw apiError(503, { code: 'brief_producers_not_wired', whatHappened: 'Head office cannot work out the day\'s figures here, so no brief was composed.', wasItSaved: 'not_saved', nextSafeAction: 'Run the brief on the full head-office service.' });
  }
  const now = deps.now();
  const calendar = await deps.calendar(tenantId);
  const today = tradingDayIn(now, calendar);
  const wall = shopWallClock(now, calendar.timeZone);
  const firstDay = s.since === undefined ? today : tradingDayIn(s.since, calendar);
  // At most a week back: a brief older than that is history, not a brief.
  const weekAgo = new Date(Date.parse(`${today}T00:00:00Z`) - 6 * 86_400_000).toISOString().slice(0, 10);
  const tradingDays = daysBetween(firstDay > weekAgo ? firstDay : weekAgo, today);
  const due = briefsDue({ schedule: { scheduleId: s.scheduleId, dueAt: s.dueAt, sentDays: s.sentDays }, tradingDays, now: `${today}${wall.slice(10)}:00Z` });
  const recipient = await deps.recipient?.(tenantId);
  const ran: BriefRunLine[] = [];
  for (const d of due) {
    const brief = buildScheduledBrief({
      figures: await deps.dayFigures(tenantId, d.tradingDay), attention: [],
      ...(s.language === undefined ? {} : { language: s.language }),
      ...(s.staleAfterMinutes === undefined ? {} : { staleAfterMinutes: s.staleAfterMinutes }),
    });
    const lines = d.reason === 'missed_catch_up' ? [`LATE — the brief for ${d.tradingDay}, which did not go out on time.`, ...brief.lines] : [...brief.lines];
    const base = { tradingDay: d.tradingDay, reason: d.reason, lines, deterministic: brief.deterministic };
    if (deps.outbox !== undefined && recipient !== undefined) {
      // The outbox: find this day's live attempt on the queue; acknowledge on delivery; queue again after a dead letter.
      let attempt = 1;
      let item = await deps.outbox.item(tenantId, briefMessageId(d.tradingDay, attempt));
      while (item?.state === 'dead_letter' && attempt < 20) { attempt += 1; item = await deps.outbox.item(tenantId, briefMessageId(d.tradingDay, attempt)); }
      if (item?.state === 'delivered') {
        await deps.recordSent(tenantId, d.tradingDay, actor, `sent-${d.tradingDay}`);
        ran.push({ ...base, outcome: 'acknowledged', detail: `the queue delivered ${briefMessageId(d.tradingDay, attempt)} — acknowledged as sent` });
        continue;
      }
      if (item !== undefined && item.state !== 'dead_letter') {
        ran.push({ ...base, outcome: 'queued_waiting', detail: `${briefMessageId(d.tradingDay, attempt)} is ${item.state} on the queue${item.reason === null ? '' : ` (${item.reason})`} — not yet sent` });
        continue;
      }
      const id = briefMessageId(d.tradingDay, attempt);
      await deps.outbox.enqueue(tenantId, {
        id, change: 'enqueued', by: actor, at: now, channel: 'whatsapp',
        // The owner's own business digest rides the transactional purpose: it is never marketing (no promotion in it).
        intent: { customerId: recipient, purpose: 'transactional', templateId: 'owner-daily-brief', templateVersion: 1, text: lines.join('\n') },
      }, `notif-enqueue-${id}`);
      ran.push({ ...base, outcome: 'queued', detail: attempt === 1 ? `put on the queue as ${id}` : `the earlier attempt was dead-lettered — queued again as ${id}` });
      continue;
    }
    if (deps.transport === undefined || recipient === undefined) {
      ran.push({ ...base, outcome: 'composed_not_sent', detail: deps.transport === undefined ? 'no phone transport is configured yet (the SMS provider is release R4) — composed, NOT sent, still due' : 'the shop has no owner on record to send it to — composed, NOT sent' });
      continue;
    }
    const sent = await deps.transport.send({ messageId: `brief-${tenantId}-${d.tradingDay}`, channel: 'whatsapp', customerId: recipient, text: lines.join('\n') });
    if (sent.ok) {
      await deps.recordSent(tenantId, d.tradingDay, actor, `sent-${d.tradingDay}`);
      ran.push({ ...base, outcome: 'sent', detail: `${deps.transport.name} took it (${sent.providerRef})` });
    } else {
      ran.push({ ...base, outcome: 'send_failed_will_retry', detail: `${sent.reason} — still due; the next run retries it` });
    }
  }
  return { ran, shopClock: wall, today, asAt: now };
}

/** The queue id of one day's brief, per attempt — deterministic, so a pass run twice queues nothing twice. */
export const briefMessageId = (tradingDay: string, attempt: number): string => (attempt === 1 ? `brief-${tradingDay}` : `brief-${tradingDay}-r${attempt}`);

export function scheduledBriefRoutes(deps: ScheduledBriefDeps): readonly Route[] {
  return [
    {
      // SET the schedule — the local time the brief is due, the language, the stale threshold.
      api: 'API-10', method: 'POST', path: '/v1/reporting/brief-schedule',
      permission: 'owner.brief.manage', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const dueAt = readDueAt(b['dueAt']);
        if (dueAt === undefined) {
          throw apiError(400, { code: 'schedule_needs_a_due_time', whatHappened: 'A brief schedule needs { dueAt: [hour, minute] } in 24-hour local time.', wasItSaved: 'not_saved', nextSafeAction: 'Send the hour (0–23) and minute (0–59) the brief should go out.' });
        }
        if (b['language'] !== undefined && !(LANGUAGES as readonly string[]).includes(b['language'] as string)) {
          throw apiError(400, { code: 'language_not_supported', whatHappened: 'language must be "en" or "ta".', wasItSaved: 'not_saved', nextSafeAction: 'Send the brief language, or leave it out for English.' });
        }
        if (b['staleAfterMinutes'] !== undefined && (!isInt(b['staleAfterMinutes']) || (b['staleAfterMinutes'] as number) <= 0)) {
          throw apiError(400, { code: 'stale_threshold_not_a_number', whatHappened: 'staleAfterMinutes must be a positive whole number when given.', wasItSaved: 'not_saved', nextSafeAction: 'Send how many minutes old the data may be before the brief warns it is not live.' });
        }
        await deps.setSchedule(ctx.tenantId, {
          dueAt,
          ...(isStr(b['language']) ? { language: b['language'] as BriefLanguage } : {}),
          ...(isInt(b['staleAfterMinutes']) ? { staleAfterMinutes: b['staleAfterMinutes'] as number } : {}),
        }, ctx.userId, ctx.idempotencyKey ?? `sched-${deps.now()}`);
        return { status: 200, body: { dueAt, at: deps.now() } };
      },
    },
    {
      // READ the schedule (its due time, language and the days already sent).
      api: 'API-10', method: 'GET', path: '/v1/reporting/brief-schedule',
      permission: 'owner.kpi.read',
      handler: async (ctx) => {
        const s = await deps.schedule(ctx.tenantId);
        if (s === undefined) throw noSchedule();
        return { status: 200, body: { schedule: s, asAt: deps.now() } };
      },
    },
    {
      // DUE — which briefs are due now, missed days included and labelled late. A read compute (POST because
      // the trading calendar is a body); server clock decides "now".
      api: 'API-10', method: 'POST', path: '/v1/reporting/brief-schedule/due',
      permission: 'owner.kpi.read', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const tradingDays = Array.isArray(b['tradingDays']) && b['tradingDays'].every(isStr) ? (b['tradingDays'] as string[]) : undefined;
        if (tradingDays === undefined) {
          throw apiError(400, { code: 'due_needs_trading_days', whatHappened: 'Computing what is due needs { tradingDays[] } — the days the brief should cover, oldest first.', wasItSaved: 'not_saved', nextSafeAction: 'Send the trading days from the calendar.' });
        }
        const s = await deps.schedule(ctx.tenantId);
        if (s === undefined) throw noSchedule();
        const due = briefsDue({ schedule: { scheduleId: s.scheduleId, dueAt: s.dueAt, sentDays: s.sentDays }, tradingDays, now: deps.now() });
        return { status: 200, body: { due, count: due.length, asAt: deps.now() } };
      },
    },
    {
      // RUN — the brief that sends itself (EA-07 · M29-FR-04). One pass of the scheduler, which an operator's timer calls
      // (infra: a systemd timer, like the backup): which briefs are due by the SHOP's clock (missed days carried, labelled
      // late), each composed from head office's governed figures with NO AI (the numbers are the brief), sent to the owner
      // through the phone transport, and acknowledged as sent ONLY when the transport took it. A day not sent stays due —
      // the next run retries it. With no transport configured (production today; SMS is R4) each due brief is composed
      // and said to be unsent, never marked sent.
      api: 'API-10', method: 'POST', path: '/v1/reporting/brief-schedule/run',
      permission: 'owner.brief.manage', idempotent: true,
      handler: async (ctx) => ({ status: 200, body: await runBriefPass(deps, ctx.tenantId, ctx.userId) }),
    },
    {
      // SENT — record a send, append-only. A day already sent collapses to one (idempotent).
      api: 'API-10', method: 'POST', path: '/v1/reporting/brief-schedule/sent',
      permission: 'owner.brief.manage', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!isStr(b['tradingDay'])) {
          throw apiError(400, { code: 'sent_needs_a_trading_day', whatHappened: 'Recording a send needs the { tradingDay } that was sent.', wasItSaved: 'not_saved', nextSafeAction: 'Send the trading day the brief covered.' });
        }
        const s = await deps.schedule(ctx.tenantId);
        if (s === undefined) throw noSchedule();
        const tradingDay = (b['tradingDay'] as string).trim();
        await deps.recordSent(ctx.tenantId, tradingDay, ctx.userId, ctx.idempotencyKey ?? `sent-${tradingDay}`);
        return { status: 200, body: { tradingDay, sentDays: s.sentDays.includes(tradingDay) ? s.sentDays : [...s.sentDays, tradingDay] } };
      },
    },
    {
      // BUILD a sendable brief for a day — deterministic figures first, the AI narrative only if it is present,
      // confident, in the reader's language and evidence-backed. Uses the schedule's language/stale threshold
      // as defaults. A read; it composes, it does not send (the transport is the deployment step).
      api: 'API-10', method: 'POST', path: '/v1/reporting/brief',
      permission: 'owner.kpi.read', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const figures = readFigures(b['figures']);
        const attention = readAttention(b['attention']);
        if (figures === undefined || attention === undefined) {
          throw apiError(400, { code: 'not_readable_as_brief_figures', whatHappened: 'A brief needs { figures } (tradingDay, netSalesMinor, marginMinor, marginBps, basketCount, cashBankedMinor, dataAgeMinutes) and optional { attention[] } (headline, valueMinor, ref).', wasItSaved: 'not_saved', nextSafeAction: 'Send the day’s figures; the narrative is optional.' });
        }
        if (b['narrative'] !== undefined && readNarrative(b['narrative']) === undefined) {
          throw apiError(400, { code: 'narrative_not_readable', whatHappened: 'A narrative may carry { text, language, confidence, evidenceRefs } — each of the right type.', wasItSaved: 'not_saved', nextSafeAction: 'Send a well-formed narrative, or omit it — the brief is complete without one.' });
        }
        const s = await deps.schedule(ctx.tenantId);
        const language = (isStr(b['language']) && (LANGUAGES as readonly string[]).includes(b['language'] as string) ? (b['language'] as BriefLanguage) : undefined) ?? s?.language;
        const staleAfterMinutes = (isInt(b['staleAfterMinutes']) ? (b['staleAfterMinutes'] as number) : undefined) ?? s?.staleAfterMinutes;
        const brief = buildScheduledBrief({
          figures, attention,
          ...(language !== undefined ? { language } : {}),
          ...(b['narrative'] !== undefined ? { narrative: readNarrative(b['narrative']) } : {}),
          ...(staleAfterMinutes !== undefined ? { staleAfterMinutes } : {}),
        });
        return { status: 200, body: brief };
      },
    },
  ];
}
