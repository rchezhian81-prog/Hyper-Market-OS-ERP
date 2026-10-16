// API-11 HR/Workforce — the Internal Committee complaints register and its annual report (R2 addendum C20 ·
// M25/M34), on the tested `packages/workforce` POSH engine.
//
// CONFIDENTIAL. The register is held by the Internal Committee alone:
//   • reads and writes of complaints need `posh.complaint.read` / `posh.complaint.record`, which ONLY the
//     `internal_committee` role holds — not the owner, not a store manager, not the platform administrator;
//   • EVERY read of the register (the list, one complaint, the access log) and every write is sealed into the
//     tamper-evident audit trail BEFORE the answer is returned — if the audit cannot be written, nothing is shown;
//   • records are append-only: a complaint is received once (a second receipt under the same id is refused, never
//     overwritten), what happens to it is a new step, and there is no route that edits or removes anything.
//
//   • `POST /v1/hr/posh/complaints/:complaintId`                 — receive a complaint. posh.complaint.record.
//   • `POST /v1/hr/posh/complaints/:complaintId/steps/:stepId`   — inquiry started / disposed. posh.complaint.record.
//   • `GET  /v1/hr/posh/complaints`                              — the register. posh.complaint.read. Audited.
//   • `GET  /v1/hr/posh/complaints/:complaintId`                 — one complaint and its steps. Audited.
//   • `GET  /v1/hr/posh/access-log`                              — who read or wrote the register, when. Audited.
//   • `POST /v1/hr/posh/annual-reports/:year`                    — generate the year's report (counts only).
//     posh.report.generate (the committee).
//   • `GET  /v1/hr/posh/annual-reports/:year`                    — the latest generated report. posh.report.read
//     (the committee and the owner — it carries no names). Audited.
//   • `POST /v1/hr/posh/annual-reports/:year/filing`             — the employer records the report as filed with the
//     District Officer. posh.report.file (the owner). Once per year.
//   • `GET  /v1/hr/posh/annual-report-status?asOf=`              — the 31 January exceptions (due / overdue) the
//     owner sees. posh.report.read.

import type { Route, RequestContext } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/audit-trail';
import {
  POSH_LAW, POSH_OUTCOMES, poshComplaintView, admitPoshStep, poshAnnualReport, poshReportExceptions, poshReportDueBy,
  type PoshComplaint, type PoshStep, type PoshAnnualReport, type PoshReportFiling, type PoshOutcome, type PoshStepKind,
} from '../../../packages/workforce/src/index';

export interface PoshRegisterDeps {
  readonly complaints: (tenantId: string) => Promise<readonly PoshComplaint[]>;
  /** False when the id is already received (the first stands). */
  readonly recordComplaint: (tenantId: string, complaint: PoshComplaint) => Promise<boolean>;
  readonly steps: (tenantId: string) => Promise<readonly PoshStep[]>;
  /** False when the step id is already recorded. */
  readonly recordStep: (tenantId: string, step: PoshStep) => Promise<boolean>;
  readonly reports: (tenantId: string) => Promise<readonly PoshAnnualReport[]>;
  readonly recordReport: (tenantId: string, report: PoshAnnualReport) => Promise<void>;
  readonly filings: (tenantId: string) => Promise<readonly PoshReportFiling[]>;
  /** False when the year is already filed. */
  readonly recordFiling: (tenantId: string, filing: PoshReportFiling) => Promise<boolean>;
  /** Seal one entry into the tamper-evident audit trail; a failure must throw (fail closed). */
  readonly recordAudit: (tenantId: string, entry: AuditEntry) => Promise<unknown>;
  /** The register's own entries in the audit trail. */
  readonly accessLog: (tenantId: string) => Promise<readonly { readonly actorId: string; readonly action: string; readonly objectId: string; readonly at: string }[]>;
  readonly now: () => string;
}

/** The audit trail's object type for every register entry — what the access log reads back. */
export const POSH_AUDIT_OBJECT = 'posh_register';

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));

/** Seal an entry naming only the act and the record id — never a name or the summary. */
const seal = (deps: PoshRegisterDeps, ctx: RequestContext, action: string, objectId: string, after: Record<string, string> = {}): Promise<unknown> =>
  deps.recordAudit(ctx.tenantId, {
    actorId: ctx.userId, action, objectType: POSH_AUDIT_OBJECT, objectId, at: deps.now(),
    origin: { tenantId: ctx.tenantId, branchId: null }, before: null, after, correlationId: ctx.traceId,
  });

const yearParam = (ctx: RequestContext): number => {
  const raw = ctx.params['year'] ?? '';
  const year = Number(raw);
  if (!/^\d{4}$/.test(raw) || year < 2013) {
    throw apiError(400, { code: 'not_a_report_year', whatHappened: `"${raw}" is not a calendar year the Act applies to.`, wasItSaved: 'not_saved', nextSafeAction: 'Use a four-digit year from 2013, e.g. 2026.' });
  }
  return year;
};

export function poshRegisterRoutes(deps: PoshRegisterDeps): readonly Route[] {
  return [
    {
      // Body: { receivedOn, complainantRef, respondentRef, summary }.
      api: 'API-11', method: 'POST', path: '/v1/hr/posh/complaints/:complaintId',
      permission: 'posh.complaint.record', idempotent: true,
      handler: async (ctx) => {
        const complaintId = (ctx.params['complaintId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (complaintId === '' || !isDate(b['receivedOn']) || !isStr(b['complainantRef']) || !isStr(b['respondentRef']) || !isStr(b['summary'])) {
          throw apiError(400, { code: 'not_readable_as_a_complaint', whatHappened: 'A complaint needs a complaintId in the path and { receivedOn (YYYY-MM-DD), complainantRef, respondentRef, summary } in the body.', wasItSaved: 'not_saved', nextSafeAction: 'Send the complaint as the committee received it.' });
        }
        const complaint: PoshComplaint = {
          complaintId, receivedOn: b['receivedOn'], complainantRef: b['complainantRef'].trim(), respondentRef: b['respondentRef'].trim(),
          summary: b['summary'].trim(), recordedBy: ctx.userId, recordedAt: deps.now(),
        };
        // Sealed first: a write the audit trail did not see does not happen.
        await seal(deps, ctx, 'posh.complaint.receive', complaintId);
        if (!(await deps.recordComplaint(ctx.tenantId, complaint))) {
          throw apiError(409, { code: 'complaint_already_received', whatHappened: `Complaint ${complaintId} is already in the register; a complaint is never overwritten.`, wasItSaved: 'not_saved', nextSafeAction: 'Record what happened next as a step, or receive a new complaint under a new id.' });
        }
        return { status: 201, body: { complaint: poshComplaintView(complaint, []) } };
      },
    },
    {
      // Body: { kind: 'inquiry_started' | 'disposed', on, outcome? (when disposed), note? }.
      api: 'API-11', method: 'POST', path: '/v1/hr/posh/complaints/:complaintId/steps/:stepId',
      permission: 'posh.complaint.record', idempotent: true,
      handler: async (ctx) => {
        const complaintId = (ctx.params['complaintId'] ?? '').trim();
        const stepId = (ctx.params['stepId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const complaint = (await deps.complaints(ctx.tenantId)).find((c) => c.complaintId === complaintId);
        if (complaint === undefined || stepId === '') {
          throw apiError(404, { code: 'no_such_complaint', whatHappened: `There is no complaint ${complaintId} in the register.`, wasItSaved: 'not_saved', nextSafeAction: 'Check the complaint id.' });
        }
        const steps = await deps.steps(ctx.tenantId);
        const view = poshComplaintView(complaint, steps);
        const kind = b['kind'] as PoshStepKind;
        const outcome = typeof b['outcome'] === 'string' && (POSH_OUTCOMES as readonly string[]).includes(b['outcome']) ? b['outcome'] as PoshOutcome : undefined;
        const on = typeof b['on'] === 'string' ? b['on'] : '';
        const admitted = admitPoshStep(view, { kind, on, ...(outcome === undefined ? {} : { outcome }) });
        if (!admitted.ok) {
          throw apiError(admitted.code === 'not_readable' || admitted.code === 'outcome_needed' ? 400 : 409, { code: admitted.code, whatHappened: admitted.detail, wasItSaved: 'not_saved', nextSafeAction: 'The register is unchanged. Record the step the complaint is actually at.' });
        }
        const step: PoshStep = {
          complaintId, stepId, kind, on, ...(kind === 'disposed' && outcome !== undefined ? { outcome } : {}),
          ...(isStr(b['note']) ? { note: b['note'].trim() } : {}), recordedBy: ctx.userId, recordedAt: deps.now(),
        };
        await seal(deps, ctx, `posh.complaint.${kind}`, complaintId, { stepId });
        if (!(await deps.recordStep(ctx.tenantId, step))) {
          throw apiError(409, { code: 'step_already_recorded', whatHappened: `Step ${stepId} is already recorded; a step is never overwritten.`, wasItSaved: 'not_saved', nextSafeAction: 'Record the next step under a new id.' });
        }
        return { status: 201, body: { complaint: poshComplaintView(complaint, [...steps, step]) } };
      },
    },
    {
      api: 'API-11', method: 'GET', path: '/v1/hr/posh/complaints',
      permission: 'posh.complaint.read',
      handler: async (ctx) => {
        const [complaints, steps] = [await deps.complaints(ctx.tenantId), await deps.steps(ctx.tenantId)];
        await seal(deps, ctx, 'posh.register.read', 'register', { count: String(complaints.length) });
        const rows = complaints.map((c) => poshComplaintView(c, steps)).sort((a, b) => a.receivedOn.localeCompare(b.receivedOn) || a.complaintId.localeCompare(b.complaintId));
        return { status: 200, body: { law: POSH_LAW, complaints: rows, count: rows.length, open: rows.filter((r) => r.status !== 'disposed').length } };
      },
    },
    {
      api: 'API-11', method: 'GET', path: '/v1/hr/posh/complaints/:complaintId',
      permission: 'posh.complaint.read',
      handler: async (ctx) => {
        const complaintId = ctx.params['complaintId'] ?? '';
        const complaint = (await deps.complaints(ctx.tenantId)).find((c) => c.complaintId === complaintId);
        // The look-up itself is sealed, found or not: asking about a complaint is part of the record.
        await seal(deps, ctx, 'posh.complaint.read', complaintId, { found: String(complaint !== undefined) });
        if (complaint === undefined) {
          throw apiError(404, { code: 'no_such_complaint', whatHappened: `There is no complaint ${complaintId} in the register.`, wasItSaved: 'not_saved', nextSafeAction: 'Check the complaint id.' });
        }
        return { status: 200, body: { complaint: poshComplaintView(complaint, await deps.steps(ctx.tenantId)) } };
      },
    },
    {
      api: 'API-11', method: 'GET', path: '/v1/hr/posh/access-log',
      permission: 'posh.complaint.read',
      handler: async (ctx) => {
        await seal(deps, ctx, 'posh.access_log.read', 'access-log');
        const entries = await deps.accessLog(ctx.tenantId);
        return { status: 200, body: { entries, count: entries.length } };
      },
    },
    {
      api: 'API-11', method: 'POST', path: '/v1/hr/posh/annual-reports/:year',
      permission: 'posh.report.generate', idempotent: true,
      handler: async (ctx) => {
        const year = yearParam(ctx);
        const filed = (await deps.filings(ctx.tenantId)).find((f) => f.year === year);
        if (filed !== undefined) {
          throw apiError(409, { code: 'report_already_filed', whatHappened: `The ${year} report was recorded as filed on ${filed.filedOn}; the filed report stands.`, wasItSaved: 'not_saved', nextSafeAction: 'Read the filed report. A correction to a filed report is a matter for the District Officer.' });
        }
        const report = poshAnnualReport({ year, complaints: await deps.complaints(ctx.tenantId), steps: await deps.steps(ctx.tenantId), generatedAt: deps.now(), generatedBy: ctx.userId });
        await seal(deps, ctx, 'posh.report.generate', String(year));
        await deps.recordReport(ctx.tenantId, report);
        return { status: 201, body: { report } };
      },
    },
    {
      api: 'API-11', method: 'GET', path: '/v1/hr/posh/annual-reports/:year',
      permission: 'posh.report.read',
      handler: async (ctx) => {
        const year = yearParam(ctx);
        const report = (await deps.reports(ctx.tenantId)).filter((r) => r.year === year).at(-1);
        await seal(deps, ctx, 'posh.report.read', String(year), { found: String(report !== undefined) });
        if (report === undefined) {
          throw apiError(404, { code: 'no_report_for_year', whatHappened: `No annual report has been generated for ${year}.`, wasItSaved: 'not_saved', nextSafeAction: 'The Internal Committee generates it from the register.' });
        }
        const filing = (await deps.filings(ctx.tenantId)).find((f) => f.year === year);
        return { status: 200, body: { report, ...(filing === undefined ? {} : { filing }) } };
      },
    },
    {
      // Body: { filedOn, reference }.
      api: 'API-11', method: 'POST', path: '/v1/hr/posh/annual-reports/:year/filing',
      permission: 'posh.report.file', idempotent: true,
      handler: async (ctx) => {
        const year = yearParam(ctx);
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!isDate(b['filedOn']) || !isStr(b['reference'])) {
          throw apiError(400, { code: 'not_readable_as_a_filing', whatHappened: 'Recording a filing needs { filedOn (YYYY-MM-DD), reference } — the District Officer\'s acknowledgement.', wasItSaved: 'not_saved', nextSafeAction: 'Send the date filed and the acknowledgement reference.' });
        }
        if (!(await deps.reports(ctx.tenantId)).some((r) => r.year === year)) {
          throw apiError(409, { code: 'no_report_to_file', whatHappened: `No annual report has been generated for ${year}, so there is nothing to record as filed.`, wasItSaved: 'not_saved', nextSafeAction: 'The Internal Committee generates the report first.' });
        }
        const filing: PoshReportFiling = { year, filedOn: b['filedOn'], reference: b['reference'].trim(), recordedBy: ctx.userId, recordedAt: deps.now() };
        await seal(deps, ctx, 'posh.report.file', String(year));
        if (!(await deps.recordFiling(ctx.tenantId, filing))) {
          throw apiError(409, { code: 'report_already_filed', whatHappened: `The ${year} report is already recorded as filed.`, wasItSaved: 'not_saved', nextSafeAction: 'Nothing to do.' });
        }
        return { status: 201, body: { filing, dueBy: poshReportDueBy(year), onTime: filing.filedOn <= poshReportDueBy(year) } };
      },
    },
    {
      api: 'API-11', method: 'GET', path: '/v1/hr/posh/annual-report-status',
      permission: 'posh.report.read',
      handler: async (ctx) => {
        const asOf = ctx.query['asOf'] ?? deps.now().slice(0, 10);
        if (!isDate(asOf)) throw apiError(400, { code: 'status_needs_a_date', whatHappened: 'asOf must be YYYY-MM-DD.', wasItSaved: 'not_saved', nextSafeAction: 'Ask again with ?asOf=2027-01-15, or leave it out for today.' });
        const complaints = await deps.complaints(ctx.tenantId);
        const reports = await deps.reports(ctx.tenantId);
        const filings = await deps.filings(ctx.tenantId);
        const years = [
          Number(asOf.slice(0, 4)) - 1,
          ...complaints.map((c) => Number(c.receivedOn.slice(0, 4))),
          ...reports.map((r) => r.year), ...filings.map((f) => f.year),
        ];
        const exceptions = poshReportExceptions({ asOf, firstYear: Math.min(...years), generatedYears: reports.map((r) => r.year), filings });
        return { status: 200, body: { asOf, exceptions, count: exceptions.length, filed: filings.map((f) => ({ year: f.year, filedOn: f.filedOn, onTime: f.filedOn <= poshReportDueBy(f.year) })) } };
      },
    },
  ];
}
