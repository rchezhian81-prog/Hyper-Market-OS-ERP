# Pilot release manifest — `pilot-rc-1`

_Generated 25 September 2026. **Non-production pilot release candidate.** Not approved for public launch, live
statutory submission, live payroll, irreversible migration, or destructive production actions._

## Identity

| Field | Value |
|---|---|
| **Authoritative immutable marker** | **commit SHA `c45b948bfb42a6d77ee2ba7b5b7b7cbb86ecaeba`** (git SHAs are immutable + reproducible) |
| Release candidate tag | annotated tag **`pilot-rc-1`** created locally on that SHA; **remote publication blocked by this session's branch-scoped credentials (tag-ref push → HTTP 403)** — see "Tag publication" below |
| Branch | `main` (dev branch `claude/new-session-lw91i4` synced, 0 ahead / 0 behind) |
| Accepted baseline | development baseline **through PR #574** (owner-accepted) |
| Open / conflicting PRs | **none** |
| Working tree | clean |

## What is in this baseline

The full SRE Retail OS as built to date, including the six owner-decision items closed this program
(portal login; delivery-substitution exception ownership; till-side concession tagging; company-wide reports;
customer delete-my-data workflow; the consolidated Owner Action Register). Per-module maturity is in
`docs/completion-status.json`; requirement→test traceability in `docs/traceability.md`; the external-gate
ledger in `docs/OWNER-ACTION-REGISTER.md`.

## Gate results at the release SHA (all green)

| Gate | Command | Result |
|---|---|---|
| Type check | `pnpm run typecheck` | ✅ pass |
| Lint | `pnpm run lint` | ✅ pass |
| Secret scan (whole repo) | `pnpm run secret-scan` | ✅ pass |
| Unit + integration (in-memory) | `pnpm run test` | ✅ pass |
| Performance | `pnpm run test:perf` | ✅ 31 passed |
| Browser E2E (Chromium) | `pnpm run test:e2e` | ✅ 40 files / 130 passed |
| Dependency vulnerabilities | `pnpm audit --audit-level=high` | ✅ pass (2 moderate only — KL-13) |
| SBOM drift | `pnpm run sbom` + diff | ✅ no drift (`docs/evidence/sbom.json`) |
| **Real-PostgreSQL DB + migration** | `pnpm run test:db` on PG16 | ✅ **287 files / 1820 passed**; 11/11 migrations applied |

Evidence: `docs/pilot/EVIDENCE-INDEX.md`.

> Note: the GitHub Actions workflow (`.github/workflows/ci.yml`) defines these same gates, but Actions is not
> executing as a required check on this repository — so the **authoritative** gate is the local run recorded
> above, reproduced on the release SHA in this session.

## Database migrations (11)

`0001`–`0011` in `db/migrations/` — forward-only, additive, append-only-guarded. Full list + rollback plan:
`docs/pilot/MIGRATION-AND-ROLLBACK.md`.

## Feature-flag / safety defaults (pilot)

- Optional modules **default-off** per tenant (`checkEntitlement`, M36-FR-01).
- `MIGRATION_TARGET_KIND=rehearsal` (never `production` in pilot); `NODE_ENV=production`.
- Login via **local/test IdP**; tender **test-mode**; GST/e-invoice **sandbox**; notifications **mocked**;
  AI **advisory-only + kill switch**.
- Disabled by default (owner GO to enable): live GST filing, live e-invoice/e-way-bill, live payroll, real
  bank-file release, autonomous financial/inventory actions, delete-my-data production execution, production
  messaging, production payment capture, irreversible legacy migration.

Full matrix: `docs/pilot/PILOT-FEATURE-MATRIX.md`.

## Externally blocked items (do not block a test-mode pilot)

From `docs/registers/external-dependencies.md` and `docs/OWNER-ACTION-REGISTER.md`: EX-03 payment provider
(⏳), EX-07 GST/GSP + CA (⏳), EX-08 licences (⏳), EX-09 store hardware (⏳), EX-13 penetration test (⏳),
EX-01/OA-5 cloud hosting + spend, OA-4 production IdP, OA-11 store map coordinates. Item 5 (delete-my-data)
additionally needs **legal confirmation**.

## Rollback target

Primary: the **legacy billing/ERP system, kept running in parallel** (the pilot does not retire it). Mechanics
(restart → redeploy previous tag → restore encrypted backup into a clean env) in
`docs/pilot/MIGRATION-AND-ROLLBACK.md`. Restore is rehearsed in Phase 7, not assumed.

## Tag publication (one owner/admin step)

The annotated RC tag was created locally but **could not be pushed** — this session's git credentials are
scoped to the working branch, and a tag-ref push returns **HTTP 403** (there is also no tag/ref-creation tool
available to the session). This is an environment permission limit, **not** an owner decision and **not** one
of the external gates. The commit SHA above is the authoritative, immutable marker in the meantime. To publish
the friendly tag, a session/credential with tag-push permission (or the owner locally) runs:

```
git tag -a pilot-rc-1 c45b948bfb42a6d77ee2ba7b5b7b7cbb86ecaeba -m "Pilot release candidate 1 (non-production)"
git push origin refs/tags/pilot-rc-1
```

(or create a GitHub Release from tag `pilot-rc-1` on that SHA). Nothing downstream depends on the tag existing
remotely — every artifact here pins the SHA.

## Known limitations

`docs/pilot/KNOWN-LIMITATIONS.md` (KL-01 … KL-14). None trading-blocking for a test-mode pilot.
