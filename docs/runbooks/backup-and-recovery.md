# Backup and recovery runbook

**M35-FR-01/02 · QG-08.** Written to be followed at 9pm by someone who is not a
programmer. If any step here does not work exactly as written, that is a defect in this
runbook — report it, do not improvise.

> **The rule this whole document exists for:** a backup nobody has restored is not a
> backup. It is a file, and a belief. Every step below is about turning the belief into
> evidence.

---

## Part 1 — What "recovered" means

A restore is **not** finished when the command says it worked. It is finished when the
restored database contains **exactly** the same number of rows and exactly the same total
money as the backup did. A restore that loses 300 sales also reports success.

So every backup carries a **manifest** — a small file recording what was inside it:

```
rows   {"config_versions":1,"event_ledger":201,"schema_migrations":4,"sync_outbox":0}
money  {"SaleCommitted":2773200}
sha256 0d462ea3ffdbd8349bcaa718dd115b44ec2a8b3ba1c067e0306bb95e3ad1f180
```

and the restore refuses to be called successful unless it reproduces those numbers.

## Part 2 — Recovery targets (roadmap §32)

| Service | Most data we may lose (RPO) | Time to be back (RTO) |
| --- | --- | --- |
| **Store till — committed sales** | **Nothing. Zero.** A sale rung up in the shop is never lost | 30 minutes |
| Cloud (head-office data) | 15 minutes | 4 hours |

The till keeps trading through a cloud failure, so a cloud outage is **not** a shop
outage. Do not stop selling.

---

## Part 3 — Taking a backup

```bash
export DATABASE_URL="postgres://USER@HOST:PORT/DATABASE"
node scripts/backup.mjs --out /path/to/backups
```

It prints the file, the manifest, the checksum and the row counts. Keep the `.dump` and
the `.manifest.json` **together** — one is useless without the other.

The connection details come from the environment, never typed on the command line, so a
password can never end up in shell history.

## Part 4 — Restoring (the one that matters)

**1. Do not restore over live data.** Make an empty database first:

```bash
psql "postgres://USER@HOST:PORT/postgres" -c "CREATE DATABASE sre_restore;"
```

**2. Restore and prove it:**

```bash
node scripts/restore.mjs \
  --manifest /path/to/backups/bk-XXXX.manifest.json \
  --target   "postgres://USER@HOST:PORT/sre_restore"
```

**3. Read the last line.** Only this is a success:

```
✅  Restore reconciles exactly against the manifest.
```

Anything else means **do not use this database**. The script refuses on its own if:

- the backup file no longer matches its checksum — it is corrupted or was altered;
- the target already has tables — restoring over live data needs `--force` and a decision;
- the restored rows or money do not match the manifest — it names exactly what is missing.

## Part 5 — What to do when the shop's system is down

1. **Is the till still selling?** If yes, **let it keep selling.** That is the design. Sales
   are stored on the lane and sync later. Do not stop trading to "be safe" — a refused sale
   is a real loss; a delayed sync is not.
2. **Check the lane display.** It shows `Offline — still selling. N sale(s) waiting to send.`
   Write down N. Those sales exist and are safe.
3. **If a lane cannot record a sale at all** (its display says so explicitly), stop using
   *that lane* and move the queue to another. An unrecorded sale is worse than a refused one.
4. **Then** raise the incident and follow Part 4 on the cloud side. There is no hurry that
   justifies restoring over live data.

## Part 6 — The monthly restore test (do not skip)

Once a month, on a quiet morning, do exactly Part 4 into a scratch database and confirm the
✅ line. Record it in the compliance register as an attestation with the date and your name.
**A control nobody has tested is an assumption, not a control.**

If the test fails, that is not an emergency — it is the system working. It found the problem
on a Tuesday morning instead of on the evening it mattered.

---

## Part 7 — Evidence: this has actually been done

**4 August 2026** — the Stage 5 gate proof was executed against a real PostgreSQL 16.13
instance, not a mock. Recorded in `docs/evidence/stage-5-recovery-proof.md`:

- migrations applied to an empty database, then re-run to prove they are idempotent;
- 201 sale events seeded carrying **₹27,732.00**;
- backup taken with checksum and control totals;
- **the database was dropped** — genuinely destroyed, not simulated;
- restored from the backup: **201 rows and ₹27,732.00 reconciled exactly**;
- the append-only guards survived the restore — `UPDATE` and `DELETE` on the ledger are
  still refused by the database after recovery;
- a deliberately corrupted backup was **refused**;
- a restore onto a non-empty database was **refused**.
