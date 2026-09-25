# Pilot readiness package (Phase 8) — the consolidated GO decision

_Release candidate `pilot-rc-1` (commit `c45b948`). **Non-production.** This is the single document that
ties the controlled-pilot preparation together and states the one decision that is the owner's._

## Where we are

All the work that can be done **without** a real host, real credentials, real personal/financial data, a
paid provider, legal/CA/HR sign-off, or a physical store has been done and merged, each behind a passing
gate. The pilot is **prepared**; it is **not started** — starting it on the floor is the owner's GO.

| Phase | Deliverable | Status | Evidence |
|---|---|---|---|
| 1 | Release-candidate package | ✅ | `RELEASE-MANIFEST.md`, `DEPLOYMENT-CHECKLIST.md`, `ENV-VAR-INVENTORY.md`, `MIGRATION-AND-ROLLBACK.md`, `COMPATIBILITY-CHECKLIST.md`, `KNOWN-LIMITATIONS.md`, `PILOT-FEATURE-MATRIX.md`, `EVIDENCE-INDEX.md` |
| 2 | Safe pilot environment | ✅ | `SAFE-PILOT-ENVIRONMENT.md`, `MONITORING-AND-ALERTS.md`, `BACKUP-RESTORE-REHEARSAL.md` (executed), compose overlay + env template |
| 3 | Feature-safety verification | ✅ | `FEATURE-SAFETY.md` + `pilot-feature-safety.test.ts` (dangerous features off/gated by default) |
| 4 | Controlled seed dataset | ✅ | `PILOT-SEED-DATASET.md` + `db/seed/pilot/` + `pilot-seed.test.ts` (22) — demo-marked, real routes |
| 5 | Role-based UAT checklist | ✅ authored | `UAT-ROLE-CHECKLIST.md` (12 roles × connected flows) — execution/sign-off is the owner's |
| 6 | Failure-drill report | ✅ | `FAILURE-DRILLS.md` + `pilot-failure-drills.test.ts` (5) — all 16 scenarios mapped to proof |
| 7 | Pilot gates + defect policy | ✅ | `PILOT-GATES.md` |

Baseline health: the full local gate is green (typecheck, lint, secret-scan, ~7,700 unit/integration, perf,
130 e2e), and the real-PostgreSQL DB/migration suite + the backup/restore loop were executed for real.

## The store pilot plan (small, reversible, one branch)

This is the plan the owner is being asked to GO on; the detailed run-sheet is
`../runbooks/pilot-plan-narrow-deep.md` and `../runbooks/pilot-run-sheet.md`.

- **Scope:** one branch, a narrow-and-deep pilot on the seeded demo data first, then the store's own data
  once the owner supplies it (UAT-02 workshop).
- **Reversible:** the legacy system keeps running **in parallel** — it is **not retired**. Every pilot day
  is reconciled against it.
- **Named incident owner:** one person owns every alert and incident for the pilot (G10). The owner names them.
- **Daily reconciliation:** pilot totals vs. the legacy/parallel figures, signed off before end of day; any
  unexplained difference is investigated before it compounds.
- **Rollback trigger:** a pre-agreed condition (a P0/P1 that cannot be fixed same-day, or a reconciliation
  difference that cannot be explained) means fall back to legacy — which is safe because legacy never stopped
  and the restore-to-clean path is rehearsed (`MIGRATION-AND-ROLLBACK.md`, G6/G9).
- **Do NOT connect** production payment, GST/GSP, Tally, SMS/WhatsApp, banking or payroll providers; the
  pilot runs on sandbox/simulator adapters (`PILOT-FEATURE-MATRIX.md`).

## What is left, and whose decision it is (the Owner Action list)

Everything remaining needs the owner or an outside party — I stop here. Full register:
`../registers/external-dependencies.md` and `../OWNER-ACTION-REGISTER.md`.

| Ref | What the owner must decide/provide | Blocks |
|---|---|---|
| **EX-01 / OA-5** | Cloud host + managed PostgreSQL + the spend for it | Standing the pilot up off the local box (G2/G7/G9 live halves) |
| **OA-4** | Production IdP (the pilot uses the local/test IdP meanwhile) | Real logins at production; not the pilot |
| **OA-6** | The pilot's genesis owner/tenant identity on the box | First real admin login |
| **EX-09** | Store hardware (lanes, scanners, printers, scales, drawers) — ⏳ started | The physical floor pilot |
| **EX-03 / EX-07 / EX-08 / EX-06 / EX-04-05** | Paid providers + statutory credentials + licences (payment, GST/GSP, Tally, messaging) — several ⏳ started | Any **live** money/statutory/messaging action — deliberately off for the pilot |
| **UAT sign-off (G8)** | The store executes the role-based UAT and the owner signs each section | Starting the floor pilot |
| **Named incident owner + daily reconciliation (G10)** | The owner names the person and commits to the daily sign-off | Starting the floor pilot |
| **Live rollback drill (G9)** | Run the timed redeploy + restore drill on the box | Starting the floor pilot |
| **Legal/CA/HR** | Legal confirmation for "delete my data" execution; CA for control-total sign-off; HR for real payroll | Those specific live actions (all off for the pilot) |
| **GAP-SEC-06** | Pre-production security item: add API-tier step-up re-auth (documented in `FEATURE-SAFETY.md`) | Production launch, not the pilot |

## Recommendation and the decision

**Recommendation:** the software side of controlled pilot preparation is complete and proven. The next step
is a single, small, reversible pilot on one branch, run against the safe environment and the demo dataset,
with the legacy system kept in parallel.

**This is where I stop.** I will not stand the pilot up on a real host, connect any live provider, touch any
real personal/financial data, or start the floor pilot — each of those is on the Owner Action list above and
is the owner's to authorise. Two or three concrete options for the owner:

1. **Stand up the pilot now on a chosen host (EX-01/OA-5)** and run the UAT + live drills (G8/G9/G10) on the
   seeded demo data — no real data, no live providers. Lowest risk; proves the whole loop end-to-end.
2. **Do the master-data workshop first (UAT-02)** to load the store's own data into the pilot before UAT, so
   UAT runs on real catalogue/prices — needs the owner's time, still no live providers.
3. **Hold** until specific outside-party items (e.g. store hardware EX-09, payment EX-03) are in hand, then
   stand up — slower, but fewer parallel unknowns during the pilot.

**No pilot is activated automatically. Awaiting the owner's GO.**
