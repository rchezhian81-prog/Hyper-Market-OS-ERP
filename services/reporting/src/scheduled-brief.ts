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
}

export interface ScheduledBriefDeps {
  readonly schedule: (tenantId: string) => Promise<StoredSchedule | undefined> | StoredSchedule | undefined;
  readonly setSchedule: (tenantId: string, config: { dueAt: readonly [number, number]; language?: BriefLanguage; staleAfterMinutes?: number }, by: string, key: string) => Promise<void> | void;
  readonly recordSent: (tenantId: string, tradingDay: string, by: string, key: string) => Promise<void> | void;
  readonly now: () => string;
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
