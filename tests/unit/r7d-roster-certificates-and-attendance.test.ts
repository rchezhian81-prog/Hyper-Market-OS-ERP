import { describe, it, expect } from 'vitest';
import { foodHandlingVerdict, certificateKindKey, FOOD_HANDLING_CERTIFICATE } from '../../packages/workforce/src/food-handling';
import { myRosterFrom } from '../../packages/workforce/src/my-roster';
import { handlesFood } from '../../packages/production/src/departments';
import { packRoster, myRosterOnBox, packCertifications, foodHandlingOnBox, foodHandlingRefusalAtTheDoor, foodHandlingForViewer, NOT_TOLD_CERTIFICATES } from '../../edge/store-edge/src/workforce-pack';
import { known, notKnown, emptyPack, type StorePack } from '../../edge/store-edge/src/store-pack';
import { attendanceExceptions } from '../../services/finance/src/attendance-marks-synced';
import { attendancePairing, nightShiftSpansOf } from '../../services/finance/src/attendance-pairing';
import { createAttendanceQueue, attendanceKeyFor, ATTENDANCE_MARKED, attendanceWords, ATTENDANCE_COPY } from '../../apps/web-erp/src/attendance-queue';
import { createProductionQueue } from '../../apps/web-erp/src/production-queue';
import { createEssSession, ESS_COPY } from '../../apps/web-erp/src/ess-session';
import { essPortsFromData } from '../../apps/web-erp/src/browser-entry';
import { SyncOutbox } from '../../packages/sync/src/outbox';
import { isRelayable } from '../../packages/sync/src/device-relay';
import { pathFor } from '../../edge/sync-agent/src/http-transport';
import { makeEvent } from '../../packages/contracts/src/event';
import { ROLE_CATALOGUE } from '../../services/api/src/roles';
import type { Employee, Certification } from '../../packages/workforce/src/workforce';

// Round 7 · R7-D — the pure rules behind OB-507 (rosters and attendance offline) and OB-502 (an expired food-handling
// certificate blocks food-handling work), M25-FR-01 / M25-FR-03.

const KUMAR: Employee = { employeeId: 'E-K', name: 'Kumar', branchId: 'S1', roles: ['cook'], active: true };
const cert = (over: Partial<Certification> = {}): Certification => ({ certificationId: 'C1', employeeId: 'E-K', kind: 'food-handling', issuedOn: '2026-01-01', validUntil: '2026-10-31', verifiedBy: 'u-mgr', ...over });
const TODAY = '2026-10-28';

describe('OB-502 · the food-handling gate (packages/workforce/src/food-handling.ts)', () => {
  it('a valid verified certificate allows the work and says until when', () => {
    expect(foodHandlingVerdict({ personId: 'E-K', employee: KUMAR, certifications: [cert()], today: TODAY, task: 'production_run' })).toEqual({ allowed: true, validUntil: '2026-10-31' });
    // The last valid day is inclusive.
    expect(foodHandlingVerdict({ personId: 'E-K', employee: KUMAR, certifications: [cert({ validUntil: TODAY })], today: TODAY, task: 'production_run' }).allowed).toBe(true);
  });
  it('an EXPIRED one blocks, naming the certificate, the person and the date, in English and Tamil', () => {
    const v = foodHandlingVerdict({ personId: 'E-K', employee: KUMAR, certifications: [cert({ validUntil: '2026-10-27' })], today: TODAY, task: 'production_run' });
    expect(v.allowed).toBe(false);
    if (v.allowed) return;
    expect([v.code, v.expiredOn, v.certificate]).toEqual(['food_handling_certificate_expired', '2026-10-27', FOOD_HANDLING_CERTIFICATE]);
    expect(v.words.en).toBe("Kumar's food-handling certificate expired on 2026-10-27. A production or bakery run cannot be recorded in their name until a renewed certificate is recorded. They may still do other work. Nothing was saved.");
    expect(v.words.ta).toContain('2026-10-27');
    expect(v.words.ta).toMatch(/[஀-௿]/);
    // The newest certificate decides: an old lapsed one beside a current one is no block.
    expect(foodHandlingVerdict({ personId: 'E-K', employee: KUMAR, certifications: [cert({ certificationId: 'old', validUntil: '2025-01-01' }), cert()], today: TODAY, task: 'weighed_run' }).allowed).toBe(true);
  });
  it('MISSING, UNVERIFIED, another person\'s, another kind, or no staff record at all — NOT blocked (owner, 28 Oct 2026: only an expired certificate blocks), said plainly; a leaver is blocked', () => {
    const verdictOf = (certifications: readonly Certification[], employee: Employee | undefined = KUMAR) => {
      const v = foodHandlingVerdict({ personId: 'E-K', employee, certifications, today: TODAY, task: 'weighed_run' });
      return v.allowed ? ('noCertificateOnFile' in v ? 'allowed, none on file' : 'allowed') : v.code;
    };
    expect(verdictOf([])).toBe('allowed, none on file');
    expect(verdictOf([cert({ verifiedBy: undefined })])).toBe('allowed, none on file');
    expect(verdictOf([cert({ employeeId: 'E-OTHER' })])).toBe('allowed, none on file');
    expect(verdictOf([cert({ kind: 'forklift' })])).toBe('allowed, none on file');
    expect(verdictOf([cert()], undefined)).toBe('allowed'); // a certificate on file, no staff record: judged on the certificate
    expect(verdictOf([], undefined)).toBe('allowed, none on file');
    expect(verdictOf([cert()], { ...KUMAR, active: false })).toBe('food_handler_inactive');
    // Another person's EXPIRED certificate does not block this person.
    expect(verdictOf([cert({ employeeId: 'E-OTHER', validUntil: '2026-01-01' })])).toBe('allowed, none on file');
    const v = foodHandlingVerdict({ personId: 'E-K', employee: KUMAR, certifications: [], today: TODAY, task: 'weighed_run' });
    expect(v).toMatchObject({ allowed: true, noCertificateOnFile: true });
    expect(v.allowed && 'words' in v ? v.words.en : '').toBe('There is no verified food-handling certificate on file for Kumar. Counter-food (weighed) work may still be recorded in their name — only an expired certificate blocks it. A manager may record one on the staff certificates page.');
    expect(v.allowed && 'words' in v ? v.words.ta : '').toMatch(/[஀-௿]/);
  });
  it('a certificate kind is read however it was typed', () => {
    for (const k of ['food-handling', 'Food handling', 'FOOD_HANDLING', ' food  handling ']) expect(certificateKindKey(k)).toBe(FOOD_HANDLING_CERTIFICATE);
    expect(foodHandlingVerdict({ personId: 'E-K', employee: KUMAR, certifications: [cert({ kind: 'Food Handling' })], today: TODAY, task: 'production_run' }).allowed).toBe(true);
  });
  it('every production department is food; an unknown one is treated as food (fail closed)', () => {
    for (const d of ['cafe', 'bakery', 'deli', 'meat_fish', 'kitchen', 'something-new']) expect(handlesFood(d)).toBe(true);
  });
});

const rosterSection = (over: Record<string, unknown> = {}) => ({
  storeId: 'S1', asAt: '2026-10-28T03:00:00.000Z',
  employees: [{ employeeId: 'E-R', name: 'Rani', roles: ['cashier'], active: true }, { employeeId: 'E-K', name: 'Kumar', roles: ['cook'], active: true }],
  shifts: [
    { shiftId: 'SH-2', branchId: 'S1', startsAt: '2026-11-03T00:30:00.000Z', endsAt: '2026-11-03T08:30:00.000Z', requiredRoles: [{ role: 'cashier', count: 1 }] },
    { shiftId: 'SH-1', branchId: 'S1', startsAt: '2026-11-02T00:30:00.000Z', endsAt: '2026-11-02T08:30:00.000Z', requiredRoles: [{ role: 'cashier', count: 1 }] },
    { shiftId: 'SH-9', branchId: 'S1', startsAt: '2026-11-10T00:30:00.000Z', endsAt: '2026-11-10T08:30:00.000Z', requiredRoles: [] },
  ],
  assignments: [{ shiftId: 'SH-1', employeeId: 'E-R', role: 'cashier' }, { shiftId: 'SH-2', employeeId: 'E-R', role: 'cashier' }, { shiftId: 'SH-9', employeeId: 'E-R', role: 'cashier' }],
  published: [{ shiftId: 'SH-1', branchId: 'S1', weekStart: '2026-11-02', weekEnd: '2026-11-08', limitsNotChecked: ['Weekly holiday'] }, { shiftId: 'SH-2', branchId: 'S1', weekStart: '2026-11-02', weekEnd: '2026-11-08', limitsNotChecked: ['Weekly holiday'] }],
  ...over,
});
const packWith = (sections: Partial<Record<'roster' | 'certifications', unknown>>): StorePack => ({
  ...emptyPack(), policies: known({ tradingDayCutoff: '02:00', storeId: 'S1', branchId: 'S1', timeZone: 'Asia/Kolkata' } as never),
  roster: 'roster' in sections ? known(sections.roster) : notKnown('not told'),
  certifications: 'certifications' in sections ? known(sections.certifications) : notKnown('not told'),
});

describe('OB-507 · my rota from the signed pack (packages/workforce/src/my-roster.ts · edge/store-edge/src/workforce-pack.ts)', () => {
  it('folds only a published week, earliest first, and counts what is held back', () => {
    const r = myRosterOnBox(packWith({ roster: rosterSection() }), 'E-R')!;
    expect(r.shifts.map((s) => s.shiftId)).toEqual(['SH-1', 'SH-2']);
    expect([r.known, r.active, r.count, r.notYetPublished, r.asAt]).toEqual([true, true, 2, 1, '2026-10-28T03:00:00.000Z']);
    expect(r.weeks).toEqual([{ branchId: 'S1', weekStart: '2026-11-02', weekEnd: '2026-11-08', limitsNotChecked: ['Weekly holiday'] }]);
    expect(myRosterOnBox(packWith({ roster: rosterSection() }), 'E-K')).toMatchObject({ known: true, shifts: [], notYetPublished: 0 });
    expect(myRosterOnBox(packWith({ roster: rosterSection() }), 'E-NOBODY')).toMatchObject({ known: false, active: false, shifts: [] });
  });
  it('the same fold as head office: an assignment to a shift the roster does not hold is not shown', () => {
    const r = myRosterFrom({ employeeId: 'E-R', employees: [], shifts: [], assignments: [{ shiftId: 'X', employeeId: 'E-R', role: 'cashier' }], visible: new Map() });
    expect([r.known, r.count, r.notYetPublished]).toEqual([false, 0, 0]);
  });
  it('a pack that was not told, or whose roster cannot be read, is "not told" — never an empty rota', () => {
    expect(myRosterOnBox(packWith({}), 'E-R')).toBeNull();
    for (const bad of [null, 'x', rosterSection({ asAt: 'later' }), rosterSection({ employees: [{ employeeId: 'E-R' }] }), rosterSection({ shifts: [{ shiftId: 'S' }] }), rosterSection({ published: [{ shiftId: 'S', weekStart: 'monday' }] })]) {
      expect(packRoster(packWith({ roster: bad }))).toBeUndefined();
    }
  });
});

const certSection = (items: readonly Record<string, unknown>[]) => ({ asAt: '2026-10-28T03:00:00.000Z', foodHandlingKind: 'food-handling', certifications: items });

describe('OB-502 on the store computer — offline, from the pack', () => {
  const pack = packWith({ roster: rosterSection(), certifications: certSection([{ certificationId: 'C1', employeeId: 'E-K', kind: 'food-handling', issuedOn: '2025-01-01', validUntil: '2026-10-20', verifiedBy: 'u-mgr' }]) });
  it('judges a person against the certificates the pack carried', () => {
    const v = foodHandlingOnBox(pack, 'E-K', 'production_run', TODAY);
    expect(v.allowed ? '' : v.code).toBe('food_handling_certificate_expired');
    expect(packCertifications(pack)?.certifications).toHaveLength(1);
  });
  it('a pack with no certificates it can read cannot show anyone\'s certificate expired — NOT refused, and said so; a leaver on the roster still is', () => {
    for (const p of [packWith({ roster: rosterSection() }), packWith({}), packWith({ roster: rosterSection(), certifications: certSection([{ certificationId: 'C1' }]) })]) {
      const v = foodHandlingOnBox(p, 'E-K', 'production_run', TODAY);
      expect(v).toMatchObject({ allowed: true, certificatesNotKnownHere: true, code: NOT_TOLD_CERTIFICATES.code });
    }
    const leaver = packWith({ roster: rosterSection({ employees: [{ employeeId: 'E-K', name: 'Kumar', roles: ['cook'], active: false }] }) });
    const gone = foodHandlingOnBox(leaver, 'E-K', 'production_run', TODAY);
    expect(gone.allowed ? '' : gone.code).toBe('food_handler_inactive');
    // Certificates told but no roster: still judged on the certificates — the expired one is refused.
    const noRoster = foodHandlingOnBox(packWith({ certifications: certSection([{ certificationId: 'C1', employeeId: 'E-K', kind: 'food-handling', issuedOn: '2025-01-01', validUntil: '2026-10-20', verifiedBy: 'u-mgr' }]) }), 'E-K', 'production_run', TODAY);
    expect(noRoster.allowed ? '' : noRoster.code).toBe('food_handling_certificate_expired');
  });
  it('the door: a production run and a counter-food run in a lapsed name are refused; one by a person with no certificate on file, and other records, pass untouched', () => {
    const door = (type: string, payload: Record<string, unknown>, recipeDept?: string) => foodHandlingRefusalAtTheDoor({
      pack, event: { type, payload }, handlesFood, dateOf: () => TODAY, now: `${TODAY}T05:00:00.000Z`, departmentOfRecipe: () => recipeDept,
    });
    expect(door('ProductionRunCaptured', { producedBy: 'E-K', recipeId: 'r-cake', at: `${TODAY}T04:00:00.000Z` }, 'cafe')).toMatch(/^food_handling_certificate_expired: Kumar's food-handling certificate expired on 2026-10-20\..* \/ /);
    expect(door('ProductionRunCaptured', { producedBy: 'E-K', recipeId: 'not-known-here' })).toContain('food_handling_certificate_expired'); // unknown recipe: food
    expect(door('WeighedRunCaptured', { weighedBy: 'E-R', departmentId: 'meat_fish' })).toBeUndefined(); // Rani: no certificate on file — not blocked
    expect(door('ProductionRunCaptured', { recipeId: 'r-cake' })).toContain('does not say who made it');
    for (const type of ['ProductionReleaseDecided', 'AttendanceMarked', 'StockCounted']) expect(door(type, { producedBy: 'E-K' })).toBeUndefined();
  });
  it('the production screen is told the viewer\'s verdict on the shop\'s own date', () => {
    expect(foodHandlingForViewer(pack, 'E-K', '2026-10-19T20:00:00.000Z')).toEqual({ allowed: true, validUntil: '2026-10-20' }); // 01:30 IST on the 20th
    expect(foodHandlingForViewer(pack, 'E-K', '2026-10-20T19:00:00.000Z')).toMatchObject({ allowed: false, expiredOn: '2026-10-20' }); // 00:30 IST on the 21st
    expect(foodHandlingForViewer(pack, 'E-R', '2026-10-20T19:00:00.000Z')).toMatchObject({ allowed: true, noCertificateOnFile: true }); // none on file: allowed, said
    expect(foodHandlingForViewer(packWith({ roster: rosterSection() }), 'E-K', '2026-10-20T19:00:00.000Z')).toMatchObject({ allowed: true, certificatesNotKnownHere: true });
  });
});

describe('OB-507 · attendance marks', () => {
  const NOW = '2026-10-28T03:30:00.000Z';
  const DAY = '2026-10-28';
  it('head office flags a mark out of order (two "in"s, or an "out" with no "in") and nothing else', () => {
    const m = (markId: string, kind: 'in' | 'out', at: string) => ({ markId, employeeId: 'E-R', kind, method: 'pin' as const, at, date: '2026-10-28', recordedBy: 'E-R' });
    expect(attendanceExceptions([], { employeeId: 'E-R', kind: 'in', at: NOW, date: DAY })).toEqual([]);
    expect(attendanceExceptions([], { employeeId: 'E-R', kind: 'out', at: NOW, date: DAY })).toEqual(['out_without_in']);
    expect(attendanceExceptions([m('1', 'in', '2026-10-28T01:00:00.000Z')], { employeeId: 'E-R', kind: 'in', at: NOW, date: DAY })).toEqual(['repeats_the_last_mark']);
    expect(attendanceExceptions([m('1', 'in', '2026-10-28T01:00:00.000Z')], { employeeId: 'E-R', kind: 'out', at: NOW, date: DAY })).toEqual([]);
    expect(attendanceExceptions([m('1', 'in', '2026-10-28T05:00:00.000Z')], { employeeId: 'E-R', kind: 'in', at: NOW, date: DAY })).toEqual([]); // a LATER mark is not "before"
    expect(attendanceExceptions([{ ...m('1', 'in', '2026-10-28T01:00:00.000Z'), employeeId: 'E-OTHER' }], { employeeId: 'E-R', kind: 'in', at: NOW, date: DAY })).toEqual([]);
  });
  // OB-507 follow-up: pairing is judged when READ, over every mark held — never frozen when one mark happened to arrive.
  describe('pairing judged when read (attendance-pairing)', () => {
    const IST = (day: string, hhmm: string): string => new Date(Date.parse(`${day}T${hhmm}:00+05:30`)).toISOString();
    const mk = (markId: string, employeeId: string, kind: 'in' | 'out', day: string, hhmm: string) => ({ markId, employeeId, kind, at: IST(day, hhmm), date: day });
    const LATER = { now: IST('2026-10-30', '12:00'), today: '2026-10-30' }; // both days are long over
    const pair = (marks: ReturnType<typeof mk>[], nightShifts: ReturnType<typeof nightShiftSpansOf> = [], clock = LATER) =>
      Object.fromEntries(attendancePairing({ marks, nightShifts, ...clock }));

    it('an "out" that arrived before its "in" is an exception only until the "in" is held — then it clears', () => {
      const out = mk('O', 'E-R', 'out', '2026-10-27', '17:00');
      expect(pair([out])).toEqual({ O: ['out_without_in'] });
      expect(pair([out, mk('I', 'E-R', 'in', '2026-10-27', '09:00')])).toEqual({}); // arrival order does not matter
    });
    it('a rostered night shift pairs an "in" with the next day\'s "out"; without one the same-day rule stands', () => {
      const marks = [mk('I', 'E-N', 'in', '2026-10-27', '21:55'), mk('O', 'E-N', 'out', '2026-10-28', '06:05')];
      const nights = nightShiftSpansOf([{ employeeId: 'E-N', startsAt: IST('2026-10-27', '22:00'), endsAt: IST('2026-10-28', '06:00') }], 'Asia/Kolkata');
      expect(nights).toEqual([{ employeeId: 'E-N', fromDate: '2026-10-27', toDate: '2026-10-28', endsAt: IST('2026-10-28', '06:00') }]);
      expect(pair(marks, nights)).toEqual({});
      expect(pair(marks)).toEqual({ I: ['in_without_out'], O: ['out_without_in'] }); // no night shift on the roster
      // Somebody else's night shift does not carry this person's "in".
      expect(pair(marks, nights.map((n) => ({ ...n, employeeId: 'E-OTHER' })))).toEqual({ I: ['in_without_out'], O: ['out_without_in'] });
      // A day shift is not a night shift.
      expect(nightShiftSpansOf([{ employeeId: 'E-N', startsAt: IST('2026-10-27', '06:00'), endsAt: IST('2026-10-27', '14:00') }], 'Asia/Kolkata')).toEqual([]);
    });
    it('real exceptions stay: an out with no in, a repeated mark, an in never closed once its day or night shift is over', () => {
      expect(pair([mk('O', 'E-L', 'out', '2026-10-28', '13:00')])).toEqual({ O: ['out_without_in'] });
      expect(pair([mk('I1', 'E-R', 'in', '2026-10-28', '09:00'), mk('I2', 'E-R', 'in', '2026-10-28', '10:00'), mk('O', 'E-R', 'out', '2026-10-28', '17:00')])).toEqual({ I2: ['repeats_the_last_mark'] });
      expect(pair([mk('I', 'E-R', 'in', '2026-10-28', '09:00'), mk('O1', 'E-R', 'out', '2026-10-28', '17:00'), mk('O2', 'E-R', 'out', '2026-10-28', '17:05')])).toEqual({ O2: ['repeats_the_last_mark'] });
      // An "in" with no "out": not an exception while its day is still running — only once it is over.
      const open = [mk('I', 'E-R', 'in', '2026-10-28', '09:00')];
      expect(pair(open, [], { now: IST('2026-10-28', '12:00'), today: '2026-10-28' })).toEqual({});
      expect(pair(open)).toEqual({ I: ['in_without_out'] });
      // On a rostered night shift: open until the shift ends, past midnight.
      const night = [mk('N', 'E-N', 'in', '2026-10-27', '21:55')];
      const nights = nightShiftSpansOf([{ employeeId: 'E-N', startsAt: IST('2026-10-27', '22:00'), endsAt: IST('2026-10-28', '06:00') }], 'Asia/Kolkata');
      expect(pair(night, nights, { now: IST('2026-10-28', '04:00'), today: '2026-10-28' })).toEqual({});
      expect(pair(night, nights, { now: IST('2026-10-28', '07:00'), today: '2026-10-28' })).toEqual({ N: ['in_without_out'] });
    });
    it('on arrival the same fold is used, and the clock-dependent "never closed" is left to the read', () => {
      const nights = nightShiftSpansOf([{ employeeId: 'E-N', startsAt: IST('2026-10-27', '22:00'), endsAt: IST('2026-10-28', '06:00') }], 'Asia/Kolkata');
      const held = [{ ...mk('I', 'E-N', 'in', '2026-10-27', '21:55'), method: 'pin' as const, recordedBy: 'E-N' }];
      expect(attendanceExceptions(held, { employeeId: 'E-N', kind: 'out', at: IST('2026-10-28', '06:05'), date: '2026-10-28' }, nights)).toEqual([]);
      expect(attendanceExceptions(held, { employeeId: 'E-N', kind: 'out', at: IST('2026-10-28', '06:05'), date: '2026-10-28' })).toEqual(['out_without_in']);
      expect(attendanceExceptions([], { employeeId: 'E-N', kind: 'in', at: IST('2026-10-20', '09:00'), date: '2026-10-20' })).toEqual([]);
    });
  });
  it('the page saves a mark durably on this device, in the person\'s own name, once per id; refuses nobody, no store, no right', () => {
    const outbox = new SyncOutbox();
    let n = 0;
    const q = createAttendanceQueue({ userId: 'E-R', storeId: 'S1', permissions: ['payroll.ess.self', 'workforce.attendance.mark'], now: () => NOW, freshId: () => `M-${++n}` }, outbox);
    expect(q.may).toBe(true);
    expect(q.mark('in')).toEqual({ outcome: 'saved', markId: 'M-1' });
    const item = outbox.all()[0]!;
    expect([item.key, item.event.type, item.event.idempotencyKey, item.event.payload]).toEqual([attendanceKeyFor('M-1'), ATTENDANCE_MARKED, 'attendance:M-1', { markId: 'M-1', employeeId: 'E-R', kind: 'in', method: 'pin', at: NOW, storeId: 'S1', source: 'self-service-screen' }]);
    expect(q.lastKind()).toBe('in');
    expect(q.marks('ta')[0]).toMatchObject({ markId: 'M-1', kind: 'in', state: 'saved_here', stateWord: ATTENDANCE_COPY.ta.stSavedHere });
    q.queue.enqueue(attendanceKeyFor('M-1'), { markId: 'M-1', employeeId: 'E-R', kind: 'out', method: 'pin', at: NOW, storeId: 'S1', source: 'x' }, NOW);
    expect(outbox.all()).toHaveLength(1); // the same id is the same mark
    const ref = (cfg: Partial<{ userId: string | null; storeId: string | null; permissions: string[] }>) => createAttendanceQueue({ userId: 'E-R', storeId: 'S1', permissions: ['workforce.attendance.mark'], now: () => NOW, ...cfg }, new SyncOutbox()).mark('out').outcome;
    expect([ref({ userId: null }), ref({ storeId: null }), ref({ permissions: [] })]).toEqual(['nobody', 'no_store', 'not_allowed']);
  });
  it('the box relays it (manager surface only) to head office\'s synced route, which only the store computer may call', () => {
    expect(isRelayable('AttendanceMarked', 'manager')).toBe(true);
    expect(isRelayable('AttendanceMarked', 'warehouse')).toBe(false);
    expect(pathFor(makeEvent({ id: 'a', type: 'AttendanceMarked', occurredAt: NOW, idempotencyKey: 'a', source: 's', payload: { markId: 'M 1' } }))).toBe('/v1/hr/workforce/attendance-marks/M%201/synced');
    const holders = ROLE_CATALOGUE.filter((r) => r.permissions.includes('workforce.attendance.sync')).map((r) => r.id).sort();
    expect(holders).toEqual(['owner', 'store_computer']);
  });
  it('every attendance word is in English and Tamil', () => {
    expect(Object.keys(ATTENDANCE_COPY.ta).sort()).toEqual(Object.keys(ATTENDANCE_COPY.en).sort());
    expect(attendanceWords('ta', 'clockIn')).toMatch(/[஀-௿]/);
    expect(Object.keys(ESS_COPY.ta).sort()).toEqual(Object.keys(ESS_COPY.en).sort());
  });
});

describe('OB-507 · the self-service page shows the box\'s held rota when head office cannot be reached, and says so', () => {
  const held = { known: true, active: true, shifts: [{ shiftId: 'SH-1', role: 'cashier', branchId: 'S1', startsAt: '2026-11-02T00:30:00.000Z', endsAt: '2026-11-02T08:30:00.000Z' }], asAt: '2026-10-28T03:00:00.000Z' };
  it('the held copy, with its age; the live answer when there is one', () => {
    const data = { userId: 'E-R', permissions: ['payroll.ess.self'], myRoster: held };
    const offline = createEssSession({ userId: 'E-R' }, essPortsFromData(data, null, null)).view('en');
    expect(offline.rows.map((r) => r.id)).toContain('shift-SH-1');
    expect(offline.rosterAsOfWords).toBe('Your rota as the store computer last heard it from head office, at 2026-10-28 03:00');
    const live = createEssSession({ userId: 'E-R' }, essPortsFromData(data, { known: true, active: true, shifts: [] }, null)).view('ta');
    expect(live.rows.map((r) => r.id)).toContain('rota-empty');
    expect(live.rosterAsOfWords).toBe('');
  });
});

describe('OB-502 · the production screen refuses before saving', () => {
  const words = { en: 'Kumar\'s food-handling certificate expired on 2026-10-20.', ta: 'காலாவதி' };
  it('no run and no weigh is saved in a lapsed name', async () => {
    const outbox = new SyncOutbox();
    const q = createProductionQueue({ userId: 'E-K', storeId: 'S1', now: () => '2026-10-28T03:00:00.000Z', foodHandling: { allowed: false, words } }, outbox);
    expect(await q.runPort().post({ runId: 'r1', recipeId: 'r-cake', batches: 1, actualOutputMinor: 1, outputBatchId: 'B1', locationId: 'K' })).toEqual({ result: 'refused', reason: words.en });
    expect(q.recordWeighed({ departmentId: 'meat_fish', inputProductId: 'CH', inputGrams: '1000', outputProductId: 'CUTS', outputGrams: '900' })).toEqual({ outcome: 'certificate', words });
    expect(outbox.all()).toHaveLength(0);
    const fine = createProductionQueue({ userId: 'E-K', storeId: 'S1', now: () => '2026-10-28T03:00:00.000Z', foodHandling: { allowed: true } }, outbox);
    expect((await fine.runPort().post({ runId: 'r1', recipeId: 'r-cake', batches: 1, actualOutputMinor: 1, outputBatchId: 'B1', locationId: 'K' })).result).toBe('done');
  });
});
