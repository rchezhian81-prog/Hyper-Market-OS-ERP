# Backup & restore rehearsal — executed evidence (Phase 2)

_Release candidate `pilot-rc-1` (commit `c45b948`). Executed 25 September 2026 against a disposable
PostgreSQL 16 cluster. M35-FR-01 / QG-07 / QG-08 — "a restore that has actually been tested, not assumed."_

A backup you cannot restore is a file, and a restore that exits zero can still have lost data. This rehearsal
proves the whole loop with `scripts/backup.mjs` + `scripts/restore.mjs`: checksum integrity, exact
control-total reconciliation (rows **and** money **and** append sequence), and the destructive-overwrite
refusal.

## Procedure executed

1. Fresh PostgreSQL 16, migrated to head (`pnpm run db:migrate` → **11/11 migrations applied**).
2. Seeded 3 synthetic money-bearing events into `event_ledger` (`SaleCommitted`, totals 12500 + 4000 + 999
   paise = **17499**). Clearly non-real rehearsal data.
3. `pnpm run db:backup` → produced the dump + a manifest carrying the SHA-256 checksum and control totals.
4. Created a **clean** target database.
5. `pnpm run db:restore --manifest … --target <clean>` → verified checksum, restored, reconciled.
6. Re-ran the restore against the now-non-empty target to prove it **refuses** to overwrite.

## Result (verbatim key lines)

**Backup manifest control totals**
```
sha256   2254b19c428a1cf3a4f22f3d47dc9575d83905de456a591f830ae1befd31e8aa
rows     {"audit_log":0,"config_versions":0,"event_ledger":3,"idempotency_keys":0,
          "number_series":0,"projection_snapshot":0,"schema_migrations":11,"sync_outbox":0}
```

**Restore into clean target**
```
checksum verified (19296 bytes)
restoring into the target database
✅  Restore reconciles exactly against the manifest.
   tables 8
   rows   {…,"event_ledger":3,"schema_migrations":11,…}
   money  {"SaleCommitted":17499}
```

**Destructive-overwrite refusal (safety)**
```
REFUSED: the target already has 8 table(s).
Restoring over live data is destructive. Re-run with --force if that is intended.
```

## What this proves

- The backup is **verifiable**: SHA-256 checksum + control totals travel with it; a corrupted/truncated dump
  is refused before any restore.
- The restore is a **restore, not a hope**: it reconciles rows, money (to the paisa), and the append sequence
  against the manifest, and fails loudly on any difference.
- Restore **never silently overwrites** a non-empty database (destructive by default is refused).
- This is the mechanism behind the rollback plan (`MIGRATION-AND-ROLLBACK.md`): restore into a **clean**
  environment, never over a live one.

## Pilot operating notes

- Encryption at rest: the storage layer encrypts in a real deployment; set `BACKUP_ENCRYPTED=true` and
  `BACKUP_OFFSITE=<location>` so the manifest records it (M35 requires an **immutable off-site copy**).
- Schedule `db:backup` end-of-day during the pilot; keep one copy off the pilot machine.
- The full rollback rehearsal (redeploy + restore-into-clean under a simulated failure) is repeated as a timed
  drill in Phase 6/7.
