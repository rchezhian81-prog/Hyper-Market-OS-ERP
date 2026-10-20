# Runbook — the real-data copy on the store computer (OB-240, Decision D0 option iii)

**Who this is for:** the store's IT person, with the owner beside them for the decisions. Comfortable following
commands; not necessarily a programmer.
**What it does:** stands up a SECOND, sealed-off copy of the new system on a computer **inside the shop**, for the
store's real data only — its own containers, its own database, its own storage, its own secrets — that trades and
works with **no internet** (P-01) and is **never connected to the hosted demo**.
**How long:** about two hours the first time, most of it waiting for builds.

> **The owner does this himself, on Windows (OB-244, 20 Oct 2026).** There is no IT person: the owner does every
> hands-on step on the shop's Windows 10/11 PC, and no AI is ever given admin access to his computers. His step-by-step
> guide is **`docs/runbooks/store-computer-owner-guide-windows.md`**. It uses one command, `pnpm run store-computer`, which
> does Steps 1, 2, 4, 6 and 7 below for him (`prepare`, `up`, `backup` + `restore-check`, `check` with `fingerprints`,
> `drill`) and checks the computer first (`doctor`). This runbook stays the reference for what each step does and why.

> **Nothing real goes into this copy before the owner's written "Option 2 GO"** (OB-242 — after the cutover tools are
> built and tested). Standing the copy up is allowed before the GO; loading real data is not. Silence is not a yes.

> **This runbook holds no secrets and no addresses.** Every secret is generated on the store computer and written only
> into its own settings file. Never paste one into a chat, an email, a ticket or this document (hard rule #4).

---

## The decisions behind this (in plain words)

- **OB-240 (D0 = iii):** the real-data copy lives on a computer inside the store, offline-first, never on the demo.
- **OB-241 (D3 = B):** the first load is one pilot department's products, barcodes, tax classes and prices.
- **OB-242 (D4):** the written Option 2 GO comes only after the cutover tools are built and tested.
- **OB-243:** the pilot names (the department, the daily reconciler, the incident owner) are still pending — the
  steps below that need a name say so and **stop** until the owner gives it.

The hosted demo (`pilot-demo`, compose project `sre-pilot`) is a different machine and stays synthetic. Pilot gate G4
promises demo data and real data never mix; the demo's isolation is **per machine**, not per tenant, so real data never
goes into the demo's database — not even as a second tenant (STEP-1 plan §5, Decision D0).

---

## What you need

1. **The store computer.** A normal office PC: 8 GB RAM or more, 50 GB free disk, wired network to the tills. It runs
   Linux (or Windows with Docker Desktop). Its clock is right and set to **Asia/Kolkata**.
2. **Docker** with the compose plugin, **Node.js 22** and **pnpm**.
3. **A copy of this repository** on that computer (from the owner's own GitHub account), with `pnpm install` run once.
4. **The owner's own backup drive** — an external USB disk that belongs to the owner and is kept by the named
   custodian. It is the only place backups of this copy go. Not a cloud folder, not the demo server.
5. **A setup workbook page** (paper or the owner's own file) where you write down — never secrets — the tenant id, the
   compose project name, the date of each step, and who did it.

---

## Step 1 — give this copy its own name, settings file and secrets

Everything about this copy is namespaced by **one compose project name**. Use `sre-real` (write it in the workbook).
The project name is what keeps its database, storage volumes and network apart from anything else on the machine
(volumes become `sre-real_db-data`, `sre-real_edge-data`, …).

**The one-command way (Windows or Linux):** `pnpm run store-computer -- prepare` does all of this step, and Step 3's
tenant id: it copies `.env.example` to `.env.real`, fills every row of the table below with fresh secrets made by the
operating system's random source (each distinct, URL-safe, at least 32 characters), writes them straight into the file
and never shows them, and prints only the names it filled and the new tenant id. It refuses to overwrite an existing
`.env.real`, refuses if any value it would write equals a value in an `infra/compose/.env` or `.env.pilot` on the same
computer (compared by fingerprint, in memory; it names only the setting), and seeds nobody. The issuer it writes is
`sre-real-store-computer-<tenant id>` and the audience `sre-real-api` — this copy's own, never the demo's.

By hand instead, from the repository folder:

```bash
cd infra/compose
cp .env.example .env.real          # .env.* files are git-ignored — this file never leaves this computer
```

Open `.env.real` and fill it in **on this computer only**:

| Setting | What to put | Why |
|---|---|---|
| `POSTGRES_DB` | `sre_real` | its own database, by name |
| `POSTGRES_PASSWORD` | generate: `openssl rand -hex 24` | its own secret |
| `DATABASE_URL` | built from the four database values, exactly as the comments in the file say (host `db`) | |
| `PACK_SIGNING_KEY` | generate: `openssl rand -base64 48` | **never the demo's key** — a key shared with the demo would let a demo pack install on a real till |
| `BOX_HISTORY_SEAL_KEY` | generate: `openssl rand -base64 48` (must differ from the pack key) | |
| `IDP_SIGNING_KEY` | generate: `openssl rand -base64 48` | its own sign-in key — a demo token is then worthless here |
| `IDP_ISSUER`, `IDP_AUDIENCE` | a name for THIS copy (for example the shop's name plus `-real`) — not the demo's values | |
| `MIGRATION_TARGET_KIND` | `rehearsal` | the loader and every migration route refuse `production` (hard rule #7) |
| `EDGE_TENANT_ID` | leave the placeholder for now — Step 3 fills it | |
| `CLOUD_API_URL` | `http://api:8081` **or blank** — never the demo's address | the store box syncs to THIS copy's own API, on this computer |
| `CLOUD_API_TOKEN` | blank for now — Step 5 fills it | |
| `SRE_PUBLIC_HOST` | blank (this computer only) | nothing on this copy is published to the internet |
| `SRE_STAFF_ROUTE` | `staff-not-public` (as the file says) | |
| `DEMO_TENANT_IDS` | add the line `DEMO_TENANT_IDS=pilot-demo` | the loaders refuse these tenants by name, as a second lock |

Do **not** use `.env.pilot.example` or the pilot overlay (`docker-compose.pilot.yml`): that overlay is the hosted demo's
shape and adds demo-only pieces (the demo sign-in and the demo store box's relay).

## Step 2 — bring the copy up, offline-first

**The one-command way:** `pnpm run store-computer -- up` runs the three commands below (without curl) and waits for
READY. It first says, in plain words with the one thing to do, if Docker is missing, Docker Desktop is stopped, the
compose part is missing, or a port it needs is already taken; and it refuses if the demo's containers (`sre-pilot`) are
on this computer. The settings file decides, never the terminal: every setting `.env.real` holds, and every `COMPOSE_*`
override, is taken out of the environment it hands to Docker.

By hand:

```bash
cd infra/compose
docker compose -p sre-real -f docker-compose.yml --env-file .env.real up -d db migrate api
docker compose -p sre-real -f docker-compose.yml --env-file .env.real ps
curl -s http://127.0.0.1:8081/readyz
```

You should see the three services up (migrate exits 0 after checking the schema) and `"ready": true`.
Then the stand-up check, pointed at THIS settings file:

```bash
STANDUP_ENV_FILE=infra/compose/.env.real pnpm run standup:check
```

It must say GREEN for the settings (no placeholder left) and the API. It is read-only and needs no token.

**Offline-first:** unplug the internet cable (leave the shop network to the tills) and run `curl` and the stand-up check
again — both must still pass. This copy needs no internet to trade or to be checked; it never reaches out to the demo.

## Step 3 — create the real tenant and its first owner (once)

A tenant id is a UUID, not a name. Generate one with `uuidgen`, write it in the workbook, and put it in `.env.real` as
`EDGE_TENANT_ID=<that uuid>`.

The first owner and the chartered accountant are seeded by the bootstrap command — the same one the real-data load
runbook uses (`docs/runbooks/real-data-load.md`, step 1) — against THIS settings file:

```bash
pnpm run tenant:bootstrap -- --tenant <uuid> --owner <owner-login> \
  --admin <accountant-login>:chartered_accountant --operator <your name> \
  --env-file infra/compose/.env.real --dry-run
```

Read the list it prints; if it is right, run it again **without** `--dry-run`. Expected: `SEEDED — 2 grant(s)`.
It refuses, on purpose: a production box, a tenant id that is not a UUID, the demo tenant, an unknown role, and a tenant
that already has anybody in it.

> The owner's login and the accountant's login are names the **owner** gives. If OB-243 has not named them yet, stop
> here and ask — do not invent a login.

> **Why not `BOOTSTRAP_OWNER_*`?** Those two settings seed one owner at the API's boot, but the base compose file does
> not pass them into the API container (gap G-RD-2 below). The bootstrap command is the supported way on this copy.

## Step 4 — the owner's backup drive

**The one-command way (Windows or Linux; OB-246, closes the backup half of G-RD-6):** no PostgreSQL tools on the
computer, no database address typed anywhere.

- `pnpm run store-computer -- backup --to <the drive's folder>` runs `pg_dump` **inside** this copy's db container
  (`docker compose -p sre-real … exec -T db`) and streams it straight onto the drive. One psql session opens a
  REPEATABLE READ snapshot, counts every table and the money in it, and runs `pg_dump --snapshot` of that same moment, so
  the manifest and the file can never disagree (GT-07). It writes `sre-real-backup-<time>.dump` and its
  `.manifest.json` (size, SHA-256, time taken, row counts, money per event type, newest event), makes both read-only,
  refuses a folder on the system drive, on the repository's drive or inside the repository (the check 10 rule), and
  never deletes anything — a failed dump is left with no manifest and is never taken for a backup.
- `pnpm run store-computer -- restore-check --from <the .manifest.json>` checks the file's size and SHA-256 against the
  manifest (a changed file is refused before anything is restored), restores it into a **new** scratch database
  `sre_restore_check_<time>` in the same container — never into `sre_real` — reconciles every table's rows, the money
  and the newest event against the manifest, writes a read-only `restore-check-<time>.json` beside the backup, and only
  then drops that scratch database and nothing else. It prints `restored_and_reconciled` or each exact difference.
- Check 10 takes the backup's manifest as `--backup-record`: it passes when a restore-check record beside it, for that
  very backup, says `restored_and_reconciled`, judged by where the files really are.

By hand on a Linux computer instead:

1. Plug in the owner's backup drive. Note where it mounts (for example `/media/<drive>`); write it in the workbook.
2. Take the first backup **of this copy only** onto it, and prove it restores:
   ```bash
   DATABASE_URL=<this copy's admin URL, typed in this terminal only> RESTORE_TARGET_URL=<an EMPTY scratch database> \
     node scripts/recovery-rehearsal.mjs --work ~/sre-real-backups --offsite /media/<drive>/sre-real
   ```
   Expected: `outcome  restored_and_reconciled`. The copy on the drive is made read-only; nothing is deleted.
3. Unplug the drive and hand it to the custodian. It is plugged in for each backup and each drill, then put away.

`DATABASE_URL` and `RESTORE_TARGET_URL` go in the environment of that one terminal — never on the command line of a
script you save, never in a file you share.

## Step 5 — the store box and the till, pointed at THIS copy

Follow `docs/runbooks/in-store-install.md` with two differences:

- use `EDGE_TENANT_ID` from Step 3 — the installer reads it and the pack key from `.env.real` when you point it there:
  `pnpm run till:install -- --lane <lane> --settings infra/compose/.env.real`;
- issue the store box's sync token from THIS copy's settings:
  `pnpm run token:store -- --tenant <uuid> --user store-edge --ttl-hours 720 --settings infra/compose/.env.real`, and put
  `CLOUD_API_URL` / `CLOUD_API_TOKEN` for THIS copy into `till/till.env`.
- Both refuse, saying so, when the file named with `--settings` cannot be read — they never fall back to another
  settings file (gap G-RD-3, closed). Never copy `.env.real` to `.env` to save typing.

The till then trades offline and drains to this copy's own API on this computer.

## Step 6 — prove the isolation (pilot gate G4)

Run each check and write the answer in the workbook. **Every one must pass before any real data is loaded.**

**The one-command way (closes gap G-RD-1):** `pnpm run store-computer -- check --by "<name>"` runs all ten itself and
prints a PASS / FAIL / NEEDS-YOU table with no secret in it, then writes a dated record (the results, the tenant id, the
project, Windows or Linux, the date and time and the name) to `infra/compose/records/` (git-ignored), or to `--out
<folder>`. The overall answer is `G4 PASSED` only if all ten pass. What it cannot do itself it says so, never as a pass:

- **check 3** compares this copy's secrets with any other settings file on this computer, in memory; and, with
  `--demo-fingerprints <file>` (OB-245, closes G-RD-8), with the demo's **fingerprints**: `store-computer fingerprints`,
  run on the demo box (`sudo -u deploy node scripts/store-computer.mjs fingerprints --out /opt/sre/fingerprints`, from
  `/opt/sre/app`; it reads `infra/compose/.env.pilot` there by default) and copied to the store computer, holds for each
  generated secret (`POSTGRES_PASSWORD`, `DATABASE_URL`, `PACK_SIGNING_KEY`, `BOX_HISTORY_SEAL_KEY`, `IDP_SIGNING_KEY`)
  the first 12 hex characters of SHA-256 over a fixed label and the value — never the value. Check 3 passes only when
  every one of this copy's fingerprints differs from every one of the demo's; a match fails and names the setting; a
  malformed, empty or cut-short file is refused, never a pass. Without the file it still says NEEDS-YOU. Why that
  reveals nothing usable: each value is 32 or more random characters (192 bits or more), SHA-256 cannot be reversed, and
  48 bits of it are shared by about 2^144 other values — a fingerprint cannot point at the secret; a value under 32
  characters is never fingerprinted (the file says "too short"); a chance match between two random secrets (about 1 in
  2^48 per pair) fails the check, never passes it;
- **check 5** cannot unplug a cable: it says NEEDS-YOU until the check is run again with `--offline-confirmed` after the
  internet is unplugged, when it re-asks `readyz`;
- **check 10** cannot know which drive is the owner's: it reads the Step 4 record given with `--backup-record <file>`
  (restored and reconciled, and the copy on a drive that is not this computer's own);
- **checks 7 and 8** run the real `migration:slice` refusal paths (`--stage --offline`) on an empty temporary folder
  holding only a `slice.json`; check 8 uses a temporary copy of the settings (its secrets left out, set to production)
  that is deleted straight afterwards.

| # | Check | How | Must show |
|---|---|---|---|
| 1 | Own project, own storage | `docker volume ls --format '{{.Name}}' \| grep '^sre-real_'` | this copy's volumes, and **no** `sre-pilot_` volume on this computer |
| 2 | Own database | `docker compose -p sre-real -f docker-compose.yml --env-file .env.real exec db psql -U "$POSTGRES_USER" -l` (type the user in the terminal) | `sre_real`, and no demo database |
| 3 | Own secrets | `store-computer fingerprints` on the demo box, copied here, then `check --demo-fingerprints <that file>` | every fingerprint different |
| 4 | Never connected to the demo | `grep -E '^(CLOUD_API_URL\|IDP_ISSUER\|SRE_PUBLIC_HOST)=' infra/compose/.env.real till/till.env` | only this computer's own values or blank — never the demo's address or issuer |
| 5 | The demo cannot reach in | with the internet cable unplugged, Steps 2's `curl` and the till still work | works with no internet |
| 6 | Never production | `grep '^MIGRATION_TARGET_KIND=' infra/compose/.env.real` | `rehearsal` |
| 7 | The demo tenant is refused | `pnpm run migration:slice -- --dir <an empty folder with a slice.json naming tenant pilot-demo> --stage --offline --settings infra/compose/.env.real` | `REFUSED (demo_tenant)` |
| 8 | Production is refused | the same with `MIGRATION_TARGET_KIND=production` set temporarily in a COPY of the settings file | `REFUSED (production_target)` — then delete that copy |
| 9 | The real tenant is a UUID and is nobody's demo | `grep '^EDGE_TENANT_ID=' infra/compose/.env.real` | a UUID, not `pilot-demo`, not in `DEMO_TENANT_IDS` |
| 10 | Backups go to the owner's drive only | the Step 4 record names the drive's folder | the owner's drive |

Checks 7 and 8 read no real data: the folder holds only a `slice.json` and no CSV files, and both refuse before a row
is read.

## Step 7 — the rollback drill (pilot gate G9)

Before the first real load, run the timed rollback drill on this copy and keep the record it writes.

**On the owner's Windows PC (OB-246, closes the drill half of G-RD-6):** `pnpm run store-computer -- drill --by
"<name>" --to <the drive's folder> --previous <the previous release's folder> [--run]`. Without `--run` it is a dry run
that changes nothing. With `--run`, each step on a stopwatch: (1) `backup`; (2) `restore-check`; (3) the previous
release back — that folder's `db`, `migrate` and `api`, built and started under project `sre-real` with THIS copy's
`.env.real`, waiting for READY and checking (by compose's own label) that the API answering is the one just started;
(4) this release back the same way (always attempted once step 3 ran). How releases are told apart: the ZIP has no git,
so a release is its extracted folder (for example `C:\SRE-previous`, downloaded from that commit's "Browse files →
Download ZIP"), fingerprinted by what the API image is built from. **The database is not rolled back:** no migration
has a down step, and they only add. So before anything changes the drill proves the previous release's
`db/migrations` are an exact prefix of this release's (same names, same contents) and all applied, and after step 3 it
checks the previous release's `migrate` added nothing — "the previous release's services run against the current
schema", as `docs/runbooks/rollback-drill.md` says. Targets (roadmap §32): steps 1 + 2 within 4 hours, steps 3 and 4
within 30 minutes each; over a target is not a pass. Each run writes a new dated `g9-drill-<time>.json` to
`infra/compose/records/` and a read-only copy onto the drive. `G9 PASSED` only when all four steps worked inside their
targets.

On a Linux box with a git checkout instead: `docs/runbooks/rollback-drill.md` with `--project sre-real` and the owner's
backup drive.

## Then — the first department (only after the written GO)

`docs/runbooks/real-data-load.md`, section **"One department first (OB-241)"**: four template files, staged row by row,
a named person accepts the exception list, then the operator applies it.

---

## Known gaps (listed, not invented around)

| Id | Gap | Effect today | What would close it |
|---|---|---|---|
| G-RD-1 | ~~No single command runs the ten isolation checks of Step 6; they are manual.~~ **Closed 20 Oct 2026:** `pnpm run store-computer -- check --by "<name>"` runs all ten and writes a dated record (Step 6). | — | Closed. Checks 3, 5 and 10 say NEEDS-YOU where only a person can answer (see G-RD-8). |
| G-RD-2 | `BOOTSTRAP_OWNER_TENANT_ID` / `BOOTSTRAP_OWNER_USER_ID` are read by the API but not passed into the API container by `infra/compose/docker-compose.yml`. | Setting them in `.env.real` does nothing; Step 3 uses `pnpm run tenant:bootstrap` instead. `store-computer` refuses a `.env.real` that names them (seeding waits for the OB-243 names). | **Not done on 20 Oct 2026, on purpose:** the same base compose file runs the hosted demo, which deploys itself on every merge, and the demo's stand-up runbook tells its operator to set `BOOTSTRAP_OWNER_*` — passing them through would change what the demo's API does at its next boot, which cannot be checked from here. Needs the owner's call (keep `tenant:bootstrap` only, or a pass-through in a real-copy-only overlay file). |
| G-RD-3 | ~~The till installer and `token:store` read `infra/compose/.env` by default.~~ **Closed 20 Oct 2026:** both take `--settings infra/compose/.env.real` (Step 5), and refuse — saying so — when the named file cannot be read. | — | Closed. |
| G-RD-4 | The sign-in on this copy is the pilot's stand-in identity provider (KL-01 / OA-4): whoever holds this computer's `IDP_SIGNING_KEY` can act as any login. | The load record and every signature are only as strong as the custody of this computer and its settings file. | The production identity provider (OA-4), a later decision. |
| G-RD-5 | Node 22 treats `--env-file` as its own option even after the script name. With a file that exists, `tenant:bootstrap` and `migration:load` still work (Node also loads the file into the process); with a mistyped path Node stops with "not found" before the command can explain. | Check the path before running. The new commands (`migration:slice`, the rollback drill, `store-computer`) use `--settings` instead. | Rename the flag on `migration:load` and `tenant:bootstrap` (a small change, with tests). |
| G-RD-6 | ~~On the owner's Windows PC the backup needed PostgreSQL's tools and the addresses read into PowerShell by hand, and the drill's `--run` needed bash and a git checkout.~~ **Closed in the build 20 Oct 2026 (OB-246):** `store-computer backup`, `restore-check` and `drill` (Steps 4 and 7) run with Docker Desktop, Node and pnpm only. | The previous release is a kept ZIP folder, and the database is not rolled back (migrations only add; the drill proves the previous release's are an exact prefix and adds nothing). | **Not yet run on real Windows or real Docker** — proved with a pretend Docker and on real PostgreSQL 16 with the container step stood in for. G9 still needs a PASSED drill on the store computer itself. |
| G-RD-7 | ~~The package scripts `migration:slice`, `migration:load`, `tenant:bootstrap`, `realm:for-shop`, `shop:*` and `demo:smoke` ended their build step with `>/dev/null`, which Windows' command shell cannot run.~~ **Closed in the build 20 Oct 2026:** they use `node scripts/build-service.mjs tools --quiet && …` — only `&&`, which cmd.exe, PowerShell 7 and sh all run. | — | Closed (tests/guardrails/the-package-tool-scripts-run-on-windows.test.ts). Not yet run on real Windows. |
| G-RD-8 | ~~Check 3 could compare only with demo settings files on this computer, so it stayed NEEDS-YOU on the store computer.~~ **Closed in the build 20 Oct 2026 (OB-245, "Compare fingerprints"):** `store-computer fingerprints` on both computers and `check --demo-fingerprints <file>` (Step 6). | Needs the owner's SSH sign-in to the demo box once per check (guide Part 9), and the demo box on a release that has the command. | Closed. Not yet run on the real demo box or the real store computer. |
