// API-09 The GST filing register and calendar (R3 · A19 · A18's 31 December) — every GSTR-1, GSTR-3B, GSTR-9 and GSTR-9C
// period with its due date, its three-year bar date and its status, the escalating warning for an unfiled return, and
// the owner exception for one near (or past) the bar. On the tested `packages/finance` filing-calendar engine.
//
//   GET  /v1/finance/filing-calendar                       — the calendar on the shop's own date, most urgent first.
//   POST /v1/finance/returns/:returnType/:period/filed     — record a return filed on the portal { arn, filedOn }:
//                                                            GSTR-3B (only once its outward liability is locked to the
//                                                            filed GSTR-1), GSTR-9 (after the year ends), GSTR-9C (after
//                                                            GSTR-9), or a GSTR-1 filed OUTSIDE this system (e.g. before
//                                                            cutover) — a GSTR-1 filed here is the submission store's.
//   POST /v1/finance/filing-calendar/raise-owner-exceptions — put every return near or past the bar into each owner's
//                                                            alert inbox (once per return), and clear a filed one's.
//
// Filed facts are append-only and recorded once; nothing here deletes or re-dates a filing (hard rules #2, #6).

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/audit-trail';
import {
  buildFilingCalendar, parseMonthlyPeriod, parseFinancialYear, InvalidGstPeriod, GST_RETURN_TYPES,
  type GstReturnType, type FilingFact, type CalendarEntry, type Gstr1FilingState,
} from '../../../packages/finance/src/index';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A filing recorded here. */
export interface RecordedFiling {
  readonly type: GstReturnType;
  readonly period: string;
  readonly arn: string;
  readonly filedOn: string;
  readonly recordedBy: string;
  readonly recordedAt: string;
  /** GSTR-1 only: filed outside this system (the submission store holds nothing for the month). */
  readonly outsideThisSystem?: boolean;
}

export interface FilingRegisterDeps {
  /** The shop's own date today (its time zone). */
  readonly today: (tenantId: string) => Promise<string>;
  /** Every monthly period the shop has traded or filed in, oldest first, up to the current month. */
  readonly monthlyPeriods: (tenantId: string, today: string) => Promise<readonly string[]>;
  /** Every filed fact: GSTR-1 from the submission store (`filed`) and every filing recorded here. */
  readonly facts: (tenantId: string) => Promise<readonly FilingFact[]>;
  readonly nearBarDays: (tenantId: string) => Promise<number | null>;
  /** N in words for the page (e.g. "180 days (owner's decision OB-191)"). */
  readonly nearBarDaysSaid?: (tenantId: string) => Promise<string>;
  readonly gstr1State: (tenantId: string, period: string) => Promise<Gstr1FilingState>;
  readonly gstr3bLocked: (tenantId: string, period: string) => Promise<boolean>;
  readonly recordFiling: (tenantId: string, filing: RecordedFiling) => Promise<void>;
  /** Raise each entry to every owner's alert inbox (once per return) and clear any whose return is now filed. */
  readonly raiseToOwners: (tenantId: string, raise: readonly CalendarEntry[], filed: readonly FilingFact[], by: string, at: string) => Promise<{ readonly raised: number; readonly alreadyOpen: number; readonly cleared: number; readonly owners: number }>;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
  readonly now: () => string;
}

/** The financial years the monthly periods touch, in order. */
export function financialYearsOf(periods: readonly string[]): readonly string[] {
  const out = new Set<string>();
  for (const p of periods) {
    const m = parseMonthlyPeriod(p);
    const start = m.month >= 4 ? m.year : m.year - 1;
    out.add(`${start}-${String((start + 1) % 100).padStart(2, '0')}`);
  }
  return [...out].sort();
}

export async function filingCalendarOf(deps: FilingRegisterDeps, tenantId: string) {
  const today = await deps.today(tenantId);
  const periods = await deps.monthlyPeriods(tenantId, today);
  const cal = buildFilingCalendar({
    today, monthlyPeriods: periods, financialYears: financialYearsOf(periods),
    facts: await deps.facts(tenantId), nearBarDays: await deps.nearBarDays(tenantId),
  });
  return deps.nearBarDaysSaid === undefined ? cal : { ...cal, nearBarDaysSaid: await deps.nearBarDaysSaid(tenantId) };
}

export function filingRegisterRoutes(deps: FilingRegisterDeps): readonly Route[] {
  return [
    {
      api: 'API-09', method: 'GET', path: '/v1/finance/filing-calendar',
      permission: 'finance.gstr.read',
      handler: async (ctx) => ({ status: 200, body: await filingCalendarOf(deps, ctx.tenantId) }),
    },
    {
      api: 'API-09', method: 'POST', path: '/v1/finance/returns/:returnType/:period/filed',
      permission: 'finance.gstr.submit', idempotent: true,
      handler: async (ctx) => {
        const type = ctx.params['returnType'] as GstReturnType;
        const period = ctx.params['period'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!GST_RETURN_TYPES.includes(type)) throw apiError(400, { code: 'unknown_return_type', whatHappened: `the return type must be one of ${GST_RETURN_TYPES.join(', ')}`, wasItSaved: 'not_saved', nextSafeAction: 'Use GSTR1, GSTR3B, GSTR9 or GSTR9C in the path.' });
        try {
          if (type === 'GSTR9' || type === 'GSTR9C') parseFinancialYear(period); else parseMonthlyPeriod(period);
        } catch (e) {
          if (e instanceof InvalidGstPeriod) throw apiError(400, { code: 'filing_period_invalid', whatHappened: e.message, wasItSaved: 'not_saved', nextSafeAction: type === 'GSTR9' || type === 'GSTR9C' ? 'Send the financial year as YYYY-YY.' : 'Send the month as MMYYYY.' });
          throw e;
        }
        if (typeof b['arn'] !== 'string' || b['arn'].trim() === '' || typeof b['filedOn'] !== 'string' || !DATE.test(b['filedOn'])) {
          throw apiError(400, { code: 'filing_needs_arn_and_date', whatHappened: 'Recording a filing needs the portal acknowledgement (arn) and the date filed (filedOn, YYYY-MM-DD).', wasItSaved: 'not_saved', nextSafeAction: 'Send { arn, filedOn } from the portal\'s acknowledgement.' });
        }
        const today = await deps.today(ctx.tenantId);
        if (b['filedOn'] > today) throw apiError(422, { code: 'filed_in_the_future', whatHappened: `filedOn ${b['filedOn']} is after today (${today})`, wasItSaved: 'not_saved', nextSafeAction: 'Send the date the portal acknowledged the return.' });
        const facts = await deps.facts(ctx.tenantId);
        if (facts.some((f) => f.type === type && f.period === period && f.filedOn !== undefined)) {
          throw apiError(409, { code: 'return_already_filed', whatHappened: `${type} ${period} is already recorded as filed — a filing is recorded once`, wasItSaved: 'not_saved', nextSafeAction: 'Nothing to do. A correction goes in a later return.' });
        }
        if (type === 'GSTR1') {
          const state = await deps.gstr1State(ctx.tenantId, period);
          if (state !== 'not_started') throw apiError(409, { code: 'gstr1_filed_through_this_system', whatHappened: `GSTR-1 for ${period} is in this system's submission store (${state}) — its filing is recorded there, not typed here`, wasItSaved: 'not_saved', nextSafeAction: 'Use the GSTR-1 submission (approve → file), or reconcile it there with evidence.' });
        }
        if (type === 'GSTR3B' && !(await deps.gstr3bLocked(ctx.tenantId, period))) {
          throw apiError(409, { code: 'gstr3b_not_locked_to_gstr1', whatHappened: `GSTR-3B for ${period} cannot be recorded filed before its outward liability is locked to the filed GSTR-1 (A16)`, wasItSaved: 'not_saved', nextSafeAction: 'File GSTR-1, lock GSTR-3B to it, then record GSTR-3B filed.' });
        }
        if (type === 'GSTR9' && today <= parseFinancialYear(period).to) {
          throw apiError(409, { code: 'year_not_ended', whatHappened: `the financial year ${period} has not ended`, wasItSaved: 'not_saved', nextSafeAction: 'GSTR-9 is filed after 31 March.' });
        }
        if (type === 'GSTR9C' && !facts.some((f) => f.type === 'GSTR9' && f.period === period && f.filedOn !== undefined)) {
          throw apiError(409, { code: 'gstr9_not_filed', whatHappened: `GSTR-9C for ${period} reconciles GSTR-9, which is not recorded filed`, wasItSaved: 'not_saved', nextSafeAction: 'Record GSTR-9 filed first.' });
        }
        const filing: RecordedFiling = {
          type, period, arn: b['arn'].trim(), filedOn: b['filedOn'], recordedBy: ctx.userId, recordedAt: deps.now(),
          ...(type === 'GSTR1' ? { outsideThisSystem: true } : {}),
        };
        await deps.recordFiling(ctx.tenantId, filing);
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: 'gst.return.filed.record', objectType: 'gst_return', objectId: `${type}:${period}`, at: filing.recordedAt,
          origin: { tenantId: ctx.tenantId, branchId: null }, before: null, after: { arn: filing.arn, filedOn: filing.filedOn }, correlationId: ctx.traceId,
        });
        return { status: 201, body: { filing } };
      },
    },
    {
      api: 'API-09', method: 'POST', path: '/v1/finance/filing-calendar/raise-owner-exceptions',
      permission: 'finance.gstr.generate', idempotent: true,
      handler: async (ctx) => {
        const cal = await filingCalendarOf(deps, ctx.tenantId);
        const r = await deps.raiseToOwners(ctx.tenantId, cal.ownerExceptions, await deps.facts(ctx.tenantId), ctx.userId, deps.now());
        return { status: 200, body: { ...r, ownerExceptions: cal.ownerExceptions, nearBarNotJudged: cal.nearBarNotJudged, detail: cal.detail } };
      },
    },
  ];
}
