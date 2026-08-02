# SRE Retail OS — Project Status

_Read this file, together with `CLAUDE.md`, at the start of every session (prompt R6)._
_Update it at the end of every session (prompt R10). This is what stops the project drifting._

Last updated: 2 August 2026

---

## Current stage
**Stage 4 — Architecture (core design documents complete); owner-closure gate now CLOSED.**
Stage 3 (UX & design system) is done and Stage 4 has produced the core architecture design
for Store-Core (R2). **D3/D4/D5/D8 were answered on 2 Aug 2026** (see
`docs/registers/decisions.md` / ADR-0001), so the coding HOLD that depended on them is
lifted and **Stage 5 (foundation) can begin**. The remaining inputs before the M1
spec-freeze / store-specific build are the Stage 1 store facts (the 20 AVR items) and the
trading-day cut-off — gathered in the store (finding A-11). Running autonomously per
**standing owner instruction (2 Aug 2026): "carry on always, don't wait for my approval
unnecessarily."** Keep building and pushing tested work; stop only for genuine blockers that
truly need the owner or the store (the Stage 1 facts, a hosting-vendor commitment) — not for
routine progress.

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
  - `pnpm check` green: typecheck + lint + secret-scan + **96 tests**. Value-object
    operations are namespaced in the barrel (`MoneyOps`/`QuantityOps`); types export flat.
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
  - **Foundation engines now cover the core invariants** (exact money/quantity, append-only
    ledger, maker-checker, RBAC, offline outbox, gap-free document numbering) — 10 tested
    units, 96 tests.
  - Next needs the outside world: the **database-backed** persistence layer needs the
    IaC/DB from `infra/` (→ hosting-vendor pick, D3 commercial validation); the
    **store-specific** modules need the Stage 1 facts + trading-day cut-off (A-11).

Store-Core scope (roadmap §21 Stage 2): **M01–M15, M23, M29, M30, M32–M35 — all done.**
Each module doc marks store-fact-dependent fields `⟳ AVR-##` (confirmed in Stage 1),
so nothing is guessed.

**Design-ahead requirement expansion (R4 + R5 — the full customer→delivery arc):**
M16 (Customer 360), M17 (Loyalty), M20 (Customer app/web), M21 (CRM/Service) for R4,
plus M18 (Order management) and M19 (Picking/packing/delivery) for R5 — all expanded
to Appendix-B detail (`docs/requirements/`, 24 requirements traced), from the roadmap
§5 FR lines — nothing invented.

Not yet expanded (later releases): M22, M24–M28 (R6), M31, M36, and the cross-cutting
sets SEC/PRV/NFR/AI-NFR/MG — expanded when their release/stage is reached.

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
- **Stage 5 foundation build** — started with the `Money` primitive (done, tested). Next:
  shared ids/enums/event types, then IaC, then the base platform. Store-fact-independent
  foundation work proceeds; store-specific modules wait on the Stage 1 facts (A-11).

## Blocked / needs owner input
- **D3/D4/D5/D8 — CLOSED (2 Aug 2026).** D3 = ₹20,000/month; D4 = **Mr Sivakumar**
  (second technical custodian); D5 = GO given today; D8 = Store-Core 1 April 2027, full
  completion phased. Recorded in `docs/registers/decisions.md` and ADR-0001. The coding
  HOLD that depended on these is lifted. (D3 still wants a commercial check vs real vendor
  quotes; a signed GO record should be filed for the audit trail.)
- **The 20 AVR facts (Stage 1) + the trading-day cut-off time** — store-specific inputs in
  `docs/discovery/avr-closure.md`, each needing a named person; gathered in the store.
  These still gate the M1 spec-freeze and store-specific build (finding A-11).
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
