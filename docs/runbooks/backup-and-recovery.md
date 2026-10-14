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
  **"two store computers report bill numbers under <prefix> for store <store>: <A> and <B>. Head office
  uses <A>'s reports … because …"** (round 27 wording, OB-101: both named, neither blamed), and head office
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
  by name (**"two store computers report … : <new> and <old>. Head office uses <new>'s reports … because the
  owner approved moving <prefix> to it …"**), and
  the "bills issued but never received" check resumes on the new store computer. The new computer's
  refused reports from before the act are answered by it. Head office refuses, by name and on the audit
  trail: a sign-in that is not a store computer of that store (`not_a_store_computer_of_this_store`),
  a prefix head office never issued to that store (`prefix_not_issued_to_this_store`), a prefix no store
  computer has reported yet (`prefix_not_bound_yet` — nothing to move), a prefix no longer bound to the
  named old computer (`prefix_bound_to_another_computer`), no approval (`owner_approval_needed`), an
  approval for anything else (`approval_does_not_match`), one store's manager
  (`replacement_needs_all_stores_authority`). Every act is kept (append-only) with who asked, who
  approved, when and why. **Afterwards, revoke the old store computer's sign-in.**
  **On screen (OB-99):** the head office web ERP's **Store computers** page (Administration) does all of this:
  tap the till's row on "Bill numbers", fill in the new store computer and why, "Ask the owner's approval"; the
  owner approves on his Approvals page; then "Move the bill numbers now" on the "Replacements" tab. The "Needs a
  person" tab has "Acknowledge with this reason" for refused reports and the not-checked line. One store's manager
  and the IT administrator see the page read-only.
- **Acknowledging "not checked" (OB-98).** After support has compared the restore record, the owner or
  head office business staff (all stores, never IT) may acknowledge the **"not checked: …"** line with a
  reason: `POST /v1/store-computers/at-risk-not-checked/acknowledgements` with `{ storeId, prefix, count,
  reason }` (the count exactly as the line shows it — a stale count is refused, `not_checked_set_changed`).
  Each acknowledgement is kept (who, why, when). It holds while the store computer keeps reporting the
  same set of not-checked numbers; if the set changes — even back to an earlier one — the line returns and
  needs a new acknowledgement. One store's manager and the IT administrator are refused by name.

**Round 27 (owner decisions OB-100 to OB-102, 13 Oct 2026):**

- **"taken but never used (information — nothing to look for)" (OB-100).** The health page and the Store
  computers page ("Taken but never used") show, per store, till and day, the bill numbers each store
  computer says it took and never put on a bill — a bill abandoned at the till, a card declined after the
  number was taken. Nobody looks for paper bills for these. If one till shows many on one day, ask the
  store why (a till left half-way through many bills, or a store computer that is faulty).
- **"does not fit: … said … that it gave <number> and never put it on a bill, but head office holds a
  sale (or return) under that number, made before that" (OB-100).** Head office has the bill, so nothing
  is missing and nobody looks for paper — but that store computer's list of unused numbers cannot be relied
  on. Call support to check the store computer (its software or its data). The line stays until the owner or
  head office staff acknowledge it with a reason (round 28, OB-103 — below).
- **Two store computers in one store (OB-101).** The refusal line now names both machines, says which one
  head office uses for the till and why (it reported the till's numbers first, or the owner approved moving
  them to it), and that bills sold on the OTHER one are not checked for loss until a person checks both.
  Check both machines: if the other one is now the till's real store computer, do the "store computer
  replaced" act; if it is a stand-by or a copy, switch it off or give its till a new prefix. The store's
  disk, queue, tills and "hours of trading left" are read ONLY from the store computer(s) that hold the
  tills' numbers; a machine that holds none is listed apart ("another store computer … also reports for this
  store but holds none of its tills' bill numbers"). **Corrected in round 29 (verifier r28 NEW-3, OB-107):**
  the round-27 claim that "a second machine's report never hides a full disk" was NOT true when the second
  machine held even ONE till's prefix (say it reported a new till first) — it could then speak for the whole
  store. Since round 29 EACH store computer that holds any of the store's tills is judged on its own and the
  WORSE decides (see Round 29 below).
- **Head office's check no longer re-reads every report (OB-102).** It keeps a saved running result of the
  never-received check (PostgreSQL table `projection_snapshot`, projection `never-received-fold@1`) and reads
  only the store computers' reports from about the last half hour onto it. It is disposable: if anything
  looks wrong, support may delete that one row
  (`DELETE FROM projection_snapshot WHERE projection = 'never-received-fold@1' AND tenant_id = '<tenant>'`);
  the next health read rebuilds it from every report (slower once — up to about 30 s for a week of an
  altered store computer's reports — then fast again). Never delete the reports themselves.

**Round 28 (owner decisions OB-103 and OB-104, 13 Oct 2026):**

- **Acknowledging "said unused, but head office has the bill" (OB-103).** Once support has checked the
  store computer, the owner or a head office person who covers ALL stores opens Store computers → "Needs a
  person", writes why in the box under that line (at least 5 characters) and presses "Acknowledge with this
  reason". Head office keeps who, why, when and exactly which numbers. A store's own manager and the IT
  administrator are refused by name (and the refusal is on the audit trail). The acknowledgement holds while
  head office finds the SAME numbers; if the store computer later calls ANOTHER held bill's number unused,
  the line comes back naming all of them and needs a new acknowledgement. If the page says "the line
  changed since it was read", reload it and acknowledge what it shows now.
- **Head office reads only the recent store-computer reports (OB-104).** Every health read and every alert
  pass now keeps ONE saved running result of everything it works out from the store computers' reports
  (PostgreSQL table `projection_snapshot`, projection `box-health-history@1`) and reads only the reports
  after it — usually a few minutes' worth, under a second even after a month of an altered store computer.
  The answers are the same as reading every report (proved by test). It is set aside and rebuilt from every
  report by itself when something it was made from changed (a setting, a report that arrived late, an
  acknowledgement or act dated before it). It is disposable: if anything looks wrong, support may delete
  that one row
  (`DELETE FROM projection_snapshot WHERE projection = 'box-health-history@1' AND tenant_id = '<tenant>'`);
  the next health read rebuilds it from every report — slower ONCE (about 30 s for a month of an altered
  store computer's reports, every minute), then fast again. The first health read after this version is
  installed is that slow read. Never delete the reports themselves. (`never-received-fold@1` is no longer
  used by the health read; it may be left as it is.)

**Round 29 (owner decisions OB-105 to OB-108, 14 Oct 2026):**

- **The saved store-computer history stays small (OB-105).** It now forgets only what can no longer change
  an answer under its stated rules: a bill number nobody has listed as "waiting to send" for 24 hours (if it
  is listed again, its waiting clock starts again; a stuck bill is listed in every report, so its clock never
  restarts), "taken but never used" numbers not said again for 30 days, a refused count head office has
  since banked, and the disk's growth points older than the 7 days the estimate reads. An honest busy store
  (10 tills, ~1,900 bills a till a day) stays under 2 MB after 30 and after 90 days (it was ~23 MB after a
  month, growing for ever). The health page shows its size as the `box_history` line ("… is N KB"); above
  4 MB the line turns to a warning — call support to find which store computer is making it grow.
- **A damaged or altered saved history is never trusted and never stops the health page (OB-106).** Every
  read checks its shape and its seal (round 30: a KEYED seal, see below) and that every till-to-store-computer
  binding in it can be traced to the report or the owner-approved act it came from. Anything that fails is
  set aside and rebuilt by itself — support no longer has to delete the row (deleting it is still safe).
- **Building it never freezes head office (OB-106).** For a store with more than 5,000 reports the first
  read after an upgrade (or after a set-aside) builds it in the background, a little at a time, once per
  shop. Meanwhile the health page says **"being prepared — store computer checks not yet available"**
  (`box_history: unknown`) and does not judge any store computer (not known, never "all fine"); the
  Store computers page and its buttons answer "being prepared … try again in a few minutes"; the alert
  worker writes "store computer checks are being prepared … skipped them and kept their open alerts" in its
  log and clears none of their alerts. The tills keep selling throughout; readiness (`/ready`) keeps
  answering. If "being prepared" lasts more than an hour, or `box_history_build` says the build failed, call
  support.
- **"saved history has not been saved since … an open database transaction holds it back"
  (`box_history_saving`).** Head office keeps the history in memory and stays correct, but each check gets
  slower. Ask the database administrator to find and end the session "idle in transaction" or the prepared
  transaction (`pg_stat_activity`, `pg_prepared_xacts`).
- **More than one store computer holding a store's tills (OB-107).** The disk and queue lines then say
  "store S has 2 store computers holding its tills' bill numbers — <A> (<prefixes>) and <B> (<prefixes>);
  head office judges each on its own and the worse decides: …". A full disk on EITHER makes the store
  "cannot record sales". Normally a store has one store computer: if two appear, check which is real.
- **"said unused, but head office has the bill" uses the store computer's own clock (OB-108).** The store
  computer now writes on each bill when IT took it from the till (`storeComputerTakenAt`), and head office
  compares that with the store computer's own report times — a till whose clock is slow no longer causes
  this line. A bill from a store computer not yet updated is still judged on the till's clock, and the line
  says so ("the bill's time is the TILL's own clock … check the till's clock first"). The time a number was
  last said unused is now kept to the minute (it was the hour), and the line says when not every number
  could be looked at (beyond the newest 500, or the newest 50 bills).
- **Acknowledging a line now sends exactly the numbers the page showed (verifier r28 NEW-5).** If the line
  has changed since the page was read — even with the same count — head office refuses ("the line changed
  since it was read"); reload and acknowledge what it shows now.

**Round 30 (owner decisions OB-109 to OB-112, 14 Oct 2026):**

- **A bill stuck through a long internet outage keeps its true age (OB-109).** Head office forgets a "waiting
  to send" bill number only after 24 HOURS OF REPORTS that leave it out — hours in which the store computer
  reported and did not list it. Hours with no report at all (internet down, store shut) never count. So after
  an outage of a day or more, a bill that was stuck all along still shows "waiting since <the first time head
  office saw it>", and its alert is not cleared on reconnect. After any outage longer than a day, open the
  Store computers page and compare "bills waiting" with the store computer's own "waiting to send" screen.
- **A stuck bill no longer makes head office slow (OB-110).** The waiting clock keeps, per till, the numbers
  ever listed as at most 128 ranges, each with the first time head office saw it. When it would keep more, the
  two neighbouring ranges seen closest together are joined and keep the EARLIER time — so a bill can look a
  little older than it is (a warning a little early), never younger (never late, never hidden). Measured: one
  till with a bill stuck for 30 days builds in under 1 s and saves 0.62 MB (was 59 s and 2.07 MB); ten tills
  each with a stuck bill for a week build in under 1 s with no pause of the process over 60 ms (was 38 s with
  2.1 s pauses); an honest busy store saves 0.66 MB at 7, 30 and 90 days.
- **The saved history is sealed with a secret key (OB-111; the key's source changed in round 32 — OB-116 below).** Head office seals it with a key it derives, under
  its own label, from **PACK_SIGNING_KEY** (no new secret to set; the key is held in memory only — never in
  the database, the repository or a log). Someone who changes the saved row with the database password cannot
  make a matching seal: the row is set aside and rebuilt from the reports (which cannot be changed). If you
  ever CHANGE PACK_SIGNING_KEY, the saved history is set aside once and rebuilt — slower once, nothing lost.
  The first health read after installing round 30 is such a rebuild (round 29's rows used a plain seal). A
  head office started without the key would say so on the health page (`box_history_seal`, degraded) and trust
  nothing saved; that cannot happen in a real deployment, because the API does not start without
  PACK_SIGNING_KEY.
- **A store computer naming made-up till numbers cannot fill head office's memory (OB-112).** Per store
  computer and per day (UTC — 05:30 to 05:30 in India), head office keeps at most 20 NEW refused words about
  bill-number prefixes that are not that store's (a prefix of another store's till, or one no till was ever
  given — or a new count under one). The rest are counted, never kept, and said in ONE line on the store's bill
  numbers: "N more refused bill-number prefix(es) not kept: store S's computer <name> …", shown for 7 days
  after the last one. The store's own tills' prefixes are not capped by this rule (round 32 caps them per till — OB-117 below). If you see that line, call support
  the same day: that store computer is faulty or has been altered; support may block its sign-in.

**Round 31 (owner decisions OB-113 and OB-114, 14 Oct 2026):**

- **The 20-a-day count above is the STORE's day (OB-113).** It now runs midnight to midnight in the shop's
  own time zone (Store setup, `locale.time_zone`; Asia/Kolkata unless changed) — no longer 05:30 to 05:30 as
  in round 30. If the time zone setting is ever changed, the saved store-computer history is set aside once
  and rebuilt with every day counted in the new zone (slower once, nothing lost). The first health read after
  installing round 31 is also such a rebuild (the saved history's version went up).
- **You are told when the store computer checks stay unavailable (OB-114).** Every shop has a built-in alert
  rule, `built-in:store-computer-checks-stuck`, addressed to whoever holds the **owner** role at the time (it is
  never a name written into the program). When the checks stay **"being prepared"** or head office **cannot seal
  the saved history** (`box_history_seal`) for more than 60 minutes without a break, the health page shows
  `store_computer_checks_stuck` as **down** ("the store computer checks have not been ready for N minutes …
  Call support today") and the alert worker raises it to the owner — in his alert inbox, and as a message to
  his phone once a message provider is set — like any other alert, even while it skips the store computers'
  other checks. Before the hour the same line is shown as ok ("not ready yet … for N minutes so far"). When
  the checks are ready again the alert is marked cleared (kept on the board). It asks to be acknowledged
  within 60 minutes; nobody is above the owner, so it does not escalate to anyone else.
  - **To see it:** `GET /v1/platform/alert-rules` lists `builtIn` with its state: `on`, `edited` (your own
    version is in force), `off`, or `no_owner` (nobody holds the owner role — then it is NOT in force).
  - **To change it** (round 32: the OWNER only — OB-115 below) (another person, another acknowledgement time, someone to escalate to): put a rule with
    alertId `built-in:store-computer-checks-stuck` and component `store_computer_checks_stuck` in your rules
    (`PUT /v1/platform/alert-rules`, the whole set as always). **To turn it off:** send `builtInOff:
    ["built-in:store-computer-checks-stuck"]` with your rules (an empty `rules: []` is allowed then). It stays
    off until a later rules version names the list again; `builtInOff: []` turns it back on. Each change is a
    new rules version recording who made it and when. An alert already open when it is turned off stays open
    until acknowledged (as for any rule removed).
  - **What to do when it arrives:** open Operational health; if `box_history_build` says the build failed, or
    `box_history_seal` is shown, call support the same day. The tills keep selling; nothing is lost.

**Round 32 (owner decisions OB-115 to OB-117, 14 Oct 2026) — these replace parts of rounds 30 and 31 above:**

- **Only the owner may turn off, edit or re-point the built-in alert (OB-115).** A save of the alert rules
  (`PUT /v1/platform/alert-rules`) that would turn `built-in:store-computer-checks-stuck` off or back on, edit it, change
  the owner's edit of it, or remove that edit is REFUSED unless the person saving holds the **owner** role:
  - the IT/platform administrator gets `403 built_in_alert_rule_refused_to_platform_administrator` (as OB-91);
  - anyone else (a store manager, head office staff) gets `403 built_in_alert_rule_owner_only`;
  - each refusal is on the audit trail (who, when, 403) like every request; nothing is changed.
  Others with alert rights may still save the shop's OTHER rules, as long as they send each built-in rule exactly as
  `GET /v1/platform/alert-rules` shows it and leave `builtInOff` out. An edit must keep component
  `store_computer_checks_stuck`, fire at `down` (or `degraded` / `unknown`, never `ok`) and name no branch — otherwise
  `400 built_in_alert_rule_cannot_fire`, even for the owner.
  - **Every change the owner makes is sent to him:** a notice `notice:built-in-alert-rule-changed:v<version>` lands on
    his alert board and in his inbox at once ("a built-in alert rule was changed by … at …: turned … OFF. Now: …"), and
    to his phone on the alert worker's next pass when a message provider is set. He acknowledges it like any alert; it
    is kept. If you get one you did not cause, check `GET /v1/platform/alert-rules` and ask who did.
  - **"Off" carries into later versions, but is never hidden:** a later save that leaves `builtInOff` out keeps it as it
    was (that is not a change). `GET /v1/platform/alert-rules` shows each built-in rule's state with `lastChangedBy` and
    `lastChangedAt` (whoever saved the rules last), and every save's reply lists the built-in rules' states and, when one
    is still off, says so in words (`builtInStillOff`). Only the owner turns it back on (`builtInOff: []`).
- **The saved history's seal now uses head office's OWN secret (OB-116).** Round 30 derived the seal key from
  PACK_SIGNING_KEY — which every store computer also holds, so someone with a store computer's settings file and the
  database password could have forged it. From round 32 the key comes from **`BOX_HISTORY_SEAL_KEY`**, a separate secret
  given to the **API only** (at least 32 characters; never to a store computer, a till or the edge container). The API
  refuses to start without it, with the placeholder, too short, or equal to PACK_SIGNING_KEY (or the personal-data or
  sign-in key), naming the setting and never its value. The saved form moved to `box-history-text@3`, so the first
  health read after installing round 32 sets round 30/31's saved history aside once and rebuilds it ("being prepared"
  for a short while on a big store; nothing lost). Changing `BOX_HISTORY_SEAL_KEY` later does the same. Setting it on a
  box: `docs/runbooks/automatic-deployment.md`, "Settings a release needs".
- **A store computer repeating impossible counts for its OWN tills is capped too (OB-117).** Per store computer, per
  till prefix and per store day (the same day as OB-113), head office keeps at most 20 NEW refused counts (a count too
  far ahead of what head office received, or a second store computer naming a till bound to another). The rest are
  counted, never kept, and said in ONE line per store computer and till: "N more refused bill count(s) under <prefix>
  not kept: store S's computer <name> … the highest of them was <prefix><number>", shown for 7 days after the last one.
  The counts that were kept are still listed as before (the highest one first). A second store computer naming a till's
  prefix uses up only its own 20, never the real store computer's. Measured (the verifier's probe F1: 10 tills, a new
  impossible count every 15 s for 200 minutes): the saved history is 72 KB, of which the flood adds 46 KB (round 31:
  2.82 MB, about 20 MB a day). If you see that line, call support the same day; ask them to block that store computer's
  sign-in if it goes on.

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
