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

## The payslip builder (`src/payslip.ts`, WP3 inc2)

Increment 1 computed deductions from a gross and a PF wage; this builds those two figures from the
employee's **compensation structure** and the month's **attendance**, then assembles the full payslip
(earnings − statutory deductions = net). Two things it gets right:

- **The compensation structure is effective-dated** — `resolveCompensation(history, onDate)` uses the
  structure in force on the pay date (a July raise never rewrites June), refusing a date before the
  earliest entry rather than guessing.
- **Loss of pay prorates earnings, not just the total** — `buildPayslip` prorates every earning *and*
  the PF wage by paid days, so a month with LOP feeds a smaller gross **and** a smaller PF wage into the
  tested deduction engine. Each earning is prorated and rounded independently; a full month is exact.

`CompensationComponent` carries `partOfPfWage` (basic + DA) and `partOfGross` (default true, so a
reimbursement can be listed without inflating gross). Wired for **review** at
`POST /v1/hr/payroll/payslip` (accepts `components` in force or a `compensationHistory` to resolve),
gated `payroll.statutory.read`, `confirmWithCa: true`. Tested in `tests/unit/payroll-payslip.test.ts`
(6) and `tests/integration/payroll-payslip.test.ts` (4). Still not a live pay run — the append-only
run, maker-checker + lock, and correction-by-reversal lifecycle are later increments.
