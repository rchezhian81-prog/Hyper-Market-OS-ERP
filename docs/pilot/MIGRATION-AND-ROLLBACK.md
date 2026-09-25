# Database migration & rollback plan (pilot)

_Release candidate `pilot-rc-1` (commit `c45b948`). Non-production pilot only._

## Migration model

The database is changed **only** through the ordered scripts in `db/migrations/`, applied by
`scripts/migrate.mjs` (`pnpm run db:migrate`). Migrations are **forward-only and additive**: the event
ledger is append-only, and `0004`/`0008` install database guards that **refuse `UPDATE` and `DELETE`** on the
ledger and audit tables (hard rule #2, #6). There are deliberately **no destructive down-migrations** — you
never "roll a table back" over committed evidence. Re-running the migrator is **idempotent**: each script is
`apply`ed once or `skip`ped, ending "Done — N migration(s) checked."

`MIGRATION_TARGET_KIND` gates which environment a *data* trial-load may touch; for the pilot it stays
`rehearsal` and is **never** `production` (hard rule #7).

## Migrations in this release candidate (11)

| # | Script | What it creates |
|---|---|---|
| 0001 | `0001_event_ledger.sql` | the append-only event ledger (book of record) |
| 0002 | `0002_sync_outbox.sql` | the store→cloud sync outbox |
| 0003 | `0003_config_versions.sql` | versioned settings |
| 0004 | `0004_append_only_guards.sql` | DB guards refusing UPDATE/DELETE on the ledger |
| 0005 | `0005_event_id_domain_scoped.sql` | event id scoped per domain/tenant |
| 0006 | `0006_stream_type_index.sql` | `(tenant, stream, seq)` + type index for fast reads |
| 0007 | `0007_idempotency_keys.sql` | idempotency-key register (at-most-once writes) |
| 0008 | `0008_audit_log.sql` | the request-level audit log |
| 0009 | `0009_number_series.sql` | gapless number series (invoices etc.) |
| 0010 | `0010_audit_log_hash_chain.sql` | per-tenant tamper-evident hash chain on the audit log |
| 0011 | `0011_projection_snapshot.sql` | projection snapshot table (read-model rebuild) |

Applied in order on a fresh pilot database by `db:migrate`; verified by the migration suite
(`tests/migration`) and the real-PostgreSQL stage-gate job.

## Forward plan (pilot deploy)

1. Provision the **pilot** Postgres (separate instance/database — see `SAFE-PILOT-ENVIRONMENT` when Phase 2
   lands; for one-box, `infra/compose` brings up `db`).
2. Set `DATABASE_URL` in the pilot `.env` (never committed).
3. Run `pnpm run db:migrate` (the compose `migrate` service does this automatically and exits 0).
4. Confirm with `docker compose logs migrate` → "Done — N migration(s) checked", and `pnpm run standup:check`
   → GREEN.
5. Verify the tamper-evident chain any time with `pnpm run verify:audit`.

## Rollback plan

**Rollback target for the pilot: the existing legacy billing/ERP process, kept running in parallel.** This is
the first release; there is no prior tag to fall back to, and the pilot plan (`docs/runbooks/pilot-plan-narrow-deep.md`)
deliberately does **not** retire the legacy system. So the primary rollback is operational, not a code
down-grade: **stop using the pilot, keep trading on the legacy system — no data is lost because the pilot ran
in parallel with daily reconciliation.**

Code / data rollback mechanics, in order of least to most disruptive:

1. **Restart** a component — `docker compose restart <svc>` (config is checked at boot; a bad deploy fails
   fast and loud, it does not run half-configured).
2. **Redeploy the previous artifact** — once a *second* RC tag exists, `git checkout <previous-tag>` and
   redeploy. For `pilot-rc-1` there is no earlier tag; the fallback is the legacy system above.
3. **Restore the database** into a **clean** pilot environment from the last encrypted backup —
   `pnpm run db:backup` / `pnpm run db:restore` (see `docs/runbooks/backup-and-recovery.md`). Restore is
   **rehearsed**, not assumed (M35): Phase 7 includes a restore-to-clean-environment rehearsal with recorded
   evidence. Never restore over a live pilot DB; restore into a fresh one and repoint.
4. **Never** `docker compose down -v` on anything holding pilot evidence — it deletes the volume and is
   irreversible.

## Data-loss guarantee

No accepted sale is lost by a rollback: the POS commits locally first (hard rule #1) and syncs idempotently,
the ledger is append-only, and writes carry idempotency keys (0007) so a replay after a restart never
duplicates. Restart-recovery for sales and refunds is proven (`tests/integration/failed-sync-survives-restart.test.ts`).
