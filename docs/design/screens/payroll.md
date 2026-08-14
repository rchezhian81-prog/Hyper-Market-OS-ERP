# Payroll UI — screen specification & security boundary

**Status:** in build (item 3 continuation — payroll UI). Engine = `packages/payroll` (WP3, built + tested).
**Source of this spec:** owner directive, 14 August 2026 ("PAYROLL UI SECURITY BOUNDARY"). Recorded here
verbatim-in-substance as the acceptance criteria, so no requirement is silently dropped (CLAUDE.md).

**Live payroll activation remains BLOCKED** pending CA/HR/legal sign-off. UI development, simulator
(DEMO-data) testing and E2E verification continue. Statutory rates/ceilings/slabs are CONFIRM-WITH-CA.

> **Do NOT copy the GST reconciliation screen's unrestricted offline-caching model into payroll.**
> Payroll holds highly sensitive salary, bank, tax and personal data.

---

## 1. Access control

- **Roles that may see payroll at all:** payroll administrator, authorized HR, finance approver, owner.
- **Roles with NO payroll visibility:** cashier, warehouse, store-floor, ordinary manager.
- **Maker and checker must be separate people** (separation of duties) — the person who submits a run may
  never approve it.
- **Re-authentication / MFA** required for: approval, period lock, bank-file generation, payslip bulk
  download, and any sensitive export.
- **Mask by default:** bank account, PAN, UAN, Aadhaar and other sensitive identifiers.
- **Never expose full Aadhaar** unless a specifically lawful workflow requires it (and then only that field,
  under authorization + audit).

## 2. Offline policy (the boundary)

- The payroll **calculation engine** may remain locally operable where genuinely required.
- **Do NOT persist complete payroll or bank data unencrypted** in browser cache, service-worker cache,
  `localStorage`, `IndexedDB`, logs, or downloadable temporary files.
- **Prefer online-first** for sensitive administrative data.
- If offline payroll access is genuinely required: **encrypted, device-bound, tenant-bound** storage with
  **short expiry, explicit authorization, remote revocation and automatic purge** (a later, opt-in capability
  — not the default).
- **Shared POS / store-floor devices must never retain payroll information.** (⇒ payroll is NOT an edge-box
  store-floor screen; it is served online-first to authorized back-office users.)
- **Clearly display stale/offline status**, and **prevent final approval, bank-file release or live posting**
  when required validations cannot be completed.

## 3. Workflow (the complete flow)

`period selection → input validation → payroll preview → exception resolution → maker submission →
independent checker approval → lock → payslips → bank file → accounting journal → statutory reports →
final-and-full settlement → audit/reconciliation`

Includes: draft/version comparison; employee-wise and department-wise summaries; earnings/deductions
breakdown; statutory calculation explanation; arrears & retrospective corrections; leave/attendance/overtime
exceptions; loan/advance recovery; **negative-net-pay refusal**; maker-checker approval; locked-period
controls; **reversal/adjustment instead of silent editing**; bank-file totals & journal reconciliation;
employee self-service payslip with **strict own-record access**; English/Tamil; responsive & accessible;
printable/exportable outputs with authorization & audit.

## 4. Sample / demo data

Sample data must be visibly marked **"DEMO DATA — NOT REAL PAYROLL"** at all times, and must never be mixed
with tenant production records, exports, bank files or statutory reports.

## 5. Required test evidence

Unauthorized-role denial · cross-tenant denial · employee own-payslip isolation · maker-cannot-self-approve ·
locked payroll cannot be silently changed · sensitive values masked · no sensitive payload in logs or unsafe
browser storage · session expiry & re-authentication · offline/stale behaviour · keyboard/screen-reader/
responsive accessibility · complete browser E2E payroll workflow.

---

## Increment plan (each: DoD, tested, PR, merge on green)

The whole flow is large; it is built in security-first increments on the proven session-model + shell +
`packages/ui` pattern, but with payroll's own online-first / no-sensitive-cache shell.

- **inc1 — security foundation + preview + maker→checker core.** Tested DOM-free `payroll-session.ts` on
  `packages/payroll`: role-gated view (payroll roles only; default-deny), **masking** of bank/PAN/UAN/Aadhaar,
  employee-wise + department-wise + earnings/deductions + statutory-explanation preview, **negative-net-pay as
  a blocking exception**, maker `submit()` / checker `approve()` with **separation of duties** enforced, all
  actions **blocked offline**. Online-first shell (`payroll-sw.js` caches static shell only, strips the
  payload, never persists sensitive data) with the **DEMO-DATA** banner, offline/stale banner that blocks
  finalization, English/Tamil, a11y. Nav item gated on the payroll permission. Dedicated **security guardrail**
  (no payload in the SW cache; masking; offline blocks finalization; restricted nav; maker≠checker).
- **inc2 — DONE (14 Aug).** Locked-run surface: **bank-file summary** (record count + total net, reconciled
  against the run net — no account numbers in the browser; the file itself is generated server-side) and the
  **balanced accounting journal** (`buildPayrollJournal`, debits === credits — an unbalanced total set is
  surfaced as a reconciliation FAILURE, never a silent pass). **Re-auth/MFA gate**: approve, lock, reverse,
  bank-file generation, bulk payslip download and export all require a FRESH re-auth (`reauthAgeSeconds` port
  + `reauthFreshWithinSeconds` window); the MFA step is a step (`window.payrollReauth`), never a browser
  dialog; offline still beats a fresh re-auth. All inc1 controls kept.
- **inc3 — DONE (14 Aug).** Statutory-deduction report (PF/ESI/PT/TDS, employee + employer shares, from the
  run totals, marked CONFIRM-WITH-CA). Full-and-final **settlement** for a leaver on the tested
  `computeSettlement` — signed net where a **negative net is EXPECTED** (recoverable from the employee) and is
  NOT a pay-run blocking exception; release gated by re-auth. **Arrears / loan / advance** shown as visible
  flag badges on the line (never folded silently into base pay). **Reversal** names its reason on-screen; a
  draft/version **delta** vs the previous version. `releaseSettlement` joined the re-auth-gated set.
- **inc4 —** employee self-service payslip (strict own-record isolation) + printable/exportable-with-audit.
- **inc5 (opt-in) —** encrypted device-bound tenant-bound offline vault, only if genuinely required.

After payroll: category-policy UI, then e-invoice/e-way-bill (action-wiring) UI, then the next
dependency-priority incomplete roadmap module.
