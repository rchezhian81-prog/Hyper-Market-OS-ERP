# Runbook — the real-data copy on the store computer (OB-240, Decision D0 option iii)

**Who this is for:** the store's IT person, with the owner beside them for the decisions. Comfortable following
commands; not necessarily a programmer.
**What it does:** stands up a SECOND, sealed-off copy of the new system on a computer **inside the shop**, for the
store's real data only — its own containers, its own database, its own storage, its own secrets — that trades and
works with **no internet** (P-01) and is **never connected to the hosted demo**.
**How long:** about two hours the first time, most of it waiting for builds.

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

From the repository folder:

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

- use `EDGE_TENANT_ID` from Step 3 (the installer reads it and the pack key from `.env.real` when you point it there);
- issue the store box's sync token from THIS copy's settings:
  `pnpm run token:store -- --tenant <uuid> --user store-edge --ttl-hours 720` with `infra/compose/.env.real` as the
  settings file, and put `CLOUD_API_URL` / `CLOUD_API_TOKEN` for THIS copy into `till/till.env`.

The till then trades offline and drains to this copy's own API on this computer.

## Step 6 — prove the isolation (pilot gate G4)

Run each check and write the answer in the workbook. **Every one must pass before any real data is loaded.**

| # | Check | How | Must show |
|---|---|---|---|
| 1 | Own project, own storage | `docker volume ls --format '{{.Name}}' \| grep '^sre-real_'` | this copy's volumes, and **no** `sre-pilot_` volume on this computer |
| 2 | Own database | `docker compose -p sre-real -f docker-compose.yml --env-file .env.real exec db psql -U "$POSTGRES_USER" -l` (type the user in the terminal) | `sre_real`, and no demo database |
| 3 | Own secrets | compare by eye with the custodian: none of the five generated values in `.env.real` is the demo's | all different |
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

Before the first real load, run the timed rollback drill on this copy — `docs/runbooks/rollback-drill.md` — with
`--project sre-real` and the owner's backup drive. Keep the record it writes.

## Then — the first department (only after the written GO)

`docs/runbooks/real-data-load.md`, section **"One department first (OB-241)"**: four template files, staged row by row,
a named person accepts the exception list, then the operator applies it.

---

## Known gaps (listed, not invented around)

| Id | Gap | Effect today | What would close it |
|---|---|---|---|
| G-RD-1 | No single command runs the ten isolation checks of Step 6; they are manual. | IT runs them by hand and writes the answers down. | A read-only isolation-check script (a later build item, needs the owner's OK). |
| G-RD-2 | `BOOTSTRAP_OWNER_TENANT_ID` / `BOOTSTRAP_OWNER_USER_ID` are read by the API but not passed into the API container by `infra/compose/docker-compose.yml`. | Setting them in `.env.real` does nothing; Step 3 uses `pnpm run tenant:bootstrap` instead. | Pass the two settings through in the compose file (a one-line change, with its own test). |
| G-RD-3 | The till installer and `token:store` read `infra/compose/.env` by default. | Point them at `.env.real` explicitly each time (or copy `.env.real` to `.env` on this computer, since the demo never runs here). | A settings-file flag on each, if IT finds the copy error-prone. |
| G-RD-4 | The sign-in on this copy is the pilot's stand-in identity provider (KL-01 / OA-4): whoever holds this computer's `IDP_SIGNING_KEY` can act as any login. | The load record and every signature are only as strong as the custody of this computer and its settings file. | The production identity provider (OA-4), a later decision. |
| G-RD-5 | Node 22 treats `--env-file` as its own option even after the script name. With a file that exists, `tenant:bootstrap` and `migration:load` still work (Node also loads the file into the process); with a mistyped path Node stops with "not found" before the command can explain. | Check the path before running. The new commands (`migration:slice`, the rollback drill) use `--settings` instead. | Rename the flag on `migration:load` and `tenant:bootstrap` (a small change, with tests). |
