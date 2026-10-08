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
  - **b-2** finance — done;
  - **b-3** stock, orders and purchasing — done.
- **c** — 2b-vi-c, in four parts:
  - **c-1** the 8 low-severity and record-only names (rows 19–26) — done;
  - **c-2** the typed makers (emergency access, access lifecycle, migration load operator) and the admin support-grant
    screen — done;
  - **c-3** the store seal on the box-relayed decisions — done (the day-reopen approver and the bill-capture checker are
    now said as unverified at head office);
  - **c-4** the day-reopen approver's own PIN at the store computer, the buyer's screen without a typed checker
    (row 17b), and the migration screen handing its decisions to the store computer.

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
| 8 | `POST /v1/finance/periods/:period/reopen` | `approvedBy` | A | Reopened a closed accounting period | M23-FR-04, §28 | b-2 | **Fixed** (b-2): kind `period_reopen`, approver holds `finance.period.sign`; the Finance screen asks and reopens at head office |
| 9 | `POST /v1/finance/periods/:period/close` | `signedBy` | A | Certified a period close | §28 (M23) | b-2 | **Fixed** (b-2): kind `period_close` — the signature is the signer's own approval; the Finance screen asks and closes at head office |
| 10 | `POST /v1/concession/contracts/:id` | `approvedBy` | A (no check) | Cleared the contract's `not_approved` trading blocker | M27, §28 | b-2 | **Fixed** (b-2): kind `concession_contract`, approved by another concession manager (API-only; no screen) |
| 11 | `POST /v1/concession/concessionaires/:id/deposit-movements/:movementId` | `approvedBy` | A (no check) | A forfeit took a deposit off the liability | M27, §28 | b-2 | **Fixed** (b-2): kind `concession_deposit_forfeit`, only a forfeit takes an approval (API-only; no screen) |
| 12 | `POST /v1/hr/payroll/bank-file` (+ `/journal`) | `events[].approved.by` | A | Built the salary bank file from caller-supplied events | §28, SEC-03 | b-2 | **Fixed** (b-2): both read the pay run head office recorded (approved by a different signed-in person); a history in the request is refused; the lines / net must be the run's recorded net total and headcount |
| 13 | `POST /v1/inventory/write-off/:id` | `approvedBy` | A | Approved a material stock loss | M28-FR-01, M27-FR-02, §28 | b-3 | **Fixed** (b-3): kind `stock_write_off`, approved by another person who may post stock movements; the write-off screen asks and records with the approval |
| 14 | `POST /v1/inventory/movements` (`adjusted`) | `approvedBy` and `enteredBy` | A | An upward adjustment approved by one body string against another | M08, §28, hard rule #2 | b-3 | **Fixed** (b-3): kind `stock_adjustment_up`; `enteredBy` must be the caller (API-only; no screen sends one) |
| 15 | `POST /v1/orders/:id/refunds` | `approvedBy` | A | Moved money back to a customer | M18-FR-04, M20-FR-03, §28 | b-3 | **Fixed** (b-3): kind `order_refund`, approver holds `order.refund.approve`; spent before the money moves (API-only; no screen) |
| 16 | `POST /v1/service/cases/:id/compensation` | `approval.decidedBy` | A | Granted service compensation | M21-FR-04, §28 | b-3 | **Fixed** (b-3): kind `service_compensation`, approver holds `service.compensation.approve` (the service screen grants none yet) |
| 17 | `POST /v1/purchase/invoices/:id/capture` | `approvedBy` | A (flag only) | The invoice was recorded with an unverified approver | SP-7a, M07-FR-04, §28 | b-3 | **Fixed** (b-3): kind `supplier_invoice_check`, checker holds `purchase.invoice.match`; captured with no approval it is flagged `no_approval` (API-only at head office; the box's capture is row 17b) |
| 18 | `POST /v1/purchase/suppliers/:id/payments/:paymentId` | `approvedBy` | A | Recorded a supplier payment | M23-FR-01, M06-FR-01, M15-FR-03, §28 | b-3 | **Fixed** (b-3): kind `supplier_payment`, approved by another person who may pay suppliers; no approval → `payment_needs_approval` (API-only; no screen) |
| 19 | `POST /v1/hr/workforce/certifications/:id` | `verifiedBy` | A-low | Made a certificate count as cover for the task gate | M25-FR-03 | c-1 | **Fixed** (c-1): the verifier is the caller (`actor_is_the_caller`), never the certificate's own holder (`self_verification`) |
| 20 | `POST /v1/hr/workforce/checklists/:id` | `signedBy` | A-low | Recorded a sign-off under a typed name | M25-FR-02 | c-1 | **Fixed** (c-1): the signer is the caller; the checklist screen sends a signature only when the person signs |
| 21 | `POST /v1/purchase/suppliers/:id` | `documents[].verifiedBy` | A-low | Stored a typed document verifier on the supplier master | M06-FR-01 | c-1 | **Fixed** (c-1): a document verified now names the caller and takes the server's time; one re-sent exactly as stored keeps its verifier |
| 22 | `POST /v1/supplier-portal/partners/:id` | `documents[].verifiedBy` | A-low | Made a compliance document count, which gates ASN and invoice acceptance | M24-FR-02 | c-1 | **Fixed** (c-1): the same rule as row 21 (one shared kernel rule) |
| 23 | `POST /v1/merchandising/display-contracts/:id` | `approvedBy` | A-rec | Cleared the `unapproved` review finding | M04-FR-04, D02-FR-06 | c-1 | **Fixed** (c-1): kind `display_contract`, approved by `purchase.supplier.approve` ("Finance approves funding terms") (API-only; no screen) |
| 24 | `POST /v1/purchase/rebate-schemes/:id` | `approvedBy` | A-rec | Stored only | M06-FR-03, D03-FR-03 | c-1 | **Fixed** (c-1): kind `rebate_scheme`, approved by `purchase.supplier.approve` (API-only; no screen) |
| 25 | `POST /v1/purchase/contracts/:id` | `approvedBy` | A-rec | Cleared the `unapproved` contract alert | M06-FR-03, D03-FR-03 | c-1 | **Fixed** (c-1): kind `purchase_contract`, approved by `purchase.supplier.approve` (API-only; no screen) |
| 26 | `POST /v1/purchase/import-jobs/:id` | `approvedBy` | A-rec | The job history showed "approved by X" from the body | M30-FR-04 | c-1 | **Fixed** (c-1): the approver is read from head office's record of the commit; a typed one is refused (`approver_is_read_from_the_commit`) |

## Side findings (recorded; each goes into the slice named)

- **Typed makers** (the requester, not the approver):
  - Fixed in **a**: `bank-details requestedBy`, `import uploadedBy` and the pay-run `actor`.
  - Fixed in **c-2**:
    - `requestedBy` on the emergency-access and access-lifecycle requests — the caller asks (`identity.role.request`)
      and the owner approves on the engine (kinds `emergency_access`, `access_change`);
    - `loadOperator` on a migration control-total signature — read from head office's record of who ran each trial
      load; a typed one is refused (`load_operator_is_read_from_the_record`), and with no trial load on record nothing is
      signed;
    - `enteredBy` on stock movements — fixed with row 14 in b-3.
- **Box-relayed decisions with no store seal** (slice **c-3**). Unlike sales, refunds, cash and till closes (ADR-0023),
  these never check a seal:
  - `approvals/decisions/:id/synced` — this one also *applies* a clean decision;
  - `day-close/:id/reopen/synced`;
  - `invoices/:id/synced`;
  - `checklists/:id/synced`;
  - the two migration `/synced` routes.
  - **Fixed in c-3** (ADR-0023 amended): the store computer seals each of these for the person it verified for the
    request, over every word of the record; head office flags `decider_not_verified_at_store` /
    `decider_seal_does_not_match`. An approval decision so flagged is not applied; a migration decision is refused by
    name; a checklist, bill or reopen is recorded with the flag. Limit: a real store box's back-office screens have no
    sign-in yet (OB-15), so their decisions arrive unsealed and flagged.
- **Back-office screens where the second person is a typed name.** In both, the box checks only that it is a
  different name. Each moves with its route:
  - day reopen (`day-reopen.js`) — c-3 seals the reopener and flags the typed approver
    (`approver_not_verified_at_store`); the approver's own PIN at the store computer is slice **c-4**;
  - the buyer's invoice capture (`buying.js`) — **moved to slice c** (found in 2b-vi-b-3, recorded here as row
    17b). The buyer captures the bill on the store box, which may be offline, and the box relays it through
    `invoices/:id/synced`. Head office re-verifies both people's grants on that relay, but the checker is still a name
    the box took. The fix is the same one the other box-relayed decisions need — a store seal on the checker's own
    act — so it moves with them in slice c instead of getting a one-off answer here. **c-3:** head office keeps the typed
    checker as a claim (`approvalClaimedBy`) and records the bill unchecked (`no_approval`,
    `approver_not_verified_at_store`); the check is the checker's own act at head office (the match). The screen drops
    the typed checker in **c-4**.
- **Screens that collect a typed approver but run only a local engine** (not wired to the API). Each is wired with
  its route in slice **b** or **c**:
  - finance close and reopen — wired in b-2;
  - service compensation — checked in b-3: the service screen offers no compensation yet (its compensation call is a
    stub that grants nothing), so there is no typed box to remove. When a compensation screen is built it asks on the
    engine;
  - the admin support grant — fixed in c-2: the Admin screen shows head office's waiting support requests and the owner
    approves or rejects them in their own session; the typed approver box and the local-only grant are gone.
- **The margin floor is taken from the request** (found in 2b-vi-b-1). `POST /v1/prices/changes`, price-list entries
  and quotations read `marginFloorBps` — and a quotation also its line costs — from the body. So the person setting a
  price also chooses the floor it is checked against. The second person now sees the floor and costs in the approval's
  details, but the floor itself should come from the shop's own margin policy (M05-FR-02). That register does not
  exist at head office yet; it belongs with the operative price and promotion registers in **Wave 4 (SF-01)**.
- **A concession contract's two versions shared one record id** (found in 2b-vi-b-2). Approving a contract that was
  recorded unapproved — the normal two-person path now — collided with the first version on PostgreSQL (a crash, not
  a new version). Fixed: each version's id comes from its own key.
- **A month-close approval names the month, not the figures.** Head office re-checks its own control totals at the
  moment of closing, so a month that stopped agreeing after the approval cannot close. A posting after the approval
  that still agrees is not shown to the signer again. Recorded as the reconsider-when.
- **Who approves a supplier's terms** (found in c-1). Rows 23–25 had no approval authority of their own. M06-FR-01 names
  "Purchase Approver/Finance" as who approves a supplier, and D02-FR-06 says "Finance approves funding terms", so all three
  use the existing supplier-approval permission (`purchase.supplier.approve` — the accountant and the owner today). No
  permission was invented; a dedicated "approve commercial terms" authority would be the owner's to set.
- **The checklist screen's unsigned save** (found in c-1). Ticking items without signing sent an empty signer name,
  which head office could not read (so the save was refused), and a signed checklist re-sent its earlier signer's name.
  Fixed: the screen sends a signature only when this person signs.
- **A second support-access route took both people from the request** (found in c-2; the triage had listed support
  access as fine — that check covered the request-and-decide routes, not this one). The older one-step
  `POST /v1/platform/support-access` took the requester and the approving owner from the body, and wrote into whichever
  tenant the body named. Nothing read what it wrote. **Retired** in c-2: it now answers 410 `support_access_moved` and
  points to the request-and-decide routes; the Admin screen uses those.
- **The emergency-access time cap is read from the request** (found in c-2). `maxMinutes` comes from the body, so the
  person asking also sets the ceiling their request is checked against (default 240 minutes when absent). The owner now
  sees it in the approval's details, but the cap should be the shop's own emergency-access policy — an open owner input
  in M02 ("the emergency-access approval policy"). Recorded, not changed.
- **A single owner can no longer grant emergency access or change someone's access alone** (c-2). The person asking
  (a store or HR manager, `identity.role.request`) and the owner approving must be two people — M02-FR-04's "separation
  between requester and granter". Before, the owner typed someone else's name as the requester.
- **The owner who runs a migration trial load cannot sign its stock totals** (c-2). The chartered accountant signs them
  (as well as the finance and tax totals). Before, the owner typed a different "load operator".
- **The pay-run route's gate.** It is `payroll.statutory.read` for every step, approve and lock included. Payroll
  approve, lock and bank-file release are under the pilot hold; this is recorded here and **no new permission is
  invented**. The owner sets the payroll approval authority when the hold lifts.

## Checked and fine (no change needed)

These routes already take the approver from the signed-in person, refuse a typed approver, write nothing, or use the
name only as a label:

- price-change vendor funding, the B2B credit check and invoice reconcile (stateless);
- stock counts and warehouse transfers (approver = the caller);
- customer erasure, product merge, delegation, emergency access and access lifecycle (the decider);
- support access through its request-and-decide routes (the older one-step route was not — see the side findings),
  purchase orders, supplier approval, GSTR-1 submission, settlement, shift, floor indents,
  adjustment requests, goods receipt and risk;
- data-rights verification (the method of proof, not a person);
- branch-lifecycle evaluation and partner certification (a ruling, or a label).
