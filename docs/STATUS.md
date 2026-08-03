# SRE Retail OS — Project Status

_Read this file, together with `CLAUDE.md`, at the start of every session (prompt R6)._
_Update it at the end of every session (prompt R10). This is what stops the project drifting._

Last updated: 3 August 2026

---

## Current stage
**Stage 5 — Foundation build (in progress). Stage 4 complete; owner-closure gate CLOSED.**
Stage 3 (UX & design system) and Stage 4 (architecture + data dictionary + infra design) are
done for Store-Core (R2); Stage 5 has built 43 tested foundation units, five
**persistence-layer** units incl. the PostgreSQL connector + migration runner, and the **first
app shell (POS) with its build pipeline, barcode scanning, the catalogue snapshot builder and
the store-edge sync agent** — 451 tests. **D3/D4/D5/D8 were answered on 2 Aug 2026** (see
`docs/registers/decisions.md` / ADR-0001), so the coding HOLD that depended on them is
lifted and **Stage 5 (foundation) can begin**. The remaining inputs before the M1
spec-freeze / store-specific build are the Stage 1 store facts (the 20 AVR items) and the
trading-day cut-off — gathered in the store (finding A-11). Running autonomously per
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
  - `pnpm check` green: typecheck + lint + secret-scan + **451 tests**. Value-object
    operations are namespaced in the barrel (`MoneyOps`/`QuantityOps`); types export flat.
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
  - Remaining for a live lane: serving `web/` on the lane device, receipt printing, the
    distribution job that ships a built snapshot to each lane, and the cloud ingest endpoint the
    sync transport posts to — all of which need the deferred hosting/DB (OB-02).
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
- **Stage 5 foundation build** — 36 tested units done (`packages/` contracts, ledger,
  approvals, rbac, sync, numbering, calendar, price-list, pricing, promotions, price-guard,
  tender, config, sale, tenant, receiving, purchasing, bank-controls, adjustment, counts,
  replenishment, fefo, traceability, finance, reconciliation, orders, fulfilment, customer,
  waste, b2b, notifications, reporting, returns, cash, till, day-close, loyalty, loss-prevention;
  359 tests, `pnpm check` green). The
  pure, store-fact-independent foundation is now comprehensive — it even composes into the
  end-to-end offline sale commit (hard rule #1). What remains genuinely needs the outside
  world: a **database** (via the hosting-vendor pick, D3 commercial validation) and the
  **store-specific modules** (via the Stage 1 facts, A-11). Further pure engines would be
  increasingly marginal versus those two unblocks.

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
The owner-closure gate is closed (D3/D4/D5/D8) and the infrastructure/deployment design +
hosting ADR-0002 are done, so the next roadmap step is **Stage 5 — the technical
foundation** (platform, identity/config service, base data layer, CI/CD). It does **not**
depend on the store facts and is unblocked:
1. **Contract & event schemas** in `packages/contracts/` (from the API catalogue & data
   dictionary) — the shared types both edge and cloud build against; **then**
2. **IaC in `infra/`** (network/db/compute/storage/secrets, dev/test/staging/prod) to
   ADR-0002; **then**
3. **Base platform** (identity/RBAC, config/number-series, the append-only data layer) with
   full tests (AID-03/AID-07 and the Definition of Done) — the first real application code.

In parallel (owner/store, still gating store-specific build per A-11): gather the 20 AVR
facts using the new plain-language **`docs/discovery/store-facts-questionnaire.md`** (grouped
by who answers: owner / floor manager / accounts / IT / payments / privacy) — it includes
the **trading-day cut-off**; measure the six baselines (`docs/discovery/baseline.md`); send
the ERP-vendor letter (`docs/discovery/legacy-data-access.md`); begin D4 custody onboarding
for Mr Sivakumar.

Also still open (design, not gating): QG-02 usability test in the store; expanding the
remaining later-release modules (M22, M24–M28, M31, M36) and the SEC/PRV/NFR/AI-NFR/MG sets.
