# Second-person sites register — where head office took a typed name as a second person's act (7 Oct 2026)

**Why this exists.** Audit finding PA-03 (and PF-02 at the till) says a second person's approval must be *that person's
own act*: "role lookup proves that name has authority, not that the person approved this action." Waves 2b-iii and
2b-v fixed the sites the audit named. The 2b-vi triage then read **every** head-office route that takes a second
person from a request body. It found **26** that still accept a typed name as the act. This register lists all 26, so
none is lost. Each row names the slice that moves it onto head office's maker-checker engine (ADR-0024). A row closes
only when its slice merges with a test that proves it.

**How to read the class column.**

- **A** — a typed second person is accepted as that person's act, and it gates money, price, stock or access.
- **A-low** — a typed verifier or signer gates something minor.
- **A-rec** — a typed approver is only stored, or only clears a report finding.
- **Severe** — the maker could also be typed, or the approver's authority was never checked.

**Slices.**

- **a** — 2b-vi-a, *this slice, done*.
- **b** — 2b-vi-b, money and price approvals, each with its screen, in three parts:
  - **b-1** pricing — done;
  - **b-2** finance;
  - **b-3** stock, orders and purchasing.
- **c** — 2b-vi-c, low-severity and record-only names, plus seals on the box-relayed decisions.

## The 26 sites

| # | Route | Typed field | Class | What the typed name did | Requirement | Slice | State |
|---|---|---|---|---|---|---|---|
| 1 | `POST /v1/purchase/suppliers/:id/bank-details` | `approvedBy` and `requestedBy` | A, severe | Both people were body strings; the approver's authority was never checked; the account changed | M06-FR-01, SP-7c, §28 | a | **Fixed**: kind `supplier_bank_change`; the maker is the caller |
| 2 | `POST /v1/import/commit` | `approval.decidedBy` and `uploadedBy` | A, severe | The checker and the uploader both came from the body; no permission check | M30-FR-01/03, §28 | a | **Fixed**: kind `data_import_commit`, bound to the file's content fingerprint; the maker is the caller |
| 3 | `POST /v1/hr/payroll/pay-run/:id/append` | `actor` | A, severe | The maker and the checker were both body `actor`s; maker ≠ checker compared two strings | §28, SEC-03 | a | **Fixed**: every step's actor is the caller (approve/lock/bank-file release stay on pilot hold) |
| 4 | `POST /v1/prices/changes` | `approval.decidedBy` | A | Unlocked a below-cost or below-floor price | M05-FR-02, M34-FR-01, §28 | b-1 | **Fixed** (b-1): kind `price_change`; the screen asks and saves with the approval |
| 5 | `POST /v1/prices/list/:productId/entries/:entryId` | `approval.decidedBy` | A | Unlocked a below-cost list entry | M05-FR-01/02, §28 | b-1 | **Fixed** (b-1): kind `price_list_entry` (API-only; no screen) |
| 6 | `POST /v1/promotions/:id/launch` | `approvedBy` | A | Launched a promotion that needed approval | M20, M05-FR-04, §28 | b-1 | **Fixed** (b-1): kind `promotion_launch`; the screen asks and launches with the approval |
| 7 | `POST /v1/pos/quotations/:id` | `approval.decidedBy` | A (no authority check at all) | Allowed a quote below the margin floor; the floor itself came from the body | M12-FR-02, M05-FR-02, §28 | b-1 | **Fixed** (b-1): kind `quotation_below_floor`, approver must hold `price.change.approve` (API-only; no screen) |
| 8 | `POST /v1/finance/periods/:period/reopen` | `approvedBy` | A | Reopened a closed accounting period | M23-FR-04, §28 | b | Open |
| 9 | `POST /v1/finance/periods/:period/close` | `signedBy` | A | Certified a period close | §28 (M23) | b | Open |
| 10 | `POST /v1/concession/contracts/:id` | `approvedBy` | A (no check) | Cleared the contract's `not_approved` trading blocker | M27, §28 | b | Open |
| 11 | `POST /v1/concession/concessionaires/:id/deposit-movements/:movementId` | `approvedBy` | A (no check) | A forfeit took a deposit off the liability | M27, §28 | b | Open |
| 12 | `POST /v1/hr/payroll/bank-file` (+ `/journal`) | `events[].approved.by` | A | Built the salary bank file from caller-supplied events | §28, SEC-03 | b (pilot hold) | Open; must read the durable pay run |
| 13 | `POST /v1/inventory/write-off/:id` | `approvedBy` | A | Approved a material stock loss | M28-FR-01, M27-FR-02, §28 | b | Open |
| 14 | `POST /v1/inventory/movements` (`adjusted`) | `approvedBy` and `enteredBy` | A | An upward adjustment approved by one body string against another | M08, §28, hard rule #2 | b | Open |
| 15 | `POST /v1/orders/:id/refunds` | `approvedBy` | A | Moved money back to a customer | M18-FR-04, M20-FR-03, §28 | b | Open |
| 16 | `POST /v1/service/cases/:id/compensation` | `approval.decidedBy` | A | Granted service compensation | M21-FR-04, §28 | b | Open |
| 17 | `POST /v1/purchase/invoices/:id/capture` | `approvedBy` | A (flag only) | The invoice was recorded with an unverified approver | SP-7a, M07-FR-04, §28 | b | Open |
| 18 | `POST /v1/purchase/suppliers/:id/payments/:paymentId` | `approvedBy` | A | Recorded a supplier payment | M23-FR-01, M06-FR-01, M15-FR-03, §28 | b | Open |
| 19 | `POST /v1/hr/workforce/certifications/:id` | `verifiedBy` | A-low | Made a certificate count as cover for the task gate | M25-FR-03 | c | Open |
| 20 | `POST /v1/hr/workforce/checklists/:id` | `signedBy` | A-low | Recorded a sign-off under a typed name | M25-FR-02 | c | Open |
| 21 | `POST /v1/purchase/suppliers/:id` | `documents[].verifiedBy` | A-low | Stored a typed document verifier on the supplier master | M06-FR-01 | c | Open |
| 22 | `POST /v1/supplier-portal/partners/:id` | `documents[].verifiedBy` | A-low | Made a compliance document count, which gates ASN and invoice acceptance | M24-FR-02 | c | Open |
| 23 | `POST /v1/merchandising/display-contracts/:id` | `approvedBy` | A-rec | Cleared the `unapproved` review finding | M04-FR-04, D02-FR-06 | c | Open |
| 24 | `POST /v1/purchase/rebate-schemes/:id` | `approvedBy` | A-rec | Stored only | M06-FR-03, D03-FR-03 | c | Open |
| 25 | `POST /v1/purchase/contracts/:id` | `approvedBy` | A-rec | Cleared the `unapproved` contract alert | M06-FR-03, D03-FR-03 | c | Open |
| 26 | `POST /v1/purchase/import-jobs/:id` | `approvedBy` | A-rec | The job history showed "approved by X" from the body | M30-FR-04 | c | Open |

## Side findings (recorded; each goes into the slice named)

- **Typed makers** (the requester, not the approver):
  - Fixed in **a**: `bank-details requestedBy`, `import uploadedBy` and the pay-run `actor`.
  - Open, slice **c**:
    - `requestedBy` on the emergency-access and access-lifecycle requests;
    - `loadOperator` on a migration load;
    - `enteredBy` on stock movements (also covered by row 14).
- **Box-relayed decisions with no store seal** (slice **c**). Unlike sales, refunds, cash and till closes (ADR-0023),
  these never check a seal:
  - `approvals/decisions/:id/synced` — this one also *applies* a clean decision;
  - `day-close/:id/reopen/synced`;
  - `invoices/:id/synced`;
  - `checklists/:id/synced`;
  - the two migration `/synced` routes.
- **Back-office screens where the second person is a typed name.** In both, the box checks only that it is a
  different name. Each moves with its route:
  - day reopen (`day-reopen.js`), slice **c**;
  - the buyer's invoice capture (`buying.js`), slice **b**.
- **Screens that collect a typed approver but run only a local engine** (not wired to the API). Each is wired with
  its route in slice **b** or **c**:
  - finance close and reopen;
  - service compensation;
  - the admin support grant.
- **The margin floor is taken from the request** (found in 2b-vi-b-1). `POST /v1/prices/changes`, price-list entries
  and quotations read `marginFloorBps` — and a quotation also its line costs — from the body. So the person setting a
  price also chooses the floor it is checked against. The second person now sees the floor and costs in the approval's
  details, but the floor itself should come from the shop's own margin policy (M05-FR-02). That register does not
  exist at head office yet; it belongs with the operative price and promotion registers in **Wave 4 (SF-01)**.
- **The pay-run route's gate.** It is `payroll.statutory.read` for every step, approve and lock included. Payroll
  approve, lock and bank-file release are under the pilot hold; this is recorded here and **no new permission is
  invented**. The owner sets the payroll approval authority when the hold lifts.

## Checked and fine (no change needed)

These routes already take the approver from the signed-in person, refuse a typed approver, write nothing, or use the
name only as a label:

- price-change vendor funding, the B2B credit check and invoice reconcile (stateless);
- stock counts and warehouse transfers (approver = the caller);
- customer erasure, product merge, delegation, emergency access and access lifecycle (the decider);
- support access, purchase orders, supplier approval, GSTR-1 submission, settlement, shift, floor indents,
  adjustment requests, goods receipt and risk;
- data-rights verification (the method of proof, not a person);
- branch-lifecycle evaluation and partner certification (a ruling, or a label).
