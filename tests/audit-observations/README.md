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
| `procurement.test.ts` | F01 PO remainder · F02 invoice saved banner · F03 excess sellable | SP-6 · SP-7 · SP-4 |
| `warehouse.test.ts` | F05 transfer not in inventory · F06 count view only · F07 caller-supplied approver/stock/value | SP-5 · SP-5b · SP-4 |
| `pos.test.ts` | F09 placeholder cashier/lane/day · F10 till close throws | SP-4b · SP-4c |
| `sync.test.ts` | F12 409 conflict acknowledged — **FIXED, case 1 is now the regression** · F11 manager decision/receipt not durable | SP-1 ✔ · SP-2 |
