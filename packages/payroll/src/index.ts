// Public surface of @sre/payroll — the India payroll engine (roadmap priority 16). Increment 1: the
// effective-dated statutory-deduction engine — PF, ESI and Tamil Nadu Professional Tax as configurable,
// dated rate tables resolved on the pay date, computing a month's deductions and net pay from earnings.
// Rates/ceilings/slabs are CONFIRM-WITH-CA constants; a live pay run needs CA/HR/legal sign-off.

export * from './statutory';
export * from './payslip';
export * from './tds';
export * from './pay-run';
export * from './bank-file';
