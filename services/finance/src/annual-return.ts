// API-09 GSTR-9 and GSTR-9C (R3 · A18) — the annual return folded from the twelve filed months, and the reconciliation of
// the books to it with every difference named. On the tested `packages/finance` annual-return engine.
//
//   GET  /v1/finance/gstr9/:fy                  — GSTR-9 for the financial year (YYYY-YY): complete, or which months are
//                                                 missing; ITC "not known" (never zero) while any month is unreconciled.
//   GET  /v1/finance/gstr9c/:fy                 — GSTR-9C: books (the day book) vs GSTR-9, month by month, each
//                                                 difference with its reason or OPEN.
//   POST /v1/finance/gstr9c/:fy/reasons         — a named person records the reason for an open difference
//                                                 { period, code, reason } (append-only; the latest stands).
//
// Due 31 December after the year (it shows on the filing calendar).

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  foldGstr9, reconcileGstr9c, parseFinancialYear, InvalidGstPeriod, dueDateOf,
  type AnnualMonthInput, type Gstr9cReason, type Gstr9cDifferenceCode,
} from '../../../packages/finance/src/index';
import { turnoverOf } from './gstr3b-store';

const CODES: readonly Gstr9cDifferenceCode[] = ['month_not_filed', 'outward_documents_not_in_books', 'changed_after_gstr1_filed_not_amended', 'books_differ_from_till'];

export interface AnnualReturnDeps {
  /** The year's twelve months folded for the annual return. */
  readonly months: (tenantId: string, fy: string, annualTurnoverMinor: number) => Promise<readonly AnnualMonthInput[]>;
  readonly reasons: (tenantId: string, fy: string) => Promise<readonly Gstr9cReason[]>;
  readonly recordReason: (tenantId: string, fy: string, reason: Gstr9cReason) => Promise<void>;
  readonly now: () => string;
}

const fyOr400 = (raw: string | undefined): string => {
  try { return parseFinancialYear(raw ?? '').fy; } catch (e) {
    if (e instanceof InvalidGstPeriod) throw apiError(400, { code: 'financial_year_invalid', whatHappened: e.message, wasItSaved: 'not_saved', nextSafeAction: 'Send the financial year as YYYY-YY (e.g. 2026-27).' });
    throw e;
  }
};

export function annualReturnRoutes(deps: AnnualReturnDeps): readonly Route[] {
  const both = async (tenantId: string, fy: string, turnover: number) => {
    const months = await deps.months(tenantId, fy, turnover);
    const gstr9 = foldGstr9({ fy, months });
    const gstr9c = reconcileGstr9c({ fy, months, gstr9, reasons: await deps.reasons(tenantId, fy) });
    return { gstr9, gstr9c };
  };
  return [
    {
      api: 'API-09', method: 'GET', path: '/v1/finance/gstr9/:fy',
      permission: 'finance.gstr.read',
      handler: async (ctx) => {
        const fy = fyOr400(ctx.params['fy']);
        const { gstr9 } = await both(ctx.tenantId, fy, turnoverOf(ctx.query));
        return { status: 200, body: { ...gstr9, dueDate: dueDateOf('GSTR9', fy) } };
      },
    },
    {
      api: 'API-09', method: 'GET', path: '/v1/finance/gstr9c/:fy',
      permission: 'finance.gstr.read',
      handler: async (ctx) => {
        const fy = fyOr400(ctx.params['fy']);
        const { gstr9, gstr9c } = await both(ctx.tenantId, fy, turnoverOf(ctx.query));
        return { status: 200, body: { ...gstr9c, gstr9Complete: gstr9.complete, gstr9Missing: gstr9.missing, dueDate: dueDateOf('GSTR9C', fy) } };
      },
    },
    {
      api: 'API-09', method: 'POST', path: '/v1/finance/gstr9c/:fy/reasons',
      permission: 'finance.gstr.generate', idempotent: true,
      handler: async (ctx) => {
        const fy = fyOr400(ctx.params['fy']);
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const periods = parseFinancialYear(fy).periods;
        if (typeof b['period'] !== 'string' || !periods.includes(b['period']) || !CODES.includes(b['code'] as Gstr9cDifferenceCode) || typeof b['reason'] !== 'string' || b['reason'].trim() === '') {
          throw apiError(400, { code: 'reason_needs_period_code_reason', whatHappened: `A reason needs period (a month of ${fy}, MMYYYY), code (${CODES.join(' / ')}) and the reason in words.`, wasItSaved: 'not_saved', nextSafeAction: 'Send { period, code, reason } for a difference GSTR-9C lists.' });
        }
        const { gstr9c } = await both(ctx.tenantId, fy, turnoverOf(ctx.query));
        if (!gstr9c.differences.some((d) => d.period === b['period'] && d.code === b['code'])) {
          throw apiError(422, { code: 'no_such_difference', whatHappened: `GSTR-9C for ${fy} lists no ${String(b['code'])} difference for ${String(b['period'])}`, wasItSaved: 'not_saved', nextSafeAction: 'Give a reason only for a difference the reconciliation lists.' });
        }
        const reason: Gstr9cReason = { period: b['period'], code: b['code'] as Gstr9cDifferenceCode, reason: b['reason'].trim(), by: ctx.userId, at: deps.now() };
        await deps.recordReason(ctx.tenantId, fy, reason);
        return { status: 201, body: { reason, gstr9c: (await both(ctx.tenantId, fy, turnoverOf(ctx.query))).gstr9c } };
      },
    },
  ];
}
