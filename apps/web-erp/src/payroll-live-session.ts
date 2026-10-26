// Payroll and My payslip as the STORE COMPUTER serves them (OB-380 · OB-209 · OB-228 · P-04 · P-08). A tested, DOM-free
// session.
//
// The two payroll pages were built for an online payroll server that injects a whole pay run into the page; with nothing
// injected they show a stamped DEMO. On the store computer neither is right: the box holds no payroll (nothing sensitive
// is ever kept on the shop's machine), and a demo — or an empty run reading "no run drafted, ₹0.00" — would show
// something that is not head office's answer as if it were (P-08). So, served by the box, both pages read head office
// LIVE, in the signed-in person's own session, and only read:
//
//   • Payroll — the owner's pay-release switch in head office's own words (OB-228: approve, lock and the bank file are
//     refused while it is off), and one pay run looked up by its number: period, stage, who submitted it, who approved
//     it, how many people and the net total. No state change is offered from this page — the pilot hold stays (OB-209).
//   • My payslip — the person's OWN latest issued payslip (`GET /v1/hr/payroll/my-payslip`, self-scoped and redacted by
//     head office); "none issued yet" is head office's answer, said as such.
//
// Head office unreachable → "nothing was read, nothing shown is current"; refused → head office's words. English and
// Tamil. Nothing is cached, stored or written.

import { makeCaller, type Outcome } from './r4-insight-call';
import type { PayRunAggregate } from '../../../packages/payroll/src/pay-run';
import type { EmployeeSelfView } from '../../../packages/payroll/src/ess';

export type Lang = 'en' | 'ta';

export const PAYROLL_LIVE_COPY = {
  en: {
    servedLead: 'Read from head office as you open it. This page only reads: approving, locking and the salary bank file are not done from here.',
    hold: 'Pay release', holdOn: 'Switched on by the owner', holdOff: 'Held — switched off', setBy: 'Set by', why: 'Why',
    runNumber: 'Pay run number', show: 'Show the pay run', period: 'Month', stage: 'Stage', submittedBy: 'Submitted by', approvedBy: 'Approved by',
    people: 'People paid', net: 'Net pay, all staff', lockedAt: 'Locked at', reversed: 'Reversed because', notGiven: 'not given',
    s_draft: 'Draft', s_submitted: 'Awaiting approval', s_approved: 'Approved — awaiting lock', s_locked: 'Locked', s_reversed: 'Reversed',
    noRunNumber: 'Type the pay run number head office gave it.', notFound: 'Head office has no pay run with that number.',
    reading: 'Reading from head office…', nobody: 'Nobody is signed in on this screen, so nothing is read.',
    cannotRead: 'Your role cannot read payroll.', cannotReadOwn: 'Your role cannot read a payslip.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read, and nothing shown is current.',
    noneIssued: 'Head office has not issued you a payslip yet.',
  },
  ta: {
    servedLead: 'திறக்கும்போது தலைமை அலுவலகத்திலிருந்து படிக்கப்படுகிறது. இந்தப் பக்கம் படிக்க மட்டுமே: அனுமதித்தல், பூட்டுதல், சம்பள வங்கிக் கோப்பு இங்கிருந்து செய்யப்படாது.',
    hold: 'சம்பள வெளியீடு', holdOn: 'உரிமையாளரால் இயக்கப்பட்டது', holdOff: 'நிறுத்தி வைக்கப்பட்டுள்ளது — அணைக்கப்பட்டது', setBy: 'அமைத்தவர்', why: 'காரணம்',
    runNumber: 'சம்பள ஓட்ட எண்', show: 'சம்பள ஓட்டத்தைக் காட்டு', period: 'மாதம்', stage: 'நிலை', submittedBy: 'சமர்ப்பித்தவர்', approvedBy: 'அனுமதித்தவர்',
    people: 'சம்பளம் பெறுவோர்', net: 'நிகர சம்பளம், அனைத்துப் பணியாளர்', lockedAt: 'பூட்டிய நேரம்', reversed: 'திருப்பியதற்கான காரணம்', notGiven: 'கொடுக்கப்படவில்லை',
    s_draft: 'வரைவு', s_submitted: 'அனுமதிக்காகக் காத்திருக்கிறது', s_approved: 'அனுமதிக்கப்பட்டது — பூட்டக் காத்திருக்கிறது', s_locked: 'பூட்டப்பட்டது', s_reversed: 'திருப்பப்பட்டது',
    noRunNumber: 'தலைமை அலுவலகம் கொடுத்த சம்பள ஓட்ட எண்ணை உள்ளிடுங்கள்.', notFound: 'அந்த எண்ணில் தலைமை அலுவலகத்தில் சம்பள ஓட்டம் இல்லை.',
    reading: 'தலைமை அலுவலகத்திலிருந்து படிக்கப்படுகிறது…', nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை; அதனால் எதுவும் படிக்கப்படவில்லை.',
    cannotRead: 'உங்கள் பங்கு சம்பளப் பட்டியலைப் படிக்க முடியாது.', cannotReadOwn: 'உங்கள் பங்கு சம்பளச் சீட்டைப் படிக்க முடியாது.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கப்படவில்லை; காட்டப்படும் எதுவும் தற்போதையது அல்ல.',
    noneIssued: 'தலைமை அலுவலகம் உங்களுக்கு இன்னும் சம்பளச் சீட்டு வழங்கவில்லை.',
  },
} as const;

export const payrollLiveWords = (lang: Lang, key: string): string =>
  (PAYROLL_LIVE_COPY[lang] as Record<string, string>)[key] ?? (PAYROLL_LIVE_COPY.en as Record<string, string>)[key] ?? key;

/** The words for an outcome that is not ok. */
export function payrollLiveOutcome(lang: Lang, out: Outcome<unknown>): string {
  const w = (k: string) => payrollLiveWords(lang, k);
  if (out.result === 'refused') return out.status === 404 ? w('notFound') : `${w('refused')} ${out.whatHappened}`;
  if (out.result === 'invalid') return w(out.why);
  if (out.result === 'lost_link') return w('unreachable');
  return '';
}

/** Head office's pay-release switch (`GET /v1/hr/payroll/release-switch`). */
export interface PayReleaseRead { readonly on: boolean; readonly state: string; readonly setBy: string | null; readonly setAt: string | null; readonly reason: string | null }
/** Head office's answer for the person's own payslip. */
export interface OwnPayslipRead { readonly issued: boolean; readonly period?: string; readonly view?: EmployeeSelfView }

/** Rupees from paise, Indian grouping. */
export const rupees = (minor: number): string => `${minor < 0 ? '-' : ''}₹${(Math.abs(minor) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** One pay run in rows of words: what a person reads, in the order they read it. Absent facts are said, never zero. */
export function payRunRows(lang: Lang, run: PayRunAggregate): readonly { readonly label: string; readonly value: string }[] {
  const w = (k: string) => payrollLiveWords(lang, k);
  const rows = [
    { label: w('period'), value: run.payPeriod },
    { label: w('stage'), value: w(`s_${run.state}`) },
    { label: w('submittedBy'), value: run.submittedBy ?? w('notGiven') },
    { label: w('approvedBy'), value: run.approvedBy ?? w('notGiven') },
    { label: w('people'), value: run.employeeCount === undefined ? w('notGiven') : String(run.employeeCount) },
    { label: w('net'), value: run.netTotalMinor === undefined ? w('notGiven') : rupees(run.netTotalMinor) },
  ];
  if (run.lockedAt !== undefined) rows.push({ label: w('lockedAt'), value: run.lockedAt });
  if (run.reversedReason !== undefined) rows.push({ label: w('reversed'), value: run.reversedReason });
  return rows;
}

/** The pay-release switch in words: on/off as head office says it, and who set it, when and why. */
export function holdWords(lang: Lang, hold: PayReleaseRead): { readonly headline: string; readonly detail: string; readonly on: boolean } {
  const w = (k: string) => payrollLiveWords(lang, k);
  const who = hold.setBy === null ? '' : `${w('setBy')}: ${hold.setBy}${hold.setAt === null ? '' : ` · ${hold.setAt}`}${hold.reason === null ? '' : ` · ${w('why')}: ${hold.reason}`}`;
  return { headline: `${w('hold')}: ${hold.on ? w('holdOn') : w('holdOff')}`, detail: [hold.state, who].filter((x) => x !== '').join(' '), on: hold.on };
}

export interface PayrollLiveSession {
  readonly may: { readonly named: boolean; readonly readRun: boolean; readonly readOwn: boolean };
  readHold(): Promise<Outcome<PayReleaseRead, 'nobody' | 'cannotRead'>>;
  readRun(payRunId: string): Promise<Outcome<PayRunAggregate, 'nobody' | 'cannotRead' | 'noRunNumber'>>;
  readOwn(): Promise<Outcome<OwnPayslipRead, 'nobody' | 'cannotReadOwn'>>;
}

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function createPayrollLiveSession(input: { readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined; readonly fetch?: typeof globalThis.fetch }): PayrollLiveSession {
  const named = input.viewer?.userId !== undefined;
  const held = new Set(input.viewer?.permissions ?? []);
  const may = { named, readRun: named && held.has('payroll.statutory.read'), readOwn: named && held.has('payroll.ess.self') };
  const call = makeCaller({ keyPrefix: 'payroll-live', ...(input.fetch === undefined ? {} : { fetch: input.fetch }) });
  return {
    may,
    readHold: async () => {
      if (!named) return { result: 'invalid', why: 'nobody' };
      if (!may.readRun) return { result: 'invalid', why: 'cannotRead' };
      return call<PayReleaseRead>('GET', '/v1/hr/payroll/release-switch');
    },
    readRun: async (payRunId) => {
      if (!named) return { result: 'invalid', why: 'nobody' };
      if (!may.readRun) return { result: 'invalid', why: 'cannotRead' };
      const id = payRunId.trim();
      if (!RUN_ID.test(id)) return { result: 'invalid', why: 'noRunNumber' };
      return call<PayRunAggregate>('GET', `/v1/hr/payroll/pay-run/${encodeURIComponent(id)}`);
    },
    readOwn: async () => {
      if (!named) return { result: 'invalid', why: 'nobody' };
      if (!may.readOwn) return { result: 'invalid', why: 'cannotReadOwn' };
      return call<OwnPayslipRead>('GET', '/v1/hr/payroll/my-payslip');
    },
  };
}
