// Payroll — employee self-service (ESS, WP3 inc8). Every earlier increment served HR/finance: computing
// deductions, running a pay run, making the bank file and the journal — all behind the confidential,
// owner-held `payroll.statutory.read`. This is the OTHER side of payroll: letting an employee see THEIR
// OWN payslip and, if they are leaving, their own final settlement — and NOTHING about anyone else.
//
// Two controls make that safe, and they are separate on purpose:
//   • **Self-scope** — the request names a subject employee, and `assertSelfScope` refuses unless it is the
//     caller's own identity. The route feeds the caller's authenticated principal as the requester, so this
//     is forge-proof: holding the self-service permission still does not let you name a colleague. This is
//     the primary control (P-04 least privilege, roadmap RBAC confidentiality).
//   • **Redaction** — `employeeSelfView` builds a purpose-shaped, employee-facing view: the employee's own
//     earnings, the deductions taken FROM THEM, their net, and their employer's contributions shown
//     SEPARATELY and labelled as a company cost (not a deduction). It carries no approver identity, no
//     cost-centre, no bank detail, no other employee — those are simply not in the shape it produces.
//
// Pure and deterministic — no clock, no I/O. Exact integer paise. Reads only; commits nothing.

import type { Payslip } from './payslip';
import type { Settlement } from './settlement';

/** The caller asked for a record that is not their own — a self-service boundary breach. */
export class EssAccessDenied extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EssAccessDenied';
  }
}

/** The supplied payslip/settlement was structurally unusable. */
export class InvalidEssInput extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidEssInput';
  }
}

/**
 * Refuse unless the requester is asking for their OWN record. The requester identity must come from the
 * authenticated principal (never the request body) for this to be forge-proof. Pure.
 */
export function assertSelfScope(input: { requesterEmployeeId: string; subjectEmployeeId: string }): void {
  const { requesterEmployeeId, subjectEmployeeId } = input;
  if (typeof requesterEmployeeId !== 'string' || requesterEmployeeId.length === 0) {
    throw new EssAccessDenied('the requester identity is missing');
  }
  if (typeof subjectEmployeeId !== 'string' || subjectEmployeeId.length === 0) {
    throw new EssAccessDenied('the subject employee is missing');
  }
  if (requesterEmployeeId !== subjectEmployeeId) {
    throw new EssAccessDenied(`self-service is limited to your own record — "${requesterEmployeeId}" may not read "${subjectEmployeeId}"`);
  }
}

// --- the employee-facing view ------------------------------------------------------------------------

export interface EssMoneyLine {
  readonly label: string;
  readonly amountMinor: number;
}

export interface EssEarningLine {
  readonly code: string;
  readonly amountMinor: number;
}

/** A leaver's own final-settlement summary — their own earnings and recoveries, and the net. */
export interface EssSettlementSummary {
  readonly earnings: readonly EssMoneyLine[];
  readonly recoveries: readonly EssMoneyLine[];
  /** Signed: positive is payable to you, negative is recoverable from you. */
  readonly netSettlementMinor: number;
  readonly payableToEmployee: boolean;
}

export interface EmployeeSelfView {
  readonly employeeId: string;
  /** The pay date the payslip is for. */
  readonly payPeriod: string;
  readonly earnings: readonly EssEarningLine[];
  readonly grossMinor: number;
  /** The deductions taken FROM the employee (PF/ESI employee share, PT, TDS). Zero lines omitted. */
  readonly deductions: readonly EssMoneyLine[];
  readonly totalDeductionsMinor: number;
  readonly netPayMinor: number;
  /** The employer's own statutory cost — shown for transparency, clearly NOT a deduction from the employee. */
  readonly employerContributions: {
    readonly note: string;
    readonly totalMinor: number;
    readonly lines: readonly EssMoneyLine[];
  };
  /** Present only if the employee is a leaver with a computed final settlement. */
  readonly settlement?: EssSettlementSummary;
  /**
   * R4 (C15 · C16 · C19): present when the payslip was prepared with the statutory checks — the hours the employee
   * actually worked each day, their overtime, why PF / ESI were or were not deducted, and each particular (shown
   * "not confirmed" until the CA's list is confirmed). Their own record only.
   */
  readonly statutoryNotes?: EssStatutoryNotes;
  readonly confirmWithCa: true;
}

export interface EssStatutoryNotes {
  readonly hoursWorked: readonly { readonly date: string; readonly workedMinutes: number }[];
  readonly totalWorkedMinutes: number;
  readonly overtime: { readonly overtimeMinutes: number | null; readonly payMinor: number | null; readonly detail: string };
  readonly contributions: readonly string[];
  readonly particulars?: readonly { readonly label: string; readonly status: string; readonly value?: string }[];
}

/** The R4 notes a payslip carries, read defensively (a payslip issued before R4 has none). */
function statutoryNotesOf(p: unknown): EssStatutoryNotes | undefined {
  const c = (p as { statutoryChecks?: Record<string, unknown> }).statutoryChecks;
  if (c === undefined || c === null || typeof c !== 'object') return undefined;
  const hw = c['hoursWorked'] as { days?: { date: string; workedMinutes: number }[]; totalWorkedMinutes?: number } | undefined;
  const ot = c['overtime'] as { overtimeMinutes?: number | null; pay?: { payMinor?: number | null; detail?: string } } | undefined;
  const co = c['contributions'] as { pf?: { why?: string }; esi?: { why?: string } } | undefined;
  const parts = (p as { particulars?: { lines?: { label: string; status: string; value?: string }[] } }).particulars;
  return {
    hoursWorked: (hw?.days ?? []).map((d) => ({ date: d.date, workedMinutes: d.workedMinutes })),
    totalWorkedMinutes: hw?.totalWorkedMinutes ?? 0,
    overtime: { overtimeMinutes: ot?.overtimeMinutes ?? null, payMinor: ot?.pay?.payMinor ?? null, detail: ot?.pay?.detail ?? '' },
    contributions: [co?.pf?.why, co?.esi?.why].filter((w): w is string => typeof w === 'string'),
    ...(Array.isArray(parts?.lines) ? { particulars: parts!.lines.map((l) => ({ label: l.label, status: l.status, ...(l.value === undefined ? {} : { value: l.value }) })) } : {}),
  };
}

export interface EmployeeSelfViewInput {
  /** The authenticated caller's identity — MUST be the principal, not a body field. */
  readonly requesterEmployeeId: string;
  /** Whose record is being asked for. */
  readonly subjectEmployeeId: string;
  /** The subject employee's own payslip (later increments will look this up from a durable store). */
  readonly payslip: Payslip;
  /** The subject employee's own final settlement, if they are leaving. */
  readonly settlement?: Settlement;
}

function assertInt(label: string, v: unknown): number {
  if (!Number.isInteger(v)) throw new InvalidEssInput(`${label} must be a whole paise amount`);
  return v as number;
}

/**
 * Build an employee's own payslip view, self-scoped and redacted. Refuses (EssAccessDenied) unless the
 * requester is the subject — so the engine cannot produce a cross-employee view even if a caller forgets
 * the route guard. Reads only the employee's own money; employer cost is shown separately, never as a
 * deduction. Pure.
 */
export function employeeSelfView(input: EmployeeSelfViewInput): EmployeeSelfView {
  assertSelfScope({ requesterEmployeeId: input.requesterEmployeeId, subjectEmployeeId: input.subjectEmployeeId });

  const p = input.payslip;
  if (p === null || typeof p !== 'object' || !Array.isArray(p.earnings) || p.statutory === null || typeof p.statutory !== 'object') {
    throw new InvalidEssInput('the payslip is missing its earnings or statutory breakdown');
  }
  const st = p.statutory;

  const earnings: EssEarningLine[] = p.earnings.map((e) => ({ code: e.code, amountMinor: assertInt(`earning "${e.code}"`, e.earnedMinor) }));
  const grossMinor = assertInt('grossMinor', p.grossMinor);
  const netPayMinor = assertInt('netPayMinor', p.netPayMinor);

  const deductions: EssMoneyLine[] = [];
  const pfEmployee = assertInt('PF employee', st.pfEmployeeMinor);
  const esiEmployee = assertInt('ESI employee', st.esiEmployeeMinor);
  const pt = assertInt('Professional Tax', st.professionalTaxMinor);
  const tds = assertInt('TDS', st.tdsMinor);
  if (pfEmployee > 0) deductions.push({ label: 'Provident Fund (your share)', amountMinor: pfEmployee });
  if (esiEmployee > 0) deductions.push({ label: 'ESI (your share)', amountMinor: esiEmployee });
  if (pt > 0) deductions.push({ label: 'Professional Tax', amountMinor: pt });
  if (tds > 0) deductions.push({ label: 'Income Tax (TDS)', amountMinor: tds });
  const totalDeductionsMinor = deductions.reduce((s, l) => s + l.amountMinor, 0);

  const employerLines: EssMoneyLine[] = [];
  const pfEmployer = assertInt('PF employer', st.pfEmployerMinor);
  const esiEmployer = assertInt('ESI employer', st.esiEmployerMinor);
  if (pfEmployer > 0) employerLines.push({ label: 'Provident Fund (employer)', amountMinor: pfEmployer });
  if (esiEmployer > 0) employerLines.push({ label: 'ESI (employer)', amountMinor: esiEmployer });

  const view: EmployeeSelfView = {
    employeeId: input.subjectEmployeeId,
    payPeriod: p.onDate,
    earnings,
    grossMinor,
    deductions,
    totalDeductionsMinor,
    netPayMinor,
    employerContributions: {
      note: 'Paid by your employer — this is a company cost, not deducted from you.',
      totalMinor: employerLines.reduce((s, l) => s + l.amountMinor, 0),
      lines: employerLines,
    },
    confirmWithCa: true,
    ...(input.settlement !== undefined ? { settlement: summariseSettlement(input.settlement) } : {}),
    ...(statutoryNotesOf(p) === undefined ? {} : { statutoryNotes: statutoryNotesOf(p)! }),
  };
  return view;
}

/** Reduce a full settlement to the employee's own summary — their earnings, recoveries and the net. */
function summariseSettlement(s: Settlement): EssSettlementSummary {
  if (s === null || typeof s !== 'object' || !Array.isArray(s.earnings) || !Array.isArray(s.recoveries)) {
    throw new InvalidEssInput('the settlement is missing its earnings or recoveries');
  }
  return {
    earnings: s.earnings.map((l) => ({ label: l.label, amountMinor: assertInt(`settlement earning "${l.label}"`, l.amountMinor) })),
    recoveries: s.recoveries.map((l) => ({ label: l.label, amountMinor: assertInt(`settlement recovery "${l.label}"`, l.amountMinor) })),
    netSettlementMinor: assertInt('netSettlementMinor', s.netSettlementMinor),
    payableToEmployee: s.payableToEmployee === true,
  };
}
