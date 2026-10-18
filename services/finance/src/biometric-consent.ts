// C21 (R3, OB-138) — fingerprint attendance consent and the attendance marks it governs, on head office's API.
//
//   POST /v1/hr/workforce/biometric-consent/:employeeId/:eventId   the person's OWN decision: given / refused / withdrawn
//   GET  /v1/hr/workforce/biometric-consent/:employeeId            their state, history and the methods they may use
//   GET  /v1/hr/workforce/biometric-consent                        every person's state (a manager's read)
//   POST /v1/hr/workforce/attendance-marks/:markId                 a clock-in / clock-out, by fingerprint or PIN
//   GET  /v1/hr/workforce/attendance-marks?date=                   the marks of a day
//
// The rules are `packages/workforce/src/biometric-consent.ts`. Consent events are append-only (hard rule #2) and each is
// sealed into the audit trail. A fingerprint mark without consent given is refused by name
// (`fingerprint_consent_not_given`); a PIN mark is always taken, and records exactly what a fingerprint mark records
// (only the method differs). Nothing here asks for, takes or stores an Aadhaar (or any identity) number, or any
// fingerprint data — a body carrying one is refused (`identity_number_not_collected`) so it never reaches the ledger.

import type { Route, RequestContext } from '../../kernel/src/index';
import { apiError, assertRecordBranchInScope, scopeOf } from '../../kernel/src/index';
import {
  consentStateOf, methodsAllowed, identityNumberFieldsIn, BIOMETRIC_PURPOSE, CONSENT_DECISIONS, ATTENDANCE_METHODS,
  type BiometricConsentEvent, type ConsentDecision, type AttendanceMethod,
} from '../../../packages/workforce/src/biometric-consent';
import type { Employee } from '../../../packages/workforce/src/workforce';
import type { AuditEntry } from '../../../packages/audit/src/index';

export interface AttendanceMark {
  readonly markId: string;
  readonly employeeId: string;
  readonly kind: 'in' | 'out';
  readonly method: AttendanceMethod;
  readonly at: string;
  readonly date: string;
  readonly recordedBy: string;
}

export interface BiometricConsentDeps {
  readonly now: () => string;
  readonly events: (tenantId: string) => Promise<readonly BiometricConsentEvent[]>;
  readonly recordEvent: (tenantId: string, e: BiometricConsentEvent) => Promise<void>;
  readonly marks: (tenantId: string, date?: string) => Promise<readonly AttendanceMark[]>;
  readonly recordMark: (tenantId: string, m: AttendanceMark) => Promise<void>;
  readonly employees: (tenantId: string) => Promise<readonly Employee[]>;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const refuseIdentityNumbers = (body: unknown): void => {
  const fields = identityNumberFieldsIn(body);
  if (fields.length > 0) {
    throw apiError(400, {
      code: 'identity_number_not_collected',
      whatHappened: `Attendance and its consent never need an Aadhaar or any identity number, and this shop does not collect one (C21). Refused: ${fields.join(', ')}.`,
      wasItSaved: 'not_saved', nextSafeAction: 'Send it again without that field. Nothing was saved.',
    });
  }
};
const own = (ctx: RequestContext, employeeId: string, what: string): void => {
  if (ctx.userId !== employeeId) {
    throw apiError(403, {
      code: 'consent_is_the_persons_own', whatHappened: `${what} is ${employeeId}'s own, in their own sign-in — nobody may record it for them.`,
      wasItSaved: 'not_saved', nextSafeAction: `${employeeId} records it themself. Nothing was changed.`,
    });
  }
};

export function biometricConsentRoutes(deps: BiometricConsentDeps): readonly Route[] {
  const employeeOf = async (t: string, id: string) => (await deps.employees(t)).find((e) => e.employeeId === id);
  return [
    {
      api: 'API-11', method: 'POST', path: '/v1/hr/workforce/biometric-consent/:employeeId/:eventId',
      permission: 'workforce.consent.self', idempotent: true,
      handler: async (ctx) => {
        const employeeId = (ctx.params['employeeId'] ?? '').trim();
        const eventId = (ctx.params['eventId'] ?? '').trim();
        refuseIdentityNumbers(ctx.body);
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (employeeId === '' || eventId === '' || !(CONSENT_DECISIONS as readonly unknown[]).includes(b['decision']) || !isStr(b['noticeRef']) || (b['purpose'] !== undefined && b['purpose'] !== BIOMETRIC_PURPOSE)) {
          throw apiError(400, { code: 'not_readable_as_a_consent', whatHappened: `A consent decision needs { decision: ${CONSENT_DECISIONS.join(' / ')}, noticeRef (the notice shown) } for the purpose "${BIOMETRIC_PURPOSE}" only.`, wasItSaved: 'not_saved', nextSafeAction: 'Send the decision with the notice it was made on. Nothing was saved.' });
        }
        own(ctx, employeeId, 'A fingerprint consent');
        const prior = (await deps.events(ctx.tenantId)).find((e) => e.eventId === eventId);
        if (prior !== undefined) return { status: 200, body: { event: prior, alreadyRecorded: true, ...consentStateOf(await deps.events(ctx.tenantId), employeeId), allowedMethods: methodsAllowed(consentStateOf(await deps.events(ctx.tenantId), employeeId).state) } };
        const e: BiometricConsentEvent = { eventId, employeeId, purpose: BIOMETRIC_PURPOSE, decision: b['decision'] as ConsentDecision, noticeRef: (b['noticeRef'] as string).trim(), decidedBy: ctx.userId, at: deps.now() };
        await deps.recordEvent(ctx.tenantId, e);
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: `biometric_consent.${e.decision}`, objectType: 'biometric_consent', objectId: employeeId, at: e.at,
          origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null }, before: null,
          after: { purpose: e.purpose, decision: e.decision, noticeRef: e.noticeRef }, reason: 'the person\'s own decision (DPDP s.7)', correlationId: eventId,
        });
        const state = consentStateOf(await deps.events(ctx.tenantId), employeeId);
        return { status: 201, body: { event: e, state: state.state, allowedMethods: methodsAllowed(state.state) } };
      },
    },
    {
      api: 'API-11', method: 'GET', path: '/v1/hr/workforce/biometric-consent/:employeeId',
      permission: 'workforce.consent.self',
      handler: async (ctx) => {
        const employeeId = (ctx.params['employeeId'] ?? '').trim();
        own(ctx, employeeId, 'This consent record');
        const s = consentStateOf(await deps.events(ctx.tenantId), employeeId);
        return { status: 200, body: { employeeId, purpose: BIOMETRIC_PURPOSE, ...s, allowedMethods: methodsAllowed(s.state), identityNumberNeeded: false } };
      },
    },
    {
      api: 'API-11', method: 'GET', path: '/v1/hr/workforce/biometric-consent',
      permission: 'workforce.roster.read',
      handler: async (ctx) => {
        const held = scopeOf(ctx);
        const events = await deps.events(ctx.tenantId);
        const people = (await deps.employees(ctx.tenantId)).filter((e) => held === 'all' || held.includes(e.branchId));
        return { status: 200, body: { people: people.map((p) => { const s = consentStateOf(events, p.employeeId); return { employeeId: p.employeeId, name: p.name, state: s.state, since: s.since, allowedMethods: methodsAllowed(s.state) }; }), asAt: deps.now() } };
      },
    },
    {
      api: 'API-11', method: 'POST', path: '/v1/hr/workforce/attendance-marks/:markId',
      permission: 'workforce.attendance.mark', idempotent: true,
      handler: async (ctx) => {
        const markId = (ctx.params['markId'] ?? '').trim();
        refuseIdentityNumbers(ctx.body);
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (markId === '' || !isStr(b['employeeId']) || (b['kind'] !== 'in' && b['kind'] !== 'out') || !(ATTENDANCE_METHODS as readonly unknown[]).includes(b['method'])) {
          throw apiError(400, { code: 'not_readable_as_an_attendance_mark', whatHappened: `A mark needs { employeeId, kind: in | out, method: ${ATTENDANCE_METHODS.join(' / ')} }.`, wasItSaved: 'not_saved', nextSafeAction: 'Send the mark. Nothing was saved.' });
        }
        const employeeId = (b['employeeId'] as string).trim();
        own(ctx, employeeId, 'An attendance mark');
        const emp = await employeeOf(ctx.tenantId, employeeId);
        if (emp !== undefined) assertRecordBranchInScope(ctx, emp.branchId);
        const prior = (await deps.marks(ctx.tenantId)).find((m) => m.markId === markId);
        if (prior !== undefined) return { status: 200, body: { mark: prior, alreadyRecorded: true } };
        const method = b['method'] as AttendanceMethod;
        if (method === 'fingerprint') {
          const s = consentStateOf(await deps.events(ctx.tenantId), employeeId);
          if (s.state !== 'given') {
            throw apiError(403, {
              code: 'fingerprint_consent_not_given',
              whatHappened: `${employeeId} has ${s.state === 'not_asked' ? 'not given' : s.state} consent to fingerprint attendance, so the fingerprint method cannot be used (C21, DPDP s.7).`,
              wasItSaved: 'not_saved', nextSafeAction: 'Use the PIN method — it records attendance exactly the same way. Nothing was saved.',
            });
          }
        }
        // The time on the attendance device (it may be relayed late), never later than head office's own clock.
        const now = deps.now();
        const at = typeof b['at'] === 'string' && !Number.isNaN(Date.parse(b['at'])) ? new Date(Date.parse(b['at'])).toISOString() : now;
        if (Date.parse(at) > Date.parse(now) + 5 * 60_000) throw apiError(422, { code: 'mark_in_the_future', whatHappened: `The mark says ${at}, later than now (${now}).`, wasItSaved: 'not_saved', nextSafeAction: 'Check the device clock. Nothing was saved.' });
        const m: AttendanceMark = { markId, employeeId, kind: b['kind'] as 'in' | 'out', method, at, date: at.slice(0, 10), recordedBy: ctx.userId };
        await deps.recordMark(ctx.tenantId, m);
        return { status: 201, body: { mark: m } };
      },
    },
    {
      api: 'API-11', method: 'GET', path: '/v1/hr/workforce/attendance-marks',
      permission: 'workforce.roster.read',
      handler: async (ctx) => {
        const date = ctx.query['date'];
        if (date === undefined || !DAY.test(date)) throw apiError(400, { code: 'attendance_needs_a_date', whatHappened: 'Reading attendance marks needs ?date=YYYY-MM-DD.', wasItSaved: 'not_saved', nextSafeAction: 'Send the date.' });
        const held = scopeOf(ctx);
        const branchOf = new Map((await deps.employees(ctx.tenantId)).map((e) => [e.employeeId, e.branchId] as const));
        const marks = (await deps.marks(ctx.tenantId, date)).filter((m) => { const br = branchOf.get(m.employeeId); return held === 'all' || (br !== undefined && held.includes(br)); });
        return { status: 200, body: { date, marks, count: marks.length } };
      },
    },
  ];
}
