# ADR 0024 — Head office's maker-checker engine: an approval is the checker's own act, used once, for exactly what was asked

- **Status:** Accepted (owner program directive — the audit's Wave 2 critical findings are repaired in order; PA-03
  reopened by the 2b-vi triage, see `docs/registers/second-person-sites-2026-10-07.md`)
- **Date:** 7 October 2026
- **Context:** Wave 2b-iii (PA-03) made every second person at head office a separate signed-in act *where the route
  had its own second-person step*. ADR-0022 did the same for refund approvals. But head office never had the general
  engine M02-FR-03 describes — *"Maker submits an action needing approval → engine routes to the authorized checker →
  checker approves / rejects with reason → action commits or is discarded → evidence recorded … A maker can never
  approve their own request; changing the amount of a pending request invalidates its approval."* So each module grew
  its own box where the person doing the work **typed** the approver's name. The 2b-vi triage read every route that
  takes a second person from a request body and found **26 that accept the typed name as that person's act** (the
  register lists each with its file, field, requirement and the slice that fixes it). Three are severe: a supplier's
  bank account (both the requester and the approver were body strings; the approver's authority was never checked); a
  bulk import commit (the checker and the uploader both from the body); and a pay-run step (the maker and the checker
  both a body `actor`). The audit's words for the class: *"role lookup proves that name has authority, not that the
  person approved this action."*

## Decision

1. **One engine, at head office** (`services/identity/src/approval-requests.ts`, routes under `/v1/approvals/requests`):
   - the **maker asks** in their own session — the kind of action, its subject, the amount (paise, or none), a summary,
     why, and the **exact details** the action will carry, which the engine fingerprints (SHA-256 over a canonical,
     key-sorted form). Only someone who may do the action may ask for it;
   - a **checker** — anyone else holding that kind's approval permission, **never the maker** — sees it in their inbox
     (`GET /v1/approvals/requests`: *waiting for me* and *what I asked*) and approves or rejects it **with a reason**,
     in their own session. A decision is final; an approval lasts the kind's window (24 hours for both kinds today);
   - the **action names the approval** (`approvalId`). Its route opens the approval and refuses it by name unless it is
     the same kind, the same subject, the same details (fingerprint), the same amount and the same maker; decided
     *approved*; not expired; **never used**; and the checker still holds the permission (a leaver's approval stops
     counting). Then, after every rule of its own has passed and **before** the action is written, the route spends it.
2. **One decision and one use, enforced by the store.** Every request has one guard (`approval-request:<id>`); the
   decision and the use are each keyed by the request, so only one of each can ever land, and each write carries its
   own attempt id. Two checkers at the same moment: one decision stands and the other is **told** (`already_decided`,
   409) — never a "201" for a decision that was not recorded. Two actions at the same moment — even the same action
   sent twice under different keys: one proceeds and the others are refused (`approval_already_used`, 409). A lost
   reply re-sent under its own idempotency key gets its original answer, never a second use.
3. **A typed second person is refused by name** (`approver_named_without_approval`, 422) wherever a route moves onto
   the engine; and **the maker is the signed-in caller** — a body naming someone else as the requester, uploader or
   actor is refused (`actor_is_the_caller`).
4. **The three severe sites move now (2b-vi-a):**
   - **Supplier bank details** (`POST /v1/purchase/suppliers/:id/bank-details`, M06-FR-01): kind `supplier_bank_change`
     — maker holds `purchase.supplier.bank`, checker `purchase.supplier.approve`. The approval binds the supplier and
     every detail of the change (account token, how it arrived, the number called back on, the date it was requested).
     The existing rules still run on top: called back on a number we already held; the supplier's creator never
     approves its bank details.
   - **Bulk import commit** (`POST /v1/import/commit`, M30-FR-01): kind `data_import_commit` — the checker is **another
     person already authorised to import** (owner, store manager); a dedicated "approve imports" authority would be new
     role policy, which is the owner's to set. Validate returns the file's **content fingerprint**; the approval binds
     the job and that fingerprint, so a changed row needs a new approval. An import job is recorded once, keyed by the
     job — two commits of one job never land two loads.
   - **Pay-run steps** (`POST /v1/hr/payroll/pay-run/:id/append`): every step's actor is the signed-in caller, so the
     maker ≠ checker rule compares two real sign-ins. (Payroll approve / lock / bank-file release remain under the pilot
     hold; the route's gate is `payroll.statutory.read` for every step — recorded in the register, no permission
     invented.)
5. **Screens:** the import screen asks for approval and loads with the approval; a new **Approvals** page shows a
   checker what waits for them and lets them approve or reject with a reason, and shows a maker where their requests
   stand.

## Consequences

- PA-03's class is now *one engine plus a list*: the remaining 23 sites move onto the same engine in two slices —
  **2b-vi-b** money and price approvals (price changes, price-list entries, promotion launch, quotations, period close
  and reopen, concession contract and deposit forfeit, the payroll bank file, write-off, upward stock adjustment, order
  refunds, service compensation, invoice capture, supplier payments), each with its screen; **2b-vi-c** the low-severity
  and record-only typed names, plus the store seal on the remaining box-relayed decisions.
- An approval that was spent by an action which then failed to write is used up; the maker asks again. That is the
  fail-closed choice: no action ever runs without its approval, and no approval ever pays for two.
- Escalation, delegation and value-limit routing (the rest of M02-FR-03) are **not** in this slice — recorded as not
  yet, not as done.
- Callers that sent a typed approver (the pilot seed, the import screen, older tests) now ask and approve as two
  people; the pilot seed's pay run is drafted by its preparer under their own sign-in.

## Reconsider-when

The owner sets a dedicated "approve imports" authority, or a value limit above which a second approver (or the owner)
must approve — then the kind's checker permission or a value-limit rule changes; the engine's shape does not.

## Amendment — 2b-vi-b-1, pricing (7 October 2026)

- **One rule for what is approved.** Every action moved onto the engine fingerprints the same thing: its own request
  body without the control fields (`approvalId`, and the typed `approval` / `approvedBy` / `rationale` it replaced), plus
  the route's path ids (`actionDetails`). A client asks with exactly the body it will send. Every route refuses a typed
  name the same way (`approvalNamedIn`).
- **Four pricing kinds.** Each is approved by the pricing-approval authority (`price.change.approve`, M05-FR-02: "above
  the setter's authority"):
  - `price_change` — `POST /v1/prices/changes`;
  - `price_list_entry` — `POST /v1/prices/list/:productId/entries/:entryId`;
  - `promotion_launch` — `POST /v1/promotions/:id/launch`;
  - `quotation_below_floor` — `POST /v1/pos/quotations/:id`. Before this, a below-floor quote passed with any name and
    no authority check at all.
- The Products & prices screen asks for approval and then saves or launches with it; the typed-approver dialog is gone.
- **Recorded, not changed:** the margin floor (and a quotation's line costs) are still read from the request. The
  approver sees them in the approval's details. The shop's own margin policy is Wave 4 (SF-01) work.

## Amendment — 2b-vi-b-2, finance (7 October 2026)

- **Four new kinds.**
  - `period_close` and `period_reopen` (M23-FR-04, "period close/reopen by Finance with approval"): the person who
    closes or reopens (`finance.period.close`) asks; someone who may sign a period (`finance.period.sign` — the
    accountant, the CA or the owner) approves. The signature on a close **is** that approval; head office still refuses
    a signer who posted into the month and re-checks its own control totals at the moment of closing.
  - `concession_contract` and `concession_deposit_forfeit` (M27-FR-01, "contracts approved"): the checker is another
    person authorised to manage concession contracts. As with imports, a dedicated approval authority would be new role
    policy, which is the owner's to set. Only a forfeit takes an approval.
- **The salary bank file and the payroll journal read the pay run head office recorded.** That run was submitted,
  approved and locked step by step by signed-in people (2b-vi-a). A history sent in the request — whose approver was a
  string anyone could write — is refused by name. When the run recorded its net total and headcount, the file and the
  journal must pay exactly that.
- The Finance screen asks for the signature or approval and then closes or reopens at head office. The typed "who is
  approving" box is gone.


## Amendment — 2b-vi-b-3, stock, orders and purchasing (7 October 2026)

- **Six new kinds.** Each checker holds the authority the route already named; no permission was invented.
  - `stock_write_off` — `POST /v1/inventory/write-off/:id` (M28-FR-01, a loss at or above the tenant's material-loss
    threshold). Approved by another person who may post stock movements (`inventory.movement.append`: the manager or
    the owner). Evidence is still required.
  - `stock_adjustment_up` — `POST /v1/inventory/movements` with kind `adjusted` (M08). Approved by the same authority.
    The person who entered it (`enteredBy`) must be the signed-in caller.
  - `order_refund` — `POST /v1/orders/:orderId/refunds` (M18-FR-04). Issued by `order.refund.issue`, approved by
    `order.refund.approve`. The approval is spent before any money moves.
  - `service_compensation` — `POST /v1/service/cases/:caseId/compensation` (M21-FR-04), for a grant above the agent's
    own authority. Approved by `service.compensation.approve`. The tenant's limits still come from its policy.
  - `supplier_invoice_check` — `POST /v1/purchase/invoices/:invoiceId/capture` (SP-7a). The buyer
    (`purchase.invoice.capture`) asks; someone who may match bills (`purchase.invoice.match`) checks. A bill captured
    before anyone checked it is still recorded, flagged `no_approval`, because the match and the payment each need
    their own second person.
  - `supplier_payment` — `POST /v1/purchase/suppliers/:supplierId/payments/:paymentId` (M23-FR-01). Approved by another
    person who may pay suppliers (`purchase.supplier.pay`). A payment with no approval is refused
    (`payment_needs_approval`).
- **The write-off screen** asks for approval for a material loss, and records it with the approval once another person
  has approved it. The Approvals page names all six kinds in English and Tamil.
- **Recorded, not changed:** the buyer's bill capture on the store box (`buying.js`) is relayed to head office through
  `invoices/:id/synced`. That relay re-verifies both people's grants, but its checker is a name the box took. It moves
  with the other box-relayed decisions in 2b-vi-c (a store seal on the checker's own act).

## Amendment — 2b-vi-c-1, the low-severity and record-only names (7 October 2026)

- **A verifier or signer is the person signed in.** Where the second person's act is the record itself — verifying a
  certificate, signing a checklist, verifying a supplier's or a partner's document — the route takes that person from
  the sign-in. A name for anyone else is refused (`actor_is_the_caller`).
  - A certificate is never verified by its own holder (`self_verification`).
  - A supplier or partner record is sent whole, so each document is judged against the stored copy. A document re-sent
    exactly as stored keeps its verifier and time. A new or changed one must name the caller, and takes the server's
    clock (`documentsVerifiedByTheCaller`, in the kernel).
- **Three new kinds for a supplier's terms:** `display_contract`, `rebate_scheme` and `purchase_contract`.
  - Before, each was stored with a typed "approved by" that cleared its `unapproved` finding.
  - The approver now holds the existing supplier-approval authority (`purchase.supplier.approve`: M06-FR-01's "Purchase
    Approver/Finance", and D02-FR-06's "Finance approves funding terms" for display funding).
  - Terms recorded without an approval stay unapproved, and the finding stays.
- **An import job's history reads its approver** from head office's record of the commit (2b-vi-a). A typed one is
  refused (`approver_is_read_from_the_commit`).
- **Reconsider-when:** the owner sets a dedicated authority for approving commercial terms. Then only the three kinds'
  checker permission changes.

## Amendment — 2b-vi-c-2, the person asking (7 October 2026)

- **Two new kinds for access** (M02-FR-04: "Store/HR manager (request/confirm), Owner (approve emergency access) …
  separation between requester and granter"):
  - `emergency_access` — `POST /v1/access/emergency/:grantId`;
  - `access_change` — `POST /v1/access/lifecycle/:requestId` (joiner, mover, leaver).
- **How both work now.** The person asking is the signed-in caller (`identity.role.request` — the store manager or the
  owner). The approver holds `identity.role.grant` (the owner), approves in their own session, and is never the
  requester. Both routes now require the approval.
  - Before, the owner called the route and TYPED who had asked. The route's gate moves from `identity.role.grant` to
    `identity.role.request`; the authority still comes from the owner's approval.
  - The access-change rule "the approver cannot hand out what they do not hold" checks the approver from the approval.
- **The migration control-total signature reads the load operator** from head office's record of the trial loads
  (each trial load now records who ran it). A typed `loadOperator` is refused. With no trial load on record, nothing is
  signed.
- **The one-step support-access grant is retired** (`POST /v1/platform/support-access`, 410 `support_access_moved`). It
  took both people from the body. Support access is the request-and-decide pair: the support person asks in their own
  session, and the owner decides on the Admin screen in theirs.
- **Recorded, not changed:** the emergency-access cap (`maxMinutes`) is still read from the request. The owner sees it
  in the approval, and the shop's own emergency-access policy is an open owner input (M02).
