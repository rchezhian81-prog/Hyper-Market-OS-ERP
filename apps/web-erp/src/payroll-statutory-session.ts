// W5 (R4 · C15 statutory payslip · C16 hours, overtime and minimum wage · C19 EPF and ESI · OB-208 · OB-209 · OB-228) — the
// statutory pay checks on the Payroll page, over head office's own routes that no screen reached. COMPUTE AND SHOW ONLY:
//
//   • the CA's legal figures — `GET /v1/hr/payroll/legal-settings`: every EPF / ESI rate, ceiling and headcount threshold,
//     the normal hours, the overtime multiplier, each minimum-wage class and the payslip particulars list, each "confirmed"
//     or "not confirmed" with what is missing (OB-208: nothing is assumed). The CA — or the owner on the CA's written
//     confirmation — fills one (`POST …/legal-settings/:key`, `payroll.legal.configure`); head office refuses overtime
//     below 2× by name (C16);
//   • prepare one person's payslip for review — `POST /v1/hr/payroll/statutory-payslips/:employeeId/:period`: the hours come
//     from attendance and the roles and hourly rate from the staff directory (never typed here); head office refuses "below
//     minimum wage" and "overtime below 2×" by name;
//   • the month's statutory check — `GET /v1/hr/payroll/statutory-check/:period`: every check not made, each payslip
//     prepared, the EPF / ESI reconciliation and the payslips late for their pay date;
//   • the month's EPF / ESI totals from the return or challan — `POST /v1/hr/payroll/contributions/:period/totals` — and
//     whether they equal the payslips to the paisa (`GET …/contributions/:period`);
//   • payslips late for their pay date (`GET /v1/hr/payroll/payslip-exceptions?period=`) and the periods issued for one
//     person (`GET /v1/hr/payroll/payslips/:employeeId`).
//
// HELD, and never reached from here (OB-209 · OB-228 · C15 "no real payslip is issued"): issuing a payslip to a person,
// approving, locking or reversing a pay run, the release switch and the salary bank file. Nothing is cached or stored in
// the browser; every figure is read live under the signed-in person's own session. Every word has a Tamil twin.

import { makeCaller, outcomeIn, type Outcome } from './r4-insight-call';

export type Lang = 'en' | 'ta';

export const PAYROLL_STATUTORY_COPY = {
  en: {
    holdNote: 'Prepare and show only. Issuing payslips to staff, approving, locking and the salary bank file stay on hold (owner decision OB-209).',
    legalH: 'The CA\'s legal figures', legalLead: 'Every figure is the CA\'s to fill, with where it comes from and their reference. Until then it shows "not confirmed" and the check that needs it says "not checked".',
    confirmed: 'confirmed', not_confirmed: 'not confirmed', figure: 'Figure', value: 'Value', source: 'Where it comes from (Act, rule, notification)', confirmation: 'Confirmed by the CA (name and reference)',
    save: 'Save', saved: 'Saved on head office.', overtimeFloor: 'Overtime is never paid at less than twice the ordinary rate.',
    minWageH: 'Minimum-wage classes', classId: 'Class code (lower case, e.g. shop-assistant)', classLabel: 'Class name', classRoles: 'Staff roles it covers (comma between)', monthly: 'Full-month minimum wage (₹)', noClasses: 'No minimum-wage class is filled yet.',
    particularsH: 'What every payslip must show', particularsSave: 'Save the list',
    prepareH: 'Prepare a payslip for review', employee: 'Staff number', period: 'Month (YYYY-MM)', payDate: 'Pay date', paidDays: 'Paid days in the month',
    basic: 'Basic pay and DA for the month (₹, counts towards PF wage)', other: 'Other allowances for the month (₹, optional)', prepare: 'Prepare',
    prepared: 'Prepared for review — not issued.', gross: 'Gross', net: 'Net pay', hoursWorked: 'Hours worked', notCheckedList: 'Not checked:', allChecked: 'Every check was made.',
    checkH: 'The month\'s statutory check', showCheck: 'Show the check', payRunSays: 'The pay run says', payslipsPrepared: 'Payslips prepared', nonePrepared: 'No payslip is prepared for this month yet.', preparedBy: 'prepared by',
    contribH: 'EPF and ESI totals for the month', pfEmployee: 'EPF — staff share (₹)', pfEmployer: 'EPF — employer share (₹)', esiEmployee: 'ESI — staff share (₹)', esiEmployer: 'ESI — employer share (₹)',
    reference: 'Return or challan reference', recordTotals: 'Record the totals', showContrib: 'Show the reconciliation',
    reconciled: 'Totals equal the payslips to the paisa.', difference: 'DIFFERENCE between the totals and the payslips', no_totals_recorded: 'No totals recorded for this month yet.', no_payslips: 'No payslip issued for this month.',
    lateH: 'Payslips late for their pay date', showLate: 'Show late payslips', noneLate: 'No payslip is late for its pay date.',
    issuedH: 'Payslips issued to one person', showIssued: 'Show', noneIssued: 'No payslip has been issued to this person.',
    needFields: 'Fill in every field first.', badPeriod: 'Write the month as YYYY-MM.', badDate: 'Write the date as YYYY-MM-DD.', badNumber: 'Write a whole number.', badAmount: 'Write an amount in rupees, e.g. 15000 or 15000.50.',
    nobody: 'Nobody is signed in on this screen.', cannotRead: 'Your role cannot read payroll.', cannotReadLegal: 'Your role cannot read the payroll legal figures.', cannotSetLegal: 'Only the CA, or the owner on the CA\'s confirmation, fills these.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read or saved, and nothing shown is current.', reading: 'Reading from head office…',
  },
  ta: {
    holdNote: 'தயாரித்துக் காட்ட மட்டும். பணியாளர்களுக்குச் சம்பளச் சீட்டு வழங்குதல், அனுமதித்தல், பூட்டுதல், சம்பள வங்கிக் கோப்பு நிறுத்தி வைக்கப்பட்டுள்ளன (உரிமையாளர் முடிவு OB-209).',
    legalH: 'தணிக்கையாளரின் சட்ட எண்கள்', legalLead: 'ஒவ்வொரு எண்ணையும் தணிக்கையாளர் நிரப்ப வேண்டும் — அது எங்கிருந்து வருகிறது, அவரது குறிப்புடன். அதுவரை "உறுதி செய்யப்படவில்லை" எனக் காட்டும்; அது தேவைப்படும் சரிபார்ப்பு "சரிபார்க்கப்படவில்லை" எனச் சொல்லும்.',
    confirmed: 'உறுதி செய்யப்பட்டது', not_confirmed: 'உறுதி செய்யப்படவில்லை', figure: 'எண்', value: 'மதிப்பு', source: 'எங்கிருந்து (சட்டம், விதி, அறிவிப்பு)', confirmation: 'தணிக்கையாளர் உறுதி (பெயர், குறிப்பு)',
    save: 'சேமி', saved: 'தலைமை அலுவலகத்தில் சேமிக்கப்பட்டது.', overtimeFloor: 'கூடுதல் நேரம் சாதாரண விகிதத்தின் இரு மடங்குக்குக் குறையாமல் வழங்கப்படும்.',
    minWageH: 'குறைந்தபட்ச ஊதிய வகுப்புகள்', classId: 'வகுப்புக் குறியீடு (சிறிய எழுத்து, உ-ம் shop-assistant)', classLabel: 'வகுப்பின் பெயர்', classRoles: 'அது உள்ளடக்கும் பணிப் பங்குகள் (காற்புள்ளியுடன்)', monthly: 'முழு மாதக் குறைந்தபட்ச ஊதியம் (₹)', noClasses: 'இன்னும் எந்தக் குறைந்தபட்ச ஊதிய வகுப்பும் நிரப்பப்படவில்லை.',
    particularsH: 'ஒவ்வொரு சம்பளச் சீட்டும் காட்ட வேண்டியவை', particularsSave: 'பட்டியலைச் சேமி',
    prepareH: 'மதிப்பாய்வுக்குச் சம்பளச் சீட்டைத் தயாரி', employee: 'பணியாளர் எண்', period: 'மாதம் (YYYY-MM)', payDate: 'சம்பள நாள்', paidDays: 'மாதத்தில் சம்பள நாட்கள்',
    basic: 'மாத அடிப்படை ஊதியமும் அகவிலைப்படியும் (₹, PF ஊதியத்தில் சேரும்)', other: 'பிற படிகள் (₹, விருப்பம்)', prepare: 'தயாரி',
    prepared: 'மதிப்பாய்வுக்குத் தயாரிக்கப்பட்டது — வழங்கப்படவில்லை.', gross: 'மொத்தம்', net: 'நிகர ஊதியம்', hoursWorked: 'வேலை செய்த மணிநேரம்', notCheckedList: 'சரிபார்க்கப்படவில்லை:', allChecked: 'எல்லாச் சரிபார்ப்புகளும் செய்யப்பட்டன.',
    checkH: 'மாதத்தின் சட்டச் சரிபார்ப்பு', showCheck: 'சரிபார்ப்பைக் காட்டு', payRunSays: 'சம்பள ஓட்டம் சொல்வது', payslipsPrepared: 'தயாரித்த சம்பளச் சீட்டுகள்', nonePrepared: 'இந்த மாதத்துக்கு இன்னும் சம்பளச் சீட்டு தயாரிக்கப்படவில்லை.', preparedBy: 'தயாரித்தவர்',
    contribH: 'மாதத்தின் EPF, ESI மொத்தங்கள்', pfEmployee: 'EPF — பணியாளர் பங்கு (₹)', pfEmployer: 'EPF — முதலாளி பங்கு (₹)', esiEmployee: 'ESI — பணியாளர் பங்கு (₹)', esiEmployer: 'ESI — முதலாளி பங்கு (₹)',
    reference: 'தாக்கல் அல்லது செலான் குறிப்பு', recordTotals: 'மொத்தங்களைப் பதிவு செய்', showContrib: 'ஒப்பீட்டைக் காட்டு',
    reconciled: 'மொத்தங்கள் சம்பளச் சீட்டுகளுடன் பைசா வரை பொருந்துகின்றன.', difference: 'மொத்தங்களுக்கும் சம்பளச் சீட்டுகளுக்கும் வேறுபாடு', no_totals_recorded: 'இந்த மாதத்துக்கு இன்னும் மொத்தங்கள் பதிவாகவில்லை.', no_payslips: 'இந்த மாதத்துக்குச் சம்பளச் சீட்டு வழங்கப்படவில்லை.',
    lateH: 'சம்பள நாளுக்குப் பிந்திய சம்பளச் சீட்டுகள்', showLate: 'பிந்தியவற்றைக் காட்டு', noneLate: 'எந்தச் சம்பளச் சீட்டும் சம்பள நாளுக்குப் பிந்தவில்லை.',
    issuedH: 'ஒருவருக்கு வழங்கிய சம்பளச் சீட்டுகள்', showIssued: 'காட்டு', noneIssued: 'இவருக்கு எந்தச் சம்பளச் சீட்டும் வழங்கப்படவில்லை.',
    needFields: 'முதலில் எல்லாப் புலங்களையும் நிரப்புங்கள்.', badPeriod: 'மாதத்தை YYYY-MM என எழுதுங்கள்.', badDate: 'நாளை YYYY-MM-DD என எழுதுங்கள்.', badNumber: 'முழு எண்ணை எழுதுங்கள்.', badAmount: 'ரூபாயில் தொகையை எழுதுங்கள், உ-ம் 15000 அல்லது 15000.50.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', cannotRead: 'உங்கள் பங்கு சம்பளப் பட்டியலைப் படிக்க முடியாது.', cannotReadLegal: 'உங்கள் பங்கு சம்பளச் சட்ட எண்களைப் படிக்க முடியாது.', cannotSetLegal: 'தணிக்கையாளர், அல்லது அவரது உறுதியின் பேரில் உரிமையாளர், மட்டுமே இவற்றை நிரப்புவார்.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கப்படவில்லை, சேமிக்கப்படவில்லை; காட்டப்படும் எதுவும் தற்போதையது அல்ல.', reading: 'தலைமை அலுவலகத்திலிருந்து படிக்கிறது…',
  },
} as const;

export const payrollStatutoryWords = (lang: Lang, key: string): string =>
  (PAYROLL_STATUTORY_COPY[lang] as Record<string, string>)[key] ?? (PAYROLL_STATUTORY_COPY.en as Record<string, string>)[key] ?? key;
export const payrollStatutoryOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => outcomeIn((k) => payrollStatutoryWords(lang, k), out);

type Why = 'nobody' | 'cannotRead' | 'cannotReadLegal' | 'cannotSetLegal' | 'needFields' | 'badPeriod' | 'badDate' | 'badNumber' | 'badAmount';
type Done<T> = Promise<Outcome<T, Why>>;
const isPeriod = (v: string): boolean => /^\d{4}-(0[1-9]|1[0-2])$/.test(v);
const isDate = (v: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
const whole = (v: string): number | undefined => (/^\d+$/.test(v.trim()) ? Number(v.trim()) : undefined);
const enc = encodeURIComponent;

/** Rupees typed by a person ("15,000.50") into paise, or undefined when it is not an amount. */
export function paiseFrom(text: string): number | undefined {
  const t = text.replace(/[,\s₹]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return undefined;
  const [r, p = ''] = t.split('.');
  return Number(r) * 100 + Number(p.padEnd(2, '0'));
}
/** The days in a month (YYYY-MM) — a calendar fact, not a payroll figure. */
export const daysInMonth = (period: string): number => new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 0)).getUTCDate();
/** Rupees from paise, Indian grouping. */
export const statutoryRupees = (minor: number): string => `${minor < 0 ? '-' : ''}₹${(Math.abs(minor) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export interface PayrollStatutorySession {
  readonly may: { readonly named: boolean; readonly statutory: boolean; readonly legalRead: boolean; readonly legalSet: boolean };
  legalSettings(): Done<Record<string, unknown>>;
  setFigure(key: string, f: { readonly value: string; readonly source: string; readonly confirmation: string }): Done<Record<string, unknown>>;
  setMinimumWage(f: { readonly classId: string; readonly label: string; readonly roles: string; readonly monthlyRupees: string; readonly source: string; readonly confirmation: string }): Done<Record<string, unknown>>;
  setParticulars(list: readonly string[], f: { readonly source: string; readonly confirmation: string }): Done<Record<string, unknown>>;
  prepare(f: { readonly employeeId: string; readonly period: string; readonly onDate: string; readonly paidDays: string; readonly basicRupees: string; readonly otherRupees: string }): Done<Record<string, unknown>>;
  check(period: string): Done<Record<string, unknown>>;
  recordTotals(period: string, f: { readonly pfEmployee: string; readonly pfEmployer: string; readonly esiEmployee: string; readonly esiEmployer: string; readonly reference: string }): Done<Record<string, unknown>>;
  contributions(period: string): Done<Record<string, unknown>>;
  late(period: string): Done<{ readonly exceptions: readonly { readonly employeeId: string; readonly payDate: string; readonly kind: string; readonly detail: string }[]; readonly count: number }>;
  issued(employeeId: string): Done<{ readonly periods: readonly { readonly period: string; readonly onDate: string; readonly netPayMinor: number }[]; readonly count: number }>;
}

export function createPayrollStatutorySession(input: { readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined; readonly fetch?: typeof globalThis.fetch }): PayrollStatutorySession {
  const named = input.viewer?.userId !== undefined;
  const held = new Set(input.viewer?.permissions ?? []);
  const may = { named, statutory: named && held.has('payroll.statutory.read'), legalRead: named && held.has('payroll.legal.read'), legalSet: named && held.has('payroll.legal.configure') };
  const call = makeCaller({ keyPrefix: 'pay-stat', ...(input.fetch === undefined ? {} : { fetch: input.fetch }) });
  const gate = (ok: boolean, why: Why): { result: 'invalid'; why: Why } | undefined => (!named ? { result: 'invalid', why: 'nobody' } : !ok ? { result: 'invalid', why } : undefined);
  const bad = (why: Why): { result: 'invalid'; why: Why } => ({ result: 'invalid', why });
  const month = (p: string): { result: 'invalid'; why: Why } | undefined => (isPeriod(p.trim()) ? undefined : bad('badPeriod'));
  const sourced = (f: { readonly source: string; readonly confirmation: string }) => ({ source: f.source.trim(), confirmation: f.confirmation.trim() });
  return {
    may,
    legalSettings: async () => gate(may.legalRead, 'cannotReadLegal') ?? call('GET', '/v1/hr/payroll/legal-settings'),
    setFigure: async (key, f) => {
      const g = gate(may.legalSet, 'cannotSetLegal'); if (g) return g;
      if (key.trim() === '' || f.source.trim() === '' || f.confirmation.trim() === '') return bad('needFields');
      const value = whole(f.value); if (value === undefined) return bad('badNumber');
      return call('POST', `/v1/hr/payroll/legal-settings/${enc(key.trim())}`, { value, ...sourced(f) });
    },
    setMinimumWage: async (f) => {
      const g = gate(may.legalSet, 'cannotSetLegal'); if (g) return g;
      const roles = f.roles.split(',').map((r) => r.trim()).filter((r) => r !== '');
      if (!/^[a-z0-9][a-z0-9_-]{0,47}$/.test(f.classId.trim()) || f.label.trim() === '' || roles.length === 0 || f.source.trim() === '' || f.confirmation.trim() === '') return bad('needFields');
      const monthlyMinor = paiseFrom(f.monthlyRupees); if (monthlyMinor === undefined || monthlyMinor <= 0) return bad('badAmount');
      return call('POST', `/v1/hr/payroll/legal-settings/minimum-wage-${enc(f.classId.trim())}`, { label: f.label.trim(), roles, monthlyMinor, ...sourced(f) });
    },
    setParticulars: async (list, f) => {
      const g = gate(may.legalSet, 'cannotSetLegal'); if (g) return g;
      if (list.length === 0 || f.source.trim() === '' || f.confirmation.trim() === '') return bad('needFields');
      return call('POST', '/v1/hr/payroll/legal-settings/payslip-particulars', { particulars: [...list], ...sourced(f) });
    },
    prepare: async (f) => {
      const g = gate(may.statutory, 'cannotRead'); if (g) return g;
      if (f.employeeId.trim() === '') return bad('needFields');
      const p = f.period.trim(); const m = month(p); if (m) return m;
      if (!isDate(f.onDate.trim())) return bad('badDate');
      const paidDays = whole(f.paidDays); if (paidDays === undefined) return bad('badNumber');
      const basic = paiseFrom(f.basicRupees); if (basic === undefined) return bad('badAmount');
      const other = f.otherRupees.trim() === '' ? 0 : paiseFrom(f.otherRupees); if (other === undefined) return bad('badAmount');
      // Basic pay and DA make the PF wage (EPF Act's definition); other allowances do not. Hours, roles, the hourly rate and
      // the headcount are head office's to read — never sent.
      const components = [{ code: 'BASIC', monthlyMinor: basic, partOfPfWage: true }, ...(other > 0 ? [{ code: 'ALLOWANCES', monthlyMinor: other }] : [])];
      return call('POST', `/v1/hr/payroll/statutory-payslips/${enc(f.employeeId.trim())}/${enc(p)}`, { onDate: f.onDate.trim(), attendance: { calendarDaysInMonth: daysInMonth(p), paidDays }, components });
    },
    check: async (p) => gate(may.statutory, 'cannotRead') ?? month(p) ?? call('GET', `/v1/hr/payroll/statutory-check/${enc(p.trim())}`),
    recordTotals: async (p, f) => {
      const g = gate(may.statutory, 'cannotRead') ?? month(p); if (g) return g;
      if (f.reference.trim() === '') return bad('needFields');
      const amounts = [f.pfEmployee, f.pfEmployer, f.esiEmployee, f.esiEmployer].map(paiseFrom);
      if (amounts.some((a) => a === undefined)) return bad('badAmount');
      const [pfEmployeeMinor, pfEmployerMinor, esiEmployeeMinor, esiEmployerMinor] = amounts as number[];
      return call('POST', `/v1/hr/payroll/contributions/${enc(p.trim())}/totals`, { pfEmployeeMinor, pfEmployerMinor, esiEmployeeMinor, esiEmployerMinor, reference: f.reference.trim() });
    },
    contributions: async (p) => gate(may.statutory, 'cannotRead') ?? month(p) ?? call('GET', `/v1/hr/payroll/contributions/${enc(p.trim())}`),
    late: async (p) => gate(may.statutory, 'cannotRead') ?? month(p) ?? call('GET', `/v1/hr/payroll/payslip-exceptions?period=${enc(p.trim())}`),
    issued: async (e) => gate(may.statutory, 'cannotRead') ?? (e.trim() === '' ? bad('needFields') : call('GET', `/v1/hr/payroll/payslips/${enc(e.trim())}`)),
  };
}
