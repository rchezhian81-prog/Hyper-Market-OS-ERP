# Pilot evidence index — `pilot-rc-1`

_Release commit `c45b948`. Pointers to the proof behind the release manifest. No secrets appear in any listed
artifact._

## Automated-gate evidence (reproduced on the release SHA, this session)

| Evidence | What it proves | Where |
|---|---|---|
| Full gate run | typecheck + lint + secret-scan + unit/integration + perf (31) + e2e (40 files/130) all green (exit 0) | `pnpm run check` (session run; reproducible) |
| Real-PG DB/migration run | 287 files / 1820 tests green on PostgreSQL 16; **11/11 migrations applied** | `pnpm run db:migrate` + `pnpm run test:db` (session run) |
| Dependency scan | no high/critical advisories (2 moderate, KL-13) | `pnpm audit --audit-level=high` |
| SBOM | matches installed tree (no drift) | `docs/evidence/sbom.json` (+ `pnpm run sbom`) |
| Audit chain verifier | tamper-evident audit chain intact | `pnpm run verify:audit` (`scripts/verify-audit-chain.mts`) |

## Requirement & maturity records

| Record | Purpose | Where |
|---|---|---|
| Requirement → test traceability (RTM) | every requirement to a passing test + release | `docs/traceability.md` |
| Per-module maturity ledger | headline completion + per-module rungs | `docs/completion-status.json`, `docs/COMPLETION-MODEL.md` |
| Owner Action Register | external gates + six-item program status | `docs/OWNER-ACTION-REGISTER.md` |
| External dependency register | vendor/credential/hardware gates | `docs/registers/external-dependencies.md` |
| Session status log | what changed, per work package | `docs/STATUS.md` |

## Failure / resilience test evidence (already in the suite)

| Scenario | Test |
|---|---|
| Sale/refund survive app restart mid-sync | `tests/integration/failed-sync-survives-restart.test.ts` |
| Offline refund end-to-end (real browser) | `tests/e2e/*refund*`, POS e2e |
| Cross-lane / duplicate refund prevented | `tests/integration/cross-lane-refund-guard.test.ts` |
| Sale idempotency (replay safe) | sale operation-identity guard tests |
| Tenant isolation across restart | `tests/integration/access-durability.test.ts` |
| Tamper-evident audit chain (edit/drop/forge detected) | `tests/integration/the-trail-is-kept.test.ts`, `tests/unit/audit-chain.test.ts` |
| Day-close / sync reaches cloud through the edge | `tests/integration/day-close-reaches-the-cloud-through-the-edge.test.ts` |
| Company-wide report honesty (missing/stale/scope) | `tests/e2e/company-report.e2e.ts`, `tests/integration/reporting-consolidation.test.ts` |
| Governed erasure + prevent-restore | `tests/e2e/erasure-console.e2e.ts`, `tests/integration/erasure-execution.test.ts` |

> Phase 6 (pilot failure tests) will assemble these into a single executed failure-drill report and add any
> gaps (backup/restore rehearsal, rollback rehearsal, monitoring-alert delivery) with recorded evidence.

## Runbooks referenced by the release

`docs/runbooks/pilot-deployment.md`, `pilot-plan-narrow-deep.md`, `pilot-run-sheet.md`,
`environments-and-secrets.md`, `backup-and-recovery.md`, `store-go-live-checklist.md`,
`security-incident.md`, `branch-protection.md`.
