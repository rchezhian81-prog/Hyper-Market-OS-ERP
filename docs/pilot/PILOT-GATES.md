# Pilot gates + defect policy (Phase 7)

_Release candidate `pilot-rc-1`. Non-production pilot only._

No floor pilot starts until every **blocking gate** below is green and the defect policy is satisfied.
The gates are drawn from what the pilot must guarantee (P-01…P-08, the hard rules) and each maps to
evidence already produced in Phases 1–6. "Green" means the cited evidence exists and passes; where a gate
can only be closed on the stood-up environment it is marked **⛔ live** and named as such.

## Blocking gates (all must be green before the floor pilot)

| Gate | What it proves | Evidence | State |
|---|---|---|---|
| G1 — Release baseline | The pilot runs a known, immutable build | `RELEASE-MANIFEST.md` (SHA `c45b948`), full gate green | ✅ |
| G2 — Isolated environment | Pilot DB/storage/secrets are separate; nothing production is reachable | `SAFE-PILOT-ENVIRONMENT.md`, `docker-compose.pilot.yml` (`-p sre-pilot`), `.env.pilot.example` | ✅ (stand up on the box) |
| G3 — Feature safety | Every dangerous "live" capability is off/gated by default | `FEATURE-SAFETY.md` + `tests/integration/pilot-feature-safety.test.ts` (8) | ✅ |
| G4 — Controlled data | A demo-marked, non-real dataset exists and cannot mix with real data | `PILOT-SEED-DATASET.md` + `tests/integration/pilot-seed.test.ts` (22) | ✅ |
| G5 — Resilience | Offline, restart, duplicate, cross-tenant, no-oversell, stale-token all hold | `FAILURE-DRILLS.md` + `tests/integration/pilot-failure-drills.test.ts` (5) + the wider suite | ✅ |
| G6 — Backup + restore | A backup restores into a clean DB and reconciles exactly; overwrite refused | `BACKUP-RESTORE-REHEARSAL.md` (executed on PG16) | ✅ |
| G7 — Monitoring | Health + trading-integrity signals exist, each alert has a named owner | `MONITORING-AND-ALERTS.md` + `ops-health`/`standup-check` tests | ✅ (wire the channel on the box) |
| G8 — UAT blocking cases | The role-based UAT blocking cases pass with real people | `UAT-ROLE-CHECKLIST.md` | ⛔ live — owner/store execution + sign-off |
| G9 — Rollback rehearsed | The previous release can be redeployed + restored under a simulated failure | `MIGRATION-AND-ROLLBACK.md` + backup/restore (G6); redeploy half | ⛔ live — timed drill on the box |
| G10 — Named incident owner + daily reconciliation | Someone owns incidents; daily figures reconcile against the parallel run | store pilot plan (below) | ⛔ live — owner names the person |

The **✅** gates are proven by automated tests and executed rehearsals now. The **⛔ live** gates (G8, G9,
G10, and the stand-up halves of G2/G7) can only close on the actual pilot box with the owner/store present —
they are the content of the OWNER GO decision, not blockers I can clear autonomously.

## Defect policy (applies to UAT and the drills)

| Severity | Meaning | Effect on the pilot |
|---|---|---|
| **P0** | No sale possible on the floor, or a data-integrity doubt (a sale could be lost, duplicated or mis-stated) | **Blocks.** The pilot does not start / stops until fixed and retested. |
| **P1** | A core connected flow is blocked with no safe workaround | **Blocks.** Same as P0 for go-live; a fix + retest is required. |
| **P2** | A flow works but with a workaround, or a non-core defect | **Documented acceptance.** The owner may accept it in writing with a named target release; it does not block. |
| **P3 / P4** | Cosmetic or minor | **Backlog.** Logged, does not block. |

Rules that never bend regardless of severity pressure: a **P0/P1 is never downgraded to keep a date**; an
accepted **P2 is written down** (what, why, target release) — silence is not acceptance; and **no defect is
closed without a retest** recorded against its UAT case.

## Exit from the gate

The floor pilot may begin only when: every ✅ gate is confirmed green on the stood-up box, the ⛔ live gates
are executed and signed, and the defect log shows **no open P0/P1**. That combined state is what the owner
signs as **GO** (see `PILOT-READINESS-PACKAGE.md`).
