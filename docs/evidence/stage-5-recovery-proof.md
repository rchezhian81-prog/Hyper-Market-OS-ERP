# Stage 5 gate evidence — reproducible deploy and restore proof

**Gate:** roadmap Stage 5 (Engineering foundation) — *"Reproducible deploy and restore
proof."* Also satisfies **QG-08 Recovery** (backup restore rehearsed) and the M35-FR-01
acceptance *"a test database is destroyed and restored."*

**Executed:** 4 August 2026, against **PostgreSQL 16.13** — a real server, not a mock, not
an in-memory double.

---

## 1. Reproducible deploy — from nothing to a working schema

```
$ pnpm db:migrate
  apply  0001_event_ledger.sql
  apply  0002_sync_outbox.sql
  apply  0003_config_versions.sql
Done — 3 migration(s) checked, 3 applied.
```

Re-run immediately, to prove the deploy is repeatable rather than one-way:

```
$ pnpm db:migrate
  skip   0001_event_ledger.sql
  skip   0002_sync_outbox.sql
  skip   0003_config_versions.sql
Done — 3 migration(s) checked, 0 applied.
```

Resulting schema: `config_versions`, `event_ledger`, `schema_migrations`, `sync_outbox`.

## 2. Defect found and fixed during this proof

Running against a real database revealed that **`event_ledger` accepted `UPDATE` and
`DELETE`**:

```
$ UPDATE event_ledger SET type='Tampered' WHERE seq=1;   →  UPDATE 1
$ DELETE FROM event_ledger WHERE seq=1;                  →  DELETE 1
```

Append-only was enforced **only in application code**. The `Ledger` and `SqlEventStore`
APIs cannot express an edit — but that protects the ledger only from *our* code, not from a
psql session, a support engineer, a compromised service account or a future ORM. Hard
rule #2 and M34-FR-01 require that the attempt **fails**, not that our code declines to try.

Fixed by **migration `0004_append_only_guards.sql`** (additive, reversible). After it:

```
$ UPDATE event_ledger SET type='Tampered' WHERE seq=3;
ERROR:  Table "event_ledger" is append-only: UPDATE is refused.
        A correction is a new compensating entry, never an edit (hard rule #2 / M34-FR-01).

$ DELETE FROM event_ledger WHERE seq=3;
ERROR:  Table "event_ledger" is append-only: DELETE is refused. …

$ UPDATE config_versions SET value='"23:00"';
ERROR:  Table "config_versions" is append-only: UPDATE is refused. …
```

`sync_outbox` is deliberately **not** guarded — it is mutable by design (retry counts and
dead-letter state change as an item is worked, §31). Verified: it carries no such trigger.

> This does not claim tampering is impossible — a superuser can drop a trigger. It turns
> *"anyone with a database connection can quietly rewrite history"* into *"you must
> deliberately and visibly disable a named guard first."* The hash chain in `packages/audit`
> remains the detector of last resort.

## 3. Representative data seeded

201 events carrying real money — 200 sales plus one earlier event — and one config version:

```
 sales | total_minor
   201 |     2773200      (₹27,732.00)
```

## 4. Backup taken, with proof of what is inside it

```
$ node scripts/backup.mjs --out /var/lib/postgresql/sre-test/backups
  taking   bk-2026-08-04T01-51-07-460Z.dump
  manifest bk-2026-08-04T01-51-07-460Z.manifest.json
  sha256   0d462ea3ffdbd8349bcaa718dd115b44ec2a8b3ba1c067e0306bb95e3ad1f180
  rows     {"config_versions":1,"event_ledger":201,"schema_migrations":4,"sync_outbox":0}
```

## 5. The database was destroyed

Not simulated. Dropped:

```
$ psql -c "DROP DATABASE sre_core;"
DROP DATABASE
$ psql -c "SELECT datname FROM pg_database WHERE datname='sre_core';"
(no rows)
```

## 6. Restored, and reconciled exactly

```
$ node scripts/restore.mjs --manifest bk-….manifest.json --target postgres://…/sre_core
  checksum verified (19166 bytes)
  restoring into the target database

✅  Restore reconciles exactly against the manifest.
   tables 4
   rows   {"config_versions":1,"event_ledger":201,"schema_migrations":4,"sync_outbox":0}
   money  {"SaleCommitted":2773200}
```

**201 rows and ₹27,732.00 recovered exactly** — not "approximately", not "the tables are
there". Same rows, same money, to the paisa.

## 7. The guarantees survived the restore

```
$ UPDATE event_ledger SET type='Tampered' WHERE seq=3;
ERROR:  Table "event_ledger" is append-only: UPDATE is refused. …
$ DELETE FROM event_ledger WHERE seq=3;
ERROR:  Table "event_ledger" is append-only: DELETE is refused. …
$ UPDATE config_versions SET value='"23:00"';
ERROR:  Table "config_versions" is append-only: UPDATE is refused. …
sync_outbox: mutable-ok  (correctly unguarded)
count | sum      →  201 | 2773200
```

A recovered system with its controls missing is not a recovered system.

## 8. Negative proofs — the restore refuses what it should

**A corrupted artefact:**

```
$ printf 'corruption' >> copy.dump && node scripts/restore.mjs --manifest copy.json …
REFUSED: the artefact no longer matches its recorded checksum.
  expected 0d462ea3…f180
  actual   301899e7…1402
It is truncated, corrupted or was altered. Do not rely on this backup.
```

**A non-empty target:**

```
$ node scripts/restore.mjs --manifest bk-….manifest.json --target <live database>
  checksum verified (19166 bytes)
REFUSED: the target already has 4 table(s).
Restoring over live data is destructive. Re-run with --force if that is intended.
```

---

## Outstanding for the production environment (not this gate)

The gate is *reproducible deploy and restore proof*, which is met. Two M35-FR-01 clauses
depend on hosting, which the owner has deferred (**OB-02 / EX-01**), and are therefore
carried openly rather than marked done:

| Clause | State |
| --- | --- |
| Backups **encrypted at rest** | Supported (`BACKUP_ENCRYPTED`), and the verifier **refuses** an unencrypted backup when policy requires it. The local proof ran unencrypted and the manifest says so rather than pretending. |
| **Immutable off-site copy** | Supported (`BACKUP_OFFSITE`), and the verifier refuses a backup without one under that policy. Needs a storage vendor (EX-01). |
| **Owner-witnessed restore** (M35-FR-01 acceptance) | This proof is reproducible on demand: `docs/runbooks/backup-and-recovery.md` Part 4. To be witnessed at the pilot. |

Automated equivalents of every check above run in CI as
`tests/unit/ops-backup.test.ts` (15 tests), so the logic cannot regress between rehearsals.
