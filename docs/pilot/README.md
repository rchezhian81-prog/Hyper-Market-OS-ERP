# `docs/pilot/` — controlled-pilot release-candidate package

Prepared for the owner's authorization to move from development into **controlled pilot preparation and UAT**
(non-production only). Release candidate: commit **`c45b948`** (accepted baseline through PR #574), local tag
`pilot-rc-1`.

| Document | What it is |
|---|---|
| `RELEASE-MANIFEST.md` | the release candidate: SHA, gate results, migrations, flags, blocked items, rollback target |
| `DEPLOYMENT-CHECKLIST.md` | the gated pilot-deploy checklist (wraps `../runbooks/pilot-deployment.md`) |
| `ENV-VAR-INVENTORY.md` | every environment variable, purpose, required?, secret? — **no secret values** |
| `MIGRATION-AND-ROLLBACK.md` | the 11 migrations, forward plan, and rollback plan |
| `COMPATIBILITY-CHECKLIST.md` | Node / pnpm / PostgreSQL / Docker / browser / offline compatibility |
| `KNOWN-LIMITATIONS.md` | honest boundaries of the baseline (KL-01…KL-14) |
| `PILOT-FEATURE-MATRIX.md` | what is ON / SIMULATED / DISABLED for the pilot |
| `EVIDENCE-INDEX.md` | pointers to the gate/test/record evidence |
| `PILOT-READINESS-GAP-ASSESSMENT.md` | the 8-phase plan vs. what exists, gaps, and external gates — the roadmap for Phases 2–8 |
| `SAFE-PILOT-ENVIRONMENT.md` | **(Phase 2)** the isolated pilot environment: how to bring it up + the isolation/HTTPS/RBAC/capacity checklist |
| `MONITORING-AND-ALERTS.md` | **(Phase 2)** what to watch, thresholds, and where alerts go |
| `BACKUP-RESTORE-REHEARSAL.md` | **(Phase 2)** executed backup + restore-into-clean-env evidence |
| `PILOT-SEED-DATASET.md` | **(Phase 4)** the controlled, demo-marked seed dataset (`../../db/seed/pilot/`): what it seeds, how it stays non-real, and the slice roadmap |
| `FEATURE-SAFETY.md` | **(Phase 3)** which dangerous capabilities are off/gated by default (asserted by `tests/integration/pilot-feature-safety.test.ts`), and the honest boundaries incl. GAP-SEC-06 |
| `FAILURE-DRILLS.md` | **(Phase 6)** the 16 resilience scenarios → control → proving test, the consolidated `tests/integration/pilot-failure-drills.test.ts`, and the live drills left for stand-up |
| `UAT-ROLE-CHECKLIST.md` | **(Phase 5)** the role-based UAT checklist — 12 roles × connected flows with per-case fields for the tester and business sign-off |

Infra: `../../infra/compose/docker-compose.pilot.yml` (resource/capacity overlay) · `../../infra/compose/.env.pilot.example` (pilot env template, placeholders only).

**Non-production.** Not approved for public launch, live statutory submission, live payroll, irreversible
migration, or destructive production actions. External gates and owner GO are tracked in
`../OWNER-ACTION-REGISTER.md` and `../registers/external-dependencies.md`.
