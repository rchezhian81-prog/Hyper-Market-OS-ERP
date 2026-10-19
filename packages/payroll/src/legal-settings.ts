// Payroll legal settings (R4 · C15 · C16 · C19 · OB-208). Every legal figure the R4 pay checks use is a SETTING the CA
// fills — the value, where it comes from (the Act, rule or notification) and who confirmed it with their reference —
// the same three-part pattern as the C18 working-time pack (`packages/workforce/src/working-time.ts`).
//
// **No legal figure is written in this file.** OB-208 (owner, 19 Oct 2026): the figures in the gap analysis (EPF 12% /
// ₹15,000 / 20 people, ESI 0.75% + 3.25% / ₹21,000 / 10 people) and the shipped CONFIRM-WITH-CA defaults in
// `statutory.ts` are NOT used as settled. A figure missing any of its three parts is NOT CONFIRMED: it is never guessed
// and never defaulted, and a check that needs it says "not checked" — it blocks nothing it cannot judge (P-08: an
// unchecked rule is said out loud, never silently passed).
//
// The one number here that is not a setting is the overtime floor of twice the ordinary rate: it is the owner's signed
// sentence itself (C16, OB-227: "paid at no less than twice the ordinary hourly rate; a lower rate is refused"), so a
// multiplier below it is refused even when somebody confirms it.
//
// Pure and deterministic: no clock, no I/O.

/** The figures the R4 checks read. Each is a whole number in its unit. */
export type PayrollFigureKey =
  | 'pfEmployeeRateBps' | 'pfEmployerRateBps' | 'pfWageCeilingMinor' | 'pfHeadcountThreshold'
  | 'esiEmployeeRateBps' | 'esiEmployerRateBps' | 'esiGrossCeilingMinor' | 'esiHeadcountThreshold'
  | 'normalDailyMinutes' | 'normalWeeklyMinutes' | 'overtimeMultiplierPercent';

export const PAYROLL_FIGURE_KEYS: readonly PayrollFigureKey[] = Object.freeze([
  'pfEmployeeRateBps', 'pfEmployerRateBps', 'pfWageCeilingMinor', 'pfHeadcountThreshold',
  'esiEmployeeRateBps', 'esiEmployerRateBps', 'esiGrossCeilingMinor', 'esiHeadcountThreshold',
  'normalDailyMinutes', 'normalWeeklyMinutes', 'overtimeMultiplierPercent',
]);

/** The overtime floor the owner signed (C16): never less than twice the ordinary rate — 200%. Not a setting. */
export const OVERTIME_FLOOR_PERCENT = 200;

export interface PayrollFigureMeta {
  readonly label: string;
  readonly unit: string;
  readonly min: number;
  readonly max: number;
  /** The R4 item the figure belongs to. */
  readonly item: 'C19' | 'C16';
}

export const PAYROLL_FIGURES: Readonly<Record<PayrollFigureKey, PayrollFigureMeta>> = Object.freeze({
  pfEmployeeRateBps: { label: 'EPF — employee\'s share of the PF wage', unit: 'basis points (1% = 100)', min: 0, max: 10_000, item: 'C19' },
  pfEmployerRateBps: { label: 'EPF — employer\'s share of the PF wage', unit: 'basis points (1% = 100)', min: 0, max: 10_000, item: 'C19' },
  pfWageCeilingMinor: { label: 'EPF — the monthly PF wage the contribution is worked on, at most', unit: 'paise', min: 1, max: 1_000_000_000, item: 'C19' },
  pfHeadcountThreshold: { label: 'EPF — the headcount at which the shop must pay PF', unit: 'people', min: 1, max: 100_000, item: 'C19' },
  esiEmployeeRateBps: { label: 'ESI — employee\'s share of gross wages', unit: 'basis points (1% = 100)', min: 0, max: 10_000, item: 'C19' },
  esiEmployerRateBps: { label: 'ESI — employer\'s share of gross wages', unit: 'basis points (1% = 100)', min: 0, max: 10_000, item: 'C19' },
  esiGrossCeilingMinor: { label: 'ESI — the monthly gross wage up to which an employee is covered', unit: 'paise', min: 1, max: 1_000_000_000, item: 'C19' },
  esiHeadcountThreshold: { label: 'ESI — the headcount at which the shop must pay ESI', unit: 'people', min: 1, max: 100_000, item: 'C19' },
  normalDailyMinutes: { label: 'Normal hours a day — work above this is overtime', unit: 'minutes', min: 1, max: 24 * 60, item: 'C16' },
  normalWeeklyMinutes: { label: 'Normal hours a week (Monday to Sunday) — work above this is overtime', unit: 'minutes', min: 1, max: 7 * 24 * 60, item: 'C16' },
  overtimeMultiplierPercent: { label: 'Overtime rate, as a share of the ordinary hourly rate (never below 200%)', unit: 'percent', min: 1, max: 1_000, item: 'C16' },
});

/** One legal figure as entered. All three parts must be present for it to be confirmed. */
export interface LegalFigure {
  /** A whole number in the figure's unit; null while nobody has filled it in. */
  readonly value: number | null;
  /** The Act, rule or notification the value comes from. */
  readonly source: string | null;
  /** Who confirmed it (the CA), with their reference. */
  readonly confirmation: string | null;
}

/**
 * A minimum-wage class (C16): the monthly minimum wage for the people whose staff-directory role is one of `roles`. The
 * class names and the figures are the CA's; the roles say which staff the class covers.
 */
export interface MinimumWageClass {
  readonly classId: string;
  readonly label: string;
  readonly roles: readonly string[];
  /** The full-month minimum wage, in paise; null while not filled. */
  readonly monthlyMinor: number | null;
  readonly source: string | null;
  readonly confirmation: string | null;
}

/**
 * The particulars a payslip can carry (C15). The CA's list chooses among these; a particular the CA needs that is not
 * here is a build change, never a guess. `derived` ones are read from the payslip itself; `supplied` ones are given when
 * the payslip is issued (the employee's name, the establishment's address…).
 */
export type PayslipParticularKey =
  | 'employerName' | 'establishmentAddress' | 'employeeName' | 'employeeId' | 'designation' | 'uan' | 'esiNumber'
  | 'payPeriod' | 'payDate' | 'daysPaid' | 'lossOfPayDays' | 'hoursWorked' | 'overtimeHours'
  | 'earnings' | 'grossWages' | 'deductions' | 'employerContributions' | 'netPay';

export const PAYSLIP_PARTICULARS: Readonly<Record<PayslipParticularKey, { readonly label: string; readonly from: 'derived' | 'supplied' }>> = Object.freeze({
  employerName: { label: 'Name of the employer', from: 'supplied' },
  establishmentAddress: { label: 'Address of the establishment', from: 'supplied' },
  employeeName: { label: 'Name of the employee', from: 'supplied' },
  employeeId: { label: 'Employee number', from: 'derived' },
  designation: { label: 'Designation', from: 'supplied' },
  uan: { label: 'EPF universal account number (UAN)', from: 'supplied' },
  esiNumber: { label: 'ESI insurance number', from: 'supplied' },
  payPeriod: { label: 'Wage period', from: 'derived' },
  payDate: { label: 'Date of payment', from: 'derived' },
  daysPaid: { label: 'Days paid', from: 'derived' },
  lossOfPayDays: { label: 'Loss-of-pay days', from: 'derived' },
  hoursWorked: { label: 'Hours actually worked', from: 'derived' },
  overtimeHours: { label: 'Overtime hours and overtime wages', from: 'derived' },
  earnings: { label: 'Each earning', from: 'derived' },
  grossWages: { label: 'Gross wages', from: 'derived' },
  deductions: { label: 'Each deduction', from: 'derived' },
  employerContributions: { label: 'Employer\'s contributions', from: 'derived' },
  netPay: { label: 'Net wages paid', from: 'derived' },
});

export const PAYSLIP_PARTICULAR_KEYS = Object.freeze(Object.keys(PAYSLIP_PARTICULARS) as PayslipParticularKey[]);

/** The CA's list of particulars every payslip must carry. Not confirmed while any part is missing. */
export interface ParticularsList {
  readonly particulars: readonly PayslipParticularKey[] | null;
  readonly source: string | null;
  readonly confirmation: string | null;
}

export interface PayrollLegalSettings {
  readonly figures: Readonly<Record<PayrollFigureKey, LegalFigure>>;
  readonly minimumWages: readonly MinimumWageClass[];
  readonly particulars: ParticularsList;
}

const EMPTY_FIGURE: LegalFigure = Object.freeze({ value: null, source: null, confirmation: null });

/** As shipped: every figure NOT CONFIRMED, no minimum-wage class, no particulars list (OB-208). */
export const UNSET_PAYROLL_LEGAL_SETTINGS: PayrollLegalSettings = Object.freeze({
  figures: Object.freeze(Object.fromEntries(PAYROLL_FIGURE_KEYS.map((k) => [k, EMPTY_FIGURE])) as Record<PayrollFigureKey, LegalFigure>),
  minimumWages: Object.freeze([]),
  particulars: Object.freeze({ particulars: null, source: null, confirmation: null }),
});

const filled = (s: string | null | undefined): boolean => typeof s === 'string' && s.trim() !== '';

/** A value the figure can hold: a whole number within its range. The overtime multiplier also has the 200% floor. */
export function figureValueIsValid(key: PayrollFigureKey, value: unknown): value is number {
  const m = PAYROLL_FIGURES[key];
  return Number.isInteger(value) && (value as number) >= m.min && (value as number) <= m.max;
}

export interface FigureStatus {
  readonly key: PayrollFigureKey;
  readonly label: string;
  readonly unit: string;
  readonly item: 'C19' | 'C16';
  readonly status: 'confirmed' | 'not_confirmed';
  readonly value: number | null;
  readonly source: string | null;
  readonly confirmation: string | null;
  /** What is missing, in words. Absent when confirmed. */
  readonly missing?: string;
}

/** Every figure and whether it is confirmed — an unconfirmed one says what is missing. */
export function figureStatuses(settings: PayrollLegalSettings): readonly FigureStatus[] {
  return PAYROLL_FIGURE_KEYS.map((key) => {
    const f = settings.figures[key] ?? EMPTY_FIGURE;
    const gaps: string[] = [];
    if (!figureValueIsValid(key, f.value)) gaps.push('the figure');
    if (!filled(f.source)) gaps.push('where it comes from');
    if (!filled(f.confirmation)) gaps.push('who confirmed it (the CA) and their reference');
    // A multiplier below the signed floor is never confirmed, whoever entered it.
    if (key === 'overtimeMultiplierPercent' && typeof f.value === 'number' && f.value < OVERTIME_FLOOR_PERCENT) gaps.push('a rate of at least 200% (overtime below 2×)');
    const { label, unit, item } = PAYROLL_FIGURES[key];
    const base = { key, label, unit, item, value: f.value, source: f.source, confirmation: f.confirmation };
    return gaps.length === 0
      ? { ...base, status: 'confirmed' as const }
      : { ...base, status: 'not_confirmed' as const, missing: `needs ${gaps.join(', ')}` };
  });
}

/** The value of a figure that is confirmed, or undefined while it is not. */
export function figureInForce(settings: PayrollLegalSettings, key: PayrollFigureKey): number | undefined {
  const st = figureStatuses(settings).find((s) => s.key === key)!;
  return st.status === 'confirmed' ? (st.value as number) : undefined;
}

/** Whether a minimum-wage class is confirmed (figure, source and confirmation all present). */
export function minimumWageClassConfirmed(c: MinimumWageClass): boolean {
  return Number.isInteger(c.monthlyMinor) && (c.monthlyMinor as number) > 0 && filled(c.source) && filled(c.confirmation);
}

/** Whether the CA's particulars list is confirmed. */
export function particularsListConfirmed(p: ParticularsList): boolean {
  return Array.isArray(p.particulars) && p.particulars.length > 0 && filled(p.source) && filled(p.confirmation);
}

/** One recorded change to the settings — append-only; the latest per target is in force. */
export type PayrollLegalSettingChange =
  | { readonly target: 'figure'; readonly key: PayrollFigureKey; readonly figure: LegalFigure; readonly by: string; readonly at: string }
  | { readonly target: 'minimumWage'; readonly setting: MinimumWageClass; readonly by: string; readonly at: string }
  | { readonly target: 'particulars'; readonly list: ParticularsList; readonly by: string; readonly at: string };

/** Fold the recorded changes over the unset settings. Pure. */
export function foldPayrollLegalSettings(changes: readonly PayrollLegalSettingChange[]): PayrollLegalSettings {
  const figures: Record<PayrollFigureKey, LegalFigure> = { ...UNSET_PAYROLL_LEGAL_SETTINGS.figures };
  const classes = new Map<string, MinimumWageClass>();
  let particulars: ParticularsList = UNSET_PAYROLL_LEGAL_SETTINGS.particulars;
  for (const c of changes) {
    if (c.target === 'figure') { if ((PAYROLL_FIGURE_KEYS as readonly string[]).includes(c.key)) figures[c.key] = c.figure; }
    else if (c.target === 'minimumWage') classes.set(c.setting.classId, c.setting);
    else if (c.target === 'particulars') particulars = c.list;
  }
  return { figures, minimumWages: [...classes.values()].sort((a, b) => a.classId.localeCompare(b.classId)), particulars };
}
