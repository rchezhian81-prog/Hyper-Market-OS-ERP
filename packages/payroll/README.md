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

## TDS — income tax deducted at source (`src/tds.ts`, WP3 inc3)

From an employee's **projected annual income** the year's income tax is computed under the chosen
regime — slabs, standard deduction, the section-87A rebate and the 4% health-&-education cess — and the
remaining tax is spread across the months left, giving this month's TDS. Income-tax figures change with
every Finance Act, so the regime parameters are an **effective-dated, configurable** schedule
(`resolveTdsParams`, resolve-on-date, refuses a gap) and `DEFAULT_TDS_SCHEDULE` ships the FY 2025-26
figures — every number a **`CONFIRM-WITH-CA`** constant (the exact slabs, the 288B ₹10 rounding, and an
employee's declared deductions are precisely what a CA confirms).

- `computeTds` — taxable income = annual gross − standard deduction − (old regime: declared deductions);
  the regime slabs give the gross tax; **section 87A** rebates it to nil where income is within the
  ceiling; **4% cess**; the balance after tax-already-deducted is spread over the remaining months.
  Never negative. Exact integer paise (BigInt slab accumulation).
- **New regime is the default**; the **old regime** honours declared deductions (80C, etc.).
- Folded into the payslip: `computeStatutoryDeductions`/`buildPayslip` now accept `tdsMonthlyMinor`
  (default 0, backward compatible) and add it to the total employee deduction and net.

Wired for **review** at `POST /v1/hr/payroll/tds`, gated `payroll.statutory.read`, `confirmWithCa: true`.
Tested in `tests/unit/payroll-tds.test.ts` (7) and `tests/integration/payroll-tds.test.ts` (3).

## The pay-run lifecycle (`src/pay-run.ts`, WP3 inc4)

A pay run moves money to real people, so it carries the spine of payroll controls as a small
event-sourced state machine: **draft → submitted → approved → locked**, plus **reversed**. The control
that matters most — **the approver may not be the submitter** (maker ≠ checker, §28) — is enforced in
BOTH `evaluatePayRunTransition` (before an action) and `foldPayRun` (so a hand-crafted event stream
cannot self-approve). A **locked run is final**; a mistake found afterwards is fixed by a **visible
reversal and a fresh run**, never a silent rewrite ("correction by reversal, never rewriting"). A
checker may `reject` a submitted run back to draft; a `reverse` needs a reason.

`foldPayRun(payRunId, events)` folds the append-only history to the current aggregate (ignoring
out-of-order or self-approval events); `evaluatePayRunTransition({ current, action, actor, reason? })`
says whether a proposed transition is allowed and why. Wired for **review** at
`POST /v1/hr/payroll/pay-run/evaluate` (fold supplied events + a proposed action → allow/deny), gated
`payroll.statutory.read`. Tested in `tests/unit/payroll-pay-run.test.ts` (8) and
`tests/integration/payroll-pay-run.test.ts` (3). The durable event store, the bank-transfer file, the
accounting journal + cost-centre posting, and full-and-final settlement are the remaining increments.

## The salary bank-transfer file (`src/bank-file.ts`, WP3 inc5)

The output that actually moves money: a **locked** pay run's per-employee net pay becomes the
bulk-salary upload a bank ingests (NEFT/IMPS/RTGS). Two hard constraints, because this file is a
payment instruction:

- **Only from a locked run** — `buildBankFile` refuses a draft, submitted or even approved run; it must
  be locked (approved and final), tying the payment to the maker-checker lifecycle.
- **Every line must be payable** — a blank name, a malformed account number (`\d{9,18}`) or IFSC
  (`[A-Z]{4}0[A-Z0-9]{6}`), a non-positive amount, or the **same account twice** is refused with the
  reason (a bad line in a bulk file is a payment that bounces or pays the wrong person).

A **control total** (record count + sum of net) travels with the file so the bank upload and the
payroll agree before release. Exact integer paise; the file renders rupees to two decimals; the
beneficiary name is CSV-escaped. The exact column layout differs by bank, so this produces a
widely-supported generic layout and marks it `confirmWithBank`. Wired at `POST /v1/hr/payroll/bank-file`
(folds the run's events to confirm it is locked, then builds), gated `payroll.statutory.read`. Tested in
`tests/unit/payroll-bank-file.test.ts` (4) and `tests/integration/payroll-bank-file.test.ts` (3). The
accounting journal + cost-centre posting and F&F settlement are the remaining increments.

## The accounting journal + cost-centre posting (`src/journal.ts`, WP3 inc6)

A locked pay run is not finished when the bank file is made — the books must record it.
`buildPayrollJournal` turns a run's totals into a **balanced double-entry journal**: the salary expense
(optionally split across cost-centres that must sum to gross) and the employer's own PF/ESI cost on the
**debit** side; the net pay owed and each statutory payable (PF, ESI, PT, TDS) on the **credit** side.

One invariant governs everything: **total debits === total credits**. It is asserted, and a run whose
net does not equal `gross − (employee PF + ESI + PT + TDS)` makes the journal fail to balance and is
**refused** — a payroll that posts an unbalanced journal has silently corrupted the books. PF/ESI
payables carry both the employee and employer shares; zero lines are omitted. Produced only from a
**locked** run; exact integer paise. Wired at `POST /v1/hr/payroll/journal` (folds the run's events to
confirm locked, then builds), gated `payroll.statutory.read`, `confirmWithCa`. Tested in
`tests/unit/payroll-journal.test.ts` (5) and `tests/integration/payroll-journal.test.ts` (3).

## Full-and-final settlement (`src/settlement.ts`, WP3 inc7)

When an employee leaves, one statement squares everything up. `computeSettlement` itemises the
**earnings** — pending salary for the final part-month, unused **leave encashment** (days × per-day
basic, optionally capped), **gratuity** where eligible, and any other earning — minus the
**recoveries** — a notice-period shortfall, an outstanding advance/loan, other deductions, and the tax
on it — netting to a **signed** result: **positive is payable to the employee, negative is recoverable
from them** when the recoveries exceed the dues. Getting this wrong underpays someone on their way out
or writes off money owed, so every line is itemised (zero lines omitted) and exact.

**Gratuity** is the piece with a formula and a statutory ceiling: `computeGratuity` pays
`15/26 × last-drawn basic+DA × completed years` for **five or more** completed years, **capped at
₹20,00,000**. Those numbers change by notification, so they are an **effective-dated, configurable**
schedule (`resolveSettlementParams`, resolve-on-the-exit-date, refuses a gap) and every value in
`DEFAULT_SETTLEMENT_SCHEDULE` is a **`CONFIRM-WITH-CA`** constant. Exact integer paise (BigInt for the
15/26 multiply, rounded to the nearest rupee); pure and deterministic. Wired for **review** at
`POST /v1/hr/payroll/settlement`, gated `payroll.statutory.read`, `confirmWithCa: true`. Tested in
`tests/unit/payroll-settlement.test.ts` (6) and `tests/integration/payroll-settlement.test.ts` (3).

## Employee self-service (`src/ess.ts`, WP3 inc8)

Every earlier increment served HR/finance behind the confidential `payroll.statutory.read`. This is the
**other side** of payroll: letting an employee see **their own** payslip (and, if they are leaving,
their own final settlement) — and **nothing about anyone else**. Two controls make that safe, and they
are deliberately separate:

- **Self-scope** — `assertSelfScope({ requesterEmployeeId, subjectEmployeeId })` refuses (throws
  `EssAccessDenied`) unless the subject is the caller's own identity. The route feeds the **authenticated
  principal** (`ctx.userId`) as the requester, so this is **forge-proof**: holding the self-service
  permission still does not let you name a colleague. `employeeSelfView` calls the guard internally too,
  so the engine cannot produce a cross-employee view even if a caller forgets the route check.
- **Redaction** — `employeeSelfView` builds a purpose-shaped, employee-facing view: the employee's own
  earnings, the deductions taken **from them** (PF/ESI employee share, PT, TDS — zero lines omitted),
  their net, and the **employer's contributions shown separately** and labelled a company cost, never a
  deduction. It carries no approver identity, no cost-centre, no bank detail, no other employee — those
  are simply not in the shape it produces. A leaver's `settlement` summary (own earnings, recoveries, net)
  is included only when supplied.

Gated on a **new, narrow, widely-held** permission — **`payroll.ess.self`** (granted to every employee
role: owner, store manager, cashier, accountant), **not** the confidential `payroll.statutory.read`.
Wired at `POST /v1/hr/payroll/ess/self` (`{ employeeId, payslip, settlement? }`; the subject `employeeId`
must equal the caller — else 403). Pure, reads only. Tested in `tests/unit/payroll-ess.test.ts` (7) and
`tests/integration/payroll-ess.test.ts` (4). The durable pay-run SQL event store — which will let ESS
look a payslip up rather than be handed one — is the remaining increment.
