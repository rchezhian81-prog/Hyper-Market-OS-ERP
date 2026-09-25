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
- 🟡 partial → **my next work package:** a single **feature-safety verification test/checklist** that asserts
  every DISABLED-by-default capability (from the feature matrix) is off in a pilot config, and that
  re-authentication is required for the sensitive actions. Mostly assembling existing guards into one proof.

## Phase 4 — Pilot data
- ✅ present: import engine (M30), catalogue pack builder, `pilot-setup-workbook.xlsx`, synthetic fixtures used
  across tests.
- 🔴 gap → **my next work package:** a single **controlled pilot seed dataset** (org/branch/users/roles,
  products+barcodes+UOM, suppliers/customers, tax/HSN, stock+batches+expiry, warehouses/bins, prices/MRP/
  promos, tills/shifts/tenders, sample online orders, delivery zones/slots, concession sources, **demo-marked**
  payroll, sandbox GST records) as a reproducible seed script, clearly labelled non-real, never mixed with real
  exports.

## Phase 5 — Formal UAT
- ✅ present: `uat-calendar.md` register, `store-go-live-checklist.md`, role model in `roles.ts`.
- 🔴 gap → **my next work package:** a **role-based UAT checklist** (12 roles × connected flows) with the
  required per-case fields (requirement ID, role, prerequisite, steps, expected, actual, evidence, pass/fail,
  severity, defect ref, retest, business sign-off). Authoring the assets is autonomous; **execution + business
  sign-off is the owner/store** (⛔ for sign-off).

## Phase 6 — Pilot failure tests
- ✅ present: a large resilience suite already exists (offline/restart/idempotency/cross-tenant/duplicate/
  stale-conflict/partial-delivery/audit-tamper) — see the evidence index.
- 🟡 partial → **my next work package:** a **failure-drill report** that runs and records these as one pilot
  drill, plus the three not-yet-as-drills: **backup creation + restore to a clean env**, **rollback
  rehearsal**, and **monitoring-alert delivery**. All doable autonomously against the pilot stack.

## Phase 7 — Pilot gates
- ✅ present: gate concepts across `store-go-live-checklist.md` + `pilot-plan-narrow-deep.md`.
- 🟡 partial → **my next work package:** a single **pilot-gate checklist** (authenticated E2E, tenant
  isolation, POS offline/cable-pull, test-mode tender, backup/restore, monitoring/alerts, rollback rehearsal,
  critical security checks, pilot users/permissions) each with a green/red status + evidence link, and the
  **defect policy** (P0/P1 block, P2 documented acceptance, P3/P4 backlog). Final gate = ⛔ **owner UAT
  approval + owner GO**.

## Phase 8 — Store pilot plan
- ✅ present: `pilot-plan-narrow-deep.md`, `pilot-run-sheet.md`, `pilot-setup-workbook`, `cutover-weekend.md`,
  `in-store-install.md`. The narrow-and-deep plan (one branch, parallel run, daily reconciliation, no legacy
  retirement, rollback trigger) is already the owner-chosen option.
- 🟡 partial → **my final work package:** a **consolidated readiness package** that ties the above together and
  a one-page GO request. ⛔ activation, physical-store scheduling, and **final pilot GO** are owner-only.

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
