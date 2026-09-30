# Audit observation tests — defect reproductions, not acceptance tests

These four files are the EXACT observation tests from the independent store-workflow audit of 30 September 2026
(handover package pinned to commit `8f4f6c5`). **They deliberately assert the DEFECTIVE behaviour: a pass confirms the
defect is still present.** They are kept here, running in the ordinary suite, for one reason — each repair slice must
turn its observation into the intended-behaviour regression in the same PR, so a green run can never quietly mean
"the bug is still there" once the fix lands.

Rules (from the handover and `docs/traceability.md` § "Store audit findings F01–F12"):

- When a finding is fixed, change the assertion to the required behaviour and keep the test as the regression; never
  preserve the bug to keep an observation green.
- If a test starts failing because other work already fixed the behaviour, verify that fix and invert the assertion;
  do not restore the old behaviour.
- These exercise real domain / session / transport / API composition over synthetic in-memory ports. They are not
  browser, physical-device or real-PostgreSQL end-to-end proof, and they are never cited as completion evidence.

| File | Findings | Fix slice |
|---|---|---|
| `procurement.test.ts` | F01 PO remainder · F02 invoice saved banner · F03 excess sellable — **F03 FIXED (SP-4 (ii)): case 2 is the regression (a body naming rules or policy is refused by name; the tenant's tolerance applies; 110 against 100 → 100 sellable and 10 HELD off the on-hand figure; the receiver cannot decide it; a second person's approval releases the 10 once)**; F01 (case 1) and F02 (case 3) still OBSERVED | SP-6 · SP-7 · SP-4 ✔ |
| `warehouse.test.ts` | F05 transfer not in inventory · F06 count view only · F07 caller-supplied approver/stock/value — **F07 FIXED (SP-4): cases 1, 2 and 4 are regressions (a body naming an approver or stock / a value, threshold or approver is refused by name; the authenticated dispatcher is the approver and cannot be the proposer; the stock checked is head office's; a material count is HELD and decided by a second person)** · **F05 FIXED (SP-5): case 1 is the regression (dispatch takes 10 off WH and shows 10 in transit at FLOOR with no FLOOR on-hand; the receipt posts FLOOR 10 at the cost that left WH; ₹20.00 of stock in all, none of it COGS)** · **F06 FIXED (SP-5b): case 3 is the regression (the approved correction is the `count:C1` movement on the ledger — availability 15, valuation ₹15.00, the count view layers nothing twice)** — all four cases are now regressions | SP-4 ✔ · SP-5 ✔ · SP-5b ✔ |
| `pos.test.ts` | F09 placeholder cashier/lane/day — **F09 FIXED (SP-4b): case 1 is the regression (the served boot passes the box's lane and cut-off and never a cashier; the till refuses payment until somebody signs in; the sale names the real cashier, lane and day)** · **F10 FIXED (SP-4c): case 2 is the regression (the Close button sends shift, moment, count and a reason once asked — the whole input; the store box works out every other figure, decides and records the close; the till keeps no cash of its own)** | SP-4b ✔ · SP-4c ✔ |
| `sync.test.ts` | F12 409 conflict acknowledged — **FIXED, case 1 is now the regression** · F11 manager decision/receipt/count not durable — **FIXED for the manager screen (SP-2a + SP-2b): cases 2 and 3 are regressions (decision, receipt and blind count durable and queued; the count captured blind, no expected figure on the screen)**; **the WAREHOUSE handheld half FIXED in SP-3a** (the authenticated device socket, ADR-0019 — regressions live in `tests/integration/warehouse-handheld-reaches-the-cloud-through-the-edge.test.ts` and `tests/e2e/warehouse-handheld-syncs-through-the-box.e2e.ts`); picker and driver → SP-3c | SP-1 ✔ · SP-2a ✔ · SP-2b ✔ · SP-3a ✔ · SP-3c |
