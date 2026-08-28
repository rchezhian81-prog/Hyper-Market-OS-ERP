# SRE Retail OS — API & event catalogue (Stage 4)

- **Roadmap:** §30 (API design), §30.2 (domain events), §31 (offline/sync). **API-01…API-13.** Principle **P-06** (open & portable). Contracts live in `../../packages/contracts/`.
- **Purpose:** The versioned contract surface between clients, edge and cloud, and the durable business events that are the integration backbone. **Store-Core (R2)** domains are detailed; later domains are named and expanded at their release.

> No endpoint code or OpenAPI/event schemas yet — those are produced per domain from
> Stage 5. This catalogue fixes the conventions and the domain/event map.

## 1. Conventions — all APIs
- **Versioned (P-06):** major version in the path (`/v1/…`); additive-only within a major;
  a breaking change is a new major with a deprecation window.
- **Auth:** OAuth2/OIDC bearer tokens issued by Identity (API-01); every request carries
  **company/branch scope**; least privilege (SEC); **no shared logins** (hard rule #4).
- **Idempotency (§31.1):** every write accepts an **`Idempotency-Key`**; safe replay
  returns the same result — **mandatory** for edge→cloud sync so a resent sale or movement
  applies once.
- **Errors:** structured, typed errors carrying the §27.1 three-part content — *what
  happened · whether data was saved · the next safe action*.
- **Pagination/filtering:** cursor pagination; filter by company/branch/warehouse/dept.
- **Events (§30.2):** state changes are recorded as **durable domain events** in a Postgres outbox
  (ADR-0008, the §19 broker deferred) and drained **at-least-once** (**idempotent consumers**, retry +
  **dead-letter**). Events — not synchronous call chains — are how domains integrate.
- **Audit/observability:** every write is audited (M34) and traceable (NFR-15).
- **No card data (hard rule #3):** no PAN/CVV/expiry crosses any API — provider tokens
  and refs only.

## 2. API domains (API-01…API-13)

| API | Domain | Modules | Key resources | Release |
| --- | --- | --- | --- | --- |
| API-01 | Identity / Admin | M01–M02 | orgs, branches, users, roles, approvals, config, number series | R1 |
| API-02 | Catalogue | M03–M05 | products, barcodes, prices, promotions, tax classes | R2 |
| API-03 | Purchase | M06–M07, M30 | suppliers, POs, GRNs, invoices, matches | R2 |
| API-04 | Inventory | M08–M11 | movements (append), availability, batches, adjustments, counts | R2 |
| API-05 | POS | M12–M15 | sales, tenders, refunds, till sessions | R2 |
| API-06 | Customer / Loyalty | M16–M17, M21 | customers, consent, points, cases | R4 |
| API-07 | OMS | M18 | orders, reservations, routing | R5 |
| API-08 | Fulfilment / Delivery | M19 | picks, packs, routes, proof | R5 |
| API-09 | Finance | M23 | journals, AP/AR, reconciliation, period close, Tally | R2 |
| API-10 | Reporting | M29 | read models / KPIs (read-only, freshness) | R2 |
| API-11 | Platform | M32–M35 | flags, store setup, jobs, devices, support access, audit, backup/health | R1 |
| API-12 | Migration | MG-01–MG-12 | staging, mapping, exceptions, reconciliation | R3 |
| API-13 | AI | A01–A10 | agent runs, evidence, budget, kill switch | R7 |

## 3. Core Store-Core flows (illustrative)
- **POS sale (API-05, edge-first):** commit locally → queue in the outbox → on sync
  `POST /v1/sales` with an `Idempotency-Key` → `SaleCommitted`. Tender emits
  `TenderAuthorized` / `TenderUncertain` / `TenderSettled`. **Never blocks on the network**
  (hard rule #1); **never carries a card number** (hard rule #3). The edge writes its sale
  in the store's own shape (`id`/`total`); `toCloudSale` (`edge/store-edge/src/cloud-sale.ts`)
  translates it into this endpoint's contract (`saleId`/`totalMinor`, stamping `packVersion`
  from the pack the lane priced from) at the sync boundary — proven end to end through the
  real lane in `tests/e2e/core-one-lane.test.ts` (prove the core on one lane).
- **Stock movement (API-04):** `POST /v1/inventory/movements` **appends** an event →
  `InventoryMoved`; balance is projected; replay is safe. Adjustments →
  `InventoryAdjusted` (reason-coded, approved).
- **Shelf count (API-04, M04-FR-02/03):** a shelf quantity is an **observation**, not a fact.
  `POST /v1/merchandising/shelf-counts/:countId` (`shelf.count.record`) records one **blind** count —
  the figure and nothing else; the counter is the **authenticated user**, never a client field; a
  negative or fractional count, or a shelf the shop does not have, is refused `422` and nothing is
  saved → `ShelfCountRecorded` (**append-only**, so a recount is a new observation and the prior one
  stays — it is what explains a variance). `GET /v1/merchandising/shelf-counts?storeId=` (`shelf.count.read`)
  returns the latest count per facing and **how stale** each is against a freshness window; `POST
  …/shelf-counts/worklist` returns the facings that most need counting, **never-counted before long-ago,
  worst first**. This is the on-shelf figure `planogramCompliance` (M19) always needed.
- **Planogram compliance (API-04, M04-FR-03) — the consumer:** `POST /v1/merchandising/planogram-compliance`
  (`planogram.compliance.read`) folds the store's **recorded** shelf counts into the plan and raises the
  right task. An **empty facing with stock in the stockroom** is an urgent refill — the most expensive
  out-of-stock there is — told apart from an empty facing with none (a **reorder**, no task). An
  **uncounted** facing is `never_counted`, never a breach and never compliant, and the compliance % is
  taken over the **observed** facings only, so a figure nobody earned is never quoted (P-08). A
  self-inconsistent plan (a facing on a shelf the store has not mapped, two primary homes) is refused
  `422`. A **pure read/compute** — it writes nothing; the plan (planogram, shelf map, stockroom figures)
  is caller-supplied, only the observations come from what the store recorded.
- **Space productivity & display contracts (API-04, M04-FR-04 · M23):** two questions a big shop gets
  wrong by feel. `POST /v1/merchandising/space/performance` (`merchandising.space.read`) runs
  `spacePerformance` — ranks areas by **margin per square foot** (not turnover), says `not_meaningful`
  where a ratio cannot be computed rather than a fabricated zero, and flags an area whose share of
  **margin** sits materially below its share of **space** ("this aisle is too big"). For supplier display
  deals, `POST /v1/merchandising/display-contracts/:id` (`merchandising.display.manage`) records a contract
  (append-only, latest-per-id) and `POST /v1/merchandising/display-contracts/review`
  (`merchandising.space.read`, static route matched before `/:id`) runs `reviewDisplayContracts` — the
  finding that costs money is an **expired contract whose display is still on the floor** (the supplier
  stopped paying and nobody took the stand away), alongside **unapproved** (no Finance sign-off, §28),
  **no-space-named** and **funding-not-received** (agreed money not in — M23), worst first.
- **Assortment / range management (API-04, M04-FR-01):** the range answers "does **this** store carry this
  item?", enforced both ways. `POST /v1/merchandising/assortment/:store/:product/list` (`merchandising.range.manage`)
  lists an item; `…/drop` runs `dropFromRange` — **the dangerous operation**: a drop **with stock on hand
  routes to CLEARANCE, never a silent delete** (deleting a stocked item makes its stock invisible — not
  counted, not replenished, eventually written off), decided by the caller, `422` on an unnamed decider or a
  "replaced" with no replacement. `POST /v1/merchandising/assortment/:store/integrity`
  (`merchandising.range.read`, static route matched before `/:product`) folds the recorded range into an
  `Assortment` and runs `checkAssortmentIntegrity` — **`sold_not_in_assortment`** (sold where it isn't
  ranged — the next customer is disappointed), **`reordered_not_listed`** (how a dropped item keeps
  arriving), **`clearance_with_no_stock`** (clearance finished — delist it) and **`listed_never_sold`**
  (holding shelf space and cash). `GET /v1/merchandising/assortment/:store?onDate=` resolves the listed
  range as-at a date. Effective-dated, event-sourced per store.
- **Approval delegation (API-01, M02-FR-03 · §28 · hard rule #4):** the honest alternative to the shared
  login — the manager is on leave, refunds still need authorising, so a deputy is lent that authority
  instead of the password. `POST /v1/access/delegations/:id` (`approvals.delegation.grant`) runs
  `grantDelegation`, **authorised by the caller** (a separate person — even the owner cannot self-authorise
  a lend of their own authority), refusing `self_delegation`, `exceeds_granter_authority`,
  `widens_branch_scope`, `too_long` and — the loophole this exists to close — `chain_forbidden` (a delegate
  cannot re-delegate: two hops in, nobody is accountable). `POST …/effective-authority` runs
  `effectiveAuthority` — a person's **own** authority wins, a live delegation only **adds** what they lack,
  an expired one grants nothing (it stops on its own). `GET /v1/access/delegations` runs `reviewDelegations`
  — the standing-delegations audit that catches a fortnight's-leave grant from March still live in August
  (active / expiring / expired / revoked). `POST …/:id/revoke` ends one early. The delegate always decides
  **in their own name** — the absent manager's name is never used.
- **Emergency access (API-01, M02-FR-04 · SEC-11 · §28):** the elevated access that is real, necessary and
  the one that quietly becomes permanent — support needs the owner's rights for twenty minutes and still has
  them six months later. `POST /v1/access/emergency/:id` (`identity.role.grant`) runs `grantEmergencyAccess`
  — the **authenticated caller is the approver** and can never be the requester (§28); the reason must be
  specific enough to review; the **expiry is computed at grant and stored** so it ends on its own; and
  anything over the policy cap is refused (`emergency_access_refused` — "no perpetual support access").
  `POST …/:id/revoke` ends one early (recorded, never erased). `GET /v1/access/emergency`
  (`identity.role.read`) runs `emergencyAccessReview` — who had elevated access, when, why, for how long and
  who allowed it, active and ended-early both visible. Never extended in place: more time is a **new grant
  with a new approval**, which is exactly what makes it appear in the review. Event-sourced
  (`EmergencyAccessRecorded`), restart-safe.
- **Joiner / mover / leaver (API-01, M02-FR-04 · SEC-11 · §28):** access has to track employment reality —
  the gap between what someone can do and what their job is, is where fraud lives.
  `POST /v1/access/lifecycle/:id` (`identity.role.grant`) runs `applyLifecycle` — **it decides, the caller
  applies**. A **mover REPLACES scope**: the old roles/branches are removed in the same act (nobody ends up
  able to raise a stock adjustment AND settle the till it hides in) and sessions close so the new scope takes
  effect now. A **leaver is blocked until their owned open items are reassigned** (an unapproved PO owned by
  nobody never gets approved), then fully revoked with sessions closed and a **priority sync** (§31). The
  caller is the approver and can never be the requester (`self_service_access_refused` `422`, §28). Returns
  what the person holds afterwards, what was removed, whether sessions close, and any blockers to clear
  first. A pure decision — nothing is written; the role-grant change goes through the identity grant events.
- **Price change (API-02):** draft → **approve (separate approver)** → effective-dated
  publish into the signed edge price pack.
- **Duplicate merge (API-02, M03-FR-04 §28):** detect suspected duplicates
  (`POST /v1/catalogue/products/duplicates`) → **propose** a merge
  (`POST /v1/catalogue/merges/:id`, `catalogue.merge.propose`) → **approve by a different
  person** (`POST …/decision`, `catalogue.merge.approve`) → a reversible **link**
  (`MergeProposed`→`MergeApproved`→`MergeReversed`), never a deletion (hard rule #2);
  `GET /v1/catalogue/products/:id/canonical` resolves where a merged id now points.
- **Pack hierarchy + UOM conversion (API-02, M03-FR-02):** `POST /v1/catalogue/products/:id/pack`
  **defines** a product's pack ladder (unit → inner → case) behind the tested `validatePack`
  gate — an inexact pack is refused at definition time, before it can make a stock figure wrong.
  `GET …/pack/convert?level=&quantity=&direction=to-base|from-base` converts exactly and
  reversibly (a case of 24 ↔ 24 singles). Event-sourced (`PackHierarchyDefined`, latest-per-product).
- **Coupon redemption (API-06, M17-FR-02, offline-first):** a lane redeems a coupon against its **cached**
  redemption set (single-use enforced offline); on sync `POST /v1/loyalty/coupons/:code/redemptions/:id`
  re-checks against the **whole** cloud history, so a cross-lane double-use is refused `409` (a visible
  conflict, hard rule #10) and a same-id re-sync is idempotent. Personalised offers (`/v1/loyalty/offers`)
  need both profiling + marketing consent (M16-FR-02); referrals pay only on a qualifying purchase.
- **Data-subject rights (API-06, M20-FR-04 · DPDP):** the customer app raises a request; the shop then
  works it on the cloud, gated `privacy.request.manage`. `POST /v1/privacy/data-requests/:id` **raises**
  (access/correction/export/erasure) → `…/verification` **verifies who asked** — the gate the module turns
  on: fulfilling **unverified** is how one person reads or deletes another's account (`422 not_verified`).
  `…/fulfilment` hands back the held data for access/correction/export; an **erasure** instead needs
  `…/erasure-plan` (verified-only), which produces the honest, category-by-category answer — **erase**
  what can go, **minimise** (strip the person from) audit evidence that can never be deleted (hard rule
  #6), **retain** what the law requires, each named with the statute and the date it can finally go — and
  the customer statement that says so rather than letting them believe they were fully erased (P-08).
  `GET …/overdue` surfaces the SLA-breached queue worst-first, calling out the unverified-and-overdue.
  Append-only (`DataSubjectRequestRecorded`) — an auditor reads exactly what was asked, verified and done.
- **Requisition → RFQ → quote comparison (API-03, M06-FR-02):** a buyer **raises a requisition**
  (`POST /v1/purchase/requisitions/:id`, `purchase.order.propose`) in one comparison currency, records
  the **quotes** suppliers send (`POST …/quotes/:quoteId`, latest-per-id), and reads a **like-for-like
  comparison** (`GET …/comparison`) from the tested `compareQuotes` — **cheapest + fastest per line and
  overall**, an incomplete or different-currency quote shown but never ranked, only a quote covering
  every line totalled (lead time = the slowest line). A chosen quote becomes a PO through the approved
  issue path (§28). Event-sourced (`RequisitionRaised`, `QuoteRecorded`).
- **Purchase order (API-03, M06-FR-01/02/04 §28):** a buyer **proposes** a PO
  (`POST /v1/purchase/orders/:id`, `purchase.order.propose` — the requisitioner is the
  authenticated user) → a **different person approves and issues** it
  (`POST …/approval`, `purchase.order.approve`) behind the tested `decide`/`issuePurchaseOrder`,
  which refuse a self-approval (`409 proposer_cannot_approve`) and a **blocked supplier**
  (`409 supplier_blocked`; the hold is its own `POST /v1/purchase/suppliers/:id/block-status`,
  latest-wins). The **open commitment** (`GET /v1/purchase/commitments`) is computed from the
  issued POs by `computeOpenCommitment` — *not known* until a PO exists, a real number after. An issued
  PO can be **amended** (`POST …/amendments`, keeps the prior lines on the ledger), **cancelled** in part
  (`POST …/cancellations`), and **received against** (`POST …/receipts`) — the open commitment nets
  ordered − received − cancelled and reconciles to receipts.
  Event-sourced (`PurchaseOrderProposed`→`PurchaseOrderIssued`, then `PurchaseOrderAmended` /
  `PurchaseOrderCancelled` / `PurchaseOrderReceiptPosted`, `SupplierBlockStatusSet`).
- **Supplier scorecard (API-03, M06-FR-03):** a delivery OUTCOME is recorded per PO
  (`POST /v1/purchase/suppliers/:id/receipts/:poId`, `purchase.performance.record`) and a contract
  recorded (`POST /v1/purchase/contracts/:id`, `purchase.contract.manage`). `GET …/scorecard` runs the
  tested `scoreSupplier` — fill rate, on-time, lead-time **reliability** (the spread, not the mean),
  price adherence, quality, weighted overall, worst signal first; `not_rated` where there is no
  evidence. `GET /v1/purchase/contracts/alerts` runs `reviewContracts` — expiring/expired/**unapproved**
  worst-first. Event-sourced (`SupplierReceiptRecorded`, `SupplierContractRecorded`).
- **Supplier rebate (API-03, M06-FR-03 · M23):** a rebate **scheme** is recorded
  (`POST /v1/purchase/rebate-schemes/:id`, `purchase.contract.manage`); an **accrual** for a measured
  period (`POST …/accruals/:accrualId`) runs the tested `accrueRebate` — nothing accrues below the
  threshold (and it says how far short), a growth scheme measures against its baseline, and the
  **outstanding** (accrued − received) is the money **earned and not yet claimed**
  (`GET …/accruals` totals it). Event-sourced (`RebateSchemeRecorded`, `RebateAccrued`).
- **Import job history & supplier data-quality (API-03, M30-FR-04 · P-08 · hard rule #6):** the control
  that catches the quiet, expensive failure — a supplier's file arriving with 12% of rows rejected every
  week for a year, where the operator fixes the dozen rows by hand so no alert ever fires.
  `POST /v1/purchase/import-jobs/:id` (`purchase.import.record`) records an import outcome append-only —
  **refusals kept alongside successes** (`ImportJobRecorded`), because a history of only the successes is
  how a file that fails half the time looks perfect. `GET /v1/purchase/import-jobs` (`purchase.import.read`)
  runs `jobHistory` (newest-first, refusals included). `GET /v1/purchase/import-quality/:sourceId` runs
  `scoreSource` — the score belongs to the **source, not the operator**: accepted %, a band, the ranked
  **reasons with the action for each** (a count is a dashboard, a reason is one email), the **direction**
  beside the level (so a supplier improving from unusable to poor is not called a failure twice), and the
  quiet cost as **`annualFixHours`** ("52 hours a year retyping their rows"); too few rows refuses to score
  (`not_enough_data`). `GET /v1/purchase/import-quality` runs `compareSources` — deliberately a **list of
  people to talk to**, worst-first, clean sources left alone. Pure reads over the recorded jobs; event-sourced, restart-safe.
- **Supplier-portal probe detection (API-03, M24-FR-04):** the portal is the one place a party OUTSIDE
  the business acts on the system, so **every submission outcome is audited** — refusals as loudly as
  successes (`PortalActionAudited`, hard rule #6). A supplier submitting against **another** supplier's
  order (`not_your_order`) is auto-flagged a security event; `GET /v1/supplier-portal/probing?threshold=`
  (`supplier.portal.review`) runs the tested `findProbing` over the tenant-wide audit trail — a buyer's,
  per-tenant view of who is **trying doors** (one refusal is a mis-click; a pattern of them is not). A
  no-grant refusal is audited but is not probing; a retried mis-click collapses to one attempt.
- **Operational health & alerting (API-11, M35-FR-03/04 · §32):** `POST /v1/platform/operational-health`
  (`platform.health.read`) runs the tested `checkHealth` over the evidence the edge reports — sync lag,
  outbox depth, dead letters, catalogue/backup age, integrations — and holds two lines that matter more
  than any number: **`canTrade` is separate from `status`** (a cloud outage degrades the status but the
  store keeps selling — P-01; only a lane that cannot record locally must stop), and **a missing signal
  is `unknown`, never `ok`** (P-08 — the absence of a heartbeat is not a heartbeat). `raiseAlerts` then
  turns findings into **owned** alerts, each routed to a named person with a §32 acknowledgement deadline.
  A pure compute — distinct from the liveness probe at `/v1/platform/health`. Escalation-over-time (a
  stateful raise-now-escalate-later concern) is a named follow-on.
- **Risk register & quality-gate blocking (API-11, M34-FR-04 · §28):** the register the governance model
  turns on. `POST /v1/compliance/risks/:id` (`compliance.risk.manage`) records a risk append-only; a
  `status` of `accepted` is **refused** on this route — acceptance is not a quiet edit. `POST …/acceptance`
  accepts it in the **caller's own name** (never a payload) with a **mandatory written rationale** (an
  unjustified acceptance is refused `422`). `GET /v1/compliance/gates/blocked` (`compliance.risk.read`)
  runs `blockedGates` — an **open, critical** risk blocks the quality gates it is registered against, and
  the only way past is to accept it, not to ignore it; an accepted or mitigated risk does not block.
  `GET …/gates/:gate/can-pass` runs `gateCanPass`. Append-only (`RiskRecorded`) — register-then-accept is
  two facts, nothing overwritten (hard rule #2).
- **Incident / remediation / control-health / attestation (API-11, M34-FR-04 follow-on · §28):** the
  registers that answer, the moment something goes wrong, WHICH control should have stopped it, WHAT is
  being done and WHO owns it, and whether anyone ever CHECKED the control works — and **every link is
  mandatory**, because a register whose links are optional degrades into a list nobody reads.
  `POST /v1/compliance/controls/:id` registers a control; `POST …/incidents/:id` (`recordIncident`) records
  an incident that **must name a registered control** (`incident_links_to_no_control` `422` otherwise);
  `POST …/remediations/:id` records a fix that **must name a registered incident** AND — the tested
  `recordRemediation` insists — **an owner AND a due date** (`remediation_needs_owner_and_date` `422`);
  `POST …/attestations/:id` records a **dated** check made in the **caller's own name** against a
  registered control (a tick with no date, or nobody's name, is not evidence). `GET …/controls/health`
  runs `controlHealth` — per control: has it failed (incidents), is the fix late (overdue remediations),
  and has anyone checked it lately (**never-attested or stale → `needsAttestation`**, an untested control
  being an assumption not a control); `GET …/remediations/overdue` runs `overdueRemediations`, the
  follow-through report. All append-only and event-sourced (`ControlRegistered` / `IncidentRecorded` /
  `RemediationRecorded` / `ControlAttested`), gated `compliance.risk.manage` (write) / `.read` (reports).
- **Service desk — cases & SLA clocks (API-06, M21-FR-04 · P-03):** control by exception — a case
  breaching its SLA must surface, not sit amber in a queue. `POST /v1/service/cases/:id`
  (`service.case.manage`) opens a case; `…/first-response` stamps the human reply; `…/resolution` resolves
  it, carrying the **waiting-on-customer minutes** the resolution clock does not count against the shop.
  `GET …/sla` (`service.case.read`) returns **both clocks** — FIRST RESPONSE (the wait the customer feels;
  does not pause) and RESOLUTION (pauses while waiting on the customer, so a slow customer is not recorded
  as the shop's breach). `GET /v1/service/cases?breached=true` is the **exception queue**. Append-only
  (`ServiceCaseRecorded`). **CSAT + the manager's report are wired too:** `POST /v1/service/cases/:id/satisfaction`
  (`service.case.manage`) records a customer's score (1–5) on a **resolved** case — a score on an open case
  is refused, because that is a complaint in another field, not satisfaction; append-only. `GET /v1/service/report`
  (`service.case.read`) runs the tested `serviceReport` over the real cases + recorded scores and returns
  CSAT **with its response rate** — a high average from six replies out of four hundred cases is six people,
  not a satisfaction score, and the report says so.
- **Service-desk compensation (API-06, M21-FR-03 · §28):** money leaving the business, decided by the
  person the customer is shouting at — so `POST /v1/service/cases/:id/compensation` (`service.case.manage`)
  runs `grantCompensation` with the controls not optional: a **mandatory reason** even within authority
  ("goodwill" explains nothing three months later); above the granting agent's **authority limit** a
  **separate** approver is required (`needs_approval`) and the agent **cannot approve their own**
  (`self_approved`); an **absolute tenant ceiling** above which it is a management decision
  (`exceeds_policy_cap`). A granted one is an **append-only** `CompensationGranted` (a payment is a ledger,
  hard rule #2); `GET …/compensations` totals what left.
- **Service-desk AI drafts — a named human sends (API-06, M21-FR-03 · P-05 / hard rule #5):** an AI may
  *draft* a reply to a customer; a **person** sends it. `POST /v1/service/cases/:id/drafts/:draftId`
  (`service.case.manage`) records a draft **always unapproved**, and it must **cite the case evidence** it
  is based on so the approver has something to check it against. `POST …/drafts/:draftId/decision` runs
  `approveDraft` — **the only path by which a draft becomes sendable; there is deliberately no send route in
  the module** — attributing the reply to the **logged-in caller, never a model**. A draft with no evidence
  or an **empty edit** is refused `422 draft_not_approvable`; an **edit is recorded as an edit**
  (`edited_and_approved`) so the shop can see whether the model is helping or generating work; a
  **rejection** is a recorded human decision (`200`, not sendable), an approval/edit `201`. `GET …/drafts`
  (`service.case.read`) lists each draft with its human decision. Append-only (`AiDraftRecorded`,
  `DraftDecided`).
- **Campaign send-gate (API-06, M21-FR-01 · PRV/DPDP · P-02):** a campaign is the one click that can
  harm thousands of people at once and cannot be recalled, so the gate is at the SEND, PER RECIPIENT.
  `POST /v1/service/campaigns/:id/plan` (`customer.campaign.send`) runs `planCampaign`, and for each
  audience member it consults the shop's OWN consent ledger — `mayWeSend`, the SAME record the rest of the
  system holds (P-02), not a list pasted into the request. Consent to SMS is not consent to email; a
  marketing send needs marketing consent; a withdrawal reads as a withdrawal and an absent record as
  no-consent (silence is never agreement). An unapproved template, or a promotion smuggled into a
  transactional message (a route around consent), **blocks the whole campaign** — no partial send. The
  **excluded count is always returned, grouped by reason**, so the check stays defensible when reach
  shrinks. Nothing is SENT here (the transports are deployment steps, EX-04/05); the decision is recorded
  as an **append-only** `CampaignPlanned` log — **counts only, the recipient lists are not stored (PRV)** —
  read at `GET /v1/service/campaigns/plans` (`customer.campaign.read`).
- **Campaign journeys & honest attribution (API-06, M21-FR-02 · PRV · P-08):** two disciplines that
  separate a real measurement from a flattering one. `POST /v1/service/campaigns/journeys/:kind/candidates`
  (`customer.campaign.send`) runs `findJourneyCandidates` — a trigger inside the **quiet period** is held
  back (a message minutes after someone put their phone down is surveillance, not a nudge), a stale one as
  too-late, an already-completed customer skipped, and only triggers of the path kind are weighed.
  `POST /v1/service/campaigns/:id/attribution` (`customer.campaign.read`) runs `measureCampaign` — only
  orders placed **after** the send, **inside the window**, by people who **received** it count, and the
  **control group's** conversion is reported beside the campaign's, because "recovered" customers who were
  coming back anyway are a cost dressed as a win (with no control it is called activity, not uplift). Both
  are pure computes — nothing is sent (transports are EX-04/05).
- **Customer segmentation & value ranking (API-06, M16-FR-02 · PRV/DPDP):** two truths this keeps.
  `POST /v1/customer/segments/audience` (`customer.segment.read`) builds a **consent-gated** campaign
  audience — **consent is two permissions**: analysing a customer (profiling) is not messaging them
  (marketing), so a marketing audience needs **both**, and the **excluded-for-consent count is always in
  the answer** (never a silently smaller list somebody later "fixes" by dropping the check). A `service`
  purpose builds regardless — answering a customer's own complaint is performance of the contract, not
  marketing. `POST …/value-ranking` runs `rankByValue` — **by margin, not revenue** (both stated, because
  a ₹50k cigarette customer at 4% is worth less than a ₹20k fresh customer at 30%); a non-profiled
  customer is left out. A pure compute over the facts supplied — it writes nothing.
- **Customer duplicate detection (API-06, M16-FR-01 · P-02 · P-08 · §28):** the same person enrolls twice —
  at the till on Tuesday, on the app on Friday — and their spend, loyalty and consent split across two
  records. `POST /v1/customer/duplicates` (`customer.segment.read`) runs `detectDuplicateCustomers` — a
  shared **VERIFIED** phone/email is a high-confidence **`merge_candidate`** (still governed), a shared
  unverified contact or a matching name is low-confidence **`review`**, ordered high-confidence first. **The
  rule that matters is what is NOT done: nothing is ever auto-merged** — a merge fuses two real people's
  records and is a governed, reversible, audited act by a person (§28); this only proposes. A stateless pure
  compute over the caller's candidate set, PII compared on normalised values only.
- **Owner drill-through & KPI comparison (API-10, M29-FR-02 · NFR-15 · §28):** the owner sees a figure and
  asks "show me". `POST /v1/reporting/drill` (`owner.kpi.read`) runs `drillThrough` — it returns the
  transactions behind a KPI **and reconciles them to the headline**: when the rows do not add up it says so
  **LOUDLY** (`reconciles:false`, a `discrepancy` that reads `DO NOT ADD UP`), because a drill that looks
  right and is wrong is worse than none (P-08). **Scope is enforced** — rows in branches the viewer cannot
  see are withheld, the shown total is recomputed, and the viewer is **told a figure exists they cannot
  see** (`withheldCount`/`withheldTotalMinor`), never handed a silently smaller list. `POST
  /v1/reporting/compare` runs `compareBy` — ranks a metric across a dimension with the **unattributed rows
  grouped, never dropped**, and the rows must reconcile to the total or they are not published. Every drill
  is logged (who reached which transactions) as an **append-only** `DrillAudited`, read at
  `GET /v1/reporting/drill-audits` — restart-safe (§28). Pure reads/computes — they write nothing but the
  audit.
- **Packing & dispatch (API-08, M19-FR-02 · D09 · M10-FR-02):** the two moments between the shelf and the
  van — one where a mistake is free to catch, one where it is expensive to make.
  `POST /v1/fulfilment/orders/:id/pack` (`fulfilment.pack.record`) runs `packOrder` — a **weighed line's
  final price is captured at pack** in exact integer minor units from the packed grams (never a guess at the
  doorstep); a chilled/frozen/raw-meat line with **no temperature, or one out of range, does not go on the
  van**; a crate that mixes incompatible handling is **refused, not warned**, while the rest of the order
  still packs; and the pack is **recorded** (`OrderPacked`) so it cannot be re-supplied later.
  `POST …/:id/dispatch` runs `dispatchOrder` over the **recorded** pack — the manifest is **derived from what
  was packed, never from what was ordered** — refusing `409` an unsealed crate (`unsealed_crate`), a short or
  refused line the customer has not been told about (`unresolved_lines`), or an unpacked order
  (`no_pack_recorded`); `dispatchedBy` is the authenticated caller, recorded `OrderDispatched`.
  `GET …/:id/pack` and `GET …/:id/manifest` read them (`fulfilment.pack.read`). Restart-safe.
- **COD reconciliation (API-08, M19-FR-04 · hard rule #3 · P-08):** cash-on-delivery is money the driver was
  carrying, and shift end is the only point at which the person who had it is still identifiable.
  `POST /v1/fulfilment/cod/reconcile` (`delivery.run.read`) runs `reconcileCod` — matches COD collected **to
  the paisa** per order against what was expected, and every mismatch is an **owned, valued exception**:
  `short`/`over` (with the variance), `uncollected` (expected, nothing came) or `unexpected` (collected,
  nobody expected it) — never a silent loss, and it feeds finance reconciliation (M23). **COD is cash/UPI
  only — a card method is refused `422`** (`card_data_not_allowed`), because the shop never holds card data
  (hard rule #3). A pure compute — the caller supplies both sides, nothing is written.
- **Finance reconciliation (API-09):** import bank/gateway statements → match →
  `ReconciliationExceptionRaised` / `…Resolved`; **period close is blocked until control
  totals validate** (QG-07) → `PeriodClosed` / `PeriodReopened`.

## 4. Named domain events (§30.2, confirmed in Store-Core specs)
`SaleCommitted` · `TenderAuthorized` / `TenderUncertain` / `TenderSettled` ·
`InventoryMoved` · `InventoryAdjusted` · `PurchaseOrderProposed` / `PurchaseOrderIssued` ·
`SupplierBlockStatusSet` · `PurchaseOrderAmended` / `PurchaseOrderCancelled` / `PurchaseOrderReceiptPosted` ·
`SupplierReceiptRecorded` / `SupplierContractRecorded` · `RebateSchemeRecorded` / `RebateAccrued` ·
`RequisitionRaised` / `QuoteRecorded` · `ConcessionContractSet` / `ConcessionSaleRecorded` / `ConcessionDepositMoved` ·
`SecretStateRecorded` · `OrgNodeSet` / `OrgGstRegistered` ·
`ReconciliationExceptionRaised` /
`ReconciliationExceptionResolved` · `PeriodClosed` / `PeriodReopened` ·
`MigrationTotalSigned` / `MigrationExceptionResolved`.
*(Additional events are defined per module as each is expanded — this list grows with the
build; it is not invented ahead of the roadmap.)*

## 5. Contracts & portability (P-06)
- Contracts are **versioned schemas** in `packages/contracts/` (request/response + event
  payloads), the single source both edge and cloud build against.
- Documented data models and **exports** for portability; a **connector SDK** (M32) wraps
  Tally, payment providers, GST, messaging (WhatsApp), logistics and hardware behind
  versioned, idempotent adapters with retry + dead-letter.

## 6. Deferred
Full endpoint specs and OpenAPI/event schemas are produced per domain as each release is
built. R4/R5/R7 domains (Customer/CRM, OMS/Fulfilment, AI) are named at family level here
and expanded when their release is reached.
