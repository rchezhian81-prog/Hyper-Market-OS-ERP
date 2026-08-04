# SRE Retail OS — Project Status

_Read this file, together with `CLAUDE.md`, at the start of every session (prompt R6)._
_Update it at the end of every session (prompt R10). This is what stops the project drifting._

Last updated: 4 August 2026

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
passed**. **Every module M01–M36 now has its foundation built: 140 of the 144 requirement rows
built, 4 partial, and NONE unstarted**, with **1,802 automated tests** plus **116 integration
tests** against real PostgreSQL 16.13 and written evidence for all eleven gates. The only
code stage left is **17 (governed AI agents)**, which waits on EX-12 — a paid model-gateway
account, a spending decision. The other outstanding externals are EX-02 (the ERP-vendor letter
that unblocks Stage 11), the hosting/live-database decision (OB-02, owner-deferred), and the
in-store activities that need the store itself (QG-02 usability testing, the owner-witnessed
restore in UAT-01).

---

## Current stage
**Stage 17 — Governed AI agents is the ONLY code stage left, and it waits on EX-12.
Stages 0–10, 14, 15, 16, 18 and 19 are complete, all gates passed.**

**Stage 19 passed today** on `tests/integration/the-seams-hold.test.ts` (15 assertions, 48
controls, real PostgreSQL 16.13, run three times green) — one evening of integration traffic: a
till on flaky 4G resending a sale it already committed, a payment webhook replayed and then
forged, Tally rejecting a journal that dead-letters and is corrected, a signing key rotated with
an overlap and a leaked one revoked without, an uncertified scanner turned away — and through all
of it, not one customer waiting. Evidence in `docs/evidence/stage-19-the-seams-hold.md`.

**With M32 complete, every module M01–M36 has its foundation built and tested.** What remains
is not code: EX-12 (a model gateway) for Stage 17, EX-02 (the ERP-vendor letter) for Stage 11,
and the store-side activities in `docs/registers/uat-calendar.md`.

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
- **Stage 4 also done:** **infrastructure & deployment design** to the **₹20,000/month (D3)**
  envelope (`docs/architecture/infrastructure.md`) with hosting **ADR-0002** (Proposed,
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
- **Stage 11 — Migration rehearsal. BLOCKED ON EX-02**, and the block is not technical:
  the migration engine, controls MG-01…12 and reconciliation design are complete
  (`docs/architecture/migration-design.md`, `packages/import`), but a *rehearsal* needs
  **real export data from the incumbent ERP**, and the letter requesting it
  (`docs/discovery/legacy-data-access.md`) has not been sent. This is the first point in
  the whole roadmap where building further in sequence is genuinely impossible.
- **Stage 17 — Governed AI agents (A01–A10). The only code stage left, and it needs EX-12** —
  a model-gateway account. The authority boundaries, evidence requirements, budgets and kill
  switches are already designed; what is missing is the provider account, which is a spending
  decision belonging to the owner.
- Everything else is **finished, not paused**: stages 0–10, 14, 15, 16, 18 and 19 complete with
  written gate evidence in `docs/evidence/`. **Every module M01–M36 has its foundation built and
  tested; nothing has been silently dropped.** Nothing has been silently dropped — `docs/backlog.md`
  schedules every remaining requirement row to a named stage.

## Blocked / needs owner input
- **D3/D4/D5/D8 — CLOSED (2 Aug 2026).** D3 = ₹20,000/month; D4 = **Mr Sivakumar**
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
**A decision, not code.** With M32 complete, every module M01–M36 has its foundation built and
gate-proven. What is left needs the owner:

1. **EX-12 — a model-gateway account**, which unblocks **Stage 17 (governed AI agents,
   A01–A10)**, the last code stage. This is a paid subscription; I will bring it as a decision
   with two or three concrete options and their costs.
2. **EX-02 — the ERP-vendor letter** in `docs/discovery/legacy-data-access.md`, which unblocks
   **Stage 11 (migration rehearsal)** and therefore the pilot.
3. **EX-13 — an independent penetration test** before customer launch (paid engagement).
4. Meanwhile: the four **partial** rows (M02-FR-02/03 hardening, M23-FR-02 GST filing formats,
   M30-FR-04) and the store-side activities in `docs/registers/uat-calendar.md` (UAT-01…39).

**The one thing that would genuinely help from outside:** send the ERP-vendor letter in
`docs/discovery/legacy-data-access.md`. It unblocks EX-02 and therefore Stage 11, which is
the only stage now standing between the build and the pilot.

In parallel (owner/store, not gating the build): gather the remaining Stage-1 store facts
using **`docs/discovery/store-facts-questionnaire.md`** (it includes the **trading-day
cut-off**); measure the six baselines (`docs/discovery/baseline.md`); send the ERP-vendor
letter (`docs/discovery/legacy-data-access.md`, which unblocks EX-02 and therefore the Stage
11 migration rehearsal); begin D4 custody onboarding for Mr Sivakumar.

Still scheduled and still not forgotten: QG-02 usability testing with real staff, and the
**owner-witnessed restore demonstration (UAT-01)**, both of which need the store and are
recorded in `docs/registers/uat-calendar.md`.
