// OB-507 (owner, 28 Oct 2026, in writing) · M25-FR-01 "rosters/attendance cache, sync on reconnect" — an attendance mark
// (a clock-in or clock-out) made on the store computer's self-service page with the line down, CARRIED here by the box.
//
//   POST /v1/hr/workforce/attendance-marks/:markId/synced      the box's relay (`workforce.attendance.sync`, the box only)
//
// Head office trusts the FACT the box kept (who, in or out, when — the mark id is the device's own, so a re-sent mark is ONE
// mark, §31.1) and re-runs every JUDGEMENT on its own records:
//   • the person must be on the roster at the box's own store (its credential speaks for its store only), and must hold the
//     right to mark their own attendance (`workforce.attendance.mark`) — re-checked from THEIR grants, refused by name;
//   • a mark dated later than head office's clock is refused (the box's clock is wrong) — kept at the store, visible;
//   • the same mark again is the same mark (200); a DIFFERENT mark under the same id is a CONFLICT, refused by name and kept at
//     the store for a person (hard rule #10) — never a silent last-write-wins;
//   • a mark out of order against what head office already holds for that person that day (a second "in" with no "out"
//     between, or an "out" with no "in") is RECORDED — it happened — and flagged on the record, so the manager's attendance
//     read shows it as an exception (P-03), never quietly corrected.
// Append-only: one `AttendanceMarked` per mark id, never edited (hard rule #2). The fingerprint method is not offered at the
// store computer (C21's consent gate lives at head office), so a relayed mark is a PIN mark. No identity number is ever
// accepted (C21). Each relayed mark is sealed into the audit trail with the box that carried it.

import type { Route, RequestContext } from '../../kernel/src/index';
import { apiError, assertRecordBranchInScope } from '../../kernel/src/index';
import { identityNumberFieldsIn } from '../../../packages/workforce/src/biometric-consent';
import type { Employee } from '../../../packages/workforce/src/workforce';
import type { AuditEntry } from '../../../packages/audit/src/index';
import { shopClock, type ShopCalendarOf } from '../../../packages/calendar/src/shop-clock';
import type { AttendanceMark, AttendanceMarkException } from './biometric-consent';

export interface SyncedAttendanceDeps {
  readonly now: () => string;
  readonly calendar?: ShopCalendarOf;
  readonly marks: (tenantId: string, date?: string) => Promise<readonly AttendanceMark[]>;
  readonly recordMark: (tenantId: string, m: AttendanceMark) => Promise<void>;
  readonly employees: (tenantId: string) => Promise<readonly Employee[]>;
  /** The person's OWN grants at head office (undefined when head office does not know them). */
  readonly permissionsOf: (tenantId: string, userId: string) => Promise<readonly string[] | undefined>;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
}

/** The device event the self-service page saves and the box relays (packages/sync/src/device-relay.ts). */
export const ATTENDANCE_MARKED_EVENT = 'AttendanceMarked';
/** The relay right: held by the store computer (and the owner, so he can approve granting it — OB-36). */
export const ATTENDANCE_SYNC_PERMISSION = 'workforce.attendance.sync';

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

const refuse = (status: number, code: string, whatHappened: string, nextSafeAction: string): never => {
  throw apiError(status, { code, whatHappened, wasItSaved: 'not_saved', nextSafeAction });
};

/** The same mark as one head office holds: the same person, the same in/out, the same moment. */
const sameMark = (a: AttendanceMark, b: { employeeId: string; kind: string; at: string }): boolean =>
  a.employeeId === b.employeeId && a.kind === b.kind && Date.parse(a.at) === Date.parse(b.at);

/** What is out of order about a mark against the person's other marks that day (the relayed mark not among them). */
export function attendanceExceptions(dayMarks: readonly AttendanceMark[], mark: { readonly employeeId: string; readonly kind: 'in' | 'out'; readonly at: string }): AttendanceMarkException[] {
  const before = dayMarks
    .filter((m) => m.employeeId === mark.employeeId && Date.parse(m.at) < Date.parse(mark.at))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const last = before[before.length - 1];
  if (last !== undefined && last.kind === mark.kind) return ['repeats_the_last_mark'];
  if (last === undefined && mark.kind === 'out') return ['out_without_in'];
  return [];
}

export function syncedAttendanceRoutes(deps: SyncedAttendanceDeps): readonly Route[] {
  return [
    {
      // Body: { markId (= path), employeeId, kind: in | out, method: pin, at, storeId, source? }.
      api: 'API-11', method: 'POST', path: '/v1/hr/workforce/attendance-marks/:markId/synced',
      permission: ATTENDANCE_SYNC_PERMISSION, idempotent: true,
      handler: async (ctx: RequestContext) => {
        const markId = (ctx.params['markId'] ?? '').trim();
        const fields = identityNumberFieldsIn(ctx.body);
        if (fields.length > 0) {
          refuse(400, 'identity_number_not_collected', `Attendance never needs an Aadhaar or any identity number, and this shop does not collect one (C21). Refused: ${fields.join(', ')}.`, 'Keep it at the store; a person must look. Nothing was saved.');
        }
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (markId === '' || b['markId'] !== markId || !isStr(b['employeeId']) || (b['kind'] !== 'in' && b['kind'] !== 'out')
          || b['method'] !== 'pin' || !isStr(b['at']) || Number.isNaN(Date.parse(b['at'])) || !isStr(b['storeId'])) {
          refuse(400, 'not_readable_as_a_relayed_attendance_mark',
            'This could not be read as an attendance mark from the store — it needs the markId matching the path, the person (employeeId), in or out, the PIN method, when it was made (at) and the store (storeId).',
            'Do not discard it at the store. Keep it in the queue and raise it.');
        }
        const employeeId = (b['employeeId'] as string).trim();
        const kind = b['kind'] as 'in' | 'out';
        const at = new Date(Date.parse(b['at'] as string)).toISOString();
        const storeId = (b['storeId'] as string).trim();
        const now = deps.now();
        if (Date.parse(at) > Date.parse(now) + 5 * 60_000) {
          refuse(422, 'mark_in_the_future', `The mark says ${at}, later than head office's clock (${now}) — the store computer's clock may be wrong.`, 'Kept at the store; check the store computer\'s clock. Nothing was saved.');
        }
        // The same mark again — a re-sent queue item — is the same mark; a DIFFERENT one under the same id is a conflict.
        const prior = (await deps.marks(ctx.tenantId)).find((m) => m.markId === markId);
        if (prior !== undefined) {
          if (sameMark(prior, { employeeId, kind, at })) return { status: 200, body: { mark: prior, alreadyRecorded: true } };
          refuse(422, 'mark_conflicts_with_record',
            `Head office already holds attendance mark ${markId} (${prior.employeeId}, ${prior.kind === 'in' ? 'in' : 'out'} at ${prior.at}); this store's mark under the same id says ${employeeId}, ${kind} at ${at}. The two cannot both be right.`,
            'Kept at the store for a manager to compare. Nothing was changed.');
        }
        // The person: on the roster at THIS store (the box speaks for its store only), holding their own right to mark.
        const emp = (await deps.employees(ctx.tenantId)).find((e) => e.employeeId === employeeId);
        if (emp === undefined) {
          refuse(422, 'person_not_on_the_roster', `${employeeId} is not on head office's staff roster, so an attendance mark cannot be booked for them.`, 'Kept at the store; a manager adds the person to the roster, then the mark is sent again. Nothing was saved.');
        }
        assertRecordBranchInScope(ctx, emp!.branchId);
        if (emp!.branchId !== storeId) {
          refuse(422, 'person_not_at_this_store', `${employeeId} is on the roster at ${emp!.branchId}, not at ${storeId}.`, 'Kept at the store for a manager to look at. Nothing was saved.');
        }
        const held = await deps.permissionsOf(ctx.tenantId, employeeId);
        if (held === undefined || !held.includes('workforce.attendance.mark')) {
          refuse(422, 'person_may_not_mark_attendance', `${employeeId} ${held === undefined ? 'holds no sign-in head office knows' : 'does not hold the right to mark their own attendance (workforce.attendance.mark)'} — re-checked from their own grants.`, 'Kept at the store; a person must look. Nothing was saved.');
        }
        const date = await shopClock(deps.calendar).dateOf(ctx.tenantId, at);
        const exceptions = attendanceExceptions(await deps.marks(ctx.tenantId, date), { employeeId, kind, at });
        const relayed = { relayedBy: ctx.userId, source: isStr(b['source']) ? (b['source'] as string) : 'store-computer', storeId };
        const mark: AttendanceMark = {
          markId, employeeId, kind, method: 'pin', at, date, recordedBy: employeeId, relayed,
          ...(exceptions.length === 0 ? {} : { exceptions }),
        };
        await deps.recordMark(ctx.tenantId, mark);
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: employeeId, action: 'workforce.attendance.mark', objectType: 'attendance_mark', objectId: markId, at,
          origin: { tenantId: ctx.tenantId, branchId: storeId, capturedOffline: true },
          before: null,
          after: { kind, date, relayedBy: ctx.userId, source: relayed.source, exceptions: exceptions.join(',') },
          correlationId: markId,
        });
        return { status: 202, body: { mark, alreadyRecorded: false } };
      },
    },
  ];
}
