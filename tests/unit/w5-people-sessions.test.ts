import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createPayrollStatutorySession, createPayrollLegalSession, PAYROLL_STATUTORY_COPY, paiseFrom, daysInMonth } from '../../apps/web-erp/src/payroll-statutory-session';
import { createWorkingTimeSession, WORKING_TIME_COPY, holidayLines, paiseOf } from '../../apps/web-erp/src/working-time-session';
import { createPoshRegisterSession, POSH_REGISTER_COPY } from '../../apps/web-erp/src/posh-register-session';
import { createAppointmentLettersSession, LETTERS_COPY } from '../../apps/web-erp/src/appointment-letters-session';
import { ROLE_CATALOGUE } from '../../services/api/src/roles';

/**
 * **W5 — people, payroll and HR registers: the sessions behind the new sections.** Each refuses the cheap things before
 * anything is sent, and sends exactly what head office's route reads.
 *   • C15 · C16 · C19 · OB-208 · OB-209 (Payroll): the CA's legal figures, preparing a payslip, the month's check, EPF/ESI
 *     totals, late payslips and the periods issued — COMPUTE AND SHOW ONLY: no issue, approve, lock or bank file is reachable.
 *   • C18 · OB-152 · OB-155 · OB-156 · OB-181 (Settings, Staff, Staff schedule): limits, leave types, holidays, leave, the
 *     three registers, the roster check and publication; OB-142 · M25-FR-01 service standards and labour cost (the owner's
 *     guide is sent only when he typed one).
 *   • C20 · OB-157 (committee page): the complaints register is the Internal Committee's alone.
 *   • OB-323 (Appointment letters): a kept signed copy is looked at by its id.
 */

function fakeHeadOffice(answer: (method: string, path: string) => unknown = () => ({})) {
  const sent: { method: string; path: string; body: unknown; key?: string }[] = [];
  const fetch = (async (path: string, init: { method: string; body?: string; headers?: Record<string, string> }) => {
    sent.push({ method: init.method, path, body: init.body === undefined ? undefined : JSON.parse(init.body), ...(init.headers?.['idempotency-key'] === undefined ? {} : { key: init.headers['idempotency-key'] }) });
    return { ok: true, status: 200, json: async () => answer(init.method, path) } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
  return { sent, fetch };
}
const v = (...permissions: string[]) => ({ userId: 'u-x', permissions });
const strip = (f: string) => readFileSync(f, 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

describe('every word has a Tamil twin (W5 sections)', () => {
  it('in each word table', () => {
    for (const c of [PAYROLL_STATUTORY_COPY, WORKING_TIME_COPY, POSH_REGISTER_COPY, LETTERS_COPY]) expect(Object.keys(c.ta).sort()).toEqual(Object.keys(c.en).sort());
  });
});

describe('C15 · C16 · C19 (OB-209): the statutory pay checks compute and show only', () => {
  it('reads the CA\'s figures; a figure needs its source and the CA\'s confirmation; only the CA or owner may fill one', async () => {
    const ho = fakeHeadOffice();
    const owner = createPayrollStatutorySession({ viewer: v('payroll.statutory.read', 'payroll.legal.read', 'payroll.legal.configure'), fetch: ho.fetch });
    await owner.legalSettings();
    expect(await owner.setFigure('pfEmployeeRateBps', { value: '1200', source: ' ', confirmation: 'CA ref 1' })).toEqual({ result: 'invalid', why: 'needFields' });
    expect(await owner.setFigure('pfEmployeeRateBps', { value: '12%', source: 'EPF Act', confirmation: 'CA ref 1' })).toEqual({ result: 'invalid', why: 'badNumber' });
    await owner.setFigure('pfEmployeeRateBps', { value: '1200', source: ' EPF scheme ', confirmation: 'CA ref 1' });
    await owner.setMinimumWage({ classId: 'shop-assistant', label: 'Shop assistant', roles: 'cashier, picker', monthlyRupees: '12,500.50', source: 'G.O. 1', confirmation: 'CA ref 2' });
    await owner.setParticulars(['employeeId', 'employeeName'], { source: 'Code on Wages s.50', confirmation: 'CA ref 3' });
    expect(ho.sent.map((s) => `${s.method} ${s.path}`)).toEqual([
      'GET /v1/hr/payroll/legal-settings', 'POST /v1/hr/payroll/legal-settings/pfEmployeeRateBps',
      'POST /v1/hr/payroll/legal-settings/minimum-wage-shop-assistant', 'POST /v1/hr/payroll/legal-settings/payslip-particulars',
    ]);
    expect(ho.sent[1]!.body).toEqual({ value: 1200, source: 'EPF scheme', confirmation: 'CA ref 1' });
    expect(ho.sent[2]!.body).toEqual({ label: 'Shop assistant', roles: ['cashier', 'picker'], monthlyMinor: 1_250_050, source: 'G.O. 1', confirmation: 'CA ref 2' });
    const manager = createPayrollStatutorySession({ viewer: v('payroll.statutory.read'), fetch: ho.fetch });
    expect(await manager.legalSettings()).toEqual({ result: 'invalid', why: 'cannotReadLegal' });
    expect(await manager.setFigure('pfEmployeeRateBps', { value: '1', source: 'a', confirmation: 'b' })).toEqual({ result: 'invalid', why: 'cannotSetLegal' });
  });

  it('prepares a payslip from the month\'s days and the pay typed — never the hours, roles or headcount', async () => {
    const ho = fakeHeadOffice();
    const s = createPayrollStatutorySession({ viewer: v('payroll.statutory.read'), fetch: ho.fetch });
    expect(await s.prepare({ employeeId: 'E-1', period: '2026-13', onDate: '2026-11-07', paidDays: '30', basicRupees: '15000', otherRupees: '' })).toEqual({ result: 'invalid', why: 'badPeriod' });
    expect(await s.prepare({ employeeId: 'E-1', period: '2026-10', onDate: '2026-11-07', paidDays: '30', basicRupees: 'fifteen', otherRupees: '' })).toEqual({ result: 'invalid', why: 'badAmount' });
    await s.prepare({ employeeId: 'E-1', period: '2026-02', onDate: '2026-03-07', paidDays: '27', basicRupees: '15000', otherRupees: '2,000' });
    expect(ho.sent).toEqual([{ method: 'POST', path: '/v1/hr/payroll/statutory-payslips/E-1/2026-02', key: expect.any(String), body: {
      onDate: '2026-03-07', attendance: { calendarDaysInMonth: 28, paidDays: 27 },
      components: [{ code: 'BASIC', monthlyMinor: 1_500_000, partOfPfWage: true }, { code: 'ALLOWANCES', monthlyMinor: 200_000 }],
    } }]);
    for (const k of ['hours', 'headcount', 'roles', 'ordinaryHourlyRateMinor']) expect(Object.keys(ho.sent[0]!.body as object)).not.toContain(k);
  });

  it('the check, the totals, the late list and the periods issued go to their routes; totals need a reference', async () => {
    const ho = fakeHeadOffice();
    const s = createPayrollStatutorySession({ viewer: v('payroll.statutory.read'), fetch: ho.fetch });
    await s.check('2026-10');
    expect(await s.recordTotals('2026-10', { pfEmployee: '1800', pfEmployer: '1800', esiEmployee: '0', esiEmployer: '0', reference: ' ' })).toEqual({ result: 'invalid', why: 'needFields' });
    await s.recordTotals('2026-10', { pfEmployee: '1,800', pfEmployer: '1800.50', esiEmployee: '0', esiEmployer: '0', reference: 'ECR-10' });
    await s.contributions('2026-10'); await s.late('2026-10'); await s.issued('E-1');
    expect(ho.sent.map((x) => `${x.method} ${x.path}`)).toEqual([
      'GET /v1/hr/payroll/statutory-check/2026-10', 'POST /v1/hr/payroll/contributions/2026-10/totals', 'GET /v1/hr/payroll/contributions/2026-10',
      'GET /v1/hr/payroll/payslip-exceptions?period=2026-10', 'GET /v1/hr/payroll/payslips/E-1',
    ]);
    expect(ho.sent[1]!.body).toEqual({ pfEmployeeMinor: 180_000, pfEmployerMinor: 180_050, esiEmployeeMinor: 0, esiEmployerMinor: 0, reference: 'ECR-10' });
    expect(await createPayrollStatutorySession({ viewer: undefined, fetch: ho.fetch }).check('2026-10')).toEqual({ result: 'invalid', why: 'nobody' });
  });

  it('OB-209 · OB-228: the session and its page never reach issue, approve, lock, the release switch or the bank file', () => {
    for (const f of ['apps/web-erp/src/payroll-statutory-session.ts', 'apps/web-erp/web/payroll-statutory.js']) {
      const src = strip(f);
      for (const banned of ['pay-run', 'bank-file', 'release-switch', '/journal', '/settlement', 'localStorage', 'sessionStorage', 'indexedDB', 'serviceWorker']) expect(src.includes(banned), `${f} reaches "${banned}"`).toBe(false);
    }
    const posts = [...strip('apps/web-erp/src/payroll-statutory-session.ts').matchAll(/call\('POST', [`']([^`']+)[`']/g)].map((m) => m[1]);
    expect(posts).toEqual(['/v1/hr/payroll/legal-settings/${enc(key.trim())}', '/v1/hr/payroll/legal-settings/minimum-wage-${enc(f.classId.trim())}', '/v1/hr/payroll/legal-settings/payslip-particulars', '/v1/hr/payroll/statutory-payslips/${enc(f.employeeId.trim())}/${enc(p)}', '/v1/hr/payroll/contributions/${enc(p.trim())}/totals']);
    expect(paiseFrom('₹1,23,456.5')).toBe(12_345_650); expect(paiseFrom('1.234')).toBeUndefined(); expect(daysInMonth('2028-02')).toBe(29);
  });
});

describe('C18: working-time limits, leave, registers and the roster', () => {
  it('a limit, a leave type and the holiday list each need the part of the Act and who confirmed it; only the owner sets them', async () => {
    const ho = fakeHeadOffice();
    const owner = createWorkingTimeSession({ viewer: v('hr.compliance.read', 'hr.compliance.configure'), fetch: ho.fetch });
    await owner.settings();
    expect(await owner.setLimit('maxDailyWorkMinutes', { value: '540', source: '', confirmation: 'owner' })).toEqual({ result: 'invalid', why: 'needFields' });
    expect(await owner.setLimit('rosterWeekStartsOn', { value: '1', source: 's', confirmation: 'c' })).toEqual({ result: 'invalid', why: 'needFields' });
    await owner.setLimit('maxDailyWorkMinutes', { value: '540', source: 'TN S&E Act s.12', confirmation: 'CA ref 9' });
    await owner.setLeaveType('casual', { daysPerYear: '12', carryOverMaxDays: '0', source: 'Rules', confirmation: 'CA ref 10' });
    expect(await owner.setHolidays({ lines: '2027-01-15 Pongal\nnot a date', source: 'G.O.', confirmation: 'CA' })).toEqual({ result: 'invalid', why: 'badHolidays' });
    await owner.setHolidays({ lines: '2027-01-15 Pongal\n\n2027-01-26  Republic Day', source: 'G.O.', confirmation: 'CA' });
    expect(ho.sent.map((x) => `${x.method} ${x.path}`)).toEqual(['GET /v1/hr/compliance/working-time/settings', 'POST /v1/hr/compliance/working-time/settings/maxDailyWorkMinutes', 'POST /v1/hr/compliance/working-time/settings/leave-casual', 'POST /v1/hr/compliance/working-time/settings/public-holidays']);
    expect(ho.sent[3]!.body).toEqual({ dates: [{ date: '2027-01-15', name: 'Pongal' }, { date: '2027-01-26', name: 'Republic Day' }], source: 'G.O.', confirmation: 'CA' });
    const mgr = createWorkingTimeSession({ viewer: v('hr.compliance.read', 'workforce.roster.read'), fetch: ho.fetch });
    expect(await mgr.setLimit('maxDailyWorkMinutes', { value: '540', source: 's', confirmation: 'c' })).toEqual({ result: 'invalid', why: 'cannotSet' });
    expect(holidayLines('')).toEqual([]);
  });

  it('records leave (taken or cancelled) and reads the three registers for a period or a day', async () => {
    const ho = fakeHeadOffice();
    const s = createWorkingTimeSession({ viewer: v('workforce.roster.manage', 'hr.register.read'), fetch: ho.fetch });
    expect(await s.recordLeave('E-1', '2026-11-31', { kind: 'taken', leaveType: 'sick', note: '' })).toEqual({ result: 'invalid', why: 'badDate' });
    await s.recordLeave(' E-1 ', '2026-11-05', { kind: 'taken', leaveType: 'sick', note: ' fever ' });
    await s.recordLeave('E-1', '2026-11-05', { kind: 'cancelled', leaveType: 'sick', note: '' });
    await s.register('attendance', { from: '2026-11-01', to: '2026-11-30', asOf: '', branchId: 'br-1' });
    await s.register('leave', { from: '', to: '', asOf: '2026-11-30', branchId: '' });
    await s.register('holidays', { from: '2026-11-01', to: '2026-11-30', asOf: '', branchId: '' });
    expect(ho.sent.map((x) => `${x.method} ${x.path}`)).toEqual([
      'POST /v1/hr/compliance/leave/E-1/2026-11-05', 'POST /v1/hr/compliance/leave/E-1/2026-11-05',
      'GET /v1/hr/compliance/registers/attendance?from=2026-11-01&to=2026-11-30&branchId=br-1', 'GET /v1/hr/compliance/registers/leave?asOf=2026-11-30',
      'GET /v1/hr/compliance/registers/holidays?from=2026-11-01&to=2026-11-30',
    ]);
    expect(ho.sent[0]!.body).toEqual({ kind: 'taken', leaveType: 'sick', note: 'fever' });
    expect(ho.sent[1]!.body).toEqual({ kind: 'cancelled', leaveType: 'sick' });
    expect(await createWorkingTimeSession({ viewer: v('workforce.roster.read'), fetch: ho.fetch }).register('leave', { from: '', to: '', asOf: '2026-11-30', branchId: '' })).toEqual({ result: 'invalid', why: 'cannotRegister' });
  });

  it('checks and publishes a week under a fresh publication id; standards and labour cost — the guide only when typed', async () => {
    const ho = fakeHeadOffice();
    let n = 0;
    const s = createWorkingTimeSession({ viewer: v('workforce.roster.read', 'workforce.roster.manage', 'workforce.standard.set'), fetch: ho.fetch, newPublicationId: () => `RP-${++n}` });
    await s.rosterCheck('br-1', '2026-11-09'); await s.publish('br-1', '2026-11-09'); await s.publications('br-1');
    await s.standards(); expect(await s.setStandard('cashier', '0')).toEqual({ result: 'invalid', why: 'badNumber' }); await s.setStandard('cashier', '20');
    await s.labourCost('br-1', '2026-11-02', '50,000', ''); await s.labourCost('br-1', '2026-11-02', '50000.5', '1100');
    expect(ho.sent.map((x) => `${x.method} ${x.path}`)).toEqual([
      'GET /v1/hr/compliance/roster-check?branchId=br-1&weekStart=2026-11-09', 'POST /v1/hr/compliance/roster-publications/RP-1', 'GET /v1/hr/compliance/roster-publications?branchId=br-1',
      'GET /v1/hr/workforce/labour-standards', 'POST /v1/hr/workforce/labour-standards/cashier',
      'GET /v1/hr/workforce/labour-cost?branchId=br-1&date=2026-11-02&salesMinor=5000000', 'GET /v1/hr/workforce/labour-cost?branchId=br-1&date=2026-11-02&salesMinor=5000050&guideBps=1100',
    ]);
    expect(ho.sent[1]!.body).toEqual({ branchId: 'br-1', weekStart: '2026-11-09' });
    expect(ho.sent[4]!.body).toEqual({ billsPerStaffHour: 20 });
    const reader = createWorkingTimeSession({ viewer: v('workforce.roster.read'), fetch: ho.fetch });
    expect(await reader.publish('br-1', '2026-11-09')).toEqual({ result: 'invalid', why: 'cannotManage' });
    expect(await reader.setStandard('cashier', '20')).toEqual({ result: 'invalid', why: 'cannotSet' });
    expect(paiseOf('abc')).toBeUndefined();
  });
});

describe('C20 · OB-157: the complaints register is the Internal Committee\'s alone', () => {
  it('only the committee role holds the register\'s words — not the owner, a manager or the administrator', () => {
    for (const p of ['posh.complaint.read', 'posh.complaint.record']) expect(ROLE_CATALOGUE.filter((r) => r.permissions.includes(p)).map((r) => r.id)).toEqual(['internal_committee']);
  });

  it('refuses to send anything for anyone else; the committee receives, steps and reads, the id made by head office', async () => {
    const ho = fakeHeadOffice();
    const owner = createPoshRegisterSession({ viewer: v('posh.report.read', 'posh.report.file'), fetch: ho.fetch });
    expect(await owner.register()).toEqual({ result: 'invalid', why: 'cannotRead' });
    expect(await owner.one('PC-1')).toEqual({ result: 'invalid', why: 'cannotRead' });
    expect(await owner.accessLog()).toEqual({ result: 'invalid', why: 'cannotRead' });
    expect(await owner.receive({ receivedOn: '2026-11-01', complainantRef: 'a', respondentRef: 'b', summary: 'c' })).toEqual({ result: 'invalid', why: 'cannotRecord' });
    expect(ho.sent).toEqual([]);
    const ic = createPoshRegisterSession({ viewer: v('posh.complaint.read', 'posh.complaint.record'), fetch: ho.fetch });
    expect(await ic.receive({ receivedOn: '2026-11-01', complainantRef: 'C-1', respondentRef: ' ', summary: 'x' })).toEqual({ result: 'invalid', why: 'needComplaint' });
    await ic.receive({ receivedOn: '2026-11-01', complainantRef: ' C-1 ', respondentRef: 'R-1', summary: ' words ' });
    expect(await ic.step('PC-1', { kind: 'disposed', on: '2026-11-03' })).toEqual({ result: 'invalid', why: 'needStep' });
    await ic.step('PC-1', { kind: 'inquiry_started', on: '2026-11-02', outcome: 'upheld', note: ' ' });
    await ic.step('PC-1', { kind: 'disposed', on: '2026-11-03', outcome: 'conciliation', note: 'settled' });
    await ic.register(); await ic.one('PC-1'); await ic.accessLog();
    expect(ho.sent.map((x) => `${x.method} ${x.path}`)).toEqual(['POST /v1/hr/posh/complaints', 'POST /v1/hr/posh/complaints/PC-1/steps', 'POST /v1/hr/posh/complaints/PC-1/steps', 'GET /v1/hr/posh/complaints', 'GET /v1/hr/posh/complaints/PC-1', 'GET /v1/hr/posh/access-log']);
    expect(ho.sent[0]!.body).toEqual({ receivedOn: '2026-11-01', complainantRef: 'C-1', respondentRef: 'R-1', summary: 'words' });
    expect(Object.keys(ho.sent[0]!.body as object)).not.toContain('complaintId');
    expect(ho.sent[1]!.body).toEqual({ kind: 'inquiry_started', on: '2026-11-02' });
    expect(ho.sent[2]!.body).toEqual({ kind: 'disposed', on: '2026-11-03', outcome: 'conciliation', note: 'settled' });
  });

  it('the register\'s page keeps nothing in the browser', () => {
    const src = strip('apps/web-erp/web/posh-register.js');
    for (const sink of ['localStorage', 'sessionStorage', 'indexedDB', 'document.cookie', 'serviceWorker']) expect(src.includes(sink), sink).toBe(false);
  });
});

describe('OB-323: a kept signed copy of an appointment letter is looked at by its id', () => {
  it('reads the scan with its bytes from its own route', async () => {
    const ho = fakeHeadOffice();
    const s = createAppointmentLettersSession({ viewer: v('hr.appointmentletter.issue'), fetch: ho.fetch });
    await s.signedScan('AL-1', 'scan-abc');
    expect(ho.sent).toEqual([{ method: 'GET', path: '/v1/hr/workforce/appointment-letters/AL-1/signed-scan/scan-abc', body: undefined }]);
  });
});

// W5 · OB-684 (owner, 3 Nov 2026) · C15 · C16 · C19: the separate "Payroll legal figures" page's session — the legal figures
// alone; the CA's words reach them, and nothing that names a person or their pay is on it.
describe('OB-684: the Payroll legal figures session carries the legal figures only', () => {
  const CA_WORDS = ROLE_CATALOGUE.find((r) => r.id === 'chartered_accountant')!.permissions;
  it('the CA reads and fills the legal figures with their own words (and holds no payroll.statutory.read)', async () => {
    expect(CA_WORDS).toEqual(expect.arrayContaining(['payroll.legal.read', 'payroll.legal.configure']));
    expect(CA_WORDS).not.toContain('payroll.statutory.read');
    const ho = fakeHeadOffice();
    const ca = createPayrollLegalSession({ viewer: { userId: 'u-ca', permissions: CA_WORDS }, fetch: ho.fetch });
    expect(ca.may).toEqual({ named: true, legalRead: true, legalSet: true });
    await ca.legalSettings();
    await ca.setFigure('overtimeMultiplierPercent', { value: '200', source: 'Code on Wages 2019', confirmation: 'CA ref 1' });
    expect(ho.sent.map((x) => `${x.method} ${x.path}`)).toEqual(['GET /v1/hr/payroll/legal-settings', 'POST /v1/hr/payroll/legal-settings/overtimeMultiplierPercent']);
  });
  it('offers nothing about a person or their pay — no payslip, no check, no totals, no late or issued list', () => {
    const ca = createPayrollLegalSession({ viewer: { userId: 'u-ca', permissions: CA_WORDS } });
    expect(Object.keys(ca).sort()).toEqual(['legalSettings', 'may', 'setFigure', 'setMinimumWage', 'setParticulars']);
  });
  it('a cashier is refused before anything is sent; nobody signed in is said', async () => {
    const ho = fakeHeadOffice();
    const till = createPayrollLegalSession({ viewer: { userId: 'u-till', permissions: ROLE_CATALOGUE.find((r) => r.id === 'cashier')!.permissions }, fetch: ho.fetch });
    expect(await till.legalSettings()).toEqual({ result: 'invalid', why: 'cannotReadLegal' });
    expect(await till.setFigure('overtimeMultiplierPercent', { value: '200', source: 's', confirmation: 'c' })).toEqual({ result: 'invalid', why: 'cannotSetLegal' });
    expect(await createPayrollLegalSession({ viewer: undefined, fetch: ho.fetch }).legalSettings()).toEqual({ result: 'invalid', why: 'nobody' });
    expect(ho.sent).toEqual([]);
  });
  it('the page\'s own words have their Tamil twins', () => {
    expect(PAYROLL_STATUTORY_COPY.ta.legalPageH).toBe('ஊதியச் சட்ட எண்கள்');
    expect(PAYROLL_STATUTORY_COPY.en.legalPageLead).toMatch(/Nobody's pay, no payslip and no total for any person/);
  });
});

// W5 · OB-686 (owner, 3 Nov 2026) · M25-FR-01: the labour-cost guide is the owner's setting — no built-in 12%.
describe('OB-686: the owner\'s labour-cost guide', () => {
  it('reads it; only the owner sets it, as a percentage of sales sent in basis points', async () => {
    const ho = fakeHeadOffice();
    const owner = createWorkingTimeSession({ viewer: v('workforce.roster.read', 'workforce.labour.guide.set'), fetch: ho.fetch });
    await owner.labourGuide();
    for (const bad of ['', 'twelve', '0', '100.5', '-3']) expect(await owner.setLabourGuide(bad), bad).toEqual({ result: 'invalid', why: 'badGuide' });
    await owner.setLabourGuide(' 9.5% ');
    expect(ho.sent.map((x) => [`${x.method} ${x.path}`, x.body])).toEqual([['GET /v1/hr/workforce/labour-cost-guide', undefined], ['POST /v1/hr/workforce/labour-cost-guide', { guideBps: 950 }]]);
    const mgr = createWorkingTimeSession({ viewer: v('workforce.roster.read', 'workforce.roster.manage'), fetch: ho.fetch });
    expect(await mgr.setLabourGuide('10')).toEqual({ result: 'invalid', why: 'cannotSet' });
    expect(ho.sent).toHaveLength(2);
    expect(ROLE_CATALOGUE.filter((r) => r.permissions.includes('workforce.labour.guide.set')).map((r) => r.id)).toEqual(['owner']);
  });
  it('says "not set by the owner" in English and Tamil', () => {
    expect(WORKING_TIME_COPY.en.guideOwnerNotSet).toBe('Not set by the owner — the cost and its share are shown, and nothing is compared.');
    expect(WORKING_TIME_COPY.en.guideNotSet).toBe('guide not set by the owner — nothing compared');
    expect(Object.keys(WORKING_TIME_COPY.ta).sort()).toEqual(Object.keys(WORKING_TIME_COPY.en).sort());
  });
});
