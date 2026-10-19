// Minimum wage (R4 · C16 · OB-208 · OB-227). The signed sentence:
//   "Once the CA fills the minimum wage for an employee's class, a month's pay below it is refused ('below minimum
//    wage'). Until the CA fills them, the minimum wage … show[s] 'not confirmed', and the pay run says 'minimum wage
//    not checked' … it never assumes a figure."
//
// The employee's class is the CA's minimum-wage class whose roles include one of the employee's staff-directory roles
// (so the class cannot be dodged by leaving it off a request). Where two classes cover a person, the higher minimum
// applies. What is compared is the month's pay as agreed — the full-month gross of the compensation structure in force,
// before loss of pay and without overtime (which earnings count toward the minimum wage is the CA's question; the build
// compares the agreed monthly gross and says so).
//
// Pure and deterministic: no clock, no I/O.

import { minimumWageClassConfirmed, type MinimumWageClass, type PayrollLegalSettings } from './legal-settings';

/** Refused: a month's pay below the confirmed minimum wage for the employee's class ("below minimum wage"). */
export class BelowMinimumWage extends Error {
  readonly code = 'below_minimum_wage';
  constructor(message: string) { super(message); this.name = 'BelowMinimumWage'; }
}

export interface MinimumWageCheck {
  readonly status: 'met' | 'not_checked';
  readonly classId: string | null;
  readonly minimumMinor: number | null;
  readonly monthlyPayMinor: number;
  /** In words — "minimum wage not checked: …" while not checked. */
  readonly detail: string;
}

const rupees = (minor: number): string => `₹${(minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Check a month's agreed pay against the minimum wage for the employee's class. Throws BelowMinimumWage when a confirmed
 * minimum is not met; answers 'not_checked' (with why) when no confirmed class covers the person. Pure.
 */
export function checkMinimumWage(input: {
  readonly settings: PayrollLegalSettings;
  readonly roles: readonly string[];
  /** The full-month gross of the compensation in force, in paise. */
  readonly monthlyPayMinor: number;
}): MinimumWageCheck {
  const covering = input.settings.minimumWages.filter((c) => c.roles.some((r) => input.roles.includes(r)));
  const base = { monthlyPayMinor: input.monthlyPayMinor };
  if (covering.length === 0) {
    return { ...base, status: 'not_checked', classId: null, minimumMinor: null, detail: `minimum wage not checked: no minimum-wage class is set for ${input.roles.length === 0 ? 'a person with no role' : `the role${input.roles.length > 1 ? 's' : ''} ${input.roles.join(', ')}`}` };
  }
  const confirmed = covering.filter(minimumWageClassConfirmed);
  if (confirmed.length === 0) {
    return { ...base, status: 'not_checked', classId: covering[0]!.classId, minimumMinor: null, detail: `minimum wage not checked: ${covering.map((c: MinimumWageClass) => c.label).join(', ')} — not confirmed by the CA` };
  }
  const strictest = [...confirmed].sort((a, b) => (b.monthlyMinor as number) - (a.monthlyMinor as number))[0]!;
  const minimum = strictest.monthlyMinor as number;
  if (input.monthlyPayMinor < minimum) {
    throw new BelowMinimumWage(`below minimum wage: the month's pay of ${rupees(input.monthlyPayMinor)} is less than the minimum wage of ${rupees(minimum)} for ${strictest.label}`);
  }
  return { ...base, status: 'met', classId: strictest.classId, minimumMinor: minimum, detail: `at or above the minimum wage of ${rupees(minimum)} for ${strictest.label}` };
}
