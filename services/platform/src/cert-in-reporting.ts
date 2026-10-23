// API-11 Platform — the CERT-In 6-HOUR REPORTING CLOCK on a security incident (M35-FR-04 · roadmap §34 "Incident:
// severity, containment, forensics, CERT-In 6-hour applicable workflow, DPDP workflow, recovery" · P-03 · P-08 · hard
// rules #2, #10 — OB-288 P5).
//
// India's CERT-In directions require certain cyber security incidents to be reported to CERT-In within six hours of
// being noticed. Which incidents are reportable is a judgement a named person makes, with the reason written down — the
// software never decides it. Once a person says an incident IS reportable, the clock runs from the moment it was noticed:
//
//   • CLASSIFY (`POST /v1/platform/incidents/:incidentId/cert-in`) — { reportable, category, reason, noticedAt }. On an
//     incident head office opened (no phantom). Once: a different classification later is a visible conflict (409),
//     never an overwrite. `noticedAt` may not be in the future, nor after the classification.
//   • REPORT (`POST /v1/platform/incidents/:incidentId/cert-in/report`) — { reportedAt, reference, channel }: the report
//     as made (CERT-In's acknowledgement or ticket reference). Once.
//   • CLOCK (`GET /v1/platform/cert-in`) — every classified incident: due by (noticed + 6 hours), hours left, and its
//     state — due, OVERDUE, reported in time, reported LATE, or not reportable (with who said so and why). An overdue
//     report is raised to the owners by the alert worker (`certInOverdue`), once, and stays visible until reported.
//
// Distinct from the DPDP personal-data breach workflow (C2): this clock is CERT-In's. Nothing here is deleted.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';

/** The CERT-In reporting window, in hours from the moment the incident was noticed. Fixed by the directions. */
export const CERT_IN_REPORT_HOURS = 6;

export type CertInFact =
  | { readonly change: 'classified'; readonly incidentId: string; readonly reportable: boolean; readonly category: string; readonly reason: string; readonly noticedAt: string; readonly by: string; readonly at: string }
  | { readonly change: 'reported'; readonly incidentId: string; readonly reportedAt: string; readonly reference: string; readonly channel: string; readonly by: string; readonly at: string };

export type CertInState = 'not_reportable' | 'due' | 'overdue' | 'reported_in_time' | 'reported_late';

export interface CertInClock {
  readonly incidentId: string;
  readonly reportable: boolean;
  readonly category: string;
  readonly reason: string;
  readonly classifiedBy: string;
  readonly noticedAt: string;
  /** noticed + 6 hours; null when not reportable. */
  readonly reportBy: string | null;
  readonly state: CertInState;
  /** Whole minutes left (negative: overdue by); null when reported or not reportable. */
  readonly minutesLeft: number | null;
  readonly report: { readonly reportedAt: string; readonly reference: string; readonly channel: string; readonly by: string } | null;
}

/** Each classified incident's clock, as at `now`. Pure. */
export function certInClocks(facts: readonly CertInFact[], now: string): readonly CertInClock[] {
  const out: CertInClock[] = [];
  for (const c of facts) {
    if (c.change !== 'classified' || out.some((x) => x.incidentId === c.incidentId)) continue;
    const r = facts.find((f): f is Extract<CertInFact, { change: 'reported' }> => f.change === 'reported' && f.incidentId === c.incidentId);
    const due = c.reportable ? new Date(Date.parse(c.noticedAt) + CERT_IN_REPORT_HOURS * 3_600_000).toISOString() : null;
    const state: CertInState = !c.reportable ? 'not_reportable'
      : r !== undefined ? (r.reportedAt <= due! ? 'reported_in_time' : 'reported_late')
        : Date.parse(now) >= Date.parse(due!) ? 'overdue' : 'due';
    out.push({
      incidentId: c.incidentId, reportable: c.reportable, category: c.category, reason: c.reason, classifiedBy: c.by, noticedAt: c.noticedAt, reportBy: due, state,
      minutesLeft: state === 'due' || state === 'overdue' ? Math.floor((Date.parse(due!) - Date.parse(now)) / 60_000) : null,
      report: r === undefined ? null : { reportedAt: r.reportedAt, reference: r.reference, channel: r.channel, by: r.by },
    });
  }
  return out;
}

export interface CertInDeps {
  readonly facts: (tenantId: string) => Promise<readonly CertInFact[]>;
  readonly record: (tenantId: string, fact: CertInFact) => Promise<void>;
  /** Does head office hold this operational incident (`ops-incidents.ts`)? */
  readonly incidentExists: (tenantId: string, incidentId: string) => Promise<boolean>;
  readonly now: () => string;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isIso = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(v) && !Number.isNaN(Date.parse(v));

export function certInRoutes(deps: CertInDeps): readonly Route[] {
  return [
    {
      api: 'API-11', method: 'POST', path: '/v1/platform/incidents/:incidentId/cert-in',
      permission: 'platform.certin.manage', idempotent: true,
      handler: async (ctx) => {
        const incidentId = (ctx.params['incidentId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (incidentId === '' || typeof b['reportable'] !== 'boolean' || !isStr(b['category']) || !isStr(b['reason']) || !isIso(b['noticedAt'])) {
          throw apiError(400, { code: 'not_readable_as_a_cert_in_classification', whatHappened: 'A CERT-In classification needs { reportable (true/false), category (which kind of incident), reason (why it is or is not reportable), noticedAt (when it was noticed, ISO time) }.', wasItSaved: 'not_saved', nextSafeAction: 'Say whether it must be reported to CERT-In and why. Nothing was recorded.' });
        }
        const now = deps.now();
        const noticedAt = new Date(Date.parse(b['noticedAt'] as string)).toISOString();
        if (Date.parse(noticedAt) > Date.parse(now)) throw apiError(422, { code: 'noticed_in_the_future', whatHappened: `${noticedAt} is later than now — the clock runs from when the incident was actually noticed.`, wasItSaved: 'not_saved', nextSafeAction: 'Send the time it was noticed. Nothing was recorded.' });
        if (!(await deps.incidentExists(ctx.tenantId, incidentId))) throw notFound(`incident ${incidentId}`);
        const prior = (await deps.facts(ctx.tenantId)).find((f) => f.change === 'classified' && f.incidentId === incidentId);
        if (prior !== undefined && prior.change === 'classified') {
          const same = prior.reportable === b['reportable'] && prior.category === (b['category'] as string).trim() && prior.noticedAt === noticedAt;
          if (same) return { status: 200, body: { clock: certInClocks(await deps.facts(ctx.tenantId), now).find((c) => c.incidentId === incidentId), alreadyClassified: true } };
          throw apiError(409, { code: 'cert_in_already_classified', whatHappened: `${incidentId} was classified by ${prior.by} at ${prior.at} (${prior.reportable ? 'reportable' : 'not reportable'}, noticed ${prior.noticedAt}). A classification is never overwritten.`, wasItSaved: 'not_saved', nextSafeAction: 'If it was wrong, write that on the incident\'s timeline and report to CERT-In if in doubt. Nothing was changed.' });
        }
        const fact: CertInFact = { change: 'classified', incidentId, reportable: b['reportable'] as boolean, category: (b['category'] as string).trim(), reason: (b['reason'] as string).trim(), noticedAt, by: ctx.userId, at: now };
        await deps.record(ctx.tenantId, fact);
        const clock = certInClocks([fact], now)[0]!;
        return { status: 201, body: { clock, detail: clock.reportable ? `Report to CERT-In by ${clock.reportBy} (${CERT_IN_REPORT_HOURS} hours from when it was noticed).` : `Recorded as not reportable to CERT-In, by ${ctx.userId}: ${fact.reason}` } };
      },
    },
    {
      api: 'API-11', method: 'POST', path: '/v1/platform/incidents/:incidentId/cert-in/report',
      permission: 'platform.certin.manage', idempotent: true,
      handler: async (ctx) => {
        const incidentId = (ctx.params['incidentId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!isIso(b['reportedAt']) || !isStr(b['reference']) || !isStr(b['channel'])) {
          throw apiError(400, { code: 'not_readable_as_a_cert_in_report', whatHappened: 'Recording the report needs { reportedAt (ISO time), reference (CERT-In\'s acknowledgement or ticket), channel (how it was sent) }.', wasItSaved: 'not_saved', nextSafeAction: 'Send the report as it was made. Nothing was recorded.' });
        }
        const facts = await deps.facts(ctx.tenantId);
        const clock = certInClocks(facts, deps.now()).find((c) => c.incidentId === incidentId);
        if (clock === undefined) throw apiError(409, { code: 'cert_in_not_classified', whatHappened: `${incidentId} has not been classified for CERT-In yet.`, wasItSaved: 'not_saved', nextSafeAction: 'Classify it first (reportable or not, and why). Nothing was recorded.' });
        if (!clock.reportable) throw apiError(409, { code: 'cert_in_not_reportable', whatHappened: `${incidentId} was classified as not reportable by ${clock.classifiedBy}.`, wasItSaved: 'not_saved', nextSafeAction: 'Nothing was recorded.' });
        if (clock.report !== null) return { status: 200, body: { clock, alreadyReported: true } };
        const reportedAt = new Date(Date.parse(b['reportedAt'] as string)).toISOString();
        if (Date.parse(reportedAt) > Date.parse(deps.now()) || Date.parse(reportedAt) < Date.parse(clock.noticedAt)) {
          throw apiError(422, { code: 'report_time_not_possible', whatHappened: `A report at ${reportedAt} is before the incident was noticed (${clock.noticedAt}) or later than now.`, wasItSaved: 'not_saved', nextSafeAction: 'Send the time the report was actually made. Nothing was recorded.' });
        }
        const fact: CertInFact = { change: 'reported', incidentId, reportedAt, reference: (b['reference'] as string).trim(), channel: (b['channel'] as string).trim(), by: ctx.userId, at: deps.now() };
        await deps.record(ctx.tenantId, fact);
        const after = certInClocks([...facts, fact], deps.now()).find((c) => c.incidentId === incidentId)!;
        return { status: 201, body: { clock: after, detail: after.state === 'reported_late' ? `Recorded — LATE: the report was due by ${after.reportBy}.` : 'Recorded, within the six hours.' } };
      },
    },
    {
      api: 'API-11', method: 'GET', path: '/v1/platform/cert-in',
      permission: 'platform.health.read',
      handler: async (ctx) => {
        const now = deps.now();
        const clocks = certInClocks(await deps.facts(ctx.tenantId), now);
        return {
          status: 200,
          body: {
            clocks: [...clocks].sort((a, b) => (a.state === 'overdue' ? -1 : 0) - (b.state === 'overdue' ? -1 : 0) || (a.reportBy ?? '').localeCompare(b.reportBy ?? '')),
            overdue: clocks.filter((c) => c.state === 'overdue').length, due: clocks.filter((c) => c.state === 'due').length,
            windowHours: CERT_IN_REPORT_HOURS, asAt: now,
          },
        };
      },
    },
  ];
}

/** The clocks that are overdue as at `now` — what the alert worker raises to the owners. Pure. */
export function certInOverdue(facts: readonly CertInFact[], now: string): readonly CertInClock[] {
  return certInClocks(facts, now).filter((c) => c.state === 'overdue');
}
