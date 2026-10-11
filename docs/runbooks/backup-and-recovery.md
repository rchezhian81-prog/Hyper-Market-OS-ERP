# Backup and recovery runbook

> **Row-level security (since migration 0012).** The database confines every connection to one tenant's rows
> unless the connection carries the explicit platform scope. `scripts/backup.mjs` and `scripts/restore.mjs`
> set it themselves (`PGOPTIONS='-c app.tenant_id=*'`, and `pg_dump --enable-row-security`). If you ever run
> `pg_dump`, `pg_restore` or `psql` by hand against the live database, set the same `PGOPTIONS` first — or the
> dump is refused / the counts come back as zero, which is the database doing its job, not data loss.

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

**The dump and the manifest are one moment (audit GT-07, 10 Oct 2026).** The backup opens a
read-only snapshot of the database, counts the rows and adds up the money *inside that
snapshot*, and dumps *that same snapshot* (`pg_dump --snapshot`). Sales that are rung while the
backup runs are in **neither** the file nor the manifest — the next backup takes them. The
manifest's `consistency` block says exactly where the line was drawn:

- `snapshotId` and `takenAt` — the moment the backup is of;
- `latestEventSeq` / `latestEventAt` — the newest record inside it (the "latest durable
  boundary": everything up to that record is in the backup, nothing after it).

You can take a backup while the shop is trading. You do not need to stop the tills.

The connection details come from the environment, never typed on the command line, so a
password can never end up in shell history.

### Part 3a — The backup job reports its own outcome (audit PA-12, round 6)

The nightly job (`infra/pilot/backup/encrypted-backup.sh`, run by `sre-pilot-backup.timer`)
tells head office how it went **every night, success and failure** — nobody types the
result in. It reports only what it measured: when it started and ended, the encrypted
file's size and checksum, whether the file really is encrypted, and whether the off-site
copy step confirmed the copy. Head office shows it on the health page and the alert
worker raises a failure to the person named in the alert rules.

If the job says nothing — the box is off, the timer is broken, the job crashed before it
could report — head office raises the backup as **MISSED** by itself once it is overdue
(the alert rules' "backup max age", 24 hours unless the owner set another).

**One-time operator step — give the job its own sign-in (never in the repo, hard rule 4):**

1. Ask the owner to approve granting the role **Backup job (machine)** (`backup_job`) to a
   new machine user, for example `svc-backup`, through the normal two-person role grant.
   This role can only report backups — it cannot read or change anything else.
2. Issue that user a token the same way the store computer's token is issued:
   `node scripts/issue-store-token.mjs --user svc-backup --tenant <shop id>` (30 days unless
   `--ttl-hours` says otherwise). The token is shown once, on your screen only.
3. On the box, create `/etc/sre-pilot/backup-reporter.env`, owned by root, mode `600`:
   ```
   SRE_BACKUP_REPORT_API_URL=https://<head office API address>
   SRE_BACKUP_REPORT_TOKEN=<the token from step 2>
   # optional: a command that copies the file off-site and exits 0 only when the copy is confirmed
   # SRE_BACKUP_OFFSITE_CMD=/usr/local/bin/sre-offsite-copy
   ```
   The service unit reads this file (`EnvironmentFile=`). Never put it in the repository,
   a container image or a log.
4. Run the job once by hand (`systemctl start sre-pilot-backup.service`) and check the
   journal says `reported   bk-… completed`. On the health page the backup line shows the
   new backup.

**What the messages mean:**

- `NOT REPORTED — … not set` — step 3 is missing. The job fails on purpose so you see it.
- `NOT REPORTED — head office answered 401` — the token is wrong or expired; issue a new one.
- `does not count: it has no off-site copy` — no off-site copy step is configured, or it
  failed. Until the owner names the off-site destination this is expected, and the backup
  alert stays raised (that is the truth: there is no off-site copy yet).
- Renew the token before it expires (the API limits how long a token may live); an expired
  token shows up the next night as "NOT REPORTED" and, the night after, as MISSED.

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

The second line it prints names the snapshot and the newest record in the backup. If instead
it prints `WARNING: this backup predates one-snapshot backups`, the file was taken by the old
tool, whose counts could be from a slightly different moment — a small mismatch on such a file
may be that, not lost data. Take a fresh backup with the current tool.

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

### Part 6a — The off-site recovery rehearsal (audit PA-12, 10 Oct 2026)

This is the monthly test done the way the bad day happens: the restore comes **from the off-site
copy**, onto a **spare machine's empty database**, not from the backup sitting next to the live
one. One command does all of it and writes down what happened:

```bash
export DATABASE_URL="postgres://USER@HOST:PORT/DATABASE"            # the live database
export RESTORE_TARGET_URL="postgres://USER@SPARE:PORT/sre_rehearsal" # an EMPTY database on the spare machine
node scripts/recovery-rehearsal.mjs --work /path/to/backups --offsite /mnt/offsite/sre
```

It takes a backup (one snapshot — Part 3), copies the file and its manifest to the off-site
folder, makes the copies **read-only**, re-reads the copy and checks it against the checksum,
restores **from the copy** into the spare database, and reconciles rows and money exactly. It
then writes `rehearsal-<backupId>.json` beside the backup with:

- `outcome` — `restored_and_reconciled` is the only good word; anything else means do not rely
  on that backup;
- `boundary` — the newest record the restored database holds (everything after it is what a
  real recovery would have lost — compare it with the recovery-point target in Part 2);
- `timingsMs` — how long the backup, the off-site copy and the restore took (compare `total`
  with the recovery-time target in Part 2).

If the off-site copy does not match what was taken, it says `refused_offsite_copy_damaged` and
restores nothing. Treat that as a finding about the off-site store.

**What is still yours to decide (owner / external):** where the off-site store is, who holds
its keys (the custodians), and that it is immutable at the storage end (object lock / WORM). The
script makes the local copies read-only; true immutability is a property of the store you
choose. Until that is decided, `--offsite` can be any separate disk, and the rehearsal still
proves the restore works from a copy. Record each rehearsal in the compliance register with
the date, your name and the `outcome` line.

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
