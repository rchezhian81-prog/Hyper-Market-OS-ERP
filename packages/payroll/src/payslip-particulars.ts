// Payslip particulars and the pay-date clock (R4 · C15 · OB-208 · OB-209 · OB-227). The signed sentence:
//   "Every payslip carries each particular on the CA's list. One missing a listed particular cannot be issued ('payslip
//    particular missing: <name>'). A payslip not issued by the pay date reaches the owner as an exception. An employee
//    sees only their own payslip. Until the CA fills the list, each particular shows 'not confirmed' on the payslip and
//    nothing is guessed. Approving, locking and the bank file stay on hold; no real payslip is issued and no pay is
//    released."
//
// The particulars a payslip can carry are named in `PAYSLIP_PARTICULARS` (legal-settings.ts). Derived ones are read from
// the payslip; supplied ones are given when the payslip is issued. The CA's list says which are required. While the list
// is not confirmed nothing is refused on it — every particular is shown "not confirmed" — because a check that cannot be
// judged blocks nothing (OB-208).
//
// Pure and deterministic: no clock, no I/O (the caller passes "today" and the issue time).

import { PAYSLIP_PARTICULARS, PAYSLIP_PARTICULAR_KEYS, particularsListConfirmed, type ParticularsList, type PayslipParticularKey } from './legal-settings';
import type { Payslip } from './payslip';

/** Refused: a listed particular the payslip does not carry ("payslip particular missing: <name>"). */
export class PayslipParticularMissing extends Error {
  readonly code = 'payslip_particular_missing';
  readonly missing: readonly PayslipParticularKey[];
  constructor(missing: readonly PayslipParticularKey[]) {
    super(missing.map((k) => `payslip particular missing: ${PAYSLIP_PARTICULARS[k].label}`).join('; '));
    this.name = 'PayslipParticularMissing';
    this.missing = missing;
  }
}

export interface ParticularLine {
  readonly key: PayslipParticularKey;
  readonly label: string;
  /** 'carried' / 'missing' against a confirmed list; 'not_confirmed' while the CA's list is not confirmed. */
  readonly status: 'carried' | 'missing' | 'not_required' | 'not_confirmed';
  /** What the payslip shows for it, when it carries it. */
  readonly value?: string;
}

export interface ParticularsCheck {
  readonly listStatus: 'confirmed' | 'not_confirmed';
  readonly lines: readonly ParticularLine[];
  readonly missing: readonly PayslipParticularKey[];
}

/** A payslip as the particulars check reads it: the payslip, and optionally the R4 statutory checks it carries. */
export interface PayslipForParticulars {
  readonly employeeId: string;
  readonly period: string;
  readonly payslip: Payslip & { readonly statutoryChecks?: { readonly hoursWorked?: unknown; readonly overtime?: unknown } };
  /** The supplied particulars (name, address, designation…), as given when the payslip is issued. */
  readonly supplied: Readonly<Partial<Record<PayslipParticularKey, string>>>;
}

const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);
const num = (v: unknown): string | undefined => (Number.isInteger(v) ? String(v) : undefined);

/** What the payslip carries for a particular, or undefined when it carries nothing for it. */
function valueOf(p: PayslipForParticulars, key: PayslipParticularKey): string | undefined {
  const s = p.payslip;
  switch (key) {
    case 'employeeId': return text(p.employeeId);
    case 'payPeriod': return text(p.period);
    case 'payDate': return text(s.onDate);
    case 'daysPaid': return num(s.paidDays);
    case 'lossOfPayDays': return num(s.lopDays);
    case 'earnings': return Array.isArray(s.earnings) && s.earnings.length > 0 ? s.earnings.map((e) => e.code).join(', ') : undefined;
    case 'grossWages': return num(s.grossMinor);
    case 'deductions': return s.statutory !== undefined && s.statutory !== null ? num(s.statutory.totalEmployeeDeductionMinor) : undefined;
    case 'employerContributions': return s.statutory !== undefined && s.statutory !== null ? num(s.statutory.totalEmployerContributionMinor) : undefined;
    case 'netPay': return num(s.netPayMinor);
    case 'hoursWorked': return s.statutoryChecks?.hoursWorked !== undefined ? 'shown' : undefined;
    case 'overtimeHours': return s.statutoryChecks?.overtime !== undefined ? 'shown' : undefined;
    default: return text(p.supplied[key]);
  }
}

/** The payslip's particulars against the CA's list. Never throws — `assertParticulars` refuses. Pure. */
export function checkParticulars(list: ParticularsList, p: PayslipForParticulars): ParticularsCheck {
  const confirmed = particularsListConfirmed(list);
  const required = new Set(confirmed ? list.particulars ?? [] : []);
  const lines = PAYSLIP_PARTICULAR_KEYS.map((key): ParticularLine => {
    const value = valueOf(p, key);
    const label = PAYSLIP_PARTICULARS[key].label;
    const shown = value === undefined ? {} : { value };
    if (!confirmed) return { key, label, status: 'not_confirmed', ...shown };
    if (!required.has(key)) return { key, label, status: 'not_required', ...shown };
    return value === undefined ? { key, label, status: 'missing' } : { key, label, status: 'carried', value };
  });
  return { listStatus: confirmed ? 'confirmed' : 'not_confirmed', lines, missing: lines.filter((l) => l.status === 'missing').map((l) => l.key) };
}

/** Refuse a payslip that is missing a particular on the CA's confirmed list. Pure. */
export function assertParticulars(list: ParticularsList, p: PayslipForParticulars): ParticularsCheck {
  const check = checkParticulars(list, p);
  if (check.missing.length > 0) throw new PayslipParticularMissing(check.missing);
  return check;
}

// ── the pay-date clock ──────────────────────────────────────────────────────────────────────────────────────────────

/** A payslip the pay run expects (prepared for review), and whether and when it was issued. */
export interface ExpectedPayslip {
  readonly employeeId: string;
  readonly period: string;
  /** The pay date (YYYY-MM-DD) — the payslip's own date. */
  readonly payDate: string;
  /** When it was issued (ISO instant), if it was. */
  readonly issuedAt?: string;
}

export interface PayslipLateException {
  readonly employeeId: string;
  readonly period: string;
  readonly payDate: string;
  readonly kind: 'not_issued_by_pay_date' | 'issued_after_pay_date';
  readonly issuedOn?: string;
  readonly detail: string;
}

/** The store-local calendar date of an instant (India is UTC+05:30 = 330 minutes). */
export const localDate = (iso: string, utcOffsetMinutes: number): string => new Date(Date.parse(iso) + utcOffsetMinutes * 60_000).toISOString().slice(0, 10);

/**
 * Every expected payslip not issued by its pay date: still not issued once the pay date has passed, or issued on a later
 * day. A payslip issued on the pay date itself is on time. Pure — `today` is the store-local date.
 */
export function payslipsLateForPayDate(input: { readonly expected: readonly ExpectedPayslip[]; readonly today: string; readonly utcOffsetMinutes: number }): readonly PayslipLateException[] {
  const out: PayslipLateException[] = [];
  for (const e of input.expected) {
    if (e.issuedAt === undefined) {
      if (input.today > e.payDate) out.push({ employeeId: e.employeeId, period: e.period, payDate: e.payDate, kind: 'not_issued_by_pay_date', detail: `${e.employeeId}'s payslip for ${e.period} was not issued by the pay date ${e.payDate}` });
      continue;
    }
    const on = localDate(e.issuedAt, input.utcOffsetMinutes);
    if (on > e.payDate) out.push({ employeeId: e.employeeId, period: e.period, payDate: e.payDate, kind: 'issued_after_pay_date', issuedOn: on, detail: `${e.employeeId}'s payslip for ${e.period} was issued on ${on}, after the pay date ${e.payDate}` });
  }
  return out.sort((a, b) => a.payDate.localeCompare(b.payDate) || a.employeeId.localeCompare(b.employeeId));
}
