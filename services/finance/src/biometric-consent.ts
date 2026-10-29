// C21 (R3, OB-138) — fingerprint attendance consent and the attendance marks it governs, on head office's API.
//
//   POST /v1/hr/workforce/biometric-consent/:employeeId/:eventId   the person's OWN decision: given / refused / withdrawn
//   GET  /v1/hr/workforce/biometric-consent/:employeeId            their state, history and the methods they may use
//   GET  /v1/hr/workforce/biometric-consent                        every person's state (a manager's read)
//   POST /v1/hr/workforce/attendance-marks/:markId                 a clock-in / clock-out, by fingerprint or PIN
//   GET  /v1/hr/workforce/attendance-marks?date=                   the marks of a day
//   POST /v1/hr/workforce/biometric-consent-notices/:noticeRef/sign  OB-197: the owner records that he signed the notice
//   GET  /v1/hr/workforce/biometric-consent-notices                 the notices signed by the owner (anyone may read)
//
// The rules are `packages/workforce/src/biometric-consent.ts`. Consent events are append-only (hard rule #2) and each is
// sealed into the audit trail. A fingerprint mark without consent given is refused by name
// (`fingerprint_consent_not_given`); a PIN mark is always taken, and records exactly what a fingerprint mark records
// (only the method differs). Nothing here asks for, takes or stores an Aadhaar (or any identity) number, or any
// fingerprint data — a body carrying one is refused (`identity_number_not_collected`) so it never reaches the ledger.
//
// OB-197 "A": consent to the fingerprint method is GIVEN only against a notice whose status is "signed by owner"; until
// one is signed the fingerprint method is refused by name (`consent_notice_not_signed`) and PIN works. Only the owner
// records a signature (`workforce.consent.notice.sign`, held by the owner role alone), and it is append-only.

import type { Route, RequestContext } from '../../kernel/src/index';
import { apiError, assertRecordBranchInScope, scopeOf } from '../../kernel/src/index';
import {
  consentStateOf, identityNumberFieldsIn, BIOMETRIC_PURPOSE, CONSENT_DECISIONS, ATTENDANCE_METHODS,
  fingerprintVerdict, methodsAllowedNow, signedNoticeRefs, NOTICE_SIGNED_BY_OWNER,
  type BiometricConsentEvent, type BiometricConsentNotice, type ConsentDecision, type AttendanceMethod,
} from '../../../packages/workforce/src/biometric-consent';
import type { Employee } from '../../../packages/workforce/src/workforce';
import type { AuditEntry } from '../../../packages/audit/src/index';
import { shopClock, type ShopCalendarOf } from '../../../packages/calendar/src/shop-clock';
import { addDays } from '../../../packages/workforce/src/working-time';
import { attendancePairing, nightShiftSpansOf, type RosteredShift } from './attendance-pairing';

export interface AttendanceMark {
  readonly markId: string;
  readonly employeeId: string;
  readonly kind: 'in' | 'out';
  readonly method: AttendanceMethod;
  readonly at: string;
  readonly date: string;
  readonly recordedBy: string;
  /** OB-507: a mark made on the store computer with the line down and carried here — who carried it, from where. */
  readonly relayed?: { readonly relayedBy: string; readonly source: string; readonly storeId: string };
  /**
   * OB-507 · hard rule #10: what head office found out of order about a relayed mark WHEN IT ARRIVED — kept on the record as
   * evidence, never edited. The manager's read judges every mark afresh from all the marks it holds then
   * (./attendance-pairing.ts), so a late-arriving "in" clears an out's exception without touching this record.
   */
  readonly exceptions?: readonly AttendanceMarkException[];
}

/**
 * A mark that repeats the person's last mark (two "in"s, or two "out"s), an "out" with no "in" to pair with, or an "in" never
 * followed by an "out" once its day (or its rostered night shift) is over.
 */
export type AttendanceMarkException = 'repeats_the_last_mark' | 'out_without_in' | 'in_without_out';

export interface BiometricConsentDeps {
  readonly now: () => string;
  /** R1b (M01-FR-02): the shop's calendar — an attendance mark's date (pay, overtime) is the shop's date, never UTC. */
  readonly calendar?: ShopCalendarOf;
  readonly events: (tenantId: string) => Promise<readonly BiometricConsentEvent[]>;
  readonly recordEvent: (tenantId: string, e: BiometricConsentEvent) => Promise<void>;
  readonly marks: (tenantId: string, date?: string) => Promise<readonly AttendanceMark[]>;
  readonly recordMark: (tenantId: string, m: AttendanceMark) => Promise<void>;
  readonly employees: (tenantId: string) => Promise<readonly Employee[]>;
  /** OB-507: each person's shifts on head office's committed roster — a shift crossing midnight pairs a night "in" and "out". */
  readonly rosteredShifts?: (tenantId: string) => Promise<readonly RosteredShift[]>;
  /** OB-197: the consent notices the owner signed, and the way his signature is recorded (append-only). */
  readonly notices: (tenantId: string) => Promise<readonly BiometricConsentNotice[]>;
  readonly recordNotice: (tenantId: string, n: BiometricConsentNotice) => Promise<void>;
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
  const signed = async (t: string) => signedNoticeRefs(await deps.notices(t));
  const allowedFor = async (t: string, events: readonly BiometricConsentEvent[], employeeId: string) => methodsAllowedNow(fingerprintVerdict(events, employeeId, await signed(t)));
  return [
    {
      // OB-197: the owner records, in his own sign-in, that he signed the fingerprint-attendance consent notice. Body:
      // { documentPath } — where the signed notice is kept. Once per notice; the same again is a no-op.
      api: 'API-11', method: 'POST', path: '/v1/hr/workforce/biometric-consent-notices/:noticeRef/sign',
      permission: 'workforce.consent.notice.sign', idempotent: true,
      handler: async (ctx) => {
        const noticeRef = (ctx.params['noticeRef'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (noticeRef === '' || !isStr(b['documentPath'])) {
          throw apiError(400, { code: 'not_readable_as_a_notice_signature', whatHappened: 'Recording a signed notice needs the noticeRef in the path and { documentPath } — where the signed notice is kept.', wasItSaved: 'not_saved', nextSafeAction: 'Send the document path. Nothing was saved.' });
        }
        const prior = (await deps.notices(ctx.tenantId)).find((n) => n.noticeRef === noticeRef);
        if (prior !== undefined) return { status: 200, body: { notice: prior, alreadySigned: true } };
        const n: BiometricConsentNotice = { noticeRef, status: NOTICE_SIGNED_BY_OWNER, documentPath: (b['documentPath'] as string).trim(), signedBy: ctx.userId, signedAt: deps.now() };
        await deps.recordNotice(ctx.tenantId, n);
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: 'biometric_consent.notice.signed', objectType: 'biometric_consent_notice', objectId: noticeRef, at: n.signedAt,
          origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null }, before: null,
          after: { status: n.status, documentPath: n.documentPath }, reason: 'the owner signed the fingerprint-attendance consent notice (OB-197)', correlationId: noticeRef,
        });
        return { status: 201, body: { notice: n } };
      },
    },
    {
      api: 'API-11', method: 'GET', path: '/v1/hr/workforce/biometric-consent-notices',
      permission: 'workforce.consent.self',
      handler: async (ctx) => {
        const notices = await deps.notices(ctx.tenantId);
        return { status: 200, body: { notices, fingerprintInUse: notices.length > 0, asAt: deps.now() } };
      },
    },
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
        if (prior !== undefined) { const ev = await deps.events(ctx.tenantId); return { status: 200, body: { event: prior, alreadyRecorded: true, ...consentStateOf(ev, employeeId), allowedMethods: await allowedFor(ctx.tenantId, ev, employeeId) } }; }
        // OB-197: consent is GIVEN only on a notice the owner signed. Refusing or withdrawing never needs one.
        if (b['decision'] === 'given' && !(await signed(ctx.tenantId)).has((b['noticeRef'] as string).trim())) {
          throw apiError(409, {
            code: 'consent_notice_not_signed',
            whatHappened: `Notice ${(b['noticeRef'] as string).trim()} has not been signed by the owner, so consent to fingerprint attendance cannot be given on it yet (OB-197, DPDP s.5).`,
            wasItSaved: 'not_saved', nextSafeAction: 'Keep using the PIN method — it records attendance exactly the same way. Consent can be given once the owner has signed the notice. Nothing was saved.',
          });
        }
        const e: BiometricConsentEvent = { eventId, employeeId, purpose: BIOMETRIC_PURPOSE, decision: b['decision'] as ConsentDecision, noticeRef: (b['noticeRef'] as string).trim(), decidedBy: ctx.userId, at: deps.now() };
        await deps.recordEvent(ctx.tenantId, e);
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: `biometric_consent.${e.decision}`, objectType: 'biometric_consent', objectId: employeeId, at: e.at,
          origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null }, before: null,
          after: { purpose: e.purpose, decision: e.decision, noticeRef: e.noticeRef }, reason: 'the person\'s own decision (DPDP s.7)', correlationId: eventId,
        });
        const after = await deps.events(ctx.tenantId);
        return { status: 201, body: { event: e, state: consentStateOf(after, employeeId).state, allowedMethods: await allowedFor(ctx.tenantId, after, employeeId) } };
      },
    },
    {
      api: 'API-11', method: 'GET', path: '/v1/hr/workforce/biometric-consent/:employeeId',
      permission: 'workforce.consent.self',
      handler: async (ctx) => {
        const employeeId = (ctx.params['employeeId'] ?? '').trim();
        own(ctx, employeeId, 'This consent record');
        const events = await deps.events(ctx.tenantId);
        const s = consentStateOf(events, employeeId);
        return { status: 200, body: { employeeId, purpose: BIOMETRIC_PURPOSE, ...s, allowedMethods: await allowedFor(ctx.tenantId, events, employeeId), identityNumberNeeded: false } };
      },
    },
    {
      api: 'API-11', method: 'GET', path: '/v1/hr/workforce/biometric-consent',
      permission: 'workforce.roster.read',
      handler: async (ctx) => {
        const held = scopeOf(ctx);
        const events = await deps.events(ctx.tenantId);
        const people = (await deps.employees(ctx.tenantId)).filter((e) => held === 'all' || held.includes(e.branchId));
        const signedRefs = await signed(ctx.tenantId);
        return { status: 200, body: { people: people.map((p) => { const s = consentStateOf(events, p.employeeId); return { employeeId: p.employeeId, name: p.name, state: s.state, since: s.since, allowedMethods: methodsAllowedNow(fingerprintVerdict(events, p.employeeId, signedRefs)) }; }), fingerprintInUse: signedRefs.size > 0, asAt: deps.now() } };
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
          const signedRefs = await signed(ctx.tenantId);
          if (s.state !== 'given') {
            // OB-197: before the owner has signed any notice, fingerprint attendance is not in use at all — said by name.
            const notSigned = signedRefs.size === 0;
            throw apiError(403, {
              code: notSigned ? 'consent_notice_not_signed' : 'fingerprint_consent_not_given',
              whatHappened: notSigned
                ? 'The owner has not yet signed the fingerprint-attendance consent notice, so the fingerprint method is not in use (OB-197, DPDP s.5).'
                : `${employeeId} has ${s.state === 'not_asked' ? 'not given' : s.state} consent to fingerprint attendance, so the fingerprint method cannot be used (C21, DPDP s.7).`,
              wasItSaved: 'not_saved', nextSafeAction: 'Use the PIN method — it records attendance exactly the same way. Nothing was saved.',
            });
          }
          // OB-197: consent given on a notice the owner has not signed is never relied on.
          const v = fingerprintVerdict(await deps.events(ctx.tenantId), employeeId, signedRefs);
          if (!v.allowed) {
            throw apiError(403, {
              code: v.code, whatHappened: `The fingerprint method cannot be used: ${v.detail} (OB-197).`,
              wasItSaved: 'not_saved', nextSafeAction: 'Use the PIN method — it records attendance exactly the same way. Nothing was saved.',
            });
          }
        }
        // The time on the attendance device (it may be relayed late), never later than head office's own clock.
        const now = deps.now();
        const at = typeof b['at'] === 'string' && !Number.isNaN(Date.parse(b['at'])) ? new Date(Date.parse(b['at'])).toISOString() : now;
        if (Date.parse(at) > Date.parse(now) + 5 * 60_000) throw apiError(422, { code: 'mark_in_the_future', whatHappened: `The mark says ${at}, later than now (${now}).`, wasItSaved: 'not_saved', nextSafeAction: 'Check the device clock. Nothing was saved.' });
        const m: AttendanceMark = { markId, employeeId, kind: b['kind'] as 'in' | 'out', method, at, date: await shopClock(deps.calendar).dateOf(ctx.tenantId, at), recordedBy: ctx.userId };
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
        const inScope = (m: AttendanceMark): boolean => { const br = branchOf.get(m.employeeId); return held === 'all' || (br !== undefined && held.includes(br)); };
        // OB-507 · P-03: whether marks pair up is judged NOW, from every mark held for the day before, the day and the day
        // after (a night shift's in and out), never read off the record — a late-arriving "in" clears an out's exception.
        // What was flagged when a mark arrived stays on its record, untouched, shown as `flaggedOnArrival`.
        const around = (await deps.marks(ctx.tenantId)).filter((m) => m.date >= addDays(date, -1) && m.date <= addDays(date, 1));
        const clock = shopClock(deps.calendar);
        const now = deps.now();
        const derived = attendancePairing({
          marks: around,
          nightShifts: nightShiftSpansOf(await deps.rosteredShifts?.(ctx.tenantId) ?? [], (await clock.calendar(ctx.tenantId)).timeZone),
          now, today: await clock.today(ctx.tenantId, now),
        });
        const marks = around.filter((m) => m.date === date && inScope(m)).map((stored) => {
          const { exceptions: onArrival, ...fact } = stored;
          const exceptions = derived.get(stored.markId) ?? [];
          return { ...fact, ...(exceptions.length === 0 ? {} : { exceptions }), ...(onArrival === undefined || onArrival.length === 0 ? {} : { flaggedOnArrival: onArrival }) };
        });
        return { status: 200, body: { date, marks, count: marks.length, withExceptions: marks.filter((m) => (m.exceptions ?? []).length > 0).length } };
      },
    },
  ];
}
