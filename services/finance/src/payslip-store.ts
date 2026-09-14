// API-09 Payroll — the DURABLE issued-payslip store (M25 · ESS), on the tested `employeeSelfView` redaction.
// The `/payslip` and `/ess/self` routes are stateless what-ifs (the payslip is supplied in the body). This
// persists an ISSUED payslip per (employeeId, period) — an append-only, retained record (hard rule #6) — so an
// employee can read THEIR OWN latest payslip, self-redacted: their own money only, employer cost shown
// separately, never anyone else's.
//
//   • `POST /v1/hr/payroll/payslips/:employeeId/:period` — HR issues/stores a payslip for a person for a pay
//     period. Confidential — gated `payroll.statutory.read`.
//   • `GET  /v1/hr/payroll/my-payslip`                   — the AUTHENTICATED employee's latest issued payslip,
//     run through the tested `employeeSelfView` (self-scope + redaction). Gated on the narrow, widely-held
//     `payroll.ess.self`. When nothing has been issued yet it returns `issued:false`, not a 404.
//   • `GET  /v1/hr/payroll/payslips/:employeeId`         — the periods issued for a person, for HR review.
//     Gated `payroll.statutory.read`.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  employeeSelfView, EssAccessDenied, InvalidEssInput,
  type Payslip,
} from '../../../packages/payroll/src/index';

/** An issued payslip — the durable record: whose, for which period, and the computed payslip. */
export interface IssuedPayslip {
  readonly employeeId: string;
  readonly period: string; // e.g. 2026-08
  readonly payslip: Payslip;
}

export interface PayslipStoreDeps {
  readonly putPayslip: (tenantId: string, issued: IssuedPayslip, key: string) => Promise<void> | void;
  /** Every issued payslip for a person (latest per period). */
  readonly payslipsFor: (tenantId: string, employeeId: string) => Promise<readonly IssuedPayslip[]> | readonly IssuedPayslip[];
  /** The person's most recent issued payslip (by period), or undefined. */
  readonly latestPayslip: (tenantId: string, employeeId: string) => Promise<IssuedPayslip | undefined> | IssuedPayslip | undefined;
  readonly now: () => string;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** A stored payslip must at least carry what `employeeSelfView` reads — earnings, statutory, gross, net, date. */
const looksLikePayslip = (v: unknown): v is Payslip =>
  isObj(v) && isStr(v['onDate']) && Array.isArray(v['earnings']) && isObj(v['statutory'])
  && isNum(v['grossMinor']) && isNum(v['netPayMinor']);

export function payslipStoreRoutes(deps: PayslipStoreDeps): readonly Route[] {
  return [
    {
      // HR issues a payslip for a person for a period. Body: { payslip } (from the /payslip engine). Confidential.
      api: 'API-09', method: 'POST', path: '/v1/hr/payroll/payslips/:employeeId/:period',
      permission: 'payroll.statutory.read', idempotent: true,
      handler: async (ctx) => {
        const employeeId = (ctx.params['employeeId'] ?? '').trim();
        const period = (ctx.params['period'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (employeeId === '' || period === '' || !looksLikePayslip(b['payslip'])) {
          throw apiError(400, {
            code: 'not_readable_as_an_issued_payslip',
            whatHappened: 'Issuing a payslip needs an employeeId and a period in the path and { payslip } in the body (the computed payslip with earnings, statutory, grossMinor, netPayMinor and onDate).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Compute the payslip via POST /v1/hr/payroll/payslip, then issue it here.',
          });
        }
        const issued: IssuedPayslip = { employeeId, period, payslip: b['payslip'] };
        await deps.putPayslip(ctx.tenantId, issued, ctx.idempotencyKey ?? `payslip-${employeeId}-${period}-${deps.now()}`);
        return { status: 200, body: { employeeId, period } };
      },
    },
    {
      // My own latest payslip (employee self-service), self-redacted. Read-only. `issued:false` when none yet.
      api: 'API-09', method: 'GET', path: '/v1/hr/payroll/my-payslip',
      permission: 'payroll.ess.self',
      handler: async (ctx) => {
        const latest = await deps.latestPayslip(ctx.tenantId, ctx.userId);
        if (latest === undefined) {
          return { status: 200, body: { issued: false, employeeId: ctx.userId } };
        }
        try {
          const view = employeeSelfView({ requesterEmployeeId: ctx.userId, subjectEmployeeId: latest.employeeId, payslip: latest.payslip });
          return { status: 200, body: { issued: true, period: latest.period, view } };
        } catch (err) {
          // Self-scope is guaranteed here (requester === subject === ctx.userId), so a throw means the stored
          // payslip is malformed — surface it honestly rather than a blank screen.
          if (err instanceof EssAccessDenied) throw apiError(403, { code: 'ess_not_your_record', whatHappened: err.message, wasItSaved: 'not_saved', nextSafeAction: 'You may only view your own payslip.' });
          if (err instanceof InvalidEssInput) throw apiError(422, { code: 'ess_invalid_payslip', whatHappened: err.message, wasItSaved: 'not_saved', nextSafeAction: 'Ask HR to re-issue your payslip — the stored copy is incomplete.' });
          throw err;
        }
      },
    },
    {
      // The periods issued for a person — HR review. Read-only.
      api: 'API-09', method: 'GET', path: '/v1/hr/payroll/payslips/:employeeId',
      permission: 'payroll.statutory.read',
      handler: async (ctx) => {
        const employeeId = (ctx.params['employeeId'] ?? '').trim();
        const all = await deps.payslipsFor(ctx.tenantId, employeeId);
        const periods = [...all].map((p) => ({ period: p.period, onDate: p.payslip.onDate, netPayMinor: p.payslip.netPayMinor }))
          .sort((a, b) => b.period.localeCompare(a.period));
        return { status: 200, body: { employeeId, periods, count: periods.length } };
      },
    },
  ];
}
