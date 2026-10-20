# Runbook — the timed rollback drill (pilot gate G9)

**Who runs it:** the store's IT person, ON THE BOX, with the owner watching (it is the owner's witnessed drill —
UAT-53 "watch the rollback actually performed, not the plan").
**What it proves:** that the previous release can be put back and the data restored, under a simulated failure — and
how long each part takes, against the roadmap's own targets (§32): the service back within **30 minutes**; the database
restored within **4 hours**.
**How long:** about an hour.
**Where:** the store computer's real-data copy (`docs/runbooks/store-computer-real-data-environment.md`, project
`sre-real`) before the first real load — or the pilot box, for G9 there.
**On the owner's Windows store computer (OB-246):** use `pnpm run store-computer -- drill` instead
(`docs/runbooks/store-computer-owner-guide-windows.md`, Part 11): the same order and the same §32 targets, with no bash,
no git and no PostgreSQL tools on the PC — the previous release is its kept ZIP folder, and its services run against
the current schema (checked compatible first). This page is the Linux box's way, with `infra/deploy/release.sh`. **Never against production, never from a
developer's machine.** The drill refuses `MIGRATION_TARGET_KIND=production` before it touches anything.

---

## What the drill does, in order

1. **Recovery.** Backs up the box's database, copies the backup to the owner's backup drive (made read-only there),
   restores that copy into an **empty, separate** database and reconciles rows and money to the paisa. Nothing is ever
   restored over the live database.
2. **Rollback — the simulated failure.** Puts the **previous** release back with the box's own release script
   (`infra/deploy/release.sh`) and waits until the API says READY.
3. **Roll forward.** Puts the **current** release back the same way and waits for READY again.
4. **Times.** Prints each time against its target and writes a record file (a new file every drill — nothing is
   overwritten or deleted).

It stops at the first step that fails. If the previous release cannot come up, the release script itself leaves the box
on the release that was live. If the box is on the previous release and cannot be put forward again, the drill says a
person is needed on the box now (`docs/runbooks/automatic-deployment.md`, "When it goes red").

## What you need

- The box's repository folder, on the release that is live.
- The two commit ids (40 characters each): the one live now (`git rev-parse HEAD`) and the previous one from the box's
  release log (`/opt/sre/releases.log`, the `previous=` of the latest line). Both must be on `main`.
- The compose project name of this box (`sre-real` on the store computer).
- The owner's backup drive, plugged in, and its folder.
- An **empty** scratch database for the restore (create one on the box's database server; it must hold no tables).
- A quiet hour: the rollback briefly restarts the API. The tills keep selling throughout and queue their sales
  (hard rule #1) — say so to the cashiers, and watch that the queue drains afterwards.

## Step 1 — dry run (changes nothing)

```bash
node scripts/rollback-drill.mjs --previous <previous commit> --current <live commit> --project sre-real \
  --work ~/sre-drills --backup-drive /media/<drive>/sre-real --settings infra/compose/.env.real
```

It prints the four steps it would take. A `REFUSED —` line names exactly one thing to fix (a production box, a commit
that is not 40 characters, the same commit twice, no project, no work folder, no backup drive).

## Step 2 — the drill

In the same terminal, set the two database addresses **in the environment only** (never on a command line you save,
never in a file you share), then run the same command with `--run`:

```bash
export DATABASE_URL=<this box's database administrator URL>
export RESTORE_TARGET_URL=<the EMPTY scratch database URL>
node scripts/rollback-drill.mjs --previous <previous commit> --current <live commit> --project sre-real \
  --work ~/sre-drills --backup-drive /media/<drive>/sre-real --settings infra/compose/.env.real --run
unset DATABASE_URL RESTORE_TARGET_URL
```

## Step 3 — read the result with the owner

The last lines look like this:

```
  times    recovery 18.4 min (target 240 min) · rollback 6.2 min (target 30 min) · roll forward 5.9 min (target 30 min) · total 30.5 min
  outcome  PASSED — the previous release went back on, the backup restored and reconciled, and the current release came back — all inside the targets
  record   ~/sre-drills/rollback-drill-….json
```

| Outcome | Meaning | What to do |
|---|---|---|
| `PASSED` | every step worked, inside every target | Write the date, the times and both commits in the workbook; the owner signs G9 |
| `OVER_TARGET` | every step worked, but one took longer than its target | G9 is **not** passed. Find the slow step (it is named) and run the drill again |
| `FAILED` | a step did not work | Read the named step. Do not load real data until a drill passes |
| `REFUSED` | the drill would not start | Fix the one named thing |

Copy the record file onto the owner's backup drive next to the backup it made. Then check the tills: their queued sales
drain to the books within a few minutes of the API coming back (the store box's sync badge goes green).

## What the drill does NOT prove

- It does not put the **old ERP** back: going back to the old system on the cutover night is the migration screen's
  "Go back to the old system" button and `docs/runbooks/cutover-weekend.md`.
- A release whose database changes cannot run on the previous release's code would fail step 2 — which is the point:
  the drill finds that before a real night does.
- Real-data volume: run it again after the first real load, so the recovery time is measured on the real size.
