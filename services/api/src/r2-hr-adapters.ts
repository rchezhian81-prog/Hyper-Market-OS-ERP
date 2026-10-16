// R2 gap lane 3 — HR compliance wiring (R2 addendum C18 and C20), on the event store, each register append-only on
// its own stream (hard rules #2, #6):
//   • the working-time settings (every limit a setting, latest per limit), the roster publications and the annual
//     leave records — the C18 pack — read alongside the durable roster and attendance stores;
//   • the Internal Committee complaints register, its steps, the annual reports and their filings — C20 — on a
//     stream of its own, with every read and write sealed into the tenant's tamper-evident audit trail.
// Reads fold the streams; nothing here edits or removes a record.

import { createHash } from 'node:crypto';
import { makeEvent } from '../../../packages/contracts/src/event';
import type { EventStore } from '../../../packages/persistence/src/event-store';
import {
  UNSET_WORKING_TIME_SETTINGS, WORKING_TIME_LIMIT_KEYS,
  type WorkingTimeSettings, type WorkingTimeLimitKey, type LimitSetting, type LeaveRecord, type AttendanceFact,
  type PoshComplaint, type PoshStep, type PoshAnnualReport, type PoshReportFiling,
} from '../../../packages/workforce/src/index';
import type { HrComplianceDeps, WorkingTimeSettingChange, RosterPublication } from '../../finance/src/hr-compliance';
import { POSH_AUDIT_OBJECT, type PoshRegisterDeps } from '../../finance/src/posh-register';
import { STREAM, streamName, rosterStoreAdapter, auditTrailAdapter } from './adapters';

/** The C18 pack's own stream (settings, publications, leave). */
const HR_COMPLIANCE = streamName(STREAM.workforce, 'hr-compliance');
/** The C20 register's own stream — nothing else is written to it. */
const POSH_REGISTER = streamName(STREAM.workforce, 'posh-register');
/** The durable attendance store's stream (`attendanceStoreAdapter` in adapters.ts writes `AttendanceSet` here). */
const ROSTER_STREAM = streamName(STREAM.workforce, 'roster');

const digest = (key: string): string => createHash('sha256').update(key).digest('hex').slice(0, 24);
const all = async <T>(store: EventStore, tenantId: string, stream: string, type: string): Promise<T[]> =>
  (await store.readStream(tenantId, stream, { type })).map((e) => e.event.payload as T);
const put = async (store: EventStore, tenantId: string, stream: string, type: string, id: string, occurredAt: string, payload: unknown, source: string): Promise<boolean> => {
  const r = await store.append(tenantId, stream, makeEvent({ id: `${type}-${digest(id)}`, type, occurredAt, idempotencyKey: `${type}-${tenantId}-${digest(id)}`, source, payload }));
  return !r.deduped;
};

/** Fold the recorded setting changes over the unset defaults — the latest per target is in force. */
export function foldWorkingTimeSettings(changes: readonly WorkingTimeSettingChange[]): WorkingTimeSettings {
  const limits: Record<WorkingTimeLimitKey, LimitSetting> = { ...UNSET_WORKING_TIME_SETTINGS.limits };
  let publicHolidays = UNSET_WORKING_TIME_SETTINGS.publicHolidays;
  let utcOffsetMinutes = UNSET_WORKING_TIME_SETTINGS.utcOffsetMinutes;
  for (const c of changes) {
    if (c.target === 'publicHolidays') publicHolidays = c.publicHolidays;
    else if (c.target === 'utcOffsetMinutes') utcOffsetMinutes = c.utcOffsetMinutes;
    else if ((WORKING_TIME_LIMIT_KEYS as readonly string[]).includes(c.target)) limits[c.target] = c.limit;
  }
  return { limits, publicHolidays, utcOffsetMinutes };
}

export function hrComplianceAdapter(input: { readonly store: EventStore; readonly now: () => string }): HrComplianceDeps {
  const { store, now } = input;
  const roster = rosterStoreAdapter({ store, now });
  const auditTrail = auditTrailAdapter({ store });
  return {
    now,
    settings: async (tenantId) => foldWorkingTimeSettings(await all<WorkingTimeSettingChange>(store, tenantId, HR_COMPLIANCE, 'WorkingTimeSettingChanged')),
    recordSettingChange: async (tenantId, change, key) => {
      await put(store, tenantId, HR_COMPLIANCE, 'WorkingTimeSettingChanged', `${change.target}|${key}`, change.at, change, 'api/hr');
    },
    roster: async (tenantId) => roster.roster(tenantId),
    attendanceBetween: async (tenantId, from, to): Promise<readonly AttendanceFact[]> => {
      // Latest hours per (employee, date), as the attendance store folds them.
      const latest = new Map<string, AttendanceFact>();
      for (const r of await all<AttendanceFact>(store, tenantId, ROSTER_STREAM, 'AttendanceSet')) latest.set(`${r.employeeId}|${r.date}`, r);
      return [...latest.values()].filter((r) => r.date >= from && r.date <= to);
    },
    leave: (tenantId) => all<LeaveRecord>(store, tenantId, HR_COMPLIANCE, 'AnnualLeaveRecorded'),
    recordLeave: async (tenantId, record, key) => {
      await put(store, tenantId, HR_COMPLIANCE, 'AnnualLeaveRecorded', `${record.employeeId}|${record.date}|${key}`, record.recordedAt, record, 'api/hr');
    },
    publications: (tenantId) => all<RosterPublication>(store, tenantId, HR_COMPLIANCE, 'RosterPublished'),
    // One publication per id: the id alone keys the event, so a second publish under it is a dedup the route refuses.
    recordPublication: (tenantId, p) => put(store, tenantId, HR_COMPLIANCE, 'RosterPublished', p.publicationId, p.publishedAt, p, 'api/hr'),
    recordAudit: (tenantId, entry) => auditTrail.recordAudit(tenantId, entry),
  };
}

export function poshRegisterAdapter(input: { readonly store: EventStore; readonly now: () => string }): PoshRegisterDeps {
  const { store, now } = input;
  const auditTrail = auditTrailAdapter({ store });
  return {
    now,
    complaints: (tenantId) => all<PoshComplaint>(store, tenantId, POSH_REGISTER, 'PoshComplaintReceived'),
    // Keyed by the complaint id alone: the first receipt stands and a second is a dedup the route refuses by name.
    recordComplaint: (tenantId, c) => put(store, tenantId, POSH_REGISTER, 'PoshComplaintReceived', c.complaintId, c.recordedAt, c, 'api/hr-posh'),
    steps: (tenantId) => all<PoshStep>(store, tenantId, POSH_REGISTER, 'PoshComplaintStepRecorded'),
    recordStep: (tenantId, s) => put(store, tenantId, POSH_REGISTER, 'PoshComplaintStepRecorded', `${s.complaintId}|${s.stepId}`, s.recordedAt, s, 'api/hr-posh'),
    reports: (tenantId) => all<PoshAnnualReport>(store, tenantId, POSH_REGISTER, 'PoshAnnualReportGenerated'),
    recordReport: async (tenantId, r) => {
      await put(store, tenantId, POSH_REGISTER, 'PoshAnnualReportGenerated', `${r.year}|${r.generatedAt}|${r.generatedBy}`, r.generatedAt, r, 'api/hr-posh');
    },
    filings: (tenantId) => all<PoshReportFiling>(store, tenantId, POSH_REGISTER, 'PoshAnnualReportFiled'),
    recordFiling: (tenantId, f) => put(store, tenantId, POSH_REGISTER, 'PoshAnnualReportFiled', String(f.year), f.recordedAt, f, 'api/hr-posh'),
    recordAudit: (tenantId, entry) => auditTrail.recordAudit(tenantId, entry),
    accessLog: async (tenantId) => (await auditTrail.records(tenantId))
      .filter((r) => r.objectType === POSH_AUDIT_OBJECT)
      .map((r) => ({ actorId: r.actorId, action: r.action, objectId: r.objectId, at: r.at })),
  };
}
