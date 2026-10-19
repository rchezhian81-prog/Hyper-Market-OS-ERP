// Public surface of @sre/payroll — the India payroll engine (roadmap priority 16). Increment 1: the
// effective-dated statutory-deduction engine — PF, ESI and Tamil Nadu Professional Tax as configurable,
// dated rate tables resolved on the pay date, computing a month's deductions and net pay from earnings.
// Rates/ceilings/slabs are CONFIRM-WITH-CA constants; a live pay run needs CA/HR/legal sign-off.

export * from './statutory';
export * from './payslip';
export * from './tds';
export * from './pay-run';
export * from './bank-file';
export * from './journal';
export * from './settlement';
export * from './ess';
export * from './mask';
// R4 Lane 1 (C15 · C16 · C19): the CA's legal settings (every figure "not confirmed" until filled, OB-208), EPF/ESI on
// headcount thresholds with the month's reconciliation, hours worked and overtime, the minimum wage, the payslip
// particulars and the pay-date clock, and the statutory payslip that carries all of them. Review only (OB-209).
export * from './legal-settings';
export * from './contribution-summary';
export * from './overtime';
export * from './minimum-wage';
export * from './payslip-particulars';
export * from './statutory-payslip';
