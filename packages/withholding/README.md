# `packages/withholding/`

Income-tax **TDS on supplier payments** — rent (s.194-I), contractors (s.194-C), professionals (s.194-J) — roadmap gap
**A24** (R3). Deliberately separate from `packages/payroll` (salary TDS under s.192). Pure and deterministic.

**Built switched off (OB-143 "A").** The engine knows no rate and no threshold: the chartered accountant fills the list of
payees, sections, rates and thresholds (`TdsConfig`, empty to start), and the owner switches it on (`TdsSwitch`).

- `validateTdsConfig` names every problem with the CA's list.
- `assessTds` decides one payment: switched off → nothing; payee not on the list → nothing; flagged "TDS applicable"
  with no section → **refused**; below the CA's single / financial-year thresholds → nothing yet; otherwise the CA's rate
  on this payment (or, where the CA chose `whole_aggregate`, on the year's aggregate not yet deducted on). The payee is
  paid **net**; the payment still settles the gross.
- `tdsLiabilities` / `checkChallan`: each deduction is a **liability** until a challan reference covers it.
- `form26qSummary`: the quarter's deductions by section, with their challans, the ones not yet deposited, and the payees
  with no PAN on the list.

The register and routes are `services/finance/src/tds-store.ts`; the hook in the supplier payment route is
`services/purchase/src/supplier-master.ts`; the wiring is `services/api/src/r3-tax-pay-adapters.ts`.
