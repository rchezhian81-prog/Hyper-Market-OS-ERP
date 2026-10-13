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
   The machine user must NOT be a person: head office refuses `backup_job` for anyone given a
   sign-in under People (even one holding no role), and refuses a backup report that comes from an
   interactive sign-in (password + one-time code) — only the machine token from step 2 is believed.
   A live emergency grant of any other role to the machine user also stops its reports being believed.
2. Issue that user a token the same way the store computer's token is issued:
   `node scripts/issue-store-token.mjs --user svc-backup --tenant <shop id> --no-store` (the backup
   job is not a store computer, so its token names no store; 30 days unless
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

### Part 3b — The store computer's data, and its bill-number witness (OB-87 · verifier r19)

The store computer (store edge) keeps two folders, and they are backed up **differently**:

| Folder | Installed till (`scripts/install-till.mjs`) | Container (`infra/compose`) | Back it up? |
|---|---|---|---|
| Data — every sale, refund and queue | `till/edge-data/` (`EDGE_DATA_DIR`) | volume `edge-data` → `/var/lib/sre-edge` | **Yes** |
| Bill-number witness | `till/edge-witness/` (`EDGE_WITNESS_DIR`) | volume `edge-witness` → `/var/lib/sre-edge-witness` | **Never** |

Every bill number the store computer gives is written in both. If the data is ever restored
from an older backup, the witness still holds the numbers given after that backup, so the store
computer sees the restore by itself and numbers under a brand-new `ZZ…` prefix until head office
answers — no customer's bill number is ever given twice. **Never back up the witness with the
data, never restore over it, and never point two store computers at one witness folder.**

- **Container:** back up the `edge-data` volume only (for example
  `docker run --rm -v sre-pilot_edge-data:/d:ro -v "$PWD":/out alpine tar czf /out/edge-data.tgz -C /d .`).
  Never `docker compose down -v` on a store box: that deletes both volumes.
- **The store computer checks its witness at every start** and says what it found. If its window or
  log shows `!!! BILL-NUMBER WITNESS UNAVAILABLE`, the witness folder is missing, not writable, or
  inside the data folder: the till still sells and never repeats a number, but every restart takes a
  new `ZZ…` prefix until it is fixed. Head office's health page shows the same on
  `box_bill_numbers:<store>` ("CANNOT keep its bill-number witness").
- **If it says the witness folder "also holds the witness of N other store computer(s)"**, two store
  computers share one witness folder — give each its own (`EDGE_WITNESS_DIR`).

**After a store computer is restored from a backup, check head office's health page an hour
later.** Bills the store computer gave after that backup and never sent are lost from head office's
books. The store computer reports them as numbers it cannot vouch for; 30 minutes after it reports,
if head office still has not received them, `box_bill_numbers:<store>` names them — **"bills issued
but never received: S2L6-000002 to S2L6-000003"**. Find those paper bills and enter them, or write
them off with the reason. (A store computer that reports a bill count far beyond what head office
holds — more than 10,000 numbers ahead — is not believed: the till keeps selling and the health page
names the report for a person to check.)

**Three other bill-number lines, and what to do with each (verifier r21):**

- **"needs a person (the store computer gave up sending; do NOT re-enter from paper)"** — the store
  computer tried to send those bills, gave up after its retries, and still HOLDS them (its "gave up
  sending" list, also shown on `box_queue:<store>`). They are not lost. **Do not enter the paper
  bills**: call support, who find out why head office did not take them and release them from the
  store computer, which then sends them. Entering them from paper as well books the sale twice.
  Head office never calls these bills "never received".
- **"bills waiting on the store computer for N hours"** — the store computer says it still has
  those bills to send, and they have waited longer than the owner's line (store setup, "Warn when
  bills have waited on a store computer, unsent, for more than (hours)", 2 hours by default). Check
  the store computer's connection and its "waiting to send" count. If the count is not going down,
  call support. Do not re-enter the bills from paper until support has checked the store computer.
- **"the store computer's report contradicts itself"** — its list of bills still to send adds up to
  more than its whole queue holds. Head office does not believe that list (a faulty or altered
  store computer could otherwise hide lost bills for ever): bills it has not received are named
  "never received" after 30 minutes as usual. Call support to check that store computer.

**A refused report stays on the health page until one of two things happens** (the rule, OB-88): head
office has itself banked bills up to the refused count (the store computer was right after all), or
**the owner or head office staff** — a person whose authority covers ALL stores — acknowledges that
exact count with a reason (`POST /v1/store-computers/bill-number-refusals/acknowledgements` with the
store, prefix, the refused count and the reason). A store's own manager is refused
(`acknowledgement_needs_all_stores_authority`, kept on the audit trail). **The IT / platform
administrator is refused too, whatever stores the account covers** (OB-91, owner, 13 Oct 2026:
`acknowledgement_refused_to_platform_administrator`, kept on the audit trail) — the person who looks
after the store computers never clears a warning about what a store computer did; a head-office
business person given all stores (or the owner) does it. Each acknowledgement is kept
on its own — who, why and when — and acknowledging again is allowed and kept too. The acknowledgement
holds while the store computer keeps reporting that same count on every pass; once it reports a
DIFFERENT count, that count (and the old one, if it comes back) needs a new acknowledgement. A later,
lower report never clears a refusal and never hides a higher one — the health page shows the highest
count still open and names the others.

**Two more lines (verifier r22, OB-89):**

- **"bills may be waiting on the store computer for N hours … it does not say which bills"** — an
  older (or altered) store computer that only says "my queue holds something". Head office believes
  that for the owner's line (2 hours by default) and no longer: past it, any bill head office has not
  received under that prefix is named "never received" 30 minutes later, saying it may still be on
  the store computer. Do NOT re-enter those bills from paper; call support to check the store computer.
- **"never received … the store computer says it still holds 2 bill(s) somewhere between …"** — the
  store computer claims a few bills spread over a wide range of numbers. Such a claim can account for
  at most its own count plus a margin for voided bills — 5 numbers or 5%, whichever is more, by default (OB-90: Store setup, "extra bill numbers" 0–100 and "percentage" 0–50; 0 and 0 is strictest); head office names every number it lacks in that range
  when there are more. Some may be on the store computer: check it before entering anything from paper.

**Two more (verifier r23, OB-89):**

- **"… the store computer said at <time> that it no longer held … and its latest report says they are
  … again"** and **"store S's computer contradicts its own earlier report"** — the store computer said
  some bills were no longer on it (its queue empty, or its list not reaching them), head office never
  received them, and later the store computer claims them again. A store computer keeps a bill until
  head office takes it and never takes back one it has let go, so head office no longer waits on that
  later word: 30 minutes after the "no longer held" report the bills are named "never received". The
  warning says "the store computer or head office lost track of these bills" and blames neither
  (owner decision OB-92): usually the store computer is faulty or altered (sending "nothing waiting"
  just before each "still waiting" was a way to hide lost bills), rarely head office lost a sale it
  had accepted. Call support to check both; do NOT re-enter the bills from paper until a
  person has looked at its "waiting to send" and "gave up sending" lists.
- **"bills waiting on the store computer for N hours … head office first saw … said to be waiting at
  <time>"** — the hours count from the first time head office saw any of those bills waiting, in any
  report. A "nothing waiting" report in between does not restart the clock.

**Round 25 (owner decisions OB-93 to OB-96, 13 Oct 2026):**

- **No false "lost track" alarm (OB-93).** A store computer's report that does not add up (its list of
  bills waiting is longer than its own queue) is never read as the store computer letting those bills
  go. The store computer itself now counts its queue and lists its bills in one step, so an honest one
  never sends such a report. If you still see "the store computer's report contradicts itself", the
  store computer is faulty or out of date — call support.
- **One store computer per till's bill numbers (OB-94).** The first store computer (its own sign-in)
  that reports a till's bill-number prefix owns it. If a second store computer — a stand-by box, or a
  box set up by mistake with the same till — reports that prefix, the health page says
  **"refused — a second store computer: … belongs to the store computer …"**, names both, and head office
  ignores the second one's word (it can neither hide a lost bill nor make a waiting one look lost).
  - Switch the stand-by box off, or give it its own till; then the owner or head-office staff
    acknowledge the line with a reason (the same acknowledgement as for any refused report; the IT
    administrator cannot). Head office banking the bills does not clear it.
  - **A store computer restored from its own backup keeps its own sign-in, so it is never refused.**
  - **Replacing a store computer with a NEW sign-in:** either issue the till a new bill-number prefix
    first (`POST /v1/stores/<store>/tills/<till>/receipt-prefix`), or — since round 26 — do the
    owner-approved **"store computer replaced"** act below, which moves the till's prefix to the new
    store computer. Until one of these is done the new box's reports of the old prefix are refused and shown.
- **Numbers taken and never used (OB-94).** When a sale cannot be saved after its bill number was
  taken, the till takes a new number for the next try. The store computer now tells head office which
  numbers it took and never used, and head office never names them "never received" — nobody goes
  looking for a paper bill that never existed. An older store computer that does not say this behaves
  as before: such a number can be named during an outage; check the till's "issued, not used" list
  (the lane's receipt-number account) before entering anything from paper.
- **"not checked: … cannot vouch for N bill number(s) … older one(s) … were NOT checked" (OB-96).**
  Head office checks at most the newest 500 numbers a store computer cannot vouch for on each report,
  so that no store computer — honest or altered — can slow head office down. Any older ones are named
  here instead of being skipped in silence. Ask support to compare that store computer's restore
  record with head office's bills; any head office does not hold may be a sale lost by the restore.
- **Separation of duties (OB-95).** Head office refuses to give one person both the IT/platform
  administrator role and any business role (owner, manager, cashier …), in either order, also in an
  emergency grant, a joiner/mover change and the first-time set-up of a shop. Anyone who already holds
  both is named on the health page (**"separation of duties (owner decision OB-95): … holds the
  IT/platform role … AND business role(s) …"**) until one side is removed.

**Round 26 (owner decisions OB-97 and OB-98, 13 Oct 2026):**

- **"Store computer replaced" (OB-97).** When a store computer dies and its replacement is given its
  OWN sign-in (a store computer role for that one store, approved by the owner as usual), head office
  moves the till's bill-number prefix to the new store computer in three steps, by two people:
  1. **Head office business staff** (a person whose business role covers ALL stores — never one store's
     manager, never the IT/platform administrator) look up the current owner of the prefix
     (`GET /v1/store-computers/prefix-bindings`) and ask the owner's approval on the approvals screen
     (`POST /v1/approvals/requests`, kind **`store_computer_replaced`**, subject `<store>/<prefix>`,
     details exactly `{ storeId, prefix, fromComputer, toComputer, reason }`).
  2. **The owner** approves it on his own approvals screen, in his own session (he cannot approve a
     request he made himself — `self_approval`).
  3. The same head office person sends the act: `POST /v1/store-computers/replacements` with the same
     details and the `approvalId`. One approval moves one prefix once.
  From that moment the new store computer's reports are used for that prefix, the old one's are refused
  by name (**"refused — a second store computer: <old> … belongs to the store computer <new>"**), and
  the "bills issued but never received" check resumes on the new store computer. The new computer's
  refused reports from before the act are answered by it. Head office refuses, by name and on the audit
  trail: a sign-in that is not a store computer of that store (`not_a_store_computer_of_this_store`),
  a prefix head office never issued to that store (`prefix_not_issued_to_this_store`), a prefix no store
  computer has reported yet (`prefix_not_bound_yet` — nothing to move), a prefix no longer bound to the
  named old computer (`prefix_bound_to_another_computer`), no approval (`owner_approval_needed`), an
  approval for anything else (`approval_does_not_match`), one store's manager
  (`replacement_needs_all_stores_authority`). Every act is kept (append-only) with who asked, who
  approved, when and why. **Afterwards, revoke the old store computer's sign-in.**
- **Acknowledging "not checked" (OB-98).** After support has compared the restore record, the owner or
  head office business staff (all stores, never IT) may acknowledge the **"not checked: …"** line with a
  reason: `POST /v1/store-computers/at-risk-not-checked/acknowledgements` with `{ storeId, prefix, count,
  reason }` (the count exactly as the line shows it — a stale count is refused, `not_checked_set_changed`).
  Each acknowledgement is kept (who, why, when). It holds while the store computer keeps reporting the
  same set of not-checked numbers; if the set changes — even back to an earlier one — the line returns and
  needs a new acknowledgement. One store's manager and the IT administrator are refused by name.

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
