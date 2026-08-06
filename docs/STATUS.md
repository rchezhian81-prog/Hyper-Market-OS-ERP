# SRE Retail OS — Project Status

_Read this file, together with `CLAUDE.md`, at the start of every session (prompt R6)._
_Update it at the end of every session (prompt R10). This is what stops the project drifting._

Last updated: 6 August 2026 (session: the buyer's screen, offline shells switched on for real, products and prices, shelf addresses, the pick zone order, and merchandising and space)

---

## Where we are, in one paragraph
**Stages 0–10 are complete and their gates are passed.** Stage 5 (engineering foundation)
passed on a real destroy-and-restore; Stage 6 (offline/sync slice) on internet-off,
duplicate, reorder and recovery tests; Stage 7 (product/pricing/purchase) on one delivery
walked from dock to payment; Stage 8 (inventory, warehouse, quality) on physical-to-system
and recall proof; Stage 9 (POS, returns, cash office) on end-of-day and refund controls; and **Stage 10
(finance, Tally, owner control) passed today on the books reconciling**. That completes
**M01–M15, M29 and M33–M35 — the entire store-facing core plus the owner's control
surface**: 94 of the 144 requirement rows built, **1,209 automated tests** plus **35
integration tests against real PostgreSQL 16.13**, and written evidence for every gate in
`docs/evidence/`. **Stage 11 (migration rehearsal) is blocked on EX-02** — the previous
system's export rights — which is a letter to send, not code to write, so the build has
moved to **Stage 14 (customer commerce)**, then **Stage 15 (fulfilment and delivery)**, and
then **Stage 16 (enterprise modules)**, **Stage 18 (multi-tenant platform and the innovation
wave)**, and now **Stage 19 (operate and improve)** — all five **COMPLETE with their gates
passed**. **Every module M01–M36 now has its foundation built: 143 of the 144 requirement rows
built, 1 partial, and NONE unstarted**, with **1,867 automated tests** plus **116 integration
tests** against real PostgreSQL 16.13 and written evidence for all eleven gates. The single
remaining partial (M02-FR-01) is partial **on purpose**: credential storage and MFA enrolment
belong to the deployment identity provider, and closing the row would mean holding credentials
in this codebase, which hard rule #4 forbids. **Stage 17 (governed AI agents) is complete too**, built entirely
against a provider-neutral simulator by owner decision of 4 August 2026. And **Stage 11
(migration) has now been rehearsed end to end against a synthetic legacy dataset** — MG-01…MG-12,
ten kinds of realistic damage planted and every one found by identity, with zero findings on
clean data — so **every code stage in the roadmap is finished, Stage 11 included.** What remains
is the hosting decision (OB-02, owner-deferred), the pre-pilot integration gate where a live AI
provider is chosen, and the in-store activities that need the store itself. **EX-02 is closed**
— the owner decided on 7 August 2026 that we extract our own data ourselves rather than wait for
a vendor with no reason to help us leave (OB-06).

---

## Current stage
**EVERY CODE STAGE IS COMPLETE. Stages 0–11 and 14–19 all passed their gates.**

**Stage 11 passed today** on `tests/integration/the-old-shop-arrives-whole.test.ts` (23
assertions, 53 controls, real PostgreSQL 16.13, three runs green) — the whole MG-01…MG-12
pipeline rehearsed against a **generated legacy dataset with ten kinds of realistic damage
planted in it**. Every planted fault found **by identity, in exactly the planted quantity**, and
**zero findings on clean data** — the control that makes the rest mean anything. Opening state
banked as append-only events in a real database; the cutover refused GO on a rollback that was
designed but never performed. Evidence in
`docs/evidence/stage-11-the-old-shop-arrives-whole.md`.

Building it caught a real defect in itself: the duplicate detector first reported **195 findings
against 14 planted, and 182 on a dataset generated clean.** Two separate causes — a degenerate
name generator, and a detector treating an identical name alone as certainty in a hypermarket
that also runs a cafe. Both fixed; both numbers are now exact.

**Stage 17 passed yesterday** on `tests/integration/ai-proposes-people-decide.test.ts` (12
assertions, 32 controls, real PostgreSQL 16.13, three runs green) — built entirely on a
**provider-neutral simulator with no AI account**, per the owner's binding decision of 4 August
2026. The hardest case in the suite: a customer message steers the model into proposing a
₹50,000 refund and a customer export, **the model obeys**, and neither reaches the shop —
because neither tool was ever granted. Evidence in
`docs/evidence/stage-17-ai-proposes-people-decide.md`.

**What is left is not code.** EX-02 (a letter), OB-02 (hosting), the pre-pilot integration gate
where a live AI provider is chosen and the 8 `liveProviderGate()` questions are answered, EX-13
(a penetration test), and the 55 store activities in `docs/registers/uat-calendar.md`.

Stage 3 (UX & design system) and Stage 4 (architecture + data dictionary + infra design) are
done for Store-Core (R2); Stage 5 has built 59 tested foundation units, five
**persistence-layer** units incl. the PostgreSQL connector + migration runner, and the **first
app shells (POS + Owner + Web ERP + Picker + Delivery)** with the build pipeline, barcode
scanning, the catalogue snapshot builder, receipt printing, template-driven import, domain
export, tamper-evident audit evidence, goods-in with the three-way match, state-aware stock
availability, the M03 product master, the compliance registers, the org hierarchy and branch
lifecycle, named accounts with the access lifecycle, the POS lane guards, in-store
production, and the store-edge sync agent — 806 tests.
**D3/D4/D5/D8 were answered on 2 Aug 2026** (see
`docs/registers/decisions.md` / ADR-0001), so the coding HOLD that depended on them is
lifted and **Stage 5 (foundation) can begin**. The remaining inputs before the M1
spec-freeze / store-specific build are the remaining Stage 1 store facts (**AVR-12 is now
closed — cafe only, OB-04**) and the trading-day cut-off — gathered in the store (A-11). Running autonomously per
**standing owner instruction (2 Aug 2026): "carry on always, don't wait for my approval
unnecessarily."** Keep building and pushing tested work; stop only for genuine blockers that
truly need the owner or the store (the Stage 1 facts, a hosting-vendor commitment) — not for
routine progress.

**Product direction (owner, 2 Aug 2026 — OB-01 / ADR-0003):** SRE Retail OS is a
**commercial, multi-tenant product** sold to many retailers, not only for SRE's own use —
"make everything choose-able". `tenant` is the top isolation boundary; **no store-specific
value is hard-coded** (all per-tenant configuration); **SRE is tenant #1**. The Stage-5
foundation already works this way (parameterised trading-day/tax rules, versioned config,
configurable roles/numbering/currency), so this is mostly formalisation, not rework.
The ADR-0003 follow-ups are **done**: the `Tenant` entity + `tenant_id` scoping (data-model
standard column, so it covers every table), the per-tenant **entitlements** engine
(choose-able modules) and per-tenant **settings** catalogue (`packages/tenant`), and the
**threat model** now treats cross-tenant access as a critical defect. The full commercial-
SaaS features (subscription/billing, white-label branding, self-serve signup) remain **M36
(R8)** unless prioritised. The questionnaire is the **tenant Store Setup Profile**.

- **Stage 3 done:** design system, usability test script, and screen specs for **all 14
  §27 role surfaces** (`docs/design/`).
- **Stage 4 done:** architecture overview, data model (§29), API & event catalogue (§30),
  offline-sync design (§31), migration/cutover design (§34), and threat & privacy model
  (§35) — in `docs/architecture/`, `docs/api/catalogue.md` and `docs/security/`; **plus the
  field-level data dictionary** for all six Store-Core domains (`db/data-dictionary/`:
  identity-platform, catalogue-pricing, inventory, purchase-supplier, pos-cash, finance).
  All apply the §19 baseline (ADR-0001); nothing invented beyond Store-Core. All 13 tests
  pass; the guardrails scope to code, not docs.
- **Open gate:** QG-02 human usability testing with real staff
  (`docs/design/usability-test-script.md`) still needs the store — it runs whenever staff
  are available.
- **Stage 4 also done:** **infrastructure & deployment design**, originally drawn to a
  ₹20,000/month envelope and now **re-based on the owner's binding decision of 4 August 2026:
  D3 = ₹15,000/month platform runtime** (hosting, storage, backups, messaging, monitoring and
  normal AI usage; external developer/support retainers shown separately and never silently
  included) (`docs/architecture/infrastructure.md`) with hosting **ADR-0002** (Proposed,
  pending owner vendor/commercial validation).
- **Stage 5 (foundation) — BEGUN** (`packages/contracts/`, all with tests; full `pnpm
  check` green — typecheck + lint + secret-scan + **45 tests**):
  - `Money` value primitive (§29.1 / M01-FR-02) — exact minor units, never a float, exact
    splits with no lost paise (21 tests).
  - Shared vocabularies & §27.1 states — tender/sale/stock/approval/lifecycle/connection
    with runtime guards (5 tests).
  - `DomainEvent` envelope (§30.2 / §31.1) — validated, idempotency-keyed (6 tests).
  - `Quantity` value primitive (UOM-aware, exact, never a float) — 9 tests.
  - `Rate` value primitive (exact basis points; applies to Money with explicit rounding via
    BigInt) — the exact %-maths for pricing (M05) and tax (M23) — 9 tests.
  - **First composition brick:** line pricing (`packages/pricing/`, M12/M05/M23) —
    `priceLine` composes Money × Quantity × Rate into gross/discount/net/tax/total, exact to
    the paisa (weighed goods included), plus `sumLines` for whole-bill totals; backed by a
    new shared `scaleMoney` primitive in `contracts` (exact BigInt fractional multiply). 7 tests.
  - `pnpm check` green: typecheck + lint + secret-scan + **806 tests**. Value-object
    operations are namespaced in the barrel (`MoneyOps`/`QuantityOps`); types export flat.
  - **Template-driven import — DONE (3 Aug 2026). This is the roadmap's own top priority
    (audit A-03: the store's #1 daily pain — the 80+ line supplier invoice typed by hand).**
    `packages/import/` is the **validate → preview → approve → commit** pipeline, where
    **nothing changes until a human has seen exactly what would change**:
    - a proper **RFC-4180 parser** — quoted fields, escaped quotes, **commas and newlines inside
      values**, CRLF, BOM, TSV. A naive `split(',')` silently mangles real supplier files; this
      one **reports** a malformed file (wrong column count, unclosed quote) instead of shifting
      cells;
    - **per-row errors with the source line number** and a plain reason — missing mandatory
      field, non-numeric amount, disallowed value, **orphan reference** — never silently skipped;
    - **duplicates**: the same key twice in the file is a blocking error naming the other line; a
      key that **already exists** goes to **review, never auto-merged** (M03-FR-04);
    - **financial imports must reconcile** — the declared control total must equal the sum of
      the lines, or the import is refused (M30-FR-03);
    - **approval by a different person than the uploader** (§28), and **atomic commit**: one bad
      row means **none** of the good rows are applied, so a half-imported invoice cannot exist.
    **Acceptance proven:** a generated **80-line supplier invoice** (with commas inside product
    names) parses, validates and reconciles **in one go**; move the declared total by ₹1 and it
    is refused. 22 tests.
  - **Domain export — DONE (3 Aug 2026). The other half of "your data is yours".**
    `packages/export/` gets **any authorised domain out** in an **open format** — CSV plus a
    **machine-readable schema**, so the file explains itself to a spreadsheet or to whatever
    system comes next (NFR-12 / OD-09 / P-06: **no proprietary-only route to your own data**).
    Three controls stop an export from becoming a leak:
    - **permission** — the same default-deny RBAC check that guards the action guards its
      export; a user without it gets **nothing** (P-04);
    - **branch scope** — a branch manager exports **their** branch, never another's (§28);
    - **classification** — personal/payment columns are **redacted, not dropped** (the column
      stays, so the file's shape never lies), unless the user also holds `export.sensitive`;
    and every export returns an **audit record** — who, what, when, how many rows, and exactly
    which columns were redacted. **Proven, not asserted:** an export is fed **back through our
    own importer** and comes out identical — headers, rows, and a customer name containing a
    comma all intact. 8 tests.
  - **Audit & compliance evidence — DONE (3 Aug 2026). M34 is an R1 requirement and was
    the largest unbuilt one.** `packages/audit/` is the tamper-evident memory of the
    system — the thing you reach for on the one evening it matters:
    - every sensitive action records **who, what, when, where, before and after**, plus the
      reason and the approval that authorised it, and whether it was **captured offline**;
    - **no one can edit or delete the log — not an administrator, not the owner.** The API
      has no update, no delete, no clear. That absence *is* the control, and a test asserts
      the absence rather than trusting a comment;
    - **each record is sealed to the one before it.** Edit a record straight in the database,
      behind the code, and `verify()` names the exact record where the chain breaks — and
      reports **every** break, not just the first. Remove one from the middle and it reports
      the gap. We do not claim tampering is impossible; we guarantee it is **detectable**;
    - **an action is reconstructable from evidence alone** (NFR-15) — "how did this price get
      here?" is answered from the trail, never from a screen someone can change;
    - **retention plans, it never deletes** (hard rule #6). Privacy says don't keep personal
      data for ever; evidence says never destroy what an audit may need. So the module
      produces a **list for a human to decide on**, with the reason every other record stays.
      A **legal hold beats the retention date**, statutory (GST/company-law) records are never
      proposed, and anything with **no policy is kept** — silence never means discard;
    - an **evidence pack** for an auditor or inspector names who took it and when, carries the
      chain hash so they can prove it matches the trail, and states plainly whether the source
      verified at export time.
    The built-in hash is dependency-free and honest about itself: it catches corruption and
    casual editing but is **not** a cryptographic seal — a deployment injects SHA-256 through
    the `Hasher` port without the engine changing. 19 tests.
  - **Goods-in: capture, discrepancy and three-way match — DONE (3 Aug 2026).** The back
    door of the shop is where most of the money is actually lost, not the till, so nothing
    now becomes sellable stock until it has been checked (`packages/receiving/`):
    - **it refuses what cannot be trusted**: a batch-tracked item with no batch or no expiry
      (you cannot recall what you cannot identify), a cold-chain item with no recorded
      temperature, and **already-expired stock is rejected at the door** — not written off
      three weeks later;
    - **damaged, QC-failed or warm-on-arrival stock goes to quarantine** — counted and
      present, but **not available to sell**. That is the acceptance test the roadmap asks
      for, and it is asserted directly;
    - **short, excess and MRP differences become valued, owned exceptions** — "10 units short,
      ₹500.00, credit note due" rather than a mystery in the stock count. A small
      over-delivery passes; **beyond tolerance it needs a second person** (§28). Every
      tolerance is per-tenant configuration, never a hard-coded number;
    - **the three-way match** (purchase order ↔ goods receipt ↔ supplier invoice) keeps the
      roadmap's blunt rule blunt: **no payment on an unmatched or out-of-tolerance invoice
      without approval, and the person who received the goods can never approve the variance
      on them**. Charged above the agreed cost, invoiced for more than arrived, invoiced for
      something never ordered, invoiced for goods that never came — **payment blocked**, with
      the variance valued and the worst one named. Goods received but not yet invoiced are
      reported without blocking, so the period does not close understating cost;
    - **landed cost** spreads freight and duty across the lines **by value, to the paisa**,
      remainder distributed, not dropped. Valuation that ignores freight understates cost and
      overstates margin — the shop then believes it is making money it is not.
    23 tests.
  - **Stock states, availability and stock health — DONE (3 Aug 2026).** `packages/stock/`
    kills the single most expensive lie in retail software: **one "quantity on hand"
    number**. The stock is in the building so the report says **12** — but 4 are reserved
    for an online order, 3 are quarantined from a damaged delivery, 2 expired yesterday and
    3 are still on a van from the other branch. The honest answer is **0**, and a system
    that says 12 oversells, disappoints a customer and hides a loss.
    - stock is held **by state**, and availability is derived from it. `explainAvailability`
      says it in words: *"0 available — 4 reserved, 3 quarantine, 3 damaged, 2 expired not
      sellable"*;
    - a movement is a **transfer between states**, so the model checks itself — quantity is
      conserved everywhere except where it enters (a supplier receipt) or leaves (a sale or
      write-off) the business. The position is **projected, never stored**, so it cannot
      drift and replaying gives the same answer;
    - **two rules no tenant can switch off**: expired and quarantined stock are never
      sellable. Everything else is choose-able — a damaged-goods clearance bin can be made
      sellable, and negative stock is either **blocked** (default) or allowed but raised as a
      **visible exception**, never silent;
    - tracked per **product × location × batch**, because that is the level a recall, an
      expiry and a branch transfer actually work at;
    - **stock health** answers the owner's real question — is the money working or dying?
      **Ageing** (how long the cash has been asleep, valued, with each bucket's share),
      **turns** and days of cover, **GMROI** (rupees of margin per rupee of stock — below
      1.00× a line consumes more cash than it returns, however good its margin percentage
      looks), and **stockout impact** — the loss that never reaches a sales report because
      the sale never happened, reported explicitly as an **estimate**.
    All ratios are exact BigInt basis points, and a ratio that cannot be computed returns
    **"not meaningful", with the reason** — never `Infinity`, `NaN` or a silent zero. 27 tests.
  - **Product master — DONE (3 Aug 2026). M03 is complete.** `packages/product/` is the
    write side of the product truth (`packages/catalogue` is the read side the till holds
    offline). A wrong product record does not stay wrong in one place — it multiplies into
    every sale, order, report and tax return, and it is found months later at stock-take.
    So the package is built to be **hard to publish something wrong through**:
    - **an incomplete product is a draft, not an error.** You can always save what you know;
      the system lists **what is still missing in plain English** and refuses to publish
      until it is there — naming **every** reason at once, not one per attempt;
    - **cannot reach the shelf without**: a category, an HSN/tax class, an **allergen
      declaration** on a food item (an empty list means "declared: none" and passes —
      **silence is not a declaration**), country of origin, the **Legal Metrology** net
      quantity and packer details on packed or weighed goods, and a minimum age on an
      age-restricted item so the till knows when to ask for proof;
    - **attributes belong to the tenant's own departments**, typed and validated — a fish
      counter and an electronics aisle do not need the same fields, and neither list is in
      our code;
    - **a recall block stops sale *and* purchase**, offline included, and **MRP is
      effective-dated** so last month's bill can still be explained;
    - **a case of 24 becomes exactly 24.** Pack conversions are exact integers and
      reversible; a pack that could never be exact is refused at definition time rather than
      corrupting stock at the first delivery. Converting down gives **whole packs and a
      remainder** — half a case is not something you can shelve or return;
    - **one barcode maps to exactly one item.** The register refuses a second claim and
      **names the product that already owns the code**; re-registering the same code to the
      same product is a no-op, so an import can be re-run safely;
    - **duplicates are reviewed, never auto-merged.** "Aashirvaad Atta 5kg" and "AASHIRVAAD
      ATTA 5 KG" are caught (the normaliser splits "5kg" into "5 kg", which is where the
      commonest real duplicate hides), graded with the evidence — a shared barcode is
      near-certain, same name+brand with a different pack size is only possible. A merge
      needs a **second person** and is a **reversible link, never a deletion**, because a
      wrong merge with nothing left to compare against is unrecoverable.
    41 tests.
  - **Licence, risk and incident registers — DONE (3 Aug 2026). M34 is now complete.**
    `packages/compliance/` covers the paper the shop did not write — the FSSAI food
    licence, the Legal Metrology stamping certificate for every scale, the trade licence,
    the fire NOC. Any one of them expiring quietly can close the shop for a day, and the
    way they expire is always the same: **nobody owned the date**. So:
    - **every obligation names a person, not a role.** An obligation that names nobody is
      refused outright — an alert that reaches "compliance" reaches nobody;
    - **alerts escalate and an expired licence keeps shouting**: notice → warning →
      critical as the date nears, escalation to a named deputy inside the final window, and
      an expired one **stays at the top of the list** instead of dropping off — which is
      exactly when most systems go quiet. The message names the person: *"FSSAI food
      licence EXPIRED 33 days ago — Priya must renew it now"*;
    - **having a licence and being able to produce it are different things**, so an
      obligation with no evidence on file is flagged separately from its expiry date;
    - **nothing is deleted** — an obligation that no longer applies is **closed with a
      reason** and keeps its whole record, because an inspector's question is usually about
      the period you no longer operate in;
    - the **risk, control, incident, remediation and attestation** registers exist to answer
      three questions instantly: which control failed, who is fixing it by when, and did
      anyone ever check the control works. An incident must **name the control it defeated**,
      remediation must have an **owner and a date**, and a control **nobody has ever
      attested** is reported as such — an untested control is an assumption;
    - an **open critical risk blocks its quality gate**. Accepting a risk unblocks it, but
      only **in someone's name with a written rationale** — accepting a risk is a decision,
      and decisions have authors.
    28 tests.
  - **Org hierarchy and branch lifecycle — DONE (3 Aug 2026). M01 is now complete.**
    `packages/org/` is the skeleton the rest of the system hangs on —
    **company → GST registration → branch → warehouse → department**. Get it wrong and
    the symptoms appear everywhere at once: GST filed against the wrong registration, a
    manager able to see another branch's takings, a report that quietly double-counts a
    warehouse.
    - **the GSTIN checksum is verified, not just its shape** — a single mistyped digit is
      caught the moment it is typed, rather than at the first return;
    - a **duplicate GSTIN is rejected naming who already holds it**, because the second
      entry is almost always a typo of the first;
    - a branch **cannot be activated without a company and its own registration** (its
      sales would be unattributable) — but it can still be **saved as a draft**, because
      incomplete is not invalid;
    - a node whose parent belongs to **another tenant** is refused outright — cross-tenant
      structure is a defect, not a setting (ADR-0003);
    - **branch closure is where stock, cash, staff access and reporting all leak at once**
      if it is done ad-hoc. So permanent closure is **blocked while anything is left
      behind** — stock (valued in the message: *"812 units worth ₹24,500.00"*), cash, open
      documents, **unsent sync items** (closing over them would destroy sales that were
      legitimately made), or unresolved exceptions — and **every blocking reason comes back
      at once**, so the manager can plan the day instead of meeting the next obstacle one
      attempt at a time;
    - a **temporary** closure deliberately blocks on none of that: it preserves stock,
      cash, reservations and unsent items, and they resume on reopen;
    - closure is **owner-approved with the executor never the approver** (§28), and it
      **deletes nothing** — access is revoked, the branch leaves the *live* reports but
      stays in history, and the audit trail and closure evidence pack are kept in full.
      "Closed" is a state, not an erasure.
    30 tests.
  - **Named accounts, sessions and the access lifecycle — DONE (3 Aug 2026).**
    `packages/identity/` closes M02 alongside `rbac` and `approvals`. It **holds no
    credentials at all** — no password field, no hash, no token. Credential storage belongs
    to the identity provider chosen at deployment, and **a password that never enters this
    codebase can never be logged by it** (hard rule #4).
    - **a shared or generic account cannot be created.** Shared logins are the top audit
      finding in retail and they never arrive as a decision — they arrive as a convenience:
      one account for the evening shift, one for the new starter "until IT sets them up",
      one called "manager" nobody wants to be the one to remove. So `cashier`, `manager`,
      `till2`, `temp` and their kind are **refused with the reason**, and **two accounts
      cannot share one personal contact** — that is a shared login wearing two names;
    - a **privileged account cannot go live without a second factor**; sessions expire on
      inactivity **and** on an absolute limit, **bind to their terminal**, and an offline
      cached identity at the lane is trusted only for a **bounded window** — the lane keeps
      trading with the cable out without leaving a permanent hole;
    - the **access review** flags the two things that actually get exploited: privileged
      accounts with no second factor, and dormant accounts nobody closed;
    - **the mover who accumulates** is the quiet one. Someone moves from the Fresh counter
      to the cash office and keeps both, and six months later can raise a stock adjustment
      *and* settle the till it hides in — a combination nobody granted; it assembled itself.
      A move now **replaces** scope and closes their sessions so it applies at once;
    - **the leaver who lingers** is the other. Revocation and session closure are **one
      act**, and it is **blocked until owned open items are reassigned**, naming them — an
      unapproved purchase order owned by nobody never gets approved. Revocation is a
      **priority sync item**: an ex-employee's access must not queue behind the day's sales;
    - **emergency access** is real, necessary, and the one that quietly becomes permanent.
      It is **time-bound at the moment it is granted**, expires by itself with nobody
      needing to remember, needs a specific reason and a separate approver, and **cannot be
      extended in place** — an extension is a new grant with a new approval, which is what
      stops "temporary" becoming permanent through a series of quiet nudges.
    34 tests.
  - **POS lane guards — DONE (3 Aug 2026). M12 is now complete.** `apps/pos/src/lane-guards.ts`
    adds the three lane controls that all fail the same way if they are advisory:
    - **an age prompt that blocks, not warns.** A flagged item does **not** join the basket
      until the question is answered — *"Beer 650ml is age restricted — check identification.
      Is the customer 21 or over?"* Answer no and the sale is refused. **"Warned and sold" is
      the outcome this exists to prevent**, because selling to a minor is a personal
      prosecution for the cashier and a licence risk for the shop. Licence-hour windows and
      per-customer quantity limits work the same way;
    - **an override the cashier cannot give themselves.** Self-approval is refused outright,
      every override needs a **reason** (*"manager approved" explains nothing three months
      later*), and one beyond a supervisor's limit **escalates to a named person** instead of
      failing silently — a button that just says no teaches the lane to work around it. Every
      decision produces an audit entry that the loss-prevention rules read for patterns;
    - **a lane that never lies about its state.** Online / degraded / offline, the **unsent
      sale count**, prices old enough to be wrong, and failed peripherals — all visible, and
      the lane **keeps trading** through every one of them (hard rule #1). A till showing
      "online" while holding 37 unsent sales is how a day's takings go missing at close;
      `lanesNeedingAttention` sorts the shop's lanes worst-first for the manager.
    16 tests.

- **Owner answers (3 Aug 2026) — two open items closed, both now recorded:**
  - **OB-03 — age-restricted sales: minimum age 18, no licence-hour restriction.** Both are
    per-tenant settings (`pos.age_restricted.minimum_age` = 18,
    `pos.licence_hours.enabled` = false), so a tenant in a state with different rules
    changes a setting, not code. The till still **blocks** rather than warns.
  - **OB-04 — SRE operates a cafe.** This **closes AVR-12**, which gated M11. SRE's setting
    is `production.departments = ['cafe']`, so only the cafe appears in SRE's screens,
    cold-chain scope and FSSAI obligations.
  - **OB-05 — product scope is never narrowed to SRE's own footprint** (owner: *"everything
    will be there, remember this software is not only for us, it's for multi tenant — so
    think for that"*). This **corrects an over-narrow reading of roadmap §2.2** on my part.
    That rule governs **what a tenant is shown**, not **what the product contains**: the
    product builds every capability, and a tenant sees only what it switches on. So a shop
    with no meat counter never meets one, *and* a tenant with three counters is not told to
    wait for a release. Concretely, **all M11 departments are built** — cafe, bakery, deli,
    meat/fish, central kitchen — **including the full weighed path**, even though SRE runs
    none of it. **This applies to every module from here on**: an SRE answer configures SRE,
    it never trims the build (OB-01, OD-02).

  - **In-store production — DONE (3 Aug 2026). M11 is complete, for every department.**
    `packages/production/` treats a production run as exactly two things: **ingredients
    consumed (stock out) → a finished batch created (stock in)**, both on the **same ledger**
    the till and the goods-in door use. Without that, the system believes you still have
    twelve litres of milk that were drunk as coffee this morning.
    - **you cannot issue more than you have** — every ingredient is checked *before*
      anything is consumed, so a half-finished run never leaves the shelf and the system
      disagreeing;
    - **output lands in quarantine, not on the shelf.** Freshly made food is sellable only
      after a **named** quality release — and because the stock model treats quarantine as
      never-sellable, that is enforced by the model rather than by anyone remembering. A
      release is refused for a failed check, an unnamed releaser, or an **expired batch**:
      you cannot release your way past a use-by date;
    - **cost follows the food that survived.** Spill 6 cups out of 40 and the same ₹860 of
      ingredients now sits on 34 cups — the cup cost moves ₹21.50 → ₹25.29. That is the only
      way a cafe's real margin is ever visible; loss written off separately hides it;
    - **yield drift is a valued exception, high or low.** Too many cups means the recipe or
      the portioning is wrong, which costs just as much as too few. Inputs in and nothing
      out always demands an explanation;
    - **a label will not print** without a use-by date, the net quantity, the packer's
      details or an **allergen declaration** — where, as in the product master, an empty list
      means "declared: none" and passes but silence does not. What is mandatory follows the
      department: a cafe needs allergens, only a weighed counter needs a weight;
    - **a repack inherits its source's expiry** — a fresh wrapper does not make food younger
      — and records where it came from, so a recall reaches everything made out of it.

    **The weighed counters are built too** (OB-05), for the tenants that run them:
    - **the bin was paid for.** A butcher takes in 12.4 kg, bins bone and trim, and puts out
      8.9 kg. **₹600/kg of carcass becomes ₹835.96/kg of curry cut** — price the shelf off
      the input figure and the counter loses money on every kilo. Cost lands only on what can
      be sold (loading it onto bone would understate the meat), and a carcass splits between
      prime and secondary cuts **by value**, with the remainder distributed so the parts sum
      to the whole;
    - **yield against the department's standard**: too low means a poor delivery, a heavy
      hand, or stock leaving another way; **too high** means the standard or the scale is
      wrong, which costs just as much. More coming out than went in is flagged as what it is;
    - **the sticker and the till agree by construction.** Scale labels are generated from the
      **same per-tenant barcode rule the catalogue parses with** — one definition, both
      directions — and the acceptance test **prints a label and scans it through the real
      catalogue**, weight-embedded and price-embedded, rather than asserting the format
      twice. The check digit is computed (verified against a published barcode), and a value
      that will not fit is **refused rather than truncated**, because truncating charges the
      wrong amount.
    38 tests.
  - **Receipt printing — DONE (owner asked, 3 Aug 2026):** `packages/receipt/` builds the
    receipt **from the committed sale** (never a draft, M31-FR-02) with its gap-free number, and
    **refuses to issue a wrong one**: a **PAN-like tender reference** (hard rule #3), **totals
    that don't balance**, or a **reprint with no reason** are all rejected. It renders to thermal
    paper (32/42/48 chars) with each line's **true weight and unit price** (`1.234 kg x 80.00`),
    GST bands and change; a long name **wraps rather than truncating**; and a **reprint is
    stamped `*** REPRINT ***` with its reason** so a copy can't pass as an original (M12-FR-02).
    Encoding is **ESC/POS** (vendor-independent, P-06) via a `PrinterPort`, and a **printer
    failure is returned, never thrown into the sale path** — the sale stays committed (hard rule
    #1) and the lane offers a reprint. Building/rendering are pure, so a receipt prints offline.
    Header/footer are per-tenant configuration. 14 tests.
  - **First app shell — POS (owner asked, 3 Aug 2026):** `apps/pos/` is the cashier till, built
    to the Stage 3 spec (`docs/design/screens/pos-cashier.md`). Two parts: **`src/session.ts`,
    the tested model** — `PosSession` holds the basket and composes the engines (pricing,
    promotions, tender, sale commit), **synchronously by construction** so a sale never awaits
    I/O (hard rule #1); a **voided line is marked and kept** with its reason (visible to loss
    prevention), a **pending card is shown honestly** and never counts as paid, the **sync badge**
    reports connection + unsent count (P-08), and a **double-tap on Tender is refused** rather
    than double-billing. And **`web/`, the PWA shell** — framework-free per the §19 baseline: the
    Sale screen laid out per spec (running total the largest element, one dominant Tender action,
    permanent sync badge), with a **service worker that pre-caches the shell so the lane opens
    and bills during an outage**. 13 tests, covering the spec's acceptance (tax-exact totals,
    weighed goods, promotions, offline commit + unsent count, suspend/recall).
  - **POS build pipeline — DONE (owner asked, 3 Aug 2026):** `pnpm build:pos` (esbuild, ~25 KB
    ESM bundle; `--watch` for screen work) compiles the tested model into
    `web/pos-session.bundle.js`, which `index.html` loads **before** the view — so **the screen
    is now driven by the real engines end to end**, not a stand-in. The bridge is a tested
    **view adapter** exposing only **display primitives** (integer minor units, plain strings),
    so the view layer holds **no** business rules. Verified end to end on the built bundle: two
    scanned lines total **₹295.00** with 18% tax, a void stays on the bill and drops it to
    **₹236.00**, and cash tender commits stock to the lane ledger leaving **unsent = 1** queued
    for sync. The artifact is git-ignored and the shell still opens (on the stand-in) if it
    hasn't been built.
  - **Barcode scanning + local catalogue cache — DONE (owner asked, 3 Aug 2026):**
    `packages/catalogue/` is the lane's offline catalogue (M03 / M12 / §31 / §32). Built once
    from a **versioned snapshot** the lane holds locally, so every scan is an **O(1)** map
    lookup — measured **360 µs for two scans** through the built bundle, far inside the
    sub-second target. It handles **variable-weight and price-embedded barcodes** (M03-FR-02)
    via **per-tenant rules** (prefix / item-code / value positions — choose-able, never
    hard-coded), and it is **safe at the scan**: a **recalled item is refused even offline**
    (M10-FR-04), a draft/discontinued item is refused, an unknown code is refused — and on any
    refusal **nothing reaches the bill**. Age-restricted items are flagged so the lane prompts
    (M12-FR-04), and the cache exposes its `version`/`builtAt` so **staleness is visible**
    (P-08). Wired into the POS (`scanBarcode`) and into the shell's scanner-keystroke handling.
    Verified end to end on the built bundle: scanning a plain barcode and a 1.234 kg weighed
    barcode totals **₹216.72**, a recalled code is refused, and cash completes locally with
    **unsent = 1**. 17 tests.
  - **Catalogue snapshot builder — DONE (owner asked, 3 Aug 2026):**
    `buildCatalogueSnapshot` closes the loop **product master → price lists → the lane**
    (`packages/catalogue/snapshot-builder.ts`). It resolves each product's price through the
    **same effective-dated precedence engine** as the rest of the system (customer > channel >
    zone > store) at the build instant — so a **future price never ships early** and the lane
    charges exactly what the ERP says — attaches the tax-class rate, and carries status, recall
    and age flags through. Crucially it **never ships a product it cannot price safely** (P-08):
    one with **no effective price**, an **unknown tax class**, or a **price above MRP**
    (M05-FR-02) is **excluded and reported with a reason**, and its barcodes are dropped so a
    lane can't scan into a product it doesn't hold. Draft/discontinued items are **included and
    marked**, so a scan says *"not sellable"* rather than the misleading *"unknown barcode"*.
    **Deterministic** (version + `asOf` are inputs), so a snapshot is rebuildable and auditable —
    10 tests.
  - **Store-edge sync agent — DONE (owner asked, 3 Aug 2026):** `edge/sync-agent/` completes the
    offline promise — it carries locally-committed work to the cloud once there is a connection,
    and **never touches the sale path**. Guarantees, all tested: items drain in **enqueue order**
    (cause before effect); delivery is **idempotent** on the event key, so a retry after an
    ambiguous failure collapses to **one effect** in the cloud (§31.1); **work is never dropped** —
    a transient failure stays queued with its attempt count, while a permanent rejection or an
    exhausted attempt budget moves the item to the **visible dead-letter queue** (hard rule #6),
    and a **cloud conflict is a rejection → an exception, never a last-write-wins overwrite**
    (hard rule #10); an unexpected transport error is treated as transient so an exception can't
    lose work; the pass **stops early when the link looks down** rather than hammering it, with
    pure **exponential backoff** (1 s → capped at 5 min); and `health()` reports **unsent count,
    dead-letter count and last success** so lag is visible everywhere (P-08). Deterministic and
    **clock-free** (time is injected), so it is tested without timers or a network — 12 tests.
    The real transport (HTTPS ingest or broker publish) is a thin adapter against the tested
    `SyncTransport` port at deployment.
  - **Second app shell — Owner command centre (owner asked, 3 Aug 2026):** `apps/owner-app/`,
    built to the Stage 3 spec. **`src/brief.ts` is the tested model**: it composes reporting,
    loss-prevention and approvals into one glanceable brief — a **plain-sentence headline** with
    the numbers beside the words, **the three things needing attention** (risks outrank
    approvals; urgent escalations first; biggest-value approval first), **grouped alerts** so six
    voided bills are *one* line with a count rather than an alert storm — while keeping **every
    transaction id** for drill-through (M29-FR-02) — and **freshness always stated**, with a
    stale feed spelled out in the headline (*"These numbers are NOT live…"*, P-08). It is **pure
    and deterministic**, so it renders **with the AI narrative off** (spec acceptance). The
    **`web/` shell** is phone-first and framework-free with a service worker, so **the brief opens
    with no signal** showing last-synced numbers, labelled as such; the view holds no KPI maths
    or priority rules, and says *"brief unavailable"* rather than inventing numbers. Verified on
    the built bundle against an 8-hour-old feed — 9 tests. The build script is now generic
    (`pnpm build:pos` / `pnpm build:owner` via `scripts/build-app.mjs`).
  - **Third app shell — Web ERP (owner asked, 3 Aug 2026):** `apps/web-erp/` is the back-office
    surface every non-till role works in. Two tested models: **role-scoped navigation**, where the
    menu is **derived from the user's real permissions** rather than hand-maintained per role — so
    a user **never sees a section they'd be refused on** (screen and server run the same
    default-deny check), **branch scope is honoured**, an unknown user sees **nothing** and an
    unknown path is **denied**, and adding a role is **configuration, not code**; and the
    **approvals workbench**, which makes **separation of duties visible on screen** (§28): a
    request you made is shown but never actionable by you, one above your limit or outside your
    branch is marked **escalate / out-of-scope with the reason instead of a button that fails**,
    the queue is ordered by value, a reason is mandatory, and every real decision is delegated to
    the approval engine — proven by a test that the engine still refuses a self-approval if the
    screen were bypassed. 14 tests.
  - **Fourth app shell — Picker/packer handheld (owner asked, 3 Aug 2026):** `apps/picker-app/`,
    built to the Stage 3 spec for a low-spec Android handheld in the aisles — **synchronous and
    local**, so a picker completes a wave with no signal. It **enforces** the rules rather than
    trusting the picker: **every pick is a scan, in order** (scan bin → scan item → confirm; the
    wrong bin or wrong item is refused); **a short pick is honest** (fewer than required marks the
    line short, never a silent complete; more than required is refused); **a substitution is never
    the picker's silent choice** — it delegates to the fulfilment engine, which **refuses an
    unconfirmed swap** (A04); **a weighed line captures its final price at pick** (1.234 kg at
    ₹80/kg = **₹98.72**, exact — D09); quality failures and shorts **need a reason**; and the
    **dispatch manifest is derived from what was actually packed** (quality fails and zero-pick
    shorts excluded, substitutes flagged), with packing **blocked while any line is unresolved**
    and cold-chain/tamper evidence recorded. **PII is minimised** — lines carry the order
    reference only, never customer details (tested). 17 tests.
  - **Fifth app shell — Delivery/driver phone (owner asked, 3 Aug 2026):**
    `apps/delivery-app/`, built to the Stage 3 spec for a low-spec Android phone in a moving
    vehicle — **synchronous and local**, so a driver completes a stop with no signal. It
    **enforces**: **nothing is "delivered" without proof** (photo/OTP/signature, M19-FR-03 —
    delegated to the fulfilment engine); the stop follows a **state machine** (depart → deliver,
    or fail → reattempt / return-to-origin), so delivering before departing is refused; **COD is
    recorded to the paisa** and **reconciled at end of shift** with short / over / uncollected /
    unexpected each a **valued exception** feeding finance (M23), and a **card method refused**
    (hard rule #3); **a failed delivery records a reason**, never quietly dropped; a **geofence
    mismatch is flagged but not blocked** (a driver may be a street away) so it is visible on
    sync; and **contribution stop rules are surfaced, not buried** — an unprofitable stop carries
    a plain-English flag (*"Delivery cost is 16.0% of order value (limit 10.0%)"*), the rule
    being **per-tenant configuration** (D09). **PII is minimised** — stops carry the order
    reference and a coarse area label, never customer name/phone/email (tested). 15 tests.
    **All five app shells in the roadmap's §27 surfaces are now modelled and tested.**
  - **Pilot stack + deployment runbook — DONE (3 Aug 2026).** `infra/compose/` brings the whole
    system up on **one machine** with one command — PostgreSQL, the schema migrations (one-shot
    and **idempotent**, safe on every deploy), and the app shells served over HTTP. It is
    deliberately **vendor-neutral**: it runs on a shop back-office PC, a laptop, or any cloud VM,
    so **standing up a pilot does not pre-empt the cloud-vendor decision** (ADR-0002 item 4 stays
    open) — the same containers are what the managed tier runs later. The database port is bound
    to **localhost only** and every secret comes from a **git-ignored `.env`** (the secret scan
    enforces it — it caught and rejected a connection string during this build). Compose config
    validated. **`docs/runbooks/pilot-deployment.md`** is the plain-English walkthrough for the
    owner or Mr Sivakumar: what you need (just Docker), the five steps, how to check it worked,
    backups, and **how to prove the offline promise by pulling the network cable mid-sale** —
    plus an honest list of what the pilot does *not* yet include.
  - **Open architecture decision — the ERP's SSR framework (needs the owner's hosting call).**
    §19's baseline for this app is "TypeScript + modern SSR web framework". **Which** framework is
    **coupled to hosting (OB-02)**: SSR needs a server, and the framework's deployment shape (Node
    server / edge runtime / container) is part of choosing one. Installing one now would bake in a
    runtime assumption before there is anything to run it on, so the shell was built
    **framework-agnostic** — pure TypeScript, no view library, renders unchanged under any SSR
    choice. When hosting is settled this needs an ADR, and the remaining work is the view layer
    plus session/auth wiring.
  - Remaining for a live store: serving the app shells on the devices, receipt printing, the
    distribution job that ships a built catalogue snapshot to each lane, the cloud ingest
    endpoint the sync transport posts to, and the read API feeding the owner's phone — all of
    which need the deferred hosting/DB (OB-02).
  - **Persistence layer — BEGUN (owner asked, 3 Aug 2026):** the core durable stores, all
    **portable and testable without a live database** via a driver-agnostic **`SqlClient` port**
    (no concrete driver imported anywhere), each with an **in-memory reference that defines the
    behavioural contract** and a **SQL adapter** over real DDL:
    - the **event store** (`packages/persistence/` + `db/migrations/0001_event_ledger.sql`) — the
      async, **tenant-scoped, append-only** log behind hard rule #2 / §30.2 / §31.1: INSERT …
      ON CONFLICT DO NOTHING (never a mutating upsert), idempotent per tenant, same key under two
      tenants = two events (ADR-0003 isolation) — 8 tests;
    - the **sync outbox** (`+ db/migrations/0002_sync_outbox.sql`) — the durable offline→cloud
      queue (P-01 / §31): idempotent enqueue, acknowledge, retry, and a **visible dead-letter**
      that is never dropped (hard rule #6); state advances bind the target state as a **parameter**
      (never a SQL literal) — 8 tests;
    - the **versioned config store** (`+ db/migrations/0003_config_versions.sql`, M01-FR-03) —
      **append-only** config versions numbered per (tenant, key), with **rollback as a new
      version** (intervening versions kept); the SQL adapter assigns the next version atomically
      (`COALESCE(MAX(version),0)+1` in the INSERT) so concurrent writers can't collide — 7 tests;
    - **projection read-models** (`packages/persistence/projection.ts`, §29 / P-08) — reporting
      owns no source tables: a read model is **derived by folding the event ledger** and is
      **rebuildable**. Each projection tracks a **watermark** (highest seq folded) so it resumes
      incrementally without double-counting, and the **last-event time** that feeds the freshness
      indicator (`packages/reporting`) — 6 tests;
    - the **PostgreSQL connector + migration runner** (owner asked, 3 Aug 2026; §19 baseline) —
      `pgClient(pool)` adapts a node-postgres `Pool` to `SqlClient` via a **structural** interface
      (so `packages/persistence` still imports no driver — portable, P-06); `runMigrations` applies
      ordered forward-only migrations idempotently (tracked in `schema_migrations`); and the
      runnable CLI **`pnpm db:migrate`** (`scripts/migrate.mjs`) applies `db/migrations/` against
      `DATABASE_URL`. `pg` added as a devDependency; the CLI is verified runnable (it connects and
      errors cleanly without a database). 5 tests. **The only thing left is a live PostgreSQL +
      `DATABASE_URL`** — then `pnpm db:migrate` creates the tables and every SQL store is durable.
    The domain hot path stays synchronous (a sale never awaits I/O, hard rule #1); these async
    stores are the durable log events are written through and the sync agent drains into. The real
    `pg` wiring is a thin `SqlClient` adapter that must pass the same contract tests — a deployment
    step. The DB **host** decision stays with the owner (OB-02).
  - **Base-platform layer begun:** the **append-only ledger engine** (`packages/ledger/`,
    hard rule #2 / M08-FR-01 / §31.1) — idempotent append, balances projected from events
    (never stored), corrections as compensating entries, storage-agnostic with an in-memory
    store; 5 tests. The `ledger-append-only` guardrail still passes (genuinely append-only).
  - **Maker-checker approval engine** (`packages/approvals/`, §28 / M02) — the maker can
    never decide their own request; mandatory reason, branch scope, and value-limit routing
    (approve needs authority, reject needs only scope); 10 tests.
  - **RBAC access-control engine** (`packages/rbac/`, P-04 / M02-FR-02) — default-deny; a
    named user may do only what an assigned role explicitly grants, within branch scope;
    `can`/`assertCan`, no wildcards; 7 tests.
  - **Offline sync outbox** (`packages/sync/`, P-01 / §31 / hard rule #6) — idempotent
    enqueue, visible unsent count, acknowledge/watermark, and a dead-letter queue that
    never drops a poison item; 5 tests.
  - **Which price applies, decided** — **effective-dated price resolution**
    (`packages/price-list/`, M05-FR-01 / P-02): resolves a product's price by **precedence**
    (customer > channel > zone > store base), considering only **published** entries **within
    their effective window** — so a **future price never activates early**, and within a scope
    the most recently effective entry wins. Price entries are **append-only** (a change is a new
    entry → complete who-changed-what history), and the resolved entry carries its version so a
    sale can **lock the price it referenced** and never be repriced mid-transaction. Pure and
    identical offline — 10 tests. With FR-02/FR-03, the M05 pricing module is now built (only
    FR-04 simulation/vendor-funding/effectiveness — reporting-heavy — remains).
  - **Pricing safety net now composed** — **margin-floor / MRP controls**
    (`packages/price-guard/`, M05-FR-02): a price **above MRP** is rejected outright (a legal
    ceiling — no approval can authorise it); a price **below the margin floor or below cost** is
    never silently allowed — it is blocked until a **different person** approves it with a
    reason (§28 / P-03). The margin maths is **exact** (BigInt, no float) and runs the same on
    the offline edge — 10 tests.
  - **One promotion truth now composed** — **promotions best-price engine**
    (`packages/promotions/`, M05-FR-03 / P-02): computes a basket's **deterministic** best
    price from the approved, effective-dated rule set — percent-off, amount-off/coupon,
    buy-X-get-Y (BOGO/multibuy with an abuse cap), and member pricing — where an **expired or
    unpublished** promotion **never applies** (§31), exclusivity picks the single best in a
    group and everything else stacks, and the discount is capped so a price never goes below
    zero. Pure and input-determined, so a lane gets the **same price offline as online**.
    Every rule is configurable ("choose-able") — 11 tests.
  - **Control-by-exception now concrete** — **loss-prevention anomaly rules**
    (`packages/loss-prevention/`, M15-FR-01 / P-03): point void/refund/discount/no-sale/cash
    activity at a store's **configurable** thresholds (count, total value, single value, spike
    escalation) and get back the risky patterns as **exceptions that link to the underlying
    transactions** — surfaced to the owner, **never acted on automatically** (AI-NFR-12). Pure,
    deterministic detection over synced data — 9 tests.
  - **The owner's numbers, honestly dated** — **owner KPIs & freshness**
    (`packages/reporting/`, M29-FR-01 / D13): aggregates committed sales into the core KPIs —
    **gross / net / tax / COGS / margin, margin %, basket count, units, average basket, tender
    mix** — with **exact** money sums (never a float) and **governed definitions** so a figure
    means the same everywhere; it refuses to blend currencies. And a **freshness indicator** that
    marks data **fresh / stale / missing** so lagging or offline data is **never shown as fresh**
    (P-08). Pure — 7 tests.
  - **Messages only where allowed** — **notifications** (`packages/notifications/`,
    M31-FR-03/04, R4 design-ahead): a notification is **consent-safe by construction** — before
    anything is sent, every gate must pass (**approved template → do-not-contact suppression →
    consent + frequency → messaging budget**), and a breach **blocks** the send rather than
    warning-and-sending. Reuses the customer consent engine. Plus a **retry queue with a visible
    dead-letter** so a poison send is **never dropped** (hard rule #6) — the same discipline as
    the sync outbox. Pure — 9 tests.
  - **Sell to businesses on terms** — **B2B credit & commission** (`packages/b2b/`,
    M22-FR-01/03, R6 design-ahead): a second commercial channel on the same core. A B2B order
    that would push the customer past their **credit limit** is **blocked pending approval** (by
    someone other than the order-taker, §28) — never a silent override; an **expired contract**
    blocks or falls back per policy. And **salesperson commission** computed with **exact money**
    (basis-points rate, half-up, optional cap). Reuses the Money and approval engines. Pure —
    10 tests.
  - **Losses recorded honestly** — **waste / write-off** (`packages/waste/`, M28-FR-01, R6
    design-ahead): records what leaves as loss — **wastage, damage, expiry, donation,
    destruction** — as a **reason-coded compensating stock movement** (a loss removes stock,
    never an edit — hard rule #2), valued for finance (M23). A **material** loss needs **captured
    evidence** (photo/witness) **and** a separate approver (§28). It **reuses the adjustment
    engine** — the same way stock counts do — so the disposal side of FEFO (expired → dispose)
    has a controlled home. Pure — 8 tests.
  - **One customer truth, consent respected** — **customer 360** (`packages/customer/`,
    M16-FR-01/02, R4 design-ahead): **duplicate detection** that **never auto-merges** — a shared
    *verified* phone/email is a high-confidence merge candidate, anything softer (unverified
    contact, name-only) is a **review exception** for a human to judge (P-08). And **consent
    enforcement**: a marketing message can be sent **only** with consent for that purpose+channel
    that hasn't been withdrawn and within the frequency cap; a breaching send is **blocked, not
    warned**, and withdrawal takes effect immediately (PRV). Pure — 9 tests.
  - **Pick, deliver, collect COD honestly** — **fulfilment** (`packages/fulfilment/`,
    M19-FR-01/03/04, R5 design-ahead): a **delivery state machine** (assigned → out-for-delivery
    → delivered, or failed → reattempt / return-to-origin) that requires **proof of delivery**
    (photo/OTP/signature) to complete; a short-pick **substitution only applies with the
    customer's confirmation** (A04) — never a silent swap; and **COD reconciliation** at shift
    end that matches cash collected **to the paisa** against each order and flags short/over/
    uncollected/unexpected as valued exceptions — **cash/UPI only, never card data** (hard rule
    #3). Pure — 10 tests.
  - **One order lifecycle, no oversell** — **order management** (`packages/orders/`,
    M18-FR-01/02, R5 design-ahead): an **auditable order state machine** (placed → confirmed →
    picking → packed → dispatched → delivered, or collected for pickup, or cancelled) where only
    allowed transitions apply. And **stock reservation** so the store **never oversells**
    (§6.2): a confirmed online order **reserves** stock, which is then **removed from what a
    walk-in can buy** (available-to-promise = physical on-hand − reservations); a reservation
    beyond availability is refused. Reservations are append-only and projected; cancellation
    releases them. Idempotent — 10 tests.
  - **Bank-fraud safeguards** — **bank controls** (`packages/bank-controls/`, M06-FR-01 +
    M15-FR-03): a supplier's **bank-detail change** can be verified only by an **independent
    approver** (the person who requested it can never approve it, §28) — an unverified change
    **blocks payment**. And **duplicate bank-account detection** flags any account shared by two
    or more distinct holders (supplier–supplier or supplier–employee related-party risk) and
    **blocks their payment pending review**. Account references are masked (PRV). Pure — 8 tests.
  - **Buy safely, track commitments** — **purchase orders**
    (`packages/purchasing/`, M06-FR-02/04): a PO can be **issued only with an approval by
    someone other than the person who raised it** (§28), the approver's value authority checked
    when the approval was decided, and **never to a blocked supplier**. **Open commitment =
    ordered − received − cancelled** (valued at unit cost), so what's on order **reconciles to
    receipts** (M07); an over-receipt shows as a negative open quantity, not hidden. Connects
    reorder suggestions → PO → goods receiving. Pure — 8 tests.
  - **Electronic payments reconcile** — **payment reconciliation**
    (`packages/reconciliation/`, M23-FR-03): matches provider settlement lines against POS
    card/UPI tenders by **token/reference and amount**, surfacing every unmatched or mismatched
    line as a **valued exception** (unsettled tender / unknown settlement / amount mismatch /
    duplicate ref) — never a silent loss (P-08). It **refuses any reference that looks like a
    card number** (hard rule #3) — tokens only. Pure and deterministic — 7 tests.
  - **Loyalty that never leaks money** — **loyalty points**
    (`packages/loyalty/`, M17-FR-01): points are **money-like** — earn/burn/reverse are
    **append-only** movements and the balance is **projected** from them (never stored). A burn
    can **never go negative**, and an **offline** burn is **capped** to prevent double-spend
    across lanes before sync. A reversal (e.g. a returned sale) is a compensating credit. Reuses
    the ledger discipline; idempotent — 8 tests.
  - **The money reconciles for the CA** — **finance posting engine**
    (`packages/finance/`, M23-FR-01/02 / P-08): maps an operational transaction to a **balanced
    double-entry journal** from a **configurable chart-of-accounts map** (choose-able per
    tenant), with **GST** posted as a mapped tax component. Posting is deterministic from the
    mapping; an **unmapped** event, a missing amount, or an **unbalanced** journal is refused as
    a **visible exception** — never silently unposted. `postBatch` posts the good entries and
    surfaces the bad ones for review. Finance only reads operational data and posts; it never
    edits the operational ledger (§28) — 7 tests.
  - **Trace a batch, stop a recall** — **lot traceability & recall**
    (`packages/traceability/`, M10-FR-03/04): `traceBatch` **projects the ledger** to show a
    batch's whole chain of custody — inbound (supplier/GRN) and outbound (sales, and the
    customers where captured), backwards and forwards, with received-vs-issued totals so a gap is
    visible. And a **recall** that **blocks a batch's sale at the POS even offline** (from the
    cached open-recall set) and **closes only with retained evidence** that is never deleted (hard
    rule #6). Pure — 5 tests. *(Full forward-trace to customers completes when sales tag their
    FEFO-allocated batch — a later wiring step.)*
  - **No money lost to expiry** — **FEFO allocation & expiry action list**
    (`packages/fefo/`, M10-FR-01): allocates stock **First-Expiry-First-Out** (earliest expiry
    sells first), **never** allocating expired, recall-blocked or quarantined stock (the recall
    block holds even offline), and reports any shortfall honestly. The **expiry action list**
    flags every on-hand batch that is **near expiry → markdown** or **expired → dispose**,
    feeding pricing (M05) and waste (M28). Pure and `asOf`-driven — same at the edge as the
    cloud — 9 tests.
  - **Buy the right amount, not too much** — **replenishment suggestions**
    (`packages/replenishment/`, M09-FR-02): from per-product parameters (reorder point / safety
    stock / max level, or a demand × lead-time computation) it proposes **what to reorder and
    how much** — reordering when the inventory position (on-hand + on-order − reserved) is at/
    below the reorder point, ordering up to the max, rounded to the pack size and raised to the
    supplier minimum. Every proposal is **advisory only** — it can never become a purchase order
    by itself; a buyer approves (**hard rule #5 / AI-NFR-12**). Pure and parameter-driven — 12
    tests.
  - **Honest stock counts now composed** — **cycle/blind count reconciliation**
    (`packages/counts/`, M09-FR-04): the counter enters a **blind** physical count; the system
    derives the expected quantity by **projecting the ledger** (so the counter never sees or
    supplies it — blind-count integrity is structural), **values** the variance, and turns any
    difference into a reason-coded **compensating adjustment** that needs a **separate
    approver** when material (the counter can never approve their own variance). Reuses the
    M08-FR-03 adjustment engine; offline; idempotent — 8 tests.
  - **Cash office now composed** — **till cash movements** (`packages/cash/`, M14-FR-01):
    float issue, loans, pickups and safe drops as an **append-only cash chain** (hard rule #2),
    with **one custodian per till at a time** (a till can't be issued to two cashiers), **no
    overdraw** (you can't remove more than the drawer holds), and the till balance + current
    custodian always **projected** from the events — the pickups/float that feed the shift
    close's expected cash. Fully offline — 8 tests.
  - **Shop-floor money-out operations now composed** — **returns & refunds**
    (`packages/returns/`, M13): a line is returned at most once (no double refund), the
    disposition decides whether stock re-enters *sellable* availability (only `resell` does),
    a material or no-receipt refund needs an approval by a **different** person and can never
    exceed the original paid amount, and a card/UPI refund is a **pending** reversal (never
    invented) — 15 tests. The **cashier shift/till close** (`packages/till/`, M14-FR-02):
    blind count → over/short against expected cash, a material variance is a reason-coded
    valued exception, fully offline — 6 tests. The **store/day close + controlled reopen**
    (`packages/day-close/`, M14-FR-04): locks a day only once its trading-day cut-off has
    passed *and* it is fully reconciled (no open exceptions, no unsent items), with an
    approved, audited reopen — 8 tests.
  - **Foundation engines now cover the core invariants** (exact money/quantity, append-only
    ledger, maker-checker, RBAC, offline outbox, gap-free document numbering, trading-day
    rule, loss-prevention anomaly rules, margin-floor/MRP price controls, replenishment
    suggestions, FEFO allocation & expiry list, lot traceability & recall, finance ledger→journal
    posting, payment reconciliation, bank fraud controls, notification guard & dead-letter queue,
    owner KPIs & freshness) plus compositions (effective-dated price resolution,
    line/bill pricing, the deterministic promotions best-price engine, tender settlement, the
    end-to-end offline sale commit, purchase-order issue & open commitment, goods receiving,
    approved stock adjustment, cycle/blind count reconciliation, the order lifecycle & stock
    reservation, fulfilment (delivery/substitution/COD), customer dedup & consent, waste
    write-off, B2B credit & commission, notification guard & dead-letter queue, owner KPIs &
    freshness, return/refund commit, till cash movements, loyalty points, the cashier shift/till
    close, and the store/day close + controlled reopen) — 43 tested units, 359 tests.
  - **OB-02 update (3 Aug 2026):** the owner asked to **start scaffolding the persistence
    layer**, so the persistence **design + code** is now **active** (the durable event store is
    the first unit; see above). What remains deferred under OB-02 is the **DB host / hosting /
    environment** decision and gathering the Stage-1 store facts — the persistence code is built
    driver-agnostically so it needs none of those to exist and tested, and slots onto the chosen
    host via a thin `SqlClient` adapter when the owner is ready.

Store-Core scope (roadmap §21 Stage 2): **M01–M15, M23, M29, M30, M32–M35 — all done.**
Each module doc marks store-fact-dependent fields `⟳ AVR-##` (confirmed in Stage 1),
so nothing is guessed.

**Design-ahead requirement expansion (R4 + R5 — the full customer→delivery arc):**
M16 (Customer 360), M17 (Loyalty), M20 (Customer app/web), M21 (CRM/Service) for R4,
plus M18 (Order management) and M19 (Picking/packing/delivery) for R5 — all expanded
to Appendix-B detail (`docs/requirements/`, 24 requirements traced), from the roadmap
§5 FR lines — nothing invented.

**All 36 modules (M01–M36) are now expanded to Appendix-B requirements** in
`docs/requirements/` — Store-Core (Stage 2) plus the design-ahead expansion of every
later-release module: customer/fulfilment (M16–M21, R4–R5), B2B (M22, R6), supplier
portals / workforce / facilities / concession / waste (M24–M28, R6), documents &
notifications (M31), and the multi-tenant platform (M36, R8). All from the roadmap §5 FR
lines — nothing invented.

**Cross-cutting sets mapped:** SEC/PRV/NFR/AI-NFR/MG are in `docs/requirements/cross-cutting.md`,
each tied to the guardrail / foundation package / ADR that addresses it (verified per item at
its build stage / quality gate). **Requirement expansion is now complete — all 36 modules
plus all five cross-cutting sets.**

---

## Stage 8 — Inventory, warehouse, quality — ✅ COMPLETE, GATE PASSED (4 August 2026)

Gate: *physical-to-system and recall proof* — `docs/evidence/stage-8-inventory-recall.md`.

Three modules were built and then put on trial together, following **one batch of chicken
from the supplier's van to a recall** against real PostgreSQL.

- **Warehouse put-away, bins and handheld scanning (M09-FR-01)** — `packages/warehouse/`.
  The handheld's failure shape is the same one the receiving door has: *a movement command
  that is not uniquely identified is a movement that can happen twice.* Stock moved twice
  from a bin that only held it once produces a negative bin, and negative bins are how a
  warehouse stops believing its own numbers. So the duplicate check runs **first**, and
  three refusals follow, each protecting something no later report can reconstruct: an
  **unknown bin is queued, never invented** (*"somewhere near aisle 4" is how stock becomes
  unfindable*), a **full bin is blocked** (the overflow ends up on the floor), and **moving
  more than a bin holds is refused** rather than going negative. Plus one that protects the
  business rather than the data: **quarantined, expired or damaged stock can never be put
  away into a pickable bin** — the commonest route by which bad stock reaches a customer is
  not a decision, it is a put-away. 16 tests.
- **Allocation and inter-store transfers (M09-FR-03)** — a transfer is the one stock movement
  that is in two places at once, and that is exactly where shops lose it. Deduct at dispatch
  and add at receipt with nothing in between and the stock exists **nowhere** for two days;
  deduct only on receipt and it exists **twice**. So it moves through an explicit
  **in-transit state held at the destination**: visible to the receiving branch, owned, and
  deliberately not sellable. **The van is a place.** A **shortfall on arrival is a valued
  exception with a name against it**, never a silent adjustment — stock that left one place
  and never arrived at another is a miscount or a theft, and both need an owner. Scarce stock
  is shared by **days of cover**, not raw shortfall, because 100 units to a shop selling 5 a
  day while a shop selling 50 gets nothing is how one branch drowns while another runs dry.
  Advisory until a person approves it. 12 tests.
- **Cold chain, sampling and quality release (M10-FR-02)** — `packages/quality/`. Cold chain
  is the one control where the damage is **invisible**: frozen goods that sat at 9 °C for
  three hours look exactly like frozen goods that did not. So the evidence decides, not an
  opinion at the counter. An excursion is judged on **duration as well as peak** (a freezer
  door open for ninety seconds is not a breach; four hours is), a breach **quarantines the
  batch automatically** rather than warning someone unloading a van in the rain, the readings
  are **retained for an inspection** because "we checked it" is not evidence, and a
  **missing reading is treated as a failed reading** — a cold-chain item nobody measured is
  not "probably fine". Temperatures are integer tenths of a degree for the same reason money
  is integer paise. 14 tests.

**The gate itself** (`tests/integration/physical-to-system.test.ts`, 10 assertions) proves
both halves against real PostgreSQL:

- **Physical to system.** 240 kg received → put away (with a duplicate scan, a typo'd bin
  and a quarantine refusal all handled) → 60 kg transferred with a **5 kg shortfall valued at
  ₹900.00** → 120 kg sold → a **blind** count returns 57 kg → the counter's self-approval is
  **refused** → the store manager approves with a reason → a compensating adjustment lands
  and the system figure becomes **exactly 57**. And the arithmetic closes:
  **240 = 57 on the shelf + 55 at the branch + 0 in transit + 120 sold + 5 lost + 3
  shrinkage.** Every kilo is somewhere, or it is someone's problem.
- **Recall.** A second batch with **no temperature reading at all** is quarantined
  automatically; the recall then blocks it **at the lane** (from the cached recall set, with
  the network out), **on a transfer** (*"sending it to another branch moves the problem, it
  does not solve it"*) and **in a put-away**; the trace says **48 kg received, 12 kg issued,
  36 kg still in the building**, and names the **one customer who can be telephoned** while
  saying plainly that two were walk-ins who cannot. The recall closes **only with evidence**,
  the record is retained, and the **database itself refuses** the `DELETE` and the `UPDATE`
  that would tidy the events away.

**A defect was found and fixed while building this.** Three shipped source files
(`packages/stock/src/position.ts`, `packages/persistence/src/event-store.ts`,
`packages/import/src/import-job.ts`) contained a **raw NUL byte** used as a key separator.
The code ran correctly and the scanners were never blinded — but git, ripgrep and GitHub all
classify such a file as *binary*, so a change inside `position.ts` (the module that decides
what is sellable) would appear in a pull request as **"Binary files differ", with not one
line shown to a reviewer**. That is a silent hole straight through the review gate in hard
rule #8, and it is invisible precisely because every check stays green. All three now use the
escape, and a **new guardrail** (`tests/guardrails/plain-text-source.test.ts`) fails the
build if any shipped **or test** source ever regains one.

`pnpm check` green: typecheck + lint + secret-scan + **1,005 tests**, plus **16 integration
tests** against real PostgreSQL 16.13.

---

## Stage 9 — POS, returns, cash office — ✅ COMPLETE, GATE PASSED (4 August 2026)

Gate: *end-of-day and refund controls prove out* — `docs/evidence/stage-9-day-close.md`.
**This completes M12, M13, M14 and M15**, and with them the whole store-facing core.

One theme runs through everything built here: **unknown is not a third kind of paid.**

- **Durable suspended bills and quotations (M12-FR-02)** — `packages/suspended-sales/`.
  A cashier parks a basket a dozen times a day, and it is one of the commonest ways a till
  loses money. A basket held in the running program is **gone when the till reboots**, and
  the cashier re-scans forty items from memory — so a suspension is serialised state, and
  the gate test proves it by pulling the power and rebuilding from disk. Resuming is a
  **claim, not a read**: it succeeds once and then names whoever already has it, because
  two lanes resuming one bill is a double charge that both cashiers believe was correct.
  A parked bill **holds no stock** (reserving for it starves the shelf all day), and past
  the tenant's window it **demands a re-price** rather than honouring a promotion that
  ended at noon. Abandonment is kept, never deleted — repeated park-and-abandon is a
  pattern, and a deleted record has no pattern in it. Quotations **move no stock**, hold
  the promised price **only inside validity**, and cannot be used to slip a below-floor
  price past the margin guard — which is checked across the *whole* quotation, because a
  loss-making line hides easily inside a healthy one and the customer only sees the total.
  31 tests.
- **Payment reversal and gateway status (M13-FR-04)** — `packages/reversal/`. This package
  exists to enforce one sentence: **never invent a reversal success.** It breaks the same
  way the tender rule breaks — not by a decision, but by a hopeful default. The provider
  times out, nobody knows, and the easiest code in the world marks it done. Then either
  the customer is told "that's refunded", comes back angry and is refunded again, or the
  reversal worked, the shop thinks it failed, and refunds by hand — **both cost the same
  money twice.** So an unknown answer becomes `uncertain`, and **the only route out is the
  provider's own statement.** There is deliberately no `markSucceeded` anywhere in the
  package, and a test asserts that absence, because the moment one exists somebody uses it
  to clear a queue at 9pm. 22 tests.
- **Settlement import and investigation (M14-FR-03)** — `packages/settlement/`. Two
  distinctions that make the difference between a list somebody reads and a list somebody
  clears. **Late is not lost**: a card tender with no credit is normal at T+1 and serious
  at T+9, so unmatched tenders are aged against the provider's contracted cycle and only
  the genuinely late ones become exceptions. **Fees are not shortfalls**: the bank credits
  net of commission, and reconciling gross against net flags every line. A provider file
  is refused unless its own `gross − fees = net` holds — reconciling against a file that
  does not add up *invents* differences that are not there. Every investigation carries a
  **named** owner and a due date, closes only with an outcome, needs a second person to
  write a difference off, and returns concrete feedback. 23 tests.
- **Cross-domain fraud signals (M15-FR-02)** — coupons, loyalty, cash on delivery and
  supplier invoices: the four places value leaves the business **without a cashier
  touching anything**. Signals carry a graded confidence and the weak ones say so in
  words, because a weak signal presented as strong is how an honest employee gets accused.
  **Nothing blocks, suspends or sanctions** — the A07 agent summarises and prioritises
  only (hard rule #5 / AI-NFR-12), and a test scans the module's exports to prove it. 20 tests.
- **Investigation cases (M15-FR-04)** — a case file is read in two adversarial situations:
  a disciplinary meeting and a court. So evidence is **append-only and sealed** with no
  edit or delete anywhere in the module, every chain break is reported rather than just
  the first, the chain of custody is mandatory (a CCTV clip without one is a video, not
  evidence), and **"unfounded" is a first-class outcome** — a system that only closes
  cases as *proven* quietly pressures people into proving things. Outcomes **measurably**
  tune the rules: a rule that is never right is retired, because after a few weeks of
  false alarms nobody reads any of the alerts, including the real ones. 26 tests.
- **Pending-payment recovery (D04-FR-02)** — `packages/tender/pending-recovery.ts`. The
  card machine does not answer and the customer is standing there. Both obvious answers
  are wrong: assume it worked and the goods leave for nothing; assume it failed and the
  customer is charged twice. So the tender commits `uncertain`, the sale still completes
  locally, and recovery reconciles against the provider's record — where an **incomplete**
  record is not a decline. At close the exposure is **four separate numbers**, not one
  "pending" total: recoverable, unrecoverable (*"treat this as a loss, not a debt"*), owed
  back to customers, and genuinely unknown. 13 tests.

**The gate** (`tests/integration/day-close-honestly.test.ts`, 9 assertions, 30 controls)
walks one trading day against real PostgreSQL: park a bill → **pull the power** → recover
it → refuse the second resume → three sales committed locally and banked → a card machine
that never answered, recovered from evidence → the close **permitted but stated** for
unknown money and **blocked** while a double capture sits unrefunded → a refund that
cannot be invented, cannot be double-issued, and is settled only by the statement → a
provider file refused for bad arithmetic → late told apart from lost → a fraud signal that
acts on nothing → a case on sealed evidence that cannot be closed once tampered with → and
the database refusing to delete any of it.

`pnpm check` green: typecheck + lint + secret-scan + **1,140 tests**, plus **25 integration
tests** against real PostgreSQL 16.13.

> The Stage 8 guardrail earned itself back immediately: while writing the case-evidence
> seal I used a literal control byte as a field separator, and `plain-text-source` failed
> the build within the hour. That is exactly the regression it was added to catch.

---

## Stage 10 — Finance, Tally, owner control — ✅ COMPLETE, GATE PASSED (4 August 2026)

Gate: *the books reconcile and the owner can see why* —
`docs/evidence/stage-10-books-reconcile.md`. **This completes M29** and takes M23 to three
of four.

- **Tally connector, dead-letter queue and period close (M23-FR-04)** —
  `packages/period-close/`. The most important thing about this package is what it is
  **not**: Tally is a **destination, not the book of record.** Our append-only ledger is
  the truth; Tally is where a copy goes so the CA can work in software they already know.
  The failure people actually hit is the reverse assumption — a posting fails, somebody
  "fixes it in Tally", and now two systems disagree and neither knows it. So a failed
  posting **never changes our numbers**: it queues, retries with computed backoff, and if
  it keeps failing it sits in a **visible** dead-letter queue that is read rather than
  drained by deletion. A `duplicate` from Tally counts as accepted — that is the payoff of
  idempotency and it is the case that actually occurs after a timeout. A **rejection**
  dead-letters immediately instead of burning five retries, because a voucher Tally will
  never accept does not become acceptable on the fifth attempt, and retrying it buries the
  one item a human needs to see. A correction is a **new** posting with a **new** key that
  keeps the original failure on file — a dead-letter that vanishes when it is fixed leaves
  no evidence the month was ever wrong. 27 tests.
- **Control totals and the CA's pack** — a period close is the moment the shop says in
  writing what happened last month, and an accountant puts their name to it, so it cannot
  be a button that sets a flag. **Every total is stated twice, from two independent
  sides** — what our ledger holds and what the accounts received — and they must agree
  **exactly**. A close that tolerates a small difference tolerates any difference, because
  nobody ever tightens the tolerance afterwards. The close returns **every blocker at
  once**, because a finance team meeting obstacles one at a time on the last day of the
  month starts looking for a way round the system and finds one. A signed period is
  **never edited**: a reopen needs a separate approver, and a late correction posts into
  the open period as a compensating entry. The evidence pack prints both sides and the
  derivation method for each figure, so the CA signs something re-derivable rather than
  our word — and a pack that does not reconcile is still produced, marked **not signable**,
  saying *"Do not sign them until the differences above are explained."*
- **Owner drill-through (M29-FR-02)** — `packages/owner-control/`. The owner sees "margin
  down 4%" and asks the only question worth asking: *show me.* A drill-through that looks
  right and is wrong is worse than none, because the owner **acts** on it. So the drill
  reaches the **immutable events**, not a summary that can drift; and if the transactions
  do not add up to the number that was clicked, it says so in capital letters instead of
  showing a plausible list. Scope is enforced **and the number changes with it** — a branch
  manager sees a recomputed total plus a line saying what was withheld, because showing a
  company total over a filtered list is how someone concludes their branch is losing money
  another branch actually made. 10 tests.
- **Alerts and the approval inbox (M29-FR-03)** — the failure mode is not too little
  information, it is **too much**: an owner who gets forty alerts a day stops reading
  alerts, and the one that mattered arrives into a habit of ignoring them. Six voided bills
  on one lane is **one** alert with a count and a value, keeping every transaction id for
  the drill. Every threshold is the owner's. The inbox **flags an approval the world has
  overtaken** rather than offering to commit a stale review, and explains every
  non-actionable item instead of showing a button that fails. 17 tests.
- **The daily brief that sends itself (M29-FR-04)** — the roadmap's acceptance is concrete
  and it is the right test: *three days running without anyone sending it*, and *if AI is
  off, the numbers still arrive.* The second half is what systems get wrong, so the
  architecture is inverted: **the numbers ARE the brief; the narrative is a decoration.**
  The figures are composed first and always sendable; the narrative is dropped without
  ceremony if it is absent, unconfident, in the wrong language, or carries no evidence for
  what it claims — and the omission is stated in the brief itself. Tamil and English
  throughout. A missed morning is **carried and labelled late**, never skipped: a brief
  that silently does not arrive is indistinguishable from a quiet day, which is exactly the
  morning you needed it. 15 tests.

**The gate** (`tests/integration/books-reconcile.test.ts`, 10 assertions, 21 controls)
closes one month against real PostgreSQL: totals projected from the database → Tally
accepts one journal and **rejects** another → the close refused **on both blockers at
once** → an unsignable pack → a corrected requeue that keeps the failure on file → a
`duplicate` retry landing **one** voucher → the close, and a **signable** pack → a reopen
refused twice → a correction routed forward → an owner drill reaching the events, a scoped
drill stating what it withheld, and a mismatched headline called out → grouped alerts with
the unvalued one first → a superseded approval → three mornings of brief sent **with no AI
at all** → and the database refusing to delete any of it.

**A defect the gate caught:** alerts sorted by severity then by *value*, so a zero-value
alert always sank. *"Someone signed in at 02:15"* — the most important line on the list —
ranked underneath ₹3,000.00 of voided bills. Ranking within a severity now puts **unvalued
alerts first**, because an alert with no rupee figure is not one worth nothing; it is one
whose risk is not money, and those are precisely the alerts nobody else is watching for.

`pnpm check` green: typecheck + lint + secret-scan + **1,209 tests**, plus **35 integration
tests** against real PostgreSQL 16.13.

### Where this leaves the build

Ten stages, ten gates, all passed, every one proven against a real database rather than
asserted. **Stage 11 is the first genuine stop**: a migration rehearsal needs real export
data from the incumbent ERP (EX-02), and that is a letter to send, not code to write. The
build therefore continues at **Stage 14 (customer commerce)**, which depends on none of it.

---

## Stage 14 (part 1) — Customer and loyalty complete (4 August 2026)

Taken out of roadmap order because **Stage 11 is blocked on EX-02** and everything here
depends on none of it. **M16 and M17 are now complete.**

- **Data-subject rights (M16-FR-03)** — the module where two laws point in opposite
  directions. A customer has a right to erasure; income-tax, GST and company law require
  the shop to keep its invoices for years. **Both are true.** Systems handle this three
  ways and two are wrong: delete everything, which is illegal and the customer's request
  caused it; or delete nothing and say nothing, which is the worse betrayal because the
  customer stops worrying about it. This one **erases what it can, keeps what the law
  demands, and tells the customer exactly which is which and why** — naming the statute
  and the date each record can finally go. Audit evidence is **never** deleted (hard rule
  #6); the person becomes a pseudonym and the trail survives. And verification is checked
  **before anything else**, because an unverified erasure deletes someone else's account
  and an unverified access request hands over their shopping history. 12 tests.
- **Segments and lifetime value (M16-FR-04)** — everything here is a **derived opinion
  about a person**, not a fact, and acting on it changes how the shop treats them. So: no
  profiling without a lawful basis, and a non-consenting customer comes back as
  `not_profiled` **with the reason** rather than vanishing — a campaign whose reach
  shrinks for no visible reason gets "fixed" by someone removing the consent check.
  Service is kept distinct from marketing, so the desk can still answer a customer's own
  complaint. And **value is margin, not revenue**: a ₹50,000 cigarette customer at 4% is
  worth less than a ₹20,000 fresh customer at 30%, and the ranking states both so the
  difference is visible. Historic only — a projected lifetime value is a guess dressed as
  a figure, and shops make real decisions on it. 15 tests.
- **Coupons, offers and referrals (M17-FR-02)** — everything that goes wrong with coupons
  goes wrong the same way: **checked once at issue, never again at the moment it costs
  money.** So expiry, eligibility and both limits are validated **at redemption**, offline,
  against the lane's cached redemption set — and when that cache is stale the lane is
  **told**, because a code used on lane 3 and again on lane 5 ninety seconds later is the
  commonest coupon fraud there is. A referral pays only once the referred person has
  actually bought (paying on sign-up funds an afternoon of fake accounts), and refuses a
  self-referral including the disguised kind where two accounts share a verified contact.
  19 tests.
- **Gift cards, store credit and household pooling (M17-FR-03/04)** — a gift card is **the
  shop's money held on the customer's behalf**, so every issued rupee is a liability that
  must reconcile to what finance posted; a balance that drifts is not a reporting bug, it
  is unrecorded debt. Balances are **projected from append-only movements**, never stored
  and decremented — a stored balance is a number two lanes can race on. Offline redemption
  is **capped, not forbidden**: forbid it and the shop cannot honour its own gift cards
  when the internet is down, which is exactly when a customer is most annoyed. And
  household pooling makes the cross-channel race a **normal Tuesday** — a mother at the
  till and a son on the app spending the same ₹500 — so a double-spend surfaces as a
  valued exception with **both movements kept and both channels named**. Nothing is
  silently reversed (hard rule #10): two people genuinely received goods, and the shop
  decides. 16 tests.

`pnpm check` green: typecheck + lint + secret-scan + **1,271 tests**.

**Still to do in Stage 14:** M20 (customer app and web), M21 (CRM and service desk),
M31-FR-01 with D07–D08, then the gate. EX-04/05 and EX-11 gate delivery and publication,
not the build; **EX-13, an independent penetration test, is a real gate before customer
launch** and needs a paid engagement.

---

## Stage 14 (part 2) — the customer storefront and the service desk (4 August 2026)

**M20 and M21 are now complete.** With M16 and M17 from part 1, the whole customer-facing
side of the product is built.

- **The storefront (M20)** — `packages/storefront/`. The app and the till must sell **the
  same shop** (P-02), and that breaks the same way every time: the storefront gets its own
  product list, its own prices and its own idea of stock, because that was easier than
  reaching into the real one. Six weeks later it is selling something the shop
  discontinued, at last month's price. So this package **holds no catalogue of its own**;
  it applies the lane's own order of checks (recall first), labels stock with its age —
  and treats an **unknown** age as stale, because "we don't know how old this is" is not
  "fresh". Search is typo-tolerant, because a customer who types "aashirwad" and gets
  nothing concludes the shop does not stock it. The cart is reviewed **before checkout**,
  not at the door. An out-of-area address is refused **at the start**, naming the distance
  and the limit, and the delivery fee is stated up front — a charge that appears on the
  confirmation screen is the commonest self-inflicted reason a grocery basket is
  abandoned. And the payment branch that matters is `unknown`: **an uncertain payment
  leaves the order pending, releases nothing for picking, and tells the customer plainly
  not to pay again.** Confirming against money that may not exist means the shop picks,
  packs and delivers goods it was never paid for. 42 tests.
- **The privacy centre** lists **every** category the shop holds, including the invoices it
  cannot erase — a privacy centre showing only the convenient data tells the customer a
  comforting and untrue story about how much is known. A consent switched off applies to
  the **very next message**, not the next batch: "it applies from tomorrow" is how someone
  who just opted out receives one more message and complains to a regulator rather than to
  the shop.
- **Campaigns (M21-FR-01/02)** — the one place a shop can do real damage at scale in a
  single click. Consent is checked **per recipient at the send**, because a list is a
  property of a spreadsheet and consent is a property of a person. The **excluded count is
  always reported**: a campaign that quietly drops 400 people looks like a campaign to
  1,600, and when the reach keeps shrinking somebody "fixes" it by loosening the check.
  A promotion hidden inside a transactional message blocks the whole campaign, because
  "your order is out for delivery" rides the contract rather than consent and is therefore
  the obvious way round it. Journeys wait a quiet period — an abandoned-cart message four
  minutes after someone puts their phone down is not a nudge, it is surveillance.
  Attribution reports the **control group** beside the result: a win-back that "recovered"
  18% when 15% came back anyway cost money to achieve 3%.
- **The service desk (M21-FR-03/04)** — compensation is **money leaving the business,
  handed out by the person the customer is currently shouting at**, so above the agent's
  authority it needs a second signature, below it still needs a reason, and a tenant
  ceiling makes large amounts a management decision. **AI drafts; a named human sends** —
  `approveDraft` is the only route, there is no send function anywhere in the module, and
  a test asserts that absence. Two SLA clocks, deliberately separate: resolution **pauses**
  while the shop waits on the customer (otherwise every slow photo reads as our failure and
  within a month nobody reads the report), while first response does **not**, because a
  desk that resolves everything on time while nobody replies for two days is failing in the
  way customers actually notice. CSAT is reported with its **response rate**: 4.8 from six
  replies out of four hundred cases is six people, and the six who reply are rarely the ones
  who left quietly. 40 tests.

`pnpm check` green: typecheck + lint + secret-scan + **1,353 tests**.

**Still to do in Stage 14:** M31-FR-01 with D07–D08 (customer notifications), then the gate.
**EX-13, an independent penetration test, is a real gate before customer launch** and needs
a paid engagement — it will come to the owner as a decision when the stage closes.

---

## Stage 14 — Customer commerce — ✅ COMPLETE, GATE PASSED (4 August 2026)

Gate: *one customer, end to end* — `docs/evidence/stage-14-one-customer.md`.
**M16, M17, M20, M21 and M31 are all complete.**

Part 3 added the last requirement and the gate.

- **Versioned templates and immutable documents (M31-FR-01)** — `packages/documents/`.
  The rule is one sentence in the roadmap and one of the most commonly broken things in
  retail software: *a template change is a new version, never overwriting issued
  documents.* It breaks because the wrong design is the obvious one — store the template,
  render the invoice whenever someone asks. Then in August the shop changes its address on
  the template, and **every invoice it has ever issued silently changes address too**.
  July's invoice now shows an address the shop did not have in July, and the customer's
  copy and the shop's copy are no longer the same document — which for a tax record is not
  a cosmetic problem. So an issued document is **frozen at issue**: the rendered content is
  stored, the exact version is recorded, reproduction returns the stored bytes, and a
  version any document depends on can never be removed. There is no edit, overwrite or
  delete anywhere in the module, and a test asserts that absence. 17 tests.

**The gate** (`tests/integration/one-customer.test.ts`, 13 assertions, 29 controls) follows
**one person** through the whole customer-facing product against real PostgreSQL: a
misspelled search that still finds the product while the recalled one never appears · a
cart corrected before the payment screen · suggestions withheld for consent **with the
omission stated** · a coupon redeemed offline on a 90-minute-old list that says so, and
refused on the second lane · a household gift card spent at the till and on the app twenty
seconds apart, with **both movements kept and both channels named** · her mother's address
35 km away refused at the start · the delivery fee stated up front · a full slot offering
alternatives · **her bank not answering, so the order stays unconfirmed and unpicked and
she is told not to pay again** · her invoice still showing the old address after the shop
moves · the service desk allowed to look her up to answer her own complaint while the
marketing lookup is refused · a **first-response** breach escalating while resolution is
still comfortably within target · compensation needing a second name · an AI reply nobody
sends · exclusion from the Diwali campaign with the count reported, while her order
confirmation still reaches her · and finally an erasure that names the **Income Tax Act**,
the eight-year period and the **2034-03-31** release date, and says the audit trail *"can
never be deleted by anyone, including us"*.

**The three places this stage refuses to lie:** *"in stock"* that isn't (an unknown
availability age counts as stale, not fresh); *"paid"* that isn't (the `unknown` payment
branch confirms nothing and picks nothing); and *"erased"* that isn't (the letter names the
statute, the period and the release date for every record that survives).

`pnpm check` green: typecheck + lint + secret-scan + **1,370 tests**, plus **48 integration
tests** against real PostgreSQL 16.13.

### The one item left on this stage, and it is the owner's

**EX-13 — an independent penetration test — is a genuine gate before the customer app goes
live to the public.** It is a paid outside engagement, not something that can be built. It
will be brought as a decision with options; nothing else on Stage 14 is outstanding.

---

## Stage 15 — Fulfilment and delivery — ✅ COMPLETE, GATE PASSED (4 August 2026)

Gate: *pick to doorstep* — `docs/evidence/stage-15-pick-to-doorstep.md`.
**M18 and M19 are now complete.**

- **Fulfilment routing and contribution (M18-FR-03)** — the routing decision is made
  **explicitly, with the reason recorded**, rather than defaulting to "the nearest shop",
  which is the rule that quietly sends a ₹200 order on a 9 km round trip. Three things it
  refuses to pretend: **capacity is real** (a slot with eight vans is a slot with eight
  vans, and promising a ninth is a customer waiting in for a delivery that was never going
  to come); **express is a different promise** (it needs stock at that location *now*, not
  "in the chain somewhere" — an express price on a scheduled delivery is a promise the shop
  will break); and a **dark store can never serve a pickup**, because there is no shop floor
  to walk into. An unprofitable drop is **flagged, not blocked** (D09): the shop may well
  want the customer, it just must not take the order believing it made money. 12 tests.
- **Cancellation and substitution (M18-FR-04)** — `cancelOrder` returns **every reservation
  to release as part of the same result**. A cancellation that forgets the release makes
  stock invisible to the shop floor: it shows as unavailable to a walk-in standing in front
  of it, and nobody connects the two for weeks. And **no answer is a no** — a picker
  swapping full-fat for skimmed, or one brand of atta for another, is making a decision
  about someone else's dinner, their diet or their religion, and the substitution people
  remember is always the one they did not agree to. A dearer substitute is charged at the
  **original** price; a cheaper one is charged cheaper and the difference **refunded, not
  kept**. Channel reconciliation runs **both ways**, because the two failures are different
  and a one-way check misses one entirely. 15 tests.
- **Packing and dispatch (M19-FR-02)** — between the shelf and the van there is one moment
  where the shop can still catch a mistake for free. **A weighed line is priced at its
  actual packed weight** (D09): "about 1 kg" of chicken is 1.187 kg, and pricing it later
  means guessing at the doorstep — every guess being either a customer overcharged or margin
  given away. **A missing pack temperature is a failure, not a gap**, the same rule the
  goods-in door applies. **A crate cannot mix frozen with ambient** (that is a wet bag of
  atta) **or raw meat with ready-to-eat food**, and those are refusals rather than warnings
  — but one bad crate never stops the rest of the order, because the customer getting most
  of their shopping beats getting none of it. The manifest is derived from **what was
  packed, never from what was ordered**: a manifest built from the order is a list of what
  the shop hoped to send, and the driver is the one who finds out at a stranger's door.
  16 tests.

**The gate** (`tests/integration/pick-to-doorstep.test.ts`, 11 assertions, 21 controls)
follows one order against real PostgreSQL: routed to the dark store, falling through to the
shop on a full slot, an express promise refused as unachievable · two bags reserved and a
cancelled order's five given straight back · a substitution refused on silence and **refunded
when cheaper** · frozen peas refused in the atta crate while the rest still packs · **1.187 kg
of chicken priced at ₹249.27** rather than guessed · dispatch refused on an unsealed crate and
on an unresolved short line · a manifest built from the pack · both state machines refusing an
out-of-order transition · COD reconciled to the paisa with a short driver as a valued
exception · an unprofitable drop flagged not blocked · the channel reconciled both ways · and
the database refusing to delete any of it.

**A defect the gate caught:** the first version of the gate test called `reserveStock`,
`releaseReservation` and `reconcileCod` with field names those modules do not have. The
modules were right and the test was wrong — rewritten against the real signatures rather
than the other way round.

`pnpm check` green: typecheck + lint + secret-scan + **1,413 tests**, plus **59 integration
tests** against real PostgreSQL 16.13.

---

## Stage 16 — Enterprise modules — ✅ COMPLETE, GATE PASSED (4 August 2026)

Gate: *beyond the till* — `docs/evidence/stage-16-beyond-the-till.md`.
**M22, M24, M25, M26, M27 and M28 are now complete.**

This is the largest single block in the roadmap — 21 requirement rows across six modules,
four of them entirely unbuilt at the start of the session — and it is the point where the
product stops being "a very good till system" and starts being the thing a hypermarket
actually runs on. Six themes, and one idea running through all of them: **the parts of the
business that nobody watches are the parts that quietly go wrong.**

- **The B2B document chain (M22-FR-02)** — quote → sales order → proforma → challan → tax
  invoice, where **each document is derived from the one before it, never from the one two
  steps back**. The failure everybody has seen is the chain drifting: an invoice for 40 cases
  when 38 were delivered, because the invoice was built from the *order* instead of from the
  *challan*. So the tax invoice follows what was **delivered** — bill the ordered quantity
  and the customer is overcharged with a tax document to prove it; bill less and the shop has
  given away goods it will never be paid for. A quotation **draws no number when it refuses**,
  because a gap in a tax-invoice series is a question from an assessing officer with no good
  answer. A proforma carries `taxClaimable: false`, the single most important field on the
  document. 21 tests.
- **B2B collections (M22-FR-04)** — three things a retail ERP usually gets quietly wrong.
  **Ageing runs from the due date, not the invoice date**: an invoice on 30-day terms issued
  40 days ago is 10 days overdue, not 40, and ageing from issue makes every account on terms
  look delinquent — so the report gets ignored, and the genuinely overdue account is ignored
  with it. **A payment is allocated, not absorbed**: ₹50,000 against three open invoices has
  to land somewhere specific, or the shop's "outstanding" and the customer's "what I have
  paid" are both right and they disagree. And **a disputed invoice never becomes a dunning
  letter** — chasing a customer for an invoice they already queried is how a good account is
  lost over ₹4,000. Stopping supply is **recommended, never automatic**: it ends a
  relationship, and date arithmetic must not cut off a school on the morning of a function.
  20 tests.
- **The supplier portal (M24)** — the only place in the whole product where **somebody
  outside the business logs in**, which makes it the highest-risk surface in the repository.
  The risk is not exotic: it is one supplier seeing another supplier's prices. So the partner
  id is taken from the **authenticated session and never from the request**, a request naming
  another partner returns a recorded security event rather than an empty list, and **no
  function in the module accepts a partner id from a payload at all** — asserted by a test
  that reads the module's own exports. Compliance is checked **at the action**, not on a
  nightly sweep, because that gap is exactly where an expired supplier gets a purchase order
  and the shop inherits their non-compliance. Nothing a supplier submits takes effect on its
  own: *the portal is a door, not an authority*. 26 tests.
- **Workforce (M25)** — this module governs people, which changes what "correct" means. A
  roster gap is **named, with the hour** — *"Sunday 06:00 has NOBODY rostered as opener"* —
  rather than averaged into a coverage percentage nobody acts on, and **a leaver still in the
  grid counts as no cover**. A lapsed certification blocks the **task, not the person**:
  someone whose food-handling certificate expired cannot work the deli and can absolutely
  still stack shelves, because blocking the person is how a shop routes around the system on
  a busy Saturday, and **a control people route around is not a control**. A missed target
  pays **nothing** — paying 96% for 96% has redefined the target. And the deliberate
  exception: **labour cost is reported, never enforced**, because a system that refuses a
  fourth cashier creates queues at Diwali. There is no function in the module that could
  refuse a roster on cost, and a test asserts that absence. 31 tests.
- **Facilities and assets (M26)** — a hypermarket is a building full of machines that lose
  money quietly. **Criticality is a property of the asset, not of the alert**, so critical
  assets come back in their own list: a list where the cold room sits beside the shelf trolley
  at the same weight is a list where the cold room gets missed. An expired AMC is reported
  against **what it protects** — *"AMC-14 expired"* gets ignored; *"the cold room has no
  maintenance contract and ₹80,000 of stock sits in it"* gets renewed. M10 assesses the
  **batch**; this assesses the **equipment**, and that difference matters: the store's habit
  is to probe a few batches, and the room is what actually fails — so a breach holds
  everything in it, *including the batches nobody probed*. **A silent probe is a fault, not a
  pass.** Downtime runs from when it **broke**, not from when it was reported. And a missed
  compliance task **escalates by itself**, while cleaning deliberately does not, because
  burying the fire check among forty mop-the-aisle alerts is the same failure by another
  route. 39 tests.
- **Concession and shop-in-shop (M27)** — a counter inside the shop that is **not the shop's
  business**. The mistake that costs real money is boring and universal: concession stock ends
  up in the store's valuation. It is on the store's shelves and moves through the store's POS,
  and one day somebody values the stock for the accountant and ₹40,00,000 of somebody else's
  gold is in it — the balance sheet, the insurance schedule and the tax position all wrong at
  once, and nobody notices because the number *looks about right*. So **ownership is a
  property of the stock and the valuation asks**, and what was excluded is named and valued.
  The money a concession sale takes was **never the shop's revenue**; the deposit is a
  liability projected from movements, with an unapproved forfeit **still a liability**. 30
  tests.
- **Scrap, packaging and sustainability (M28-FR-02/03/04)** — scrap is the one revenue stream
  in most shops with no paperwork and no controls, and because nobody knows what a month of
  cardboard is *worth*, nobody can tell ₹4,000 from ₹12,000. **The control is not suspicion —
  it is making the number exist**, with rate drift measured against the shop's own running
  average and the finding asking about the **rate**, not the person. A carry-bag charge is a
  **visible priced line or it does not exist**. A reusable crate is an asset **in circulation**,
  not a consumable — 118 crates unaccounted for is a number instead of a feeling. And the one
  that matters most: **a fall in recorded waste is not a fall in waste.** A store reports
  "waste down 18%" when the one manager who logged every damaged crate went on leave; six
  months later it believes it controls a problem it has stopped measuring. So every figure
  **carries its coverage on the face of the report**, and a comparison across moved coverage
  says *"we cannot tell"* rather than flattering itself. 29 tests.

**The gate** (`tests/integration/beyond-the-till.test.ts`, 22 assertions, 53 controls,
verified repeatable — run three times, green three times) follows one trading day against
real PostgreSQL through the six things a hypermarket does besides selling at a till: a school
quoted, converted at the quoted price and refused a late re-price, with an invoice that
follows the **van** (₹38,062.50) and not the order (₹82,950) · a 40-day-old invoice aged as 10
days overdue and a queried one never chased · a supplier shown only their own rows with a
rival request refused **and recorded**, an expired licence stopping an ASN at the door · a
statement that reconciles with its dispute separate · ₹4,00,000 of a jeweller's gold kept out
of our valuation and our own manager refused a write-off on it · a cold room holding ₹1,840 of
stock *including what nobody probed* · 47 unprotected minutes counted from the mains failure ·
*"Sunday 06:00 has NOBODY rostered as opener"* · the deli counter blocked but not Raj · one
fire check escalated above 40 mop-the-aisle tasks · a reportable injury refused closure three
times · 118 crates never returned · an 18% "improvement" in waste reported as
`not_comparable` · and the database refusing to delete any of it.

**Two defects found and fixed while building:** `auditPartnerAction` mixed `??` with `||`
without parentheses, which is a **syntax error** in JavaScript, not a precedence subtlety —
the typechecker caught it before a single test ran. And `buildStatement` had a `reconciles`
check that was algebraically always true; it now cross-checks named buckets against the raw
line amounts, so a document kind added later and left uncategorised turns it **false** instead
of vanishing from a supplier's balance.

`pnpm check` green: typecheck + lint + secret-scan + **1,609 tests**, plus **81 integration
tests** against real PostgreSQL 16.13.

---

## Stage 18 — Multi-tenant platform and the innovation wave — ✅ COMPLETE, GATE PASSED (4 August 2026)

Gate: *two shops, one system* — `docs/evidence/stage-18-two-shops-one-system.md`.
**M36 is now complete**, and with it the whole commercial-SaaS layer that OB-01 and ADR-0003
asked for two days ago.

Taken **ahead of Stage 17** for the same reason Stages 14–16 were taken ahead of Stage 11:
Stage 17 needs **EX-12**, a paid model-gateway account, which is a spending decision belonging
to the owner rather than code to write.

- **Plans, entitlements and metering (M36-FR-01)** — the commercial layer on the tenant
  foundation that has been in the code since Stage 5. The design decision that matters is
  about **the edge of the plan**, because that is where a product like this earns a bad
  reputation, and it always happens the same way: a shop hits its lane limit on the Saturday
  before Diwali and the tills stop. That is "upgrade or stop trading" — a commercial decision
  taken automatically, at the worst possible moment, by code with no idea what is happening in
  the shop. So **`mayContinueTrading` is typed as the literal `true`**, not a boolean that
  happens to be true: no code path here, and no future edit to the file, can return false. A
  vendor may withdraw a service; a vendor's software may not close a hypermarket. There is no
  `suspendTrading`, `enforceLimit` or `lockTenant` anywhere in the package, and a test asserts
  that absence. 20 tests.
- **White-label branding (M36-FR-02)** — **one codebase, one deployment, many brands.** The
  moment a customer's branding comes from a code fork the product is finished: every fix
  applies N times, one tenant's urgent patch waits behind another's release, and within
  eighteen months nobody can say which customer runs which version. An unset brand falls back
  to **neutral, never to another tenant's** — a missing logo showing the *previous* tenant's
  mark is a retailer invoicing under a competitor's name, and the neutral default is rebuilt
  fresh on every call so there is no shared object to leak through. Contrast is **blocking**,
  not a note. And a tenant may call a branch a showroom but may **not** rename "tax invoice",
  "GST" or "credit note", because a document that calls a tax invoice something else is not a
  tax invoice — refused at publish *and* again at render, since the two paths are separated by
  a database and a year. 16 tests.
- **Export, closure and upgrades (M36-FR-03)** — this one answers a single question honestly:
  **what happens when a customer wants to leave?** Every vendor says the data belongs to the
  customer; the test of it is what the export actually contains. So an export is **complete or
  it is not an export**, checked against the platform's own declared domain list — which means
  adding a domain to the product without adding it to the exporter turns every subsequent
  export into a *failure* rather than a quietly smaller file. That pressure is deliberate.
  Closure revokes access immediately but mostly deletes nothing, because Indian tax retention
  outlives the commercial relationship, and **audit evidence is never in scope** (#6). An
  upgrade is judged against **who is still calling**, named rather than counted, because "3
  tenants affected" gets deployed on a Friday and "Sri Lakshmi Stores and two others" does
  not. 19 tests.
- **Partner ecosystem (M36-FR-04)** — an ecosystem is **people we do not employ holding
  credentials to systems we are responsible for**, and every rule follows from that. A sandbox
  credential presented against production is refused *and recorded as a security event*,
  whether it was a mistake or not; a production credential in the sandbox is stopped but
  deliberately **not** called an attack, because calling every mix-up an attack trains people
  to ignore the alerts. A partner is scoped to the tenants that engaged them, and an empty
  scope list means **none**, never all. An unversioned call is **refused, not defaulted to the
  latest** — defaulting is what silently breaks a partner on the morning we ship. And
  production data offered as a sandbox seed refuses the whole seed: the temptation always
  arrives with a good reason, and the result is a retailer's customer list on a developer's
  laptop. 17 tests.
- **The innovation wave (D04, D06, D14)** — self-checkout is the one place in a shop where
  **the customer operates the till**, and it sits between two failures. Too suspicious and the
  lane sits empty while the staffed one queues; too trusting and it is a shrinkage hole. So
  every intervention carries **two messages**: a neutral one for the customer in public
  (*"a colleague will be with you"*) and a specific one for the attendant (*"usually a bag or a
  hand on the platform — check, do not accuse"*). Basket-level patterns — five loose-produce
  lines, the banana trick — are scored for the office and **never shown at the lane**. Age
  verification is always a human, with no setting that changes it. And **price integrity**
  across shelf, POS, app and ESL is asymmetric on purpose: a shelf showing *less* than the till
  charges is a **legal** exposure ranked first whatever it is worth, because the displayed
  price is what the customer was offered; a shelf showing more is margin, ranked by value. An
  ESL price push **waits for every label to confirm** before the till may charge the new price
  — fire-and-forget would *create* the exact overcharge risk the audit exists to catch. 28
  tests.

**The gate** (`tests/integration/two-shops-one-system.test.ts`, 20 assertions, 57 controls,
verified repeatable — three runs, three green) puts SRE Hyper Market and Kumar Stores on one
deployment, one binary and one PostgreSQL database: both days banked in **one append-only
ledger under the same stream name**, with only the tenant column separating them · a
cross-tenant row refusing the *whole* result set as a critical defect · the concession module
entitled for one shop, a sales conversation for the other, and a *third* answer for
suspended-for-billing · Kumar's Diwali week at 7 lanes on a 4-lane plan metered at its **peak**
and **invoiced ₹24,000** while `mayContinueTrading` stays `true` · two brands from one binary,
a cross-tenant brand ignored, a new tenant falling to neutral, "tax invoice" refused as a
rename twice over · an export failing on one missing domain and refused entirely on one foreign
file · closure refused before the export and before a name, then retaining tax records to 2034
and audit evidence indefinitely · an API removal **still** breaking after a 14-month window
because SRE is named as still calling it · a partner's sandbox call running **unchanged**
against a real shop · a self-checkout that says *"a colleague will be with you"* while telling
the attendant *"check, do not accuse"* · a ₹4 shelf understatement ranked above a ₹5,000 margin
leak · an ESL silent nine days named by device and shelf · and the database refusing DELETE and
UPDATE on either tenant's rows.

`pnpm check` green: typecheck + lint + secret-scan + **1,709 tests**, plus **101 integration
tests** against real PostgreSQL 16.13.

---

## Stage 19 — Operate and improve — ✅ COMPLETE, GATE PASSED (4 August 2026)

Gate: *the seams hold* — `docs/evidence/stage-19-the-seams-hold.md`.
**M32 is now complete — and with it EVERY module M01–M36 has its foundation built.**

M32 is the safe seams between us and everything outside, and the whole module exists because of
one fact: **at-least-once delivery means every caller will eventually send the same request
twice.** A till on flaky 4G retries a sale it already committed; a payment provider retries a
webhook because our acknowledgement was lost; a partner's cron overlaps itself. None of those
are bugs at the other end — they are the correct behaviour of a network. The bug is ours if the
second copy has a second effect.

- **Versioned APIs and idempotency (M32-FR-01)** — a replay returns **the first answer**, not a
  fresh empty 200. That distinction is the module: an empty 200 leaves the till unable to tell
  whether it worked, so it retries again, which is exactly how a duplicate sale reaches a
  ledger. The digest is over a **key-sorted** body, so a different field order is still the same
  request; the same key with a *different* body is a **conflict**, because silently returning
  the first answer would hide a genuinely lost transaction; and a write with no key is refused
  outright. Webhooks carry **the timestamp inside the signature** — a signature over the body
  alone is valid forever, so a captured "payment succeeded" can be posted back at will. 24 tests.
- **The connector SDK (M32-FR-02)** — the shape the Stage 10 Tally connector proved, extracted
  so every future integration inherits it. What makes integrations rot is not any single failure
  but that failures become **invisible**: an unbounded retry loop looks healthy while nothing
  moves, a dead-letter queue somebody clears on Mondays looks empty, and a mapping that drops
  what it does not recognise looks like a clean run. So an unmapped field is an **exception**, a
  `permanent` error dead-letters on attempt one rather than burning nine retries and burying the
  message that mattered, a `duplicate` counts as delivered, a rate limit **waits**, and **a dead
  letter is read but never deleted** — there is no purge, clear, remove or drop anywhere in the
  package, and a test reads the module's own exports to prove it. 24 tests.
- **Managed secrets (M32-FR-03)** — **no secret ever exists in this module**, and that is a
  property of the types rather than a policy: they carry a vault *reference*, and there is no
  field, parameter or return value anywhere that could hold a value. The reason is the shape of
  every credential leak: nobody commits one on purpose, they add a field "temporarily" or log a
  config object while debugging — and once a secret *can* sit in a variable it will eventually
  sit in a log line, and a log line is copied into a ticket, a screenshot, a chat. **Rotation
  overlaps and revocation does not**, which is why they are two functions rather than one with a
  flag: a hard cut fails every edge device that has not synced, while a compromise accepts that
  breakage and **names its casualties before they happen**. 20 tests.
- **The certified adapter matrix (M32-FR-04)** — an uncertified combination is **refused**
  rather than merely undocumented, and the refusal **names a working alternative**, because one
  that does not is overridden on a Sunday when the shop needs a printer. A payment adapter
  declaring it retains anything outside an **allowlist** cannot be registered at all — an
  allowlist rather than a list of forbidden card fields, so a provider that invents a new one
  next year is refused too. And health is **when it last actually worked**: an adapter failing
  quietly for nine days is enabled and green on any dashboard that reports configuration, and
  that is the normal way an integration dies. 26 tests.

**The gate** (`tests/integration/the-seams-hold.test.ts`, 15 assertions, 48 controls, verified
repeatable — three runs, three green) follows one evening of integration traffic against real
PostgreSQL: a ₹4,120 sale sent three times, the last in a different field order, landing as
**one row** with the first answer returned each time · the same key reused for a different ₹990
sale called a conflict · a retired lane version refused naming where to go · two callers on the
deprecated version **named** · a payment webhook accepted once, its provider retry *not* treated
as an attack, the same delivery captured and posted back six hours later refused as a security
event, and an edited amount refused on signature · a Tally journal refused for an unmapped cess
line and again for an unknown ledger code · a rejection dead-lettered on attempt **one** · a
correction refused for reusing the key and then accepted with a new one while the original
failure stays on file · a queue flagged by **age**, not depth · a payment key 216 days unrotated
reported as *"the key protecting card payments at every till"* · a zero-grace rotation refused ·
a leaked signing key revoked with its two casualties named in advance · a silent shelf-label feed
surfaced · an uncertified scanner turned away **with alternatives** · a payment adapter refused
for keeping card digits · and Tally silent five hours while `canTrade` stays true and
`posUnaffected` is typed `true`.

**Two defects the guardrails caught, both real.** A raw `0x1F` byte got into `api-gateway.ts`,
which would have rendered that file's diff as *"Binary files differ"* in a pull request — a hole
straight through hard rule #8. The Stage 8 `plain-text-source` guardrail caught it, and fixing
it exposed a **worse** problem underneath: the webhook signature was **concatenating** its
fields, which makes it ambiguous and forgeable without the key. Both fixed. Separately, the
card-data guardrail fired on a type that listed forbidden card fields by name; the fix was
better than the original — a **default-deny allowlist** that refuses field names nobody has
thought of yet.

`pnpm check` green: typecheck + lint + secret-scan + **1,802 tests**, plus **116 integration
tests** against real PostgreSQL 16.13.

---

## The four partial rows — three closed (4 August 2026)

With every stage gate passed, the only unblocked code left was the four rows marked *partial*.
Three are now closed; the fourth is partial on purpose and will stay that way.

- **M02-FR-03 — approval delegation.** The manager goes on leave and the shop still needs
  refunds authorised. Every business solves this, and **most solve it by sharing the login** —
  which does not merely break separation of duties, it **erases attribution retrospectively
  and permanently**: once two people use one account, nothing that account ever did can be
  attributed to anybody again. So delegation exists to make the honest route easier than the
  dishonest one. A delegate acts as **themselves**, with the borrowed authority named beside
  their own name on the decision. "Until further notice" is refused as a permanent escalation
  nobody remembers granting. Nobody can lend more than they hold — and an *uncapped* delegation
  from a capped approver would grant **more**, so it is refused too. Chains are forbidden,
  because two hops in nobody can say who was accountable. And a delegation **from the maker**
  is refused by name as *"a self-approval with an extra step"* — the loophole somebody will
  actually try. 25 tests.
- **M23-FR-02 — credit notes, debit notes and returns reporting.** CGST section 34 arrives at
  hard rule #2 independently: **a correction is a compensating document, never an overwrite.**
  So the invoice is never edited, and there is no `editInvoice`, `amendInvoice` or
  `reissueInvoice` anywhere — a test reads the module's exports to prove it. Reissuing an
  invoice at a lower figure is the commonest small-business accounting error there is, and it
  produces an input-credit mismatch that **the buyer's GSTR-2B finds before we do**. Tax
  reverses in the *proportion* it was charged, because reversing the goods and keeping the GST
  survives audits precisely as the document's own totals still add up. A note is declared in
  the period it was **issued**, not the invoice's. And returns are split **by reason**, each
  carrying who it is a conversation with — ₹80,000 of returns is unactionable; ₹52,000 of wrong
  prices at the till is a job somebody does this week. 23 tests.
- **M30-FR-04 — import job history and data-quality scoring.** The failure this closes is quiet
  and expensive: a supplier's price file arriving with 12% of rows rejected **every week for a
  year**. Nobody is wrong — the operator fixes the dozen rows by hand, the import succeeds, no
  alert fires, no report shows anything. The cost is an hour a week forever plus the standing
  risk that one week a row is fixed incorrectly, and it is visible **only as a trend, and only
  if somebody kept the history**. So every job is recorded whether it succeeded or not (a
  history of only the successes is how a file that fails half the time looks perfect), the
  score belongs to the **source** rather than the operator because the fix is at the supplier's
  end, and the quiet cost is stated in **hours a year** — because "12% rejected" sounds
  tolerable and "52 hours a year retyping their rows" does not. 17 tests.

**M02-FR-01 stays partial, deliberately.** Named-account rules, the MFA gate, session and
device binding, bounded offline identity, lockout and access review are all built. Credential
storage and MFA enrolment belong to the deployment identity provider — closing this row would
mean holding credentials in this codebase, which hard rule #4 forbids. It stays open and
honest rather than being marked complete.

`pnpm check` green: **1,867 tests**, plus **116 integration tests** against real PostgreSQL.

---

## Proving the loyalty points against the customers — the sixth and last (7 August 2026)

`packages/migration/src/loyalty-verification.ts`. **All six outside-evidence checks are now
built.** This one is the odd one out: every other domain is proved against a record somebody else
keeps for their own reasons — a bank, a supplier, the department, the CA. **No such record exists
for a customer's points.** The only witness is the customer, one at a time, which makes the
sampling the whole design.

Two facts about customers decide it:

- **The feedback is asymmetric, so complaints are a useless sample.** A customer whose points went
  down complains, loudly, on day one. A customer whose points went up says nothing, ever. So a
  sample drawn from the complaint list is **100% shortfalls by construction**, and it would
  confirm — with real evidence, from real customers — a migration that is systematically
  over-crediting. Refused by name, alongside the §28 refusal of a sample chosen by whoever ran the
  extraction.
- **The loud direction is not the dangerous one.** Understated points are visible, immediate and
  expensive in trust — and *self-correcting*, because a problem that generates complaints gets
  fixed. **Overstated points are silent, permanent and cost real money**: redeemed for goods at our
  cost, never chased by anyone, never discovered. So the silent side sorts first, carries a rupee
  figure at the tenant's own cost per redeemed point, and is **never netted** against the loud
  side — offsetting them turns two problems into none.

The central control mirrors the stock count exactly, for the same reason: **the balance is never
shown to the customer** (`balanceShownToTheCustomer` typed as the literal `false`). Asked *"is your
balance 450 points?"* almost anybody says yes — nobody carries their points total in their head, so
the question measures agreeableness rather than the balance. It is *"expected: 40"* on a count
sheet in a different costume. What is accepted instead is the customer's own figure, or the
activity they actually remember — and *"I don't know the number, but I redeemed against a gas
cylinder in June"* is recorded as **honest and explicitly not agreement**.

Sampling is seeded and three-strata: the largest balances (the points that cost money), customers
sitting on a **tier boundary** (a tier is printed on every receipt and shown in the app, so a
one-point error there becomes the loudest thing in the migration), and a thin random slice of
everybody else — which matters most, because the first two are exactly the accounts a careful
operator would already have got right.

A test caught the strata double-counting: a customer near the tier line who is *also* in the
largest-balance census must appear once, not twice, or the coverage figure overstates itself. The
census wins.

`provesTheBalanceWasEarned` is typed as the literal `false`: award double points by mistake for a
year and every customer confirms the wrong figure cheerfully.

23 tests. Full suite **2,632**.

---

## The page the owner and the CA sign (7 August 2026)

`packages/migration/src/verification-report.ts`. Six checks each produce a verdict and a sentence
of advice. Nobody should have to read six outputs — this gathers them into **one page, in the
language of the runbook**, and a worked example is in `docs/evidence/example-verification-report.md`
so the owner can see the real thing before it matters.

Which makes it **the most dangerous file in the migration**, because a report is what people
believe: nobody re-derives a figure from the modules once a page exists with a signature on it. So
the refusals here are about the document rather than the arithmetic.

- **It cannot be produced from some of the domains.** Render four of twelve and you get a page that
  looks complete — every heading filled, every figure right — and covers a third of the business.
  The missing eight are missing in the only way nobody checks: they are not on the page to be
  looked at. Exactly the failure `completeness.ts` refuses in a truncated export, refused the same
  way.
- **An unproved domain is a row in the same table, in the same type** — not a footnote, not an
  appendix, not silence (P-08). A report listing only what passed is a report that hides its gaps.
- **A proved domain that states no limit is refused.** Every one of these checks has a real limit;
  a blank does not mean there is none, it means nobody wrote it down — and whoever signs then reads
  the evidence as covering more than it does.
- **Each exception is accepted one at a time, by name, by the owner, with a reason.** A single tick
  against *"I accept the exceptions above"* accepts things nobody read. A reason of *"approved"* or
  *"as discussed"* is refused, the same way `cutover.ts` refuses an explanation that explains
  nothing — in two years that sentence is the only record that the owner understood what was being
  carried.
- **Whoever ran the extraction can neither prepare nor sign it**, and signatures accumulate rather
  than being replaced: a signature belongs to the figures that were on the page when it was given.

Four faults found by **reading the rendered page as the owner would**, none of which the assertions
caught — the tests checked that substrings were present, which is not the same as the page being
readable:

- Seven of twelve rows showed a dash, because most domains are not a rupee total. It read as a
  broken report rather than an honest one. Findings now carry a `figureLabel` — *"41,200
  products"*, *"8,940 customers"*.
- Only **one** witness was printed per domain. `ledgers` is checked against the bank, the CA's
  accounts *and* the filed returns; showing one of three understates the evidence behind a figure
  somebody is about to sign for.
- The footer printed raw identifiers — `filed_gst_return`, `ca_prepared_accounts`. The reader is
  not reading identifiers.
- Nothing required a limit to be stated at all, which is how the `provesX: false` discipline would
  have quietly failed to reach the only document anybody outside the codebase ever sees.

25 tests. Full suite **2,673**.

## OB-06 verification gate PASSED — every figure has a witness (7 August 2026)

`tests/integration/every-figure-has-a-witness.test.ts`, **16 assertions, real PostgreSQL 16.13,
three runs green.** All six checks run as one pass over one shop, and the gate adds the two things
no unit test can reach. Evidence: `docs/evidence/ob-06-every-figure-has-a-witness.md`.

**First: it proves every domain has a witness with code behind it.** A unit test can only test the
checks that exist; the failure it cannot see is a domain with a *named* witness and **no module** —
a row that reads as covered and is not. The test walks `VERIFIES` for all twelve domains and
requires a built module for every source named. The map is typed `Record<ExternalSource, string>`,
so **the gate is enforced by the compiler**: adding a kind of evidence without building a check is
a type error, not merely a red test. Confirmed by adding a fictional `insurance_valuation` source
and watching `tsc` refuse it before any test ran.

**Second: it proves the witnesses agree with each other.** Four figures are tied across
independent checks — bank gross across every tender = the filed taxable plus tax (₹75,86,000); the
signed accounts' *Stock on hand* = the counted shelves; *Trade creditors* = the suppliers' own
confirmations; *GST payable* = the filed return. **A wrong number now has to be wrong consistently
in two independent records to survive.** And the ties are proved to be real rather than
decorative: change one day's cash takings by ₹1,00,000 and *two* checks break at once.

**And the gate can say no.** Withhold the physical count and five domains are refused by name as
`verified_by_the_same_system`. A gate that cannot fail has not been tested.

The verified figures are then banked as append-only events **carrying the witness that proved
them** — a number in the opening books whose witness nobody recorded is a number nobody can defend
two years later — and the database refuses to change them afterwards.

Building it cost one guardrail hit, which is worth recording because the resolution was the same
as every previous one: `ai-provider-neutral` fired on the word *"co**here**nt"* in a comment. The
tempting fix was word boundaries in the detector, but `\bcohere\b` would then stop matching
`COHERE_API_KEY` — a real weakening. **The prose was reworded instead.** That guardrail and
`plain-text-source` have now been paid for six times between them.

Full suite **2,648 across 189 files**.

## The six outside-evidence checks — COMPLETE (7 August 2026)

OB-06 said we extract our own data rather than wait for a vendor. The consequence was that
**every opening figure has to be proved against a record somebody outside the old system keeps**,
because a domain verified only against the system it came from is refused by name in
`extraction.ts`. All six now have code behind them:

| Domain | External evidence | Module | The control it stands on |
| --- | --- | --- | --- |
| **Stock** | A physical count | `count-verification.ts` | The counter never sees the expected quantity |
| **Supplier balances** | Their own statement | `supplier-reconciliation.ts` | Nothing is netted; the invoice only they have sorts first |
| **Sales** | The bank statement | `banking-verification.ts` | A commission rate is declared, never derived from the gap |
| **Tax** | The returns already filed | `tax-verification.ts` | No acknowledgement, no evidence; slab by slab, never blended |
| **Books** | The accounts the CA signed | `books-verification.ts` | A balancing figure refused by name, before the balance test |
| **Loyalty** | The customers themselves | `loyalty-verification.ts` | The sample is not the complaints; the balance is not shown |

Each carries a **fixed `false`** naming what it cannot prove — `provesSalesWereComplete`,
`provesTaxWasCorrectlyCharged`, `provesTheAccountsAreRight`, `provesTheBalanceWasEarned`,
`certifiesTheTarget` — so no check can be read as proving more than it does.

The pattern that runs through all six, arrived at independently each time: **an arithmetic that
closes by naming the hole rather than finding it is refused.** A commission derived from the
difference it explains, a tax rate averaged across a mixed basket, a suspense account, a sample
drawn from the people who already complained. Each makes the numbers agree perfectly and proves
nothing, and each is the move a competent person makes under time pressure.

## Proving the opening books against the accounts the CA signed (7 August 2026)

`packages/migration/src/books-verification.ts`. The fifth external check, and **the one that ties
the other four together**: the signed closing balance sheet *is* the opening position. Stock,
debtors, creditors, cash and tax all appear on it, each already proved by its own evidence — so if
the opening trial balance agrees with the signed accounts line by line, every earlier check has
agreed too.

It is also, said plainly in the module's own header, **the weakest of the six as independent
evidence.** The bank statement is an adversary's record. A supplier's statement is a
counterparty's. A physical count is the shelves. The CA's accounts are none of those — they were
*prepared from the same old system we are leaving*, by somebody reading the same reports. What
they add is **a professional signature and the discipline of double entry**, which is a different
kind of strength and not a substitute for the other five. `provesTheAccountsAreRight` is typed as
the literal `false` for exactly that reason.

**The refusal this module exists for: a balancing figure, refused by name.** When an opening trial
balance does not balance, the universal move is to post the difference to *Suspense*, *Opening
Difference* or *Diff A/c* and open anyway. The books then balance **perfectly** and are wrong, and
that account is **never cleared** — it is still there in five years and nobody alive knows what it
was. It is the same failure as a commission rate derived from the gap it explains: the arithmetic
is made to close by naming the hole instead of finding it. Checked **before** the balance test, so
a set of books that closes only because of the plug is never reported as balancing — a test proves
exactly that, on an opening that sums to zero and is still refused.

Three further refusals, each a real trap:

- **Draft accounts are not accounts.** Unsigned figures still change, and the whole reason to
  reconcile to them is that somebody with a licence at stake has signed them.
- **The accounts must end the day before the books open.** A balance sheet is a position at one
  instant; cut over a month later and the opening is out by a whole trading period while looking
  entirely authoritative.
- **What only the CA has must arrive.** Depreciation, provisions, accruals, prepayments and
  drawings exist only in the CA's books — no ERP export will ever contain them. Their absence is
  not a variance to investigate: it is *exactly* the amount by which the books will fail to
  balance, and exactly what would end up in suspense. So it is a precondition, not a finding.

Two defects found by running the tests:

- **The wrong-side check fired on Drawings in a perfectly correct set of books.** Drawings is
  equity by nature and always carries a debit balance; so does accumulated depreciation against an
  asset. The check would have flagged every correctly prepared migration — **and a flag that is
  always on is a flag nobody reads**, which is the failure this codebase keeps guarding against
  elsewhere. `TrialBalanceLine` now carries `contra`, and `expectedSide()` inverts for it.
- A fixture of my own that changed one account and broke the trial balance, so the test was
  exercising the out-of-balance path rather than the account-comparison path it claimed to. The
  interesting case is the one where the books **balance and still do not match** — 50,000 sitting
  in the wrong account — and that is what it tests now.

The subtlest case it catches: **two accounts lost in extraction whose balances cancel.** Debtors
at 8,00,000 debit and GST payable at 8,00,000 credit both go missing, the trial balance still
closes to zero, and nothing whatsoever looks wrong. Only the account-by-account comparison against
the signed accounts finds it.

23 tests. Full suite **2,609**.

## Proving the tax against the returns already filed (7 August 2026)

`packages/migration/src/tax-verification.ts`. The fourth external check, and **the only one that
runs backwards.**

Everywhere else in this migration we are asking whether the extracted figure is right. A filed
return is already true as a matter of law — filed, dated, acknowledged, and impossible to un-file.
So the question inverts: not *"does the return agree with our books?"* but **"what do our books
have to become?"** Where the two disagree, it is the books that are wrong. That inversion is the
whole value of the evidence: a report can be re-run until it agrees, and a filed return cannot be
adjusted to make a total come out. It is why the CA asks for it first.

Four refusals, each carrying its own failure:

- **No acknowledgement reference.** A spreadsheet named `GSTR1_April.xlsx` is a working paper. The
  ARN is the only thing separating what was *filed* from what somebody *prepared*, and those
  differ exactly in the case this check exists to find.
- **Not a whole tax period.** A return covers a month and cannot be cut at a cutover date. A part
  period against a whole return is short by design and reads as missing sales.
- **Superseded by an amendment.** A later period's amendment restates an earlier one; reconciling
  to the original produces a wrong answer with a flawless audit trail behind it — the worst
  combination available.
- **The return's own arithmetic failing.** If the tax does not follow from the taxable value at
  the declared rate, either the transcription or the return is wrong, and reconciling to it would
  spread that error through every opening figure.

**A slab rate is never inferred from a total.** A hypermarket sells at 0%, 5%, 12% and 18% in one
basket; an average is right in total, wrong on every line, and wrong in the one way the department
checks **automatically**, since GST is reconciled rate-wise. The control turned out to be simpler
and stronger than a flag: **an average is not a rate anything could have been sold at.** A books
line at 3.1% is proof on its own that a mixed basket was collapsed, so any rate off the statutory
slabs is refused — and the slab list is per-tenant, because rates move at every budget and this is
not written for one shop in one tax regime (OB-05). A test reads the module's **real exports** to
prove no blended-rate entry point exists; a hand-written list would still pass after somebody
added one.

GSTR-1 is also checked against GSTR-3B, because **the department reconciles those two by machine**
and a difference between them is a notice waiting to happen. Where one already exists it is
reported as **inherited, not created** by this migration.

And the rule with no exception: **a difference against a filed return is a disclosure, not a data
fix.** Somebody signed that return; quietly adjusting our figures to meet it is not ours to do. It
goes to the CA in writing before the opening books are signed.

Written in as a fixed `false`: **a return never proves the tax was correctly charged.** Sell at 5%
what should have been 12% and the books and the return agree exactly, because both record the same
mistake.

23 tests, two of which were strengthened after they passed for the wrong reason — the rounding
fixture happened to land on an exact figure, and the absence check scanned a hand-built object
rather than the module.

Full suite **2,586**.

## Proving the sales against the bank (7 August 2026)

`packages/migration/src/banking-verification.ts`. The third external check and the hardest of the
six, because **gross sales never equal a bank line and everybody knows it.**

Two packages already reconcile money in the running system and neither can answer this.
`packages/reconciliation` matches a tender to a settlement line on a shared provider reference —
for the historic period there are no references, only a daily total per tender.
`packages/settlement` checks the provider's own file, where gross, fees and net are declared and
the arithmetic verifies against itself — for the historic period there is no provider file either.
So the route has to be **reconstructed**: cash lodged in lumps days later after the float comes
out, card net of commission and the GST on the commission, UPI gross on its own cycle.

**The control the whole module stands on: a commission rate is declared, never derived.** Compute
it as `(gross − banked) / gross` and every shortfall becomes commission *by definition* — the
reconciliation then agrees perfectly at any figure and has proved nothing at all. It is the same
failure as verifying a total against the system it came from, which `extraction.ts` already
refuses by name. A test shows both halves: a **₹60,000 hole reconciling to a clean zero** under a
rate fitted to it, and the identical input refused outright once the source is declared honestly.

**Cash is the dangerous direction.** Card and UPI move themselves; nobody carries them. Cash is
the only tender a person physically holds between the till and the bank, and unlike a supplier
balance **there is no counterparty who will ever chase it.** So it carries its own figure, never
merged into a tender total, with the peak standing unlodged beside it — a security number as much
as an accounting one. Cash is also deliberately **not** matched day against day, because
lodgements are lumpy on purpose and a day-by-day comparison manufactures a page of differences
that all resolve to *"it went in on Friday."*

**An unexplained credit is not good news.** Money with no sale behind it is usually somebody
else's and comes back out; migrated as revenue it overstates turnover **and the tax due on it**,
and the correction lands after the return is filed. It sits in the exception list beside the money
that failed to arrive.

Two defects found while building it, both by writing the test that the design implied:

- **The statement-coverage check asked the file whether the file was complete** — it derived the
  span from the first and last credit line, which is the exact move `completeness.ts` refuses. It
  also marked every *correct* statement short, because settlement lags the period start. The span
  is now read off the statement header, and must run **past** the period end: a statement ending
  on the last trading day looks like a perfectly matched pair of dates while missing the batch it
  exists to prove.
- **A tender sitting at nil crashed with a `TypeError`** instead of refusing. Terms were demanded
  only for tenders with non-zero takings, so a nil line reached the arithmetic with no terms
  behind it. Now terms are required for every tender present in the takings at all — reading a
  zero as *"no terms needed"* invents a lag and a commission for it, which is the same
  turn-an-unknown-into-a-clean-result substitution the refusal exists to stop.

Written into the type system as a fixed `false`: **the bank never proves the sales were
complete.** A sale rung up and pocketed at the till reaches neither the old system nor the bank,
and the two agree perfectly about it. Only the shelves speak to that.

26 tests. Full suite **2,563**.

## Proving what we owe against what the supplier says we owe (7 August 2026)

`packages/migration/src/supplier-reconciliation.ts`. The second external check after the shelves,
and **the one that costs nothing to get.** A supplier sending us a statement of what we owe them
is a supplier chasing money — it is the single request in this whole exercise that gets answered
promptly, and it needs nobody's goodwill.

`packages/reconciliation` already matches provider settlement lines to POS tenders on an exact
shared reference. This is a harder problem, because **the two ledgers have no shared key and were
never meant to agree at a point in time:**

> Their statement says we owe 8,40,000. Our books say we owe 7,95,000.
> Neither is wrong. We paid 45,000 on the 29th; they banked it on the 2nd.

So the whole job is telling a **timing difference** from a real one, and the distinction turns on
one fact: a timing difference clears by itself and a real one does not. At migration there is
usually only one statement, so clearance cannot be observed — and the honest output says which
items **cannot yet be told apart** rather than guessing and presenting the guess as a
reconciliation.

Three rules that do not bend:

- **The dangerous direction is theirs, not ours.** An invoice on their statement that is not in
  our books is a liability we are about to migrate as **zero**. It is called out on its own figure
  and sorted to the top of the list, above larger differences that are merely wrong. Overstating
  what we owe gets caught by us; understating it gets caught by nobody until they chase, by which
  time it is in the opening balance and the CA has signed it.
- **Nothing is netted.** *"They say we owe 45,000 more"* and *"we paid 45,000 they have not
  applied"* may be one event or two separate problems. A test proves the point directly: an
  unapplied payment and an unrecorded credit note of the same size give a headline difference of
  **exactly zero** while 90,000 sits unexplained — netted, this supplier reports clean and both
  problems disappear.
- **An `amount_differs` item is never timing.** Both sides hold the document; nobody is waiting
  for the post. It is a price, a quantity or a tax the two of us read differently, and it is
  settled against the delivery note.

Building it caught a defect in my own first draft, and the header of the file had warned about
exactly it. Three of the four statuses carried each item's contribution to *their balance minus
ours*; `only_in_our_books` carried its effect on **our** balance instead. Our payable is their
receivable, and a reconciliation that reads one side backwards balances at twice the true figure —
the same failure as reading a `CR` as positive. One convention now covers all four, so **the items
sum to the headline difference exactly**, and that sum is the test. Reverting the sign to confirm
it: expected 150,000, got 36,000.

A supplier who never replied is listed **by name** as unverified, never quietly counted as
agreeing. Silence is the commonest response to a statement request and the easiest to read as
consent, and the balance it leaves unproved goes into the opening books either way. The owner may
set a tolerance for unexplained difference; there is no tolerance for silence, and none for an
invoice we have never seen.

Full suite **2,537**.

## Proving the stock against the shelves (7 August 2026)

`packages/migration/src/count-verification.ts`. The runbook says *"authorise a physical count"* —
this is the part that makes it affordable and makes it mean something.

`packages/counts` already does blind counting for the **running** system, projecting the expected
on-hand from the ledger. At migration there is no ledger. The expected figure comes from a report
we extracted ourselves, and the question is not *"adjust the stock"* but **"does this figure
deserve to become opening truth?"** Only the shelves can answer that.

**A full count of 14,000 sq ft is one closed evening and most of the staff.** Affordable once,
which is why the temptation is to sample — and sampling is where this goes wrong three ways:

- **The sample is value-stratified, not random.** In a hypermarket a few lines hold most of the
  money. The high-value lines are a **census**; the tail is sampled. A random sample of the same
  size that happened to miss the ghee has verified almost nothing while looking thorough.
- **The person who ran the extraction cannot choose the lines** (§28). Not dishonesty — *the
  lines somebody is confident about are the lines they pick, and that is what confidence does.*
- **The extrapolation is labelled an estimate**, and returns `undefined` rather than a fabricated
  figure when the sample is too thin to support one. A rate from three lines is arithmetic, not
  evidence — the same discipline as `not_meaningful` elsewhere in this codebase. It is never
  added to the measured figure to produce one confident-looking total, because that is the
  presentation that gets signed.

The expected quantity never reaches the count sheet (`expectedQtyShownToCounter` typed as the
literal `false`): a counter shown *"expected: 40"* writes 40, and the exercise then measures their
willingness to disagree rather than the stock. The draw is **seeded**, so an auditor can ask why
this line and get an answer.

Differences are named worst-by-value first and settled one at a time against the shelf, never
averaged away. A count that covers too little of the value cannot support a signature, and says
so.

Full suite **2,519**.

## The export that reconciles perfectly and is a tenth of the shop (7 August 2026)

`packages/migration/src/completeness.ts`. The runbook names this danger for Route B; nothing
enforced it.

**It is dangerous because it does not look like a failure.** An operator opens the stock screen,
sets no filter, clicks Export to Excel, and gets a file. It parses cleanly. Its rows are
well-formed. Its own grand total agrees with the sum of its rows to the paisa. Everything
reconciles — and it holds 4,000 of the shop's 41,200 products, because the grid was paginated and
the export took the page. Nothing downstream can catch it: the cleaning detectors find no faults
because there are none in what arrived, and the control totals reconcile because both sides are
computed over the same short file. **It is internally consistent about a shop a tenth of the real
size**, and the first person to notice is a customer whose product does not scan.

Four signals, checked before anything else reads the file, in order of how much they can be
trusted: a row count taken off the screen; **`Page N of M` — the signal that works when nobody
wrote anything down**, because if the file stops at page 3 while the report says *of 47* no
arithmetic is needed; the end marker, which is printed last; and sequence density.

**Refused, not flagged.** A warning on a truncated export is one somebody clicks past at nine at
night, and the cost of being wrong is a migration redone after cutover.

**`unverifiable` is kept as a distinct verdict from `complete`.** A bare CSV with no page
numbers, no end marker and no declared count has not passed anything — it has failed to be
caught, and collapsing the two is how *"we checked it"* comes to mean *"nothing objected"*.

Two defects my own tests caught while writing it. The end-marker signal was marked always
available, so a plain CSV — which never has one — was condemned as truncated; it is now available
only for a file carrying page furniture, since a signal that condemns every clean export is worse
than no signal. And the sequence density counted repeated identifiers, so a heavily filtered
export looked dense enough to pass; deduped now. The fixture for that test was also wrong in a
way worth noting: it filtered every third *row* while its comment claimed every third *product*,
and a product appears once per location — so it did not test what it said it did.

`compareDoubleKeyed` closes Route D: two typists, two files, every disagreement named as a line
for a person to settle against the page rather than an average to take. `verifiesTheSource` is
typed as the literal `false` — two typists agreeing proves they read the page the same way, and
nothing about whether the page was right.

Full suite **2,504**.

## OB-06 gate passed — the whole self-extraction path, end to end (7 August 2026)

Evidence: `docs/evidence/ob-06-we-get-it-out-ourselves.md`.
`tests/integration/we-get-it-out-ourselves.test.ts`, 16 assertions against real PostgreSQL.

Stage 11 proved the engine against a synthetic dataset in this product's own clean shape. That
was right for the engine and it is **not the shape the data now arrives in**. So this walks the
real path: a dataset we generated — and therefore know the truth about — is rendered back into a
printed report with banner, page breaks, repeated headers and department subtotals, then parsed
with the same parser that will read the real thing, sealed, reconciled and banked.

**The round trip is the point.** With a real file nobody knows what the right answer was. Here we
do: **396 stock rows through 526 printed lines, lossless, every paisa exact** — and repeated at
page sizes 7, 13, 25, 60 and 500, because a break landing between a row and its subtotal is the
case that breaks naive parsers and it has to be exercised where it actually falls. Four tripwires
prove the check fires: a dropped row, a subtotal counted as data, a lost second location hiding
behind a still-present id, and a misread figure with every row present.

**A real limitation surfaced by writing the test, and kept.** The first version invented an
`@MAIN` location suffix for opening state, and the event store immediately refused the second row
for a product stocked in two places — the store being right and my test being wrong. **A printed
stock valuation has no location column.** Opening state built from it is product-level,
deliberately: pretending to a location the source never carried is how a migration produces stock
in a place nobody put it. `cannotYield` now names it alongside batch and expiry.

**And the control the approach rests on held throughout.** Stock verified against another report
from the same product is refused by name; a control total whose two sides both came off the
report is refused; the physical count is accepted; the loader cannot sign it; opening state is
refused before QG-07 and banked as append-only events after. The whole path ran **from a file** —
no connection to the incumbent, nothing of theirs touched, asserted by absence.

Full suite **2,489**.

## Reading what the old system actually exports (7 August 2026)

The self-extraction decision made this necessary. `packages/import` takes clean rows and
validates them; nothing turned **what these systems actually produce** into rows — and what they
produce is not a data file, it is a **printed page that happens to be in a spreadsheet**: the
shop's name, the report title, the date, then the header, then data, then *"Total for GROCERY"*,
then a page break where the header comes back, then a grand total and a print stamp.

`packages/migration/src/report-parser.ts`. Four things in there will corrupt a migration silently
if they are got wrong, and each is a test:

- **`4,12,000.00` is twelve lakh, not four thousand.** Indian digit grouping separates at three,
  then two, then two. Stripping commas happens to work for both conventions, which is exactly why
  it is dangerous: a parser that *validates* grouping against the Western convention rejects real
  files, and one that "corrects" it multiplies a stock valuation by a factor nobody notices until
  an audit.
- **`parseFloat(x) * 100` is wrong, always**, and it is the line everybody writes — 19.99 times a
  hundred is 1998.9999999999998 in every language with binary floats. §29.1 requires integer minor
  units, so the decimal part is parsed **as text**. There is no float in the file.
- **A `Total for GROCERY` line counted as data adds the group's total back into the group** and
  doubles it — reconciling to a number that is plausibly wrong rather than obviously wrong. So
  subtotals are classified *before* anything else.
- **`CR` is negative.** A credit balance read positive inverts every supplier balance and
  reconciles to exactly twice the truth. And a lone `-` is nil — a *number*, which these reports
  print constantly, not a blank.

The header is **found**, not assumed to be line 1: taking the first line on one of these exports
names the columns after the shop. Nothing is dropped silently — every discarded line is returned
with its reason, **including the banner above the header**, because *"where did the other four
hundred rows go"* is asked about the file, not about the part below the header.

The report's own subtotals give a free check that **the reading** was right — and
`verifiesTheData` is typed as the literal `false`, because both sides came from the same system.
That is the comparison `planVerification` refuses. The stock figure is still proved by counting
the shelves.

**The `plain-text-source` guardrail paid for itself a fifth time**, catching a raw non-breaking
space I had written into a character class. Now an escape, with the reason beside it.

## OB-06 — we migrate ourselves (7 August 2026)

**Owner decision, and it corrected a mistake in my planning.** I had been carrying the letter to
the incumbent ERP vendor as an open owner action, listed at the end of every update. The owner's
answer: *"who will give this? no one will be ready to, because they don't want to lose a
customer. Please stop asking — we have to migrate ourselves."*

That is the correct reading, and I should have reached it myself. A vendor asked to export a
customer's data in an open format is being asked to help that customer leave. The request gets
answered slowly, partially, in a format nobody can use, or not at all — and none of those is a
refusal you can escalate. **A plan whose first step is "wait for them" has handed its schedule to
somebody whose interests run the other way.**

**EX-02 is closed.** The drafted letter stays on file; if the vendor ever answers, that is a
bonus and not a dependency.

**What replaces it.** `docs/runbooks/legacy-self-extraction.md` and
`packages/migration/src/extraction.ts`. Four routes ranked by what they *structurally* lose —
read the database directly (complete, including history), the system's own export-to-Excel
(row-level but silently truncated by whatever the screen was filtering), a printed report
(already grouped and rounded; parsing recovers what it printed, never what it did not), and
re-keying, which the software **refuses as a migration source** because a route nobody can re-run
cannot be rehearsed, delta'd or redone.

The boundary is stated plainly: our own data, our own machine, the access we already have. Their
software is not touched — no source code, no decompiling, nothing defeated. There is one question
worth asking the CA or a solicitor once, at leisure, about what the licence says; it blocks
nothing.

**The consequence that actually shapes the design is verification, not access.** With a vendor
file you have their word for what it means. Without one, everything comes from the same system —
and MG-06 already refuses a control total whose two sides were computed the same way. Reading the
stock value off the stock report and checking it against the valuation report *from the same
product* reconciles perfectly and proves only internal consistency. It would be just as
consistent about a wrong number.

So the evidence comes from **outside the incumbent entirely**, and `planVerification` refuses by
name any domain checked only against the system it came from: the bank statement, the GST returns
already filed, the supplier's own statement of account, and a physical count of our own shelves.
Each is a record somebody else keeps for their own reasons.

**This is stronger evidence than a vendor export, not a poorer substitute.** A vendor file is one
system's account of itself. A bank statement is an adversary's.

What the owner obtains instead — bank statements, filed returns, supplier statements, and an
authorised physical count — involves the vendor in none of it.

## Migration and contract tests — the last two empty folders (7 August 2026)

`tests/migration/` and `tests/contract/` were the last two empty folders in the repository
layout. Both found something.

**Migration safety (hard rules #2, #6, #7).** The standing rule — *additive, reversible,
versioned migrations only* — was enforced by discipline, which means it was enforced until the
first evening somebody needed a column gone and the change looked obviously safe. A destructive
migration is not like other bad code: **it runs once, it succeeds, and the data it removed is not
in the diff.** You cannot review your way back to it.

The scanner flagged **migration 0005**, and correctly: it retypes a column and drops a
constraint. Both are actually safe — `uuid → text` is lossless, and the global `UNIQUE (id)` it
drops is replaced in the same file by the wider `UNIQUE (tenant_id, id)` that ADR-0003 requires.
The right answer was neither to weaken the scanner nor to block the work, but the pattern used
everywhere else in this product: a **declared exception with a reason**, kept in the migration's
own header where a reviewer sees it. Two rules keep it honest, and the second is the one that
matters — a flagged statement with no declaration fails, **and a declaration with no flagged
statement fails too**, so the block cannot rot into a blanket exemption somebody copies forward
into a migration that genuinely does drop a column.

The set is applied three times against real PostgreSQL, and the append-only guards are verified
**in the database** rather than trusted because migration 0004 says it installs them.

**Contract tests (P-06, §30.2, §31.1).** The catalogue's conventions were sentences. The one
that earns a test is backward compatibility, because the edge and the cloud are *different
deployments on different upgrade cycles*: **a till offline for three days is running Tuesday's
code, and its sales must still arrive.** A v1 envelope is written out literally — not built by
today's code — and read back; an envelope carrying a field this version has never heard of is
carried, not rejected. Plus: money stays integer minor units on the wire (§29.1), UTC only, and
the catalogue and the code are checked to agree on the named event types.

**A defect in my own test, caught by repeatability.** The first version of the
apply-a-new-migration test used a timestamped probe name, so every run added a row to
`schema_migrations` and the run after it failed. That is exactly the interrupted-deploy failure
the file exists to catch, reproduced in the test that checks for it. Fixed with a fixed probe
name and subset assertions; verified green three runs running.

Full suite **2,411**. Every folder in the `CLAUDE.md` layout now has content.

## Incident runbook and traceability integrity (7 August 2026)

**SEC-10 / PRV-09 / C-05 — the incident runbook was explicitly "to write" and now exists**
(`docs/runbooks/security-incident.md`), with a legal clock attached: CERT-In requires reporting
within **six hours**. The rule the whole document is built around is the one everybody gets
wrong: **the clock starts when you NOTICE, not when you understand.** The universal mistake is to
spend five hours working out what happened, so the report is late and the lateness becomes a
second problem on top of the first. An incomplete report at hour two is correct procedure; a
complete one at hour nine is a breach of the rules about breaches.

Written for 9pm, for somebody who is not a programmer: the first ninety seconds (write down the
time, touch nothing, call two people), containment that does not destroy evidence (**unplug the
network cable, never the power** — a machine switched off to be safe loses the record of what
happened on it), ransomware handled *before* containment because the damage is still spreading,
and the four things that are the owner's personally and cannot be delegated. C-05 moves from
"Not started" to workflow-written; what remains is owner action — the CERT-In contact details
recorded **off-system**, and a named security lead. Three UAT items added (UAT-56…58).

**Traceability integrity is now a test, not a ritual.** After every stage I had been checking by
hand that the traceability counts matched the backlog and that the paths existed. A ritual
somebody performs is one somebody eventually skips, on the stage where they are in a hurry —
which is the stage where it matters. `tests/guardrails/traceability-integrity.test.ts` checks
498 referenced paths exist, that every built row names both an implementation and a test, that
the per-module counts and the headline agree, that no requirement id is duplicated, and that
every gate claiming PASSED has evidence on disk which states a verdict.

**It caught a real defect the day it was written:** `scripts/build-pos.mjs`, renamed to
`build-app.mjs` and never updated — a row certifying a file that does not exist. Five further
paths were written unqualified (`stock/position.ts` rather than `packages/stock/src/position.ts`),
which is exactly how the stale one hid: an unverifiable path cannot be checked. All fixed, and
seven tripwires added proving each check fires on a deliberately broken document — including the
M22-FR-02 trap, where the prose *"a partial delivery bills partially"* reads as a partial row to
any naive substring search.

Also verified while there: **all 498 referenced paths exist**, every package with source code has
tests (the three without any are empty layout placeholders), and **all eight existing guardrails
carry a tripwire** proving they can fire.

## Consolidated cost forecast against D3 (7 August 2026)

`docs/registers/cost-forecast.md` — the record the owner's binding decision of 4 August asked
for: *"if the platform cannot remain within ₹15,000/month, do not stop development — record the
forecast and present one consolidated cost decision at the hosting/procurement gate."*
**Nothing here needs a decision today.**

**The finding is real, not a rounding difference.** `infrastructure.md` was sized to the
superseded ₹20,000 and its range topped out at exactly ₹20,000. Costed properly against the
current ceiling and including the metered lines, the all-managed shape reaches **₹24,500 at its
upper bound — a breach.** Managed PostgreSQL alone is ₹6,000–8,000 and does not shrink.

A single India-region VM running Postgres, Redis and the containers — with object storage and
off-site backups deliberately kept managed, because a backup you also host is not an off-site
backup — costs **₹6,465–12,500 and fits with headroom**, including AI at full R7 usage. That is
the recommendation, and **what it actually costs is not money**: database patching, failover and
restore rehearsal move to D4, the second custodian, whose quarterly rebuild (AID-10) stops being
a drill and becomes the real recovery path. Stated in the decision, not buried in a footnote.

The AI line is the only one with a **measured** basis: 120 calls cost ₹164.40 at the Stage 17
gate, so ~1,200 calls/month at R2 launch is **₹165 (1.1% of the ceiling)** and all ten agents at
R7 is **₹2,470 (16.5%)** — bounded by per-agent ceilings, checked before the call rather than
metered after, and failing safe so the AI stops and the shop does not.

Also corrected: **six documents still carried the superseded ₹20,000** — the infrastructure
design, ADR-0002, the architecture README, the pilot runbook, the store-facts questionnaire and
STATUS itself. A ceiling that appears as two different numbers across the documentation is a
ceiling nobody can hold anyone to.

## Cross-cutting hardening — the deny path (7 August 2026)

Evidence: `docs/evidence/cross-cutting-security.md`. SEC-02/03/12, PRV-03/05/08, §28, hard rules
#3, #5, #6.

`tests/security/` was the last empty folder in the repository layout. Filling it found **two
defects**, both of which had survived because the existing tests checked the reachable path
rather than the refused one.

**A test that proves a manager CAN approve proves nothing about whether a cashier cannot.** That
is the shape of every access-control bug: the allow path is exercised all day by everyone using
the product and is correct; the deny path is exercised by an attacker, once, in production. So
these tests sweep the **complement** — 5 users × 12 permissions × 4 scopes = 240 decisions,
checked against an oracle computed from the role tables **independently of the implementation**,
because an oracle that asks the thing under test is 240 assertions that the code agrees with
itself. Plus the escalations somebody actually attempts: a deleted role, an empty `[]` scope that
must never read as `'all'`, a branch grant reaching a company-wide action, near-miss and
prefix-matched permission strings, and mutating the tables after construction.

**Defect 1 — `minimisePii` was a blocklist wearing an allowlist's name (high).** The module's own
doc-comment and README claimed it minimised *"against an allowlist, so a field invented later is
minimised by default"*. It held a fixed set of seven known PII fields and **passed everything
else straight through** — so `aadhaar_number`, `pan`, `gstin` and `bank_account` reached the
model untouched. Aadhaar is the most sensitive identifier in India. The existing unit test was
titled *"is an ALLOWLIST, so a field invented later is minimised by default"* and asserted only
that the table held arrays: **it named the property and never checked it**, which is precisely
how the blocklist underneath survived review. Fixed by inverting to a genuine default-deny with
business fields opt-in — real friction on callers, and the point: forgetting now loses a field,
which is a visible bug in your own feature, where before it leaked PII invisibly.

**Defect 2 — role permission lists held live by reference (low).** `AccessControl` copied the
assignments array but held roles by reference, so mutating a role's permissions afterwards
widened access. `readonly` stops that in TypeScript and nothing at a JSON boundary, which is
where role configuration arrives from. Two structures where one is defended and the other is not
is worse than either.

**Separation of duties is now swept product-wide.** Every module had its own
maker-cannot-be-checker test, and each proved the rule in one place; none proved it holds
everywhere, which is the only interesting claim. Every self-authorisation point in the product is
now in one list, each run **twice** — allowed with two people, refused with one — because without
the first half a module that simply refuses everything would pass, and a control that blocks the
legitimate path gets switched off within a fortnight. Including the three that get argued about:
the owner approving their own delegation, the owner signing a tax total, and a delegation used to
launder a self-approval.

**Erasure resolves the PRV-05 / hard-rule-#6 tension** per category with the actual statute
named: marketing preferences erased, invoices **minimised** (lines and totals survive, the name
becomes a pseudonym), audit trail retained and stated without hedging. Partial is declared, not
hidden — and where nothing is legally held, everything is erased.

**EX-13 (independent penetration test) is unchanged.** Nothing here substitutes for it: these
tests prove the controls the code implements behave as designed, and cannot find a class of
attack nobody here thought of.

## Cross-cutting hardening — performance shape and accessibility (5 August 2026)

Evidence: `docs/evidence/cross-cutting-performance-and-accessibility.md`. §32, NFR-02, NFR-03,
NFR-07, NFR-13, QG-05.

**Performance measures SHAPE, not speed, and says so.** §32 states its POS targets *"on certified
pilot hardware"* — which is EX-09 and does not exist. A green tick against 300 ms measured on a
CI container would be worse than no measurement: it is the evidence somebody quotes at the pilot
when the lane turns out slow. So `againstBudget()` returns **`certifiesTheTarget` typed as the
literal `false`**, and `certifiedHardwareGate()` records the six items that genuinely need the
store.

What *is* settleable is the part that actually fails in production. Measured at 100× the data:
a `Map.get` grows **1.9×**; a deliberate `Array.find` regression grows **136×**. Two orders of
magnitude, which is why a ratio is assertable on unknown hardware when a millisecond figure is
not. Proven: scan flat across 100× catalogue growth · a miss costs the same as a hit · a
200-line basket linear in its own lines · commit running with `fetch`, `XMLHttpRequest` and
`WebSocket` **removed from the runtime** (hard rule #1, by absence rather than by a mock) ·
commit cost independent of how much the lane has already sold · outbox enqueue and dedupe flat at
100× queue depth · 72 hours of trading held · a 24-hour backlog draining in order, exactly once,
in 24 rounds not 2,400 · a dead-lettered item staying counted (#6, P-08).

**The tripwire earned itself immediately.** The deliberate-linear-scan control first reported
`flat` — which would have meant every complexity assertion in the folder was worthless. The bug
was in the measurement: lookups used `i % n`, so a linear scan found its match at the same
absolute position whatever the catalogue size and never got slower. A performance assertion
nobody has seen fail is an assertion nobody should trust.

**Accessibility found a shipped defect.** The design system has required contrast ≥ 4.5:1 since
Stage 3, and the maths lived privately inside tenant branding carrying luminance **in
hundredths** — matching this codebase's integer discipline for money (§29.1). Luminance is not
money; it is a ratio in 0…1, and two decimal places throws away the resolution exactly where
contrast is most sensitive. **White on `#777777` computed 4.57:1 and PASSED, against a true
4.48:1 that fails AA.** Mid-grey on white is body text, not an exotic edge. Fixed in
`packages/a11y/`: full-precision luminance, rounded once, and the ratio rounds **down** because
the number exists to be compared against a threshold. The fix discriminates — `#767676`, one
step lighter, still correctly passes at 4.54:1 — and `branding.ts` now delegates, so there is one
answer to *"can a cashier read this"* instead of two.

Three design-system sentences that were enforced by nothing are now enforced by code: **colour is
never the only signal** (`presentStatus` throws without a label or icon; no `toneOf()` helper
exists, asserted by test — that helper is how a badge becomes a dot), **touch targets** (WCAG's
24px floor and the design system's 44px bar reported separately, because they are different
claims), and **NFR-13's ≤3 interactions** (steps named rather than counted: *"4 of 3"* starts an
argument, the list starts a conversation about which step to remove). Offline is presented as
**`degraded`, not `error`** — the shop is meant to keep trading (P-01), and a red alarm on the
normal offline state teaches cashiers to ignore the badge.

## Stage 11 — Migration rehearsal — ✅ COMPLETE, GATE PASSED (5 August 2026)

Gate: *the old shop arrives whole* — `docs/evidence/stage-11-the-old-shop-arrives-whole.md`.
**MG-01…MG-12 built and gate-proven against a synthetic legacy dataset**, per the owner's
instruction of 4 August 2026 that EX-02 blocks real-data extraction and **does not** block
synthetic migration testing.

The premise: **a migration rehearsal that only handles good data rehearses nothing.** The entire
cost and risk of a migration lives in the mess, so the fixture is built to contain it — ten kinds
of damage drawn from what a fifteen-year-old standalone retail ERP actually holds, with
`plantedIds` recording **which** records were broken rather than how many. A count lets a test
claim *"found 14 duplicates"* while having found fourteen different ones.

- **Discovery and preservation (MG-01, MG-02)** — discovery is not a technical task. The
  incumbent database is the least dangerous source because everyone knows it exists; the
  migration that goes wrong is the one where somebody mentions three weeks later that the
  loyalty points were on a spreadsheet on a laptop. **A source nobody claims stays named and
  unowned**, and discovery is not complete while one stands. Sealing refuses without a
  **verified backup restore** — a backup job that reports success and a backup that restores
  differ only at the moment it matters. Verification checks the digest **and** the row count,
  because a truncated extract loads perfectly and reconciles a smaller, entirely self-consistent
  shop. 10 tests.
- **Mapping (MG-03)** — the step where a migration quietly acquires a tax bill. Legacy code `TX`
  is on fourteen products and meant something in 2014 to somebody who has left; the convenient
  line is `taxCode ?? 'T0'`, it works, no error appears, and fourteen products are zero-rated
  until an assessment. So **`mapValue` has no fallback parameter** — a caller wanting a default
  must write it in the open where a reviewer sees it. One legacy value mapping to two targets is
  refused **at approval**, not resolved at load. 13 tests.
- **Cleaning (MG-04)** — defined mostly by what it may not do. **Cleaning proposes; it never
  decides.** Nothing merges, nothing is corrected, nothing is dropped — two products that look
  identical are sometimes two products, and an auto-merge loses one silently at 3am. **A merge is
  a redirection, not a delete.** Every finding is kept, resolved or not (hard rule #6); there is
  no `discardException` and no `clearExceptions`, asserted by test. A blocking exception is
  cleared by a **decision**, including *"migrate as is"* — the owner may knowingly accept a
  valuation error, nobody may accidentally inherit one. 19 tests.
- **Trial load and delta (MG-05, MG-09)** — `assertNonProduction` is deliberately a separate,
  callable, testable function rather than an `if` inside the loader: it is the one control whose
  failure is unrecoverable, and the realistic accident is a copied connection string at eleven at
  night. It runs **first**, ahead of the operator's name — every other refusal costs an evening,
  this one costs the shop. A delta re-send is a **success**, because one that errors cannot be
  resumed at midnight. 14 tests.
- **Control totals and opening state (MG-06, MG-08, QG-07)** — one check matters more than all
  the rest: **a total that reconciles because both sides were computed the same way reconciles
  nothing.** The report is green, the CA signs it, and it proves that addition is commutative.
  Identical derivations are refused. The person who ran the load cannot sign its totals — not
  because they would lie, but because they already believe it worked. Finance and tax are the
  CA's. **There is no provisional signature.** And opening balances are **events, never
  balances**: the migration is the one moment when one `UPDATE` would be defensible, which is
  exactly why it must not be — an opening quantity with no event behind it is the one number in
  the shop that can never be explained. 23 tests.
- **History and archive (MG-07, MG-12)** — **age alone is refused as a reason** to leave data
  behind; it is the reason offered ninety per cent of the time and never true. Only an
  owner-approved exclusion may explain a control-total difference. And **retiring the legacy
  system and destroying the legacy data are different acts** — the licence renewal is the
  pressure, switching the server off is the action, and deleting the archive is what quietly
  happens alongside it. 18 tests.
- **Parallel run and cutover (MG-10, MG-11)** — the parallel run is the only step that tests the
  new system against **reality** rather than against itself. *"The new system is probably right"*
  is refused by name: that is last-write-wins with a sentence in front of it (hard rule #10), and
  the stock error it hides surfaces at a count six weeks later. Clean days are **consecutive**.
  And **the rollback is the deliverable, not the cutover** — GO is refused until a rollback has
  been *demonstrated*, because the decision to use it gets made at 6am by a tired person. 20 tests.

**A defect the rehearsal caught in itself.** The duplicate detector first reported **195 findings
against 14 planted, and 182 on a dataset generated clean.** Two causes, neither visible from a
passing test: the generator drew names from ten words and six sizes, so 240 products collided by
construction and a finding could not be told from an accident; and the detector treated an
identical name alone as certainty, which it is not in a hypermarket that also runs a cafe — the
same line legitimately exists as a grocery product and a kitchen ingredient. After both fixes,
**every one of the ten detectors matches its planted count exactly and a clean dataset yields
zero findings.** The second number is the one that matters: a detector that always fires detects
nothing. Three further defects were in the gate test itself, including append-only assertions
that named a table which does not exist — they were passing because a missing relation also
throws.

## Stage 17 — Governed AI agents — ✅ COMPLETE, GATE PASSED (5 August 2026)

Gate: *the AI proposes, people decide* — `docs/evidence/stage-17-ai-proposes-people-decide.md`.
**All ten agents A01–A10 are built and gate-proven, with no AI account.**

Built against a provider-neutral gateway and a deterministic simulator, per the owner's binding
decision of 4 August 2026 (Option A). The one condition on that decision — *switching provider
must remain a configuration and adapter change, never a rewrite* — is enforced by a guardrail
that **fails the build** if a provider name, SDK import, provider-shaped model id or network
call appears outside a declared adapter directory.

The whole stage rests on one premise: **a language model is an untrusted input, not a
component.** Every other module here is deterministic and either succeeds or refuses by name. A
model can be slow, truncated, confidently wrong, or steered by text a stranger typed into a
review. So its output is checked the way the goods-in door checks a delivery.

- **The gateway (A01–A10, AI-NFR-01/02)** — a timeout is an **outcome, not an exception**,
  because a model must never hold a cashier's screen. Malformed output is **refused, never
  repaired**: best-effort parsing of a broken reply is how a half-parsed number reaches a
  purchase order. And the line that matters most — **a proposal for a tool that was not offered
  is dropped and recorded.** Text can persuade a model to *ask* for anything; it cannot make the
  gateway hand over `issue_refund`. 16 tests.
- **Authority (AI-NFR-12, absolute)** — no autonomous payment, refund, purchase commitment,
  price change, stock adjustment or privilege change. Easy to write in a document and hard to
  keep, because the pressure runs one way: every quarter somebody has a good reason why *this*
  agent should just apply the markdown itself. So `FORBIDDEN_TOOLS` is a **closed list with no
  override anywhere** — not a setting, not a tenant option, not a flag — checked at grant time,
  subtracted again at review, and refused **first**. The **human is the actor and the agent is
  the drafter**, because *"the AI did it"* is an audit trail with nobody in it. And **A01, the
  agent closest to the owner, is read-only.** 25 tests.
- **Budgets and kill switches (D3)** — the owner's cost decision as code. Fail-safe means
  something precise and easy to get backwards: **the AI stops and the shop does not.** Every
  agent assists a process that already worked without it, so `shopKeepsTrading` is typed as the
  literal `true` and no future edit can make an AI bill stop a till. The estimate is checked
  **before** the call — metering afterwards tells you what you already owe, which is a report,
  not a control. A tier is **downgraded, never upgraded**. And the kill switch needs **no
  approval**, because one that needs approval gets pulled twenty minutes too late. 22 tests.
- **Injection, secrets and PII (§35, PRV)** — said plainly: **detection is not the defence.**
  You cannot reliably spot hostile instructions; people writing them are trying not to be
  spotted. The defence is **fencing** untrusted content as data, with forged delimiters stripped
  **in a loop** — a single pass lets a split forgery reassemble into a valid fence. The
  scanner's `blocks` field is typed as the literal **`false`**. Secrets are redacted **both
  directions**, the inbound one being the leak nobody expects: a model repeats back what it was
  shown, and the answer lands in a log, a screenshot, a ticket. 19 tests.
- **Evaluation (AI-NFR-03/04/11)** — hallucination is the hardest of the four, because it looks
  exactly like an answer: nothing throws, the sentence is fluent and specific, and the buyer
  orders 400 cases on it. So an **uncited answer scores zero however good it sounds**, *"I don't
  know"* is a **correct answer**, and safety cases return `unsafe` as a **separate verdict from
  `fail`** — there is no partial credit on a case where the agent proposed a refund. An agent at
  99% accuracy with one unsafe case is **not ready**. A regression **blocks the release**. 21
  tests.

**The gate** (12 assertions, 32 controls, verified repeatable) walks a day of agent work. The
hardest case: a hostile customer message whose PII is minimised away and whose forged fence is
stripped, where **the model obeys the attacker** and proposes a ₹50,000 refund and a customer
export — and neither reaches the shop, because neither tool was ever granted. Proven across
**all 12 forbidden tools × all 10 agents**. Plus a tier downgraded rather than overspent, a
ceiling exhausted with the FEFO fallback named, a duty manager stopping the customer-facing
agents at 8pm without approval while the owner's brief carried on, and a suite at 100% accuracy
with one unsafe case refused as unfit.

**A defect the guardrails caught, and it was serious.** A raw control byte reached the fence
delimiter constants. Two consequences: the file's diff would have rendered as *"Binary files
differ"* (hard rule #8), **and the delimiter strip stopped matching the plain text an attacker
actually sends** — so a forged fence survived into the prompt. Found by printing the real output
rather than trusting the test. Fixed with explicit escapes, a unit separator an attacker cannot
type into a web form, and a looping strip that also defeats split forgeries. The Stage 8
`plain-text-source` guardrail has now paid for itself four times.

**What still needs a live provider** is recorded in `liveProviderGate()` — 8 items, every one a
question about what a model *says*, none about what the system *permits*. Notably: *does AI
expiry prediction actually beat the deterministic FEFO rule already built?* If it does not, that
agent should not ship, and only a live comparison answers it. Scheduled to the pre-pilot
integration gate as UAT-49.

`pnpm check` green: typecheck + lint + secret-scan + **1,974 tests**, plus **128 integration
tests** against real PostgreSQL 16.13.

---

## Merchandising and space — and the shelf nobody had counted (6 August 2026)

The rest of M04, built the same day you asked for it: the shelf plan and refill tasks, the range
review, and what each part of the floor actually earns.

### The thing I warned you about, and why it mattered more than I thought

When I deferred this, I said the refill engine needed **how many of each item are actually on the
shelf right now**, and that nothing in the system produced that figure. So I built the counting
first.

What I found while doing it was worse than a missing feature. The refill engine treated a shelf
**nobody had counted** as a shelf that was **empty**. And an empty shelf with stock in the
stockroom is the loudest alarm this system has — *the sale is being lost with the goods in the
building*.

So on the day you switched it on, before anybody had counted anything, **every product in the shop
would have come back as an urgent refill task**, and staff would have been sent to full shelves all
morning.

An alarm that goes off on everything is one people learn to ignore. Then it is worse than no alarm.

Now a shelf nobody has counted says exactly that: **"nobody has counted this — this is not an empty
shelf, it is an unchecked one."** No task, no alarm, no wasted walk.

### Counting, and the two rules around it

**Blind.** The person counting is never shown what the shelf is supposed to hold. Same as the till
drawer, the stock count and the driver's cash. A number on the screen is an answer, and a tired
person at the end of a shift agrees with it. There is no way to show one even by accident — the
software has no function that could return it.

**A count goes off.** It was true when somebody looked, and the shop keeps selling. So every count
records **when it was taken**, and a count older than your own limit raises **no task at all**
rather than sending somebody on a three-day-old reading. Enough wasted walks and nobody believes the
list any more. Your limit is a setting, not a rule I chose — a shop that counts twice a day and one
that counts on Sundays need different numbers.

Counts are **added, never overwritten**. "We counted it at nine and again at two" is the record that
explains a difference; rubbing out the nine o'clock reading destroys the only evidence of what
happened in between.

### The percentage that would have gone on a wall

The screen shows how full the shelves are — but it shows **how much of the shop was actually
counted first, above it**, and it says in plain words that a partial check tells you nothing about
the rest.

A shop where nothing has been counted reports **0%**, not 100%. An empty check is not a clean shop;
it is an unchecked one, and somebody would have quoted the 100%.

And if the shelves cannot be checked at all, it says which of the two reasons: nobody has addressed
the shelves yet, or nobody has published a shelf plan. Those need different things done about them,
and "no problems found" would have read as neither.

### The range

Take an item out of the range and, **if you still have stock of it, it goes to clearance instead of
being deleted.** Deleting it would make that stock invisible — not counted, not replenished, not
sold, and eventually written off. The screen reads your real stock figure to decide; guessing zero
there would have quietly turned every clearance into a deletion.

It also lists where the range and the shop disagree — an item that sold at a store that does not
range it, for instance — checked against **this shop's own till records**, not against the cloud's
idea of what sold.

### The floor

Each part of the shop, ranked by **margin per square foot** rather than by turnover. A big seller on
a thin margin can be the worst use of space in the building while looking like the best.

An area whose square footage nobody has recorded says **"not measured"** rather than showing zero,
because "this area earns nothing" and "we never measured this area" lead to opposite decisions.

And supplier display space: the finding that matters is an **expired contract with the stand still
on the floor** — the supplier stopped paying, nobody took the stand away, and the shop is giving
away its best space.

**Tests:** 3,849 automated plus 31 performance, all green — 87 new.

### What the owner should check, in the store

1. Open the merchandising screen before anybody has counted anything. **The refill list must be
   empty**, and it must say the shelves have not been counted. If it lists the whole shop, tell me —
   that is exactly the fault I found.
2. Count one facing. The screen must **not** tell you what it should have been, before or after.
3. Now look at the refill list. Only that one item can appear.
4. Leave it a few hours past your counting limit and look again — it should go quiet, because the
   count is too old to send somebody on.
5. Take an item you still have stock of out of the range. It must go to **clearance**, and say how
   many are still on hand.

### Two things I need from you

- **How long a shelf count stays worth acting on.** I have used two hours as a starting figure.
  Tell me what suits how often your staff actually walk the shop.
- **How empty a shelf has to be before it is worth a trip.** Starting figure is half empty.
  Refilling at 90% wastes the day; refilling at nothing means the customer already found the gap.

---


## Shelf addresses — and the picker's walk nothing had ever sequenced (6 August 2026)

Built on your decision: **option 2, shelf locations before go-live.** Planograms and supplier
display space are deferred to after go-live, with that written down rather than forgotten.

### The thing I expected to build, and the thing I actually found

I expected to build the screen where somebody says which shelf an item lives on. That is built.

What I did not expect: **the piece that puts the picker's list into shelf order already existed,
had its own tests, and nothing in the entire system had ever called it.** So every picking list was
walked in whatever order it arrived — which, for an online grocery order, is the order the customer
typed it: milk, rice, back to milk.

That is the third time this session. The rule was written, the rule was tested, and the wire was
never connected — and nothing failed, because nothing was watching.

The store computer now puts the list in shelf order before the handheld ever sees it. On the box,
not in the cloud, so a dead router does not put the pickers back to walking the shop twice.

### And a second one, inside the rule itself

Every shelf can be marked ambient, chilled or frozen, and the note next to that setting has said
since the day it was written that **a picker collects chilled last**. The sorting code never looked
at it. The setting was decoration. A chiller that happens to sit near the front of the shop was
picked first, and the milk was then carried round the whole store.

Fixed. But **the order is yours, not mine.** I have not put a cold-chain order into the software.
Which zones your shop has, how far apart they are and how long chilled goods may stand out are
questions about your premises and your licences, and guessing would have been silent — the route
would look perfectly sensible and the milk would just be warm.

So: if you tell the system the order, it uses it. If you do not, it sorts by position only **and
says so on the picker's screen**, so nobody walks a list believing it is cold-chain ordered when
nothing ordered it. There is a test that stops anybody adding a default later.

### An item with no shelf address

It goes **last**, and it is marked on the handheld, and it is named on the product screen.

Hiding it would send the picker back across the shop. Dropping it would lose the line. Neither is
acceptable, and the person who can fix it — by giving it a shelf — is exactly the person reading
the product screen.

### One item, one home

If somebody tries to give an item a second shelf, it refuses and names the shelf it is already on.
Two homes means the picker's route and the refill task disagree about where a thing is, and then
**both** are wrong.

And if the data arriving from head office contains that contradiction, the **one bad row is
dropped** rather than the whole shelf map. Refusing the lot would report every product in the shop
as having no shelf address, which reads as the shelf data having been lost.

### Small thing that matters more than it looks

Shelf addresses are stored as **numbers**, not as labels like "A10". As text, "A10" sorts before
"A9" — so a picker would walk up the aisle, back down it, and up it again, and would never work out
why.

**Tests:** 3,755 automated plus 31 performance, all green — 30 new.

### What the owner should check, in the store

1. On the product screen, open **Shelves**. It should list every shelf address the shop has and,
   underneath, **the order a picker would walk them**. Put an item on a shelf and watch that order
   change.
2. Look at **Items with no shelf address**. Those are the ones costing walking time today.
3. Give a picker a real order with a chilled item in it. The chiller should be the **last** thing
   on their list — and if it is not, tell me the order you want your zones collected in and I will
   put it into your settings.
4. ~~Tell me the zone order for the shop.~~ ✅ **Answered 6 August 2026: ambient, then the secure
   cabinet, then the chiller, then the freezer** (OB-07). In the shop that means a picker clears the
   dry aisles, opens the locked cabinet once, then takes the chiller and the freezer last — so what
   spoils fastest spends the least time out of temperature. Recorded as SRE's own setting, not as a
   rule in the software: the next shop we sell this to answers for itself, and one that has not
   answered still gets a list in shelf order only with the handheld saying so. **Proved, not just
   filed** — there is a test that runs your order through a shop laid out to defeat it, with the
   freezer nearest the door and the dry goods furthest away.

### What is deferred, and what has to happen before it can be built

**Planograms, shelf compliance, refill tasks and supplier display space (M04-FR-03/04)** — target
**R3, after go-live**, per your decision.

Worth knowing for when it is picked up: the refill-task engine is written and tested, and it needs
**how many of each item are actually on the shelf right now**. Nothing in this system produces that
figure yet. Building the screen today would give it nothing to read. Whoever picks this up starts
with the shelf count, not with the planogram.

---


## Products and prices — the price nobody had ever made (6 August 2026)

The shop can now create an item and set what it sells for. Until today it could do neither.

### What I found while building it

Everything that *polices* a price was already here and tested — the MRP ceiling, the minimum
margin, the effective dates, the full history, the price list that goes down to the tills. And
**nothing in the whole system had ever produced a price.** Every price in the code was a made-up
one written for a test. So the piece that sends prices to the tills had never had a real price to
send.

Same as the supplier invoice last time: every rule built, the join missing, nothing failing to say
so.

### The one refusal nobody can overrule

**A price above the MRP printed on the pack is refused, and there is no approval for it.** Not the
owner, not a written reason, not a "just this once" button. MRP is the law in India, not a shop
rule, and a screen offering a way round it would be offering to break the law with a record proving
we meant to.

There is also a check in the tests that **no such button ever gets added** — because a helpful
little override is exactly the thing somebody adds on a busy Friday.

And it reads **today's** MRP, not the newest one on file. If a price increase is recorded for
December, the customer in front of you is still holding the pack printed at the old price.

### The margin check, and the thing that would have silently defeated it

To know whether a price makes money, the system needs to know what the goods cost. If it does not
know, the tempting thing is to treat the cost as zero — and then **every price looks like a 100%
margin** and the check passes cheerfully at exactly the moment somebody is relying on it.

So an unknown cost is its own answer: *nobody can say what this price earns*, and it goes to a
second person to approve with their eyes open. The store computer also sends **no cost at all** for
an item it has no cost for, rather than a zero.

### The two limits are on the screen before you type

The MRP printed on the pack, and the lowest price that still keeps the shop's margin — both shown
as soon as you pick an item. A screen that only says "rejected" afterwards teaches people to guess,
and guessing at a legal limit is how this goes wrong.

### A price change never overwrites the old price

It adds a new one. The old price stays exactly as it was, with the date it ran from and who changed
it. A receipt printed last Tuesday has to stay explainable, and an overwritten price explains
nothing. Withdrawing a price also adds a record rather than rubbing one out.

**And a price cannot start before today.** Back-dating would change what yesterday's sales should
have charged — the receipts and the reports would stop agreeing and nobody could say which was
right.

### "How finished is this item?" — counts, not a percentage on its own

For each item the screen says **four of seven things needed are done**, then the percentage, then
every missing thing by name in plain words: *no HSN / tax code*, *no allergen declaration*, *no pack
size*. A bare "57%" gets put on a wall and argued about and nobody can say what the other 43% is.

**What counts as finished is your decision, not mine.** Which fields a department needs, and which
departments are food or age-restricted, come from your own settings. The law's fields (allergens,
country of origin, net quantity, packer details) are only asked of the departments you have declared
regulated.

And an item in a department the screen has not been told about says **"this item cannot be checked"**
with the reason — not 0%, which would read as *somebody has filled in nothing* and send a person to
fix a record that may already be perfect.

### Also on the screen

- **Stop selling this everywhere** — two taps. Stops the till and the customer app at once, and
  keeps working with no internet, because it travels with the price list.
- **Possible duplicates** — two records for the same barcode are listed for somebody to look at.
  Nothing is ever merged automatically.
- **Offers** — type the normal price, the offer price, what it costs and how many you expect to
  sell, and it tells you what the offer costs you and how many extra units it would take to break
  even. An offer that loses money can still run, but somebody else has to approve it **and write
  down why**, in a sentence readable next year.

**Tests:** 3,725 automated plus 31 performance, all green — 93 new.

### What is NOT in this screen, and needs your decision

**Shelf planning and space** — planograms, which shelf an item lives on, sales per square foot, and
display space a supplier pays for (M04). The rules are built and tested; there is no screen. The
roadmap marks these **P2** and asks you directly whether they are in scope for the first store.

Three options, and I need one of them in writing rather than silence:
1. **Defer to R3, after go-live.** Cheapest now. Shelf locations then stay as they are, which means
   the picker's walking route is ordered by whatever we import rather than by your real aisles.
2. **Build shelf locations only, before go-live.** Roughly a session's work. It is the half that
   makes the picker walk the shop once instead of back and forth — the audit called that out as a
   real cost.
3. **Build all of it, including planograms and supplier display contracts.** Several sessions, and
   most of it earns nothing until the shop is trading and has sales history to measure space by.

**My recommendation is option 2.**

### What the owner should check, in the store

1. Open the product screen and look at the list. It should say, item by item, **how many things are
   still needed** before it can be sold — and the ones needing least work should be at the bottom.
2. Pick a real item and try to price it **above the MRP printed on the pack**. It must refuse, and
   there must be no way to make it accept.
3. Try pricing something **below cost**. It should refuse until somebody else approves it, and it
   should ask that person to write down why.
4. Tell me **the minimum margin** the shop will not go below, and **who may approve** going below
   it. Until then the screen says so plainly on the page and refuses.

---


## Every screen now really does open without a network (6 August 2026)

Six screens each shipped with the piece of software that is supposed to make them work with no
internet. All six were written correctly. **Five of them were never switched on** — nothing in the
app ever asked the browser to use it, so nothing was ever kept, and every screen fell back to its
demonstration data the moment it could not reach the store computer.

At the goods-in door and in a delivery van, that is most of the time.

### Why simply switching them on would have made things worse

These screens are handed the shop's own figures inside the page. So a screen that reaches for its
saved copy first is a screen reaching for **saved figures** first — this morning's exception list
handed over as this minute's, quietly, by the one part of the system nobody was looking at. A
manager could have closed a trading day on it.

So it works the other way round. **It always asks the shop first.** Only when there is genuinely no
answer does it use what it kept.

### And when it does use what it kept, it says so

A blue strip across the top of the screen, in English and Tamil, saying **this is what this screen
was last told, and at what time** — in your own local time, because the person reading it is
standing in the shop.

That strip is the whole point. Keeping a copy of a page is easy. Keeping a copy and letting
somebody believe it is live is how a day gets closed on figures from three hours ago with nothing
anywhere saying so.

**The till says something different on purpose.** It says *"No connection to the store computer.
Billing still works."* — because it does. A lane sells against its own disk, not the network, and a
strip that only said "no connection" would stop a cashier who could have carried on serving people.

### Two more faults, found by writing the check rather than by reading the code

- **The picker's handheld and the driver's phone were sharing one storage name.** Each one clears
  out anything that is not its own, so served from the same store computer they took turns wiping
  each other. Neither would have opened offline reliably and nobody could have said why.
- **`/pos` — without the slash on the end — was served cheerfully and completely broken.** The
  browser then looks for the app's programme file one folder too high, does not find it, and you
  get a blank screen with nothing saying anything at all. Now the box sends you to `/pos/` first.
  Proved for every screen, over the real socket.

### What is not in this cache, deliberately

Prices, figures, waves, routes and orders are never kept as facts. What is kept is the page, the
view and the programme file — the parts that only change when we deploy a new version. The lane's
own sale path never touches this at all: a sale is still written to the till's own disk before the
receipt prints, and that is refused out loud if the disk does not answer.

**Tests:** 3,631 automated plus 31 performance, all green — 27 new (19 guarding the decisions
above, 8 driving the redirect and the workers over the real socket).

### What the owner should check, in the store

1. Open the till, then **unplug the store computer's network cable** (not the till's own box). The
   till should still open, still scan, still take money — and show a blue strip saying when its
   price list was last given to it.
2. Do the same on the picker's handheld and the driver's phone. Both should open. Both should say
   when they were last given their work.
3. Plug it back in and reload. **The blue strip should disappear.** If it does not, tell me — that
   means it is showing you a saved page when a live one was available.
4. On the manager's screen, confirm the blue strip says **do not close the day on it**. A day must
   never be closed on a saved page.

---


## Purchase and receiving — the eighty lines nobody has to retype (6 August 2026)

The audit found it a year ago and called it *line-by-line invoice pain*: somebody in this shop
retypes an eighty-line supplier invoice into a computer, by hand, every week. Everything needed to
stop that was already built and tested — and **nothing anywhere captured a supplier invoice**, so
the check that compares the order, the delivery and the invoice had nothing to compare and refused
every single time. Correctly, and uselessly.

That is now a screen. Paste the supplier's file, see what is wrong, get it checked by somebody
else, save it in one go.

### The control that makes this safe rather than just fast

**You type the total off the bottom of the supplier's paper.**

It is the only figure in the whole flow that does not come out of the file, and that is exactly
why it earns its place. If the supplier's file is missing a line, every remaining line is perfect —
nothing else in the system can possibly notice. The printed total notices.

It has been proved that way round: a file where every line is correct and the total is short by one
line previews with **no problems at all** and is still refused, by name, saying either a line is
wrong or a line is missing. Both mean paying something other than what was agreed.

**And each line is checked against itself.** Quantity × price each must equal the line total printed
on the invoice. A mistyped quantity is invisible in a column of numbers and obvious the moment those
three are multiplied — and it is the commonest typing mistake there is. When it finds one it tells
you **the line number on the paper**, so somebody can go and look at it rather than hunt.

### It is all of it, or none of it

Seventy-seven of eighty lines saved is an invoice in the system that matches no piece of paper
anywhere, and nobody can afterwards say which three are missing. So it saves the whole invoice or
it saves nothing.

**And the save button does not exist on the page until the check has passed.** Not greyed out — a
greyed-out button is something people keep clicking. Absent, so the only thing to do is go back and
look at what is wrong.

### Nobody signs off their own work

The person who captured the invoice cannot be the person who approves it. That is roadmap §28, and
it is enforced in two places on purpose: **the screen is never even given the buyer's own name to
pick**, and the model refuses their approval anyway if it somehow arrives. Offering somebody a name
and then rejecting it would be the worse of the two.

### The fault my own test caught before it shipped

The comparison built its list of things to check from all three documents at once — what was
ordered, what arrived, what was invoiced. So an invoice **nobody had captured** still produced rows
saying "invoiced: none, nothing to pay, nothing held back", and came back **not blocked**.

Which is true, and useless. The engine already refuses to call an empty comparison an agreement —
and my screen defeated that guard from the outside by handing it lines it should never have had.

Three documents cannot agree when we are holding two of them. It now passes nothing through, and the
engine's own refusal fires: *nothing has been compared* — a different sentence from *these agree*,
and only one of them is a reason to pay somebody.

### When the box has not been told something, it says so

Every gap here already fails the safe way — if the box has not been sent the purchase orders, every
invoiced line looks like something nobody ordered, and nothing gets paid.

That is safe and it is still not honest enough. *"This was never ordered"* looks identical whether
the supplier invented the line or **we simply never sent the order to this screen** — and only one
of those is an argument to have with a supplier. So the screen names what it was not told, in a
sentence, in English and Tamil, at the top of the page.

### One rule now lives in one place

The comparison rule was sitting inside the purchase service, next to server code a browser cannot
load. The two ways forward were to copy it into the screen or to move it somewhere both can reach.

Two copies of *"what may we pay this supplier"* is one of them being wrong, and you find out when a
supplier is paid one figure by the screen and reconciled against another by the books. So it moved.
One rule, both places.

### Something I found on the way

Building the offline side of this screen turned up that **five of the six apps have a service
worker that nothing ever registers.** The file that is supposed to make a screen open with no
internet was written, is correct, and was never switched on. Only the owner's phone registered its
own. It failed visibly rather than dangerously — a screen with no network fell back to its sample
data and said *"Sample data — this is not your shop"* across the top — which is why it survived
three sessions unnoticed.

Fixed for the back office in this commit, and **for all six in the next one** — see *Every screen
now really does open without a network*.

**Tests:** 3,611 automated plus 31 performance, all green — 64 new (25 on the invoice rules, 12
driving the real screen over the real store box, 27 guarding the decisions above).

### What the owner should check, in the store

1. Open the buyer's screen and ask for a supplier's file **in a plain file** — most suppliers can
   email one, and it is the difference between eighty lines typed and eighty lines pasted.
2. Take a real supplier invoice. **Type the total off the bottom of it**, paste the lines, and press
   check. Then try it again with the total deliberately ₹100 out and confirm it refuses.
3. Confirm the person who captures an invoice is **not** in the list of people offered as the
   approver. If they are, tell me — that list comes from the store's own configuration.
4. Tell me who in the shop may approve a captured invoice, and who may approve a purchase order.
   Until I am told, the screen says so plainly and refuses to save anything.

---


## Route planning — the van now knows where it is going (5 August 2026)

The last named gap in delivery. Until today somebody had to write out the driver's route by hand.

### The part that was actually broken

It was not just the handwriting. The end-of-shift check that asks *"did every order the driver took
out get delivered?"* was being handed **an empty list of what he took out**. So every single
delivery he genuinely made came back flagged as *a delivery nobody dispatched* — which is the alarm
that is supposed to mean **goods left the building against an order nobody planned**.

An alarm that goes off on every normal delivery is an alarm people learn to ignore, and then it is
worse than no alarm at all. It is now quiet on a normal day and still loud on a real one — proved
both ways.

### What the box does now

It takes today's confirmed deliveries and who is driving, and it plans the runs. Nearest first from
the shop, and it fills one driver before starting the next.

**And it does this on the box in your back office, not in the cloud.** A shop whose routes could
only be planned when the internet was working would stop delivering on the afternoon the router
dies — which is exactly the day it can least afford to.

### What I will not let it pretend

**These are straight-line distances.** There is no map in this software, no roads and no traffic. It
measures as the crow flies. If there is a river or a railway line between two houses, the order it
picks is wrong.

So it says so — every plan it produces carries the words "straight line" in the result itself, not
buried in a comment, so any screen showing a distance has to admit which kind it is. **It is a
draft for a dispatcher to confirm, and it never calls itself the best route**, because it cannot
work that out and software that claims it anyway hands a driver a schedule that was never possible.

### The rule that matters more than the route

**Every order goes somewhere.** Onto a run, or onto a "could not be planned" list with the reason
written for a person. Never both, and — the important half — **never neither**.

A stop that quietly disappears is not an inefficiency. It is a customer who ordered, paid, waited,
and was never told anything, and they find out because nothing arrives. So the count is checked
against what went in, and there is an automatic check that no path in the planner can drop an order
without writing down why.

The reasons it gives:
- **No address on the order** — somebody has to add it; guessing a location is worse than saying so.
- **Outside the delivery area** — it should not have been sold as a delivery. Tell the customer
  today, not at the door.
- **Everybody's day is full** — a real answer that needs a person, not a longer route.
- **Nobody is on shift for that time slot** — put somebody on, or ring the customer and move it.

And **an order it could not plan appears on the manager's exceptions**, so the day will not close
while somebody's shopping is still in the building and nobody has told them.

### Three smaller decisions worth knowing

- **The promised time beats the shorter route.** If a customer booked five o'clock, their order is
  not moved to eight because it was geographically convenient. A shorter route and a broken promise
  — only one of those shows up on a screen.
- **A stop that will run late is flagged, and still delivered.** It is a phone call, not a reason to
  quietly not deliver somebody's shopping — and it is flagged while the van is still in the yard,
  which is the only moment anybody can do anything.
- **You can still overrule it.** If you know the bridge is shut, write the route by hand and the
  screen uses yours — and it tells the driver which of the two he is holding. Software that cannot
  be overruled just gets worked around, and then there is a piece of paper that disagrees with the
  screen.

**Tests:** 3,547 automated plus 31 performance, all green.

**What is left:** a real map. If routes ever matter more than a draft is worth, the thing to buy is
road distances from a maps provider — and that is a cost decision (D3), not a code one.

---

## The store box now feeds all six screens — and the day close closes (5 August 2026)

This is the one that joins everything together.

### What was actually wrong

Every one of the six screens was built to be handed its information when it opens. **Nothing had
ever handed it anything.** So all six sat there, correctly and uselessly, saying *"I have not been
told anything"* — and the manager's day close refused to close, every time, exactly as designed.

That was the right behaviour and I said so each time. But it meant six finished screens and no
system.

### What the box does now

The store box in your back office serves all six screens, and it answers from two different places:

- **From its own disk** — every sale rung at every lane. It wrote them, so it can answer without
  asking anybody. This is why the screens work with the internet down.
- **From the last pack the cloud sent** — the product list, who is waiting on an approval, today's
  checklist, the picker's wave, the driver's route.

And it always says **which of the two** an answer came from. If the cloud has never told it
something, it says so rather than saying "none".

### The day close now closes

The two things the day close checks — is anything unresolved, and has everything reached the cloud —
finally have somewhere to come from. **The unsent count is the box's own queue**, which is the only
honest source there is: the cloud cannot tell you what has not reached the cloud.

And the exceptions are worked out **on the box, from the day's own takings**, against the limits you
set. If it waited for the cloud to notice a refund spike, that check would go blank the moment the
internet dropped — which is exactly when a shop is least supervised.

This is proved end to end now: a real socket, the real screens loaded from disk, a real day closed.

### One number I refuse to make up

**Margin.** What you sold something for is on the sale. What it *cost* you is in the product list.
So if a product has no cost price, that sale's margin cannot be worked out.

The tempting thing is to treat the missing cost as zero. **Do not ever let anybody do that** — it
reports a 100% margin, which looks like wonderful news and would be believed.

So the box leaves that sale out of the margin figures, keeps it in the takings (the money came in
either way), and **tells you on your own screen exactly which products are missing a cost price**.
Two true numbers and a named gap, instead of one number that is quietly wrong.

### Three real faults this found

1. **The till was throwing away figures it had already worked out.** It saved the basket and the
   total to disk, and dropped the pre-tax amount, the tax and how they paid — all three already
   calculated to take the money. Without them the day's figures cannot be rebuilt from the disk at
   all. Fixed.
2. **The customer app's search was broken and silent.** It read the wrong field, so `?? []` turned
   every search into "nothing matched that" — for every word, including exact barcodes. Nothing
   crashed and no test failed; the shop simply appeared to stock nothing. Found by actually running
   a search. Fixed.
3. **The manager's approvals list crashed on real data**, because the box sent the amount as a plain
   number and the approval rules expect an amount *with its currency*. Same fault as the one that
   once made the till refuse every sale because two files disagreed on a field name. Fixed, and the
   conversion now happens in one place instead of six.

### A note on the safety catch

All of this can be undone by two characters. Writing `?? []` in the box turns *"the cloud has never
mentioned approvals"* into *"no approvals are waiting"*, and the day close would then lock a trading
day on nothing at all. There is now an automatic check that bans that exact shape in the file that
builds these payloads, and a test that proves the check works.

**Tests:** 3,510 automated plus 31 performance, all green.

**What is left:** nothing plans a delivery route yet (M20), so the driver's route still has to be put
in the pack by hand. And nothing has yet met one real product from your old system — which is now
the biggest remaining risk in the whole project.

---

## The customer's app — and making it as easy to leave as to arrive (5 August 2026)

The last screen. Every application in this project now has one.

### The part I want you to read

This is the only screen a **stranger** uses. Everybody else — cashier, manager, picker, driver,
you — works for the shop and can be shown how it works. A customer cannot. And it is the one screen
where the money points the wrong way: it is always cheaper to make leaving harder than arriving.

India's data protection law (the DPDP Act 2023) says something very specific about this. Section
6(6): **turning off permission must be as easy as turning it on.**

That rule is almost never broken deliberately. It gets broken one sensible-looking decision at a
time. Saying yes is a switch when somebody signs up. Saying no becomes a settings page. Then a "are
you sure?". Then a "tell us why you're leaving". Then an email to support. Nobody ever sat down and
decided to make it hard — it just costs nothing to add a step on the way out, and it costs sales to
add one on the way in.

So on our screen there is **one switch per thing**, and it is the same switch both ways. One tap on,
one tap off. No confirmation, no "are you sure", no "here's what you'll miss".

And it is not left to good intentions: there is an automatic check that **counts the buttons** in
that part of the screen and fails the build if a second one ever appears.

### "Delete my information" says what it can and cannot do — before you press it

A customer can ask us, from their own phone with nobody contacted: show me what you hold, correct
it, send me a copy, or delete it.

Deleting is the honest one. **We cannot delete everything, and the law is why** — sales invoices
and GST records have to be kept for years. So the button itself says so, before it is pressed. Not
afterwards in a letter.

And tapping it does not say "deleted". It says we have your request and we must answer by a date.
Because that is what actually happened: the shop still has to check the request really came from
that person before doing anything, and a phone that checked itself would be no check at all.

### The other important rule, and it is the opposite of the till

At the till we save the sale on the lane first and send it to the cloud later, because the money is
already in the drawer and the customer has walked out.

On a customer's phone it is the exact reverse. **Nothing has happened yet.** No money has moved, no
goods have left, and the shop has never heard of that basket. So if their signal drops, the app says
— in these words — *your basket is ready but has NOT been sent, and nothing has been charged.*

It never says "order placed" over something that never left the phone. There is an automatic check
that the words "order placed" do not exist anywhere in that screen's code.

### Some smaller things that matter

- **The basket is saved on their phone**, so losing signal on a bus is annoying and nothing worse.
  Prices are not — if we republish the price list while somebody is deciding, paying is refused and
  they are asked to look again, rather than being charged a number they never saw.
- **A "buy again" that cannot get everything says which item it could not get.** Quietly dropping
  the milk from somebody's weekly shop is why people stop using that button.
- **Nothing loads from anywhere else** — no fonts, no images, no outside scripts. That is partly
  for a slow phone, and partly because a font loaded from another company is that company being
  told who shops with us.
- Card numbers are refused outright if one is ever put where a payment token belongs. Refused, not
  hidden — hiding it means we held it first.

**Tests:** 3,438 automated plus 31 performance, all green.

**What is left:** logging in needs the identity provider you have not chosen yet (OB-02), so there
is no OTP screen. And this needs a real stranger with a real slow phone, which is the only test that
counts.

---

## The picker's handheld and the driver's phone — and work that was going nowhere (5 August 2026)

Two screens built. But the important part of this session is not the screens.

### What I found before I built anything

Both of these already had their rules written and tested — how a pick works, how a substitution
works, how proof of delivery works, how the cash reconciles. And both files said, in writing, that
the picker's scans and the driver's cash **"queue for sync afterwards."**

**They did not.** Nothing queued. Anywhere.

Every scan a picker made and every delivery a driver completed lived only inside the app, on the
device, and nowhere else. Close the app, drop the handheld, run out of battery — and it was all
gone, with nothing anywhere saying it had ever happened.

For the picker that costs an afternoon's work.

**For the driver it is worse, and I want to be direct about it.** A driver collects ₹6,000 in cash
across four stops. The phone dies. There is now no record anywhere — not in the store, not in the
cloud, not on the phone — that any of that money was ever collected. At the end of the shift there
is cash in his pocket and nothing to check it against. **That is unfair to an honest driver and
invisible for a dishonest one.**

This is the ninth and tenth time in this project I have found something that was described,
believed, and simply not there. Not one existing test failed when I fixed it.

### What is now true

Both devices write every piece of work to the phone or handheld's own storage as it happens. Drop
it, close it, run the battery flat — it comes back. And it comes back correctly: work already sent
is not sent again, and anything the cloud rejected stays visibly rejected rather than quietly
reappearing.

If the device cannot save something, **the screen says so at the top in red**. A picker whose scans
are not being saved needs to know before the end of the wave, not after it.

### Two things the screens showed me were wrong in the rules

**1. "Customer confirmed" was a tick box.** A substitution — swapping an item the customer ordered
for a different one — needed the customer's agreement, and the way that was recorded was a true/false
flag. On a handheld that is a checkbox, and a picker with eleven lines left taps it in half a second.
It is true as far as the software is concerned and completely unverifiable in the aisle.

Now it needs **the reference** — the WhatsApp message, the call, wherever the customer actually
agreed. It travels with the swap, so if the customer complains later you can look it up instead of
arguing about it. And if the picker cannot get that reference, marking the item unavailable is one
tap away. That is the honest alternative, and it has to be easy or people work around the rule.

**2. The driver handed cash over and nothing counted it.** Now the driver counts the bag, note by
note, **and the screen never shows what they should be holding until after they have counted.**
Same as the till drawer, same as the stock count. Shown "you should have ₹6,000", people hand over
₹6,000 and count nothing.

If the difference is big, the screen does not show a number — it gives an instruction: *do not hand
the money over until somebody from the office is with you.*

### The screens themselves

**Picker (handheld, in the aisles):** scan the bin, scan the item, say how many. **There is no
place to type anything on this screen at all** — that is deliberate. If a picker can type a product
code, they will when the scanner will not read a crushed label, and then "every pick is a scan"
stops being true. Buttons are 64px because it is used with gloves, in cold, under freezer glare.

**Driver (phone, at doorsteps):** the stop is the biggest thing on screen and the amount to collect
is bigger still, because that is the number that has to be right when somebody hands over money.
Proof is asked for first, because that is the order it happens at a door. **Card is not offered as
a payment method at all** — COD is cash or UPI only, so it is a rule a driver can never accidentally
break. A delivery that failed must say what happens to the goods next: try again, or back to the
store.

### One thing my own safety checks caught in my own work

I wrote the picker screen to say which of the three steps comes next. A check then asked why two of
those three messages were translated but never actually shown — and it was right. The screen only
ever said "step 1", even when the picker was on step 3. That is worse than having no indicator at
all, because somebody told the wrong thing twice stops reading it. Fixed.

**Tests:** 3,372 automated plus 31 performance, all green.

**What is left:** nothing dispatches routes yet (M20), so a driver's route still has to be handed to
the phone rather than planned by the system. And both of these want a real handheld, a real scanner,
a real van and a real bad signal — which is the only test that counts.

---

## The owner's phone — deciding on numbers that left the shop hours ago (5 August 2026)

The till takes the money. The manager's screen runs the floor. **This one is you, on your phone,
possibly nowhere near the shop.**

### The thing this screen is really about

Every number on your phone is *old*. Not wrong — old. It left the shop at some point and the shop
has been trading ever since. For **reading** the day that is completely fine. For **approving an
₹8 lakh purchase order** it is not, and the whole design is about that difference.

So now:

- **The age of the data is shown inside the approval panel**, right next to the buttons — not in a
  small badge at the top that you scrolled past on the way down.
- If the numbers are not live, you have to tap through a warning that says so in plain words. One
  deliberate act. **And the system writes down that you were told.** *"Approved, on data eleven
  hours old, and he was shown that"* is a different fact from *"approved"*, and only one of them
  can be defended a year later.
- **This is not a block.** An owner who cannot approve anything while travelling ends up telephoning
  instructions instead — and a telephoned approval has no record at all. That is worse.
- **One thing is blocked:** if nothing has *ever* reached the phone from that shop, there are no
  reason buttons to tap. That is not old data, it is no data, and agreeing to nothing is not
  agreeing to anything.

### If you approve something with no signal, and it changes while it waits

You approve a ₹40,000 order on the train. The phone has no signal, so the decision waits. Meanwhile
somebody changes that order to ₹90,000.

Your ₹40,000 approval must not quietly land on a ₹90,000 order. It now comes back to the top of
your screen saying **"this changed after you decided it"**, showing what you said and what it says
now. It is never sent on its own and it is never thrown away on its own — you look again.

And the decisions you made **survive the app closing**. Three approvals made on a train used to
live only in the phone's memory. If the phone had killed the app, they would have vanished with no
message. They are now saved on the device, and if the phone cannot save them it *says so*.

### Every number opens up

Tap any figure — sales, margin, bills, average basket — and you see **every single sale behind it**,
not a selection. The list adds up to exactly the figure you tapped. A summary that disagrees with
its own detail is a reporting system nobody trusts again, and the disagreement is only ever found
by the person being asked to make a decision.

Tap an alert and you see the transactions behind it, on screen.

### Three things the old screen did that it should not have

I want to be plain about these, because all three were already built and shipped.

1. **Tapping an alert opened a grey system box containing raw codes** like `t-1`, `t-2`. That is a
   dead end dressed up as an action.
2. **It showed made-up sample takings as if they were the shop's.** ₹413 of sales that came from
   nowhere, with no warning at all. If you had glanced at it you would have believed it.
3. **The EN / த button changed nothing.** Not one word on the screen was in Tamil. A button that
   says "translated" and is not is worse than no button.

All three are fixed, and all three are now locked down by tests so they cannot come back.

### One repair that runs deeper than this screen

Every safety check in the project had been quietly scanning the *machine-generated* files that the
build produces, not just the code people write. That meant the whole test suite could pass or fail
depending on whether somebody had happened to run a build. **A safety check that depends on that is
not a safety check.** Fixed, narrowly, with a test proving the hand-written files beside them are
still checked.

**Tests:** 3,299 automated plus 31 performance, all green.

**What is left on this screen:** the AI narrative slot (A01) is deliberately empty until a live
model provider is chosen — the numbers, the priorities and the approvals all work with the AI off,
which was the requirement. And it wants a real phone, a real train, and a real bad signal.

---

## The manager's screen — and a day that will not close on an assumption (5 August 2026)

The till was the screen that takes the money. This is the screen that runs the shop: approvals,
receiving a delivery, counting stock, and closing the day. **Without it goods cannot be booked in
and the day cannot be closed.**

### The one decision that matters most on this screen

When a manager closes the day, the system is supposed to check two things first: is any exception
still open, and has everything reached the cloud. The rules that do that checking take **two
numbers**.

Here is the problem with that, and it is worth reading twice. **A screen that cannot reach the
store's exception list would send a zero — the exact same zero a shop with nothing wrong sends.**
The day would close. It would lock. And it would have locked on a page that had never actually
spoken to the store.

So this screen does not ask for numbers. It asks the store a question and accepts three answers:
*none*, *this many*, and ***I could not find out***. The third one stops the close. **Not knowing
is not a small problem — it is the strongest reason there is to stop.**

If you open the manager screen right now, before it is wired to the store box, it will tell you it
cannot see the lists and it will refuse to close the day. **That is correct.** It is not a rough
edge to smooth off later.

### "Cannot close" is useless at eleven at night

The old behaviour would have been an error: *the day cannot be closed*. A manager standing there
with the shutters down needs the list. So the screen now says:

> **3 sales have not reached the cloud** — nothing is lost, they are saved in the store. Check the
> internet, then check again.
> **2 exceptions are still open** — Till 3 is short by ₹420. Nine voids by one cashier in an hour.

Everything at once, with the actual items under it, not one problem per attempt. And if the rules
refuse when the screen thought nothing was wrong, **that disagreement is shown too** rather than
thrown at a manager as gibberish. The day stays open either way.

### The blind count again — and this time it had a sharper edge

Counting stock works exactly like counting the drawer: the manager never sees what the system
thinks is there until after they have written down what they actually counted.

But there is a second thing here that the till did not have. A stock difference gets **valued** —
6 items missing at ₹25 each is ₹150 — and that value decides whether somebody else has to approve
it. **So a screen that did not know what an item costs, and quietly used ₹0, would value every
difference at nothing, and every difference at nothing is below every approval limit there is.**
A hundred thousand rupees of missing stock would post with nobody's approval at all.

It now refuses the count and says so. Nothing is written.

### A delivery with no purchase order is said out loud

Stock still goes up — the goods are physically in the building and pretending otherwise makes the
shelf and the system disagree. But the screen tells the manager plainly: *there is no purchase
order behind this, so nobody can check the invoice against it. Tell the buyer today.* The person
who can still fix that is the buyer, today.

### Approving something takes two taps, and the reason is not typed

Tap **Approve**, tap a reason. The reasons are a fixed list, and **the approve list and the reject
list are deliberately different** — you cannot approve something "against policy", and you cannot
reject something as "within policy". Either sentence would sit in the audit trail forever looking
like a considered decision. A manager can never decide their own request; that row shows *why*
instead of a button that would fail.

### A real bug the tests caught while writing them

A manager set up with authority over the **whole company** was quietly demoted to a single branch
by one line of code — and then their own branch scope blocked them from deciding anything outside
it. Found by an assembly test, not by reading. Fixed.

### What is guarded now

Two new tripwires bind the screen to the rules: every kind of blocker and every kind of refusal the
system can produce **must** have words in English and in Tamil. Add one and forget the translation
and the build fails, rather than a manager seeing a blank reason at the moment they most need one.

**Tests:** 3,214 automated plus 31 performance, all green.

**What is left on this screen:** the exception list and the task list have no producer on the store
box yet, so today they honestly answer *not known* — which is why the day will not close from this
screen until that is built. Then the whole thing in front of an actual store manager with a
stopwatch, which is the only test that counts.

---

## Cash to the safe, and closing the till — counted blind (5 August 2026)

The last of the till screen, apart from one thing I have deliberately left undone and named.

**The drawer is counted blind, and that is the whole design.** When a cashier closes the till, the
screen shows **nothing** about what the drawer *should* contain. They count what is actually there,
note by note, and only afterwards does the system say whether it matches.

That is not distrust. Shown "expected: ₹6,000", people write ₹6,000 — because a number on a screen
is an answer and counting is work. A cash-up anchored to the expectation finds nothing, which is
the one thing a cash-up exists to do. It is the same rule as the stock count, and I have made it
structural in the software rather than a habit: **there is no way to ask the system what the drawer
should hold.** The function does not exist. It cannot be shown early by accident, and a future
change cannot expose it without somebody deliberately writing it.

**Counted note by note, not one typed total.** Big plus and minus buttons per denomination — ₹500,
₹200, ₹100 and so on. A typed total is a number somebody worked out in their head at the end of a
long shift.

**A big difference produces an instruction, not a number.** Not "variance ₹200" — *"Do not put the
money away. Call the manager now."* At the end of a shift only one of those gets acted on. A small
difference passes without fuss, because demanding a written reason for every rupee trains people to
type anything, and then the reasons on the ones that matter mean nothing either.

**Cash to the safe** is on the same menu, and every movement is recorded and queued to the cloud —
cash is never a fact that lives only on one machine.

**Refunds:** a cash refund settles at the till immediately. **A card refund stays "pending"**,
because the bank has not actually reversed anything yet — telling a customer they have been refunded
when the money has not moved is how they find out days later that it hasn't.

**What I have not built, and said so on the screen rather than hiding it:** a refund against a
receipt needs the till to look up the original sale, and it cannot do that yet. The screen says so
and sends the customer to the service desk. A button that opens a screen which cannot work is worse
than one that explains itself.

**Tests:** 3,139 automated plus 31 performance, all green.

**What the owner should check.** When we test in the store, this one is worth watching yourself:
**ask a cashier to close a till and see whether anything on the screen tells them what to expect.**
It should not. If it ever does, the cash-up has stopped being a check.

---

## Card, UPI and holding a basket — and a real bug the tests caught (5 August 2026)

A hypermarket takes mostly card and UPI, so a cash-only till is not a till. Both are now on the
screen, along with holding a basket while a customer fetches something.

**The important part is what happens when the card machine does not answer.** There are three
outcomes, not two:

| The machine says | What happens |
| --- | --- |
| Approved | Sale completes |
| Declined | Sale does **not** complete. Ask for another payment method |
| **Nothing at all** | Sale does **not** complete. **Do not hand over the goods** |

That third one is where shops lose money. The terminal has not come back, the customer is waiting,
there is a queue — and the temptation is to treat silence as "probably fine". The system will not:
an unanswered payment does not count as paid, the sale cannot complete, and the screen says so in
words rather than showing an error code. There is **no "force complete" button anywhere**, on
purpose, because the moment one exists it gets used at seven on a Saturday.

**And the tests caught a real bug of mine.** I had the till writing the sale to the disk *before*
checking whether it had actually been paid for. So a card payment the machine never answered was
written down and only then rejected — and because the till rebuilds its send-to-cloud list from
what is written down, **those unpaid sales would have been sent to the cloud after a restart.**

Nothing about the code looked wrong. Only the test found it. The order is now: **decide whether it
is a sale, then write it down, then account for it.**

**Holding a basket** parks it whole and the screen *says* it is held. A screen that just looked
empty is how the same customer's shopping gets rung up twice.

**Tests:** 3,121 automated plus 31 performance, all green.

**What is left on the till screen:** returns, cash in and out of the drawer, opening and closing the
till — and then the whole thing on a real touchscreen with a real scanner and a stopwatch.

---

## The till screen is now usable, not just laid out (5 August 2026)

The layout was already right — big total, line list, one Tender button, permanent sync badge. What
it did wrong was **ask its questions through the browser's own pop-up boxes**.

That sounds cosmetic. It is not, for three reasons:

- A browser pop-up is a small text box with the phone keyboard over it. Unusable with a queue
  waiting, impossible with gloves.
- **Kiosk browsers block them entirely.** On a locked-down till the button would have done nothing
  at all, and nobody would know why.
- They cannot be styled, so the one screen that has to be readable across a counter was not.

Now every question is a proper on-screen panel with big buttons: a keypad for quantity and for cash
received, and **preset buttons for a void reason** rather than free typing — a typed reason is one
nobody can ever report on.

**Change due is worked out as the cashier types it.** Miscounted change is the most common till
mistake there is, and nobody should be doing that sum in their head at speed.

**The "do not take payment" message does not disappear.** It is full width, it stays until somebody
taps to say they have read it, and it uses the exact words the system already had rather than new
ones. A message that fades after four seconds is a message that was missed by the person serving a
customer.

**The scanner cannot type into the wrong box**, because there is no box. A shop scanner is really a
very fast keyboard, and if it types into whatever was last tapped — at a till, that is the quantity
field — you get a sale of nine hundred million units. The screen listens for the scanner directly.

**Tamil is complete**, not partial. A half-translated screen reads as unfinished exactly where
somebody is depending on it.

All of it is locked down by tests, because every one of these is easy to undo in a hurry and
invisible in a code review.

**Tests:** 3,114 automated plus 31 performance, all green.

**What is left on this screen:** card and UPI payment, returns, hold-and-recall a basket, cash in
and out of the drawer, opening and closing the till — and then the whole thing on a real touchscreen
with a real scanner and a stopwatch, which is the only test that counts.

---

## Phase 1 started: the till's screen now reaches the till's disk (5 August 2026)

Not just a plan — the first item on it is built.

**A decision worth understanding, because it changes what we buy.** A browser cannot force a sale
onto a disk; a small program on the till has to do it. The question was **whose disk** — one shared
box in the back office, or one per till.

**Chosen: one per till** (`docs/adr/ADR-0004-the-disk-lives-on-the-lane.md`). With a shared box, if
that box is off, restarting, out of space, or behind a switch somebody unplugged while looking for a
socket, **every till stops taking money at the same moment**. That is not a slow day; that is a
closed shop with customers holding baskets — and it happens on exactly the bad day this whole design
exists for. Each till owning its own disk depends on nothing outside the till it stands in.

The cost is a little redundancy: four tills keep four small logs. **Redundant hardware is cheap. A
shop that cannot take money is not.**

**The socket between screen and disk listens only to the till itself** — not to the shop network. If
it listened to the network, any device on the shop wifi, including a customer's phone, could write
sales into the till's records.

**Found while building it:** the two halves disagreed about a field name, so every real sale was
refused with "could not read the sale". A till that cannot take money because two files disagree,
and no test on either side would have shown it — only driving the whole thing did.

**What the owner should check.** When we test in the store: **switch off the back-office box in the
middle of trading. Every till must keep selling.** That is the test this decision exists for.

**Tests:** 3,102 automated plus 31 performance, all green.

---

## The honest assessment, and the plan to close every gap (5 August 2026)

The owner asked for three things: find out what data we need, say where the project really stands,
and plan the rest properly. All three are now written down.

### 1. What data we need — `docs/requirements/data-requirements.md`

Researched against public sources rather than guessed, in four parts: **facts about the shop**
(fifteen minutes of the owner's time), **data out of the old system** (ours to extract), **evidence
from outside it** (bank, CA, suppliers, the shelves), and **what the law requires** (GST, FSSAI,
Legal Metrology, data protection, RBI).

Three findings worth knowing now:

- **One number decides a whole piece of work.** If turnover has *ever* exceeded ₹5 crore in any year
  since 2017–18, electronic invoicing applies **permanently** — every business-to-business invoice
  must be registered with a government portal before it is issued. That is a build item on the
  critical path, not a setting. If it has never been above, we skip it entirely.
- **HSN codes are probably missing** from the old system, and they cannot be guessed: they decide
  the tax rate and the input credit. Mapped category by category with the CA; anything unmapped is
  an exception the owner signs.
- **The cafe's scale prints barcodes with the weight inside them.** That is a standard supermarket
  thing and a real build item, and nobody had written it down.

### 2. Where the project stands — `docs/architecture/gap-analysis.md`

Written to be uncomfortable, because a comfortable status report is how a project arrives at go-live
with a surprise.

**The thinking in this system is better than most commercial retail software. The assembly is not
finished, and there is almost no screen.** 45,000 lines of rules — genuinely strong, and the hard
part. **2,452 lines across all six applications**, none of which draws anything. Fourteen screen
designs are written; none is built.

So the honest position: today nobody can ring up a sale, receive a delivery, count stock or close a
day — while the rules that would govern all of those are written, tested and correct.

There is now a table showing every module against **three separate questions**: are the rules
written, does it run in the assembled system, and **can a person in the shop actually do it**. The
third column is the one that matters and it was not visible anywhere before.

### 3. The plan — `docs/architecture/build-plan.md`

Ordered by one principle: **build the thing a person uses first**, because a screen is the only test
that cannot be passed by a system that merely looks assembled. Seven silent faults in two sessions
proved that the hard way.

1. **One screen, all the way through** — the till, on real hardware, ringing real sales into the
   real system. Everything after it is easier for having done it first.
2. **Real data into rehearsal** — runs in parallel; it is the owner's and the CA's time, not mine.
3. **The other five screens**, ordered by how much of the shop stops without them.
4. **Compliance built rather than assumed**, alongside.
5. **Hardening** — a restore actually performed, a penetration test, monitoring that wakes someone.

### What I need from the owner, and it is short

Everything else proceeds without him.

1. The **store facts questionnaire** — fifteen minutes.
2. **Has turnover ever exceeded ₹5 crore since 2017–18?** One number.
3. **An identity provider.** Small, cheap, and all user testing waits behind it.
4. The **two phone calls** already in the extraction plan: whoever installed the old system, and the
   CA's journals-only list.

---

## The seventh: the receipt was not waiting for the disk (5 August 2026)

One level above yesterday's find, and the same shape again.

**The till's own commit never touched the disk.** It priced the basket, settled the payment,
recorded the stock movement and queued the sale for the cloud — all correctly, and all **in the
computer's memory**. A lane that lost power between the sale and the next sync lost the sale, and
the cashier had already seen "Sale complete".

The function's own description said it commits the sale *locally*, which is our first rule. It did
not. That is the most expensive kind of comment there is: it tells every later reader the job is
done.

**Fixed, and fixed in the order that matters.** The sale goes to the disk **first**. Nothing else
is true until it is there — not the stock, not the queue, not the "sale complete" on the screen.
And the receipt number now literally does not exist until the disk confirms, so there is nothing to
print early with. That makes it a property of the software rather than something a future change
could quietly undo.

If the disk refuses — full, or broken — the sale is refused **before the customer pays**, and the
cashier is told in words: *"This lane could not save the sale. Do not take payment and do not hand
over the goods."* That is the one place in this whole product where refusing a sale is the right
answer, and it is right because of the moment: nothing has happened yet and the customer is still
standing there.

**Seven now, all the same shape.** Something present in the design and absent in the running
software. None a crash; every one invisible until a shop depended on it. Two of them — this one and
yesterday's — could only be found by driving the real path end to end, which is what the tests now
do.

**Tests:** 3,093 automated plus 31 performance, all green.

**One consequence you would notice, and it is deliberate.** The standalone POS demo screen — the
one that runs on its own with nothing behind it — now **refuses to take payment** and says so,
because it has nowhere to write a sale. That is the correct behaviour and it is the whole point: a
lane with no disk behind it must not take money. Connecting a lane to the back-office box is part
of the store hardware setup (EX-09), and until that is done the demo screen will say it is not
ready. If it ever goes back to accepting sales without being connected, that is a bug.

**What the owner should check.** This is the second store test I gave you, and it is now worth
doing: **pull the plug on a lane in the middle of a sale.** Anything the cashier was told was
complete must still be there afterwards. Anything half-written must be reported, not quietly gone.

---

## The sixth one, and it was the biggest (5 August 2026)

The guard I built this morning looks for controls that are stand-ins rather than the real thing. It
would not have caught this one, because nothing here was a stand-in — **two real, working, tested
pieces simply were not joined to each other.**

**A sale rung up at the till was written safely to the disk and never put in the queue to be sent.**
So no sale a lane took would ever have reached the cloud. Everything on both sides of that line was
built and tested. Nothing failed. That is what made it invisible — and the end-to-end test I wrote
earlier today passed because it put sales into the queue *by hand*, going around the gap instead of
through it.

That is now joined, and the test goes through the real path: ring a sale at the till, find it in
the cloud.

**Two decisions in it worth knowing about:**

- **The queue entry is made after the sale is safely on the disk, never before.** The other order
  would send a sale the till then refused — the cloud would hold a sale that never happened, and
  the customer walked out without paying for it.
- **The queue is rebuilt from the disk every time the edge starts.** The disk is the record; the
  queue is only a working list. That needs the edge to remember how far it got, so it keeps a small
  durable marker. If that marker is ever unreadable it starts from the beginning — which re-sends
  a few sales the cloud then ignores, rather than skipping one, which would be permanent and
  silent.

**Found while building it:** my first version of that marker never moved, which would have meant
re-sending every sale the shop had ever made on every restart. Caught by the test within the hour.

**Tests:** 3,088 automated plus 31 performance, all green.

**What the owner should check.** This does not change the two store tests I gave you — it is what
makes the first of them able to pass at all. **Internet off, sell ten things, internet on: all ten
in the cloud, once.**

---

## The store edge can now actually run (5 August 2026)

Following on from this morning: having found that nothing could *send* a sale to the cloud, I
looked at what else was a promise rather than a working part. Two more, both underneath the same
claim.

**Nothing could write a sale to the disk, either.** The function that decides whether a receipt may
print was writing to an interface that had a test stand-in behind it and nothing else. So the whole
offline-first claim rested on a file that did not exist.

**And nothing started the edge at all.** No process, no container, no entry in the deployment file.
A shop could not have run this.

Both are built. There is now a container for the back-office box, and it is in the deployment file
alongside the others.

**The detail that matters most, in plain terms.** When a program writes a file, the operating
system normally says "done" as soon as it has the data in memory — *before* it reaches the disk. On
a shop PC with no battery backup, a power cut in that gap means the receipt printed and the sale
does not exist. The software now waits for the disk to confirm, every time, before the receipt is
allowed to print. It is a little slower and it is the whole reason the till can be trusted.

If the power does go mid-write, the half-written record is **kept and reported, never repaired** —
a repaired half-sale is a made-up sale — and the edge says so out loud when it next starts.

**The property I most wanted to prove: the edge starts and sells with no cloud settings at all.**
Not "starts with warnings" — starts, sells, and says plainly that nothing is being synced. You can
bring the whole system up with the cloud switched off and the network unplugged, and the shop
trades. If it needed the cloud to start, offline-first would be a sentence in a document rather
than something the software does.

**Found while writing it:** my first version of the file format mangled any sale whose text
contained a line break — a lost sale, produced by the code whose entire job is not losing sales.
Caught by a test written the same hour.

**And one more of the same kind, in the cloud rather than the shop.** The system has a safety
catch that refuses a *different* sale sent under a reference already used — what stops a ₹400 sale
being answered with the record of a ₹250 one. It was being remembered in the program's memory
only, which means it was forgotten on every restart and never shared between two copies of the
service. Not a crash — just the safety catch quietly not being there. It is now kept in the
database.

**And the most serious of the lot: the system was keeping no audit trail at all.** The software
knows how to record every action and every refusal — who did it, what they asked for, what they
were told — but nothing had been connected to write it down. Our own rule says never delete audit
evidence, and there was none to delete. That is now written to a table nobody can edit or delete
from, including the database administrator.

**So I stopped finding these one at a time.** Five faults of exactly the same shape turned up in
one session: something that *looked* wired up and was not. None of them was a crash — each was a
safety control quietly not being there, which is the hardest kind to notice and the kind this
project cares most about. There is now a guard that reads the four files the running system
actually starts from and refuses anything that is a stand-in rather than the real thing. It will
catch the sixth.

**Tests:** 3,080 automated plus 31 performance, all green.

**What the owner should check.** This is now testable in the store, and it is the test I would run
first: **switch off the internet at the router, sell ten things, switch it back on.** Every sale
must appear in the cloud, once. Then the harder one, when we are ready: **pull the plug on the
back-office PC mid-sale.** Nothing should be lost, and anything half-written should be reported
rather than quietly disappearing.

---

## The shop can now actually reach the cloud (5 August 2026)

**This was the biggest hole in the product and I had not spotted it.** The till commits a sale to
the local disk before the receipt prints, queues it, and tells the cashier honestly how many are
waiting to be sent. All of that worked and was tested. What did not exist was **the piece that
sends them.** Every part had been tested on its own; nothing had ever tested the join.

That is built now, and there is an end-to-end test that runs the whole spine against the real
system: the shop sells five items with the internet down, the sales sit safely in the queue,
nothing gets lost and nothing gets given up on, the line comes back, and **all five arrive in the
cloud exactly once.**

**Almost all the care went into one distinction.** When a send fails, the software has to decide
whether to *try again later* or *give up and flag it for a person*. Those two look nearly identical
in code and could not be more different in the shop: a sale wrongly given up on stops being retried,
and the money in the drawer has no record in the cloud until somebody works through a list.

So the rules are written down and tested one by one:

| What happened | What we do | Why |
| --- | --- | --- |
| The line timed out | Try again | A rural line does this several times a day. Nothing about it says the sale was bad |
| We don't know if it arrived | Try again | The cloud ignores a duplicate. Guessing "it arrived" loses the sale silently, and that has no way back |
| The cloud had a fault | Try again | It's having a bad minute, not judging the sale |
| The cloud says the sale is malformed | Flag it for a person | Retrying it forever buries everything queued behind it |
| The login expired | Try again | It renews itself. The sale should still be waiting when it does |
| The till lacks permission | Flag it for a person | That will not fix itself |

A sale that syncs late goes through **the same door** as one that syncs immediately — same price
check against the published price list, same receipt-number check, same exception list. There is
deliberately no back entrance.

**Also fixed:** a naming flaw in yesterday's work that could have merged two drivers' delivery
records into one — which would have settled cash against the wrong person's round. It needed a
coincidence in the length of a driver's name to happen, which is precisely the kind of thing that
happens eventually and is impossible to explain afterwards.

**Tests:** 3,039 automated plus 31 performance, all green.

**What the owner should check.** Nothing yet — but this is the single most important thing to test
in the store, and it is on the pilot list: **unplug the internet, sell ten things, plug it back in.**
Every one must appear in the cloud, once. Not nine, not eleven. If that test ever fails, stop the
pilot.

---

## The tills would have got slow by month three (5 August 2026)

A defect I introduced with the persistence work this morning, found by writing the performance test
that should have gone in at the same time.

**Every one of the adapters answered a question by reading the whole history.** To decide whether a
sale had already been banked, the software loaded **every sale the shop had ever made** and looked
in the list. Correct — and slower every day the shop trades.

The arithmetic is what makes it serious rather than untidy. SRE takes roughly 2,000 sales a day:

| | Sales stored | What each till waited for, per scan |
| --- | --- | --- |
| Week one | ~14,000 | barely noticeable |
| Month three | ~180,000 | a scan of 180,000 records |
| Year one | ~700,000 | a scan of 700,000 records |

It would not have shown up in any test, it would not have shown up in the pilot's first week, and
it would have arrived some months in as **"the tills have got slow"** with nothing obviously
changed — which is the worst kind of fault to be handed, because by then nobody can say what
changed.

**The mistake was in a type, which is why reading the code did not reveal it.** The software asked
*"give me every sale"* and then looked at one of them. It now asks *"was this one sale banked?"* —
and the database answers that from an index it already had to keep. The same for receipt numbers
and stock movements.

Two more came out of the same test: working out "which price list are we on?" was reading every
price list ever published — 365 of them a year, each holding the whole product list — on every
sale. And the in-house test version of the store was scanning everything for any read, so it had
quietly stopped behaving like the real one.

**Stock was worse, because it has no ceiling.** The shop generates a few thousand stock movements a
day — over a million a year — and every "how many are there?" replayed all of them. That is
somebody standing in an aisle, or a customer watching a page. The software now keeps a **summary of
where stock stood at a point in time** and only adds up what has happened since.

That summary is not a second set of books. It is worked out from the record, it can be thrown away
and worked out again, and nothing can edit it — and there is a test proving the answer you get
through the summary is identical to adding up the whole record from the beginning. The
click-and-collect stock promise reads through the same summary, so if it ever drifted, that test
would fail as a wrong promise to a customer rather than as an abstract complaint.

**One thing worth recording, because it nearly slipped past.** My first version of that summary
*passed its speed test* while still reading every movement and throwing most of them away. Correct,
faster, and still reading a million rows — which a stopwatch cannot see, because discarding a
million rows is quick compared with adding them up. The test now **counts rows read**, not
milliseconds. A timing test would have signed that off.

**The tests are ratios, not stopwatch times** — a hundred times the history must not cost anything
like a hundred times the work — so they mean the same thing on a laptop, in the cloud, and on the
shop's back-office PC.

**Two more of the same shape, both found by looking rather than waiting.** *Today's takings* — the
number you look at every morning — was reading every sale the shop had ever banked and then picking
out today's. It now reads today. And a customer's marketing consent, asked at the counter with
somebody waiting, was reading every customer's consent record to find one; each customer now has
their own record to look in.

**Then the same correction everywhere else, and a guard so it stays true.** Deliveries, stock
reservations and supplier invoices each got their own record to look in, and six places that read a
whole history to look at its most recent entry now read just that entry. The guard is the part
worth keeping: it fills a shop with twenty thousand records that have nothing to do with the
question, asks **every** question the software can answer, and counts how much each one had to read.
Anything that reads more than a handful is named. It will catch the same mistake in whatever gets
built next, which is more than any of us noticing would.

It has already earned it — it found a case the one-at-a-time tests missed, and the fault turned out
to be in the **test data**: it had put a whole year's sales on a single day, which makes a
per-day limit look like no limit at all.

**Tests:** 3,010 automated plus 31 performance, all green.

**What the owner should check.** Nothing now. But this is the thing to insist on when the pilot
starts: **if the tills get slower after a few months, that is a bug and not "more data"**, and we
have tests that are supposed to catch it before you do. If it ever happens, say so early — the
faults that arrive gradually are the ones people put up with.

---

## The cutover weekend, hour by hour (5 August 2026)

`docs/runbooks/cutover-weekend.md` — the plan for the weekend the shop stops using the old system
and starts using this one. `extraction-work-plan.md` covers the weeks before; this covers the
weekend itself, and **every decision on it is taken now, while nobody is tired.**

Two things shape the rest of the page:

- **The point of no return is late on purpose.** Right up until Monday's opening, the answer to
  "should we go back?" is *yes, and it costs us a weekend*. So the decision to open on the new
  system is taken **Monday at 06:00 with the checks in front of you**, not on Saturday evening when
  the load has just finished and everybody is pleased with themselves.
- **The old system is never switched off.** It goes read-only and stays running for ninety days.
  That costs nothing, and it is the only thing that makes "go back" a real option rather than a
  thing we say.

The stop conditions are written down and absolute — no judgement calls at 2am. One of them is easy
to miss: if the latest rehearsal's exception list is **longer** than the previous one, we stop,
because something is getting worse and we do not yet know what. Another: **if the shift-in-charge
is not happy to open on it, we do not open** — they are the ones who will be standing there, and
that outranks everybody's schedule.

**What the owner should check.** Read the page — it is written for you, not for a programmer. The
two parts to look at hardest are the four questions you will be asked at 06:00 on the Monday, and
the stop-conditions table. If you disagree with any of them, now is the time to say so; the whole
point is that they are settled before the weekend, not during it.

---

## The last empty folder — the customer app (5 August 2026)

`apps/customer-app/` held a README and nothing else. It now holds the shopping session behind the
customer screens: browse, review the basket against the live catalogue, choose a slot, pay with a
provider token, and see the truth about whether the order actually reached the shop.

Almost every rule it needs already existed in `packages/storefront`. What it adds is the thing no
single function can hold — **the order of events**, and what the customer is truthfully told at
each point.

**The rule that only this layer can hold: an order is not placed until the shop has it.** On a
phone with no signal the basket is prepared and nothing else — the screen says *not sent yet*,
never *order placed*, and it says plainly that nothing has been charged.

That is the deliberate **inverse of the till**, and the difference is worth having in writing
because getting it backwards is easy:

| | Why |
| --- | --- |
| **At the till**, commit locally first, sync afterwards | The money is already in the drawer and the customer has walked out. The event happened; refusing to record it loses it. |
| **On a customer's phone**, do not claim placed | Nothing has happened at all. No money moved, no goods left, and the shop has never heard of this basket. |

An app that says "order placed" over a request sitting in a queue has told the customer something
untrue about the world, and they find out when nothing arrives.

Three more, all about sequence: nothing is paid for that has not been reviewed; a review built on
an older price list will not be charged (the customer is sent back to look, not quietly repriced);
and a short line is reduced only when the customer says so, never silently. A payment reference
shaped like a card number is refused rather than redacted — redacting means it was held first, and
by then it is in memory, in a crash report and in whatever the phone wrote to disk.

**Tests:** 3,007 automated plus 19 performance, all green. **No folder in the repository layout is
empty any more.**

**What the owner should check.** Nothing in the store. When we get to testing this with a real
phone, the one thing to try is: **turn aeroplane mode on, fill a basket, press pay.** It must say
the order has not been sent and nothing has been charged. If it ever says "order placed" while the
phone has no signal, that is a bug and a serious one.

---

## All thirteen services persist — and the same fault three more times (5 August 2026)

Identity, platform, reporting, migration and AI now read and write the event store. **Every one of
the thirteen services persists.** The API is a system rather than a shell.

The empty-answer fault from earlier today turned up three more times, and each was fixed in the
domain rather than hidden in an adapter:

| It was asked | It answered | What that meant |
| --- | --- | --- |
| Is the system healthy? (nothing probed) | "healthy — all 0 dependencies reachable" | Green because nothing was checked |
| Show me the dashboard (no figures) | "0 figures, all current" | Everything is fine |
| Who is the owner? | `'u-owner'` — a placeholder | Anybody who typed that string could accept a migration figure into the opening books |

The health one is the sharpest: this is the module whose whole point is that *the process being
alive is not the same as it working*, and it was making exactly that mistake one level up. It now
answers **unknown** — deliberately not *unhealthy*, which means the shop cannot trade and would
trigger a failover over what is a gap in monitoring.

The migration one is the most serious. The page the owner and the CA sign was naming a person who
does not exist. That is worse than a page that refuses to render, because it gets signed — and the
rule that whoever ran the extraction cannot choose which stock lines get counted only means
anything if the page says who that was. Both names are now read from the record, and the routes
refuse, naming every gap at once, rather than proceeding on a placeholder.

**Roles are now written down** (`services/api/src/roles.ts`). A role is configuration — what
`cashier` *means* is a set of permission codes this product defines — while who holds it is the
tenant's own data in the event stream. Separation of duties is not a policy document; it is which
codes are **absent** from a list: the accountant can post a journal and cannot close the period
they posted into; the store manager runs the shop and cannot grant a role; the cashier, the role
most people hold, has six permissions.

**The AI kill switch defaults ON.** It is the one place in the adapters where an absent record does
not mean "we cannot say" — a switch that defaults off is an agent running because nobody has told
it not to. No budget granted means nothing may be spent.

**Tests:** 2,989 automated plus 19 performance, all green.

**What the owner should check.** Nothing in the store. Two things worth knowing: **the AI is
switched off and stays off until you turn it on by name**, and **the migration report will not
print until the system knows who you are and who ran the extraction** — which is deliberate,
because that page gets signed.

---

## Nobody could log in — now the door exists (5 August 2026)

**What changed.** The API's `authenticate` returned nothing for every caller. That was
*default-deny* rather than a bypass — nothing was exposed — but it also meant the system could not
be used by anybody. `services/identity/src/token.ts` is the piece that turns a bearer token into
*who is asking, and on whose behalf*.

**It verifies. It never issues, and it never stores a credential.** No password, passkey or MFA
secret is held anywhere in this codebase; that belongs to whichever identity provider the
deployment uses, and M02-FR-01 is a deliberate partial for exactly that reason (hard rule #4). A
test scans the module's exports to prove there is no way to *make* a token — a module that can
issue tokens is a module whose key is a token factory.

Every check it performs is shaped around a real, repeatedly-shipped bug, and all of them come down
to the same mistake — **believing something the token said about itself**:

- `alg: none`, and the RS256→HS256 confusion attack. Both are "the header chose the algorithm".
  Here the algorithm comes from our configuration and the header is *checked against* it.
- Reading claims before checking the signature. Until the signature verifies, every byte of the
  payload is text an attacker wrote.
- A token with no expiry. It works forever, including after the person who held it has left.
- A perfectly valid token from a *different* system, or for a different service of ours.
- A tenant swapped in the claims. `tenantId` comes from the signed payload and nowhere else —
  there is no header, query parameter or option by which a caller can supply one.

The caller is told "unauthenticated" and **never the reason**: "the signature did not verify" and
"that token expired" are different sentences, and the difference is free information for whoever is
trying tokens. The reason goes to the operator's log, which never contains any part of the token.

**Three new settings are required, not optional** — `IDP_SIGNING_KEY`, `IDP_ISSUER`,
`IDP_AUDIENCE`. Absent, `authenticate` would have to fall back to *something*, and every fallback
there is a way in. A deployment with no identity provider **does not start**, which is louder than
one that starts and lets everybody in. CI proves that refusal by name.

**Found by a guardrail, again.** The test that reads `.env.example` off disk and proves every
placeholder in it would be refused caught the new `REPLACE_WITH_YOUR_IDENTITY_PROVIDER_URL` — the
refusal list held exact strings, so it sailed straight through, and a deployment would have believed
tokens from an issuer literally called that. It now matches the `REPLACE_WITH` prefix, with a
tripwire proving it fires on an invented placeholder and still accepts a generated key.

**Tests:** 2,972 automated plus 19 performance, all green.

**What the owner should check.** Nothing in the store. The thing to know: **we still have to choose
an identity provider before anyone can log in** — that is part of the hosting decision (OB-02) that
is deferred, and it is not urgent, but it is on the list. The system is built so that choosing one
is a configuration change, not a rewrite.

---

## The API stopped forgetting (5 August 2026)

**What changed.** Until this session the cloud API booted, answered every request correctly, and
**forgot everything** — all thirteen services were wired to stubs. Eight of the thirteen now
persist to the real event store: catalogue, POS, inventory, purchase, finance, customer, orders
and fulfilment.

**Everything is an event.** There is no products table, no sales table, no stock table and no
"current pack" column. A sale is a `SaleCommitted` appended to the tenant's stream, a stock
movement is an `InventoryMoved`, and every balance and every *current* anything is projected by
reading the stream forward. A test asserts that no mutable `sales`, `products`, `stock` or
`inventory` table exists at all. That is not architectural taste — it is the only shape in which
hard rule #2 can hold, because a table with an `UPDATE` on it is a quantity somebody can
overwrite, and no discipline in the application layer survives one hurried fix at 9pm.

**Four defects came out of it that had nothing to do with persistence.** Three of the new
projections read streams nothing writes to yet — purchase orders, the chart of accounts, the
dispatch list — and in each case the empty answer was an *all-clear*:

| It was asked | It answered | What that meant |
| --- | --- | --- |
| Match this invoice (no lines held) | "invoiced 0, matched — the order, the delivery and the invoice agree" | Pay it |
| Close August (no control totals) | "closed, 0 control total(s) agreed" | A signed month nothing checked |
| Settle Ravi's run (no dispatch list) | "the run reconciles and every order has an outcome" | Five deliveries and a bag of cash, unaccounted |
| What is on order? | `{count: 0}` | "We have nothing on order" — and buy against it |

The system was most confident exactly where it knew least. All four were fixed **in the domain
logic, not papered over in the adapters**, because all four were wrong before persistence existed
and would have shipped either way. **Not one existing test failed when the guards went in** — no
test had ever exercised the empty case, which is precisely why all four were wrong.

Two more found the same way: a supplier bank change carried **no date it was requested on**, so a
supplier who moved to a new account and later moved back had the return collapse into the original
change as a replay — leaving the ledger asserting the money still goes to the middle account. And
`JournalPosted` was being stamped with the **document's own date** instead of the time we recorded
it, which would have put the ledger's clock under the control of whoever typed the date on the
paper.

**Period close now refuses, deliberately.** No genuine control total can be built inside this API:
every figure it holds for a period comes down one path — the till banks a sale, the sale becomes a
journal — so adding those two up and comparing them is one figure written twice, which
`closePeriod` already refuses by name. The real second source is outside: the bank statement, the
filed return, the counted shelf. Until one is fed in, the month does not close and the refusal says
why. **A month that closes because nobody checked it is the outcome worth refusing.**

**Tests:** 2,949 automated plus 19 performance, all green. The performance suite now runs in its
own isolated pass (`pnpm test:perf`) after flaking three times under full-suite load while passing
alone — the tempting repair was to widen its tolerances until the noise fitted inside them, and a
performance test loose enough never to flake is a performance test that cannot fail.

**What the owner should check.** Nothing in the store yet — this is all engine work. The thing to
know is that **the finance module will refuse to close a month until we give it a bank statement
or a filed return to check the month against.** That is on purpose, and it is the behaviour to
insist on when somebody eventually asks for it to be switched off.

---

## Last completed
- **Setup 1/3/4** — repository, `CLAUDE.md`, safety net (tests, guardrails, secret
  scan, CI), and baseline ADR. (Merged to `main` via PR #1.)
- **Roadmap added** — `docs/roadmap/roadmap-v2.0.docx` (Final Master Roadmap v2.0,
  39 sections) is now the single source of truth in the repository.
- **Setup 2 — Requirement index complete.** `docs/requirements/index.md` now maps,
  from the roadmap: M01–M36 (title/priority/purpose), D01–D14 (FR lines),
  WF-01–WF-20, QG-01–QG-12, A01–A10 (authority), MG-01–MG-12, the §31 offline
  matrix, §32 targets, R0–R8, stages 0–19, milestones M0–M8, API-01–13, and the
  SEC/PRV/NFR/AI-NFR/AID/AVR requirement sets.
- **Stage 0 registers completed from the roadmap** — `decisions.md` (OD-01–10,
  D1–D8, AID-01–10 verbatim), `risks.md`, `compliance.md`. `open-questions.md`
  refreshed; `docs/discovery/avr-closure.md` populated with all 20 AVR items;
  `to-be-processes.md` lists WF-01–20; `docs/traceability.md` seeded with the §37
  family-level baseline.

## In progress
- **Nothing.** Every code stage in the roadmap is complete with written gate evidence in
  `docs/evidence/` — stages 0–11 and 14–19. Every module M01–M36, all ten agents A01–A10 and
  all twelve migration controls MG-01…MG-12 are built and tested. Nothing has been silently
  dropped.
- **Stage 11 is no longer blocked on EX-02.** The migration engine, its twelve controls and the
  whole reconciliation and exception path are built and gate-proven against a **synthetic**
  legacy dataset (`packages/migration/`, `docs/evidence/stage-11-the-old-shop-arrives-whole.md`).
  EX-02 now gates only the **real-data** migration: the real fault profile, the real volume and
  therefore the true cutover window, and the real control-total figures for the CA to sign. The
  pipeline is built to surface an unforeseen fault kind as an **exception rather than a silent
  default**, which is the property that had to be settled before the data arrives.
- **EX-02 is closed (OB-06, 7 August 2026)** — we extract our own data ourselves. What the
  real-data migration now needs is **outside evidence**, not a vendor: bank statements, filed GST
  returns, supplier statements of account and an authorised physical count. **All six checks are
  now built** — see *The six outside-evidence checks — COMPLETE*. What remains for the real-data
  migration is the evidence itself, which is the owner's to gather, and the end-to-end gate that
  runs all six as one pass.
- **Two per-store facts the product and price screen needs (6 August 2026).** The **minimum margin**
  the shop will not go below, and **who may approve** a price beneath it. Until the store's
  configuration carries them the screen names the gap on the page and refuses — which is correct,
  not a bug to route around. The person who sets a price is stripped out of their own approver list
  by the store box, so naming only them is the same as naming nobody (§28).
- **M04 — COMPLETE (6 August 2026).** Owner chose option 2 (shelf locations first), then asked for
  the rest the same day. All of M04 is now built — see *Shelf addresses* and *Merchandising and
  space*. The prerequisite named in the deferral turned out to be a live fault: an uncounted shelf
  was being treated as an empty one.
- **Two per-store figures the merchandising screen needs.** How long a shelf count stays worth
  acting on (starting figure: 2 hours) and how empty a facing must be before it is worth a trip
  (starting figure: half). Both are settings with stated starting figures, not rules — refilling at
  90% wastes the day, refilling at nothing means the customer already found the gap.
- **Pick zone order — ANSWERED (OB-07, 6 August 2026):** `ambient → secure → chilled → frozen`.
  Recorded in `decisions.md` (OB-07) and `owner-configuration.md` (OC-42), held as
  `SETTINGS.PICK_ZONE_ORDER`, shipped in the example store pack, and driven end to end by test. The
  product default stays **empty** — guessing a cold-chain order is a licensed-premises decision and
  the wrong guess is silent (OB-01/OB-05).
- **Still open on shelves (OC-43):** the shelf addresses themselves — aisle, rack, bay, shelf and
  position for each location, and which product lives on which. That is master-data configuration
  in the store, not a decision: until it exists, the picker's list is in the order it arrived and
  the handheld says so.
- **Two per-store facts the buyer's screen needs (6 August 2026).** Who may approve a captured
  supplier invoice, and who may approve a purchase order. Until the store's configuration carries
  them, the screen names the gap on the page and refuses to save — which is the correct behaviour,
  not a bug to route around. The buyer is stripped out of their own approver list by the store box,
  so naming only the buyer is the same as naming nobody (§28).
- What remains needs the owner or the store: **OB-02** (hosting), the
  **pre-pilot integration gate** (a live AI provider, then UAT-49), **EX-13** (a penetration
  test), and the 55 store activities in
  `docs/registers/uat-calendar.md`. `docs/backlog.md` schedules every remaining requirement row
  to a named stage.

## Blocked / needs owner input
- **D3/D4/D5/D8 — CLOSED (2 Aug 2026), D3 SUPERSEDED (4 Aug 2026).** D3 is now
  **₹15,000/month maximum post-go-live platform runtime** by binding owner decision —
  ₹20,000 is expressly *not* an approved value. D4 = **Mr Sivakumar**
  (second technical custodian); D5 = GO given today; D8 = Store-Core 1 April 2027, full
  completion phased. Recorded in `docs/registers/decisions.md` and ADR-0001. The coding
  HOLD that depended on these is lifted. (D3 still wants a commercial check vs real vendor
  quotes; a signed GO record should be filed for the audit trail.)
- **Infrastructure / live database / hosting / environment setup + the Stage-1 store facts —
  OWNER-DEFERRED (OB-02, 2 Aug 2026):** "live database, hosting and any type of setups we
  will plan later." Recorded, **not an active ask and not surfaced each turn**. The Store
  Setup Profile (`docs/discovery/store-facts-questionnaire.md`) and the tenant-ready
  foundation are ready whenever the owner picks these up.
- **D4 onboarding** — Mr Sivakumar needs a custody handover (OD-09) and a demonstrated
  quarterly rebuild/deploy path (AID-10); runbooks/training produced during Stage 5.
- **Other named approvals still open** (`decisions.md` → Named approvals): product owner,
  store operations lead, finance/CA reviewer, security/architecture reviewer.

## Next session should start with

**Real data.** The screens are built, the store box feeds every one of them, every one of them
now really opens with no network and says so, the day close closes, a supplier invoice can be
captured whole and a price can be set — and **not one line of any of it has met a single real
product from the old system.** Every control was written for 20,000 SKUs with duplicate
barcodes, missing HSN codes, three spellings of one brand and produce sold by weight; none of them
has met one. That is now the largest risk in the project by a wide margin, and
`docs/requirements/data-requirements.md` says exactly what to extract.

~~After that: purchase and receiving (M06/M07 — nothing captures a supplier invoice, so the
three-way match still has no lines to match).~~ ✅ **Done this session.** What is left in that area
is the compliance build (HSN, e-invoicing if it applies, FSSAI records, legal-metrology stamping
dates), and **two facts only the owner can give**: who may approve a captured supplier invoice, and
who may approve a purchase order. The screen refuses to save anything until it is told, and says so
on the page rather than guessing.

**Then the owner's decisions.** The code is complete as far as it can go without them: all thirteen
services persist, token verification is done, no folder in the repository layout is empty, the
cutover weekend is planned hour by hour, and no read the software makes grows with how long the
shop has been open. What is left needs the owner or the store — an identity provider and hosting
(OB-02), a live AI provider, a penetration test (EX-13), store hardware (EX-09), the outside
evidence for the real migration, and the D4 handover to Mr Sivakumar.

**Nothing is half-done and nothing is blocked on me.** This is a clean stopping point: the branch
`claude/new-session-lw91i4` is pushed, every check passes, and the traceability document has a row
for every piece of it.

**The theme of the second half of this session, worth remembering.** Having found one thing that
looked wired up and was not, I went looking for more, and found five: the piece that sends a sale
to the cloud, the piece that writes a sale to the disk, the process that runs the shop's edge, the
safety catch on repeated requests, and the audit trail itself. **Not one of them was a crash.**
Every one was a control quietly not being there, and none would have shown up until the shop was
using it. **Two more turned out to be different and worse:** real, working, tested pieces that
were simply not joined to each other — a sale written safely to the disk and never queued to be
sent, and a till whose commit never reached a disk at all. No guard based on names catches those;
only driving the real path end to end does, which is what the tests now do. There are two
guards that look for the name-shape on purpose — one for controls that are
stand-ins rather than the real thing, one for work that grows with how long the shop has been open
— because finding them by reading is not a plan.

Everything below remains true and unchanged.

**The outside-evidence checks, one domain at a time.** Every code stage is complete and the
migration engine is gate-proven. What is being built now is the part OB-06 made necessary: since
nothing comes from the vendor, **every opening figure has to be proved against a record somebody
outside the old system keeps.** A domain checked only against the system it came from is refused
by name in `extraction.ts`, so each row of that table needs code behind it.

| Domain | External evidence | State |
| --- | --- | --- |
| **Stock** | A physical count of our own shelves | ✅ `count-verification.ts` |
| **Supplier balances** | The supplier's own statement of account | ✅ `supplier-reconciliation.ts` |
| **Sales** | The bank statement; the card/UPI settlement file | ✅ `banking-verification.ts` |
| **Tax** | The GST returns already filed | ✅ `tax-verification.ts` |
| **Books** | The accounts the CA prepared | ✅ `books-verification.ts` |
| **Loyalty points** | A sample of customers confirming their own balance | ✅ `loyalty-verification.ts` |

**All six are built, and the end-to-end gate has passed** — see *OB-06 verification gate PASSED*
below. Nothing in the verification path is outstanding.

**What remains for the real-data migration is not code. It is the evidence itself, and it is the
owner's to gather:** bank statements running past the period end, the filed GST returns off the
portal, statements of account from every supplier, the CA's signed accounts with the list of
journal-only balances, and an authorised physical count. Each has a check waiting for it, and each
check refuses to run on an assumption in place of the document.

**The owner-facing verification report is built too** (`verification-report.ts`), with a worked
example at `docs/evidence/example-verification-report.md`. There is now nothing outstanding in the
verification path at all: the checks, the gate that proves they cover everything, and the page that
gets signed.

The next piece of build work, when the owner wants it, is **the runbook for the migration weekend
itself** — who does what, in what order, on the days around cutover, with the rollback rehearsed
rather than described. `cutover.ts` already refuses GO on a rollback that was designed and never
performed; nothing yet writes down the hours.

**Nothing here needs the ERP vendor, and nothing waits on them.** The letter stays on file
(`docs/discovery/legacy-data-access.md`); if they ever answer it is a bonus, not a dependency.

In parallel (owner/store, not gating the build): gather the remaining Stage-1 store facts using
**`docs/discovery/store-facts-questionnaire.md`** (it includes the **trading-day cut-off**);
measure the six baselines (`docs/discovery/baseline.md`); request statements of account from
every supplier and pull the bank statements and filed GST returns for the period; begin D4
custody onboarding for Mr Sivakumar.

Still scheduled and still not forgotten: QG-02 usability testing with real staff, and the
**owner-witnessed restore demonstration (UAT-01)**, both of which need the store and are
recorded in `docs/registers/uat-calendar.md`.
