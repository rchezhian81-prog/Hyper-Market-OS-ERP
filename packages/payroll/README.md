# `packages/payroll/`

India **payroll** engine (roadmap priority 16, owner directive §6). This is **increment 1**: the
**effective-dated statutory-deduction engine** — from an employee's monthly earnings it computes the
statutory deductions and net pay, with every rate, ceiling and slab as **dated, configurable
configuration**, never hard-coded law.

## Effective-dated, resolve-on-date

Statutory rates change by notification, and a payslip computed last year must still be explainable. So
the parameters are a **dated schedule** resolved on the pay date the same way GST rates are
(`resolveGstRate`): `resolveStatutoryParams(schedule, onDate)` filters to what was in force, takes the
latest, and **refuses rather than guesses** on a gap. The shipped `DEFAULT_STATUTORY_SCHEDULE` carries
the current widely-published figures — but **every value is a named constant with a `CONFIRM-WITH-CA`
marker**, because a wrong PF ceiling or PT slab is somebody's pay and the employer's compliance.

## What it computes

- **PF** — `computeStatutoryDeductions` takes the PF wage (basic + DA) capped at the ceiling (₹15,000)
  and applies the employee/employer rate (12%/12%), rounded to the nearest rupee (EPF convention).
- **ESI** — on gross, applicable only at or below the gross ceiling (₹21,000) **unless covered for the
  period** (the wage-period continuation rule), employee/employer 0.75%/3.25%, rounded **up** to the
  next rupee (ESIC rule).
- **Professional Tax (Tamil Nadu)** — `professionalTaxTamilNadu(halfYearlyIncome, slabs)` reads the
  half-yearly slab; the monthly engine subtracts the caller's apportioned monthly amount.
- **Net** = gross − (PF employee + ESI employee + PT). Employer contributions are reported separately as
  a cost, never a deduction.

Money is integer paise with exact arithmetic (BigInt for the rate multiply). Pure and deterministic —
no clock, no I/O.

Wired for **review** at `POST /v1/hr/payroll/{statutory-deductions,professional-tax-tn}`
(`services/finance/src/payroll.ts`), gated on the confidential owner-held `payroll.statutory.read`
permission; every response carries `confirmWithCa: true`. Tested in
`tests/unit/payroll-statutory.test.ts` (11) and `tests/integration/payroll-statutory.test.ts` (4).

**This is not a live pay run.** It computes deductions for review; a real payroll needs CA/HR/legal
sign-off (an externally-blocked GO). Increments to follow: attendance / loss-of-pay, earnings &
allowance structures, TDS, maker-checker approval + lock, payslips, the bank-transfer file, the
accounting journal & cost-centre posting, and full-and-final settlement — each a tested increment.
