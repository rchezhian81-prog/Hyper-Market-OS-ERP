# `packages/input-tax/`

Input tax credit (ITC) through **GSTR-2B** and the **Invoice Management System** — roadmap gap **A17** (R3), CGST Act
s.16(2)(aa) and Rule 36(4). Pure and deterministic: no clock, no I/O.

## What it does

- `readGstr2b(json)` reads the GSTR-2B JSON the accountant downloads from the GST portal (OB-145 "A": the accountant
  uploads it; no GST service provider). The portal's own field names are read (`rtnprd`, `gstin`, `docdata.b2b[].ctin`,
  `inv[].inum/dt/val/txval/igst/cgst/sgst/cess/itcavl/rev`, per-item amounts added when the invoice carries none). Every
  unreadable part is named; nothing is half-read.
- `reviewItc(...)` matches every line with the shop's own supplier invoices that passed the **three-way match**, on
  supplier GSTIN + invoice number + date + tax. A 2B line with no booked invoice and a booked invoice in no 2B are both
  named exceptions. Each line carries the **named person's** latest action (accept / reject / pending); a line nobody has
  acted on is *awaiting a person*. Only a matched line may be accepted (`mayAccept`).
- The month's **claim** (GSTR-3B Table 4) is the accepted lines only. With no 2B uploaded, or any line awaiting a
  person, it is `not_reconciled` with the reason — never a zero (P-08).
- A **reversal** (Rule 37 / 42 / 43, free samples under A12) is its own record for the month (hard rule #2).
- `makeItcForPeriod(load)` builds the port `itcForPeriod(tenantId, period)` that the GSTR-3B builder reads.

The durable register and the routes are `services/finance/src/itc-store.ts`; the head-office wiring is
`services/api/src/r3-tax-pay-adapters.ts`; the review page is `apps/web-erp/web/itc-review.html`.
