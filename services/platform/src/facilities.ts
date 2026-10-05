// API-11 Facilities — maintenance & compliance schedules (M26-FR-03). Cleaning, pest control, fire
// and electrical safety, statutory checks: recurring tasks where **a tick is worth nothing at an
// inspection and a dated photograph is worth everything**. So a completion without required evidence
// is REFUSED rather than accepted-with-a-note (an accepted-with-a-note task shows green, and green is
// what everybody reads); a safety check needs a second verifier who is not the person who did it
// (§28); and a compliance-linked task that rolls into tomorrow's list every day escalates BY ITSELF,
// because nothing ever going red is how nothing is ever wrong. The rule is the pure `assessCompletion`
// / `findOverdue` in `packages/facilities` — another complete engine nothing fed on the cloud.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound, requireActorIsCaller, secondPersonIsASeparateAct } from '../../kernel/src/index';
import {
  assessCompletion, findOverdue, closeIncident, buildComplianceEvidence,
  type MaintenanceSchedule, type ScheduledTask, type ScheduleCategory, type ScheduleFrequency,
  type SafetyIncident, type IncidentKind, type IncidentSeverity,
} from '../../../packages/facilities/src/index';

export type { MaintenanceSchedule, ScheduledTask, SafetyIncident } from '../../../packages/facilities/src/index';

const CATEGORIES: readonly ScheduleCategory[] = ['cleaning', 'pest_control', 'fire_safety', 'electrical_safety', 'maintenance', 'statutory'];
const FREQUENCIES: readonly ScheduleFrequency[] = ['daily', 'weekly', 'monthly', 'quarterly', 'half_yearly', 'annual'];
const INCIDENT_KINDS: readonly IncidentKind[] = ['injury', 'near_miss', 'fire', 'equipment_failure', 'food_safety', 'security'];
const INCIDENT_SEVERITIES: readonly IncidentSeverity[] = ['minor', 'serious', 'reportable'];
const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00.000Z`));
const isDateTime = (s: unknown): s is string => typeof s === 'string' && s.trim() !== '' && !Number.isNaN(Date.parse(s));
const isStr = (s: unknown): s is string => typeof s === 'string' && s.trim() !== '';

export interface FacilitiesDeps {
  readonly schedules: (tenantId: string) => Promise<readonly MaintenanceSchedule[]> | readonly MaintenanceSchedule[];
  readonly tasks: (tenantId: string) => Promise<readonly ScheduledTask[]> | readonly ScheduledTask[];
  readonly recordSchedule: (tenantId: string, schedule: MaintenanceSchedule) => Promise<void> | void;
  readonly recordTaskDue: (tenantId: string, task: { taskId: string; scheduleId: string; dueOn: string }) => Promise<void> | void;
  readonly recordTaskCompleted: (tenantId: string, task: ScheduledTask) => Promise<void> | void;
  /** The second person's verification of a completed check (Wave 2b · PA-03) — its own fact, under their own sign-in. */
  readonly recordTaskVerified: (tenantId: string, verification: { readonly taskId: string; readonly verifiedBy: string; readonly at: string }) => Promise<void> | void;
  readonly incidents: (tenantId: string) => Promise<readonly SafetyIncident[]> | readonly SafetyIncident[];
  readonly recordIncident: (tenantId: string, incident: SafetyIncident) => Promise<void> | void;
  readonly now: () => string;
}

export function facilitiesRoutes(deps: FacilitiesDeps): readonly Route[] {
  return [
    {
      api: 'API-11', method: 'POST', path: '/v1/facilities/schedules/:scheduleId',
      permission: 'facilities.schedule.manage', idempotent: true,
      handler: async (ctx) => {
        const scheduleId = ctx.params['scheduleId'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (typeof b['branchId'] !== 'string' || (b['branchId'] as string).trim() === ''
          || typeof b['title'] !== 'string' || (b['title'] as string).trim() === ''
          || typeof b['category'] !== 'string' || !CATEGORIES.includes(b['category'] as ScheduleCategory)
          || typeof b['frequency'] !== 'string' || !FREQUENCIES.includes(b['frequency'] as ScheduleFrequency)
          || typeof b['assignedRole'] !== 'string' || typeof b['escalatesTo'] !== 'string'
          || typeof b['evidenceRequired'] !== 'boolean' || typeof b['verificationRequired'] !== 'boolean') {
          throw apiError(400, {
            code: 'not_readable_as_a_schedule',
            whatHappened: 'A schedule needs a branch, title, category, frequency, assigned role, an escalation contact, and the evidence/verification flags.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the schedule fields. Nothing was set.',
          });
        }
        const schedule: MaintenanceSchedule = {
          scheduleId, tenantId: ctx.tenantId, branchId: b['branchId'] as string, title: b['title'] as string,
          category: b['category'] as ScheduleCategory, frequency: b['frequency'] as ScheduleFrequency,
          assignedRole: b['assignedRole'] as string, evidenceRequired: b['evidenceRequired'] as boolean,
          verificationRequired: b['verificationRequired'] as boolean, escalatesTo: b['escalatesTo'] as string,
          active: b['active'] !== false,
          ...(Number.isInteger(b['escalateAfterDays']) ? { escalateAfterDays: b['escalateAfterDays'] as number } : {}),
          ...(typeof b['assetId'] === 'string' ? { assetId: b['assetId'] } : {}),
        };
        await deps.recordSchedule(ctx.tenantId, schedule);
        return { status: 201, body: { scheduleId, category: schedule.category, evidenceRequired: schedule.evidenceRequired, verificationRequired: schedule.verificationRequired } };
      },
    },
    {
      // Raise a due instance of a schedule. It is not done until it is completed and accepted.
      api: 'API-11', method: 'POST', path: '/v1/facilities/schedules/:scheduleId/tasks/:taskId',
      permission: 'facilities.task.record', idempotent: true,
      handler: async (ctx) => {
        const scheduleId = ctx.params['scheduleId'] ?? '';
        const taskId = ctx.params['taskId'] ?? '';
        const dueOn = (ctx.body as { dueOn?: unknown } | null)?.dueOn;
        if (!isDate(dueOn)) {
          throw apiError(400, { code: 'task_needs_a_due_date', whatHappened: 'A scheduled task needs a due date (YYYY-MM-DD).', wasItSaved: 'not_saved', nextSafeAction: 'Send { "dueOn": "YYYY-MM-DD" }. Nothing was raised.' });
        }
        if (!(await deps.schedules(ctx.tenantId)).some((s) => s.scheduleId === scheduleId)) throw notFound(`facilities schedule ${scheduleId}`);
        await deps.recordTaskDue(ctx.tenantId, { taskId, scheduleId, dueOn });
        return { status: 201, body: { taskId, scheduleId, dueOn } };
      },
    },
    {
      // Complete a task — THE COMPLETER's act (Wave 2b · audit PA-03): who did it is the caller, never a name in the body;
      // a second person's verification is THEIR act, through …/verify, under their own sign-in. A tick without
      // required evidence is REFUSED (an accepted-with-a-note task shows green, and green is what everybody reads);
      // a safety check that needs verifying is recorded as done and WAITS — not accepted until a different person
      // verifies it.
      api: 'API-11', method: 'POST', path: '/v1/facilities/tasks/:taskId/complete',
      permission: 'facilities.task.record', idempotent: true,
      handler: async (ctx) => {
        const taskId = ctx.params['taskId'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        requireActorIsCaller(ctx, b, 'completedBy');
        if (b['verifiedBy'] !== undefined) throw secondPersonIsASeparateAct('verifiedBy', 'POST /v1/facilities/tasks/:taskId/verify');
        const due = (await deps.tasks(ctx.tenantId)).find((t) => t.taskId === taskId);
        if (due === undefined) throw notFound(`facilities task ${taskId}`);
        const schedule = (await deps.schedules(ctx.tenantId)).find((s) => s.scheduleId === due.scheduleId);
        if (schedule === undefined) throw notFound(`facilities schedule ${due.scheduleId}`);

        const task: ScheduledTask = {
          taskId, scheduleId: due.scheduleId, dueOn: due.dueOn,
          completedBy: ctx.userId,
          completedOn: isDate((b['completedOn'] as string ?? '').slice(0, 10)) ? (b['completedOn'] as string).slice(0, 10) : deps.now().slice(0, 10),
          ...(Array.isArray(b['evidenceRefs']) ? { evidenceRefs: (b['evidenceRefs'] as unknown[]).filter((r): r is string => typeof r === 'string') } : {}),
          ...(typeof b['note'] === 'string' ? { note: b['note'] } : {}),
        };
        const result = assessCompletion({ schedule, task });
        if (!result.accepted && result.outcome === 'not_verified') {
          // Done and recorded in the completer's name; accepted only when a DIFFERENT signed-in person verifies it.
          await deps.recordTaskCompleted(ctx.tenantId, task);
          return { status: 202, body: { taskId, scheduleId: due.scheduleId, accepted: false, outcome: result.outcome, awaitingVerification: true, completedBy: ctx.userId } };
        }
        if (!result.accepted) {
          throw apiError(422, {
            code: result.outcome,
            whatHappened: result.detail,
            wasItSaved: 'not_saved',
            nextSafeAction: 'The task is not accepted as done. Attach the evidence the schedule requires; a safety check is then verified by a second person under their own sign-in.',
          });
        }
        await deps.recordTaskCompleted(ctx.tenantId, task);
        return { status: 200, body: { taskId, scheduleId: due.scheduleId, accepted: true, outcome: result.outcome } };
      },
    },
    {
      // THE SECOND PERSON's act (Wave 2b · audit PA-03): verify a safety check somebody else completed, under your own
      // sign-in. The engine's rule still decides — the verifier cannot be the completer (§28), the evidence must be there.
      api: 'API-11', method: 'POST', path: '/v1/facilities/tasks/:taskId/verify',
      permission: 'facilities.task.record', idempotent: true,
      handler: async (ctx) => {
        const taskId = ctx.params['taskId'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        requireActorIsCaller(ctx, b, 'verifiedBy');
        const stored = (await deps.tasks(ctx.tenantId)).find((t) => t.taskId === taskId);
        if (stored === undefined) throw notFound(`facilities task ${taskId}`);
        const schedule = (await deps.schedules(ctx.tenantId)).find((s) => s.scheduleId === stored.scheduleId);
        if (schedule === undefined) throw notFound(`facilities schedule ${stored.scheduleId}`);
        if (stored.completedOn === undefined || (stored.completedBy ?? '').trim() === '') {
          throw apiError(422, {
            code: 'nothing_to_verify',
            whatHappened: `"${schedule.title}" has not been marked done yet — there is nothing to verify.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'The person who did the check marks it done first; then a second person verifies it.',
          });
        }
        if (stored.verifiedBy !== undefined) {
          return { status: 200, body: { taskId, scheduleId: stored.scheduleId, accepted: true, outcome: 'complete', verifiedBy: stored.verifiedBy, alreadyVerified: true } };
        }
        const task: ScheduledTask = { ...stored, verifiedBy: ctx.userId };
        const result = assessCompletion({ schedule, task });
        if (!result.accepted) {
          throw apiError(422, {
            code: result.outcome,
            whatHappened: result.detail,
            wasItSaved: 'not_saved',
            nextSafeAction: 'A safety check is verified by a DIFFERENT person from the one who did it, with its evidence attached.',
          });
        }
        await deps.recordTaskVerified(ctx.tenantId, { taskId, verifiedBy: ctx.userId, at: deps.now() });
        return { status: 200, body: { taskId, scheduleId: stored.scheduleId, accepted: true, outcome: result.outcome, verifiedBy: ctx.userId } };
      },
    },
    {
      // What is overdue, worst first — a compliance-linked miss (fire, pest, electrical, statutory)
      // escalates by itself; cleaning never does, so the fire check is never buried among mop alerts.
      api: 'API-11', method: 'GET', path: '/v1/facilities/overdue',
      permission: 'facilities.overdue.read',
      handler: async (ctx) => {
        const asAt = ctx.query['asOf'];
        if (!isDate(asAt)) throw apiError(400, { code: 'overdue_needs_a_date', whatHappened: 'The overdue list needs ?asOf=YYYY-MM-DD to measure lateness against.', wasItSaved: 'not_saved', nextSafeAction: 'Send the date. A list reads, it never writes.' });
        const overdue = findOverdue({ schedules: await deps.schedules(ctx.tenantId), tasks: await deps.tasks(ctx.tenantId), asAt });
        return { status: 200, body: { overdue, complianceRisks: overdue.filter((o) => o.level === 'compliance_risk').length, asAt: deps.now() } };
      },
    },
    {
      // Raise a safety incident — injury, near miss, fire, equipment failure, food safety, security.
      api: 'API-11', method: 'POST', path: '/v1/facilities/incidents/:incidentId',
      permission: 'facilities.incident.record', idempotent: true,
      handler: async (ctx) => {
        const incidentId = ctx.params['incidentId'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        requireActorIsCaller(ctx, b, 'recordedBy');
        if (!isStr(b['branchId']) || !INCIDENT_KINDS.includes(b['kind'] as IncidentKind) || !INCIDENT_SEVERITIES.includes(b['severity'] as IncidentSeverity)
          || !isDateTime(b['occurredAt']) || !isDateTime(b['reportedAt']) || !isStr(b['reportedBy']) || !isStr(b['description'])
          || (b['assetId'] !== undefined && !isStr(b['assetId']))) {
          throw apiError(400, {
            code: 'not_readable_as_an_incident',
            whatHappened: 'An incident needs a branch, a kind, a severity (minor/serious/reportable), when it happened and was reported, who reported it, and a description.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the incident fields. Nothing was raised.',
          });
        }
        const incident: SafetyIncident = {
          incidentId, tenantId: ctx.tenantId, branchId: b['branchId'] as string,
          kind: b['kind'] as IncidentKind, severity: b['severity'] as IncidentSeverity,
          occurredAt: b['occurredAt'] as string, reportedAt: b['reportedAt'] as string,
          // reportedBy is who reported it (may hold no login); recordedBy is the caller — never a name in the body (PA-03).
          reportedBy: b['reportedBy'] as string, recordedBy: ctx.userId, description: b['description'] as string,
          ...(Array.isArray(b['evidenceRefs']) ? { evidenceRefs: (b['evidenceRefs'] as unknown[]).filter((r): r is string => typeof r === 'string') } : {}),
          ...(isStr(b['assetId']) ? { assetId: b['assetId'] } : {}),
        };
        await deps.recordIncident(ctx.tenantId, incident);
        return { status: 201, body: { incidentId, kind: incident.kind, severity: incident.severity } };
      },
    },
    {
      // Close an incident — or refuse to. A close with no corrective action is refused; a serious one
      // needs evidence and a second person (§28); a reportable one cannot close with no statutory
      // notification on file — closing it internally is what makes everybody stop thinking about it (#6).
      api: 'API-11', method: 'POST', path: '/v1/facilities/incidents/:incidentId/close',
      permission: 'facilities.incident.record', idempotent: true,
      handler: async (ctx) => {
        const incidentId = ctx.params['incidentId'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        // Who closes is the CALLER (Wave 2b · PA-03) — a body naming somebody else is refused by name. actionTaken must be
        // a string but MAY be empty, so the engine can refuse a close with no corrective action as the business outcome
        // `no_action_recorded` (422) rather than this boundary masking it as merely malformed.
        requireActorIsCaller(ctx, b, 'closedBy');
        if (typeof b['actionTaken'] !== 'string' || (b['authorityNotifiedOn'] !== undefined && !isDate(b['authorityNotifiedOn']))) {
          throw apiError(400, { code: 'close_needs_what', whatHappened: 'Closing an incident needs the corrective action taken (actionTaken, which may be blank but must be present). Who closes it is taken from your sign-in.', wasItSaved: 'not_saved', nextSafeAction: 'Send actionTaken. Nothing was closed.' });
        }
        const incident = (await deps.incidents(ctx.tenantId)).find((i) => i.incidentId === incidentId);
        if (incident === undefined) throw notFound(`facilities incident ${incidentId}`);
        const at = deps.now();
        const result = closeIncident({
          incident, closedBy: ctx.userId, actionTaken: b['actionTaken'] as string, at,
          ...(isDate(b['authorityNotifiedOn']) ? { authorityNotifiedOn: b['authorityNotifiedOn'] } : {}),
        });
        if (!result.closed) {
          throw apiError(422, {
            code: result.outcome,
            whatHappened: result.detail,
            wasItSaved: 'not_saved',
            nextSafeAction: 'The incident stays open. Record the corrective action, attach evidence for a serious incident, have a second person close it, and file the statutory notification for a reportable one.',
          });
        }
        const closed: SafetyIncident = { ...incident, actionTaken: b['actionTaken'] as string, closedAt: at, closedBy: ctx.userId };
        await deps.recordIncident(ctx.tenantId, closed);
        return { status: 200, body: { incidentId, closed: true, outcome: result.outcome } };
      },
    },
    {
      // The pack an inspector would ask for, and whether it would SURVIVE — a pack that presents a
      // 60%-complete record as "the evidence" is worse than no pack, so every gap is named.
      api: 'API-11', method: 'GET', path: '/v1/facilities/evidence',
      permission: 'facilities.overdue.read',
      handler: async (ctx) => {
        const branchId = ctx.query['branchId'];
        const from = ctx.query['from'];
        const to = ctx.query['to'];
        if (!isStr(branchId) || !isDate(from) || !isDate(to)) throw apiError(400, { code: 'evidence_needs_branch_and_window', whatHappened: 'The compliance evidence pack needs ?branchId=, ?from=YYYY-MM-DD and ?to=YYYY-MM-DD.', wasItSaved: 'not_saved', nextSafeAction: 'Send all three. A pack reads, it never writes.' });
        const pack = buildComplianceEvidence({
          branchId, from, to,
          schedules: await deps.schedules(ctx.tenantId),
          tasks: await deps.tasks(ctx.tenantId),
          incidents: await deps.incidents(ctx.tenantId),
        });
        return { status: 200, body: pack };
      },
    },
  ];
}
