# Pilot-readiness gap assessment

_Release candidate `pilot-rc-1` (commit `c45b948`). Assesses the owner's 8-phase pilot-preparation plan
against what already exists in the repository, what I can close autonomously, and what is an external gate._

Status key: ✅ **present** (exists + verified) · 🟡 **partial** (exists, needs assembly/execution I can do) ·
🔴 **gap** (must build autonomously) · ⛔ **external gate** (owner/provider/legal/hardware — I stop and ask).

## Phase 1 — Baseline & release candidate — ✅ DONE this work package
- ✅ Clean tree, synced, no open PRs, all gates green, SHA, migrations, flags, blocked items, rollback target.
- ✅ Immutable RC tag `pilot-rc-1`.
- ✅ Artifacts: release manifest, deployment checklist, env-var inventory (secret-free), migration+rollback
  plan, compatibility checklist, known-limitations register, pilot feature matrix, evidence index (this folder).

## Phase 2 — Safe pilot environment
- ✅ present: one-machine stack (`infra/compose`), API/edge Dockerfiles, nginx/TLS config, env template,
  `environments-and-secrets.md`, backup/restore scripts + runbook, health probes (`/livez` `/readyz`),
  `standup:check`, RBAC + tenant isolation (proven), audit logging + tamper-evident chain.
- 🟡 partial → **my next work packages:** a dedicated **pilot compose profile** (separate DB name/volume,
  pilot-only secrets template, resource limits, HTTPS-on by default, secure-cookie settings surfaced); a
  **monitoring & alerts** definition (what to watch, thresholds, where alerts go); an **encrypted-backup +
  tested-restore rehearsal** with recorded evidence.
- ⛔ external gate: an actual cloud host + managed PG + spend (EX-01 / OA-5). The one-box pilot needs none of
  this; a hosted pilot does. Provisioning real infra = expenditure → owner.

## Phase 3 — Feature safety
- ✅ present: entitlements default-off (`checkEntitlement`), test-IdP guardrail (`no-test-idp-in-production`),
  AI kill switch + budget, maker-checker on money/privilege/erasure, `MIGRATION_TARGET_KIND` gate.
- ✅ **feature-safety verification built** — `tests/integration/pilot-feature-safety.test.ts` (8 cases) asserts,
  against the REAL surface for a fresh pilot tenant, that live GST/e-invoice is not live + killable, the AI kill
  switch is ON, every optional feature is OFF (and a gated route is refused until enabled), migration refuses a
  production target, the cutover checklist is NO-GO by default, §28 self-approval is refused, and a
  no-grant user is default-denied. Documented in `FEATURE-SAFETY.md`, which also records the honest boundaries:
  payroll bank-file release + "delete my data" are **gated** (maker-checker/RBAC) not default-off, and
  **API-tier step-up re-auth does not exist (GAP-SEC-06)** — a pre-production security item, not a pilot claim.

## Phase 4 — Pilot data
- ✅ present: import engine (M30), catalogue pack builder, `pilot-setup-workbook.xlsx`, synthetic fixtures used
  across tests.
- ✅ **the controlled pilot seed dataset is built** — a reproducible, demo-marked applier that drives the
  REAL cloud routes (`db/seed/pilot/`, see `PILOT-SEED-DATASET.md`), proven end-to-end in
  `tests/integration/pilot-seed.test.ts` (22 cases) and tenant-isolated so demo data cannot reach a real tenant.
  - **4a foundation** — genesis owner, six role logins, entitlements, org skeleton (GST reg → company → branch → warehouse).
  - **4b catalogue** — HSN tax-rate schedules, five products through the real compliance gate (incl. a regulated
    food category), barcodes, pack hierarchies, governed prices.
  - **4c trading partners + stock** — two suppliers (+ portal login), two bins, a goods receipt through the real
    receiving gate (batch/expiry → sellable on-hand), two demo customers (consent + points).
  - **4d transactions** — till float + clean shift close, serviceability period, concession contract, coupons,
    an OMS order reserving seeded stock, a demo-marked payroll draft, and a sandbox e-invoice through the real
    Rule-46 gate.
  - **Operational packaging note:** the applier is the reproducible seed mechanism; wiring it to a running pilot
    API + the pilot's test IdP for a real stand-up run lands with the environment stand-up (⛔ EX-01 / OA-5 host
    decision). Categories with no write route (delivery slot definitions, tender-type config) are recorded in
    `PILOT-SEED-DATASET.md` rather than faked. Maturity: **integration tested** → pilot verified on stand-up.

## Phase 5 — Formal UAT
- ✅ present: `uat-calendar.md` register, `store-go-live-checklist.md`, role model in `roles.ts`.
- ✅ **role-based UAT checklist authored** — `UAT-ROLE-CHECKLIST.md` covers 12 pilot roles (cashier, store
  manager, owner, accountant, CA, warehouse/GRN, picker, delivery, buyer, supplier, customer, platform admin)
  across their connected flows, each case carrying the required per-case fields (requirement ID, role,
  prerequisite, steps, expected, actual, pass/fail, severity, defect ref, retest, business sign-off), keyed to
  the seeded demo tenant and cross-referenced to the `UAT-##` witness register. **Execution + business
  sign-off is the owner/store** (⛔ for sign-off).

## Phase 6 — Pilot failure tests
- ✅ present: a large resilience suite already exists (offline/restart/idempotency/cross-tenant/duplicate/
  stale-conflict/partial-delivery/audit-tamper) — see the evidence index.
- ✅ **failure-drill report built** — `FAILURE-DRILLS.md` maps all 16 required scenarios to their control +
  proving test(s), and `tests/integration/pilot-failure-drills.test.ts` (5 cases) co-locates the
  surface-level invariants (idempotent replay, no oversell/negative stock, unauthorized 403, cross-tenant
  isolation, tampered/expired token 401). Backup + restore-to-clean is **executed** (`BACKUP-RESTORE-REHEARSAL.md`).
  Two items remain **live drills on the stood-up box** (⛔ EX-01/OA-5): the full rollback rehearsal
  (redeploy + restore under simulated failure) and confirming alert delivery reaches the named incident owner.

## Phase 7 — Pilot gates
- ✅ present: gate concepts across `store-go-live-checklist.md` + `pilot-plan-narrow-deep.md`.
- ✅ **pilot-gate checklist + defect policy built** — `PILOT-GATES.md`: 10 gates (G1 baseline … G10 named
  incident owner) each with evidence + green/⛔-live state, and the defect policy (P0/P1 block; P2 documented
  acceptance; P3/P4 backlog; P0/P1 never downgraded, P2 always written down, nothing closed without a retest).
  The ⛔-live gates (UAT sign-off, live rollback drill, incident owner) are the content of the owner GO.

## Phase 8 — Store pilot plan
- ✅ present: `pilot-plan-narrow-deep.md`, `pilot-run-sheet.md`, `pilot-setup-workbook`, `cutover-weekend.md`,
  `in-store-install.md`. The narrow-and-deep plan (one branch, parallel run, daily reconciliation, no legacy
  retirement, rollback trigger) is already the owner-chosen option.
- ✅ **consolidated readiness package built** — `PILOT-READINESS-PACKAGE.md` ties Phases 1–7 together, states
  the store pilot plan (one branch, parallel legacy, named incident owner, daily reconciliation, rollback
  trigger, no live providers), lists the Owner Action items, and ends with the GO decision (2–3 concrete
  options). ⛔ activation, physical-store scheduling, and **final pilot GO** are owner-only — **no pilot is
  activated automatically; awaiting the owner's GO.**

## External gates (I will STOP and ask — never do autonomously)

Paid provider selection · production credentials · access to real personal/financial data · legal/CA/HR
approval · destructive/irreversible action · expenditure · physical-store scheduling · final pilot GO ·
production GO. Enumerated per item in `docs/OWNER-ACTION-REGISTER.md` and
`docs/registers/external-dependencies.md`.

## Proposed sequence of the remaining autonomous work packages

1. **Phase 2** pilot environment profile + monitoring/alerts def + backup/restore rehearsal evidence.
2. **Phase 4** controlled pilot seed dataset (reproducible, demo-marked).
3. **Phase 3** feature-safety verification proof.
4. **Phase 6** failure-drill report (incl. rollback + restore + alert-delivery rehearsals).
5. **Phase 5** role-based UAT checklist assets (12 roles × flows).
6. **Phase 7** pilot-gate checklist + defect policy.
7. **Phase 8** consolidated readiness package + owner GO request → **STOP for owner GO**.

Each lands as one focused, gate-green PR with an 8-point report.
