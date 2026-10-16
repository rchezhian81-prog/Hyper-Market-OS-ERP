// R2 gap lane 3 — HR compliance wiring (R2 addendum C18 and C20), on the event store, each register append-only on
// its own stream (hard rules #2, #6):
//   • the working-time settings (every limit a setting, latest per limit), the roster publications and the annual
//     leave records — the C18 pack — read alongside the durable roster and attendance stores;
//   • the Internal Committee complaints register, its steps, the annual reports and their filings — C20 — on a
//     stream of its own, with every read and write sealed into the tenant's tamper-evident audit trail.
// Reads fold the streams; nothing here edits or removes a record.

import { createHash } from 'node:crypto';
import { makeEvent } from '../../../packages/contracts/src/event';
import type { EventStore, BatchEntry } from '../../../packages/persistence/src/event-store';
import {
  UNSET_WORKING_TIME_SETTINGS, WORKING_TIME_LIMIT_KEYS, LEAVE_TYPE_KEYS,
  type LeaveTypeKey, type LeaveTypeSetting,
  type WorkingTimeSettings, type WorkingTimeLimitKey, type LimitSetting, type LeaveRecord, type AttendanceFact,
  type PoshComplaint, type PoshStep, type PoshAnnualReport, type PoshReportFiling,
} from '../../../packages/workforce/src/index';
import { staffRosterVisibility, type HrComplianceDeps, type WorkingTimeSettingChange, type RosterPublication, type StaffRosterVisibility } from '../../finance/src/hr-compliance';
import type { StoredRoster } from '../../finance/src/roster-store';
import { POSH_AUDIT_OBJECT, type PoshRegisterDeps } from '../../finance/src/posh-register';
import { STREAM, streamName, rosterStoreAdapter, auditTrailAdapter, effectiveGrants, rolesHeldNow, isPersonNow, outsideLoginOf, ROLE_GRANTED, ROLE_REVOKED } from './adapters';
import { ROLE_CATALOGUE } from './roles';
import { COMMITTEE_ROLE_ID, type CommitteeMembershipDeps, type CommitteeChange } from '../../identity/src/committee-membership';

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
  const leaveTypes: Record<LeaveTypeKey, LeaveTypeSetting> = { ...UNSET_WORKING_TIME_SETTINGS.leaveTypes };
  for (const c of changes) {
    if (c.target === 'publicHolidays') publicHolidays = c.publicHolidays;
    else if (c.target === 'utcOffsetMinutes') utcOffsetMinutes = c.utcOffsetMinutes;
    else if (c.target === 'leaveType') { if ((LEAVE_TYPE_KEYS as readonly string[]).includes(c.leaveType)) leaveTypes[c.leaveType] = c.setting; }
    else if ((WORKING_TIME_LIMIT_KEYS as readonly string[]).includes(c.target)) limits[c.target] = c.limit;
  }
  return { limits, publicHolidays, utcOffsetMinutes, leaveTypes };
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

/**
 * OB-166 "A": what staff may see of the roster — only the shifts of a branch's week that is published NOW. Read by
 * GET /v1/hr/workforce/my-roster (and shown beside the manager's roster), over the same settings and publications the
 * publish route writes.
 */
export function staffRosterVisibilityAdapter(input: { readonly store: EventStore; readonly now: () => string }): (tenantId: string, roster: StoredRoster) => Promise<StaffRosterVisibility> {
  const hr = hrComplianceAdapter(input);
  return async (tenantId, roster) => staffRosterVisibility(await hr.settings(tenantId), roster, await hr.publications(tenantId));
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

/**
 * OB-165 "A": Internal Committee membership on the identity ledger every reader of authority folds — an addition is a
 * `RoleGranted` of `internal_committee` (all branches), a removal a `RoleRevoked` per committee grant the person holds,
 * in ONE batch, idempotent on the change id. Who asked (the owner) and who confirmed ride on each event.
 */
export function committeeMembershipAdapter(input: { readonly store: EventStore; readonly now: () => string }): Omit<CommitteeMembershipDeps, 'recordAudit' | 'approvals'> {
  const { store, now } = input;
  return {
    now,
    rolesHeldBy: (tenantId, userId) => rolesHeldNow(store, tenantId, userId, now()),
    committeeGrantsOf: async (tenantId, userId) => (await effectiveGrants(store, tenantId))
      .filter((g) => g.userId === userId && g.roleId === COMMITTEE_ROLE_ID).map((g) => ({ branchScope: g.branchScope })),
    roles: () => ROLE_CATALOGUE,
    isPerson: (tenantId, userId) => isPersonNow(store, tenantId, userId),
    outsideLoginOf: (tenantId, userId) => outsideLoginOf(store, tenantId, userId, now()),
    recordChange: async (tenantId, c: CommitteeChange) => {
      const provenance = { kind: 'internal_committee_change', changeId: c.changeId, action: c.action, requestedBy: c.requestedBy, approvedBy: c.approvedBy, reason: c.reason };
      const entries: BatchEntry[] = c.action === 'add'
        ? [{ stream: STREAM.identity, event: makeEvent({
          id: `grant-committee-${c.changeId}`, type: ROLE_GRANTED, occurredAt: c.at, idempotencyKey: `grant-${tenantId}-committee-${c.changeId}`, source: 'api/identity',
          payload: {
            userId: c.userId, roleId: COMMITTEE_ROLE_ID, branchScope: 'all',
            request: { grantId: `committee-${c.changeId}`, userId: c.userId, roleId: COMMITTEE_ROLE_ID, branchScope: 'all', requestedBy: c.requestedBy, approvedBy: c.approvedBy, requestedAt: c.at },
            provenance,
          },
        }) }]
        : c.revokes.map((g, i) => ({ stream: STREAM.identity, event: makeEvent({
          id: `revoke-committee-${c.changeId}-${i}`, type: ROLE_REVOKED, occurredAt: c.at, idempotencyKey: `revoke-${tenantId}-committee-${c.changeId}-${i}`, source: 'api/identity',
          payload: { userId: c.userId, roleId: COMMITTEE_ROLE_ID, branchScope: g.branchScope, provenance },
        }) }));
      if (entries.length > 0) await store.appendBatch(tenantId, entries);
    },
  };
}
